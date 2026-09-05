import { describe, expect, it, vi } from 'vitest'

import type { AppState, ProjectRecord, SessionRecord } from '../../shared/contracts'
import type { ProjectService } from './project-service'
import type { SessionStore } from './session-store'
import type { RemoveWorktreeResult, SessionLocation, WorktreeService } from './worktree-service'
import type { TerminalEventMap } from './terminal-service'
import type { TitleService } from './title-service'
import { SessionCoordinator, SessionNotFoundError, type SessionTerminal } from './session-coordinator'

const emptyState = (): AppState => ({ version: 1, projects: [], sessions: [] })

const project: ProjectRecord = {
  id: 'project-1',
  name: 'App',
  path: 'C:\\Projects\\App',
  repoRoot: 'C:\\Projects\\App',
  createdAt: '2026-08-26T00:00:00.000Z'
}

const ordinaryLocation: SessionLocation = { mode: 'ordinary', launchPath: 'C:\\Projects\\App' }

const worktreeLocation: Extract<SessionLocation, { mode: 'worktree' }> = {
  mode: 'worktree',
  launchPath: 'C:\\Projects\\App\\.worktrees\\worktree-260827-1',
  worktreeName: 'worktree-260827-1',
  worktreePath: 'C:\\Projects\\App\\.worktrees\\worktree-260827-1',
  branchName: 'worktree-260827-1',
  repoRoot: 'C:\\Projects\\App'
}

const clock = () => new Date('2026-08-27T00:00:00.000Z')

const fakeStore = (initial: AppState = emptyState()) => {
  let state = initial
  return {
    load: vi.fn(async () => structuredClone(state)),
    update: vi.fn(async (mutator: (state: AppState) => AppState | Promise<AppState>) => {
      state = await mutator(structuredClone(state))
      return structuredClone(state)
    })
  }
}

type FakeStore = ReturnType<typeof fakeStore>

const fakeProjectService = (record: ProjectRecord = project) => ({
  get: vi.fn(async (id: string) => {
    if (id !== record.id) throw new Error(`Project not found: ${id}`)
    return record
  })
})

type FakeProjectService = ReturnType<typeof fakeProjectService>

const fakeWorktreeService = () => ({
  create: vi.fn(async (): Promise<SessionLocation> => ordinaryLocation),
  validate: vi.fn(async (): Promise<'valid' | 'missing'> => 'valid'),
  remove: vi.fn(async (): Promise<RemoveWorktreeResult> => ({ status: 'removed' })),
  rollback: vi.fn(async (_location: Extract<SessionLocation, { mode: 'worktree' }>): Promise<void> => undefined)
})

type FakeWorktreeService = ReturnType<typeof fakeWorktreeService>

type ExitListener = (payload: TerminalEventMap['exit']) => void

/** Stands in for the in-process TerminalService: owns its PTYs, so it cannot detach. */
class FakeTerminalService implements SessionTerminal {
  readonly start = vi.fn(async (_session: SessionRecord, _options?: { resume?: boolean }) => undefined)
  readonly stop = vi.fn(async (_sessionId: string) => undefined)
  readonly stopAll = vi.fn(async () => undefined)
  private readonly exitListeners = new Set<ExitListener>()

  on<K extends keyof TerminalEventMap>(event: K, listener: (payload: TerminalEventMap[K]) => void): () => void {
    if (event === 'exit') {
      const exitListener = listener as unknown as ExitListener
      this.exitListeners.add(exitListener)
      return () => {
        this.exitListeners.delete(exitListener)
      }
    }
    return () => undefined
  }

  emitExit(sessionId: string, exitCode = 0): void {
    for (const listener of [...this.exitListeners]) listener({ sessionId, exitCode })
  }
}

/** Stands in for the pty-host client: the PTYs live elsewhere, so quitting only detaches. */
class FakeDetachableTerminalService extends FakeTerminalService {
  readonly detach = vi.fn(async () => undefined)
}

const fakeTitleService = () => ({
  generate: vi.fn(async (_sessionId: string, _kind: SessionRecord['kind'], input: string) => input),
  cancel: vi.fn((_sessionId: string): void => undefined)
})

type FakeTitleService = ReturnType<typeof fakeTitleService>

type Harness<T extends FakeTerminalService = FakeTerminalService> = {
  store: FakeStore
  projectService: FakeProjectService
  worktreeService: FakeWorktreeService
  terminalService: T
  titleService: FakeTitleService
  coordinator: SessionCoordinator
}

const buildHarness = <T extends FakeTerminalService = FakeTerminalService>(options: {
  initial?: AppState
  createId?: () => string
  terminalService?: T
} = {}): Harness<T> => {
  const store = fakeStore(options.initial)
  const projectService = fakeProjectService()
  const worktreeService = fakeWorktreeService()
  const terminalService = options.terminalService ?? (new FakeTerminalService() as T)
  const titleService = fakeTitleService()
  const coordinator = new SessionCoordinator(
    store as unknown as SessionStore,
    projectService as unknown as ProjectService,
    worktreeService as unknown as WorktreeService,
    terminalService,
    titleService as unknown as TitleService,
    clock,
    options.createId ?? (() => 'session-1')
  )
  return { store, projectService, worktreeService, terminalService, titleService, coordinator }
}

const runningSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'session-1',
  projectId: 'project-1',
  kind: 'powershell',
  title: 'New PowerShell session',
  titleState: 'pending',
  createdAt: '2026-08-27T00:00:00.000Z',
  mode: 'ordinary',
  launchPath: 'C:\\Projects\\App',
  status: 'stopped',
  ...overrides
} as SessionRecord)

describe('SessionCoordinator.create', () => {
  it('creates the worktree location, persists a creating record, starts the PTY, then persists running', async () => {
    const { store, worktreeService, terminalService, coordinator } = buildHarness()

    const record = await coordinator.create('project-1', 'powershell', { worktree: true })

    expect(record).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      kind: 'powershell',
      title: 'New PowerShell session',
      titleState: 'pending',
      status: 'running',
      mode: 'ordinary',
      launchPath: 'C:\\Projects\\App'
    })

    // Transaction order: worktree location, then persist creating, then start PTY, then persist running.
    expect(worktreeService.create.mock.invocationCallOrder[0]).toBeLessThan(store.update.mock.invocationCallOrder[0]!)
    expect(store.update.mock.invocationCallOrder[0]).toBeLessThan(terminalService.start.mock.invocationCallOrder[0]!)
    expect(terminalService.start.mock.invocationCallOrder[0]).toBeLessThan(store.update.mock.invocationCallOrder[1]!)

    expect(store.update).toHaveBeenCalledTimes(2)
    const persisted = await store.load()
    expect(persisted.sessions).toHaveLength(1)
    expect(persisted.sessions[0]).toMatchObject({ status: 'running' })
  })

  it.each([
    ['shell' as const, 'New Shell session'],
    ['powershell' as const, 'New PowerShell session'],
    ['cmd' as const, 'New Command Prompt session'],
    ['claude' as const, 'New Claude session'],
    ['codex' as const, 'New Codex session'],
    ['gemini' as const, 'New Gemini session'],
    ['copilot' as const, 'New GitHub Copilot session'],
    ['cursor' as const, 'New Cursor session'],
    ['comate' as const, 'New Comate session'],
    ['qwen' as const, 'New Qwen Code session']
  ])('uses the exact initial title for %s sessions', async (kind, expectedTitle) => {
    const { coordinator } = buildHarness()

    const record = await coordinator.create('project-1', kind)

    expect(record.title).toBe(expectedTitle)
  })

  it('generates the session id with the injected id factory', async () => {
    const { coordinator } = buildHarness({ createId: () => 'generated-id' })

    const record = await coordinator.create('project-1', 'claude')

    expect(record.id).toBe('generated-id')
  })

  it('removes the temporary record and rolls back a newly created worktree when the PTY fails to start', async () => {
    const { store, worktreeService, terminalService, coordinator } = buildHarness()
    worktreeService.create.mockResolvedValue(worktreeLocation)
    const startError = new Error('agent CLI not found')
    terminalService.start.mockRejectedValue(startError)

    await expect(coordinator.create('project-1', 'claude', { worktree: true })).rejects.toThrow(startError)

    expect(store.update).toHaveBeenCalledTimes(2)
    const persisted = await store.load()
    expect(persisted.sessions).toHaveLength(0)

    expect(worktreeService.rollback).toHaveBeenCalledWith(worktreeLocation)
    // Removal of the temporary record happens before rollback is invoked.
    expect(store.update.mock.invocationCallOrder[1]).toBeLessThan(worktreeService.rollback.mock.invocationCallOrder[0]!)
  })

  it('never asks WorktreeService for a location when no worktree was requested', async () => {
    const { worktreeService, terminalService, coordinator } = buildHarness()

    const record = await coordinator.create('project-1', 'claude')

    expect(worktreeService.create).not.toHaveBeenCalled()
    expect(record).toMatchObject({ mode: 'ordinary', launchPath: project.path })
    expect(terminalService.start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ordinary', launchPath: project.path }))
  })

  it('records ordinary mode when a requested worktree falls back (non-Git project or no commit yet)', async () => {
    const { worktreeService, coordinator } = buildHarness()
    worktreeService.create.mockResolvedValue(ordinaryLocation)

    const record = await coordinator.create('project-1', 'claude', { worktree: true })

    expect(worktreeService.create).toHaveBeenCalledTimes(1)
    expect(record.mode).toBe('ordinary')
  })

  it('records worktree mode with the created branch when a worktree was requested', async () => {
    const { worktreeService, coordinator } = buildHarness()
    worktreeService.create.mockResolvedValue(worktreeLocation)

    const record = await coordinator.create('project-1', 'claude', { worktree: true })

    expect(record).toMatchObject({
      mode: 'worktree',
      worktreeName: worktreeLocation.worktreeName,
      worktreePath: worktreeLocation.worktreePath,
      branchName: worktreeLocation.branchName,
      launchPath: worktreeLocation.launchPath
    })
  })

  it('does not roll back an ordinary-mode session when the PTY fails to start', async () => {
    const { store, worktreeService, terminalService, coordinator } = buildHarness()
    terminalService.start.mockRejectedValue(new Error('powershell missing'))

    await expect(coordinator.create('project-1', 'powershell')).rejects.toThrow(/powershell missing/)

    expect(worktreeService.rollback).not.toHaveBeenCalled()
    const persisted = await store.load()
    expect(persisted.sessions).toHaveLength(0)
  })

  it('serializes concurrent create calls for the same project behind a project lock', async () => {
    const order: string[] = []
    const ids = ['session-a', 'session-b']
    const { worktreeService, terminalService, coordinator } = buildHarness({ createId: () => ids.shift()! })
    worktreeService.create.mockImplementation(async () => {
      order.push('worktree.create')
      return ordinaryLocation
    })
    terminalService.start.mockImplementation(async () => {
      order.push('terminal.start')
    })

    const [a, b] = await Promise.all([
      coordinator.create('project-1', 'powershell', { worktree: true }),
      coordinator.create('project-1', 'powershell', { worktree: true })
    ])

    expect(order).toEqual(['worktree.create', 'terminal.start', 'worktree.create', 'terminal.start'])
    expect(a.id).not.toBe(b.id)
  })

  it('does not revert a title persisted by submitFirstInput while the PTY is still starting', async () => {
    const { store, terminalService, titleService, coordinator } = buildHarness()
    let startResolve!: () => void
    terminalService.start.mockImplementation(
      () => new Promise<undefined>((resolve) => {
        startResolve = () => resolve(undefined)
      })
    )
    titleService.generate.mockResolvedValue('Fix login bug')

    const creation = coordinator.create('project-1', 'claude')
    // Wait until the 'creating' record is persisted and terminalService.start is in flight
    // before racing submitFirstInput's title persistence against create()'s eventual
    // 'running' persist — this is the window the finding described.
    await vi.waitFor(() => expect(terminalService.start).toHaveBeenCalled())

    const titling = coordinator.submitFirstInput('session-1', 'please fix the login bug')
    await vi.waitFor(() => expect(titleService.generate).toHaveBeenCalled())

    startResolve()
    await Promise.all([creation, titling])

    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({
      status: 'running',
      title: 'Fix login bug',
      titleState: 'complete'
    })
  })

  it('stops the started PTY and persists error when the final create update fails', async () => {
    const { store, terminalService, coordinator } = buildHarness()
    const persistFailure = new Error('disk full after PTY start')
    const realUpdate = store.update.getMockImplementation()!
    store.update.mockImplementationOnce(realUpdate).mockRejectedValueOnce(persistFailure)

    await expect(coordinator.create('project-1', 'powershell')).rejects.toThrow(persistFailure)

    expect(terminalService.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1' }))
    expect(terminalService.stop).toHaveBeenCalledWith('session-1')
    await expect(store.load()).resolves.toMatchObject({
      sessions: [{ id: 'session-1', status: 'error', lastError: persistFailure.message }]
    })
  })

  it('stops the PTY and preserves the original error when create compensation cannot persist', async () => {
    const { store, terminalService, coordinator } = buildHarness()
    const persistFailure = new Error('final update failed')
    const compensationFailure = new Error('compensation update failed')
    const realUpdate = store.update.getMockImplementation()!
    store.update
      .mockImplementationOnce(realUpdate)
      .mockRejectedValueOnce(persistFailure)
      .mockRejectedValueOnce(compensationFailure)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(coordinator.create('project-1', 'powershell')).rejects.toThrow(persistFailure)

    expect(terminalService.stop).toHaveBeenCalledWith('session-1')
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('session-1'), compensationFailure)
    consoleError.mockRestore()
  })
})

describe('SessionCoordinator.restore', () => {
  it('validates the worktree before starting and persists running on success', async () => {
    const session = runningSession({ status: 'stopped' })
    const { store, worktreeService, terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })

    const restored = await coordinator.restore('session-1')

    expect(restored.status).toBe('running')
    expect(worktreeService.validate.mock.invocationCallOrder[0]).toBeLessThan(terminalService.start.mock.invocationCallOrder[0]!)
    expect(terminalService.start).toHaveBeenCalledWith(session, { resume: true })
    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ status: 'running' })
  })

  it('stops the started PTY and persists error when the final restore update fails', async () => {
    const session = runningSession({ status: 'stopped' })
    const { store, terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    const persistFailure = new Error('restore status update failed')
    store.update.mockRejectedValueOnce(persistFailure)

    await expect(coordinator.restore('session-1')).rejects.toThrow(persistFailure)

    expect(terminalService.start).toHaveBeenCalledWith(session, { resume: true })
    expect(terminalService.stop).toHaveBeenCalledWith('session-1')
    await expect(store.load()).resolves.toMatchObject({
      sessions: [{ id: 'session-1', status: 'error', lastError: persistFailure.message }]
    })
  })

  it('marks a missing worktree path without starting a PTY', async () => {
    const session = runningSession({ status: 'stopped' })
    const { store, worktreeService, terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    worktreeService.validate.mockResolvedValue('missing')

    const restored = await coordinator.restore('session-1')

    expect(restored.status).toBe('missing')
    expect(terminalService.start).not.toHaveBeenCalled()
    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ status: 'missing' })
  })

  it('persists an error status and rethrows when the PTY fails to start', async () => {
    const session = runningSession({ status: 'stopped' })
    const { store, terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    const startError = new Error('claude not available')
    terminalService.start.mockRejectedValue(startError)

    await expect(coordinator.restore('session-1')).rejects.toThrow(startError)

    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ status: 'error', lastError: 'claude not available' })
  })

  it('rejects with SessionNotFoundError for an unknown session id', async () => {
    const { coordinator } = buildHarness()

    await expect(coordinator.restore('missing-id')).rejects.toBeInstanceOf(SessionNotFoundError)
  })

  it('treats restoring an already-running session as a no-op', async () => {
    const session = runningSession({ status: 'running' })
    const { terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })

    const restored = await coordinator.restore('session-1')

    expect(restored.status).toBe('running')
    expect(terminalService.start).not.toHaveBeenCalled()
  })
})

describe('SessionCoordinator.submitFirstInput', () => {
  it('flips titleState to complete (keeping the temporary title) before calling generate, then persists the sanitized title', async () => {
    const session = runningSession({ kind: 'claude', title: 'New Claude session', status: 'running' })
    const { store, titleService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    titleService.generate.mockResolvedValue('Fix login bug')

    await coordinator.submitFirstInput('session-1', 'please fix the login bug')
    await coordinator.submitFirstInput('session-1', 'a second, later submission')

    // The titleState-flipping store.update (the claim) happens strictly before generate is called.
    expect(store.update.mock.invocationCallOrder[0]).toBeLessThan(titleService.generate.mock.invocationCallOrder[0]!)
    expect(titleService.generate).toHaveBeenCalledTimes(1)
    expect(titleService.generate).toHaveBeenCalledWith('session-1', 'claude', 'please fix the login bug')
    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ title: 'Fix login bug', titleState: 'complete' })
  })

  it('has already persisted titleState complete with the temporary title by the time generate is called', async () => {
    const session = runningSession({ kind: 'claude', title: 'New Claude session', status: 'running' })
    const { store, titleService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    let snapshotWhenGenerateStarts: SessionRecord | undefined
    titleService.generate.mockImplementation(async () => {
      const state = await store.load()
      snapshotWhenGenerateStarts = state.sessions[0]
      return 'Fix login bug'
    })

    await coordinator.submitFirstInput('session-1', 'please fix the login bug')

    expect(snapshotWhenGenerateStarts).toMatchObject({ title: 'New Claude session', titleState: 'complete' })
  })

  it('ignores a submission after a restart when titleState is already complete, even with a fresh in-memory guard', async () => {
    // Simulates a process restart mid-generation: a fresh SessionCoordinator (fresh in-memory
    // Set) must still refuse a second attempt because the persisted titleState already claimed it.
    const session = runningSession({ kind: 'claude', title: 'New Claude session', titleState: 'complete', status: 'running' })
    const { titleService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })

    await coordinator.submitFirstInput('session-1', 'late input')

    expect(titleService.generate).not.toHaveBeenCalled()
  })

  it('ignores a concurrent duplicate submission before the first resolves', async () => {
    const session = runningSession({ kind: 'claude', status: 'running' })
    const { titleService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    let resolveGenerate!: (title: string) => void
    titleService.generate.mockImplementation(
      () => new Promise<string>((resolve) => {
        resolveGenerate = resolve
      })
    )

    const first = coordinator.submitFirstInput('session-1', 'first input')
    const second = coordinator.submitFirstInput('session-1', 'second input')
    await vi.waitFor(() => expect(titleService.generate).toHaveBeenCalledTimes(1))
    resolveGenerate('Title')
    await Promise.all([first, second])

    expect(titleService.generate).toHaveBeenCalledTimes(1)
  })

  it('keeps the temporary title and marks titleState complete when generation yields nothing usable', async () => {
    const session = runningSession({ kind: 'claude', title: 'New Claude session', status: 'running' })
    const { store, titleService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    titleService.generate.mockResolvedValue('')

    await coordinator.submitFirstInput('session-1', 'input')

    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ title: 'New Claude session', titleState: 'complete' })
  })

  it('keeps the temporary title and marks titleState complete when the title service rejects', async () => {
    const session = runningSession({ kind: 'claude', title: 'New Claude session', status: 'running' })
    const { store, titleService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    titleService.generate.mockRejectedValue(new Error('adapter exploded'))

    await coordinator.submitFirstInput('session-1', 'input')

    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ title: 'New Claude session', titleState: 'complete' })
  })
})

describe('SessionCoordinator.stop and exits', () => {
  it('persists stopped after an explicit stop even when no exit event is published', async () => {
    const session = runningSession({ status: 'running' })
    const { store, terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })

    await coordinator.stop('session-1')

    expect(terminalService.stop).toHaveBeenCalledWith('session-1')
    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ status: 'stopped' })
  })

  it('persists stopped when the terminal reports an unexpected exit', async () => {
    const session = runningSession({ status: 'running' })
    // buildHarness() constructs the coordinator, which subscribes to terminal exit events as a side effect.
    const { store, terminalService } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })

    terminalService.emitExit('session-1', 1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ status: 'stopped' })
  })

  it('logs rather than rejecting unhandled when persisting after an exit event fails', async () => {
    const session = runningSession({ status: 'running' })
    const { store, terminalService } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    const persistFailure = new Error('disk full')
    store.update.mockRejectedValueOnce(persistFailure)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    terminalService.emitExit('session-1', 1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('session-1'), persistFailure)
    consoleError.mockRestore()
  })

  it('persists stopped even when terminalService.stop rejects (force-kill failure), then rethrows', async () => {
    const session = runningSession({ status: 'running' })
    const { store, terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    const killError = new Error('kill failed')
    terminalService.stop.mockRejectedValueOnce(killError)

    await expect(coordinator.stop('session-1')).rejects.toThrow(killError)

    const persisted = await store.load()
    expect(persisted.sessions[0]).toMatchObject({ status: 'stopped' })
  })

  it('allows restoring a session after a failed stop instead of leaving it a permanent zombie', async () => {
    const session = runningSession({ status: 'running' })
    const { terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    terminalService.stop.mockRejectedValueOnce(new Error('kill failed'))
    await expect(coordinator.stop('session-1')).rejects.toThrow('kill failed')

    terminalService.stop.mockResolvedValue(undefined)
    const restored = await coordinator.restore('session-1')

    expect(restored.status).toBe('running')
    expect(terminalService.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1' }), { resume: true })
  })
})

describe('SessionCoordinator.delete', () => {
  it('stops the PTY and cancels the title job before inspecting worktree status', async () => {
    const session = runningSession({ mode: 'worktree', worktreeName: 'w', worktreePath: 'p', branchName: 'w', status: 'running' })
    const { terminalService, titleService, worktreeService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })

    await coordinator.delete('session-1')

    expect(titleService.cancel).toHaveBeenCalledWith('session-1')
    expect(terminalService.stop.mock.invocationCallOrder[0]).toBeLessThan(worktreeService.remove.mock.invocationCallOrder[0]!)
  })

  it('returns dirty and retains metadata when the worktree has changes', async () => {
    const session = runningSession({ mode: 'worktree', worktreeName: 'w', worktreePath: 'p', branchName: 'w', status: 'running' })
    const { store, worktreeService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    worktreeService.remove.mockResolvedValue({ status: 'dirty', changedFiles: 3 })

    const result = await coordinator.delete('session-1')

    expect(result).toEqual({ status: 'dirty', changedFiles: 3 })
    const persisted = await store.load()
    expect(persisted.sessions).toHaveLength(1)
    expect(persisted.sessions[0]!.id).toBe('session-1')
  })

  it('removes the worktree then the metadata on a clean delete', async () => {
    const session = runningSession({ mode: 'worktree', worktreeName: 'w', worktreePath: 'p', branchName: 'w', status: 'running' })
    const { store, worktreeService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    worktreeService.remove.mockResolvedValue({ status: 'removed' })

    const result = await coordinator.delete('session-1')

    expect(result).toEqual({ status: 'deleted' })
    const persisted = await store.load()
    expect(persisted.sessions).toHaveLength(0)
  })

  it('removes metadata when the worktree is already missing', async () => {
    const session = runningSession({ mode: 'worktree', worktreeName: 'w', worktreePath: 'p', branchName: 'w', status: 'running' })
    const { store, worktreeService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    worktreeService.remove.mockResolvedValue({ status: 'missing' })

    const result = await coordinator.delete('session-1')

    expect(result).toEqual({ status: 'deleted' })
    const persisted = await store.load()
    expect(persisted.sessions).toHaveLength(0)
  })

  it('maps unexpected worktree removal errors to failed and retains metadata', async () => {
    const session = runningSession({ mode: 'worktree', worktreeName: 'w', worktreePath: 'p', branchName: 'w', status: 'running' })
    const { store, worktreeService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    worktreeService.remove.mockRejectedValue(new Error('disk full'))

    const result = await coordinator.delete('session-1')

    expect(result).toEqual({ status: 'failed', message: 'disk full' })
    const persisted = await store.load()
    expect(persisted.sessions).toHaveLength(1)
  })

  it('resolves deleted for an already-removed session id', async () => {
    const { coordinator } = buildHarness()

    await expect(coordinator.delete('missing-id')).resolves.toEqual({ status: 'deleted' })
  })

  it('maps a terminal stop failure to failed instead of throwing, and still persists stopped', async () => {
    const session = runningSession({ mode: 'worktree', worktreeName: 'w', worktreePath: 'p', branchName: 'w', status: 'running' })
    const { store, terminalService, titleService, worktreeService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    terminalService.stop.mockRejectedValueOnce(new Error('kill failed'))

    const result = await coordinator.delete('session-1')

    expect(result).toEqual({ status: 'failed', message: 'kill failed' })
    expect(titleService.cancel).toHaveBeenCalledWith('session-1')
    expect(worktreeService.remove).not.toHaveBeenCalled()
    const persisted = await store.load()
    expect(persisted.sessions).toHaveLength(1)
    expect(persisted.sessions[0]).toMatchObject({ status: 'stopped' })
  })
})

describe('SessionCoordinator.shutdown', () => {
  it('cancels title jobs, detaches without killing anything, and leaves running sessions running', async () => {
    const sessions: SessionRecord[] = [
      runningSession({ id: 'a', status: 'running' }),
      runningSession({ id: 'b', status: 'creating' })
    ]
    const terminalService = new FakeDetachableTerminalService()
    const { store, titleService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions },
      terminalService
    })

    await coordinator.shutdown()

    expect(titleService.cancel).toHaveBeenCalledWith('a')
    expect(titleService.cancel).toHaveBeenCalledWith('b')
    expect(terminalService.detach).toHaveBeenCalledOnce()
    // The whole point of the resident host: quitting must not end a single session.
    expect(terminalService.stop).not.toHaveBeenCalled()
    expect(terminalService.stopAll).not.toHaveBeenCalled()
    const persisted = await store.load()
    expect(persisted.sessions.map((s) => s.status)).toEqual(['running', 'stopped'])
  })

  it('falls back to stopAll when the injected terminal owns its PTYs and cannot detach', async () => {
    const sessions: SessionRecord[] = [
      runningSession({ id: 'a', status: 'running' }),
      runningSession({ id: 'b', status: 'creating' })
    ]
    const { store, terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions } })

    await coordinator.shutdown()

    expect(terminalService.stopAll).toHaveBeenCalledOnce()
    // 'running' is still recorded as intent even on the fallback path: those PTYs die with the
    // process, and reconcile() turning that intent into a resume on the next start is exactly
    // the "restore whatever was running" behaviour the product promises.
    const persisted = await store.load()
    expect(persisted.sessions.map((s) => s.status)).toEqual(['running', 'stopped'])
  })
})

describe('SessionCoordinator.reconcile', () => {
  it('keeps a session running when the host still holds its PTY, without relaunching it', async () => {
    const session = runningSession({ status: 'running' })
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })

    const state = await coordinator.reconcile(new Set(['session-1']))

    expect(state.sessions[0]).toMatchObject({ status: 'running' })
    expect(terminalService.start).not.toHaveBeenCalled()
  })

  it('adopts a live session that was persisted as error and drops the stale message', async () => {
    const session = runningSession({ status: 'error', lastError: 'claude not available' })
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })

    const state = await coordinator.reconcile(new Set(['session-1']))

    expect(state.sessions[0]).toMatchObject({ status: 'running' })
    expect(state.sessions[0]).not.toHaveProperty('lastError')
    expect(terminalService.start).not.toHaveBeenCalled()
  })

  it('adopts a live session that was persisted as creating rather than demoting it', async () => {
    const session = runningSession({ status: 'creating' })
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })

    const state = await coordinator.reconcile(new Set(['session-1']))

    expect(state.sessions[0]).toMatchObject({ status: 'running' })
    expect(terminalService.start).not.toHaveBeenCalled()
  })

  it('resumes a running session the host no longer has, using the agent resume flag', async () => {
    const session = runningSession({ kind: 'claude', status: 'running' })
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })

    const state = await coordinator.reconcile(new Set())

    expect(terminalService.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1' }), { resume: true })
    expect(state.sessions[0]).toMatchObject({ status: 'running' })
  })

  it('demotes a creating session the host does not have to stopped instead of resuming it', async () => {
    const session = runningSession({ status: 'creating' })
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })

    const state = await coordinator.reconcile(new Set())

    expect(terminalService.start).not.toHaveBeenCalled()
    expect(state.sessions[0]).toMatchObject({ status: 'stopped' })
  })

  // 'stopped' is what stop() persists, which is how a session the user ended on purpose is
  // told apart from one that was interrupted — no extra field needed.
  it.each(['stopped' as const, 'error' as const, 'missing' as const])(
    'never auto-resumes a session persisted as %s',
    async (status) => {
      const session = runningSession({ status })
      const { store, terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })

      const state = await coordinator.reconcile(new Set())

      expect(terminalService.start).not.toHaveBeenCalled()
      expect(state.sessions[0]).toMatchObject({ status })
      expect(store.update).not.toHaveBeenCalled()
    }
  )

  it('resumes the remaining sessions when one of them fails to start', async () => {
    const sessions = [runningSession({ id: 'a', status: 'running' }), runningSession({ id: 'b', status: 'running' })]
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions } })
    terminalService.start.mockRejectedValueOnce(new Error('claude not available'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const state = await coordinator.reconcile(new Set())

      expect(terminalService.start).toHaveBeenCalledTimes(2)
      expect(state.sessions.map((s) => s.status)).toEqual(['error', 'running'])
      expect(state.sessions[0]).toMatchObject({ lastError: 'claude not available' })
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to resume session a'), expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('marks a resumed session missing when its worktree is gone, without starting a PTY', async () => {
    const session = runningSession({ mode: 'worktree', worktreeName: 'w', worktreePath: 'p', branchName: 'w', status: 'running' })
    const { worktreeService, terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), sessions: [session] }
    })
    worktreeService.validate.mockResolvedValue('missing')

    const state = await coordinator.reconcile(new Set())

    expect(terminalService.start).not.toHaveBeenCalled()
    expect(state.sessions[0]).toMatchObject({ status: 'missing' })
  })

  it('kills a live host session that has no persisted record', async () => {
    const { terminalService, coordinator } = buildHarness()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await coordinator.reconcile(new Set(['orphan']))

      expect(terminalService.stop).toHaveBeenCalledWith('orphan')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('orphan'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('logs and continues when an orphan refuses to die, still reconciling the known sessions', async () => {
    const session = runningSession({ status: 'running' })
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })
    terminalService.stop.mockRejectedValueOnce(new Error('host refused'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const state = await coordinator.reconcile(new Set(['session-1', 'orphan']))

      expect(state.sessions[0]).toMatchObject({ status: 'running' })
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('orphan'), expect.any(Error))
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('marks running sessions stopped without resuming when autoResume is false', async () => {
    const sessions = [runningSession({ id: 'a', status: 'running' }), runningSession({ id: 'b', status: 'creating' })]
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions } })

    const state = await coordinator.reconcile(new Set(), { autoResume: false })

    expect(terminalService.start).not.toHaveBeenCalled()
    expect(state.sessions.map((s) => s.status)).toEqual(['stopped', 'stopped'])
  })

  it('still adopts live sessions when autoResume is false', async () => {
    const session = runningSession({ status: 'running' })
    const { terminalService, coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })

    const state = await coordinator.reconcile(new Set(['session-1']), { autoResume: false })

    expect(terminalService.start).not.toHaveBeenCalled()
    expect(state.sessions[0]).toMatchObject({ status: 'running' })
  })

  it('broadcasts only states it has already persisted', async () => {
    const sessions = [runningSession({ id: 'a', status: 'creating' }), runningSession({ id: 'b', status: 'running' })]
    const { store, coordinator } = buildHarness({ initial: { ...emptyState(), sessions } })
    const seen: AppState[] = []
    coordinator.onStateChanged((state) => seen.push(state))

    const state = await coordinator.reconcile(new Set(['b']))

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toEqual(await store.load())
    expect(state.sessions.map((s) => s.status)).toEqual(['stopped', 'running'])
  })
})

describe('SessionCoordinator.snapshot and onStateChanged', () => {
  it('snapshot returns the current persisted state', async () => {
    const session = runningSession()
    const { coordinator } = buildHarness({ initial: { ...emptyState(), sessions: [session] } })

    await expect(coordinator.snapshot()).resolves.toEqual({ version: 1, projects: [], sessions: [session] })
  })

  it('emits state to subscribers only after validated persistence, and stops after unsubscribe', async () => {
    const { coordinator } = buildHarness()
    const seen: AppState[] = []
    const unsubscribe = coordinator.onStateChanged((state) => seen.push(state))

    await coordinator.create('project-1', 'powershell')
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.at(-1)!.sessions[0]).toMatchObject({ status: 'running' })

    unsubscribe()
    const before = seen.length
    await coordinator.create('project-1', 'cmd')
    expect(seen.length).toBe(before)
  })
})

describe('SessionCoordinator.removeProject', () => {
  const otherProject: ProjectRecord = { ...project, id: 'project-2', name: 'Other', path: 'C:\\Projects\\Other' }

  it('stops running sessions, then drops the project and all of its sessions in one persisted write', async () => {
    const running = runningSession({ id: 'running', status: 'running' })
    const stopped = runningSession({ id: 'stopped', status: 'stopped' })
    const foreign = runningSession({ id: 'foreign', projectId: 'project-2', status: 'running' })
    const { store, terminalService, titleService, coordinator } = buildHarness({
      initial: { ...emptyState(), projects: [project, otherProject], sessions: [running, stopped, foreign] }
    })
    const seen: AppState[] = []
    coordinator.onStateChanged((state) => seen.push(state))

    await coordinator.removeProject('project-1')

    // Only the PTY that is actually alive is stopped; the other project's session is untouched.
    expect(terminalService.stop.mock.calls).toEqual([['running']])
    expect(titleService.cancel.mock.calls.map(([id]) => id).sort()).toEqual(['running', 'stopped'])
    expect(terminalService.stop.mock.invocationCallOrder[0]).toBeLessThan(store.update.mock.invocationCallOrder[0]!)
    expect(store.update).toHaveBeenCalledTimes(1)

    const persisted = await store.load()
    expect(persisted.projects).toEqual([otherProject])
    expect(persisted.recentProjects).toEqual([project])
    expect(persisted.sessions).toEqual([foreign])
    expect(seen).toEqual([persisted])
  })

  it('rejects an unknown project without touching the store or any PTY', async () => {
    const { store, terminalService, coordinator } = buildHarness()

    await expect(coordinator.removeProject('ghost')).rejects.toThrow('Project not found: ghost')
    expect(store.update).not.toHaveBeenCalled()
    expect(terminalService.stop).not.toHaveBeenCalled()
  })

  it('still forgets the project when stopping one of its PTYs fails', async () => {
    const running = runningSession({ id: 'running', status: 'running' })
    const { store, terminalService, coordinator } = buildHarness({
      initial: { ...emptyState(), projects: [project], sessions: [running] }
    })
    terminalService.stop.mockRejectedValueOnce(new Error('force kill timed out'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await expect(coordinator.removeProject('project-1')).resolves.toBeUndefined()
    } finally {
      errorSpy.mockRestore()
    }
    await expect(store.load()).resolves.toEqual({ ...emptyState(), recentProjects: [project] })
  })
})
