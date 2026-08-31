// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppSnapshot, AppState, CapabilityState, DeleteSessionResult, ProjectRecord, SessionRecord } from '../../../shared/contracts'
import { AGENT_IDLE_MS, useAppStore } from './use-app-store'

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
    getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({ state: seededState, capabilities: defaultCapabilities() })),
    addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
    openProjectInVSCode: vi.fn(async (): Promise<void> => undefined),
    openProjectFolder: vi.fn(async (): Promise<void> => undefined),
    createSession: vi.fn(async (): Promise<SessionRecord> => claudeSession),
    restoreSession: vi.fn(async (): Promise<SessionRecord> => claudeSession),
    reorderProjects: vi.fn(async (): Promise<ProjectRecord[]> => []),
    deleteSession: vi.fn(async (): Promise<DeleteSessionResult> => ({ status: 'deleted' })),
    submitFirstInput: vi.fn(async (): Promise<void> => undefined),
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
