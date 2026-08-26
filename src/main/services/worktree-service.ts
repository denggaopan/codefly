import { access, lstat, mkdir, open, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ProjectRecord, SessionRecord } from '../../shared/contracts'
import { commandRunner } from '../infrastructure/command-runner'
import type { CommandResult, CommandRunner } from '../infrastructure/command-runner'

export type SessionLocation =
  | { mode: 'ordinary'; launchPath: string }
  | {
      mode: 'worktree'
      launchPath: string
      worktreeName: string
      worktreePath: string
      branchName: string
      repoRoot: string
    }

export type RemoveWorktreeResult =
  | { status: 'removed' }
  | { status: 'dirty'; changedFiles: number }
  | { status: 'missing' }

export interface WorktreeFileSystem {
  access(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  lstat(path: string): Promise<{ dev: number; ino: number; isDirectory(): boolean; isSymbolicLink(): boolean }>
  stat(path: string): Promise<{ dev: number; ino: number }>
  realpath(path: string): Promise<string>
  open(path: string, flags: 'wx' | 'a+'): Promise<FileHandle>
  unlink(path: string): Promise<void>
}

const productionFileSystem: WorktreeFileSystem = {
  access,
  async readdir(path) {
    return readdir(path)
  },
  async readFile(path, encoding) {
    return readFile(path, encoding)
  },
  async mkdir(path, options) {
    return mkdir(path, options)
  },
  lstat,
  stat,
  realpath,
  open,
  unlink
}

const createQueues = new Map<string, Promise<void>>()
const EXCLUDE_LINE = '/.worktrees/'
const WORKTREE_NAME_PATTERN = /^worktree-\d{6}-[1-9]\d*$/u

const canonicalPath = (path: string): string =>
  resolve(path).replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US')

const missingError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const ensureSuccess = (result: CommandResult, operation: string): CommandResult => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`)
  }
  return result
}

const namesFromLines = (output: string): string[] =>
  output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)

const pathIsWithin = (parent: string, candidate: string): boolean => {
  const nested = relative(resolve(parent), resolve(candidate))
  return nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))
}

type WorktreeStanza = { path: string; branch?: string }
type WorktreeContext = { repoRoot: string; worktreePath: string; name: string }
type RollbackProvenance = WorktreeContext & { initialOid: string }

const enqueue = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = createQueues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  const tail = current.then(() => undefined, () => undefined)
  createQueues.set(key, tail)
  try {
    return await current
  } finally {
    if (createQueues.get(key) === tail) createQueues.delete(key)
  }
}

export class WorktreeService {
  private readonly rollbackProvenance = new WeakMap<object, RollbackProvenance>()

  constructor(
    private readonly runner: CommandRunner = commandRunner,
    private readonly clock: () => Date = () => new Date(),
    private readonly fileSystem: WorktreeFileSystem = productionFileSystem
  ) {}

  async create(project: ProjectRecord, knownSessions: readonly SessionRecord[]): Promise<SessionLocation> {
    const ordinary: SessionLocation = { mode: 'ordinary', launchPath: project.path }
    if (!project.repoRoot) return ordinary

    const repoRoot = resolve(project.repoRoot)
    const selectedPath = resolve(project.path)
    const nestedPath = relative(repoRoot, selectedPath)
    if (nestedPath === '..' || nestedPath.startsWith(`..${sep}`) || isAbsolute(nestedPath)) {
      return ordinary
    }
    const commonDirectory = await this.findCommonDirectory(repoRoot)
    if (!commonDirectory) return ordinary

    return enqueue(canonicalPath(commonDirectory), async () => {
      if (!await this.hasCommittedHead(repoRoot)) return ordinary

      const worktreesDirectory = resolve(repoRoot, '.worktrees')
      await this.prepareSafeWorktreesDirectory(worktreesDirectory)
      await this.ensureLocalExclude(repoRoot)
      await this.assertSafeDirectory(worktreesDirectory, 'Worktrees directory')
      let name = await this.nextName(repoRoot, worktreesDirectory, knownSessions)

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this.assertSafeDirectory(worktreesDirectory, 'Worktrees directory')
        const worktreePath = resolve(worktreesDirectory, name)
        const expectedOid = await this.headOid(repoRoot)
        try {
          const result = await this.runner.run('git', ['-C', repoRoot, 'worktree', 'add', '-b', name, worktreePath, 'HEAD'])
          ensureSuccess(result, 'git worktree add')
        } catch (error) {
          if (attempt !== 0) throw error
          const occupied = await this.usedNames(repoRoot, worktreesDirectory, knownSessions)
          if (!occupied.has(name.toLocaleLowerCase('en-US'))) throw error
          name = await this.nextName(repoRoot, worktreesDirectory, knownSessions)
          continue
        }

        let initialOid: string
        try {
          initialOid = await this.branchOid(repoRoot, name)
          if (initialOid !== expectedOid) throw new Error('Created branch OID differs from the recorded HEAD')
        } catch (error) {
          try {
            await this.cleanupCreatedWorktree(repoRoot, worktreePath, name, expectedOid)
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Branch OID lookup failed and worktree cleanup was incomplete')
          }
          throw error
        }
        const location: Extract<SessionLocation, { mode: 'worktree' }> = {
          mode: 'worktree',
          launchPath: nestedPath ? resolve(worktreePath, nestedPath) : worktreePath,
          worktreeName: name,
          worktreePath,
          branchName: name,
          repoRoot
        }
        this.rollbackProvenance.set(location, { repoRoot, worktreePath, name, initialOid })
        return location
      }
      throw new Error('Unable to allocate worktree')
    })
  }

  async validate(session: SessionRecord, project: ProjectRecord): Promise<'valid' | 'missing'> {
    if (session.projectId !== project.id) return 'missing'
    if (session.mode === 'ordinary') {
      if (canonicalPath(session.launchPath) !== canonicalPath(project.path)) return 'missing'
      return await this.pathExists(session.launchPath) ? 'valid' : 'missing'
    }

    const context = this.worktreeContext(session, project)
    if (!context) return 'missing'
    try {
      await this.assertSafeDirectory(resolve(context.repoRoot, '.worktrees'), 'Worktrees directory')
      await this.assertSafeDirectory(context.worktreePath, 'Worktree path')
    } catch {
      return 'missing'
    }
    if (!await this.pathExists(context.worktreePath)) return 'missing'
    try {
      const result = ensureSuccess(
        await this.runner.run('git', ['-C', context.repoRoot, 'worktree', 'list', '--porcelain']),
        'git worktree list'
      )
      return this.hasExactStanza(result.stdout, context) ? 'valid' : 'missing'
    } catch {
      return 'missing'
    }
  }

  async remove(session: SessionRecord, project: ProjectRecord): Promise<RemoveWorktreeResult> {
    if (session.projectId !== project.id) return { status: 'missing' }
    if (session.mode === 'ordinary') {
      return canonicalPath(session.launchPath) === canonicalPath(project.path) ? { status: 'removed' } : { status: 'missing' }
    }

    const context = this.worktreeContext(session, project)
    if (!context) return { status: 'missing' }
    try {
      await this.assertSafeDirectory(resolve(context.repoRoot, '.worktrees'), 'Worktrees directory')
      await this.assertSafeDirectory(context.worktreePath, 'Worktree path')
    } catch {
      return { status: 'missing' }
    }
    if (!await this.pathExists(context.worktreePath)) return { status: 'missing' }
    const registration = ensureSuccess(
      await this.runner.run('git', ['-C', context.repoRoot, 'worktree', 'list', '--porcelain']),
      'git worktree list'
    )
    if (!this.hasExactStanza(registration.stdout, context)) return { status: 'missing' }

    const status = ensureSuccess(
      await this.runner.run('git', ['-C', context.worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
      'git status'
    )
    const changedFiles = this.changedFileCount(status.stdout)
    if (changedFiles > 0) return { status: 'dirty', changedFiles }

    try {
      await this.assertSafeDirectory(resolve(context.repoRoot, '.worktrees'), 'Worktrees directory')
      await this.assertSafeDirectory(context.worktreePath, 'Worktree path')
    } catch {
      return { status: 'missing' }
    }
    ensureSuccess(
      await this.runner.run('git', ['-C', context.repoRoot, 'worktree', 'remove', context.worktreePath]),
      'git worktree remove'
    )
    return { status: 'removed' }
  }

  async rollback(location: Extract<SessionLocation, { mode: 'worktree' }>): Promise<void> {
    const provenance = this.rollbackProvenance.get(location)
    if (!provenance) throw new Error('Missing worktree rollback provenance')
    this.rollbackProvenance.delete(location)

    const repoRoot = resolve(provenance.repoRoot)
    const worktreesDirectory = resolve(repoRoot, '.worktrees')
    const expectedPath = resolve(provenance.worktreePath)
    if (
      location.repoRoot !== provenance.repoRoot ||
      location.worktreePath !== provenance.worktreePath ||
      location.worktreeName !== provenance.name ||
      location.branchName !== provenance.name ||
      !WORKTREE_NAME_PATTERN.test(provenance.name) ||
      canonicalPath(dirname(expectedPath)) !== canonicalPath(worktreesDirectory) ||
      canonicalPath(location.worktreePath) !== canonicalPath(expectedPath) ||
      !pathIsWithin(expectedPath, location.launchPath)
    ) {
      throw new Error('Invalid worktree rollback location mismatch')
    }

    await this.assertSafeDirectory(worktreesDirectory, 'Worktrees directory')
    if (await this.pathExists(expectedPath)) {
      await this.assertSafeDirectory(expectedPath, 'Worktree path')
      const registration = ensureSuccess(
        await this.runner.run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']),
        'git worktree list'
      )
      if (!this.hasExactStanza(registration.stdout, { repoRoot, worktreePath: expectedPath, name: provenance.name })) {
        throw new Error('Rollback worktree registration mismatch')
      }
      await this.assertUnchangedBranch(provenance)
      await this.assertSafeDirectory(worktreesDirectory, 'Worktrees directory')
      await this.assertSafeDirectory(expectedPath, 'Worktree path')
      ensureSuccess(
        await this.runner.run('git', ['-C', repoRoot, 'worktree', 'remove', expectedPath]),
        'git worktree remove'
      )
    } else {
      const registration = ensureSuccess(
        await this.runner.run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']),
        'git worktree list'
      )
      if (this.worktreeStanzas(registration.stdout).some((stanza) => stanza.branch === `refs/heads/${provenance.name}`)) {
        throw new Error('Rollback worktree branch is registered at a moved path')
      }
      await this.assertUnchangedBranch(provenance)
    }

    await this.deleteBranchIfUnchanged(repoRoot, provenance.name, provenance.initialOid)
  }

  private async hasCommittedHead(repoRoot: string): Promise<boolean> {
    try {
      const result = await this.runner.run('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'])
      return result.exitCode === 0 && result.stdout.trim().length > 0
    } catch {
      return false
    }
  }

  private async findCommonDirectory(repoRoot: string): Promise<string | undefined> {
    let result: CommandResult
    try {
      result = await this.runner.run('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'])
    } catch {
      return undefined
    }
    const output = result.stdout.trim()
    if (result.exitCode !== 0 || !output) return undefined
    const lexicalPath = resolve(isAbsolute(output) ? output : join(repoRoot, output))
    return this.fileSystem.realpath(lexicalPath)
  }

  private async ensureLocalExclude(repoRoot: string): Promise<void> {
    const commonResult = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir']),
      'git rev-parse --git-common-dir'
    )
    const commonOutput = commonResult.stdout.trim()
    if (!commonOutput) throw new Error('Git returned an empty common directory')
    const commonDirectory = resolve(isAbsolute(commonOutput) ? commonOutput : join(repoRoot, commonOutput))
    const physicalCommonDirectory = await this.fileSystem.realpath(commonDirectory)

    const result = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'info/exclude']),
      'git rev-parse --git-path info/exclude'
    )
    const output = result.stdout.trim()
    if (!output) throw new Error('Git returned an empty local exclude path')
    const excludePath = resolve(isAbsolute(output) ? output : join(repoRoot, output))
    if (!pathIsWithin(commonDirectory, excludePath)) throw new Error('Git local exclude escapes the common directory')
    const excludeParent = dirname(excludePath)
    await this.fileSystem.mkdir(excludeParent, { recursive: true })
    const physicalParent = await this.fileSystem.realpath(excludeParent)
    if (!pathIsWithin(physicalCommonDirectory, physicalParent)) {
      throw new Error('Git local exclude parent escapes the physical common directory')
    }
    const lockPath = join(physicalCommonDirectory, 'info', 'codefly-exclude.lock')
    const lock = await this.acquireExcludeLock(lockPath)
    try {
      const excludeHandle = await this.fileSystem.open(excludePath, 'a+')
      try {
        const handleInfo = await excludeHandle.stat()
        const pathInfo = await this.fileSystem.lstat(excludePath)
        if (pathInfo.isSymbolicLink()) throw new Error('Git local exclude is symbolic')
        const followedInfo = await this.fileSystem.stat(excludePath)
        if (handleInfo.dev !== followedInfo.dev || handleInfo.ino !== followedInfo.ino) {
          throw new Error('Git local exclude changed after open')
        }
        const physicalExclude = await this.fileSystem.realpath(excludePath)
        if (!pathIsWithin(physicalCommonDirectory, physicalExclude)) {
          throw new Error('Git local exclude escapes the physical common directory')
        }
        const contents = await excludeHandle.readFile({ encoding: 'utf8' })
        if (contents.split(/\r?\n/u).some((line) => line.trim() === EXCLUDE_LINE)) return

        const newline = contents.includes('\r\n') ? '\r\n' : '\n'
        const separator = contents.length > 0 && !/[\r\n]$/u.test(contents) ? newline : ''
        await excludeHandle.appendFile(`${separator}${EXCLUDE_LINE}${newline}`, { encoding: 'utf8' })
      } finally {
        await excludeHandle.close()
      }
    } finally {
      const lockInfo = await lock.stat()
      await lock.close()
      try {
        const currentLockInfo = await this.fileSystem.stat(lockPath)
        if (lockInfo.dev === currentLockInfo.dev && lockInfo.ino === currentLockInfo.ino) {
          await this.fileSystem.unlink(lockPath)
        }
      } catch (error) {
        if (!missingError(error)) throw error
      }
    }
  }

  private async acquireExcludeLock(lockPath: string): Promise<FileHandle> {
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        return await this.fileSystem.open(lockPath, 'wx')
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the Git exclude lock')
        await new Promise((complete) => setTimeout(complete, 10))
      }
    }
  }

  private async nextName(
    repoRoot: string,
    worktreesDirectory: string,
    knownSessions: readonly SessionRecord[]
  ): Promise<string> {
    const used = await this.usedNames(repoRoot, worktreesDirectory, knownSessions)
    const now = this.clock()
    const date = `${String(now.getFullYear() % 100).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    for (let sequence = 1; ; sequence += 1) {
      const candidate = `worktree-${date}-${sequence}`
      if (!used.has(candidate.toLocaleLowerCase('en-US'))) return candidate
    }
  }

  private async usedNames(
    repoRoot: string,
    worktreesDirectory: string,
    knownSessions: readonly SessionRecord[]
  ): Promise<Set<string>> {
    const used = new Set<string>()
    const add = (name: string): void => {
      if (name) used.add(name.toLocaleLowerCase('en-US'))
    }

    for (const session of knownSessions) {
      if (!session.worktreePath || canonicalPath(dirname(session.worktreePath)) !== canonicalPath(worktreesDirectory)) continue
      add(basename(session.worktreePath))
      if (session.worktreeName) add(session.worktreeName)
    }

    try {
      for (const child of await this.fileSystem.readdir(worktreesDirectory)) add(child)
    } catch (error) {
      if (!missingError(error)) throw error
    }

    const branches = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'branch', '--format=%(refname:short)']),
      'git branch'
    )
    for (const branch of namesFromLines(branches.stdout)) add(branch)

    const worktrees = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']),
      'git worktree list'
    )
    for (const path of this.registeredPaths(worktrees.stdout)) {
      if (canonicalPath(dirname(path)) === canonicalPath(worktreesDirectory)) add(basename(path))
    }
    for (const line of namesFromLines(worktrees.stdout)) {
      if (line.startsWith('branch refs/heads/')) add(line.slice('branch refs/heads/'.length))
    }

    return used
  }

  private registeredPaths(output: string): string[] {
    return this.worktreeStanzas(output).map((stanza) => stanza.path)
  }

  private worktreeStanzas(output: string): WorktreeStanza[] {
    return output.split(/\r?\n\r?\n/u).flatMap((block) => {
      let path: string | undefined
      let branch: string | undefined
      for (const line of block.split(/\r?\n/u)) {
        if (line.startsWith('worktree ')) path = resolve(line.slice('worktree '.length))
        if (line.startsWith('branch ')) branch = line.slice('branch '.length)
      }
      return path ? [{ path, branch }] : []
    })
  }

  private hasExactStanza(output: string, context: WorktreeContext): boolean {
    return this.worktreeStanzas(output).some((stanza) =>
      canonicalPath(stanza.path) === canonicalPath(context.worktreePath) &&
      stanza.branch === `refs/heads/${context.name}`
    )
  }

  private worktreeContext(session: Extract<SessionRecord, { mode: 'worktree' }>, project: ProjectRecord): WorktreeContext | undefined {
    if (
      !project.repoRoot ||
      typeof session.worktreeName !== 'string' ||
      typeof session.worktreePath !== 'string' ||
      typeof session.branchName !== 'string' ||
      typeof session.launchPath !== 'string' ||
      !WORKTREE_NAME_PATTERN.test(session.worktreeName) ||
      session.branchName !== session.worktreeName
    ) return undefined

    const repoRoot = resolve(project.repoRoot)
    const worktreePath = resolve(repoRoot, '.worktrees', session.worktreeName)
    const selectedPath = resolve(project.path)
    const nestedPath = relative(repoRoot, selectedPath)
    if (nestedPath === '..' || nestedPath.startsWith(`..${sep}`) || isAbsolute(nestedPath)) return undefined
    const expectedLaunchPath = nestedPath ? resolve(worktreePath, nestedPath) : worktreePath
    if (
      canonicalPath(session.worktreePath) !== canonicalPath(worktreePath) ||
      canonicalPath(session.launchPath) !== canonicalPath(expectedLaunchPath)
    ) return undefined
    return { repoRoot, worktreePath, name: session.worktreeName }
  }

  private async prepareSafeWorktreesDirectory(worktreesDirectory: string): Promise<void> {
    await this.fileSystem.mkdir(worktreesDirectory, { recursive: true })
    await this.assertSafeDirectory(worktreesDirectory, 'Worktrees directory')
  }

  private async assertSafeDirectory(path: string, label: string): Promise<void> {
    const info = await this.fileSystem.lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} is symbolic, a junction, or not a directory`)
    }
    const physicalPath = await this.fileSystem.realpath(path)
    if (canonicalPath(physicalPath) !== canonicalPath(path)) {
      throw new Error(`${label} physical path does not match its lexical path`)
    }
  }

  private changedFileCount(output: string): number {
    const records = output.split('\0').filter(Boolean)
    let count = 0
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!
      count += 1
      if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') index += 1
    }
    return count
  }

  private async branchOid(repoRoot: string, name: string): Promise<string> {
    const result = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'rev-parse', `refs/heads/${name}`]),
      'git rev-parse branch'
    )
    const oid = result.stdout.trim()
    if (!oid) throw new Error('Git returned an empty branch OID')
    return oid
  }

  private async headOid(repoRoot: string): Promise<string> {
    const result = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD']),
      'git rev-parse --verify HEAD'
    )
    const oid = result.stdout.trim()
    if (!oid) throw new Error('Git returned an empty HEAD OID')
    return oid
  }

  private async cleanupCreatedWorktree(repoRoot: string, worktreePath: string, name: string, expectedOid: string): Promise<void> {
    await this.assertSafeDirectory(resolve(repoRoot, '.worktrees'), 'Worktrees directory')
    await this.assertSafeDirectory(worktreePath, 'Worktree path')
    const registration = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']),
      'git worktree list'
    )
    if (!this.hasExactStanza(registration.stdout, { repoRoot, worktreePath, name })) {
      throw new Error('Created worktree ownership changed before cleanup')
    }
    await this.assertSafeDirectory(resolve(repoRoot, '.worktrees'), 'Worktrees directory')
    await this.assertSafeDirectory(worktreePath, 'Worktree path')
    ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'worktree', 'remove', worktreePath]),
      'git worktree remove'
    )
    await this.deleteBranchIfUnchanged(repoRoot, name, expectedOid)
  }

  private async deleteBranchIfUnchanged(repoRoot: string, name: string, expectedOid: string): Promise<void> {
    const registration = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']),
      'git worktree list'
    )
    if (this.worktreeStanzas(registration.stdout).some((stanza) => stanza.branch === `refs/heads/${name}`)) {
      throw new Error('Worktree branch is still registered before reference deletion')
    }
    ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'update-ref', '-d', `refs/heads/${name}`, expectedOid]),
      'git update-ref -d'
    )
  }

  private async assertUnchangedBranch(provenance: RollbackProvenance): Promise<void> {
    const currentOid = await this.branchOid(provenance.repoRoot, provenance.name)
    if (currentOid !== provenance.initialOid) throw new Error('Rollback branch OID changed')
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await this.fileSystem.access(resolve(path))
      return true
    } catch (error) {
      if (missingError(error)) return false
      throw error
    }
  }
}
