// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_KINDS, type AgentKind } from '../../../shared/agent-kinds'
import type {
  AppInfo,
  AppSnapshot,
  AppState,
  CapabilityState,
  DeleteSessionResult,
  ProjectRecord,
  SessionRecord,
  ToolAvailability,
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateInstallResult
} from '../../../shared/contracts'
import { EXTERNAL_LINKS } from '../../../shared/links'
import closeIconUrl from '../assets/close.svg'
import gitIconUrl from '../assets/git.svg'
import githubIconUrl from '../assets/github.svg'
import gitlabIconUrl from '../assets/gitlab.svg'
import optionsIconUrl from '../assets/options.svg'
import removeIconUrl from '../assets/remove.svg'
import { useAppStore } from '../store/use-app-store'
import ProjectSidebar from './ProjectSidebar'

type FakeApi = Window['codefly']

const createFakeApi = (): FakeApi => ({
  getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({
    platform: 'win32',
    state: { version: 1, projects: [], sessions: [] },
    capabilities: defaultCapabilities()
  })),
  addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
  reorderProjects: vi.fn(async (): Promise<ProjectRecord[]> => []),
  openProjectInVSCode: vi.fn(async (_projectId: string): Promise<void> => undefined),
  openProjectFolder: vi.fn(async (_projectId: string): Promise<void> => undefined),
  openProjectRepository: vi.fn(async (_projectId: string): Promise<void> => undefined),
  removeProject: vi.fn(async (_projectId: string): Promise<void> => undefined),
  createSession: vi.fn(async () => {
    throw new Error('createSession not stubbed for this test')
  }),
  restoreSession: vi.fn(async (_sessionId: string): Promise<SessionRecord> => {
    throw new Error('restoreSession not stubbed for this test')
  }),
  deleteSession: vi.fn(async (_sessionId: string): Promise<DeleteSessionResult> => ({ status: 'deleted' })),
  submitFirstInput: vi.fn(async () => undefined),
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
  onStateChanged: vi.fn(() => () => undefined),
  onTerminalData: vi.fn(() => () => undefined),
  onTerminalExit: vi.fn(() => () => undefined),
  onUpdateProgress: vi.fn(() => () => undefined)
})

// A real snapshot carries one entry per agent kind; built from the registry so adding a CLI
// does not mean hand-editing every fixture in this file.
const agentCapabilities = (detail = ''): Record<AgentKind, ToolAvailability> =>
  Object.fromEntries(AGENT_KINDS.map((kind) => [kind, { available: true, detail }])) as Record<AgentKind, ToolAvailability>

const defaultCapabilities = (): CapabilityState => ({
  ...agentCapabilities('C:\\agents\\cli.exe'),
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

afterEach(() => {
  vi.restoreAllMocks()
})

const projectOptionsName = (projectName: string): string => `Project options for ${projectName}`

const openProjectOptions = async (
  user: ReturnType<typeof userEvent.setup>,
  projectName = project1.name
): Promise<HTMLElement> => {
  await user.click(screen.getByRole('button', { name: projectOptionsName(projectName) }))
  return screen.getByRole('menu', { name: projectOptionsName(projectName) })
}

const geometry = (top: number, bottom: number, left = 0, right = 300): DOMRect =>
  ({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    top,
    right,
    bottom,
    left,
    toJSON: () => ({})
  }) as DOMRect

const controlProjectOptionsGeometry = (state: {
  rowTop: number
  rowBottom: number
  triggerTop?: number
  triggerBottom?: number
  scrollportTop: number
  scrollportBottom: number
  menuHeight: number
  menuRectHeight?: number
  clampedMenuRectHeight?: number
  menuBorderTop?: number
  menuBorderBottom?: number
}): void => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('project-groups')) return geometry(state.scrollportTop, state.scrollportBottom)
    if (this.hasAttribute('data-project-row')) return geometry(state.rowTop, state.rowBottom)
    if (this.classList.contains('project-options-trigger')) {
      return geometry(state.triggerTop ?? state.rowTop, state.triggerBottom ?? state.rowBottom)
    }
    if (this.classList.contains('project-options-menu')) {
      const clamped = this.style.getPropertyValue('--project-options-menu-max-height') !== ''
      const height = clamped ? state.clampedMenuRectHeight ?? state.menuRectHeight ?? 0 : state.menuRectHeight ?? 0
      return geometry(0, height)
    }
    return geometry(0, 0)
  })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('project-groups')
      ? ([geometry(state.scrollportTop, state.scrollportBottom)] as unknown as DOMRectList)
      : ([] as unknown as DOMRectList)
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('project-options-menu') ? state.menuHeight : 0
  })
  const originalGetComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    if (!element.classList.contains('project-options-menu')) return originalGetComputedStyle(element)
    const style = originalGetComputedStyle(element)
    return new Proxy(style, {
      get(target, property) {
        if (property === 'borderTopWidth') return `${state.menuBorderTop ?? 0}px`
        if (property === 'borderBottomWidth') return `${state.menuBorderBottom ?? 0}px`
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  })
}

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

  it('collapses the project actions into one labelled options menu', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New session' })).not.toBeInTheDocument()

    const menu = await openProjectOptions(user)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      'New session',
      'Open project in VS Code',
      'Open project folder',
      'Remove from list'
    ])

    await user.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('swaps the options glyph for a close glyph while the menu is open', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    const glyph = () => trigger.querySelector('img')
    expect(glyph()).toHaveAttribute('src', optionsIconUrl)

    await user.click(trigger)
    expect(glyph()).toHaveAttribute('src', closeIconUrl)

    await user.click(trigger)
    expect(glyph()).toHaveAttribute('src', optionsIconUrl)
  })

  it('offers Open Git repository with the GitHub mark and opens it through the main process', async () => {
    const user = userEvent.setup()
    const github: ProjectRecord = { ...project1, repoRemote: { host: 'github', webUrl: 'https://github.com/me/app' } }
    seedStore({ version: 1, projects: [github], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      'New session',
      'Open project in VS Code',
      'Open project folder',
      'Open Git repository',
      'Remove from list'
    ])
    const item = within(menu).getByRole('menuitem', { name: 'Open Git repository' })
    expect(item.querySelector('img')).toHaveAttribute('src', githubIconUrl)
    // GitHub's mark is a mono glyph, so it takes the dark-theme inversion like the other mono icons.
    expect(item.querySelector('img')).toHaveClass('icon-mono')

    await user.click(item)

    expect(api.openProjectRepository).toHaveBeenCalledWith(github.id)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it.each([
    ['gitlab', gitlabIconUrl],
    ['git', gitIconUrl]
  ] as const)('uses the brand-colored %s mark without inversion for that host', async (host, iconUrl) => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [{ ...project1, repoRemote: { host, webUrl: 'https://example.com/me/app' } }], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const icon = within(menu).getByRole('menuitem', { name: 'Open Git repository' }).querySelector('img')
    expect(icon).toHaveAttribute('src', iconUrl)
    expect(icon).not.toHaveClass('icon-mono')
  })

  it('hides Open Git repository for projects without a browsable remote', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    expect(within(menu).queryByRole('menuitem', { name: 'Open Git repository' })).not.toBeInTheDocument()
  })

  it('asks for confirmation before removing a project and forgets it on confirm', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const item = within(menu).getByRole('menuitem', { name: 'Remove from list' })
    expect(item.querySelector('img')).toHaveAttribute('src', removeIconUrl)
    await user.click(item)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(api.removeProject).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog', { name: 'Remove project' })
    expect(dialog).toHaveTextContent(`Remove "${project1.name}" from the list? Nothing on disk is deleted.`)

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

    expect(api.removeProject).toHaveBeenCalledWith(project1.id)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('mentions how many sessions go with the project when it still has some', async () => {
    const user = userEvent.setup()
    const otherSession: SessionRecord = { ...stoppedSession, id: 'session-other', title: 'Investigate crash' }
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession, otherSession] })
    render(<ProjectSidebar />)

    await user.click(within(await openProjectOptions(user)).getByRole('menuitem', { name: 'Remove from list' }))

    expect(screen.getByRole('alertdialog', { name: 'Remove project' })).toHaveTextContent(
      `Remove "${project1.name}" from the list? Its 2 session(s) will be removed too. Nothing on disk is deleted.`
    )
  })

  it('keeps the project when the removal is cancelled', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    await user.click(within(await openProjectOptions(user)).getByRole('menuitem', { name: 'Remove from list' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    expect(api.removeProject).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText(project1.name)).toBeInTheDocument()
  })

  it('translates the project options trigger and menu items when the locale changes', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    useAppStore.getState().setLocale('zh-CN')
    render(<ProjectSidebar />)

    const menuName = `${project1.name} 的项目选项`
    await user.click(screen.getByRole('button', { name: menuName }))

    const menu = screen.getByRole('menu', { name: menuName })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      '新建会话',
      '在 VS Code 中打开项目',
      '打开项目文件夹',
      '从列表中移除'
    ])
  })

  it('places the options menu below its row when the scrollport has room', async () => {
    const user = userEvent.setup()
    controlProjectOptionsGeometry({ rowTop: 80, rowBottom: 112, scrollportTop: 40, scrollportBottom: 300, menuHeight: 100 })
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)

    expect(menu).toHaveAttribute('data-placement', 'below')
    expect(menu).toHaveAttribute('data-clamped', 'false')
  })

  it('places the options menu above a lower row when below space is insufficient', async () => {
    const user = userEvent.setup()
    controlProjectOptionsGeometry({ rowTop: 240, rowBottom: 272, scrollportTop: 40, scrollportBottom: 300, menuHeight: 100 })
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)

    expect(menu).toHaveAttribute('data-placement', 'above')
    expect(menu).toHaveAttribute('data-clamped', 'false')
  })

  it('clamps the menu to the roomier side and keeps keyboard navigation available when neither side fits', async () => {
    const user = userEvent.setup()
    controlProjectOptionsGeometry({ rowTop: 80, rowBottom: 112, scrollportTop: 40, scrollportBottom: 160, menuHeight: 100 })
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const newSession = within(menu).getByRole('menuitem', { name: 'New session' })
    const vscode = within(menu).getByRole('menuitem', { name: 'Open project in VS Code' })

    expect(menu).toHaveAttribute('data-placement', 'below')
    expect(menu).toHaveAttribute('data-clamped', 'true')
    expect(menu.style.getPropertyValue('--project-options-menu-max-height')).toBe('42px')
    await user.keyboard('{ArrowDown}')
    expect(vscode).toHaveFocus()
    expect(newSession).not.toHaveFocus()
  })

  it('clamps the menu above its row when above has more room than below', async () => {
    const user = userEvent.setup()
    controlProjectOptionsGeometry({ rowTop: 100, rowBottom: 132, scrollportTop: 40, scrollportBottom: 160, menuHeight: 100 })
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)

    expect(menu).toHaveAttribute('data-placement', 'above')
    expect(menu).toHaveAttribute('data-clamped', 'true')
    expect(menu.style.getPropertyValue('--project-options-menu-max-height')).toBe('54px')
  })

  it('recomputes placement while open after scroll and resize geometry changes', async () => {
    const user = userEvent.setup()
    const state = { rowTop: 80, rowBottom: 112, scrollportTop: 40, scrollportBottom: 300, menuHeight: 100 }
    controlProjectOptionsGeometry(state)
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const scrollport = document.querySelector('.project-groups') as HTMLElement
    expect(menu).toHaveAttribute('data-placement', 'below')

    state.rowTop = 240
    state.rowBottom = 272
    fireEvent.scroll(scrollport)
    expect(menu).toHaveAttribute('data-placement', 'above')

    state.rowTop = 80
    state.rowBottom = 112
    fireEvent(window, new Event('resize'))
    expect(menu).toHaveAttribute('data-placement', 'below')
  })

  it('keeps a border-box menu clamped across consecutive scroll and resize measurements', async () => {
    const user = userEvent.setup()
    controlProjectOptionsGeometry({
      rowTop: 80,
      rowBottom: 112,
      scrollportTop: 40,
      scrollportBottom: 158,
      menuHeight: 40,
      menuRectHeight: 42,
      clampedMenuRectHeight: 40,
      menuBorderTop: 1,
      menuBorderBottom: 1
    })
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const scrollport = document.querySelector('.project-groups') as HTMLElement
    expect(menu).toHaveAttribute('data-clamped', 'true')
    expect(menu.style.getPropertyValue('--project-options-menu-max-height')).toBe('40px')

    fireEvent.scroll(scrollport)
    expect(menu).toHaveAttribute('data-clamped', 'true')
    expect(menu.style.getPropertyValue('--project-options-menu-max-height')).toBe('40px')
    fireEvent(window, new Event('resize'))

    expect(menu).toHaveAttribute('data-clamped', 'true')
    expect(menu.style.getPropertyValue('--project-options-menu-max-height')).toBe('40px')
  })

  it.each([
    ['above', 0, 32],
    ['below', 320, 352]
  ])('closes the menu without restoring focus when its row scrolls fully %s the scrollport', async (_direction, rowTop, rowBottom) => {
    const user = userEvent.setup()
    const state = { rowTop: 80, rowBottom: 112, scrollportTop: 40, scrollportBottom: 300, menuHeight: 100 }
    controlProjectOptionsGeometry(state)
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    const menu = await openProjectOptions(user)
    const scrollport = document.querySelector('.project-groups') as HTMLElement
    expect(menu).toBeInTheDocument()

    state.rowTop = rowTop
    state.rowBottom = rowBottom
    fireEvent.scroll(scrollport)

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).not.toHaveFocus()
  })

  it('closes the menu when a laid-out scrollport collapses around its trigger', async () => {
    const user = userEvent.setup()
    const state = {
      rowTop: 20,
      rowBottom: 52,
      triggerTop: 32,
      triggerBottom: 48,
      scrollportTop: 40,
      scrollportBottom: 300,
      menuHeight: 100
    }
    controlProjectOptionsGeometry(state)
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    await openProjectOptions(user)
    const scrollport = document.querySelector('.project-groups') as HTMLElement
    state.scrollportBottom = state.scrollportTop
    fireEvent.scroll(scrollport)

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it.each([
    ['above', 20, 52, 8, 32],
    ['below', 288, 320, 308, 332]
  ])(
    'closes the menu when its trigger scrolls fully %s the scrollport while its row still intersects',
    async (_direction, rowTop, rowBottom, triggerTop, triggerBottom) => {
      const user = userEvent.setup()
      const state = {
        rowTop: 80,
        rowBottom: 112,
        triggerTop: 84,
        triggerBottom: 108,
        scrollportTop: 40,
        scrollportBottom: 300,
        menuHeight: 100
      }
      controlProjectOptionsGeometry(state)
      seedStore({ version: 1, projects: [project1], sessions: [] })
      render(<ProjectSidebar />)

      const menu = await openProjectOptions(user)
      const scrollport = document.querySelector('.project-groups') as HTMLElement
      expect(menu).toBeInTheDocument()

      Object.assign(state, { rowTop, rowBottom, triggerTop, triggerBottom })
      fireEvent.scroll(scrollport)

      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    }
  )

  it('keeps the menu open and places it when its trigger remains partially visible in the scrollport', async () => {
    const user = userEvent.setup()
    const state = {
      rowTop: 80,
      rowBottom: 112,
      triggerTop: 84,
      triggerBottom: 108,
      scrollportTop: 40,
      scrollportBottom: 300,
      menuHeight: 100
    }
    controlProjectOptionsGeometry(state)
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const scrollport = document.querySelector('.project-groups') as HTMLElement
    state.rowTop = 20
    state.rowBottom = 52
    state.triggerTop = 28
    state.triggerBottom = 52
    fireEvent.scroll(scrollport)

    expect(menu).toBeInTheDocument()
    expect(menu).toHaveAttribute('data-placement', 'below')
  })

  it('keeps one scroll and resize listener while open, then removes them on close and unmount', async () => {
    const user = userEvent.setup()
    controlProjectOptionsGeometry({ rowTop: 80, rowBottom: 112, scrollportTop: 40, scrollportBottom: 300, menuHeight: 100 })
    seedStore({ version: 1, projects: [project1], sessions: [] })
    const view = render(<ProjectSidebar />)
    const scrollport = document.querySelector('.project-groups') as HTMLElement
    const addScroll = vi.spyOn(scrollport, 'addEventListener')
    const removeScroll = vi.spyOn(scrollport, 'removeEventListener')
    const addResize = vi.spyOn(window, 'addEventListener')
    const removeResize = vi.spyOn(window, 'removeEventListener')

    await openProjectOptions(user)
    expect(addScroll).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(addResize).toHaveBeenCalledWith('resize', expect.any(Function))
    const scrollListenerCount = addScroll.mock.calls.filter(([type]) => type === 'scroll').length
    const resizeListenerCount = addResize.mock.calls.filter(([type]) => type === 'resize').length

    fireEvent.scroll(scrollport)
    fireEvent(window, new Event('resize'))
    expect(addScroll.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(scrollListenerCount)
    expect(addResize.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(resizeListenerCount)

    await user.keyboard('{Escape}')
    expect(removeScroll).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(removeResize).toHaveBeenCalledWith('resize', expect.any(Function))

    await openProjectOptions(user)
    view.unmount()
    expect(removeScroll.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(2)
    expect(removeResize.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(2)
  })

  it('replaces scroll and resize listeners when the open menu switches projects', async () => {
    const user = userEvent.setup()
    const project2: ProjectRecord = { ...project1, id: 'project-2', name: 'second-project', path: 'C:\\work\\second' }
    controlProjectOptionsGeometry({ rowTop: 80, rowBottom: 112, scrollportTop: 40, scrollportBottom: 300, menuHeight: 100 })
    seedStore({ version: 1, projects: [project1, project2], sessions: [] })
    const view = render(<ProjectSidebar />)
    const scrollport = document.querySelector('.project-groups') as HTMLElement
    const addScroll = vi.spyOn(scrollport, 'addEventListener')
    const removeScroll = vi.spyOn(scrollport, 'removeEventListener')
    const addResize = vi.spyOn(window, 'addEventListener')
    const removeResize = vi.spyOn(window, 'removeEventListener')

    await openProjectOptions(user, project1.name)
    await openProjectOptions(user, project2.name)

    expect(addScroll.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(2)
    expect(removeScroll.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(1)
    expect(addResize.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(2)
    expect(removeResize.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1)

    view.unmount()
    expect(removeScroll.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(2)
    expect(removeResize.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(2)
  })

  it('focuses the first enabled menu item and supports wrapping keyboard navigation', async () => {
    const user = userEvent.setup()
    seedStore(
      { version: 1, projects: [project1], sessions: [] },
      { ...agentCapabilities(), vscode: { available: false, detail: 'Install VS Code or the code command.' } }
    )
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const newSession = within(menu).getByRole('menuitem', { name: 'New session' })
    const folder = within(menu).getByRole('menuitem', { name: 'Open project folder' })
    const remove = within(menu).getByRole('menuitem', { name: 'Remove from list' })
    expect(newSession).toHaveFocus()

    // The disabled VS Code entry is skipped; the enabled ring is New session → folder → remove.
    await user.keyboard('{ArrowDown}')
    expect(folder).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(remove).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(newSession).toHaveFocus()
    await user.keyboard('{End}')
    expect(remove).toHaveFocus()
    await user.keyboard('{Home}')
    expect(newSession).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(remove).toHaveFocus()
  })

  it('closes on Escape and restores focus to the options trigger', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    await openProjectOptions(user)
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on outside click and Tab without stealing the destination focus', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    await openProjectOptions(user)
    const search = screen.getByRole('searchbox', { name: 'Search sessions' })
    await user.click(search)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(search).toHaveFocus()

    await openProjectOptions(user)
    await user.tab()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Project' })).toHaveFocus()

    await openProjectOptions(user)
    await user.tab({ shift: true })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: projectOptionsName(project1.name) })).toHaveFocus()
  })

  it('keeps only one project menu open and clears stale state when a project disappears', async () => {
    const user = userEvent.setup()
    const project2: ProjectRecord = {
      id: 'project-2',
      name: 'second-project',
      path: 'C:\\work\\second',
      createdAt: '2026-08-21T00:00:00.000Z'
    }
    const state = { version: 1 as const, projects: [project1, project2], sessions: [] }
    seedStore(state)
    render(<ProjectSidebar />)

    await openProjectOptions(user, project1.name)
    await openProjectOptions(user, project2.name)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu', { name: projectOptionsName(project2.name) })).toBeInTheDocument()

    act(() => useAppStore.setState({ appState: { ...state, projects: [project1] } }))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    act(() => useAppStore.setState({ appState: state }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('returns focus to the options trigger after a folder action and after closing the launcher', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    let menu = await openProjectOptions(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Open project folder' }))
    expect(trigger).toHaveFocus()

    menu = await openProjectOptions(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'New session' }))
    expect(screen.getByLabelText('Create session')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close launcher' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('dismisses an open launcher when the options menu is reopened', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'New session' }))
    expect(screen.getByLabelText('Create session')).toBeInTheDocument()

    // Both popovers anchor to the same row edge, so they must never be open together.
    await openProjectOptions(user)
    expect(screen.queryByLabelText('Create session')).not.toBeInTheDocument()
  })

  it('moves keyboard focus into the launcher and restores it after launcher Escape', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    await openProjectOptions(user)
    await user.keyboard('{Enter}')

    expect(screen.getByLabelText('Create session')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'PowerShell' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('Create session')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('refocuses the newly selected project launcher when New session is reopened', async () => {
    const user = userEvent.setup()
    const project2: ProjectRecord = {
      id: 'project-2',
      name: 'second-project',
      path: 'C:\\work\\second',
      createdAt: '2026-08-21T00:00:00.000Z'
    }
    seedStore({ version: 1, projects: [project1, project2], sessions: [] })
    render(<ProjectSidebar />)

    await openProjectOptions(user, project1.name)
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'PowerShell' })).toHaveFocus()

    await openProjectOptions(user, project1.name)
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'PowerShell' })).toHaveFocus()

    const project2Trigger = screen.getByRole('button', { name: projectOptionsName(project2.name) })
    await openProjectOptions(user, project2.name)
    await user.keyboard('{Enter}')

    expect(useAppStore.getState().activeProjectId).toBe(project2.id)
    expect(screen.getByRole('button', { name: 'PowerShell' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('Create session')).not.toBeInTheDocument())
    expect(project2Trigger).toHaveFocus()
  })

  it('renders the supplied options SVG as a decorative trigger icon', () => {
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    const icon = trigger.querySelector('img.icon-options') as HTMLImageElement | null
    expect(icon).not.toBeNull()
    expect(icon).toHaveAttribute('src')
    expect(icon).toHaveAttribute('alt', '')
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

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    await openProjectOptions(user)
    await user.click(screen.getByRole('menuitem', { name: 'Open project in VS Code' }))

    expect(api.openProjectInVSCode).toHaveBeenCalledWith('project-1')
    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeProjectId).toBeNull()
    expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('does not toggle the project row or restore a session when opening the folder', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    await openProjectOptions(user)
    await user.click(screen.getByRole('menuitem', { name: 'Open project folder' }))

    expect(api.openProjectFolder).toHaveBeenCalledWith('project-1')
    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeProjectId).toBeNull()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not start a project drag from the options trigger, menu, or launcher', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const transfer = { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: '', dropEffect: '' }
    const row = screen.getByText(project1.name).closest('[data-project-row]') as HTMLElement
    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    fireEvent.pointerDown(trigger)
    fireEvent.dragStart(row, { dataTransfer: transfer })

    const menu = await openProjectOptions(user)
    const newSession = within(menu).getByRole('menuitem', { name: 'New session' })
    fireEvent.pointerDown(newSession)
    fireEvent.dragStart(row, { dataTransfer: transfer })
    fireEvent.pointerUp(newSession)

    await user.click(newSession)
    const launcherAction = screen.getByRole('button', { name: 'PowerShell' })
    fireEvent.pointerDown(launcherAction)
    fireEvent.dragStart(row, { dataTransfer: transfer })

    expect(transfer.setData).not.toHaveBeenCalled()
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

  describe('project drag reordering', () => {
    const project2: ProjectRecord = { ...project1, id: 'project-2', name: 'other-app', path: 'C:\\work\\other-app' }
    const dataTransfer = () => ({ setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: '', dropEffect: '' })

    const projectRows = (): HTMLElement[] => Array.from(document.querySelectorAll('.project-row'))

    it('marks project rows draggable and calls reorderProjects with the dropped order', async () => {
      seedStore({ version: 1, projects: [project1, project2], sessions: [] })
      api.reorderProjects = vi.fn(async () => [project2, project1])
      window.codefly = api
      render(<ProjectSidebar />)

      const [firstRow, secondRow] = projectRows()
      expect(firstRow).toHaveAttribute('draggable', 'true')

      const transfer = dataTransfer()
      fireEvent.dragStart(firstRow!, { dataTransfer: transfer })
      // jsdom rects are all zeros, so clientY 0 is not above the midpoint: position is 'after'.
      fireEvent.dragOver(secondRow!, { dataTransfer: transfer, clientY: 0 })
      expect(secondRow).toHaveAttribute('data-drop', 'after')
      fireEvent.drop(secondRow!, { dataTransfer: transfer })

      await waitFor(() => expect(api.reorderProjects).toHaveBeenCalledWith(['project-2', 'project-1']))
      expect(secondRow).not.toHaveAttribute('data-drop')
    })

    it('does not call reorderProjects when the row is dropped back onto itself', () => {
      seedStore({ version: 1, projects: [project1, project2], sessions: [] })
      render(<ProjectSidebar />)

      const [firstRow] = projectRows()
      const transfer = dataTransfer()
      fireEvent.dragStart(firstRow!, { dataTransfer: transfer })
      fireEvent.dragOver(firstRow!, { dataTransfer: transfer, clientY: 0 })
      fireEvent.drop(firstRow!, { dataTransfer: transfer })

      expect(api.reorderProjects).not.toHaveBeenCalled()
    })

    it('disables dragging while a search filter is active', async () => {
      const user = userEvent.setup()
      seedStore({ version: 1, projects: [project1, project2], sessions: [] })
      render(<ProjectSidebar />)

      await user.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'x')

      for (const row of projectRows()) {
        expect(row).toHaveAttribute('draggable', 'false')
      }
    })
  })

  it('renders an SVG brand icon per session kind instead of a text glyph', () => {
    const cmdSession: SessionRecord = { ...stoppedSession, id: 'session-cmd', kind: 'cmd' }
    const codexSession: SessionRecord = { ...runningWorktreeSession, id: 'session-codex', kind: 'codex' }
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession, cmdSession, runningWorktreeSession, codexSession] })
    render(<ProjectSidebar />)

    for (const kind of ['powershell', 'cmd', 'claude', 'codex']) {
      const icon = document.querySelector(`.session-kind-icon[data-kind="${kind}"] img`)
      expect(icon).not.toBeNull()
    }
    expect(screen.queryByText('PS')).not.toBeInTheDocument()
    expect(screen.queryByText('CMD')).not.toBeInTheDocument()
    expect(screen.queryByText('CL')).not.toBeInTheDocument()
    expect(screen.queryByText('CX')).not.toBeInTheDocument()
  })

  it('shows worktree name for a worktree session and "Ordinary session" for a fallback session', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession, runningWorktreeSession] })
    render(<ProjectSidebar />)

    expect(screen.getByText('Ordinary session')).toBeInTheDocument()
    expect(screen.getByText(runningWorktreeSession.worktreeName as string)).toBeInTheDocument()
  })

  it('marks a stopped session with a restore-hinting status dot and calls restoreSession on click', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    const restarted: SessionRecord = { ...stoppedSession, status: 'running' }
    api.restoreSession = vi.fn(async () => restarted)
    window.codefly = api
    render(<ProjectSidebar />)

    expect(screen.getByRole('img', { name: 'Click to restore' })).toHaveAttribute('data-status', 'stopped')
    await user.click(screen.getByText(stoppedSession.title))

    expect(api.restoreSession).toHaveBeenCalledWith(stoppedSession.id)
  })

  it('marks a running session with a running status dot and only switches to it on click', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [runningWorktreeSession] })
    render(<ProjectSidebar />)

    expect(screen.getByRole('img', { name: 'Running' })).toHaveAttribute('data-status', 'running')
    await user.click(screen.getByText(runningWorktreeSession.title))

    expect(api.restoreSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeSessionId).toBe(runningWorktreeSession.id)
  })

  it('shows a done-tinted status dot for a running agent session whose output has gone quiet', () => {
    seedStore({ version: 1, projects: [project1], sessions: [runningWorktreeSession] })
    useAppStore.setState({ idleAgentSessionIds: { [runningWorktreeSession.id]: true } })
    render(<ProjectSidebar />)

    const status = screen.getByRole('img', { name: 'Done' })
    expect(status).toHaveAttribute('data-status', 'done')
    expect(screen.queryByRole('img', { name: 'Running' })).not.toBeInTheDocument()
  })

  it('keeps the running status dot for a quiet shell session even when it is marked idle', () => {
    const runningShell: SessionRecord = { ...stoppedSession, id: 'session-shell', status: 'running' }
    seedStore({ version: 1, projects: [project1], sessions: [runningShell] })
    useAppStore.setState({ idleAgentSessionIds: { [runningShell.id]: true } })
    render(<ProjectSidebar />)

    expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Done' })).not.toBeInTheDocument()
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

  it('keeps an unavailable VS Code menu item disabled with an accessible visible detail', async () => {
    const user = userEvent.setup()
    const detail = 'Install VS Code or the code command.'
    seedStore(
      { version: 1, projects: [project1], sessions: [] },
      { ...agentCapabilities(), vscode: { available: false, detail } }
    )
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const item = within(menu).getByRole('menuitem', { name: 'Open project in VS Code' })
    const hint = screen.getByText(detail)
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', detail)
    expect(hint).toBeVisible()
    expect(item).toHaveAttribute('aria-describedby', hint.id)

    await user.click(item)
    expect(api.openProjectInVSCode).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: projectOptionsName(project1.name) })).toBeInTheDocument()
  })

  it('does not render a visible VS Code hint when the capability is available', () => {
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    expect(screen.queryByText(/install vs code/i)).not.toBeInTheDocument()
  })

  it('renders the bundled VS Code SVG asset inside the menu item', async () => {
    const user = userEvent.setup()
    seedStore({ version: 1, projects: [project1], sessions: [] })
    render(<ProjectSidebar />)

    const menu = await openProjectOptions(user)
    const item = within(menu).getByRole('menuitem', { name: 'Open project in VS Code' })
    const icon = item.querySelector('img.icon-vscode') as HTMLImageElement | null
    expect(icon).not.toBeNull()
    expect(icon).toHaveAttribute('src')
    expect(icon).toHaveAttribute('alt', '')
  })

  it('gives the session secondary label (worktree name / "Ordinary session") a title attribute for ellipsized text', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession, runningWorktreeSession] })
    render(<ProjectSidebar />)

    expect(screen.getByText('Ordinary session')).toHaveAttribute('title', 'Ordinary session')
    expect(screen.getByText(runningWorktreeSession.worktreeName as string)).toHaveAttribute('title', runningWorktreeSession.worktreeName)
  })

  it('exposes a non-empty accessible name for the sole icon-only project action', () => {
    seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
    render(<ProjectSidebar />)

    const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
    expect(trigger.getAttribute('aria-label')).toBeTruthy()

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
