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

  it('renders Add Project as a round icon button docked in the sidebar footer, not in the header', () => {
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const addButton = screen.getByRole('button', { name: 'Add Project' })
    expect(addButton).toHaveClass('add-project-fab')
    expect(addButton.closest('.project-sidebar-footer')).not.toBeNull()
    expect(addButton.closest('.project-sidebar-header')).toBeNull()
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

  it('orders project row actions as New session, VS Code, then folder', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    const row = screen.getByText(project1.name).closest('[data-project-row]') as HTMLElement
    const actions = row.querySelector('[data-project-actions]') as HTMLElement
    const buttons = within(actions).getAllByRole('button')
    const names = buttons.map((button) => button.getAttribute('aria-label'))

    expect(names).toEqual(['New session', 'Open project in VS Code', 'Open project folder'])
  })

  it('does not put the project-row label or session-row label inside a role="button" ancestor', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    const projectLabel = screen.getByText(project1.name).closest('button') as HTMLElement
    expect(projectLabel.closest('[role="button"]')).toBeNull()

    const sessionLabel = screen.getByText(stoppedSession.title).closest('button') as HTMLElement
    expect(sessionLabel.closest('[role="button"]')).toBeNull()
  })

  it('activates the project row label with the keyboard (native button, no role="button")', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const label = screen.getByText(project1.name).closest('button') as HTMLButtonElement
    label.focus()
    await user.keyboard('{Enter}')

    expect(useAppStore.getState().activeProjectId).toBe('project-1')
  })

  it('restores a stopped session when its row label is activated with the keyboard', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    const restarted: SessionRecord = { ...stoppedSession, status: 'running' }
    api.restoreSession = vi.fn(async () => restarted)
    window.codefly = api
    render(<ProjectSidebar />)

    const label = screen.getByText(stoppedSession.title).closest('button') as HTMLButtonElement
    label.focus()
    await user.keyboard('{Enter}')

    expect(api.restoreSession).toHaveBeenCalledWith(stoppedSession.id)
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

  it('expands the clicked project and collapses the others (accordion), with no expand control', async () => {
    const user = userEvent.setup()
    const project2: ProjectRecord = { id: 'project-2', name: 'second-project', path: 'C:\\work\\second', createdAt: '2026-08-21T00:00:00.000Z' }
    const sessionInP2: SessionRecord = { ...stoppedSession, id: 'session-p2', projectId: 'project-2', title: 'P2 session' }
    seedStore({ version: 1, projects: [project1, project2], sessions: [stoppedSession, sessionInP2] })
    render(<ProjectSidebar />)

    // No active project yet: every group is expanded, and there is no expand/collapse control.
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
    expect(screen.getByText('P2 session')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /collapse sessions|expand sessions/i })).not.toBeInTheDocument()

    await user.click(screen.getByText(project2.name))
    expect(screen.queryByText(stoppedSession.title)).not.toBeInTheDocument()
    expect(screen.getByText('P2 session')).toBeInTheDocument()

    await user.click(screen.getByText(project1.name))
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
    expect(screen.queryByText('P2 session')).not.toBeInTheDocument()
  })

  it('shows matching sessions in every project while searching, regardless of the active project', async () => {
    const project2: ProjectRecord = { id: 'project-2', name: 'second-project', path: 'C:\\work\\second', createdAt: '2026-08-21T00:00:00.000Z' }
    const sessionInP2: SessionRecord = { ...stoppedSession, id: 'session-p2', projectId: 'project-2', title: 'Special P2 session' }
    seedStore({ version: 1, projects: [project1, project2], sessions: [stoppedSession, sessionInP2] })
    useAppStore.setState({ activeProjectId: project1.id, searchQuery: 'special' })
    render(<ProjectSidebar />)

    expect(screen.getByText('Special P2 session')).toBeInTheDocument()
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

  it('focuses Cancel by default when the delete confirmation opens', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: `Delete ${stoppedSession.title}` }))

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('cancels the delete confirmation on Escape without deleting', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: `Delete ${stoppedSession.title}` }))
    await user.keyboard('{Escape}')

    expect(api.deleteSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
  })

  it('does not delete a session when Enter is pressed immediately after the confirmation opens', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    await user.click(screen.getByRole('button', { name: `Delete ${stoppedSession.title}` }))
    await user.keyboard('{Enter}')

    expect(api.deleteSession).not.toHaveBeenCalled()
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

  it('also shows the disabled VS Code reason as visible text, not only a hover tooltip', () => {
    seedStore(
      { version: 1, projects: [project1], sessions: [] },
      { claude: { available: true, detail: '' }, codex: { available: true, detail: '' }, vscode: { available: false, detail: 'Install VS Code or the code command.' } }
    )
    render(<ProjectSidebar />)

    const button = screen.getByRole('button', { name: 'Open project in VS Code' })
    const hint = screen.getByText('Install VS Code or the code command.')
    expect(hint).toBeVisible()
    // The visible hint is programmatically associated with the button too, so screen
    // reader users who tab to it (never having "hovered") still get the explanation.
    expect(button).toHaveAttribute('aria-describedby', hint.id)
  })

  it('does not render a visible VS Code hint when the capability is available', () => {
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    expect(screen.queryByText(/install vs code/i)).not.toBeInTheDocument()
  })

  it('renders the bundled VS Code SVG asset (not the old inline placeholder) inside the action button', () => {
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const button = screen.getByRole('button', { name: 'Open project in VS Code' })
    const icon = button.querySelector('img.icon-vscode') as HTMLImageElement | null
    expect(icon).not.toBeNull()
    expect(icon).toHaveAttribute('src')
    // Decorative: the button's own aria-label is the accessible name, not the image.
    expect(icon).toHaveAttribute('alt', '')
  })

  it('gives the session secondary label (worktree name / "Ordinary session") a title attribute for ellipsized text', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession, runningWorktreeSession] })
    render(<ProjectSidebar />)

    expect(screen.getByText('Ordinary session')).toHaveAttribute('title', 'Ordinary session')
    expect(screen.getByText(runningWorktreeSession.worktreeName as string)).toHaveAttribute('title', runningWorktreeSession.worktreeName)
  })

  it('exposes an accessible name for every icon-only button in a project row', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    const row = screen.getByText(project1.name).closest('[data-project-row]') as HTMLElement
    const actions = row.querySelector('[data-project-actions]') as HTMLElement
    for (const button of within(actions).getAllByRole('button')) {
      const accessibleName = button.getAttribute('aria-label')
      expect(accessibleName).toBeTruthy()
    }

    const deleteButton = screen.getByRole('button', { name: `Delete ${stoppedSession.title}` })
    expect(deleteButton.getAttribute('aria-label')).toBeTruthy()
  })

  it('returns focus to the Delete button that opened the confirmation after Cancel', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    const deleteButton = screen.getByRole('button', { name: `Delete ${stoppedSession.title}` })
    await user.click(deleteButton)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(deleteButton).toHaveFocus()
  })

  it('returns focus to the Delete button that opened the confirmation after Escape', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    const deleteButton = screen.getByRole('button', { name: `Delete ${stoppedSession.title}` })
    await user.click(deleteButton)
    await user.keyboard('{Escape}')

    expect(deleteButton).toHaveFocus()
  })

  it('returns focus to the Delete button after a dirty-delete result leaves the session in place', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    api.deleteSession = vi.fn(async () => ({ status: 'dirty', changedFiles: 1 }) as DeleteSessionResult)
    window.codefly = api
    render(<ProjectSidebar />)

    const deleteButton = screen.getByRole('button', { name: `Delete ${stoppedSession.title}` })
    await user.click(deleteButton)
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await screen.findByText('Worktree has 1 changed files. Commit or discard them before deleting.')
    expect(deleteButton).toHaveFocus()
  })
})
