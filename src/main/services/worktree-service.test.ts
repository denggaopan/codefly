import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectRecord, SessionRecord } from '../../shared/contracts'
import { commandRunner } from '../infrastructure/command-runner'
import type { CommandRunner, CommandResult } from '../infrastructure/command-runner'
import { WorktreeService } from './worktree-service'
import type { SessionLocation } from './worktree-service'

const TEMP_PREFIX = 'codefly-worktree-service-'
const roots = new Set<string>()
const clock = () => new Date(2026, 7, 26, 12)

const git = (directory: string, args: readonly string[]): Promise<CommandResult> =>
  commandRunner.run('git', ['-C', directory, ...args])

const makeDirectory = async (prefix = TEMP_PREFIX): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.add(root)
  return root
}

const makeRepo = async (commit = true): Promise<string> => {
  const root = await makeDirectory()
  await initializeRepo(root, commit)
  return root
}

const initializeRepo = async (root: string, commit = true): Promise<void> => {
  await git(root, ['init'])
  await git(root, ['config', 'user.email', 'codefly-tests@example.com'])
  await git(root, ['config', 'user.name', 'CodeFly Tests'])
  if (commit) {
    await writeFile(join(root, 'tracked.txt'), 'committed\n', 'utf8')
    await writeFile(join(root, '.gitignore'), 'dist/\n', 'utf8')
    await mkdir(join(root, 'packages', 'app'), { recursive: true })
    await writeFile(join(root, 'packages', 'app', 'nested.txt'), 'nested\n', 'utf8')
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'initial'])
  }
}

const projectFor = (root: string, path = root): ProjectRecord => ({
  id: 'project-1',
  name: 'Test project',
  path,
  repoRoot: root,
  createdAt: '2026-08-26T00:00:00.000Z'
})

const ordinarySession = (launchPath: string): SessionRecord => ({
  id: 'ordinary-session',
  projectId: 'project-1',
  kind: 'powershell',
  title: 'Terminal',
  titleState: 'complete',
  createdAt: '2026-08-26T00:00:00.000Z',
  mode: 'ordinary',
  launchPath,
  status: 'stopped'
})

const worktreeSession = (
  location: Extract<SessionLocation, { mode: 'worktree' }>,
  id = 'worktree-session'
): SessionRecord => ({
  id,
  projectId: 'project-1',
  kind: 'codex',
  title: 'Codex',
  titleState: 'complete',
  createdAt: '2026-08-26T00:00:00.000Z',
  mode: 'worktree',
  launchPath: location.launchPath,
  worktreeName: location.worktreeName,
  worktreePath: location.worktreePath,
  branchName: location.branchName,
  status: 'stopped'
})

const expectExists = async (path: string): Promise<void> => {
  await expect(stat(path)).resolves.toBeDefined()
}

const expectMissing = async (path: string): Promise<void> => {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

const branchExists = async (root: string, branch: string): Promise<boolean> => {
  try {
    await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

const listedWorktreePaths = async (root: string): Promise<string[]> => {
  const output = (await git(root, ['worktree', 'list', '--porcelain'])).stdout
  return output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)))
}

const assertSafeTempRoot = (root: string): void => {
  const resolvedRoot = resolve(root)
  expect(dirname(resolvedRoot).toLocaleLowerCase('en-US')).toBe(resolve(tmpdir()).toLocaleLowerCase('en-US'))
  expect(basename(resolvedRoot).startsWith(TEMP_PREFIX)).toBe(true)
}

afterEach(async () => {
  for (const root of roots) {
    assertSafeTempRoot(root)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  roots.clear()
})

describe.sequential('WorktreeService real Git lifecycle', () => {
  it('creates sequential dated worktrees and same-named branches from HEAD', async () => {
    const root = await makeRepo()
    const originalHead = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
    const service = new WorktreeService(undefined, clock)

    const first = await service.create(projectFor(root), [])
    const second = await service.create(projectFor(root), first.mode === 'worktree' ? [worktreeSession(first)] : [])

    expect(first).toMatchObject({
      mode: 'worktree',
      worktreeName: 'worktree-260826-1',
      branchName: 'worktree-260826-1',
      launchPath: join(root, '.worktrees', 'worktree-260826-1')
    })
    expect(second).toMatchObject({ mode: 'worktree', worktreeName: 'worktree-260826-2' })
    if (first.mode !== 'worktree' || second.mode !== 'worktree') throw new Error('Expected worktrees')
    await expectExists(first.worktreePath)
    await expectExists(second.worktreePath)
    expect(await branchExists(root, first.branchName)).toBe(true)
    expect(await branchExists(root, second.branchName)).toBe(true)
    expect((await git(first.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(originalHead)
    expect((await git(second.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(originalHead)
  })

  it('combines branch, child directory, known-session, and registered-worktree collisions', async () => {
    const root = await makeRepo()
    const worktrees = join(root, '.worktrees')
    await mkdir(worktrees, { recursive: true })
    await git(root, ['branch', 'worktree-260826-1', 'HEAD'])
    await mkdir(join(worktrees, 'worktree-260826-2'))
    const knownLocation: Extract<SessionLocation, { mode: 'worktree' }> = {
      mode: 'worktree',
      launchPath: join(worktrees, 'worktree-260826-3'),
      worktreeName: 'worktree-260826-3',
      worktreePath: join(worktrees, 'worktree-260826-3'),
      branchName: 'worktree-260826-3',
      repoRoot: root
    }
    await git(root, ['worktree', 'add', '-b', 'worktree-260826-4', join(worktrees, 'worktree-260826-4'), 'HEAD'])

    const location = await new WorktreeService(undefined, clock).create(projectFor(root), [worktreeSession(knownLocation)])

    expect(location).toMatchObject({ mode: 'worktree', worktreeName: 'worktree-260826-5' })
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    await expectExists(location.worktreePath)
  })

  it('serializes concurrent creates into distinct sequential valid worktrees', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)

    const locations = await Promise.all([
      service.create(projectFor(root), []),
      service.create(projectFor(root), []),
      service.create(projectFor(root), [])
    ])

    expect(locations.map((location) => location.mode === 'worktree' ? location.worktreeName : location.mode)).toEqual([
      'worktree-260826-1',
      'worktree-260826-2',
      'worktree-260826-3'
    ])
    for (const location of locations) {
      if (location.mode !== 'worktree') throw new Error('Expected worktree')
      await expect(service.validate(worktreeSession(location))).resolves.toBe('valid')
    }
  })

  it('validates a worktree beneath a Unicode repository path', async () => {
    const container = await makeDirectory()
    const root = join(container, '\u6f22\u5b57 repo')
    await mkdir(root)
    await initializeRepo(root)
    const service = new WorktreeService(undefined, clock)

    const location = await service.create(projectFor(root), [])

    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    await expect(service.validate(worktreeSession(location))).resolves.toBe('valid')
  })

  it('appends the local exclude once without changing tracked .gitignore', async () => {
    const root = await makeRepo()
    const excludePath = (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim()
    await writeFile(resolve(root, excludePath), 'keep-this', 'utf8')
    const gitignoreBefore = await readFile(join(root, '.gitignore'), 'utf8')
    const service = new WorktreeService(undefined, clock)

    await service.create(projectFor(root), [])
    await service.create(projectFor(root), [])

    const exclude = await readFile(resolve(root, excludePath), 'utf8')
    expect(exclude).toBe('keep-this\n/.worktrees/\n')
    expect(exclude.split(/\r?\n/u).filter((line) => line.trim() === '/.worktrees/')).toHaveLength(1)
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(gitignoreBefore)
  })

  it('maps a nested selected project path underneath the new worktree', async () => {
    const root = await makeRepo()
    const nestedPath = join(root, 'packages', 'app')

    const location = await new WorktreeService(undefined, clock).create(projectFor(root, nestedPath), [])

    expect(location).toMatchObject({
      mode: 'worktree',
      launchPath: join(root, '.worktrees', 'worktree-260826-1', 'packages', 'app')
    })
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    expect(relative(location.worktreePath, location.launchPath)).toBe(join('packages', 'app'))
    await expectExists(join(location.launchPath, 'nested.txt'))
  })

  it('returns ordinary locations for non-Git projects and repositories without a commit', async () => {
    const plain = await makeDirectory()
    const emptyRepo = await makeRepo(false)
    const service = new WorktreeService(undefined, clock)

    await expect(service.create({ ...projectFor(plain), repoRoot: undefined }, [])).resolves.toEqual({ mode: 'ordinary', launchPath: plain })
    await expect(service.create(projectFor(emptyRepo), [])).resolves.toEqual({ mode: 'ordinary', launchPath: emptyRepo })
    await expectMissing(join(plain, '.worktrees'))
    await expectMissing(join(emptyRepo, '.worktrees'))
  })

  it('creates from committed HEAD without copying current uncommitted changes', async () => {
    const root = await makeRepo()
    await writeFile(join(root, 'tracked.txt'), 'uncommitted\n', 'utf8')

    const location = await new WorktreeService(undefined, clock).create(projectFor(root), [])

    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    expect((await readFile(join(location.worktreePath, 'tracked.txt'), 'utf8')).trim()).toBe('committed')
  })

  it('validates registered worktrees, external disappearance, and ordinary paths', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    const session = worktreeSession(location)

    await expect(service.validate(session)).resolves.toBe('valid')
    await rm(location.worktreePath, { recursive: true, force: true })
    await expect(service.validate(session)).resolves.toBe('missing')
    await expect(service.validate(ordinarySession(root))).resolves.toBe('valid')
    await expect(service.validate(ordinarySession(join(root, 'absent')))).resolves.toBe('missing')
  })

  it('refuses dirty worktree removal and counts modified and untracked files', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    await writeFile(join(location.worktreePath, 'tracked.txt'), 'modified\n', 'utf8')
    await writeFile(join(location.worktreePath, 'untracked.txt'), 'new\n', 'utf8')

    await expect(service.remove(worktreeSession(location))).resolves.toEqual({ status: 'dirty', changedFiles: 2 })
    await expectExists(location.worktreePath)
    expect(await listedWorktreePaths(root)).toContain(resolve(location.worktreePath))
  })

  it('removes a clean worktree but deliberately leaves its branch', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')

    await expect(service.remove(worktreeSession(location))).resolves.toEqual({ status: 'removed' })

    await expectMissing(location.worktreePath)
    expect(await listedWorktreePaths(root)).not.toContain(resolve(location.worktreePath))
    expect(await branchExists(root, location.branchName)).toBe(true)
  })

  it('removes ordinary metadata without touching its original files or Git state', async () => {
    const root = await makeRepo()
    const pathsBefore = await listedWorktreePaths(root)
    const contentsBefore = await readFile(join(root, 'tracked.txt'), 'utf8')

    await expect(new WorktreeService(undefined, clock).remove(ordinarySession(root))).resolves.toEqual({ status: 'removed' })

    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe(contentsBefore)
    expect(await listedWorktreePaths(root)).toEqual(pathsBefore)
  })

  it('rolls back only exact owned worktrees and their same-named branches', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const first = await service.create(projectFor(root), [])
    if (first.mode !== 'worktree') throw new Error('Expected worktree')

    await service.rollback(first)
    await expectMissing(first.worktreePath)
    expect(await branchExists(root, first.branchName)).toBe(false)

    const second = await service.create(projectFor(root), [])
    if (second.mode !== 'worktree') throw new Error('Expected worktree')
    const mismatch = { ...second, branchName: 'main' }
    await expect(service.rollback(mismatch)).rejects.toThrow(/mismatch|invalid/i)
    await expectExists(second.worktreePath)
    expect(await branchExists(root, second.branchName)).toBe(true)

    const foreignPath = join(root, '.worktrees', 'foreign')
    await git(root, ['worktree', 'add', '-b', 'foreign', foreignPath, 'HEAD'])
    const foreign: Extract<SessionLocation, { mode: 'worktree' }> = {
      mode: 'worktree',
      launchPath: foreignPath,
      worktreeName: 'foreign',
      worktreePath: foreignPath,
      branchName: 'foreign',
      repoRoot: root
    }
    await expect(service.rollback(foreign)).rejects.toThrow('Invalid worktree rollback location mismatch')
    await expectExists(foreignPath)
    expect(await branchExists(root, 'foreign')).toBe(true)

    const traversal = { ...second, worktreeName: '..', branchName: '..', worktreePath: root }
    await expect(service.rollback(traversal)).rejects.toThrow('Invalid worktree rollback location mismatch')
    await expectExists(second.worktreePath)
    expect(await branchExists(root, second.branchName)).toBe(true)

    await git(root, ['worktree', 'remove', second.worktreePath])
    await service.rollback(second)
    expect(await branchExists(root, second.branchName)).toBe(false)
  })

  it('honors the exclude path returned by git rev-parse --git-path', async () => {
    const root = await makeRepo()
    const alternateExclude = join(root, '.git', 'codefly-info', 'exclude')
    const runner: CommandRunner = {
      async run(file, args, cwd) {
        if (file === 'git' && args.length === 5 && args[0] === '-C' && args[1] === root && args[2] === 'rev-parse' && args[3] === '--git-path' && args[4] === 'info/exclude') {
          return { stdout: `${alternateExclude}\n`, stderr: '', exitCode: 0 }
        }
        return commandRunner.run(file, args, cwd)
      }
    }

    await new WorktreeService(runner, clock).create(projectFor(root), [])

    expect(await readFile(alternateExclude, 'utf8')).toBe('/.worktrees/\n')
  })

  it('recomputes names once after a real branch collision race', async () => {
    const root = await makeRepo()
    let addAttempts = 0
    const runner: CommandRunner = {
      async run(file, args, cwd) {
        if (file === 'git' && args[2] === 'worktree' && args[3] === 'add') {
          addAttempts += 1
          if (addAttempts === 1) await git(root, ['branch', String(args[5]), 'HEAD'])
        }
        return commandRunner.run(file, args, cwd)
      }
    }

    const location = await new WorktreeService(runner, clock).create(projectFor(root), [])

    expect(location).toMatchObject({ mode: 'worktree', worktreeName: 'worktree-260826-2' })
    expect(addAttempts).toBe(2)
  })

  it('does not retry a real non-collision Git failure', async () => {
    const root = await makeRepo()
    let addAttempts = 0
    const runner: CommandRunner = {
      async run(file, args, cwd) {
        if (file === 'git' && args[2] === 'worktree' && args[3] === 'add') {
          addAttempts += 1
          if (addAttempts === 1) {
            return commandRunner.run('git', [...args.slice(0, -1), 'refs/heads/does-not-exist'], cwd)
          }
        }
        return commandRunner.run(file, args, cwd)
      }
    }
    const service = new WorktreeService(runner, clock)

    const failed = service.create(projectFor(root), [])
    const waiting = service.create(projectFor(root.toUpperCase(), root.toUpperCase()), [])
    await expect(failed).rejects.toThrow()
    expect(addAttempts).toBe(1)
    await expectMissing(join(root, '.worktrees', 'worktree-260826-1'))
    await expect(waiting).resolves.toMatchObject({
      mode: 'worktree',
      worktreeName: 'worktree-260826-1'
    })
    expect(addAttempts).toBe(2)
  })
})
