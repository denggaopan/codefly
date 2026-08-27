// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppSnapshot, AppState, CapabilityState, DeleteSessionResult, ProjectRecord, SessionRecord } from '../../../shared/contracts'
import { useAppStore } from '../store/use-app-store'
import ProjectSidebar from './ProjectSidebar'

type FakeApi = Window['codefly']

const createFakeApi = (): FakeApi => ({
  getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({ state: { version: 1, projects: [], sessions: [] }, capabilities: defaultCapabilities() })),
  addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
  openProjectInVSCode: vi.fn(async (_projectId: string): Promise<void> => undefined),
  openProjectFolder: vi.fn(async (_projectId: string): Promise<void> => undefined),
  createSession: vi.fn(async () => {
    throw new Error('createSession not stubbed for this test')
  }),
  restoreSession: vi.fn(async (_sessionId: string): Promise<SessionRecord> => {
    throw new Error('restoreSession not stubbed for this test')
  }),
  deleteSession: vi.fn(async (_sessionId: string): Promise<DeleteSessionResult> => ({ status: 'deleted' })),
  submitFirstInput: vi.fn(async () => undefined),
  writeTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  onStateChanged: vi.fn(() => () => undefined),
  onTerminalData: vi.fn(() => () => undefined),
  onTerminalExit: vi.fn(() => () => undefined)
})

const defaultCapabilities = (): CapabilityState => ({
  claude: { available: true, detail: 'C:\\claude\\claude.exe' },
  codex: { available: true, detail: 'C:\\codex\\codex.exe' },
  vscode: { available: true, detail: 'C:\\Code\\Code.exe' }
})

const project1: ProjectRecord = {
  id: 'project-1',
  name: 'demo-project',
  path: 'C:\\work\\demo-project',
  createdAt: '2026-08-20T00:00:00.000Z'
}

const stoppedSession: SessionRecord = {
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

const runningWorktreeSession: SessionRecord = {
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

const seedStore = (state: AppState, capabilities: CapabilityState = defaultCapabilities()): void => {
  useAppStore.setState({ appState: state, capabilities, activeProjectId: null, activeSessionId: null, launcherOpen: false, searchQuery: '', notice: null })
}

let api: FakeApi

beforeEach(() => {
  useAppStore.getState().reset()
  api = createFakeApi()
  window.codefly = api
})

describe('ProjectSidebar', () => {
  it('renders Add Project, search, and the project group', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    expect(screen.getByRole('button', { name: 'Add Project' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search sessions' })).toBeInTheDocument()
    expect(screen.getByText(project1.name)).toBeInTheDocument()
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
  })

  it('calls addProject when Add Project is clicked', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [], sessions: [] })
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: 'Add Project' }))

    expect(api.addProject).toHaveBeenCalledTimes(1)
  })

  it('filters session rows to those matching the search query', async () => {
    const user = userEvent.setup()
    const otherSession: SessionRecord = { ...stoppedSession, id: 'session-other', title: 'Investigate crash' }
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession, otherSession] })
    render(<ProjectSidebar />)

    await user.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'crash')

    expect(screen.getByText(otherSession.title)).toBeInTheDocument()
    expect(screen.queryByText(stoppedSession.title)).not.toBeInTheDocument()
  })

  it('orders project row actions as VS Code, folder, then expand control', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    const row = screen.getByText(project1.name).closest('[data-project-row]') as HTMLElement
    const buttons = within(row).getAllByRole('button')
    const names = buttons.map((button) => button.getAttribute('aria-label'))

    expect(names).toEqual(['Open project in VS Code', 'Open project folder', expect.stringMatching(/sessions/i)])
  })

  it('does not toggle the project row or restore a session when opening VS Code', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: 'Open project in VS Code' }))

    expect(api.openProjectInVSCode).toHaveBeenCalledWith('project-1')
    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeProjectId).toBeNull()
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
  })

  it('does not toggle the project row or restore a session when opening the folder', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: 'Open project folder' }))

    expect(api.openProjectFolder).toHaveBeenCalledWith('project-1')
    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeProjectId).toBeNull()
  })

  it('sets the active project when the project row itself is clicked', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    await user.click(screen.getByText(project1.name))

    expect(useAppStore.getState().activeProjectId).toBe('project-1')
  })

  it('collapses and expands the session list with the expand control', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    const toggle = screen.getByRole('button', { name: /collapse sessions/i })
    await user.click(toggle)
    expect(screen.queryByText(stoppedSession.title)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /expand sessions/i }))
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
  })

  it('shows worktree name for a worktree session and "Ordinary session" for a fallback session', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession, runningWorktreeSession] })
    render(<ProjectSidebar />)

    expect(screen.getByText('Ordinary session')).toBeInTheDocument()
    expect(screen.getByText(runningWorktreeSession.worktreeName as string)).toBeInTheDocument()
  })

  it('shows "Click to restore" for a stopped session and calls restoreSession on click', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    const restarted: SessionRecord = { ...stoppedSession, status: 'running' }
    api.restoreSession = vi.fn(async () => restarted)
    window.codefly = api
    render(<ProjectSidebar />)

    expect(screen.getByText('Click to restore')).toBeInTheDocument()
    await user.click(screen.getByText(stoppedSession.title))

    expect(api.restoreSession).toHaveBeenCalledWith(stoppedSession.id)
  })

  it('shows "Running" for a running session and only switches to it on click', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [runningWorktreeSession] })
    render(<ProjectSidebar />)

    expect(screen.getByText('Running')).toBeInTheDocument()
    await user.click(screen.getByText(runningWorktreeSession.title))

    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeSessionId).toBe(runningWorktreeSession.id)
  })

  it('stops propagation on the session delete button and opens a confirmation', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [runningWorktreeSession] })
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: `Delete ${runningWorktreeSession.title}` }))

    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeSessionId).toBeNull()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('never deletes when the confirmation is canceled', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: `Delete ${stoppedSession.title}` }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(api.deleteSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
  })

  it('shows the dirty-delete message after confirming and keeps the session', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    api.deleteSession = vi.fn(async () => ({ status: 'dirty', changedFiles: 2 }) as DeleteSessionResult)
    window.codefly = api
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: `Delete ${stoppedSession.title}` }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Worktree has 2 changed files. Commit or discard them before deleting.')).toBeInTheDocument()
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
  })

  it('disables the VS Code action when unavailable and exposes the reason as a tooltip', () => {
    seedStore(
      { version: 1, projects: [project1], sessions: [] },
      { claude: { available: true, detail: '' }, codex: { available: true, detail: '' }, vscode: { available: false, detail: 'Install VS Code or the code command.' } }
    )
    render(<ProjectSidebar />)

    const button = screen.getByRole('button', { name: 'Open project in VS Code' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Install VS Code or the code command.')
  })
})
