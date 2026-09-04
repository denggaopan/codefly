// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_KINDS, type AgentKind } from '../../shared/agent-kinds'
import type {
  AppInfo,
  AppSnapshot,
  AppState,
  CapabilityState,
  DeleteSessionResult,
  HostPlatform,
  ProjectRecord,
  SessionKind,
  SessionRecord,
  ToolAvailability,
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateInstallResult
} from '../../shared/contracts'
import { EXTERNAL_LINKS } from '../../shared/links'
import App from './App'
import { SESSION_KINDS_STORAGE_KEY, useAppStore } from './store/use-app-store'

// App renders TerminalWorkspace, which embeds real @xterm/xterm and @xterm/addon-fit
// instances. Both rely on browser APIs (canvas, matchMedia, ResizeObserver) that jsdom does
// not provide, so — same as TerminalWorkspace's own tests — they are replaced here with
// inert stubs; these tests exercise navigation/session flows, not terminal rendering.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    open = vi.fn()
    write = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    loadAddon = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    dispose = vi.fn()
    proposeDimensions = vi.fn(() => undefined)
  }
}))
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }
)

// Deliberately NOT annotated with a `CodeFlyApi`-shaped return type: that would widen every
// vi.fn() property down to a plain function type and lose access to mock helpers like
// mockResolvedValueOnce in the tests below. Structural compatibility with window.codefly
// (CodeFlyApi) is still checked at each `window.codefly = api` assignment site.
const createFakeApi = (state: AppState, capabilities: CapabilityState, platform: HostPlatform = 'win32') => {
  const stateListeners = new Set<(state: AppState) => void>()
  return {
    getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({ platform, state, capabilities })),
    addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
    reorderProjects: vi.fn(async (): Promise<ProjectRecord[]> => []),
    openProjectInVSCode: vi.fn(async (_projectId: string): Promise<void> => undefined),
    openProjectFolder: vi.fn(async (_projectId: string): Promise<void> => undefined),
    openProjectRepository: vi.fn(async (_projectId: string): Promise<void> => undefined),
    removeProject: vi.fn(async (_projectId: string): Promise<void> => undefined),
    createSession: vi.fn(async (_projectId: string, _kind: SessionKind): Promise<SessionRecord> => {
      throw new Error('createSession not stubbed for this test')
    }),
    restoreSession: vi.fn(async (_sessionId: string): Promise<SessionRecord> => {
      throw new Error('restoreSession not stubbed for this test')
    }),
    deleteSession: vi.fn(async (_sessionId: string): Promise<DeleteSessionResult> => ({ status: 'deleted' })),
    submitFirstInput: vi.fn(async (): Promise<void> => undefined),
    setTheme: vi.fn(async (): Promise<void> => undefined),
    setWindowPinned: vi.fn(async (pinned: boolean): Promise<boolean> => pinned),
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
    onStateChanged: vi.fn((listener: (state: AppState) => void) => {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    }),
    onTerminalData: vi.fn(() => () => undefined),
    onTerminalExit: vi.fn(() => () => undefined),
    onUpdateProgress: vi.fn(() => () => undefined),
    emitState: (nextState: AppState) => {
      for (const listener of [...stateListeners]) listener(nextState)
    }
  }
}

type FakeApi = ReturnType<typeof createFakeApi>

const project1: ProjectRecord = {
  id: 'project-1',
  name: 'demo-project',
  path: 'C:\\work\\demo-project',
  createdAt: '2026-08-20T00:00:00.000Z'
}

const stoppedPowerShellSession: SessionRecord = {
  id: 'session-ps',
  projectId: 'project-1',
  kind: 'powershell',
  title: 'New PowerShell session',
  titleState: 'pending',
  createdAt: '2026-08-20T00:01:00.000Z',
  mode: 'ordinary',
  launchPath: 'C:\\work\\demo-project',
  status: 'stopped'
}

const runningPowerShellSession: SessionRecord = { ...stoppedPowerShellSession, id: 'session-ps-running', status: 'running' }

const runningClaudeSession: SessionRecord = {
  id: 'session-claude',
  projectId: 'project-1',
  kind: 'claude',
  title: 'Fix login bug',
  titleState: 'complete',
  createdAt: '2026-08-20T00:02:00.000Z',
  mode: 'worktree',
  worktreeName: 'worktree-260820-1',
  worktreePath: 'C:\\work\\demo-project\\.worktrees\\worktree-260820-1',
  branchName: 'worktree-260820-1',
  launchPath: 'C:\\work\\demo-project\\.worktrees\\worktree-260820-1',
  status: 'running'
}

const stoppedClaudeSession: SessionRecord = { ...runningClaudeSession, id: 'session-claude-stopped', status: 'stopped' }

// Every agent kind is probed at startup, so a snapshot always carries one entry per kind.
// Built from the registry so adding a CLI does not mean hand-editing each fixture.
const agentCapabilities = (
  overrides: Partial<Record<AgentKind, ToolAvailability>> = {}
): Record<AgentKind, ToolAvailability> =>
  Object.fromEntries(
    AGENT_KINDS.map((kind) => [kind, overrides[kind] ?? { available: true, detail: `C:\\${kind}\\${kind}.exe` }])
  ) as Record<AgentKind, ToolAvailability>

const allAvailableCapabilities: CapabilityState = {
  ...agentCapabilities(),
  vscode: { available: true, detail: 'C:\\Code\\Code.exe' }
}

const claudeDisabledCapabilities: CapabilityState = {
  ...agentCapabilities({ claude: { available: false, detail: 'Claude CLI not found. Install claude and sign in.' } }),
  vscode: { available: true, detail: 'C:\\Code\\Code.exe' }
}

const cursorDisabledCapabilities: CapabilityState = {
  ...agentCapabilities({ cursor: { available: false, detail: 'Install the Cursor CLI (agent) and sign in.' } }),
  vscode: { available: true, detail: 'C:\\Code\\Code.exe' }
}

const stateWith = (...sessions: SessionRecord[]): AppState => ({ version: 1, projects: [project1], sessions })

let api: FakeApi

const projectOptionsName = (projectName: string): string => `Project options for ${projectName}`

const openProjectOptions = async (
  user: ReturnType<typeof userEvent.setup>,
  projectName = project1.name
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole('button', { name: projectOptionsName(projectName) }))
  return screen.getByRole('menu', { name: projectOptionsName(projectName) })
}

const openNewSessionLauncher = async (
  user: ReturnType<typeof userEvent.setup>,
  projectName = project1.name
): Promise<HTMLElement> => {
  const menu = await openProjectOptions(user, projectName)
  await user.click(within(menu).getByRole('menuitem', { name: 'New session' }))
  return screen.getByLabelText('Create session')
}

beforeEach(() => {
  useAppStore.getState().reset()
  // Theme persistence and the html[data-theme] stamp outlive an unmount; clear both so a
  // theme toggled in one test never leaks into the next.
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
  api = createFakeApi(stateWith(), allAvailableCapabilities)
  window.codefly = api
})

describe('App', () => {
  it('shows a dismissible warning when startup recovered a corrupt state file', async () => {
    const recoveryWarning = 'CodeFly recovered state from backup. The corrupt state was preserved.'
    api.getSnapshot.mockResolvedValueOnce({
      platform: 'win32',
      state: stateWith(),
      capabilities: allAvailableCapabilities,
      recoveryWarning
    } as AppSnapshot & { recoveryWarning: string })

    render(<App />)

    expect(await screen.findByText(recoveryWarning)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss notice' })).toBeInTheDocument()
  })

  it('loads the snapshot on mount and renders the project and its sessions', async () => {
    api = createFakeApi(stateWith(stoppedPowerShellSession, runningClaudeSession), allAvailableCapabilities)
    window.codefly = api

    render(<App />)

    expect(await screen.findByText(project1.name)).toBeInTheDocument()
    expect(await screen.findByText(stoppedPowerShellSession.title, { selector: 'span.session-title' })).toBeInTheDocument()
    // Assert the sidebar row specifically via its span.session-title selector.
    expect(await screen.findByText(runningClaudeSession.title, { selector: 'span.session-title' })).toBeInTheDocument()
  })

  it('reconciles state pushed through onStateChanged after the initial snapshot', async () => {
    render(<App />)

    await screen.findByText(project1.name)
    expect(api.onStateChanged).toHaveBeenCalledTimes(1)

    api.emitState(stateWith(stoppedPowerShellSession))

    expect(await screen.findByText(stoppedPowerShellSession.title, { selector: 'span.session-title' })).toBeInTheDocument()
  })

  it('adds a project and shows it in the sidebar', async () => {
    const user = userEvent.setup()
    const newProject: ProjectRecord = { ...project1, id: 'project-2', name: 'other-project', path: 'C:\\work\\other-project' }
    api.addProject.mockResolvedValueOnce(newProject)
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Add Project' }))

    expect(api.addProject).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('other-project')).toBeInTheDocument()
  })

  it('filters session rows by the search query', async () => {
    const user = userEvent.setup()
    const otherSession: SessionRecord = { ...stoppedPowerShellSession, id: 'session-other', title: 'Investigate crash' }
    api = createFakeApi(stateWith(stoppedPowerShellSession, otherSession), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await screen.findByText(stoppedPowerShellSession.title)
    await user.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'crash')

    expect(screen.getByText(otherSession.title)).toBeInTheDocument()
    expect(screen.queryByText(stoppedPowerShellSession.title)).not.toBeInTheDocument()
  })

  it.each<[SessionKind, string]>([
    ['powershell', 'PowerShell'],
    ['cmd', 'Command Prompt'],
    ['claude', 'Claude'],
    ['codex', 'Codex']
  ])('creates a %s session from the launcher and selects it', async (kind, label) => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(), allAvailableCapabilities)
    const created: SessionRecord = {
      id: `session-${kind}`,
      projectId: 'project-1',
      kind,
      title: `New session (${kind})`,
      titleState: 'pending',
      createdAt: '2026-08-20T00:03:00.000Z',
      mode: 'ordinary',
      launchPath: 'C:\\work\\demo-project',
      status: 'running'
    }
    api.createSession.mockResolvedValueOnce(created)
    window.codefly = api
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)
    await user.click(await screen.findByRole('button', { name: label }))

    expect(api.createSession).toHaveBeenCalledWith('project-1', kind, false)
    expect(await screen.findByText(created.title, { selector: 'span.session-title' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
  })

  it('offers a "(new worktree)" entry only for the kinds whose Settings switch is on', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)

    // Defaults: the shells only run in the project directory, the agents offer both.
    expect(screen.queryByRole('button', { name: 'PowerShell (new worktree)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Command Prompt (new worktree)' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Claude (new worktree)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Codex (new worktree)' })).toBeInTheDocument()

    act(() => {
      useAppStore.getState().setSessionKindPreference('powershell', { worktree: true })
      useAppStore.getState().setSessionKindPreference('codex', { worktree: false })
    })

    expect(screen.getByRole('button', { name: 'PowerShell (new worktree)' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Codex (new worktree)' })).not.toBeInTheDocument()
    // The plain entry is never removed: every kind can always launch in the project directory.
    expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument()
  })

  it('drops a session kind from the launcher entirely once it is turned off in Settings', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)

    act(() => {
      useAppStore.getState().setSessionKindPreference('cmd', { enabled: false })
    })

    expect(screen.queryByRole('button', { name: 'Command Prompt' })).not.toBeInTheDocument()
    // A disabled kind is gone; the ones left over are untouched.
    expect(screen.getByRole('button', { name: 'PowerShell' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Claude (new worktree)' })).toBeInTheDocument()

    act(() => {
      for (const kind of ['powershell', 'claude', 'codex'] as const) {
        useAppStore.getState().setSessionKindPreference(kind, { enabled: false })
      }
    })

    expect(screen.getByText('Every session kind is turned off in Settings.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'PowerShell' })).not.toBeInTheDocument()
  })

  it('requests a worktree only when the "(new worktree)" entry is the one activated', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(), allAvailableCapabilities)
    api.createSession.mockResolvedValue({
      id: 'session-claude-worktree',
      projectId: 'project-1',
      kind: 'claude',
      title: 'New Claude session',
      titleState: 'pending',
      createdAt: '2026-08-20T00:04:00.000Z',
      mode: 'worktree',
      launchPath: 'C:\work\demo-project\.worktrees\worktree-260820-1',
      worktreeName: 'worktree-260820-1',
      worktreePath: 'C:\work\demo-project\.worktrees\worktree-260820-1',
      branchName: 'worktree-260820-1',
      status: 'running'
    })
    window.codefly = api
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)
    await user.click(screen.getByRole('button', { name: 'Claude (new worktree)' }))

    expect(api.createSession).toHaveBeenCalledWith('project-1', 'claude', true)
    expect(await screen.findByText('worktree-260820-1', { selector: 'span.session-secondary' })).toBeInTheDocument()
  })

  it('returns focus to the project options trigger after closing the launcher with its close button', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText(project1.name)
    const trigger = await screen.findByRole('button', { name: projectOptionsName(project1.name) })
    await openNewSessionLauncher(user)
    await screen.findByRole('button', { name: 'PowerShell' })

    await user.click(screen.getByRole('button', { name: 'Close launcher' }))

    expect(screen.queryByRole('button', { name: 'PowerShell' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('returns focus to the project options trigger after closing the launcher with Escape', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText(project1.name)
    const trigger = await screen.findByRole('button', { name: projectOptionsName(project1.name) })
    await openNewSessionLauncher(user)
    await screen.findByRole('button', { name: 'PowerShell' })

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('button', { name: 'PowerShell' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('creates a session by activating a launcher item with the keyboard and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const created: SessionRecord = {
      id: 'session-kbd',
      projectId: 'project-1',
      kind: 'powershell',
      title: 'New session (powershell)',
      titleState: 'pending',
      createdAt: '2026-08-20T00:03:00.000Z',
      mode: 'ordinary',
      launchPath: 'C:\\work\\demo-project',
      status: 'running'
    }
    api.createSession.mockResolvedValueOnce(created)
    render(<App />)

    await screen.findByText(project1.name)
    const trigger = await screen.findByRole('button', { name: projectOptionsName(project1.name) })
    await openNewSessionLauncher(user)

    const powershellButton = await screen.findByRole('button', { name: 'PowerShell' })
    expect(powershellButton).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(api.createSession).toHaveBeenCalledWith('project-1', 'powershell', false)
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('advertises no accelerator beside PowerShell in the launcher', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)

    const powershellButton = await screen.findByRole('button', { name: 'PowerShell' })
    const container = powershellButton.closest('[data-launcher-item]') ?? powershellButton.parentElement!
    expect(container).not.toHaveTextContent('Ctrl+T')
  })

  it('shows only Shell and agents on macOS, creates Shell, and advertises Cmd+T', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(), allAvailableCapabilities, 'darwin')
    const created: SessionRecord = {
      ...stoppedPowerShellSession,
      id: 'session-shell',
      kind: 'shell',
      title: 'New Shell session',
      launchPath: '/Users/test/demo-project',
      status: 'running'
    }
    api.createSession.mockResolvedValueOnce(created)
    window.codefly = api
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)

    expect(screen.queryByRole('button', { name: 'PowerShell' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Command Prompt' })).not.toBeInTheDocument()
    const shellButton = screen.getByRole('button', { name: 'Shell' })
    expect(shellButton.closest('[data-launcher-item]')).toHaveTextContent('Cmd+T')
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument()

    await user.click(shellButton)
    expect(api.createSession).toHaveBeenCalledWith('project-1', 'shell', false)
  })

  it('creates the ordinary Shell session from Cmd+T on macOS', async () => {
    api = createFakeApi(stateWith(), allAvailableCapabilities, 'darwin')
    api.createSession.mockResolvedValueOnce({
      ...stoppedPowerShellSession,
      id: 'session-shortcut-shell',
      kind: 'shell',
      title: 'New Shell session',
      status: 'running'
    })
    window.codefly = api
    render(<App />)
    await screen.findByText(project1.name)

    fireEvent.keyDown(document, { key: 't', code: 'KeyT', metaKey: true })

    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith('project-1', 'shell', false))
  })

  it('leaves Ctrl+T alone on Windows so the focused terminal keeps it', async () => {
    api = createFakeApi(stateWith(), allAvailableCapabilities, 'win32')
    window.codefly = api
    render(<App />)
    await screen.findByText(project1.name)

    fireEvent.keyDown(document, { key: 't', code: 'KeyT', ctrlKey: true })

    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('disables Claude and Codex when unavailable and shows the capability detail as visible help text', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(), claudeDisabledCapabilities)
    window.codefly = api
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)

    const claudeButton = await screen.findByRole('button', { name: 'Claude' })
    expect(claudeButton).toBeDisabled()
    expect(await screen.findByText('Claude CLI not found. Install claude and sign in.')).toBeVisible()

    await user.click(claudeButton)
    expect(api.createSession).not.toHaveBeenCalled()
  })

  // An opt-in agent behaves exactly like Claude once its switch is on: present, and disabled
  // with the lookup detail when its CLI is missing.
  it('lists an opt-in agent once enabled and disables it while its CLI is missing', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(SESSION_KINDS_STORAGE_KEY, JSON.stringify({ cursor: { enabled: true } }))
    api = createFakeApi(stateWith(), cursorDisabledCapabilities)
    window.codefly = api
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)

    const cursorButton = await screen.findByRole('button', { name: /^Cursor$/ })
    expect(cursorButton).toBeDisabled()
    expect(await screen.findByText('Install the Cursor CLI (agent) and sign in.')).toBeVisible()

    await user.click(cursorButton)
    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('switches to a running session by clicking its row without restoring it', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(runningClaudeSession), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByText(runningClaudeSession.title, { selector: 'span.session-title' }))

    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('Permissions and sandbox bypass enabled')
  })

  it('restores a stopped session by clicking its row', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(stoppedPowerShellSession), allAvailableCapabilities)
    const restarted: SessionRecord = { ...stoppedPowerShellSession, status: 'running' }
    api.restoreSession.mockResolvedValueOnce(restarted)
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByText(stoppedPowerShellSession.title, { selector: 'span.session-title' }))

    expect(api.restoreSession).toHaveBeenCalledWith(stoppedPowerShellSession.id)
  })

  it('opens a confirmation before deleting and never restores the session', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(stoppedPowerShellSession), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByRole('button', { name: `Delete ${stoppedPowerShellSession.title}` }))

    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(api.deleteSession).not.toHaveBeenCalled()
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(api.deleteSession).toHaveBeenCalledWith(stoppedPowerShellSession.id)
  })

  it('shows the dirty-delete message and keeps the session after a dirty delete result', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(stoppedPowerShellSession), allAvailableCapabilities)
    api.deleteSession.mockResolvedValueOnce({ status: 'dirty', changedFiles: 3 })
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByRole('button', { name: `Delete ${stoppedPowerShellSession.title}` }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Worktree has 3 changed files. Commit or discard them before deleting.')).toBeInTheDocument()
    expect(screen.getByText(stoppedPowerShellSession.title)).toBeInTheDocument()
  })

  it('removes the session row after a clean delete result', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(stoppedPowerShellSession), allAvailableCapabilities)
    api.deleteSession.mockResolvedValueOnce({ status: 'deleted' })
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByRole('button', { name: `Delete ${stoppedPowerShellSession.title}` }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByText(stoppedPowerShellSession.title)).not.toBeInTheDocument())
  })

  it('opens VS Code without toggling the project or restoring a session', async () => {
    const user = userEvent.setup()
    render(<App />)

    const menu = await openProjectOptions(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Open project in VS Code' }))

    expect(api.openProjectInVSCode).toHaveBeenCalledWith('project-1')
    expect(api.restoreSession).not.toHaveBeenCalled()
  })

  it('opens Explorer without toggling the project or restoring a session', async () => {
    const user = userEvent.setup()
    render(<App />)

    const menu = await openProjectOptions(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Open project folder' }))

    expect(api.openProjectFolder).toHaveBeenCalledWith('project-1')
    expect(api.restoreSession).not.toHaveBeenCalled()
  })

  it('shows the bypass warning only for an active running Codex session', async () => {
    const user = userEvent.setup()
    const runningCodex: SessionRecord = { ...runningClaudeSession, id: 'session-codex', kind: 'codex', title: 'Codex refactor' }
    api = createFakeApi(stateWith(runningCodex), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    await user.click(await screen.findByText(runningCodex.title, { selector: 'span.session-title' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Permissions and sandbox bypass enabled')
  })

  it('hides the bypass warning for an active running PowerShell session', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(runningPowerShellSession), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByText(runningPowerShellSession.title, { selector: 'span.session-title' }))

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('hides the bypass warning for an active running Command Prompt session', async () => {
    const user = userEvent.setup()
    const runningCmd: SessionRecord = { ...runningPowerShellSession, id: 'session-cmd-running', kind: 'cmd', title: 'New Command Prompt session' }
    api = createFakeApi(stateWith(runningCmd), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByText(runningCmd.title, { selector: 'span.session-title' }))

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('hides the bypass warning for a stopped Claude session', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(stoppedClaudeSession), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByText(stoppedClaudeSession.title, { selector: 'span.session-title' }))

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('renders the bypass warning as a compact header badge without a bottom strip', async () => {
    const user = userEvent.setup()
    api = createFakeApi(stateWith(runningClaudeSession), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await user.click(await screen.findByText(runningClaudeSession.title, { selector: 'span.session-title' }))

    expect(await screen.findByRole('status')).toHaveClass('terminal-header-bypass')
    expect(document.querySelector('.agent-bypass-status')).toBeNull()
  })

  it('renders the title bar with a settings control and no session tabs', async () => {
    api = createFakeApi(stateWith(runningClaudeSession), allAvailableCapabilities)
    window.codefly = api
    render(<App />)

    await screen.findByText(runningClaudeSession.title, { selector: 'span.session-title' })
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(document.querySelector('.title-bar')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('opens Settings from the title bar and switches between light and dark themes', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(dialog).toBeInTheDocument()
    expect(dialog.closest('.title-bar')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem('codefly.theme')).toBe('light')
    expect(api.setTheme).toHaveBeenCalledWith('light')
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(api.setTheme).toHaveBeenLastCalledWith('dark')

    await user.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('closes Settings from the backdrop and Escape', async () => {
    const user = userEvent.setup()
    render(<App />)

    const trigger = screen.getByRole('button', { name: 'Settings' })
    await user.click(trigger)

    const backdrop = document.querySelector('.settings-dialog-backdrop')
    expect(backdrop).not.toBeNull()
    await user.click(backdrop!)
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()

    await user.click(trigger)
    await screen.findByRole('dialog', { name: 'Settings' })
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('pins and unpins the window from the title bar, persisting the choice', async () => {
    const user = userEvent.setup()
    render(<App />)

    const pin = await screen.findByRole('button', { name: 'Keep window on top' })
    expect(pin).toHaveAttribute('aria-pressed', 'false')

    await user.click(pin)

    expect(api.setWindowPinned).toHaveBeenLastCalledWith(true)
    expect(window.localStorage.getItem('codefly.windowPinned')).toBe('true')
    const pinned = screen.getByRole('button', { name: 'Stop keeping window on top' })
    expect(pinned).toHaveAttribute('aria-pressed', 'true')

    await user.click(pinned)

    expect(api.setWindowPinned).toHaveBeenLastCalledWith(false)
    expect(window.localStorage.getItem('codefly.windowPinned')).toBe('false')
    expect(screen.getByRole('button', { name: 'Keep window on top' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('replays a persisted pin on startup', async () => {
    window.localStorage.setItem('codefly.windowPinned', 'true')

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Stop keeping window on top' })).toHaveAttribute('aria-pressed', 'true')
    expect(api.setWindowPinned).toHaveBeenCalledWith(true)
  })

  it('applies the persisted light theme (DOM, storage, and main process) on startup', async () => {
    window.localStorage.setItem('codefly.theme', 'light')

    render(<App />)

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    expect(api.setTheme).toHaveBeenCalledWith('light')
  })

  describe('sidebar resize handle', () => {
    const appBody = (): HTMLElement => document.querySelector<HTMLElement>('.app-body')!
    const handle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize sidebar' })

    it('renders the default width as the layout token and exposes it as a vertical splitter', () => {
      render(<App />)

      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('300px')
      expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
      expect(handle()).toHaveAttribute('aria-valuenow', '300')
      expect(handle()).toHaveAttribute('aria-valuemin', '200')
    })

    it('follows a pointer drag live, persists the result and ends the drag on pointer up', () => {
      render(<App />)
      const separator = handle()

      fireEvent.pointerDown(separator, { pointerId: 7, button: 0, clientX: 300 })
      expect(document.body.dataset.sidebarResizing).toBe('true')
      expect(separator).toHaveAttribute('data-resizing', 'true')

      fireEvent.pointerMove(separator, { pointerId: 7, clientX: 340 })
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('340px')
      expect(separator).toHaveAttribute('aria-valuenow', '340')

      fireEvent.pointerMove(separator, { pointerId: 7, clientX: 260 })
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('260px')

      fireEvent.pointerUp(separator, { pointerId: 7 })
      expect(document.body.dataset.sidebarResizing).toBeUndefined()
      expect(separator).not.toHaveAttribute('data-resizing')
      expect(window.localStorage.getItem('codefly.sidebarWidth')).toBe('260')

      // Moves after the drag ended are ignored: a stray pointermove must not resize anything.
      fireEvent.pointerMove(separator, { pointerId: 7, clientX: 500 })
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('260px')
    })

    it('clamps a drag to the sidebar minimum and to the viewport-derived maximum', () => {
      render(<App />)
      const separator = handle()
      // jsdom reports a 1024px viewport: 1024 - 360 (workspace minimum) = 664 > 640, so the
      // absolute maximum applies.
      expect(separator).toHaveAttribute('aria-valuemax', '640')

      fireEvent.pointerDown(separator, { pointerId: 1, button: 0, clientX: 300 })
      fireEvent.pointerMove(separator, { pointerId: 1, clientX: -1000 })
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('200px')

      fireEvent.pointerMove(separator, { pointerId: 1, clientX: 5000 })
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('640px')
      fireEvent.pointerUp(separator, { pointerId: 1 })
    })

    it('ignores secondary-button presses and pointers other than the one that started the drag', () => {
      render(<App />)
      const separator = handle()

      fireEvent.pointerDown(separator, { pointerId: 2, button: 2, clientX: 300 })
      fireEvent.pointerMove(separator, { pointerId: 2, clientX: 400 })
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('300px')
      expect(document.body.dataset.sidebarResizing).toBeUndefined()

      fireEvent.pointerDown(separator, { pointerId: 3, button: 0, clientX: 300 })
      fireEvent.pointerMove(separator, { pointerId: 4, clientX: 400 })
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('300px')
      fireEvent.pointerUp(separator, { pointerId: 3 })
    })

    it('nudges with the arrow keys, jumps with Home/End and resets on double-click', async () => {
      const user = userEvent.setup()
      render(<App />)
      const separator = handle()

      separator.focus()
      await user.keyboard('{ArrowRight}{ArrowRight}')
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('332px')
      await user.keyboard('{ArrowLeft}')
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('316px')
      await user.keyboard('{Home}')
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('200px')
      await user.keyboard('{End}')
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('640px')
      expect(window.localStorage.getItem('codefly.sidebarWidth')).toBe('640')

      await user.dblClick(separator)
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('300px')
      expect(window.localStorage.getItem('codefly.sidebarWidth')).toBe('300')
    })

    it('restores the persisted width on startup and falls back to the default for garbage', () => {
      window.localStorage.setItem('codefly.sidebarWidth', '420')
      const first = render(<App />)
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('420px')
      first.unmount()
      useAppStore.getState().reset()

      window.localStorage.setItem('codefly.sidebarWidth', 'wide')
      render(<App />)
      expect(appBody().style.getPropertyValue('--sidebar-width')).toBe('300px')
    })
  })

  it('creates a session in the project whose options menu New session action was clicked', async () => {
    const user = userEvent.setup()
    const project2: ProjectRecord = {
      id: 'project-2',
      name: 'second-project',
      path: 'C:\\work\\second-project',
      createdAt: '2026-08-21T00:00:00.000Z'
    }
    api = createFakeApi({ version: 1, projects: [project1, project2], sessions: [] }, allAvailableCapabilities)
    const created: SessionRecord = {
      id: 'session-p2',
      projectId: 'project-2',
      kind: 'powershell',
      title: 'New PowerShell session',
      titleState: 'pending',
      createdAt: '2026-08-21T00:01:00.000Z',
      mode: 'ordinary',
      launchPath: 'C:\\work\\second-project',
      status: 'running'
    }
    api.createSession.mockResolvedValueOnce(created)
    window.codefly = api
    render(<App />)

    await screen.findByText(project2.name)
    await openNewSessionLauncher(user, project2.name)
    await user.click(await screen.findByRole('button', { name: 'PowerShell' }))

    expect(api.createSession).toHaveBeenCalledWith('project-2', 'powershell', false)
  })
})
