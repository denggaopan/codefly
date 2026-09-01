// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppSnapshot, AppState, CapabilityState, DeleteSessionResult, ProjectRecord, SessionKind, SessionRecord } from '../../shared/contracts'
import App from './App'
import { useAppStore } from './store/use-app-store'

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
const createFakeApi = (state: AppState, capabilities: CapabilityState) => {
  const stateListeners = new Set<(state: AppState) => void>()
  return {
    getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({ state, capabilities })),
    addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
    reorderProjects: vi.fn(async (): Promise<ProjectRecord[]> => []),
    openProjectInVSCode: vi.fn(async (_projectId: string): Promise<void> => undefined),
    openProjectFolder: vi.fn(async (_projectId: string): Promise<void> => undefined),
    createSession: vi.fn(async (_projectId: string, _kind: SessionKind): Promise<SessionRecord> => {
      throw new Error('createSession not stubbed for this test')
    }),
    restoreSession: vi.fn(async (_sessionId: string): Promise<SessionRecord> => {
      throw new Error('restoreSession not stubbed for this test')
    }),
    deleteSession: vi.fn(async (_sessionId: string): Promise<DeleteSessionResult> => ({ status: 'deleted' })),
    submitFirstInput: vi.fn(async (): Promise<void> => undefined),
    setTheme: vi.fn(async (): Promise<void> => undefined),
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

const allAvailableCapabilities: CapabilityState = {
  claude: { available: true, detail: 'C:\\claude\\claude.exe' },
  codex: { available: true, detail: 'C:\\codex\\codex.exe' },
  vscode: { available: true, detail: 'C:\\Code\\Code.exe' }
}

const claudeDisabledCapabilities: CapabilityState = {
  claude: { available: false, detail: 'Claude CLI not found. Install claude and sign in.' },
  codex: { available: true, detail: 'C:\\codex\\codex.exe' },
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

    expect(api.createSession).toHaveBeenCalledWith('project-1', kind)
    expect(await screen.findByText(created.title, { selector: 'span.session-title' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
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

    expect(api.createSession).toHaveBeenCalledWith('project-1', 'powershell')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('shows Ctrl+T beside PowerShell in the launcher', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText(project1.name)
    await openNewSessionLauncher(user)

    const powershellButton = await screen.findByRole('button', { name: 'PowerShell' })
    const container = powershellButton.closest('[data-launcher-item]') ?? powershellButton.parentElement!
    expect(container).toHaveTextContent('Ctrl+T')
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

  it('applies the persisted light theme (DOM, storage, and main process) on startup', async () => {
    window.localStorage.setItem('codefly.theme', 'light')

    render(<App />)

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    expect(api.setTheme).toHaveBeenCalledWith('light')
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

    expect(api.createSession).toHaveBeenCalledWith('project-2', 'powershell')
  })
})
