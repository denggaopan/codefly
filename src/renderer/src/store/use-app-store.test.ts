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
  UpdateInstallResult
} from '../../../shared/contracts'
import { EXTERNAL_LINKS } from '../../../shared/links'
import { AGENT_KINDS, type AgentKind } from '../../../shared/agent-kinds'
import { DEFAULT_SESSION_KIND_PREFERENCES } from '../../../shared/contracts'
import { AGENT_IDLE_MS, SESSION_KINDS_STORAGE_KEY, useAppStore } from './use-app-store'

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
    getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({ platform: 'win32', state: seededState, capabilities: defaultCapabilities() })),
    addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
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
