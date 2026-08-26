import { access, appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectRecord, SessionRecord } from '../../shared/contracts'
import { commandRunner } from '../infrastructure/command-runner'
import type { CommandRunner, CommandResult } from '../infrastructure/command-runner'
import { WorktreeService } from './worktree-service'
import type { SessionLocation, WorktreeFileSystem } from './worktree-service'

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

const replaceWorktreeWithJunction = async (
  root: string,
  location: Extract<SessionLocation, { mode: 'worktree' }>
): Promise<{ physicalPath: string; sentinel: string }> => {
  const external = await makeDirectory()
  const physicalPath = join(external, 'redirected-child')
  await rename(location.worktreePath, physicalPath)
  const excludePath = resolve(root, (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim())
  await appendFile(excludePath, 'secret.txt\n', 'utf8')
  const sentinel = join(physicalPath, 'secret.txt')
  await writeFile(sentinel, 'must survive\n', 'utf8')
  await symlink(physicalPath, location.worktreePath, 'junction')
  return { physicalPath, sentinel }
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
}, 30_000)

describe.sequential('WorktreeService real Git lifecycle', { timeout: 30_000 }, () => {
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
      await expect(service.validate(worktreeSession(location), projectFor(root))).resolves.toBe('valid')
    }
  })

  it('serializes concurrent creates across main and linked roots sharing one common dir', async () => {
    const root = await makeRepo()
    const linkedOne = join(root, '.linked', 'one')
    const linkedTwo = join(root, '.linked', 'two')
    await git(root, ['worktree', 'add', '-b', 'linked-one', linkedOne, 'HEAD'])
    await git(root, ['worktree', 'add', '-b', 'linked-two', linkedTwo, 'HEAD'])
    const delayedRunner: CommandRunner = {
      async run(file, args, cwd) {
        if (file === 'git' && args[2] === 'branch' && String(args[3]).startsWith('--format=')) {
          await new Promise((complete) => setTimeout(complete, 100))
        }
        return commandRunner.run(file, args, cwd)
      }
    }
    const projects = [projectFor(root), projectFor(linkedOne), projectFor(linkedTwo)]

    const locations = await Promise.all(projects.map((project) => new WorktreeService(delayedRunner, clock).create(project, [])))

    expect(locations.map((location) => location.mode === 'worktree' ? location.worktreeName : location.mode).sort()).toEqual([
      'worktree-260826-1',
      'worktree-260826-2',
      'worktree-260826-3'
    ])
    const commonDir = resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim())
    const exclude = await readFile(join(commonDir, 'info', 'exclude'), 'utf8')
    expect(exclude.split(/\r?\n/u).filter((line) => line.trim() === '/.worktrees/')).toHaveLength(1)
  })

  it('validates a worktree beneath a Unicode repository path', async () => {
    const container = await makeDirectory()
    const root = join(container, '\u6f22\u5b57 repo')
    await mkdir(root)
    await initializeRepo(root)
    const service = new WorktreeService(undefined, clock)

    const location = await service.create(projectFor(root), [])

    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    await expect(service.validate(worktreeSession(location), projectFor(root))).resolves.toBe('valid')
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

  it('preserves CRLF while appending a missing exclude line through one handle', async () => {
    const root = await makeRepo()
    const excludePath = resolve(root, (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim())
    await writeFile(excludePath, 'first\r\nsecond', 'utf8')

    await new WorktreeService(undefined, clock).create(projectFor(root), [])

    expect(await readFile(excludePath, 'utf8')).toBe('first\r\nsecond\r\n/.worktrees/\r\n')
    await expectMissing(join(root, '.git', '.codefly-exclude.lock'))
  })

  it('rejects a .worktrees junction without writing through it', async () => {
    const root = await makeRepo()
    const external = await makeDirectory()
    await symlink(external, join(root, '.worktrees'), 'junction')

    await expect(new WorktreeService(undefined, clock).create(projectFor(root), [])).rejects.toThrow(/symbolic|junction|physical/i)

    expect(await readdir(external)).toEqual([])
  })

  it('rejects a symbolic local exclude before append through an injected filesystem', async () => {
    const root = await makeRepo()
    const excludePath = resolve(root, (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim())
    const original = await readFile(excludePath, 'utf8')
    const fileSystem: WorktreeFileSystem = {
      access,
      readdir,
      readFile: (path, encoding) => readFile(path, encoding),
      mkdir,
      async lstat(path) {
        if (resolve(path) === excludePath) return { dev: 1, ino: 1, isDirectory: () => false, isSymbolicLink: () => true }
        const result = await lstat(path)
        return { dev: result.dev, ino: result.ino, isDirectory: () => result.isDirectory(), isSymbolicLink: () => result.isSymbolicLink() }
      },
      stat,
      realpath,
      open,
      unlink
    }

    await expect(new WorktreeService(undefined, clock, fileSystem).create(projectFor(root), [])).rejects.toThrow(/symbolic/i)
    expect(await readFile(excludePath, 'utf8')).toBe(original)
  })

  it('rejects an exclude path replaced after its handle opens', async () => {
    const root = await makeRepo()
    const external = await makeDirectory()
    const excludePath = resolve(root, (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim())
    const heldPath = `${excludePath}.held`
    const replacement = join(external, 'replacement-exclude')
    await writeFile(replacement, 'external sentinel\n', 'utf8')
    let replaced = false
    const fileSystem: WorktreeFileSystem = {
      access,
      readdir,
      readFile: (path, encoding) => readFile(path, encoding),
      mkdir,
      lstat,
      stat,
      realpath,
      async open(path, flags) {
        const handle = await open(path, flags)
        if (!replaced && resolve(path) === excludePath && flags === 'a+') {
          replaced = true
          await rename(excludePath, heldPath)
          await symlink(replacement, excludePath, 'file')
        }
        return handle
      },
      unlink
    }

    await expect(new WorktreeService(undefined, clock, fileSystem).create(projectFor(root), [])).rejects.toThrow(/symbolic|changed/i)
    expect(await readFile(replacement, 'utf8')).toBe('external sentinel\n')
    expect(await readFile(heldPath, 'utf8')).not.toContain('/.worktrees/')
    await expectMissing(join(root, '.git', '.codefly-exclude.lock'))
  })

  it('places the exclude lock directly under the physical common dir when info is a junction', async () => {
    const root = await makeRepo()
    const commonDir = resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim())
    const infoPath = join(commonDir, 'info')
    const safeInfo = join(commonDir, 'safe-info')
    await rename(infoPath, safeInfo)
    await symlink(safeInfo, infoPath, 'junction')
    const lockPaths: string[] = []
    const fileSystem: WorktreeFileSystem = {
      access,
      readdir,
      readFile: (path, encoding) => readFile(path, encoding),
      mkdir,
      lstat,
      stat,
      realpath,
      async open(path, flags) {
        if (flags === 'wx') lockPaths.push(resolve(path))
        return open(path, flags)
      },
      unlink
    }

    await new WorktreeService(undefined, clock, fileSystem).create(projectFor(root), [])

    expect(lockPaths).toEqual([join(await realpath(commonDir), '.codefly-exclude.lock')])
    await expectMissing(join(safeInfo, 'codefly-exclude.lock'))
    await expectMissing(join(commonDir, '.codefly-exclude.lock'))
  })

  it('rejects an existing symbolic exclude lock without touching its target', async () => {
    const root = await makeRepo()
    const external = await makeDirectory()
    const commonDir = await realpath(resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim()))
    const lockPath = join(commonDir, '.codefly-exclude.lock')
    const target = join(external, 'lock-target')
    await writeFile(target, 'external lock sentinel\n', 'utf8')
    await symlink(target, lockPath, 'file')

    await expect(new WorktreeService(undefined, clock).create(projectFor(root), [])).rejects.toThrow(/lock is symbolic/i)

    expect(await readFile(target, 'utf8')).toBe('external lock sentinel\n')
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true)
  })

  it('does not unlink a replacement of the acquired exclude lock', async () => {
    const root = await makeRepo()
    const commonDir = await realpath(resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim()))
    const lockPath = join(commonDir, '.codefly-exclude.lock')
    const heldLock = join(commonDir, '.codefly-exclude.lock.held')
    let replaced = false
    const fileSystem: WorktreeFileSystem = {
      access,
      readdir,
      readFile: (path, encoding) => readFile(path, encoding),
      mkdir,
      lstat,
      stat,
      realpath,
      async open(path, flags) {
        const handle = await open(path, flags)
        if (!replaced && resolve(path) === lockPath && flags === 'wx') {
          replaced = true
          await rename(lockPath, heldLock)
          await writeFile(lockPath, 'replacement lock sentinel\n', 'utf8')
        }
        return handle
      },
      unlink
    }

    await new WorktreeService(undefined, clock, fileSystem).create(projectFor(root), [])

    expect(await readFile(lockPath, 'utf8')).toBe('replacement lock sentinel\n')
    await expectExists(heldLock)
  })

  it('uses the shared common-dir exclude from a linked worktree repository root', async () => {
    const root = await makeRepo()
    const linkedRoot = join(root, '.linked', 'source')
    await git(root, ['worktree', 'add', '-b', 'linked-source', linkedRoot, 'HEAD'])
    const project = projectFor(linkedRoot)
    const service = new WorktreeService(undefined, clock)

    const location = await service.create(project, [])

    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    await expect(service.validate(worktreeSession(location), project)).resolves.toBe('valid')
    const commonDir = resolve(linkedRoot, (await git(linkedRoot, ['rev-parse', '--git-common-dir'])).stdout.trim())
    const exclude = await readFile(join(commonDir, 'info', 'exclude'), 'utf8')
    expect(exclude.split(/\r?\n/u).filter((line) => line.trim() === '/.worktrees/')).toHaveLength(1)
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

  it('returns a missing mapped launch path when the nested directory exists only in the live checkout', async () => {
    const root = await makeRepo()
    const liveOnlyPath = join(root, 'live-only', 'nested')
    await mkdir(liveOnlyPath, { recursive: true })
    await writeFile(join(liveOnlyPath, 'untracked.txt'), 'live only\n', 'utf8')
    const project = projectFor(root, liveOnlyPath)
    const service = new WorktreeService(undefined, clock)

    const location = await service.create(project, [])

    expect(location).toMatchObject({
      mode: 'worktree',
      launchPath: join(root, '.worktrees', 'worktree-260826-1', 'live-only', 'nested')
    })
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    await expectMissing(location.launchPath)
    await expect(service.validate(worktreeSession(location), project)).resolves.toBe('valid')
    await expectExists(location.worktreePath)
    expect(await branchExists(root, location.branchName)).toBe(true)
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

    await expect(service.validate(session, projectFor(root))).resolves.toBe('valid')
    await rm(location.worktreePath, { recursive: true, force: true })
    await expect(service.validate(session, projectFor(root))).resolves.toBe('missing')
    await expect(service.validate(ordinarySession(root), projectFor(root))).resolves.toBe('valid')
    await expect(service.validate(ordinarySession(join(root, 'absent')), projectFor(root))).resolves.toBe('missing')
  })

  it('rejects forged session ownership tuples without status or removal mutations', async () => {
    const root = await makeRepo()
    const foreignRoot = await makeRepo()
    const project = projectFor(root)
    const creator = new WorktreeService(undefined, clock)
    const owned = await creator.create(project, [])
    if (owned.mode !== 'worktree') throw new Error('Expected worktree')
    const foreignName = 'worktree-260826-9'
    const foreignPath = join(foreignRoot, '.worktrees', foreignName)
    await git(foreignRoot, ['worktree', 'add', '-b', foreignName, foreignPath, 'HEAD'])

    let destructiveCommands = 0
    const guardedRunner: CommandRunner = {
      async run(file, args, cwd) {
        if (file === 'git' && (args[2] === 'status' || (args[2] === 'worktree' && args[3] === 'remove'))) {
          destructiveCommands += 1
        }
        return commandRunner.run(file, args, cwd)
      }
    }
    const service = new WorktreeService(guardedRunner, clock)
    const valid = worktreeSession(owned)
    const foreign = worktreeSession({
      mode: 'worktree',
      launchPath: foreignPath,
      worktreeName: foreignName,
      worktreePath: foreignPath,
      branchName: foreignName,
      repoRoot: foreignRoot
    }, 'foreign-session')
    const adversarial: SessionRecord[] = [
      { ...valid, projectId: 'wrong-project' },
      { ...valid, branchName: 'worktree-260826-99' },
      { ...valid, worktreeName: 'worktree-260826-99' },
      { ...valid, launchPath: root },
      { ...valid, launchPath: join(owned.worktreePath, 'packages') },
      foreign,
      { ...valid, worktreePath: '' } as SessionRecord
    ]

    for (const session of adversarial) {
      await expect(service.validate(session, project)).resolves.toBe('missing')
      await expect(service.remove(session, project)).resolves.toEqual({ status: 'missing' })
    }
    await expect(service.validate(valid, { ...project, id: 'different' })).resolves.toBe('missing')
    await expect(service.remove(valid, { ...project, id: 'different' })).resolves.toEqual({ status: 'missing' })
    expect(destructiveCommands).toBe(0)
    await expectExists(owned.worktreePath)
    await expectExists(foreignPath)
  })

  it('fails closed if .worktrees becomes a junction after creation', async () => {
    const root = await makeRepo()
    const external = await makeDirectory()
    const project = projectFor(root)
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(project, [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    const redirected = join(external, 'redirected')
    await rename(join(root, '.worktrees'), redirected)
    await symlink(redirected, join(root, '.worktrees'), 'junction')
    const physicalTarget = join(redirected, location.worktreeName)

    await expect(service.validate(worktreeSession(location), project)).resolves.toBe('missing')
    await expect(service.remove(worktreeSession(location), project)).resolves.toEqual({ status: 'missing' })
    await expectExists(physicalTarget)
    expect(await branchExists(root, location.branchName)).toBe(true)
  })

  it('fails closed when a worktree child becomes a junction before validate or remove', async () => {
    const root = await makeRepo()
    const project = projectFor(root)
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(project, [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    const { sentinel } = await replaceWorktreeWithJunction(root, location)

    await expect(service.validate(worktreeSession(location), project)).resolves.toBe('missing')
    await expect(service.remove(worktreeSession(location), project)).resolves.toEqual({ status: 'missing' })
    expect(await readFile(sentinel, 'utf8')).toBe('must survive\n')
    expect(await branchExists(root, location.branchName)).toBe(true)
  })

  it('rejects rollback when its worktree child becomes a junction', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    const { sentinel } = await replaceWorktreeWithJunction(root, location)

    await expect(service.rollback(location)).rejects.toThrow(/physical|symbolic|junction/i)
    expect(await readFile(sentinel, 'utf8')).toBe('must survive\n')
    expect(await branchExists(root, location.branchName)).toBe(true)
  })

  it('requires ordinary sessions to match their project without deleting files', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const project = projectFor(root)

    await expect(service.validate({ ...ordinarySession(root), projectId: 'wrong' }, project)).resolves.toBe('missing')
    await expect(service.validate(ordinarySession(join(root, 'packages')), project)).resolves.toBe('missing')
    await expect(service.remove({ ...ordinarySession(root), projectId: 'wrong' }, project)).resolves.toEqual({ status: 'missing' })
    await expect(service.remove(ordinarySession(root), project)).resolves.toEqual({ status: 'removed' })
    await expectExists(join(root, 'tracked.txt'))
  })

  it('does not create a missing .worktrees directory during validation or removal', async () => {
    const root = await makeRepo()
    const worktreePath = join(root, '.worktrees', 'worktree-260826-1')
    const project = projectFor(root)
    const session = worktreeSession({
      mode: 'worktree',
      launchPath: worktreePath,
      worktreeName: 'worktree-260826-1',
      worktreePath,
      branchName: 'worktree-260826-1',
      repoRoot: root
    })
    const service = new WorktreeService(undefined, clock)

    await expect(service.validate(session, project)).resolves.toBe('missing')
    await expect(service.remove(session, project)).resolves.toEqual({ status: 'missing' })
    await expectMissing(join(root, '.worktrees'))
  })

  it('refuses dirty worktree removal and counts modified and untracked files', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    await git(location.worktreePath, ['mv', 'tracked.txt', 'renamed.txt'])
    await mkdir(join(location.worktreePath, 'untracked'))
    await writeFile(join(location.worktreePath, 'untracked', 'one.txt'), 'one\n', 'utf8')
    await writeFile(join(location.worktreePath, 'untracked', 'two.txt'), 'two\n', 'utf8')

    await expect(service.remove(worktreeSession(location), projectFor(root))).resolves.toEqual({ status: 'dirty', changedFiles: 3 })
    await expectExists(location.worktreePath)
    expect(await listedWorktreePaths(root)).toContain(resolve(location.worktreePath))
  })

  it('removes a clean worktree but deliberately leaves its branch', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')

    await expect(service.remove(worktreeSession(location), projectFor(root))).resolves.toEqual({ status: 'removed' })

    await expectMissing(location.worktreePath)
    expect(await listedWorktreePaths(root)).not.toContain(resolve(location.worktreePath))
    expect(await branchExists(root, location.branchName)).toBe(true)
  })

  it('removes ordinary metadata without touching its original files or Git state', async () => {
    const root = await makeRepo()
    const pathsBefore = await listedWorktreePaths(root)
    const contentsBefore = await readFile(join(root, 'tracked.txt'), 'utf8')

    await expect(new WorktreeService(undefined, clock).remove(ordinarySession(root), projectFor(root))).resolves.toEqual({ status: 'removed' })

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
    await expect(service.rollback(mismatch)).rejects.toThrow(/provenance|mismatch|invalid/i)
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
    await expect(service.rollback(foreign)).rejects.toThrow(/provenance|mismatch/i)
    await expectExists(foreignPath)
    expect(await branchExists(root, 'foreign')).toBe(true)

    const traversal = { ...second, worktreeName: '..', branchName: '..', worktreePath: root }
    await expect(service.rollback(traversal)).rejects.toThrow(/provenance|mismatch/i)
    await expectExists(second.worktreePath)
    expect(await branchExists(root, second.branchName)).toBe(true)

    await git(root, ['worktree', 'remove', second.worktreePath])
    await service.rollback(second)
    expect(await branchExists(root, second.branchName)).toBe(false)
  })

  it('requires exact rollback provenance and consumes it once', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')

    await expect(service.rollback({ ...location })).rejects.toThrow(/provenance/i)
    await expectExists(location.worktreePath)
    await service.rollback(location)
    await expect(service.rollback(location)).rejects.toThrow(/provenance/i)
    expect(await branchExists(root, location.branchName)).toBe(false)
  })

  it('preserves advanced or moved worktrees during rollback', async () => {
    const advancedRoot = await makeRepo()
    const movedRoot = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const advanced = await service.create(projectFor(advancedRoot), [])
    const moved = await service.create(projectFor(movedRoot), [])
    if (advanced.mode !== 'worktree' || moved.mode !== 'worktree') throw new Error('Expected worktrees')

    await writeFile(join(advanced.worktreePath, 'advance.txt'), 'advance\n', 'utf8')
    await git(advanced.worktreePath, ['add', 'advance.txt'])
    await git(advanced.worktreePath, ['commit', '-m', 'advance branch'])
    await expect(service.rollback(advanced)).rejects.toThrow(/changed|OID/i)
    await expectExists(advanced.worktreePath)
    expect(await branchExists(advancedRoot, advanced.branchName)).toBe(true)

    const movedPath = join(movedRoot, '.worktrees', 'moved-elsewhere')
    await git(movedRoot, ['worktree', 'move', moved.worktreePath, movedPath])
    await expect(service.rollback(moved)).rejects.toThrow(/moved|registered|mismatch/i)
    await expectExists(movedPath)
    expect(await branchExists(movedRoot, moved.branchName)).toBe(true)
  })

  it('rejects rollback when a branch advances behind an ambiguous same-name tag', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    const initialOid = (await git(root, ['rev-parse', `refs/heads/${location.branchName}`])).stdout.trim()
    await git(root, ['tag', location.branchName, initialOid])
    await writeFile(join(location.worktreePath, 'advance-behind-tag.txt'), 'advance\n', 'utf8')
    await git(location.worktreePath, ['add', 'advance-behind-tag.txt'])
    await git(location.worktreePath, ['commit', '-m', 'advance behind tag'])

    await expect(service.rollback(location)).rejects.toThrow(/changed|OID|ambiguous/i)
    await expectExists(location.worktreePath)
    expect(await branchExists(root, location.branchName)).toBe(true)
  })

  it('preserves a same-name worktree replacement with a different OID', async () => {
    const root = await makeRepo()
    const service = new WorktreeService(undefined, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    await git(root, ['worktree', 'remove', location.worktreePath])
    await git(root, ['branch', '-D', location.branchName])
    await writeFile(join(root, 'replacement.txt'), 'replacement\n', 'utf8')
    await git(root, ['add', 'replacement.txt'])
    await git(root, ['commit', '-m', 'replacement base'])
    await git(root, ['worktree', 'add', '-b', location.branchName, location.worktreePath, 'HEAD'])

    await expect(service.rollback(location)).rejects.toThrow(/changed|OID/i)
    await expectExists(location.worktreePath)
    expect(await branchExists(root, location.branchName)).toBe(true)
  })

  it('preserves a branch advanced after rollback OID precheck but before removal', async () => {
    const root = await makeRepo()
    let advanceDuringRemove = false
    const runner: CommandRunner = {
      async run(file, args, cwd) {
        if (advanceDuringRemove && file === 'git' && args[2] === 'worktree' && args[3] === 'remove') {
          const worktreePath = String(args[4])
          await writeFile(join(worktreePath, 'race-commit.txt'), 'survive\n', 'utf8')
          await git(worktreePath, ['add', 'race-commit.txt'])
          await git(worktreePath, ['commit', '-m', 'advance during rollback remove'])
        }
        return commandRunner.run(file, args, cwd)
      }
    }
    const service = new WorktreeService(runner, clock)
    const location = await service.create(projectFor(root), [])
    if (location.mode !== 'worktree') throw new Error('Expected worktree')
    advanceDuringRemove = true

    await expect(service.rollback(location)).rejects.toThrow(/changed|update-ref|reference/i)
    expect(await branchExists(root, location.branchName)).toBe(true)
    expect((await git(root, ['show', `refs/heads/${location.branchName}:race-commit.txt`])).stdout.trim()).toBe('survive')
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

  it('surfaces a second real collision without a third add attempt', async () => {
    const root = await makeRepo()
    let addAttempts = 0
    const runner: CommandRunner = {
      async run(file, args, cwd) {
        if (file === 'git' && args[2] === 'worktree' && args[3] === 'add') {
          addAttempts += 1
          await git(root, ['branch', String(args[5]), 'HEAD'])
        }
        return commandRunner.run(file, args, cwd)
      }
    }

    await expect(new WorktreeService(runner, clock).create(projectFor(root), [])).rejects.toThrow()
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

  it('cleans one successful add when exact branch OID lookup fails without retrying', async () => {
    const root = await makeRepo()
    let addAttempts = 0
    let oidAttempts = 0
    const runner: CommandRunner = {
      async run(file, args, cwd) {
        if (file === 'git' && args[2] === 'worktree' && args[3] === 'add') addAttempts += 1
        if (file === 'git' && args[2] === 'rev-parse' && String(args[3]).startsWith('refs/heads/worktree-')) {
          oidAttempts += 1
          return commandRunner.run('git', ['-C', root, 'rev-parse', 'refs/heads/does-not-exist'], cwd)
        }
        return commandRunner.run(file, args, cwd)
      }
    }
    const target = join(root, '.worktrees', 'worktree-260826-1')

    await expect(new WorktreeService(runner, clock).create(projectFor(root), [])).rejects.toThrow()

    expect(addAttempts).toBe(1)
    expect(oidAttempts).toBe(1)
    await expectMissing(target)
    expect(await branchExists(root, 'worktree-260826-1')).toBe(false)
    expect(await listedWorktreePaths(root)).not.toContain(resolve(target))
  })

  it('rejects a worktree child swapped for a junction immediately after add', async () => {
    const root = await makeRepo()
    const external = await makeDirectory()
    const original = join(external, 'original-worktree')
    const redirect = join(external, 'redirect-target')
    const sentinel = join(redirect, 'secret.txt')
    await mkdir(redirect)
    await writeFile(sentinel, 'must survive post-add swap\n', 'utf8')
    let addedPath = ''
    const runner: CommandRunner = {
      async run(file, args, cwd) {
        const result = await commandRunner.run(file, args, cwd)
        if (file === 'git' && args[2] === 'worktree' && args[3] === 'add') {
          addedPath = String(args[6])
          await rename(addedPath, original)
          await symlink(redirect, addedPath, 'junction')
        }
        return result
      }
    }

    await expect(new WorktreeService(runner, clock).create(projectFor(root), [])).rejects.toThrow(/physical|symbolic|junction|cleanup/i)

    expect(await readFile(sentinel, 'utf8')).toBe('must survive post-add swap\n')
    expect(await branchExists(root, 'worktree-260826-1')).toBe(true)
    expect(await listedWorktreePaths(root)).toContain(resolve(addedPath))
    await expectExists(original)
  })

  it('preserves a cleanup branch advanced between failed OID capture and removal', async () => {
    const root = await makeRepo()
    let oidFailed = false
    const runner: CommandRunner = {
      async run(file, args, cwd) {
        if (file === 'git' && args[2] === 'rev-parse' && String(args[3]).startsWith('refs/heads/worktree-')) {
          oidFailed = true
          return commandRunner.run('git', ['-C', root, 'rev-parse', 'refs/heads/does-not-exist'], cwd)
        }
        if (oidFailed && file === 'git' && args[2] === 'worktree' && args[3] === 'remove') {
          const worktreePath = String(args[4])
          await writeFile(join(worktreePath, 'cleanup-race.txt'), 'preserve\n', 'utf8')
          await git(worktreePath, ['add', 'cleanup-race.txt'])
          await git(worktreePath, ['commit', '-m', 'advance during cleanup'])
        }
        return commandRunner.run(file, args, cwd)
      }
    }

    await expect(new WorktreeService(runner, clock).create(projectFor(root), [])).rejects.toThrow()

    expect(await branchExists(root, 'worktree-260826-1')).toBe(true)
    expect((await git(root, ['show', 'refs/heads/worktree-260826-1:cleanup-race.txt'])).stdout.trim()).toBe('preserve')
  })
})
