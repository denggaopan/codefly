import { access, appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
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
  appendFile(path: string, contents: string, encoding: 'utf8'): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
}

const productionFileSystem: WorktreeFileSystem = {
  access,
  async readdir(path) {
    return readdir(path)
  },
  async readFile(path, encoding) {
    return readFile(path, encoding)
  },
  async appendFile(path, contents, encoding) {
    await appendFile(path, contents, encoding)
  },
  async mkdir(path, options) {
    return mkdir(path, options)
  }
}

const createQueues = new Map<string, Promise<void>>()
const EXCLUDE_LINE = '/.worktrees/'
const WORKTREE_NAME_PATTERN = /^worktree-\d{6}-[1-9]\d*$/u

const canonicalPath = (path: string): string =>
  resolve(path).replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US')

const missingError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const commandDetails = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const result = 'result' in error ? error.result as Partial<CommandResult> : undefined
  return [error.message, result?.stdout, result?.stderr].filter(Boolean).join('\n')
}

const collisionError = (error: unknown): boolean =>
  /already exists|already checked out|already registered|a branch named .+ exists/iu.test(commandDetails(error))

const ensureSuccess = (result: CommandResult, operation: string): CommandResult => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`)
  }
  return result
}

const namesFromLines = (output: string): string[] =>
  output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)

const worktreeRootFor = (worktreePath: string | undefined): string | undefined => {
  if (!worktreePath) return undefined
  const absolutePath = resolve(worktreePath)
  const worktreesDirectory = dirname(absolutePath)
  if (basename(worktreesDirectory).toLocaleLowerCase('en-US') !== '.worktrees') return undefined
  return dirname(worktreesDirectory)
}

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

    return enqueue(canonicalPath(repoRoot), async () => {
      if (!await this.hasCommittedHead(repoRoot)) return ordinary

      await this.ensureLocalExclude(repoRoot)
      const worktreesDirectory = resolve(repoRoot, '.worktrees')
      let name = await this.nextName(repoRoot, worktreesDirectory, knownSessions)

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const worktreePath = resolve(worktreesDirectory, name)
        try {
          const result = await this.runner.run('git', ['-C', repoRoot, 'worktree', 'add', '-b', name, worktreePath, 'HEAD'])
          ensureSuccess(result, 'git worktree add')
          return {
            mode: 'worktree',
            launchPath: nestedPath ? resolve(worktreePath, nestedPath) : worktreePath,
            worktreeName: name,
            worktreePath,
            branchName: name,
            repoRoot
          }
        } catch (error) {
          if (attempt !== 0 || !collisionError(error)) throw error
          name = await this.nextName(repoRoot, worktreesDirectory, knownSessions)
        }
      }
      throw new Error('Unable to allocate worktree')
    })
  }

  async validate(session: SessionRecord): Promise<'valid' | 'missing'> {
    if (session.mode === 'ordinary') return await this.pathExists(session.launchPath) ? 'valid' : 'missing'

    const repoRoot = worktreeRootFor(session.worktreePath)
    if (!repoRoot || !await this.pathExists(session.worktreePath)) return 'missing'
    try {
      const result = ensureSuccess(
        await this.runner.run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']),
        'git worktree list'
      )
      const expected = canonicalPath(session.worktreePath)
      return this.registeredPaths(result.stdout).some((path) => canonicalPath(path) === expected) ? 'valid' : 'missing'
    } catch {
      return 'missing'
    }
  }

  async remove(session: SessionRecord): Promise<RemoveWorktreeResult> {
    if (session.mode === 'ordinary') return { status: 'removed' }

    const repoRoot = worktreeRootFor(session.worktreePath)
    if (!repoRoot || !await this.pathExists(session.worktreePath)) return { status: 'missing' }

    const status = ensureSuccess(
      await this.runner.run('git', ['-C', resolve(session.worktreePath), 'status', '--porcelain']),
      'git status'
    )
    const changedFiles = namesFromLines(status.stdout).length
    if (changedFiles > 0) return { status: 'dirty', changedFiles }

    ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'worktree', 'remove', resolve(session.worktreePath)]),
      'git worktree remove'
    )
    return { status: 'removed' }
  }

  async rollback(location: Extract<SessionLocation, { mode: 'worktree' }>): Promise<void> {
    const repoRoot = resolve(location.repoRoot)
    const worktreesDirectory = resolve(repoRoot, '.worktrees')
    const expectedPath = resolve(worktreesDirectory, location.worktreeName)
    if (
      !location.worktreeName ||
      !WORKTREE_NAME_PATTERN.test(location.worktreeName) ||
      location.worktreeName === '.' ||
      location.worktreeName === '..' ||
      basename(location.worktreeName) !== location.worktreeName ||
      canonicalPath(dirname(expectedPath)) !== canonicalPath(worktreesDirectory) ||
      location.branchName !== location.worktreeName ||
      canonicalPath(location.worktreePath) !== canonicalPath(expectedPath)
    ) {
      throw new Error('Invalid worktree rollback location mismatch')
    }

    if (await this.pathExists(expectedPath)) {
      ensureSuccess(
        await this.runner.run('git', ['-C', repoRoot, 'worktree', 'remove', expectedPath]),
        'git worktree remove'
      )
    } else {
      const branch = ensureSuccess(
        await this.runner.run('git', ['-C', repoRoot, 'branch', '--list', location.branchName, '--format=%(refname:short)']),
        'git branch --list'
      )
      if (!namesFromLines(branch.stdout).includes(location.branchName)) return
    }

    ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'branch', '-D', location.branchName]),
      'git branch -D'
    )
  }

  private async hasCommittedHead(repoRoot: string): Promise<boolean> {
    try {
      const result = await this.runner.run('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'])
      return result.exitCode === 0 && result.stdout.trim().length > 0
    } catch {
      return false
    }
  }

  private async ensureLocalExclude(repoRoot: string): Promise<void> {
    const result = ensureSuccess(
      await this.runner.run('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'info/exclude']),
      'git rev-parse --git-path info/exclude'
    )
    const output = result.stdout.trim()
    if (!output) throw new Error('Git returned an empty local exclude path')
    const excludePath = resolve(isAbsolute(output) ? output : join(repoRoot, output))
    await this.fileSystem.mkdir(dirname(excludePath), { recursive: true })

    let contents = ''
    try {
      contents = await this.fileSystem.readFile(excludePath, 'utf8')
    } catch (error) {
      if (!missingError(error)) throw error
    }
    if (contents.split(/\r?\n/u).some((line) => line.trim() === EXCLUDE_LINE)) return

    const separator = contents.length > 0 && !/[\r\n]$/u.test(contents) ? '\n' : ''
    await this.fileSystem.appendFile(excludePath, `${separator}${EXCLUDE_LINE}\n`, 'utf8')
  }

  private async nextName(
    repoRoot: string,
    worktreesDirectory: string,
    knownSessions: readonly SessionRecord[]
  ): Promise<string> {
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

    const now = this.clock()
    const date = `${String(now.getFullYear() % 100).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    for (let sequence = 1; ; sequence += 1) {
      const candidate = `worktree-${date}-${sequence}`
      if (!used.has(candidate.toLocaleLowerCase('en-US'))) return candidate
    }
  }

  private registeredPaths(output: string): string[] {
    return output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => resolve(line.slice('worktree '.length)))
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
