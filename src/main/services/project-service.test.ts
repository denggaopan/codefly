import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppState, ProjectRecord } from '../../shared/contracts'
import type { CommandRunner } from '../infrastructure/command-runner'
import { SessionStore } from './session-store'
import { InvalidProjectPathError, ProjectNotFoundError, ProjectOrderMismatchError, ProjectService } from './project-service'

const emptyState = (): AppState => ({ version: 1, projects: [], sessions: [] })
const fsFor = (realPath = 'C:\\Projects\\My App', directory = true) => ({
  realpath: vi.fn(async () => realPath),
  stat: vi.fn(async () => ({ isDirectory: () => directory }))
})
const runnerWith = (run: CommandRunner['run']): CommandRunner => ({ run })
const clock = () => new Date('2026-08-26T00:00:00.000Z')

describe('ProjectService', () => {
  it('rejects blank paths before filesystem access', async () => {
    const fileSystem = fsFor()
    const service = new ProjectService({} as SessionStore, undefined, fileSystem)

    await expect(service.register('  ')).rejects.toBeInstanceOf(InvalidProjectPathError)
    expect(fileSystem.realpath).not.toHaveBeenCalled()
  })

  it('converts missing and file paths into InvalidProjectPathError', async () => {
    const missingCause = new Error('missing')
    const missingFs = { realpath: vi.fn(async () => { throw missingCause }), stat: vi.fn() }
    const missing = new ProjectService({} as SessionStore, undefined, missingFs)
    await expect(missing.register('C:\\missing')).rejects.toMatchObject({ selectedPath: 'C:\\missing', cause: missingCause })

    const file = new ProjectService({} as SessionStore, undefined, fsFor('C:\\file.txt', false))
    await expect(file.register('C:\\file.txt')).rejects.toBeInstanceOf(InvalidProjectPathError)
  })

  it('registers a Git directory and preserves existing state', async () => {
    let state: AppState = { ...emptyState(), sessions: [{ id: 's1', projectId: 'old', kind: 'powershell', title: 'Terminal', titleState: 'pending', createdAt: '2026-08-26T00:00:00.000Z', mode: 'ordinary', launchPath: 'C:\\Old', status: 'stopped' }] }
    const store = { load: vi.fn(async () => structuredClone(state)), update: vi.fn(async (mutator) => { state = await mutator(structuredClone(state)); return structuredClone(state) }) } as unknown as SessionStore
    const run = vi.fn().mockResolvedValue({ stdout: 'C:\\Projects\\Repo\n', stderr: '', exitCode: 0 })
    const service = new ProjectService(store, runnerWith(run), fsFor(), clock, () => 'new-id')

    await expect(service.register('C:\\selected')).resolves.toEqual({ id: 'new-id', name: 'My App', path: 'C:\\Projects\\My App', repoRoot: 'C:\\Projects\\Repo', createdAt: '2026-08-26T00:00:00.000Z' })
    expect(state.sessions).toHaveLength(1)
    expect(run).toHaveBeenCalledWith('git', ['-C', 'C:\\Projects\\My App', 'rev-parse', '--show-toplevel'])
  })

  it('omits repoRoot when Git probing rejects', async () => {
    let state = emptyState()
    const store = { load: vi.fn(async () => structuredClone(state)), update: vi.fn(async (mutator) => { state = await mutator(structuredClone(state)); return structuredClone(state) }) } as unknown as SessionStore
    const service = new ProjectService(store, runnerWith(vi.fn().mockRejectedValue(new Error('not git'))), fsFor('C:\\Projects\\Plain'), clock, () => 'plain')

    await expect(service.register('C:\\plain')).resolves.toEqual({ id: 'plain', name: 'Plain', path: 'C:\\Projects\\Plain', createdAt: '2026-08-26T00:00:00.000Z' })
  })

  it('returns an equivalent registered path without probing Git or persisting', async () => {
    const existing: ProjectRecord = { id: 'old', name: 'Existing', path: 'C:\\Projects\\My App', createdAt: '2026-08-26T00:00:00.000Z' }
    const store = { load: vi.fn(async () => ({ ...emptyState(), projects: [existing] })), update: vi.fn() } as unknown as SessionStore
    const run = vi.fn()
    const service = new ProjectService(store, runnerWith(run), fsFor('c:/projects/my app/'), clock, () => 'new')

    await expect(service.register('C:\\other')).resolves.toBe(existing)
    expect(run).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
  })

  it('serializes equivalent concurrent registrations to one persisted project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codefly-project-service-'))
    const store = new SessionStore(join(directory, 'state.json'))
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const ids = ['first-id', 'second-id']
    const createId = vi.fn(() => ids.shift()!)
    const service = new ProjectService(store, runnerWith(run), fsFor('C:\\Projects\\Concurrent'), clock, createId)
    try {
      const [first, second] = await Promise.all([service.register('C:\\one'), service.register('C:\\two')])
      expect(first.id).toBe('first-id')
      expect(second.id).toBe('first-id')
      expect(createId).toHaveBeenCalledTimes(2)
      await expect(store.load()).resolves.toMatchObject({ projects: [{ id: 'first-id' }] })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('gets records by ID and uses ProjectNotFoundError otherwise', async () => {
    const project: ProjectRecord = { id: 'p1', name: 'One', path: 'C:\\One', createdAt: '2026-08-26T00:00:00.000Z' }
    const store = { load: vi.fn(async () => ({ ...emptyState(), projects: [project] })) } as unknown as SessionStore
    const service = new ProjectService(store)

    await expect(service.get('p1')).resolves.toBe(project)
    await expect(service.get('')).rejects.toMatchObject({ projectId: '' })
    await expect(service.get('missing')).rejects.toBeInstanceOf(ProjectNotFoundError)
  })

  it.each([
    ['drive roots with trailing separators', 'C:\\', 'c:/'],
    ['UNC paths with case and separator differences', '\\\\Server\\Share\\Project\\', '//server/share/project'],
    ['non-ASCII paths with case and separator differences', 'C:\\Projects\\\u6f22\u5b57\\', 'c:/projects/\u6f22\u5b57']
  ])('deduplicates %s using Windows-safe normalization', async (_label, storedPath, realPath) => {
    const existing: ProjectRecord = { id: 'existing', name: 'Existing', path: storedPath, createdAt: '2026-08-26T00:00:00.000Z' }
    const store = { load: vi.fn(async () => ({ ...emptyState(), projects: [existing] })), update: vi.fn() } as unknown as SessionStore
    const run = vi.fn()
    const service = new ProjectService(store, runnerWith(run), fsFor(realPath), clock, () => 'new')

    await expect(service.register('C:\\selected')).resolves.toBe(existing)
    expect(run).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
  })

  it('uses POSIX separators without folding case for macOS project identity', async () => {
    const existing: ProjectRecord = {
      id: 'existing',
      name: 'Project',
      path: '/Users/me/Project/',
      createdAt: '2026-08-26T00:00:00.000Z'
    }
    let state: AppState = { ...emptyState(), projects: [existing] }
    const store = {
      load: vi.fn(async () => structuredClone(state)),
      update: vi.fn(async (mutator) => {
        state = await mutator(structuredClone(state))
        return structuredClone(state)
      })
    } as unknown as SessionStore
    const run = vi.fn().mockRejectedValue(new Error('not git'))
    const sameCase = new ProjectService(store, runnerWith(run), fsFor('/Users/me/Project'), clock, () => 'same', 'darwin')

    await expect(sameCase.register('/Users/me/Project')).resolves.toEqual(existing)

    const differentCase = new ProjectService(store, runnerWith(run), fsFor('/Users/me/project'), clock, () => 'new', 'darwin')
    await expect(differentCase.register('/Users/me/project')).resolves.toMatchObject({
      id: 'new',
      name: 'project',
      path: '/Users/me/project'
    })
    expect(state.projects).toHaveLength(2)
  })
})

describe('ProjectService.reorder', () => {
  const projectAt = (id: string): ProjectRecord => ({ id, name: id, path: `C:\\${id}`, createdAt: '2026-08-26T00:00:00.000Z' })

  const storeWith = (projects: ProjectRecord[]) => {
    let state: AppState = { ...emptyState(), projects }
    return {
      state: () => state,
      store: {
        load: vi.fn(async () => structuredClone(state)),
        update: vi.fn(async (mutator: (state: AppState) => AppState | Promise<AppState>) => {
          state = await mutator(structuredClone(state))
          return structuredClone(state)
        })
      } as unknown as SessionStore
    }
  }

  it('persists the requested order and returns the reordered records', async () => {
    const { store, state } = storeWith([projectAt('p1'), projectAt('p2'), projectAt('p3')])
    const service = new ProjectService(store)

    const reordered = await service.reorder(['p3', 'p1', 'p2'])

    expect(reordered.map((project) => project.id)).toEqual(['p3', 'p1', 'p2'])
    expect(state().projects.map((project) => project.id)).toEqual(['p3', 'p1', 'p2'])
  })

  it.each([
    ['a missing project id', ['p1']],
    ['an unknown project id', ['p1', 'ghost']],
    ['a duplicated project id', ['p1', 'p1']]
  ])('rejects %s without persisting', async (_label, orderedIds) => {
    const { store, state } = storeWith([projectAt('p1'), projectAt('p2')])
    const service = new ProjectService(store)

    await expect(service.reorder(orderedIds)).rejects.toBeInstanceOf(ProjectOrderMismatchError)
    expect(state().projects.map((project) => project.id)).toEqual(['p1', 'p2'])
  })

  it('validates against the latest persisted state inside the update transaction', async () => {
    // A project registered between the renderer reading the list and dropping the row must
    // not be silently discarded by the stale order.
    const { store } = storeWith([projectAt('p1'), projectAt('p2'), projectAt('late')])
    const service = new ProjectService(store)

    await expect(service.reorder(['p2', 'p1'])).rejects.toBeInstanceOf(ProjectOrderMismatchError)
  })
})

describe('ProjectService: repository remotes', () => {
  type GitFixture = { repoRoot?: string; remotes?: Record<string, string>; fail?: boolean }
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })

  // Answers the three git invocations the service makes, keyed by project path so one runner
  // can serve several projects with different remotes at once.
  const gitRunner = (fixtures: Record<string, GitFixture>) =>
    vi.fn(async (_file: string, args: readonly string[]) => {
      const fixture = fixtures[args[1]!]
      if (!fixture || fixture.fail) throw new Error(`git failed for ${args.join(' ')}`)
      if (args[2] === 'rev-parse') {
        if (!fixture.repoRoot) throw new Error('not a git repository')
        return ok(`${fixture.repoRoot}\n`)
      }
      if (args[2] === 'remote' && args.length === 3) return ok(Object.keys(fixture.remotes ?? {}).map((name) => `${name}\n`).join(''))
      if (args[2] === 'remote' && args[3] === 'get-url') {
        const url = fixture.remotes?.[args[4]!]
        if (url === undefined) throw new Error(`No such remote '${args[4]}'`)
        return ok(`${url}\n`)
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

  const storeWith = (projects: ProjectRecord[]) => {
    let state: AppState = { ...emptyState(), projects }
    return {
      state: () => state,
      store: {
        load: vi.fn(async () => structuredClone(state)),
        update: vi.fn(async (mutator: (state: AppState) => AppState | Promise<AppState>) => {
          state = await mutator(structuredClone(state))
          return structuredClone(state)
        })
      } as unknown as SessionStore
    }
  }

  const projectPath = 'C:\\Projects\\My App'
  const projectAt = (id: string, path: string, repoRemote?: ProjectRecord['repoRemote']): ProjectRecord => ({
    id,
    name: id,
    path,
    repoRoot: path,
    ...(repoRemote ? { repoRemote } : {}),
    createdAt: '2026-08-26T00:00:00.000Z'
  })

  it('records the origin remote as the browsable repository when registering', async () => {
    const { store } = storeWith([])
    const run = gitRunner({
      [projectPath]: { repoRoot: projectPath, remotes: { upstream: 'https://gitlab.com/up/stream.git', origin: 'git@github.com:me/app.git' } }
    })
    const service = new ProjectService(store, runnerWith(run), fsFor(), clock, () => 'new-id')

    await expect(service.register('C:\\selected')).resolves.toMatchObject({
      repoRoot: projectPath,
      repoRemote: { host: 'github', webUrl: 'https://github.com/me/app' }
    })
    expect(run).toHaveBeenCalledWith('git', ['-C', projectPath, 'remote', 'get-url', 'origin'])
  })

  it('falls back to the first listed remote when there is no origin', async () => {
    const { store } = storeWith([])
    const run = gitRunner({
      [projectPath]: { repoRoot: projectPath, remotes: { upstream: 'https://gitlab.com/up/stream.git', fork: 'https://github.com/me/fork.git' } }
    })
    const service = new ProjectService(store, runnerWith(run), fsFor(), clock, () => 'new-id')

    await expect(service.register('C:\\selected')).resolves.toMatchObject({
      repoRemote: { host: 'gitlab', webUrl: 'https://gitlab.com/up/stream' }
    })
  })

  it.each([
    ['no remotes at all', {}],
    ['only a local-directory remote', { origin: 'D:\\mirrors\\app.git' }]
  ])('omits repoRemote for a repository with %s', async (_label, remotes) => {
    const { store } = storeWith([])
    const run = gitRunner({ [projectPath]: { repoRoot: projectPath, remotes } })
    const service = new ProjectService(store, runnerWith(run), fsFor(), clock, () => 'new-id')

    const registered = await service.register('C:\\selected')
    expect(registered.repoRoot).toBe(projectPath)
    expect(registered).not.toHaveProperty('repoRemote')
  })

  it('does not probe remotes for a directory outside any Git repository', async () => {
    const { store } = storeWith([])
    const run = gitRunner({ [projectPath]: {} })
    const service = new ProjectService(store, runnerWith(run), fsFor(), clock, () => 'new-id')

    const registered = await service.register('C:\\selected')
    expect(registered).not.toHaveProperty('repoRemote')
    expect(run.mock.calls.some(([, args]) => args[2] === 'remote')).toBe(false)
  })

  it('refreshRemotes re-resolves every project and persists the changed set once', async () => {
    const changed = projectAt('changed', 'C:\\changed', { host: 'github', webUrl: 'https://github.com/old/app' })
    const added = projectAt('added', 'C:\\added')
    const removed = projectAt('removed', 'C:\\removed', { host: 'git', webUrl: 'https://git.example.com/gone/repo' })
    const unreachable = projectAt('unreachable', 'C:\\unreachable', { host: 'gitlab', webUrl: 'https://gitlab.com/kept/repo' })
    const { store, state } = storeWith([changed, added, removed, unreachable])
    const run = gitRunner({
      'C:\\changed': { repoRoot: 'C:\\changed', remotes: { origin: 'git@gitlab.com:new/app.git' } },
      'C:\\added': { repoRoot: 'C:\\added', remotes: { origin: 'https://github.com/me/added.git' } },
      'C:\\removed': { repoRoot: 'C:\\removed', remotes: {} },
      'C:\\unreachable': { fail: true }
    })
    const service = new ProjectService(store, runnerWith(run))

    await expect(service.refreshRemotes()).resolves.toBeUndefined()

    expect(state().projects).toEqual([
      { ...changed, repoRemote: { host: 'gitlab', webUrl: 'https://gitlab.com/new/app' } },
      { ...added, repoRemote: { host: 'github', webUrl: 'https://github.com/me/added' } },
      projectAt('removed', 'C:\\removed'),
      unreachable
    ])
    expect(store.update).toHaveBeenCalledTimes(1)
  })

  it('refreshRemotes leaves the store untouched when every remote is unchanged', async () => {
    const same = projectAt('same', 'C:\\same', { host: 'github', webUrl: 'https://github.com/me/app' })
    const plain = projectAt('plain', 'C:\\plain')
    const { store } = storeWith([same, plain])
    const run = gitRunner({
      'C:\\same': { repoRoot: 'C:\\same', remotes: { origin: 'https://github.com/me/app.git' } },
      'C:\\plain': { repoRoot: 'C:\\plain', remotes: {} }
    })
    const service = new ProjectService(store, runnerWith(run))

    await service.refreshRemotes()

    expect(store.update).not.toHaveBeenCalled()
  })

  it('refreshRemotes never rejects, even when the store cannot be read', async () => {
    const store = { load: vi.fn().mockRejectedValue(new Error('corrupt')), update: vi.fn() } as unknown as SessionStore
    const service = new ProjectService(store, runnerWith(vi.fn()))

    await expect(service.refreshRemotes()).resolves.toBeUndefined()
    expect(store.update).not.toHaveBeenCalled()
  })
})
