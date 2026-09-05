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
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateInstallResult,
  WorkspaceState
} from '../../../shared/contracts'
import { EXTERNAL_LINKS } from '../../../shared/links'
import type { TerminalReplay } from '../../../shared/pty-protocol'
import { AGENT_KINDS, type AgentKind } from '../../../shared/agent-kinds'
import { DEFAULT_SESSION_KIND_PREFERENCES } from '../../../shared/contracts'
import { AGENT_IDLE_MS, SESSION_KINDS_STORAGE_KEY, WINDOW_PINNED_STORAGE_KEY, useAppStore } from './use-app-store'

const defaultCapabilities = (): CapabilityState => ({
  ...(Object.fromEntries(AGENT_KINDS.map((kind) => [kind, { available: true, detail: '' }])) as Record<
    AgentKind,
    { available: boolean; detail: string }
  >),
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
  const progressListeners = new Set<(progress: UpdateDownloadProgress) => void>()
  return {
    setTheme: vi.fn(async (): Promise<void> => undefined),
    saveWorkspace: vi.fn(async (_workspace: WorkspaceState): Promise<void> => undefined),
    setWindowPinned: vi.fn(async (pinned: boolean): Promise<boolean> => pinned),
    getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({ platform: 'win32', state: seededState, capabilities: defaultCapabilities() })),
    addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
    reopenProject: vi.fn(async (): Promise<ProjectRecord> => { throw new Error('reopenProject not stubbed') }),
    selectCloneDirectory: vi.fn(async (): Promise<string | null> => null),
    cloneProject: vi.fn(async (): Promise<ProjectRecord> => { throw new Error('cloneProject not stubbed') }),
    openProjectInVSCode: vi.fn(async (): Promise<void> => undefined),
    openProjectFolder: vi.fn(async (): Promise<void> => undefined),
    openProjectRepository: vi.fn(async (): Promise<void> => undefined),
    removeProject: vi.fn(async (): Promise<void> => undefined),
    createSession: vi.fn(async (): Promise<SessionRecord> => claudeSession),
    restoreSession: vi.fn(async (): Promise<SessionRecord> => claudeSession),
    reorderProjects: vi.fn(async (): Promise<ProjectRecord[]> => []),
    deleteSession: vi.fn(async (): Promise<DeleteSessionResult> => ({ status: 'deleted' })),
    submitFirstInput: vi.fn(async (): Promise<void> => undefined),
    getAppInfo: vi.fn(async (): Promise<AppInfo> => ({ version: '0.0.0-test', links: EXTERNAL_LINKS })),
    checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult> => ({ status: 'none', currentVersion: '0.0.0-test' })),
    downloadUpdate: vi.fn(async (): Promise<UpdateDownloadResult> => ({ status: 'cancelled' })),
    cancelUpdateDownload: vi.fn(async (): Promise<void> => undefined),
    installUpdate: vi.fn(async (): Promise<UpdateInstallResult> => ({ status: 'launched' })),
    openExternalLink: vi.fn(async (): Promise<void> => undefined),
    getAutoLaunch: vi.fn(async (): Promise<boolean> => false),
    setAutoLaunch: vi.fn(async (enabled: boolean): Promise<boolean> => enabled),
    writeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    replayTerminal: vi.fn(async (_sessionId: string): Promise<TerminalReplay | undefined> => undefined),
    onStateChanged: vi.fn((_listener: (state: AppState) => void) => () => undefined),
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
    onUpdateProgress: vi.fn((listener: (progress: UpdateDownloadProgress) => void) => {
      progressListeners.add(listener)
      return () => {
        progressListeners.delete(listener)
      }
    }),
    emitUpdateProgress: (progress: UpdateDownloadProgress) => {
      for (const listener of [...progressListeners]) listener(progress)
    },
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

describe('workspace persistence', () => {
  const project: ProjectRecord = {
    id: 'project-1', name: 'Project', path: 'C:\\project', createdAt: '2026-08-20T00:00:00.000Z'
  }
  const secondProject = { ...project, id: 'project-2' }
  const snapshot: AppSnapshot = {
    platform: 'win32', capabilities: defaultCapabilities(),
    state: { ...seededState, projects: [secondProject, project] }
  }
  const stored = () => api.saveWorkspace.mock.calls.at(-1)![0]
  const restart = async () => {
    dispose()
    useAppStore.getState().reset()
    const workspace = stored()
    api.getSnapshot.mockResolvedValue({ ...snapshot, state: { ...snapshot.state, workspace } })
    dispose = useAppStore.getState().initialize()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('saves selection and independent folds before shutdown and restores the active terminal inside a folded project', async () => {
    await restart()
    useAppStore.getState().setActiveSession(powershellSession.id)
    useAppStore.getState().toggleProjectCollapsed(project.id)
    expect(stored()).toEqual({
      activeProjectId: project.id, activeSessionId: powershellSession.id, collapsedProjectIds: [project.id]
    })

    await restart()
    expect(useAppStore.getState()).toMatchObject(stored())
    expect(useAppStore.getState().activeSessionId).toBe(powershellSession.id)
    expect(useAppStore.getState().collapsedProjectIds).toEqual([project.id])
    expect(api.restoreSession).not.toHaveBeenCalled()
    useAppStore.getState().toggleProjectCollapsed(secondProject.id)
    useAppStore.getState().toggleProjectCollapsed(project.id)
    await restart()
    expect(useAppStore.getState().collapsedProjectIds).toEqual([secondProject.id])
  })

  it('persists sessions selected through creation and restoration, and clears a deleted selection', async () => {
    await restart()
    await useAppStore.getState().createSession(project.id, 'claude', false)
    expect(stored().activeSessionId).toBe(claudeSession.id)
    api.restoreSession.mockResolvedValue(powershellSession)
    await useAppStore.getState().restoreSession(powershellSession.id)
    expect(stored().activeSessionId).toBe(powershellSession.id)
    await useAppStore.getState().deleteSession(powershellSession.id)
    expect(stored().activeSessionId).toBeNull()
  })

  it('opens a saved stopped session without restarting its process', async () => {
    dispose()
    useAppStore.getState().reset()
    const workspace = { activeProjectId: project.id, activeSessionId: claudeSession.id, collapsedProjectIds: [project.id] }
    api.getSnapshot.mockResolvedValue({
      ...snapshot, state: { ...snapshot.state, workspace, sessions: [{ ...claudeSession, status: 'stopped' }] }
    })
    dispose = useAppStore.getState().initialize()
    await vi.advanceTimersByTimeAsync(0)
    expect(useAppStore.getState()).toMatchObject(workspace)
    expect(api.restoreSession).not.toHaveBeenCalled()
  })

  it('remembers an empty selection after adding a project and removes forgotten project folds', async () => {
    await restart()
    useAppStore.getState().setActiveSession(claudeSession.id)
    api.addProject.mockResolvedValue(secondProject)
    await useAppStore.getState().addProject()
    expect(stored()).toMatchObject({ activeProjectId: secondProject.id, activeSessionId: null })
    useAppStore.getState().toggleProjectCollapsed(secondProject.id)
    await useAppStore.getState().removeProject(secondProject.id)
    expect(stored().collapsedProjectIds).toEqual([])
  })

  it('ignores deleted records on startup without choosing an unrelated session', async () => {
    await api.saveWorkspace({
      activeProjectId: 'deleted', activeSessionId: 'deleted', collapsedProjectIds: ['deleted', project.id, project.id]
    })
    await restart()
    expect(stored()).toEqual({
      activeProjectId: secondProject.id, activeSessionId: null, collapsedProjectIds: [project.id]
    })
  })

  it('clears references when a state broadcast removes the active project', async () => {
    await restart()
    useAppStore.getState().setActiveSession(claudeSession.id)
    useAppStore.getState().toggleProjectCollapsed(project.id)
    const listener = api.onStateChanged.mock.calls.at(-1)![0] as (state: AppState) => void
    listener({ version: 1, projects: [secondProject], sessions: [] })
    expect(stored()).toEqual({ activeProjectId: secondProject.id, activeSessionId: null, collapsedProjectIds: [] })
  })

  it('does not overwrite preferences while the snapshot is pending or restore a disposed initialization', async () => {
    dispose()
    useAppStore.getState().reset()
    const preferences = { activeProjectId: project.id, activeSessionId: claudeSession.id, collapsedProjectIds: [project.id] }
    await api.saveWorkspace(preferences)
    let resolveSnapshot!: (value: AppSnapshot) => void
    api.getSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveSnapshot = resolve }))
    dispose = useAppStore.getState().initialize()
    expect(stored()).toEqual(preferences)
    dispose()
    useAppStore.getState().reset()
    resolveSnapshot(snapshot)
    await vi.advanceTimersByTimeAsync(0)
    expect(stored()).toEqual(preferences)
    expect(useAppStore.getState().appState.projects).toEqual([])
  })

  it('preserves a user selection made while loading and uses broadcasts newer than the snapshot', async () => {
    dispose()
    useAppStore.getState().reset()
    let resolveSnapshot!: (value: AppSnapshot) => void
    api.getSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveSnapshot = resolve }))
    dispose = useAppStore.getState().initialize()
    const listener = api.onStateChanged.mock.calls.at(-1)![0] as (state: AppState) => void
    listener(snapshot.state)
    useAppStore.getState().setActiveSession(powershellSession.id)
    resolveSnapshot({ ...snapshot, state: { version: 1, projects: [], sessions: [] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(useAppStore.getState().activeSessionId).toBe(powershellSession.id)
    expect(useAppStore.getState().appState).toEqual(snapshot.state)
    expect(stored().activeSessionId).toBe(powershellSession.id)
  })

  it('keeps navigation usable and reports a failed workspace save', async () => {
    await restart()
    api.saveWorkspace.mockRejectedValue(new Error('storage unavailable'))
    useAppStore.getState().setActiveSession(claudeSession.id)
    useAppStore.getState().toggleProjectCollapsed(project.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(useAppStore.getState().activeSessionId).toBe(claudeSession.id)
    expect(useAppStore.getState().collapsedProjectIds).toEqual([project.id])
    expect(useAppStore.getState().notice).toEqual({ message: 'storage unavailable', tone: 'error' })
  })
})

// The launcher reads availability by kind with no fallback, and it can be opened before the
// first snapshot arrives — a kind missing from the resting state would crash it.
describe('useAppStore resting capabilities', () => {
  it('carries a placeholder entry for every agent kind before the snapshot arrives', () => {
    useAppStore.getState().reset()

    const { capabilities } = useAppStore.getState()

    for (const kind of AGENT_KINDS) {
      expect(capabilities[kind]).toEqual({ available: false, detail: 'Checking availability…' })
    }
  })
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

describe('useAppStore.openProjectRepository', () => {
  it('names only the project over IPC and surfaces a rejection as a notice', async () => {
    await useAppStore.getState().openProjectRepository('project-1')
    expect(api.openProjectRepository).toHaveBeenCalledWith('project-1')
    expect(useAppStore.getState().notice).toBeNull()

    api.openProjectRepository.mockRejectedValue(new Error('Could not open https://github.com/me/app in the default browser: boom'))
    await useAppStore.getState().openProjectRepository('project-1')
    expect(useAppStore.getState().notice).toEqual({
      message: 'Could not open https://github.com/me/app in the default browser: boom',
      tone: 'error'
    })
  })
})

describe('useAppStore.removeProject', () => {
  const projectAt = (id: string): ProjectRecord => ({ id, name: id, path: `C:\\${id}`, createdAt: '2026-08-20T00:00:00.000Z' })

  beforeEach(() => {
    useAppStore.setState((state) => ({
      appState: { ...state.appState, projects: [projectAt('project-1'), projectAt('project-2')] },
      activeProjectId: 'project-1',
      activeSessionId: claudeSession.id,
      launcherOpen: true
    }))
  })

  it('forgets the project over IPC and moves the selection off its vanished records', async () => {
    await useAppStore.getState().removeProject('project-1')

    expect(api.removeProject).toHaveBeenCalledWith('project-1')
    const state = useAppStore.getState()
    expect(state.appState.projects.map((project) => project.id)).toEqual(['project-2'])
    expect(state.appState.sessions).toEqual([])
    expect(state.activeProjectId).toBe('project-2')
    expect(state.activeSessionId).toBeNull()
    expect(state.launcherOpen).toBe(false)
    expect(state.notice).toBeNull()
  })

  it('leaves the selection alone when a different project is removed', async () => {
    await useAppStore.getState().removeProject('project-2')

    const state = useAppStore.getState()
    expect(state.appState.projects.map((project) => project.id)).toEqual(['project-1'])
    expect(state.appState.sessions).toHaveLength(2)
    expect(state.activeProjectId).toBe('project-1')
    expect(state.activeSessionId).toBe(claudeSession.id)
    expect(state.launcherOpen).toBe(true)
  })

  it('keeps everything and surfaces a notice when the main process rejects', async () => {
    api.removeProject.mockRejectedValue(new Error('Project not found: project-1'))

    await useAppStore.getState().removeProject('project-1')

    const state = useAppStore.getState()
    expect(state.appState.projects).toHaveLength(2)
    expect(state.appState.sessions).toHaveLength(2)
    expect(state.activeProjectId).toBe('project-1')
    expect(state.notice).toEqual({ message: 'Project not found: project-1', tone: 'error' })
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

  it('merges stored values over macOS defaults after the snapshot identifies the platform', async () => {
    dispose()
    window.localStorage.setItem(SESSION_KINDS_STORAGE_KEY, JSON.stringify({ shell: { worktree: true }, claude: { worktree: false } }))
    useAppStore.getState().reset()
    api.getSnapshot.mockResolvedValueOnce({ platform: 'darwin', state: seededState, capabilities: defaultCapabilities() })

    dispose = useAppStore.getState().initialize()
    await vi.advanceTimersByTimeAsync(0)

    expect(useAppStore.getState().platform).toBe('darwin')
    expect(document.documentElement.dataset.platform).toBe('darwin')
    expect(useAppStore.getState().sessionKindPreferences).toEqual({
      shell: { enabled: true, worktree: true },
      powershell: { enabled: false, worktree: false },
      cmd: { enabled: false, worktree: false },
      claude: { enabled: true, worktree: false },
      codex: { enabled: true, worktree: true },
      gemini: { enabled: false, worktree: true },
      copilot: { enabled: false, worktree: true },
      cursor: { enabled: false, worktree: true },
      comate: { enabled: false, worktree: true },
      qwen: { enabled: false, worktree: true }
    })
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

describe('useAppStore updater', () => {
  const availableResult = {
    status: 'available',
    currentVersion: '0.0.0-test',
    latestVersion: '2.0.0',
    releaseUrl: 'https://example.test/release',
    asset: { fileName: 'CodeFly-Setup-2.0.0-win-x64.exe', size: 1024 }
  } as const

  // Re-runs initialize() against a check result of the test's choosing; the file-level
  // beforeEach has already run one startup check (answered "none").
  const restartWithCheckResult = async (result: UpdateCheckResult): Promise<void> => {
    dispose()
    useAppStore.getState().reset()
    api.checkForUpdates.mockResolvedValueOnce(result)
    dispose = useAppStore.getState().initialize()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('checks for updates once on startup', () => {
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1)
    // The seeded fake answers "none", which must leave nothing on screen.
    expect(useAppStore.getState().updater).toEqual({ phase: 'idle' })
  })

  it('raises the dialog only when a newer version actually exists', async () => {
    await restartWithCheckResult(availableResult)

    expect(useAppStore.getState().updater).toEqual({ phase: 'available', version: '2.0.0', downloadable: true })
  })

  it('marks a release with no installer as not downloadable', async () => {
    const { asset: _asset, ...withoutAsset } = availableResult
    await restartWithCheckResult(withoutAsset)

    expect(useAppStore.getState().updater).toEqual({ phase: 'available', version: '2.0.0', downloadable: false })
  })

  it('stays silent when the background check fails', async () => {
    dispose()
    useAppStore.getState().reset()
    api.checkForUpdates.mockRejectedValueOnce(new Error('Network request failed.'))
    dispose = useAppStore.getState().initialize()
    await vi.advanceTimersByTimeAsync(0)

    expect(useAppStore.getState().updater).toEqual({ phase: 'idle' })
    expect(useAppStore.getState().notice).toBeNull()
  })

  it('runs the download and lands on ready', async () => {
    useAppStore.getState().beginUpdate('2.0.0', true)
    api.downloadUpdate.mockResolvedValueOnce({ status: 'ready', version: '2.0.0', fileName: 'Setup.exe' })

    await useAppStore.getState().startUpdateDownload()

    expect(useAppStore.getState().updater).toEqual({ phase: 'ready', version: '2.0.0' })
  })

  it('returns to idle when the download is cancelled', async () => {
    useAppStore.getState().beginUpdate('2.0.0', true)
    api.downloadUpdate.mockResolvedValueOnce({ status: 'cancelled' })

    await useAppStore.getState().startUpdateDownload()

    expect(useAppStore.getState().updater).toEqual({ phase: 'idle' })
  })

  it('keeps the version alongside a download failure so retry knows what to fetch', async () => {
    useAppStore.getState().beginUpdate('2.0.0', true)
    api.downloadUpdate.mockResolvedValueOnce({ status: 'error', message: 'GitHub returned HTTP 500.' })

    await useAppStore.getState().startUpdateDownload()

    expect(useAppStore.getState().updater).toEqual({ phase: 'error', version: '2.0.0', message: 'GitHub returned HTTP 500.' })
  })

  it('folds a rejected invoke into the same error phase', async () => {
    useAppStore.getState().beginUpdate('2.0.0', true)
    api.downloadUpdate.mockRejectedValueOnce(new Error('Unauthorized IPC sender.'))

    await useAppStore.getState().startUpdateDownload()

    expect(useAppStore.getState().updater).toEqual({ phase: 'error', version: '2.0.0', message: 'Unauthorized IPC sender.' })
  })

  it('ignores a second download request while one is already running', async () => {
    useAppStore.getState().beginUpdate('2.0.0', true)
    const first = useAppStore.getState().startUpdateDownload()
    await useAppStore.getState().startUpdateDownload()
    await first

    expect(api.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('merges progress only while that version is downloading', () => {
    useAppStore.setState({ updater: { phase: 'downloading', version: '2.0.0', receivedBytes: 0, totalBytes: 0 } })

    api.emitUpdateProgress({ version: '2.0.0', receivedBytes: 512, totalBytes: 4096 })
    expect(useAppStore.getState().updater).toEqual({ phase: 'downloading', version: '2.0.0', receivedBytes: 512, totalBytes: 4096 })

    // A late event from an abandoned download must not resurrect the progress bar.
    useAppStore.getState().dismissUpdate()
    api.emitUpdateProgress({ version: '2.0.0', receivedBytes: 1024, totalBytes: 4096 })
    expect(useAppStore.getState().updater).toEqual({ phase: 'idle' })
  })

  it('holds the installing phase while the app quits, and reports a failure to launch', async () => {
    useAppStore.setState({ updater: { phase: 'ready', version: '2.0.0' } })
    await useAppStore.getState().installUpdate()
    // The app is on its way out; staying here avoids a flash of another state during teardown.
    expect(useAppStore.getState().updater).toEqual({ phase: 'installing', version: '2.0.0' })

    useAppStore.setState({ updater: { phase: 'ready', version: '2.0.0' } })
    api.installUpdate.mockResolvedValueOnce({ status: 'error', message: 'The downloaded installer is missing.' })
    await useAppStore.getState().installUpdate()
    expect(useAppStore.getState().updater).toEqual({
      phase: 'error',
      version: '2.0.0',
      message: 'The downloaded installer is missing.'
    })
  })

  it('refuses a second install once one is already handed to the OS', async () => {
    useAppStore.setState({ updater: { phase: 'ready', version: '2.0.0' } })

    // Quitting is not instant, so the user has a real window in which to click twice.
    await useAppStore.getState().installUpdate()
    await useAppStore.getState().installUpdate()

    expect(api.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('adopts the version a progress event reports rather than dropping the frame', () => {
    useAppStore.setState({ updater: { phase: 'downloading', version: '2.0.0', receivedBytes: 0, totalBytes: 0 } })

    // The main process re-resolves the release when the download starts, so a release
    // published between the check and the click legitimately reports a newer version.
    api.emitUpdateProgress({ version: '2.1.0', receivedBytes: 64, totalBytes: 512 })

    expect(useAppStore.getState().updater).toEqual({ phase: 'downloading', version: '2.1.0', receivedBytes: 64, totalBytes: 512 })
  })

  it('asks the main process to cancel without pre-empting the download result', async () => {
    useAppStore.setState({ updater: { phase: 'downloading', version: '2.0.0', receivedBytes: 10, totalBytes: 100 } })

    await useAppStore.getState().cancelUpdateDownload()

    expect(api.cancelUpdateDownload).toHaveBeenCalledTimes(1)
    // Still downloading as far as this store knows: startUpdateDownload's own result decides.
    expect(useAppStore.getState().updater.phase).toBe('downloading')
  })

  it('reset returns the updater to idle', () => {
    useAppStore.setState({ updater: { phase: 'ready', version: '2.0.0' } })

    useAppStore.getState().reset()

    expect(useAppStore.getState().updater).toEqual({ phase: 'idle' })
  })
})
// Pinning is renderer-owned like the theme: the store keeps the preference, the main process
// owns the window flag, and the button renders whatever the window actually took.
describe('useAppStore window pinning', () => {
  it('starts unpinned and replays that default at startup so the window converges', () => {
    expect(useAppStore.getState().windowPinned).toBe(false)
    expect(api.setWindowPinned).toHaveBeenCalledWith(false)
  })

  it('pins the window, persists the preference, and unpins again', async () => {
    useAppStore.getState().setWindowPinned(true)

    expect(useAppStore.getState().windowPinned).toBe(true)
    expect(api.setWindowPinned).toHaveBeenLastCalledWith(true)
    expect(window.localStorage.getItem(WINDOW_PINNED_STORAGE_KEY)).toBe('true')
    await vi.advanceTimersByTimeAsync(0)
    expect(useAppStore.getState().windowPinned).toBe(true)

    useAppStore.getState().setWindowPinned(false)
    await vi.advanceTimersByTimeAsync(0)

    expect(api.setWindowPinned).toHaveBeenLastCalledWith(false)
    expect(window.localStorage.getItem(WINDOW_PINNED_STORAGE_KEY)).toBe('false')
    expect(useAppStore.getState().windowPinned).toBe(false)
  })

  it('replays a stored pin at startup', async () => {
    dispose()
    useAppStore.getState().reset()
    window.localStorage.setItem(WINDOW_PINNED_STORAGE_KEY, 'true')
    api = createFakeApi()
    window.codefly = api

    dispose = useAppStore.getState().initialize()
    await vi.advanceTimersByTimeAsync(0)

    expect(api.setWindowPinned).toHaveBeenCalledWith(true)
    expect(useAppStore.getState().windowPinned).toBe(true)
  })

  it('shows the flag the window actually took when the request is refused', async () => {
    api.setWindowPinned.mockResolvedValueOnce(false)

    useAppStore.getState().setWindowPinned(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(useAppStore.getState().windowPinned).toBe(false)
  })

  it('lets a newer click win over a late refusal', async () => {
    api.setWindowPinned.mockResolvedValueOnce(false)

    useAppStore.getState().setWindowPinned(true)
    // Toggled off again before the refusal lands: the stale reply must not pin it back.
    useAppStore.getState().setWindowPinned(false)
    await vi.advanceTimersByTimeAsync(0)

    expect(useAppStore.getState().windowPinned).toBe(false)
  })

  it('keeps the preference when the main process is unreachable', async () => {
    api.setWindowPinned.mockRejectedValueOnce(new Error('window gone'))

    useAppStore.getState().setWindowPinned(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(useAppStore.getState().windowPinned).toBe(true)
  })
})
