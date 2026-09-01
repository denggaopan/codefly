// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AppInfo,
  AppSnapshot,
  AppState,
  CapabilityState,
  DeleteSessionResult,
  ProjectRecord,
  SessionRecord,
  UpdateCheckResult
} from '../../../shared/contracts'
import { EXTERNAL_LINKS } from '../../../shared/links'
import { DEFAULT_SESSION_KIND_PREFERENCES } from '../../../shared/contracts'
import { AGENT_IDLE_MS, SESSION_KINDS_STORAGE_KEY, useAppStore } from './use-app-store'

const defaultCapabilities = (): CapabilityState => ({
  claude: { available: true, detail: '' },
  codex: { available: true, detail: '' },
  vscode: { available: true, detail: '' }
})

const claudeSession: SessionRecord = {
  id: 'session-claude',
  projectId: 'project-1',
  kind: 'claude',
  title: 'Fix login bug',
  titleState: 'complete',
  createdAt: '2026-08-20T00:02:00.000Z',
  mode: 'ordinary',
  launchPath: 'C:\\work\\demo-project',
  status: 'running'
}

const powershellSession: SessionRecord = {
  id: 'session-ps',
  projectId: 'project-1',
  kind: 'powershell',
  title: 'New PowerShell session',
  titleState: 'pending',
  createdAt: '2026-08-20T00:01:00.000Z',
  mode: 'ordinary',
  launchPath: 'C:\\work\\demo-project',
  status: 'running'
}

const seededState: AppState = { version: 1, projects: [], sessions: [claudeSession, powershellSession] }

const createFakeApi = () => {
  const dataListeners = new Set<(payload: { sessionId: string; data: string }) => void>()
  const exitListeners = new Set<(payload: { sessionId: string; exitCode: number }) => void>()
  return {
    setTheme: vi.fn(async (): Promise<void> => undefined),
    getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({ state: seededState, capabilities: defaultCapabilities() })),
    addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
    openProjectInVSCode: vi.fn(async (): Promise<void> => undefined),
    openProjectFolder: vi.fn(async (): Promise<void> => undefined),
    createSession: vi.fn(async (): Promise<SessionRecord> => claudeSession),
    restoreSession: vi.fn(async (): Promise<SessionRecord> => claudeSession),
    reorderProjects: vi.fn(async (): Promise<ProjectRecord[]> => []),
    deleteSession: vi.fn(async (): Promise<DeleteSessionResult> => ({ status: 'deleted' })),
    submitFirstInput: vi.fn(async (): Promise<void> => undefined),
    getAppInfo: vi.fn(async (): Promise<AppInfo> => ({ version: '0.0.0-test', links: EXTERNAL_LINKS })),
    checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult> => ({ status: 'none', currentVersion: '0.0.0-test' })),
    openExternalLink: vi.fn(async (): Promise<void> => undefined),
    getAutoLaunch: vi.fn(async (): Promise<boolean> => false),
    setAutoLaunch: vi.fn(async (enabled: boolean): Promise<boolean> => enabled),
    writeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
    onTerminalData: vi.fn((listener: (payload: { sessionId: string; data: string }) => void) => {
      dataListeners.add(listener)
      return () => {
        dataListeners.delete(listener)
      }
    }),
    onTerminalExit: vi.fn((listener: (payload: { sessionId: string; exitCode: number }) => void) => {
      exitListeners.add(listener)
      return () => {
        exitListeners.delete(listener)
      }
    }),
    emitTerminalData: (payload: { sessionId: string; data: string }) => {
      for (const listener of [...dataListeners]) listener(payload)
    },
    emitTerminalExit: (payload: { sessionId: string; exitCode: number }) => {
      for (const listener of [...exitListeners]) listener(payload)
    }
  }
}

type FakeApi = ReturnType<typeof createFakeApi>

let api: FakeApi
let dispose: () => void

const idleIds = (): Record<string, true> => useAppStore.getState().idleAgentSessionIds

beforeEach(async () => {
  vi.useFakeTimers()
  window.localStorage.clear()
  useAppStore.getState().reset()
  api = createFakeApi()
  window.codefly = api
  dispose = useAppStore.getState().initialize()
  // getSnapshot resolves on the microtask queue; flush it so appState holds the sessions.
  await vi.advanceTimersByTimeAsync(0)
  expect(useAppStore.getState().appState.sessions).toHaveLength(2)
})

afterEach(() => {
  dispose()
  vi.useRealTimers()
})

describe('useAppStore.reorderProjects', () => {
  const projectAt = (id: string): ProjectRecord => ({ id, name: id, path: `C:\\${id}`, createdAt: '2026-08-20T00:00:00.000Z' })

  it('sends the order over IPC and applies the returned authoritative project list', async () => {
    const reordered = [projectAt('p2'), projectAt('p1')]
    api.reorderProjects.mockResolvedValue(reordered)

    await useAppStore.getState().reorderProjects(['p2', 'p1'])

    expect(api.reorderProjects).toHaveBeenCalledWith(['p2', 'p1'])
    expect(useAppStore.getState().appState.projects).toEqual(reordered)
  })

  it('surfaces a notice and keeps the current order when the reorder rejects', async () => {
    const before = useAppStore.getState().appState.projects
    api.reorderProjects.mockRejectedValue(new Error('Project not found: ghost'))

    await useAppStore.getState().reorderProjects(['ghost'])

    expect(useAppStore.getState().appState.projects).toEqual(before)
    expect(useAppStore.getState().notice).toEqual({ message: 'Project not found: ghost', tone: 'error' })
  })
})

describe('useAppStore.createSession', () => {
  it('forwards the per-creation worktree choice to the main process verbatim', async () => {
    await useAppStore.getState().createSession('project-1', 'claude', true)
    expect(api.createSession).toHaveBeenLastCalledWith('project-1', 'claude', true)

    await useAppStore.getState().createSession('project-1', 'claude', false)
    expect(api.createSession).toHaveBeenLastCalledWith('project-1', 'claude', false)
  })
})

describe('useAppStore session-kind preferences', () => {
  const reinitializeWith = async (stored: string): Promise<void> => {
    dispose()
    window.localStorage.setItem(SESSION_KINDS_STORAGE_KEY, stored)
    useAppStore.getState().reset()
    dispose = useAppStore.getState().initialize()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('starts from the documented defaults when nothing is stored', () => {
    expect(useAppStore.getState().sessionKindPreferences).toEqual(DEFAULT_SESSION_KIND_PREFERENCES)
  })

  it('patches one field of one kind and persists the whole record', () => {
    useAppStore.getState().setSessionKindPreference('cmd', { worktree: true })
    useAppStore.getState().setSessionKindPreference('powershell', { enabled: false })

    const expected = {
      ...DEFAULT_SESSION_KIND_PREFERENCES,
      powershell: { enabled: false, worktree: false },
      cmd: { enabled: true, worktree: true }
    }
    expect(useAppStore.getState().sessionKindPreferences).toEqual(expected)
    expect(JSON.parse(window.localStorage.getItem(SESSION_KINDS_STORAGE_KEY)!)).toEqual(expected)
  })

  it('merges a partial stored value over the defaults field by field on initialize', async () => {
    await reinitializeWith(JSON.stringify({ claude: { worktree: false }, cmd: { enabled: false } }))

    expect(useAppStore.getState().sessionKindPreferences).toEqual({
      ...DEFAULT_SESSION_KIND_PREFERENCES,
      cmd: { enabled: false, worktree: false },
      claude: { enabled: true, worktree: false }
    })
  })

  it('falls back to the defaults when the stored value is unreadable', async () => {
    await reinitializeWith('not json')

    expect(useAppStore.getState().sessionKindPreferences).toEqual(DEFAULT_SESSION_KIND_PREFERENCES)
  })
})

describe('useAppStore agent idle tracking', () => {
  it('marks an agent session Done only after its output has been quiet for the idle window', async () => {
    api.emitTerminalData({ sessionId: claudeSession.id, data: 'thinking…' })
    expect(idleIds()).toEqual({})

    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS - 1)
    expect(idleIds()).toEqual({})

    await vi.advanceTimersByTimeAsync(1)
    expect(idleIds()).toEqual({ [claudeSession.id]: true })
  })

  it('clears the Done mark the moment new output arrives, then re-marks after quiet', async () => {
    api.emitTerminalData({ sessionId: claudeSession.id, data: 'first' })
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS)
    expect(idleIds()).toEqual({ [claudeSession.id]: true })

    api.emitTerminalData({ sessionId: claudeSession.id, data: 'more output' })
    expect(idleIds()).toEqual({})

    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS)
    expect(idleIds()).toEqual({ [claudeSession.id]: true })
  })

  it('never tracks shell sessions', async () => {
    api.emitTerminalData({ sessionId: powershellSession.id, data: 'PS>' })
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS * 2)
    expect(idleIds()).toEqual({})
  })

  it('ignores output for sessions not present in appState', async () => {
    api.emitTerminalData({ sessionId: 'unknown-session', data: 'x' })
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS * 2)
    expect(idleIds()).toEqual({})
  })

  it('clears tracking when the session process exits', async () => {
    api.emitTerminalData({ sessionId: claudeSession.id, data: 'output' })
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS)
    expect(idleIds()).toEqual({ [claudeSession.id]: true })

    api.emitTerminalExit({ sessionId: claudeSession.id, exitCode: 0 })
    expect(idleIds()).toEqual({})
  })

  it('cancels a pending idle timer when the session exits before the window elapses', async () => {
    api.emitTerminalData({ sessionId: claudeSession.id, data: 'output' })
    api.emitTerminalExit({ sessionId: claudeSession.id, exitCode: 0 })

    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS * 2)
    expect(idleIds()).toEqual({})
  })

  it('stops tracking and clears pending timers on dispose', async () => {
    api.emitTerminalData({ sessionId: claudeSession.id, data: 'output' })
    dispose()

    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS * 2)
    expect(idleIds()).toEqual({})
  })

  it('reset clears the idle map and pending timers', async () => {
    api.emitTerminalData({ sessionId: claudeSession.id, data: 'output' })
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS)
    expect(idleIds()).toEqual({ [claudeSession.id]: true })

    useAppStore.getState().reset()
    expect(idleIds()).toEqual({})
  })
})
