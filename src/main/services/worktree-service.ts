import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
  lstat(path: string): Promise<{ dev: number; ino: number; nlink?: number; mtimeMs?: number; isDirectory(): boolean; isSymbolicLink(): boolean }>
  stat(path: string): Promise<{ dev: number; ino: number }>
  realpath(path: string): Promise<string>
  open(path: string, flags: 'wx' | 'a+' | 'r'): Promise<FileHandle>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
}

export interface WorktreeLockOptions {
  timeoutMs?: number
  pollMs?: number
  staleMs?: number
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
  unlink,
  rename
}

const createQueues = new Map<string, Promise<void>>()
const repositoryAdmissionQueues = new Map<string, Promise<void>>()
const EXCLUDE_LINE = '/.worktrees/'
const WORKTREE_NAME_PATTERN = /^worktree-\d{6}-[1-9]\d*$/u
const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_LOCK_POLL_MS = 10
const DEFAULT_LOCK_STALE_MS = 300_000

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
type LockIdentity = { dev: number; ino: number; nlink: number }
type ExcludeLockMetadata = {
  nonce?: string
  pid?: number
  createdAt?: number
  state?: 'held' | 'released'
}
type AcquiredExcludeLock = {
  handle: FileHandle
  identity: LockIdentity
  nonce: string
  path: string
}

const enqueue = async <T>(
  key: string,
  task: () => Promise<T>,
  queues: Map<string, Promise<void>> = createQueues
): Promise<T> => {
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  const tail = current.then(() => undefined, () => undefined)
  queues.set(key, tail)
  try {
    return await current
  } finally {
    if (queues.get(key) === tail) queues.delete(key)
  }
}

export class WorktreeService {
  private readonly rollbackProvenance = new WeakMap<object, RollbackProvenance>()

  constructor(
    private readonly runner: CommandRunner = commandRunner,
    private readonly clock: () => Date = () => new Date(),
    private readonly fileSystem: WorktreeFileSystem = productionFileSystem,
    private readonly lockOptions: WorktreeLockOptions = {}
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
    return enqueue(canonicalPath(repoRoot), async () => {
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
            const beforeOid = await this.assertSafeDirectory(worktreePath, 'Worktree path')
            initialOid = await this.branchOid(repoRoot, name)
            if (initialOid !== expectedOid) throw new Error('Created branch OID differs from the recorded HEAD')
            const afterOid = await this.assertSafeDirectory(worktreePath, 'Worktree path')
            if (beforeOid.dev !== afterOid.dev || beforeOid.ino !== afterOid.ino) throw new Error('Worktree identity changed before return')
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
    }, repositoryAdmissionQueues)
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

    await this.claimAndRemoveWorktree(context.repoRoot, context.worktreePath)
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

    const commonDirectory = await this.findCommonDirectory(repoRoot)
    if (!commonDirectory) throw new Error('Unable to resolve Git common directory for rollback')
    return enqueue(canonicalPath(commonDirectory), () => this.rollbackTransaction(provenance, repoRoot, worktreesDirectory, expectedPath))
  }

  private async rollbackTransaction(
    provenance: RollbackProvenance,
    repoRoot: string,
    worktreesDirectory: string,
    expectedPath: string
  ): Promise<void> {
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
      await this.claimAndRemoveWorktree(repoRoot, expectedPath, true)
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
    const physicalParentInfo = await this.fileSystem.lstat(physicalParent)
    if (!physicalParentInfo.isDirectory() || physicalParentInfo.isSymbolicLink()) {
      throw new Error('Git local exclude physical parent is unsafe')
    }
    const lockPath = join(physicalCommonDirectory, '.codefly-exclude.lock')
    if (canonicalPath(dirname(lockPath)) !== canonicalPath(physicalCommonDirectory)) {
      throw new Error('Git exclude lock parent is not the physical common directory')
    }
    const lock = await this.acquireExcludeLock(lockPath)
    try {
      const excludeHandle = await this.fileSystem.open(excludePath, 'a+')
      let replacement: {
        contents: string
        mode: number
        physicalExclude: string
        excludeIdentity: { dev: number; ino: number }
      } | undefined
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
        if (canonicalPath(dirname(physicalExclude)) !== canonicalPath(physicalParent)) {
          throw new Error('Git local exclude changed physical parent')
        }
        const physicalInfo = await this.fileSystem.lstat(physicalExclude)
        if (physicalInfo.isSymbolicLink() || physicalInfo.dev !== handleInfo.dev || physicalInfo.ino !== handleInfo.ino) {
          throw new Error('Git local exclude physical identity changed')
        }
        const contents = await excludeHandle.readFile({ encoding: 'utf8' })
        if (contents.split(/\r?\n/u).some((line) => line.trim() === EXCLUDE_LINE)) return

        const newline = contents.includes('\r\n') ? '\r\n' : '\n'
        const separator = contents.length > 0 && !/[\r\n]$/u.test(contents) ? newline : ''
        replacement = {
          contents: `${contents}${separator}${EXCLUDE_LINE}${newline}`,
          mode: handleInfo.mode,
          physicalExclude,
          excludeIdentity: { dev: handleInfo.dev, ino: handleInfo.ino }
        }
      } finally {
        await excludeHandle.close()
      }
      if (replacement) {
        await this.replaceExclude(
          replacement.physicalExclude,
          physicalParent,
          replacement.contents,
          replacement.mode,
          replacement.excludeIdentity,
          { dev: physicalParentInfo.dev, ino: physicalParentInfo.ino }
        )
      }
    } finally {
      await this.releaseExcludeLock(lock)
    }
  }

  private async replaceExclude(
    excludePath: string,
    parent: string,
    contents: string,
    mode: number,
    excludeIdentity: { dev: number; ino: number },
    parentIdentity: { dev: number; ino: number }
  ): Promise<void> {
    const tempPath = join(parent, `.codefly-exclude-${randomUUID()}.tmp`)
    const handle = await this.fileSystem.open(tempPath, 'wx')
    let identity: { dev: number; ino: number } | undefined
    let closeAttempted = false
    try {
      const info = await handle.stat()
      identity = { dev: info.dev, ino: info.ino }
      await handle.writeFile(contents, { encoding: 'utf8' })
      await handle.chmod(mode & 0o777)
      await handle.sync()
      closeAttempted = true
      await handle.close()
      const pathInfo = await this.fileSystem.lstat(tempPath)
      if (pathInfo.isSymbolicLink() || pathInfo.dev !== identity.dev || pathInfo.ino !== identity.ino) {
        throw new Error('Git exclude temp identity changed')
      }
      const physical = await this.fileSystem.realpath(tempPath)
      if (canonicalPath(dirname(physical)) !== canonicalPath(parent)) throw new Error('Git exclude temp escaped its parent')
      const currentParent = await this.fileSystem.lstat(parent)
      const currentPhysicalParent = await this.fileSystem.realpath(parent)
      if (
        !currentParent.isDirectory() || currentParent.isSymbolicLink() ||
        currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino ||
        canonicalPath(currentPhysicalParent) !== canonicalPath(parent)
      ) throw new Error('Git exclude physical parent identity changed before replacement')
      const currentExclude = await this.fileSystem.lstat(excludePath)
      const currentPhysicalExclude = await this.fileSystem.realpath(excludePath)
      if (
        currentExclude.isSymbolicLink() ||
        currentExclude.dev !== excludeIdentity.dev || currentExclude.ino !== excludeIdentity.ino ||
        canonicalPath(currentPhysicalExclude) !== canonicalPath(excludePath)
      ) throw new Error('Git local exclude identity changed before replacement')
      await this.fileSystem.rename(tempPath, excludePath)
    } catch (error) {
      const errors = [error]
      if (!closeAttempted) {
        closeAttempted = true
        try {
          await handle.close()
        } catch (closeError) {
          errors.push(closeError)
        }
      }
      try {
        const current = await this.fileSystem.lstat(tempPath)
        if (identity && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
          await this.fileSystem.unlink(tempPath)
        }
      } catch (cleanupError) {
        if (!missingError(cleanupError)) errors.push(cleanupError)
      }
      if (errors.length > 1) throw new AggregateError(errors, 'Exclude replacement cleanup failed')
      throw error
    } finally {
      if (!closeAttempted) await handle.close()
    }
  }

  private async acquireExcludeLock(lockPath: string): Promise<AcquiredExcludeLock> {
    const deadline = Date.now() + (this.lockOptions.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
    const pollMs = this.lockOptions.pollMs ?? DEFAULT_LOCK_POLL_MS
    const staleMs = this.lockOptions.staleMs ?? DEFAULT_LOCK_STALE_MS
    for (;;) {
      try {
        const handle = await this.fileSystem.open(lockPath, 'wx')
        let identity: LockIdentity | undefined
        const nonce = randomUUID()
        try {
          const info = await handle.stat()
          identity = { dev: info.dev, ino: info.ino, nlink: info.nlink }
          if (!info.isFile() || info.nlink !== 1) throw new Error('Acquired Git exclude lock identity is unsafe')
          const now = this.clock().getTime()
          await handle.writeFile(JSON.stringify({ nonce, pid: process.pid, createdAt: now, state: 'held' }), { encoding: 'utf8' })
          await handle.sync()
          return { handle, identity, nonce, path: lockPath }
        } catch (error) {
          const errors = [error]
          try {
            try {
              await handle.close()
            } catch (closeError) {
              errors.push(closeError)
            }
          } finally {
            if (identity) {
              try {
                await this.claimAndDeleteLock(lockPath, identity)
              } catch (cleanupError) {
                errors.push(cleanupError)
              }
            }
          }
          if (errors.length > 1) throw new AggregateError(errors, 'Exclude lock initialization cleanup failed')
          throw error
        }
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
        let existing: Awaited<ReturnType<WorktreeFileSystem['lstat']>>
        try {
          existing = await this.fileSystem.lstat(lockPath)
        } catch (inspectError) {
          if (missingError(inspectError)) continue
          throw inspectError
        }
        if (existing.isSymbolicLink()) throw new Error('Git exclude lock is symbolic')
        if ((existing.nlink ?? 1) !== 1 || existing.isDirectory()) throw new Error('Git exclude lock identity is unsafe')
        let owner: ExcludeLockMetadata = {}
        try {
          const handle = await this.fileSystem.open(lockPath, 'r')
          try {
            const handleInfo = await handle.stat()
            if (handleInfo.dev !== existing.dev || handleInfo.ino !== existing.ino) continue
            owner = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as ExcludeLockMetadata
          } finally {
            await handle.close()
          }
        } catch (inspectError) {
          if (missingError(inspectError)) continue
        }
        const hasPid = typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0
        const ownerIsReleased = owner.state === 'released' && typeof owner.nonce === 'string' && owner.nonce.length > 0
        const ownerIsDead = hasPid && !this.processExists(owner.pid as number)
        const ownerIsUnknownAndStale = !hasPid && this.clock().getTime() - (owner.createdAt ?? existing.mtimeMs ?? this.clock().getTime()) > staleMs
        if (ownerIsReleased || ownerIsDead || ownerIsUnknownAndStale) {
          try {
            await this.claimAndDeleteLock(
              lockPath,
              { dev: existing.dev, ino: existing.ino, nlink: existing.nlink ?? 1 },
              typeof owner.nonce === 'string' ? owner.nonce : undefined
            )
          } catch (claimError) {
            if (missingError(claimError)) continue
            throw claimError
          }
          continue
        }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the Git exclude lock')
        await new Promise((complete) => setTimeout(complete, pollMs))
      }
    }
  }

  private async releaseExcludeLock(lock: AcquiredExcludeLock): Promise<void> {
    const errors: unknown[] = []
    try {
      const metadata = JSON.stringify({
        nonce: lock.nonce,
        pid: process.pid,
        createdAt: this.clock().getTime(),
        state: 'released'
      } satisfies ExcludeLockMetadata)
      await lock.handle.write(metadata, 0, 'utf8')
      await lock.handle.truncate(Buffer.byteLength(metadata))
      await lock.handle.sync()
    } catch (error) {
      errors.push(error)
    } finally {
      try {
        await lock.handle.close()
      } catch (closeError) {
        errors.push(closeError)
      }
    }
    try {
      if (await this.lockPathMatches(lock.path, lock.identity, lock.nonce)) {
        await this.claimAndDeleteLock(lock.path, lock.identity, lock.nonce)
      }
    } catch (error) {
      if (!missingError(error)) errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Exclude lock release failed')
  }

  private processExists(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch (error) {
      return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
    }
  }

  private async lockPathMatches(lockPath: string, expected: LockIdentity, expectedNonce?: string): Promise<boolean> {
    const current = await this.fileSystem.lstat(lockPath)
    if (current.isSymbolicLink() || current.isDirectory() || (current.nlink ?? 1) !== expected.nlink) return false
    const followed = await this.fileSystem.stat(lockPath)
    if (followed.dev !== expected.dev || followed.ino !== expected.ino) return false
    return this.lockNonceMatches(lockPath, expectedNonce)
  }

  private async lockNonceMatches(lockPath: string, expectedNonce?: string): Promise<boolean> {
    if (!expectedNonce) return true
    try {
      const metadata = JSON.parse(await this.fileSystem.readFile(lockPath, 'utf8')) as ExcludeLockMetadata
      return metadata.nonce === expectedNonce
    } catch {
      return true
    }
  }

  private async claimAndDeleteLock(lockPath: string, expected: LockIdentity, expectedNonce?: string): Promise<void> {
    const claimedPath = `${lockPath}.stale-${randomUUID()}`
    if (!await this.lockPathMatches(lockPath, expected, expectedNonce)) throw new Error('Stale lock identity changed before claim')
    await this.fileSystem.rename(lockPath, claimedPath)
    if (!await this.lockPathMatches(claimedPath, expected, expectedNonce)) {
      if (!await this.pathExists(lockPath)) await this.fileSystem.rename(claimedPath, lockPath)
      throw new Error('Stale lock identity changed during claim')
    }
    await this.fileSystem.unlink(claimedPath)
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

  private async assertSafeDirectory(path: string, label: string): Promise<{ dev: number; ino: number }> {
    const info = await this.fileSystem.lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} is symbolic, a junction, or not a directory`)
    }
    const physicalPath = await this.fileSystem.realpath(path)
    if (canonicalPath(physicalPath) !== canonicalPath(path)) {
      throw new Error(`${label} physical path does not match its lexical path`)
    }
    return { dev: info.dev, ino: info.ino }
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
    await this.claimAndRemoveWorktree(repoRoot, worktreePath, true)
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
    const afterDelete = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']),
      'git worktree list'
    )
    if (this.worktreeStanzas(afterDelete.stdout).some((stanza) => stanza.branch === `refs/heads/${name}`)) {
      try {
        ensureSuccess(
          await this.runner.run('git', ['-C', repoRoot, 'update-ref', `refs/heads/${name}`, expectedOid, '0'.repeat(expectedOid.length)]),
          'git update-ref restore'
        )
      } catch (error) {
        try {
          await this.branchOid(repoRoot, name)
        } catch {
          throw error
        }
      }
    }
  }

  private async claimAndRemoveWorktree(repoRoot: string, worktreePath: string, alreadyQueued = false): Promise<void> {
    if (!alreadyQueued) {
      const commonDirectory = await this.findCommonDirectory(repoRoot)
      if (!commonDirectory) throw new Error('Unable to resolve Git common directory for worktree removal')
      return enqueue(canonicalPath(commonDirectory), () => this.claimAndRemoveWorktree(repoRoot, worktreePath, true))
    }
    const parent = resolve(repoRoot, '.worktrees')
    await this.assertSafeDirectory(parent, 'Worktrees directory')
    const before = await this.fileSystem.lstat(worktreePath)
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Worktree path is unsafe before claim')
    const quarantine = join(parent, `.codefly-quarantine-${randomUUID()}`)
    await this.fileSystem.rename(worktreePath, quarantine)
    try {
      const claimed = await this.fileSystem.lstat(quarantine)
      if (!claimed.isDirectory() || claimed.isSymbolicLink() || claimed.dev !== before.dev || claimed.ino !== before.ino) {
        throw new Error('Claimed worktree identity changed')
      }
      const physical = await this.fileSystem.realpath(quarantine)
      if (canonicalPath(physical) !== canonicalPath(quarantine)) throw new Error('Claimed worktree escaped its trusted parent')
      ensureSuccess(await this.runner.run('git', ['-C', repoRoot, 'worktree', 'repair', quarantine]), 'git worktree repair')
      ensureSuccess(await this.runner.run('git', ['-C', repoRoot, 'worktree', 'remove', quarantine]), 'git worktree remove')
    } catch (error) {
      const recoveryErrors: unknown[] = []
      try {
        const current = await this.fileSystem.lstat(quarantine)
        const physical = await this.fileSystem.realpath(quarantine)
        if (
          !current.isDirectory() || current.isSymbolicLink() ||
          current.dev !== before.dev || current.ino !== before.ino ||
          canonicalPath(physical) !== canonicalPath(quarantine)
        ) throw new Error('Quarantine identity changed before recovery')
        if (await this.pathExists(worktreePath)) throw new Error('Original worktree path was occupied during recovery')
        await this.fileSystem.rename(quarantine, worktreePath)
        const restored = await this.fileSystem.lstat(worktreePath)
        const restoredPhysical = await this.fileSystem.realpath(worktreePath)
        if (
          restored.isSymbolicLink() || restored.dev !== before.dev || restored.ino !== before.ino ||
          canonicalPath(restoredPhysical) !== canonicalPath(worktreePath)
        ) throw new Error('Restored worktree identity changed')
        ensureSuccess(await this.runner.run('git', ['-C', repoRoot, 'worktree', 'repair', worktreePath]), 'git worktree repair original')
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError)
      }
      if (recoveryErrors.length > 0) throw new AggregateError([error, ...recoveryErrors], 'Worktree removal and recovery failed')
      throw error
    }
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
