// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { BYPASS_WARNING_TEXT } from '../session-status'
import { useAppStore } from '../store/use-app-store'
import { AGENT_NEWLINE_SEQUENCE } from '../terminal/terminal-key-bindings'
import TerminalWorkspace from './TerminalWorkspace'

// TerminalWorkspace embeds real @xterm/xterm and @xterm/addon-fit instances, which rely on
// canvas/ResizeObserver browser APIs jsdom does not provide. Both packages are mocked with
// minimal, introspectable test doubles below (vi.hoisted so the factory can reference them)
// rather than exercising the real library — the behavior under test is TerminalWorkspace's
// own ownership/routing/dispose logic, not xterm's rendering internals.
const { FakeTerminal, FakeFitAddon, FakeWebglAddon, FakeResizeObserver } = vi.hoisted(() => {
  class FakeTerminalImpl {
    static instances: FakeTerminalImpl[] = []
    options: Record<string, unknown>
    cols = 80
    // xterm builds its layered DOM inside the host on open(); only .xterm-screen matters here,
    // because that is where the WebGL addon attaches its canvas and where the block-glyph grid
    // alignment reads the rendered cell width back from.
    private screen: HTMLElement | undefined
    private canvas: HTMLCanvasElement | undefined
    open = vi.fn((element: HTMLElement) => {
      this.screen = document.createElement('div')
      this.screen.className = 'xterm-screen'
      element.append(this.screen)
    })
    write = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    loadAddon = vi.fn((addon: unknown) => {
      // Mirrors the real Terminal.loadAddon, which synchronously calls addon.activate(this)
      // and lets its failure propagate — that is where a missing WebGL2 context surfaces.
      if (addon instanceof FakeWebglAddonImpl) {
        if (FakeWebglAddonImpl.activationError) throw FakeWebglAddonImpl.activationError
        // A successful activation attaches a canvas whose bitmap is sized in whole device
        // pixels, which is what the block-glyph alignment measures the cell width from.
        this.canvas = document.createElement('canvas')
        this.screen?.append(this.canvas)
        this.resizeCanvas()
      }
    })

    // WebglRenderer computes device.cell.width as device.char.width + Math.round(letterSpacing)
    // and sizes its canvas at cols * that, so changing letterSpacing feeds straight back into
    // what a later measurement sees. Reproducing that loop is what makes an alignment that
    // flip-flops between 0 and 1 on every fit fail this suite instead of passing it.
    private resizeCanvas(): void {
      if (!this.canvas) return
      const letterSpacing = Math.round((this.options.letterSpacing as number | undefined) ?? 0)
      this.canvas.width = this.cols * (FakeWebglAddonImpl.deviceCharWidth + letterSpacing)
    }
    onData = vi.fn((listener: (data: string) => void) => {
      this.dataListeners.push(listener)
      return { dispose: vi.fn() }
    })
    keyEventHandler: ((event: KeyboardEvent) => boolean) | undefined
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.keyEventHandler = handler
    })

    private dataListeners: Array<(data: string) => void> = []

    constructor(options?: Record<string, unknown>) {
      const initial = options ?? {}
      let letterSpacing = (initial.letterSpacing as number | undefined) ?? 0
      // Writing terminal.options.letterSpacing re-renders the real terminal at a new cell
      // width; the accessor is how this double keeps its canvas in step.
      Object.defineProperty(initial, 'letterSpacing', {
        get: () => letterSpacing,
        set: (value: number) => {
          letterSpacing = value
          this.resizeCanvas()
        },
        enumerable: true,
        configurable: true
      })
      this.options = initial
      FakeTerminalImpl.instances.push(this)
    }

    emitData(data: string): void {
      for (const listener of [...this.dataListeners]) listener(data)
    }
  }

  class FakeFitAddonImpl {
    static instances: FakeFitAddonImpl[] = []
    fit = vi.fn()
    dispose = vi.fn()
    proposeDimensions = vi.fn((): { cols: number; rows: number } | undefined => ({ cols: 80, rows: 24 }))

    constructor() {
      FakeFitAddonImpl.instances.push(this)
    }
  }

  class FakeWebglAddonImpl {
    static instances: FakeWebglAddonImpl[] = []
    // Set by a test to make loading the addon throw, standing in for a machine where the
    // renderer process has no working WebGL2 context (GPU blocklisted, --disable-gpu, ...).
    // The real addon fails from activate(), which loadAddon() calls — not the constructor.
    static activationError: Error | undefined
    // Width in whole device pixels of one CHARACTER once the renderer has measured the font,
    // before letterSpacing is added on top. 13 is what Cascadia Mono measures at the default
    // font size and 150% display scaling — odd, which is the case the alignment exists for.
    static deviceCharWidth = 13
    dispose = vi.fn()
    private contextLossListeners: Array<() => void> = []

    constructor() {
      FakeWebglAddonImpl.instances.push(this)
    }

    onContextLoss = vi.fn((listener: () => void) => {
      this.contextLossListeners.push(listener)
      return { dispose: vi.fn() }
    })

    emitContextLoss(): void {
      for (const listener of [...this.contextLossListeners]) listener()
    }
  }

  class FakeResizeObserverImpl {
    static instances: FakeResizeObserverImpl[] = []
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
    private readonly callback: () => void

    constructor(callback: () => void) {
      this.callback = callback
      FakeResizeObserverImpl.instances.push(this)
    }

    trigger(): void {
      this.callback()
    }
  }

  return {
    FakeTerminal: FakeTerminalImpl,
    FakeFitAddon: FakeFitAddonImpl,
    FakeWebglAddon: FakeWebglAddonImpl,
    FakeResizeObserver: FakeResizeObserverImpl
  }
})

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFitAddon }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebglAddon }))

// Deliberately NOT annotated with a `CodeFlyApi`-shaped return type (see App.test.tsx): that
// would widen every vi.fn() property down to a plain function type and lose access to mock
// helpers like mockResolvedValueOnce/mockClear used below. Structural compatibility with
// window.codefly is still checked at the `window.codefly = api` assignment site.
const createFakeApi = () => {
  const dataListeners = new Set<(payload: { sessionId: string; data: string }) => void>()
  const exitListeners = new Set<(payload: { sessionId: string; exitCode: number }) => void>()
  return {
    getSnapshot: vi.fn(async (): Promise<AppSnapshot> => ({
      platform: 'win32',
      state: { version: 1, projects: [], sessions: [] },
      capabilities: defaultCapabilities()
    })),
    addProject: vi.fn(async (): Promise<ProjectRecord | null> => null),
    reorderProjects: vi.fn(async (): Promise<ProjectRecord[]> => []),
    openProjectInVSCode: vi.fn(async (): Promise<void> => undefined),
    openProjectFolder: vi.fn(async (): Promise<void> => undefined),
    openProjectRepository: vi.fn(async (): Promise<void> => undefined),
    removeProject: vi.fn(async (): Promise<void> => undefined),
    createSession: vi.fn(async () => {
      throw new Error('createSession not stubbed for this test')
    }),
    restoreSession: vi.fn(async (_sessionId: string): Promise<SessionRecord> => {
      throw new Error('restoreSession not stubbed for this test')
    }),
    deleteSession: vi.fn(async (): Promise<DeleteSessionResult> => ({ status: 'deleted' })),
    submitFirstInput: vi.fn(async (): Promise<void> => undefined),
    setTheme: vi.fn(async (): Promise<void> => undefined),
    setWindowPinned: vi.fn(async (pinned: boolean): Promise<boolean> => pinned),
    getAppInfo: vi.fn(async (): Promise<AppInfo> => ({ version: '0.0.0-test', links: EXTERNAL_LINKS })),
    checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult> => ({ status: 'none', currentVersion: '0.0.0-test' })),
    openExternalLink: vi.fn(async (): Promise<void> => undefined),
    getAutoLaunch: vi.fn(async (): Promise<boolean> => false),
    setAutoLaunch: vi.fn(async (enabled: boolean): Promise<boolean> => enabled),
    downloadUpdate: vi.fn(async (): Promise<UpdateDownloadResult> => ({ status: 'cancelled' })),
    cancelUpdateDownload: vi.fn(async (): Promise<void> => undefined),
    installUpdate: vi.fn(async (): Promise<UpdateInstallResult> => ({ status: 'launched' })),
    onUpdateProgress: vi.fn(() => () => undefined),
    writeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
    onTerminalData: vi.fn((listener: (payload: { sessionId: string; data: string }) => void) => {
      dataListeners.add(listener)
      return vi.fn(() => {
        dataListeners.delete(listener)
      })
    }),
    onTerminalExit: vi.fn((listener: (payload: { sessionId: string; exitCode: number }) => void) => {
      exitListeners.add(listener)
      return vi.fn(() => {
        exitListeners.delete(listener)
      })
    }),
    emitTerminalData: (payload: { sessionId: string; data: string }) => {
      for (const listener of [...dataListeners]) listener(payload)
    },
    emitTerminalExit: (payload: { sessionId: string; exitCode: number }) => {
      for (const listener of [...exitListeners]) listener(payload)
    }
  }
}

// A real snapshot carries one entry per agent kind, built from the registry so adding a CLI
// does not mean hand-editing the fixture.
const defaultCapabilities = (): CapabilityState => ({
  ...(Object.fromEntries(AGENT_KINDS.map((kind) => [kind, { available: true, detail: '' }])) as Record<
    AgentKind,
    ToolAvailability
  >),
  vscode: { available: true, detail: '' }
})

const project1: ProjectRecord = {
  id: 'project-1',
  name: 'demo-project',
  path: 'C:\\work\\demo-project',
  createdAt: '2026-08-20T00:00:00.000Z'
}

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

const runningPowerShellSession: SessionRecord = {
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

const stoppedSession: SessionRecord = { ...runningPowerShellSession, id: 'session-stopped', status: 'stopped' }

const seedStore = (...sessions: SessionRecord[]): void => {
  useAppStore.setState({
    appState: { version: 1, projects: [project1], sessions },
    capabilities: defaultCapabilities(),
    activeProjectId: project1.id,
    activeSessionId: null,
    launcherOpen: false,
    searchQuery: '',
    notice: null
  })
}

type FakeApi = ReturnType<typeof createFakeApi>

let api: FakeApi

beforeEach(() => {
  useAppStore.getState().reset()
  api = createFakeApi()
  window.codefly = api
  FakeTerminal.instances = []
  FakeFitAddon.instances = []
  FakeWebglAddon.instances = []
  FakeWebglAddon.activationError = undefined
  FakeWebglAddon.deviceCharWidth = 13
  FakeResizeObserver.instances = []
  // jsdom has no ResizeObserver; stub a controllable one so tests can trigger the callback
  // TerminalWorkspace registers per entry and assert what it does in response.
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

describe('TerminalWorkspace', () => {
  it('creates exactly one terminal instance per opened session and does not recreate it on re-activation', async () => {
    seedStore(runningClaudeSession, runningPowerShellSession)
    act(() => useAppStore.setState({ activeSessionId: runningClaudeSession.id }))
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    useAppStore.setState({ activeSessionId: runningPowerShellSession.id })
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(2))

    act(() => useAppStore.setState({ activeSessionId: runningClaudeSession.id }))
    await waitFor(() => expect(screen.getByTestId(`terminal-host-${runningClaudeSession.id}`).closest('.terminal-pane')).toHaveStyle({ display: 'flex' }))

    expect(FakeTerminal.instances).toHaveLength(2)
  })

  it('does not create a terminal for a session that has never been active', async () => {
    seedStore(runningClaudeSession, runningPowerShellSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    expect(screen.queryByTestId(`terminal-host-${runningPowerShellSession.id}`)).not.toBeInTheDocument()
  })

  it('keeps an inactive terminal mounted with display:none instead of unmounting it', async () => {
    seedStore(runningClaudeSession, runningPowerShellSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    useAppStore.setState({ activeSessionId: runningPowerShellSession.id })
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(2))

    const claudeHost = screen.getByTestId(`terminal-host-${runningClaudeSession.id}`)
    const psHost = screen.getByTestId(`terminal-host-${runningPowerShellSession.id}`)

    expect(claudeHost.closest('.terminal-pane')).toHaveStyle({ display: 'none' })
    expect(psHost.closest('.terminal-pane')).toHaveStyle({ display: 'flex' })
    expect(FakeTerminal.instances[0].dispose).not.toHaveBeenCalled()
  })

  it('creates terminals with the current theme palette and re-themes live terminals on switch', async () => {
    seedStore(runningClaudeSession)
    act(() => useAppStore.setState({ activeSessionId: runningClaudeSession.id }))
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    const terminal = FakeTerminal.instances[0]
    expect(terminal.options.theme).toMatchObject({ background: '#0b0f14' })

    act(() => useAppStore.setState({ theme: 'light' }))
    expect(terminal.options.theme).toMatchObject({ background: '#f5f7fa' })

    act(() => useAppStore.setState({ theme: 'dark' }))
    expect(terminal.options.theme).toMatchObject({ background: '#0b0f14' })
  })

  it('focuses the terminal as soon as its session becomes active so typing works without clicking', async () => {
    seedStore(runningPowerShellSession)
    act(() => useAppStore.setState({ activeSessionId: runningPowerShellSession.id }))
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    await waitFor(() => expect(FakeTerminal.instances[0].focus).toHaveBeenCalled())
  })

  it('focuses the newly activated terminal when switching between sessions', async () => {
    seedStore(runningClaudeSession, runningPowerShellSession)
    act(() => useAppStore.setState({ activeSessionId: runningClaudeSession.id }))
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    act(() => useAppStore.setState({ activeSessionId: runningPowerShellSession.id }))
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(2))
    await waitFor(() => expect(FakeTerminal.instances[1].focus).toHaveBeenCalled())
  })

  it('re-focuses the active terminal when its session is restarted back to running', async () => {
    const stoppedActive = { ...runningPowerShellSession, status: 'stopped' as const }
    seedStore(stoppedActive)
    act(() => useAppStore.setState({ activeSessionId: stoppedActive.id }))
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    await waitFor(() => expect(FakeTerminal.instances[0].focus).toHaveBeenCalled())
    FakeTerminal.instances[0].focus.mockClear()

    act(() =>
      useAppStore.setState({
        appState: { version: 1, projects: [project1], sessions: [{ ...stoppedActive, status: 'running' }] }
      })
    )
    await waitFor(() => expect(FakeTerminal.instances[0].focus).toHaveBeenCalled())
  })

  it('does not steal focus when the active session exits to stopped', async () => {
    seedStore(runningPowerShellSession)
    act(() => useAppStore.setState({ activeSessionId: runningPowerShellSession.id }))
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    await waitFor(() => expect(FakeTerminal.instances[0].focus).toHaveBeenCalled())
    FakeTerminal.instances[0].focus.mockClear()

    act(() =>
      useAppStore.setState({
        appState: { version: 1, projects: [project1], sessions: [{ ...runningPowerShellSession, status: 'stopped' }] }
      })
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    expect(FakeTerminal.instances[0].focus).not.toHaveBeenCalled()
  })

  it('routes incoming terminal data only to the terminal owning that session ID', async () => {
    seedStore(runningClaudeSession, runningPowerShellSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    useAppStore.setState({ activeSessionId: runningPowerShellSession.id })
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(2))

    const [claudeTerminal, psTerminal] = FakeTerminal.instances

    api.emitTerminalData({ sessionId: runningClaudeSession.id, data: 'hello from claude' })

    expect(claudeTerminal.write).toHaveBeenCalledWith('hello from claude')
    expect(psTerminal.write).not.toHaveBeenCalled()
  })

  it('delivers terminal data that arrives before the owning xterm is mounted', async () => {
    seedStore(runningClaudeSession)
    render(<TerminalWorkspace />)

    api.emitTerminalData({ sessionId: runningClaudeSession.id, data: 'CODEFLY_FAKE_AGENT_READY\r\n' })
    act(() => useAppStore.setState({ activeSessionId: runningClaudeSession.id }))

    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    expect(FakeTerminal.instances[0].write).toHaveBeenCalledWith('CODEFLY_FAKE_AGENT_READY\r\n')
  })

  it('bounds pre-mount output to the newest 64 KiB per session', async () => {
    seedStore(runningClaudeSession)
    render(<TerminalWorkspace />)
    const oversized = `${'old'.repeat(10_000)}${'n'.repeat(70_000)}`

    api.emitTerminalData({ sessionId: runningClaudeSession.id, data: oversized })
    act(() => useAppStore.setState({ activeSessionId: runningClaudeSession.id }))

    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    const retained = FakeTerminal.instances[0].write.mock.calls[0]?.[0] as string
    expect(retained).toHaveLength(65_536)
    expect(retained).toBe(oversized.slice(-65_536))
  })

  it('always forwards keystrokes to writeTerminal and calls submitFirstInput exactly once on the first submitted line', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    const terminal = FakeTerminal.instances[0]
    terminal.emitData('h')
    terminal.emitData('i')
    terminal.emitData('\r')
    terminal.emitData('more')
    terminal.emitData('\r')

    expect(api.writeTerminal).toHaveBeenNthCalledWith(1, runningClaudeSession.id, 'h')
    expect(api.writeTerminal).toHaveBeenNthCalledWith(2, runningClaudeSession.id, 'i')
    expect(api.writeTerminal).toHaveBeenNthCalledWith(3, runningClaudeSession.id, '\r')
    expect(api.writeTerminal).toHaveBeenNthCalledWith(4, runningClaudeSession.id, 'more')
    expect(api.writeTerminal).toHaveBeenNthCalledWith(5, runningClaudeSession.id, '\r')
    expect(api.writeTerminal).toHaveBeenCalledTimes(5)

    await waitFor(() => expect(api.submitFirstInput).toHaveBeenCalledTimes(1))
    expect(api.submitFirstInput).toHaveBeenCalledWith(runningClaudeSession.id, 'hi')
  })

  it('hands Ctrl+V to the browser in a Claude session so its paste event can reach xterm instead of sending ^V', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    const handler = FakeTerminal.instances[0].keyEventHandler
    expect(handler).toBeDefined()
    const event = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, cancelable: true })

    expect(handler!(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(api.writeTerminal).not.toHaveBeenCalled()
  })

  it('sends the agent newline sequence for Shift+Enter in a Codex session without treating it as the first submitted line', async () => {
    const codexSession: SessionRecord = { ...runningClaudeSession, id: 'session-codex', kind: 'codex' }
    seedStore(codexSession)
    useAppStore.setState({ activeSessionId: codexSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    const terminal = FakeTerminal.instances[0]
    const handler = terminal.keyEventHandler!
    terminal.emitData('abc')
    const keydown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, cancelable: true })
    expect(handler(keydown)).toBe(false)
    expect(keydown.defaultPrevented).toBe(true)
    const keyup = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', shiftKey: true, cancelable: true })
    expect(handler(keyup)).toBe(false)
    terminal.emitData('def')

    expect(api.writeTerminal.mock.calls).toEqual([
      [codexSession.id, 'abc'],
      [codexSession.id, AGENT_NEWLINE_SEQUENCE],
      [codexSession.id, 'def']
    ])
    expect(api.submitFirstInput).not.toHaveBeenCalled()

    // The eventual plain Enter submits the whole multi-line draft's first line as the title seed.
    terminal.emitData('\r')
    await waitFor(() => expect(api.submitFirstInput).toHaveBeenCalledWith(codexSession.id, 'abcdef'))
  })

  it('leaves Ctrl+V and Shift+Enter to xterm in a PowerShell session', async () => {
    seedStore(runningPowerShellSession)
    useAppStore.setState({ activeSessionId: runningPowerShellSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    const handler = FakeTerminal.instances[0].keyEventHandler!
    expect(handler(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, cancelable: true }))).toBe(true)
    expect(handler(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, cancelable: true }))).toBe(true)
    expect(api.writeTerminal).not.toHaveBeenCalled()
  })

  it('fits the terminal when its session becomes active', async () => {
    seedStore(runningClaudeSession, runningPowerShellSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeFitAddon.instances).toHaveLength(1))
    expect(FakeFitAddon.instances[0].fit).toHaveBeenCalled()

    useAppStore.setState({ activeSessionId: runningPowerShellSession.id })
    await waitFor(() => expect(FakeFitAddon.instances).toHaveLength(2))
    expect(FakeFitAddon.instances[1].fit).toHaveBeenCalled()
  })

  it('sends only changed, positive dimensions when the ResizeObserver fires', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeResizeObserver.instances).toHaveLength(1))

    const fitAddon = FakeFitAddon.instances[0]
    const resizeObserver = FakeResizeObserver.instances[0]
    api.resizeTerminal.mockClear()

    fitAddon.proposeDimensions.mockReturnValue({ cols: 100, rows: 40 })
    resizeObserver.trigger()
    expect(api.resizeTerminal).toHaveBeenCalledWith(runningClaudeSession.id, 100, 40)

    api.resizeTerminal.mockClear()
    resizeObserver.trigger()
    expect(api.resizeTerminal).not.toHaveBeenCalled()

    fitAddon.proposeDimensions.mockReturnValue({ cols: 0, rows: 0 })
    resizeObserver.trigger()
    expect(api.resizeTerminal).not.toHaveBeenCalled()

    fitAddon.proposeDimensions.mockReturnValue(undefined)
    resizeObserver.trigger()
    expect(api.resizeTerminal).not.toHaveBeenCalled()
  })

  // A restart in place (click-to-restore, or the header's restart action) hands the session a
  // BRAND NEW pty, spawned at TerminalService's own 120x30 default, while this xterm entry and
  // its memo of what the OLD pty was last told both survive. Neither the active id, the mounted
  // list nor the host's box changes, so nothing else re-fits: the size has to be pushed again on
  // the transition back to running, or the new pty stays at 120x30 while xterm renders at its
  // fitted size and ConPTY's differential repaints land on the wrong geometry.
  it('re-pushes the terminal size when a session restarts in place, reusing the same xterm entry', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(api.resizeTerminal).toHaveBeenCalledWith(runningClaudeSession.id, 80, 24))
    api.resizeTerminal.mockClear()

    act(() =>
      useAppStore.setState({
        appState: { version: 1, projects: [project1], sessions: [{ ...runningClaudeSession, status: 'stopped' }] }
      })
    )
    expect(api.resizeTerminal).not.toHaveBeenCalled()

    act(() =>
      useAppStore.setState({
        appState: { version: 1, projects: [project1], sessions: [{ ...runningClaudeSession, status: 'running' }] }
      })
    )

    await waitFor(() => expect(api.resizeTerminal).toHaveBeenCalledWith(runningClaudeSession.id, 80, 24))
    expect(FakeTerminal.instances).toHaveLength(1)
  })

  it('never sends non-finite (NaN/Infinity) dimensions to resizeTerminal', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeResizeObserver.instances).toHaveLength(1))

    const fitAddon = FakeFitAddon.instances[0]
    const resizeObserver = FakeResizeObserver.instances[0]
    api.resizeTerminal.mockClear()

    fitAddon.proposeDimensions.mockReturnValue({ cols: NaN, rows: NaN })
    resizeObserver.trigger()
    expect(api.resizeTerminal).not.toHaveBeenCalled()

    fitAddon.proposeDimensions.mockReturnValue({ cols: 80, rows: NaN })
    resizeObserver.trigger()
    expect(api.resizeTerminal).not.toHaveBeenCalled()

    fitAddon.proposeDimensions.mockReturnValue({ cols: Infinity, rows: 24 })
    resizeObserver.trigger()
    expect(api.resizeTerminal).not.toHaveBeenCalled()
  })

  it('does not fit or resize a hidden (inactive) pane when its ResizeObserver fires', async () => {
    seedStore(runningClaudeSession, runningPowerShellSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    const claudeFitAddon = FakeFitAddon.instances[0]
    const claudeResizeObserver = FakeResizeObserver.instances[0]

    useAppStore.setState({ activeSessionId: runningPowerShellSession.id })
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(2))

    claudeFitAddon.fit.mockClear()
    api.resizeTerminal.mockClear()

    // Claude's pane is now display:none (PowerShell is active); its ResizeObserver keeps
    // observing so it's ready when the pane becomes visible again, but firing it now must be
    // a no-op — it must not reflow (fit()) or resize a hidden terminal.
    claudeResizeObserver.trigger()

    expect(claudeFitAddon.fit).not.toHaveBeenCalled()
    expect(api.resizeTerminal).not.toHaveBeenCalled()
  })

  it('disposes the terminal entry and removes its pane when its session is deleted', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    useAppStore.setState((state) => ({ appState: { ...state.appState, sessions: [] } }))

    await waitFor(() => expect(FakeTerminal.instances[0].dispose).toHaveBeenCalled())
    expect(FakeResizeObserver.instances[0].disconnect).toHaveBeenCalled()
    expect(screen.queryByTestId(`terminal-host-${runningClaudeSession.id}`)).not.toBeInTheDocument()
  })

  it('preserves xterm contents after an unexpected exit by writing a notice instead of disposing', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))

    api.emitTerminalExit({ sessionId: runningClaudeSession.id, exitCode: 1 })

    expect(FakeTerminal.instances[0].write).toHaveBeenCalledWith(expect.stringContaining('exited'))
    expect(FakeTerminal.instances[0].dispose).not.toHaveBeenCalled()
    expect(screen.getByTestId(`terminal-host-${runningClaudeSession.id}`)).toBeInTheDocument()
  })

  it('disposes every terminal entry and both IPC subscriptions on unmount', async () => {
    seedStore(runningClaudeSession, runningPowerShellSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    const { unmount } = render(<TerminalWorkspace />)
    useAppStore.setState({ activeSessionId: runningPowerShellSession.id })
    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(2))

    expect(api.onTerminalData).toHaveBeenCalledTimes(1)
    expect(api.onTerminalExit).toHaveBeenCalledTimes(1)
    const dataUnsubscribe = api.onTerminalData.mock.results[0]!.value as ReturnType<typeof vi.fn>
    const exitUnsubscribe = api.onTerminalExit.mock.results[0]!.value as ReturnType<typeof vi.fn>

    unmount()

    expect(dataUnsubscribe).toHaveBeenCalledTimes(1)
    expect(exitUnsubscribe).toHaveBeenCalledTimes(1)
    expect(FakeTerminal.instances[0].dispose).toHaveBeenCalled()
    expect(FakeTerminal.instances[1].dispose).toHaveBeenCalled()
    expect(FakeResizeObserver.instances[0].disconnect).toHaveBeenCalled()
    expect(FakeResizeObserver.instances[1].disconnect).toHaveBeenCalled()
  })

  it('renders session title, full launch path, kind, and running status in the header', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    expect(await screen.findByText(runningClaudeSession.title)).toBeInTheDocument()
    expect(screen.getByText(runningClaudeSession.launchPath)).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('renders the native Shell label in a macOS session header', async () => {
    const shellSession: SessionRecord = {
      ...runningPowerShellSession,
      id: 'session-shell',
      kind: 'shell',
      title: 'New Shell session',
      launchPath: '/Users/test/demo-project'
    }
    seedStore(shellSession)
    useAppStore.setState({ activeSessionId: shellSession.id })
    render(<TerminalWorkspace />)

    expect(await screen.findByText('Shell')).toBeInTheDocument()
  })

  it('shows "Starting…" for a creating session header, matching the sidebar\'s shared label', async () => {
    const creatingSession: SessionRecord = { ...runningPowerShellSession, id: 'session-creating', status: 'creating' }
    seedStore(creatingSession)
    useAppStore.setState({ activeSessionId: creatingSession.id })
    render(<TerminalWorkspace />)

    expect(await screen.findByText('Starting…')).toBeInTheDocument()
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument()
  })

  it("shows the session's lastError for an error session header, matching the sidebar's shared label", async () => {
    const errorSession: SessionRecord = { ...runningPowerShellSession, id: 'session-error', status: 'error', lastError: 'PTY spawn failed' }
    seedStore(errorSession)
    useAppStore.setState({ activeSessionId: errorSession.id })
    render(<TerminalWorkspace />)

    expect(await screen.findByText('PTY spawn failed')).toBeInTheDocument()
  })

  it('shows "Path missing" for a missing session header, matching the sidebar\'s shared label', async () => {
    const missingSession: SessionRecord = { ...runningPowerShellSession, id: 'session-missing', status: 'missing' }
    seedStore(missingSession)
    useAppStore.setState({ activeSessionId: missingSession.id })
    render(<TerminalWorkspace />)

    expect(await screen.findByText('Path missing')).toBeInTheDocument()
  })

  it('shows the shared bypass warning text in a running Claude header', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    expect(await screen.findByText(BYPASS_WARNING_TEXT)).toBeInTheDocument()
  })

  // Comate's bypass is an environment variable rather than a flag, so the badge has to be
  // driven by "is this an agent" and not by the presence of bypass argv.
  it.each([
    ['gemini' as const, 'Gemini'],
    ['copilot' as const, 'GitHub Copilot'],
    ['cursor' as const, 'Cursor'],
    ['comate' as const, 'Comate'],
    ['qwen' as const, 'Qwen Code']
  ])('names a running %s session and discloses its bypass in the header', async (kind, label) => {
    const session: SessionRecord = { ...runningClaudeSession, id: `session-${kind}`, kind }
    seedStore(session)
    useAppStore.setState({ activeSessionId: session.id })
    render(<TerminalWorkspace />)

    expect(await screen.findByText(label)).toHaveClass('terminal-header-kind')
    expect(screen.getByText(BYPASS_WARNING_TEXT)).toBeInTheDocument()
  })

  it('renders the bypass disclosure as a compact badge inside the header row, not a banner or strip', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    const badge = await screen.findByText(BYPASS_WARNING_TEXT)
    expect(badge).toHaveClass('terminal-header-bypass')
    expect(badge.closest('.terminal-header-row')).not.toBeNull()
    expect(document.querySelector('.agent-bypass-status')).toBeNull()
  })

  it('configures xterm with the Cascadia Mono terminal font', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    expect(FakeTerminal.instances[0].options.fontFamily).toContain('Cascadia Mono')
  })

  // xterm's default DOM renderer lays each cell out on a fractional CSS grid (a Cascadia Mono
  // cell measures 8.7875px wide at 100% zoom), so the glyph-drawn Block Elements that agents
  // use for pixel art — U+2588 and the quadrants around it — cannot meet at a device-pixel
  // boundary and leave hairline background-colored seams running through what should be solid
  // fill (visible as cracks in Claude Code's startup logo). The WebGL renderer sizes cells in
  // whole device pixels and draws those code points from its own vector CustomGlyphs table
  // instead of the font, so the fill is seamless.
  it('loads the WebGL renderer so Block Elements are drawn without seams', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeWebglAddon.instances).toHaveLength(1))
    const terminal = FakeTerminal.instances[0]
    expect(terminal.loadAddon).toHaveBeenCalledWith(FakeWebglAddon.instances[0])
    // The addon needs a live element to attach its canvas to, so it must come after open().
    const openOrder = terminal.open.mock.invocationCallOrder[0]
    const webglOrder = terminal.loadAddon.mock.calls.findIndex((call) => call[0] === FakeWebglAddon.instances[0])
    expect(terminal.loadAddon.mock.invocationCallOrder[webglOrder]).toBeGreaterThan(openOrder)
  })

  // The WebGL renderer alone is not enough: it draws U+259B (▛) — which Claude Code's logo
  // uses for the head — as two rectangles that MEET at deviceCellWidth / 2. On an odd cell
  // width that join falls on a half pixel, both fillRects anti-alias into the same column and
  // the two 50% passes composite to 75%, leaking a hairline of the cell's black background
  // down through solid orange. One device pixel of letterSpacing moves the join onto a pixel
  // boundary. See block-glyph-alignment.ts.
  it('widens an odd cell grid by one device pixel so composed block glyphs have no seam', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeWebglAddon.instances).toHaveLength(1))
    expect(FakeTerminal.instances[0].options.letterSpacing).toBe(1)
  })

  it('leaves an already-even cell grid alone', async () => {
    FakeWebglAddon.deviceCharWidth = 12
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeWebglAddon.instances).toHaveLength(1))
    expect(FakeTerminal.instances[0].options.letterSpacing ?? 0).toBe(0)
  })

  it('keeps the session usable when WebGL is unavailable', async () => {
    FakeWebglAddon.activationError = new Error('WebGL2 is not supported')
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    // Terminal still opened and still receives PTY output through the DOM renderer.
    expect(FakeTerminal.instances[0].open).toHaveBeenCalled()
    api.emitTerminalData({ sessionId: runningClaudeSession.id, data: 'hello' })
    expect(FakeTerminal.instances[0].write).toHaveBeenCalledWith('hello')
  })

  it('drops the WebGL renderer instead of freezing the pane when the GPU context is lost', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeWebglAddon.instances).toHaveLength(1))
    const addon = FakeWebglAddon.instances[0]
    act(() => {
      addon.emitContextLoss()
    })

    expect(addon.dispose).toHaveBeenCalled()
    expect(FakeTerminal.instances[0].dispose).not.toHaveBeenCalled()
  })

  // A PTY-backed terminal must treat LF as a bare line feed: ConPTY emits
  // 'ESC[<row>;4H ESC[K <LF> text' to paint the next row at the SAME column, so rewriting LF
  // to CR+LF drags that text to column 1. Because ConPTY repaints differentially, it never
  // learns about the cells it did not intend to write, so the shifted characters survive every
  // later repaint as residue (observed as 3-character stubs left behind after closing /usage).
  it('does not convert LF to CRLF, so PTY cursor-down-same-column output keeps its column', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await waitFor(() => expect(FakeTerminal.instances).toHaveLength(1))
    expect(FakeTerminal.instances[0].options.convertEol).not.toBe(true)
  })

  it('gives the terminal header status a data-status attribute matching the shared status pill styling', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    expect(await screen.findByText('Running')).toHaveAttribute('data-status', 'running')
  })

  it('shows "Done" in the header when the active agent session output has gone quiet', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id, idleAgentSessionIds: { [runningClaudeSession.id]: true } })
    render(<TerminalWorkspace />)

    expect(await screen.findByText('Done')).toHaveAttribute('data-status', 'done')
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  it('hides the bypass warning text in a running PowerShell header', async () => {
    seedStore(runningPowerShellSession)
    useAppStore.setState({ activeSessionId: runningPowerShellSession.id })
    render(<TerminalWorkspace />)

    await screen.findByText(runningPowerShellSession.title)
    expect(screen.queryByText(BYPASS_WARNING_TEXT)).not.toBeInTheDocument()
  })

  it('shows a compact restart action for a stopped session that calls the store restore path', async () => {
    const user = userEvent.setup()
    seedStore(stoppedSession)
    useAppStore.setState({ activeSessionId: stoppedSession.id })
    api.restoreSession.mockResolvedValueOnce({ ...stoppedSession, status: 'running' })
    render(<TerminalWorkspace />)

    const restartButton = await screen.findByRole('button', { name: /restart/i })
    await user.click(restartButton)

    expect(api.restoreSession).toHaveBeenCalledWith(stoppedSession.id)
  })

  it('does not show a restart action for a running session', async () => {
    seedStore(runningClaudeSession)
    useAppStore.setState({ activeSessionId: runningClaudeSession.id })
    render(<TerminalWorkspace />)

    await screen.findByText(runningClaudeSession.title)
    expect(screen.queryByRole('button', { name: /restart/i })).not.toBeInTheDocument()
  })
})
