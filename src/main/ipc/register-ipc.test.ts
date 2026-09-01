import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type {
  AppInfo,
  AppSnapshot,
  AppState,
  DeleteSessionResult,
  ProjectRecord,
  SessionRecord,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateInstallResult
} from '../../shared/contracts'
import { IPC } from '../../shared/ipc'
import { EXTERNAL_LINKS } from '../../shared/links'
import { ProjectNotFoundError, type ProjectService } from '../services/project-service'
import { SessionNotFoundError, type SessionCoordinator } from '../services/session-coordinator'
import type { AppInfoService } from '../services/app-info-service'
import type { ExternalAppService } from '../services/external-app-service'
import type { TerminalService } from '../services/terminal-service'
import type { UpdaterService } from '../services/updater-service'
import { registerIpc } from './register-ipc'

type Listener = (event: unknown, payload?: unknown) => unknown

class FakeIpcMain {
  readonly handlers = new Map<string, Listener>()
  readonly listeners = new Map<string, Set<Listener>>()

  constructor(private readonly defaultSender: unknown) {}

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  on(channel: string, listener: Listener): this {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set())
    this.listeners.get(channel)!.add(listener)
    return this
  }

  removeListener(channel: string, listener: Listener): this {
    this.listeners.get(channel)?.delete(listener)
    return this
  }

  invoke(channel: string, payload?: unknown): unknown {
    return this.invokeFrom(this.defaultSender, channel, payload)
  }

  invokeFrom(sender: unknown, channel: string, payload?: unknown): unknown {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for channel: ${channel}`)
    return handler({ sender }, payload)
  }

  emit(channel: string, payload?: unknown): void {
    this.emitFrom(this.defaultSender, channel, payload)
  }

  emitFrom(sender: unknown, channel: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener({ sender }, payload)
  }
}

const fakeWindow = (destroyed = false) => ({
  webContents: {
    send: vi.fn(),
    isDestroyed: vi.fn(() => destroyed)
  }
})

const fakeDialog = (result: { canceled: boolean; filePaths: string[] }) => ({
  showOpenDialog: vi.fn(async () => result)
})

class FakeCoordinator {
  readonly create = vi.fn()
  readonly restore = vi.fn()
  readonly delete = vi.fn()
  readonly submitFirstInput = vi.fn()
  private readonly stateListeners = new Set<(state: AppState) => void>()

  onStateChanged(listener: (state: AppState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  emitState(state: AppState): void {
    for (const listener of [...this.stateListeners]) listener(state)
  }

  listenerCount(): number {
    return this.stateListeners.size
  }
}

class FakeTerminalService {
  readonly write = vi.fn()
  readonly resize = vi.fn()
  private readonly listeners = {
    data: new Set<(payload: { sessionId: string; data: string }) => void>(),
    exit: new Set<(payload: { sessionId: string; exitCode: number }) => void>()
  }

  on(event: 'data' | 'exit', listener: (payload: never) => void): () => void {
    const set = this.listeners[event] as Set<(payload: never) => void>
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  emitData(payload: { sessionId: string; data: string }): void {
    for (const listener of [...this.listeners.data]) listener(payload)
  }

  emitExit(payload: { sessionId: string; exitCode: number }): void {
    for (const listener of [...this.listeners.exit]) listener(payload)
  }

  listenerCounts(): { data: number; exit: number } {
    return { data: this.listeners.data.size, exit: this.listeners.exit.size }
  }
}

class FakeUpdaterService {
  readonly download = vi.fn(async (): Promise<UpdateDownloadResult> => ({ status: 'cancelled' }))
  readonly cancel = vi.fn(async () => undefined)
  readonly install = vi.fn(async (): Promise<UpdateInstallResult> => ({ status: 'launched' }))
  private readonly listeners = new Set<(progress: UpdateDownloadProgress) => void>()

  onProgress(listener: (progress: UpdateDownloadProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emitProgress(progress: UpdateDownloadProgress): void {
    for (const listener of [...this.listeners]) listener(progress)
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

const emptyState = (): AppState => ({ version: 1, projects: [], sessions: [] })

const capabilities = (): AppSnapshot['capabilities'] => ({
  claude: { available: true, detail: 'C:\\claude.exe' },
  codex: { available: false, detail: 'Install Codex CLI (codex) and sign in.' },
  vscode: { available: true, detail: 'C:\\Code.exe' }
})

const project: ProjectRecord = {
  id: 'project-1',
  name: 'App',
  path: 'C:\\Projects\\App',
  createdAt: '2026-08-26T00:00:00.000Z'
}

const session: SessionRecord = {
  id: 'session-1',
  projectId: 'project-1',
  kind: 'powershell',
  title: 'New PowerShell session',
  titleState: 'pending',
  createdAt: '2026-08-26T00:00:00.000Z',
  mode: 'ordinary',
  launchPath: 'C:\\Projects\\App',
  status: 'running'
} as SessionRecord

type Harness = {
  ipcMain: FakeIpcMain
  window: ReturnType<typeof fakeWindow>
  dialog: ReturnType<typeof fakeDialog>
  projectService: { register: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; reorder: ReturnType<typeof vi.fn> }
  coordinator: FakeCoordinator
  externalAppService: { openInVSCode: ReturnType<typeof vi.fn>; openInExplorer: ReturnType<typeof vi.fn> }
  appInfoService: {
    info: ReturnType<typeof vi.fn>
    checkForUpdates: ReturnType<typeof vi.fn>
    openLink: ReturnType<typeof vi.fn>
    autoLaunch: ReturnType<typeof vi.fn>
    setAutoLaunch: ReturnType<typeof vi.fn>
  }
  updaterService: FakeUpdaterService
  terminalService: FakeTerminalService
  getSnapshot: ReturnType<typeof vi.fn>
  applyTheme: ReturnType<typeof vi.fn>
  dispose: () => void
}

const appInfo: AppInfo = { version: '0.4.1', links: EXTERNAL_LINKS }

const buildHarness = (options: {
  dialogResult?: { canceled: boolean; filePaths: string[] }
  windowDestroyed?: boolean
} = {}): Harness => {
  const window = fakeWindow(options.windowDestroyed ?? false)
  const ipcMain = new FakeIpcMain(window.webContents)
  const dialog = fakeDialog(options.dialogResult ?? { canceled: true, filePaths: [] })
  const projectService = { register: vi.fn(async () => project), get: vi.fn(async () => project), reorder: vi.fn(async () => [project]) }
  const coordinator = new FakeCoordinator()
  const externalAppService = { openInVSCode: vi.fn(async () => undefined), openInExplorer: vi.fn(async () => undefined) }
  const appInfoService = {
    info: vi.fn((): AppInfo => appInfo),
    checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult> => ({ status: 'none', currentVersion: appInfo.version })),
    openLink: vi.fn(async () => undefined),
    autoLaunch: vi.fn(() => false),
    setAutoLaunch: vi.fn((enabled: boolean) => enabled)
  }
  const updaterService = new FakeUpdaterService()
  const terminalService = new FakeTerminalService()
  const getSnapshot = vi.fn(async (): Promise<AppSnapshot> => ({ state: emptyState(), capabilities: capabilities() }))
  const applyTheme = vi.fn()

  const dispose = registerIpc({
    ipcMain: ipcMain as unknown as Electron.IpcMain,
    dialog: dialog as unknown as Electron.Dialog,
    window: window as unknown as Electron.BrowserWindow,
    projectService: projectService as unknown as ProjectService,
    coordinator: coordinator as unknown as SessionCoordinator,
    externalAppService: externalAppService as unknown as ExternalAppService,
    appInfoService: appInfoService as unknown as AppInfoService,
    updaterService: updaterService as unknown as UpdaterService,
    terminalService: terminalService as unknown as TerminalService,
    getSnapshot,
    applyTheme
  })

  return {
    ipcMain,
    window,
    dialog,
    projectService,
    coordinator,
    externalAppService,
    appInfoService,
    updaterService,
    terminalService,
    getSnapshot,
    applyTheme,
    dispose
  }
}

describe('registerIpc: sender ownership', () => {
  it('rejects invoke requests from webContents other than the owning window', async () => {
    const { ipcMain, getSnapshot } = buildHarness()

    await expect(ipcMain.invokeFrom({}, IPC.snapshotGet)).rejects.toThrow(/unauthorized ipc sender/i)
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it('drops send-only terminal events from webContents other than the owning window', () => {
    const { ipcMain, terminalService } = buildHarness()

    ipcMain.emitFrom({}, IPC.terminalWrite, { sessionId: 'session-1', data: 'whoami\r' })
    ipcMain.emitFrom({}, IPC.terminalResize, { sessionId: 'session-1', cols: 100, rows: 40 })

    expect(terminalService.write).not.toHaveBeenCalled()
    expect(terminalService.resize).not.toHaveBeenCalled()
  })
})

describe('registerIpc: snapshot:get', () => {
  it('resolves with the composed AppSnapshot', async () => {
    const { ipcMain, getSnapshot } = buildHarness()
    const snapshot: AppSnapshot = { state: emptyState(), capabilities: capabilities() }
    getSnapshot.mockResolvedValue(snapshot)

    await expect(ipcMain.invoke(IPC.snapshotGet)).resolves.toEqual(snapshot)
  })
})

describe('registerIpc: project:add', () => {
  it('returns null and does not call ProjectService.register when the dialog is cancelled', async () => {
    const { ipcMain, projectService } = buildHarness({ dialogResult: { canceled: true, filePaths: [] } })

    await expect(ipcMain.invoke(IPC.projectAdd)).resolves.toBeNull()
    expect(projectService.register).not.toHaveBeenCalled()
  })

  it('returns null when the dialog resolves with no selected paths', async () => {
    const { ipcMain, projectService } = buildHarness({ dialogResult: { canceled: false, filePaths: [] } })

    await expect(ipcMain.invoke(IPC.projectAdd)).resolves.toBeNull()
    expect(projectService.register).not.toHaveBeenCalled()
  })

  it('registers the selected directory and returns the resulting ProjectRecord', async () => {
    const { ipcMain, dialog, projectService } = buildHarness({
      dialogResult: { canceled: false, filePaths: ['C:\\Projects\\App'] }
    })

    await expect(ipcMain.invoke(IPC.projectAdd)).resolves.toEqual(project)
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory'] })
    expect(projectService.register).toHaveBeenCalledWith('C:\\Projects\\App')
  })
})

describe('registerIpc: project:reorder', () => {
  it('parses the ordered id list and returns the reordered projects', async () => {
    const { ipcMain, projectService } = buildHarness()
    const reordered = [{ ...project, id: 'project-2' }, project]
    projectService.reorder.mockResolvedValue(reordered)

    await expect(ipcMain.invoke(IPC.projectReorder, { orderedProjectIds: ['project-2', 'project-1'] })).resolves.toEqual(reordered)
    expect(projectService.reorder).toHaveBeenCalledWith(['project-2', 'project-1'])
  })

  it.each([[{}], [{ orderedProjectIds: [] }], [{ orderedProjectIds: ['p1', 1] }]])(
    'rejects malformed payload %j with a ZodError before touching the service',
    async (payload) => {
      const { ipcMain, projectService } = buildHarness()

      await expect(ipcMain.invoke(IPC.projectReorder, payload)).rejects.toBeInstanceOf(z.ZodError)
      expect(projectService.reorder).not.toHaveBeenCalled()
    }
  )
})

describe('registerIpc: project:open-vscode', () => {
  it('parses the request, resolves the project, and opens it in VS Code', async () => {
    const { ipcMain, projectService, externalAppService } = buildHarness()

    await ipcMain.invoke(IPC.projectOpenVSCode, { projectId: 'project-1' })

    expect(projectService.get).toHaveBeenCalledWith('project-1')
    expect(externalAppService.openInVSCode).toHaveBeenCalledWith(project)
  })

  it('rejects an invalid request without calling ProjectService or ExternalAppService', async () => {
    const { ipcMain, projectService, externalAppService } = buildHarness()

    await expect(ipcMain.invoke(IPC.projectOpenVSCode, {})).rejects.toBeInstanceOf(z.ZodError)
    await expect(ipcMain.invoke(IPC.projectOpenVSCode, { projectId: 'p1', extra: true })).rejects.toBeInstanceOf(z.ZodError)
    expect(projectService.get).not.toHaveBeenCalled()
    expect(externalAppService.openInVSCode).not.toHaveBeenCalled()
  })

  it('propagates the typed ProjectNotFoundError from the service instead of resolving it at the IPC layer', async () => {
    const { ipcMain, projectService, externalAppService } = buildHarness()
    projectService.get.mockRejectedValue(new ProjectNotFoundError('missing-id'))

    await expect(ipcMain.invoke(IPC.projectOpenVSCode, { projectId: 'missing-id' })).rejects.toBeInstanceOf(ProjectNotFoundError)
    expect(externalAppService.openInVSCode).not.toHaveBeenCalled()
  })
})

describe('registerIpc: project:open-folder', () => {
  it('parses the request, resolves the project, and opens it in Explorer', async () => {
    const { ipcMain, projectService, externalAppService } = buildHarness()

    await ipcMain.invoke(IPC.projectOpenFolder, { projectId: 'project-1' })

    expect(projectService.get).toHaveBeenCalledWith('project-1')
    expect(externalAppService.openInExplorer).toHaveBeenCalledWith(project)
  })

  it('rejects an invalid request without calling ProjectService or ExternalAppService', async () => {
    const { ipcMain, projectService, externalAppService } = buildHarness()

    await expect(ipcMain.invoke(IPC.projectOpenFolder, { projectId: 42 })).rejects.toBeInstanceOf(z.ZodError)
    expect(projectService.get).not.toHaveBeenCalled()
    expect(externalAppService.openInExplorer).not.toHaveBeenCalled()
  })
})

describe('registerIpc: session:create', () => {
  it('parses the request and delegates to SessionCoordinator.create', async () => {
    const { ipcMain, coordinator } = buildHarness()
    coordinator.create.mockResolvedValue(session)

    await expect(ipcMain.invoke(IPC.sessionCreate, { projectId: 'project-1', kind: 'claude', worktree: true })).resolves.toEqual(session)
    expect(coordinator.create).toHaveBeenCalledWith('project-1', 'claude', { worktree: true })
  })

  it('defaults a request with no worktree flag to the project directory', async () => {
    const { ipcMain, coordinator } = buildHarness()
    coordinator.create.mockResolvedValue(session)

    await expect(ipcMain.invoke(IPC.sessionCreate, { projectId: 'project-1', kind: 'claude' })).resolves.toEqual(session)
    expect(coordinator.create).toHaveBeenCalledWith('project-1', 'claude', { worktree: false })
  })

  it('rejects an invalid session kind without calling the coordinator', async () => {
    const { ipcMain, coordinator } = buildHarness()

    await expect(ipcMain.invoke(IPC.sessionCreate, { projectId: 'project-1', kind: 'bash' })).rejects.toBeInstanceOf(z.ZodError)
    expect(coordinator.create).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean worktree flag without calling the coordinator', async () => {
    const { ipcMain, coordinator } = buildHarness()

    await expect(
      ipcMain.invoke(IPC.sessionCreate, { projectId: 'project-1', kind: 'claude', worktree: 'yes' })
    ).rejects.toBeInstanceOf(z.ZodError)
    expect(coordinator.create).not.toHaveBeenCalled()
  })
})

describe('registerIpc: session:restore', () => {
  it('parses the request and delegates to SessionCoordinator.restore', async () => {
    const { ipcMain, coordinator } = buildHarness()
    coordinator.restore.mockResolvedValue(session)

    await expect(ipcMain.invoke(IPC.sessionRestore, { sessionId: 'session-1' })).resolves.toEqual(session)
    expect(coordinator.restore).toHaveBeenCalledWith('session-1')
  })

  it('rejects an invalid request without calling the coordinator', async () => {
    const { ipcMain, coordinator } = buildHarness()

    await expect(ipcMain.invoke(IPC.sessionRestore, {})).rejects.toBeInstanceOf(z.ZodError)
    expect(coordinator.restore).not.toHaveBeenCalled()
  })

  it('lets a SessionNotFoundError, or a PTY-start rejection, propagate to the renderer unchanged', async () => {
    const { ipcMain, coordinator } = buildHarness()
    coordinator.restore.mockRejectedValue(new SessionNotFoundError('missing-id'))

    await expect(ipcMain.invoke(IPC.sessionRestore, { sessionId: 'missing-id' })).rejects.toBeInstanceOf(SessionNotFoundError)
  })
})

describe('registerIpc: session:delete', () => {
  it('parses the request and returns the DeleteSessionResult from the coordinator verbatim', async () => {
    const { ipcMain, coordinator } = buildHarness()
    const result: DeleteSessionResult = { status: 'dirty', changedFiles: 2 }
    coordinator.delete.mockResolvedValue(result)

    await expect(ipcMain.invoke(IPC.sessionDelete, { sessionId: 'session-1' })).resolves.toEqual(result)
    expect(coordinator.delete).toHaveBeenCalledWith('session-1')
  })
})

describe('registerIpc: session:first-input', () => {
  it('parses the request and delegates to SessionCoordinator.submitFirstInput', async () => {
    const { ipcMain, coordinator } = buildHarness()

    await ipcMain.invoke(IPC.sessionFirstInput, { sessionId: 'session-1', text: 'fix the bug' })

    expect(coordinator.submitFirstInput).toHaveBeenCalledWith('session-1', 'fix the bug')
  })

  it('rejects empty text without calling the coordinator', async () => {
    const { ipcMain, coordinator } = buildHarness()

    await expect(ipcMain.invoke(IPC.sessionFirstInput, { sessionId: 'session-1', text: '' })).rejects.toBeInstanceOf(z.ZodError)
    expect(coordinator.submitFirstInput).not.toHaveBeenCalled()
  })
})

describe('registerIpc: theme:set', () => {
  it('parses the request and delegates to applyTheme', async () => {
    const { ipcMain, applyTheme } = buildHarness()

    await ipcMain.invoke(IPC.themeSet, { theme: 'light' })
    expect(applyTheme).toHaveBeenCalledWith('light')

    await ipcMain.invoke(IPC.themeSet, { theme: 'dark' })
    expect(applyTheme).toHaveBeenLastCalledWith('dark')
  })

  it.each([[{}], [{ theme: 'blue' }], [{ theme: 'light', extra: true }]])(
    'rejects malformed payload %j without calling applyTheme',
    async (payload) => {
      const { ipcMain, applyTheme } = buildHarness()

      await expect(ipcMain.invoke(IPC.themeSet, payload)).rejects.toBeInstanceOf(z.ZodError)
      expect(applyTheme).not.toHaveBeenCalled()
    }
  )
})

describe('registerIpc: app:info', () => {
  it('returns the AppInfo composed by AppInfoService', async () => {
    const { ipcMain, appInfoService } = buildHarness()

    await expect(ipcMain.invoke(IPC.appInfoGet)).resolves.toEqual(appInfo)
    expect(appInfoService.info).toHaveBeenCalledTimes(1)
  })
})

describe('registerIpc: app:update-check', () => {
  it('returns the UpdateCheckResult from the service verbatim', async () => {
    const { ipcMain, appInfoService } = buildHarness()
    const result: UpdateCheckResult = {
      status: 'available',
      currentVersion: '0.4.1',
      latestVersion: '0.5.0',
      releaseUrl: 'https://github.com/denggaopan/codefly/releases/tag/v0.5.0'
    }
    appInfoService.checkForUpdates.mockResolvedValue(result)

    await expect(ipcMain.invoke(IPC.appUpdateCheck)).resolves.toEqual(result)
  })
})

describe('registerIpc: app:update-download / app:update-cancel / app:update-install', () => {
  it('starts a download with no renderer-supplied payload and returns the result verbatim', async () => {
    const { ipcMain, updaterService } = buildHarness()
    const result: UpdateDownloadResult = { status: 'ready', version: '0.5.0', fileName: 'CodeFly-Setup-0.5.0-win-x64.exe' }
    updaterService.download.mockResolvedValue(result)

    await expect(ipcMain.invoke(IPC.appUpdateDownload)).resolves.toEqual(result)
    expect(updaterService.download).toHaveBeenCalledWith()
  })

  it('ignores anything the renderer sends alongside the command, so it can never name a URL', async () => {
    const { ipcMain, updaterService } = buildHarness()

    await ipcMain.invoke(IPC.appUpdateDownload, { url: 'https://evil.invalid/payload.exe' })

    expect(updaterService.download).toHaveBeenCalledWith()
  })

  it('cancels the running download', async () => {
    const { ipcMain, updaterService } = buildHarness()

    await expect(ipcMain.invoke(IPC.appUpdateCancel)).resolves.toBeUndefined()
    expect(updaterService.cancel).toHaveBeenCalledTimes(1)
  })

  it('returns the install result verbatim', async () => {
    const { ipcMain, updaterService } = buildHarness()
    const result: UpdateInstallResult = { status: 'error', message: 'Could not start the installer: EACCES' }
    updaterService.install.mockResolvedValue(result)

    await expect(ipcMain.invoke(IPC.appUpdateInstall)).resolves.toEqual(result)
  })

  it.each([IPC.appUpdateDownload, IPC.appUpdateCancel, IPC.appUpdateInstall])(
    'rejects %s from webContents other than the owning window',
    async (channel) => {
      const { ipcMain, updaterService } = buildHarness()

      await expect(ipcMain.invokeFrom({}, channel)).rejects.toThrow(/unauthorized ipc sender/i)
      expect(updaterService.download).not.toHaveBeenCalled()
      expect(updaterService.cancel).not.toHaveBeenCalled()
      expect(updaterService.install).not.toHaveBeenCalled()
    }
  )
})

describe('registerIpc: app:open-link', () => {
  it('parses the target and delegates to AppInfoService.openLink', async () => {
    const { ipcMain, appInfoService } = buildHarness()

    await ipcMain.invoke(IPC.appOpenLink, { target: 'changelog' })

    expect(appInfoService.openLink).toHaveBeenCalledWith('changelog')
  })

  it.each([[{}], [{ target: 'https://evil.invalid' }], [{ target: 'repository', extra: true }], [{ url: 'repository' }]])(
    'rejects malformed payload %j without touching the service',
    async (payload) => {
      const { ipcMain, appInfoService } = buildHarness()

      await expect(ipcMain.invoke(IPC.appOpenLink, payload)).rejects.toBeInstanceOf(z.ZodError)
      expect(appInfoService.openLink).not.toHaveBeenCalled()
    }
  )
})

describe('registerIpc: app:auto-launch-get', () => {
  it('returns the current openAtLogin value', async () => {
    const { ipcMain, appInfoService } = buildHarness()
    appInfoService.autoLaunch.mockReturnValue(true)

    await expect(ipcMain.invoke(IPC.appAutoLaunchGet)).resolves.toBe(true)
  })
})

describe('registerIpc: app:auto-launch-set', () => {
  it('parses the request and returns the value the service read back after writing', async () => {
    const { ipcMain, appInfoService } = buildHarness()
    appInfoService.setAutoLaunch.mockReturnValue(false)

    await expect(ipcMain.invoke(IPC.appAutoLaunchSet, { enabled: true })).resolves.toBe(false)
    expect(appInfoService.setAutoLaunch).toHaveBeenCalledWith(true)
  })

  it.each([[{}], [{ enabled: 'true' }], [{ enabled: true, extra: 1 }]])(
    'rejects malformed payload %j without touching the service',
    async (payload) => {
      const { ipcMain, appInfoService } = buildHarness()

      await expect(ipcMain.invoke(IPC.appAutoLaunchSet, payload)).rejects.toBeInstanceOf(z.ZodError)
      expect(appInfoService.setAutoLaunch).not.toHaveBeenCalled()
    }
  )

  it('propagates a write failure so the renderer can show why the toggle did not stick', async () => {
    const { ipcMain, appInfoService } = buildHarness()
    appInfoService.setAutoLaunch.mockImplementation(() => {
      throw new Error('Access is denied.')
    })

    await expect(ipcMain.invoke(IPC.appAutoLaunchSet, { enabled: true })).rejects.toThrow('Access is denied.')
  })
})

describe('registerIpc: terminal:write (send-only)', () => {
  it('parses the payload and forwards it to TerminalService.write', () => {
    const { ipcMain, terminalService } = buildHarness()

    ipcMain.emit(IPC.terminalWrite, { sessionId: 'session-1', data: 'ls\r' })

    expect(terminalService.write).toHaveBeenCalledWith('session-1', 'ls\r')
  })

  it('silently drops an invalid payload without calling TerminalService.write', () => {
    const { ipcMain, terminalService } = buildHarness()

    expect(() => ipcMain.emit(IPC.terminalWrite, { sessionId: 'session-1' })).not.toThrow()
    expect(() => ipcMain.emit(IPC.terminalWrite, { sessionId: '', data: 'x' })).not.toThrow()

    expect(terminalService.write).not.toHaveBeenCalled()
  })

  it('does not let a TerminalService.write failure escape the listener', () => {
    const { ipcMain, terminalService } = buildHarness()
    terminalService.write.mockImplementation(() => {
      throw new Error('Terminal session is not running: session-1')
    })

    expect(() => ipcMain.emit(IPC.terminalWrite, { sessionId: 'session-1', data: 'x' })).not.toThrow()
  })
})

describe('registerIpc: terminal:resize (send-only)', () => {
  it('parses the payload and forwards it to TerminalService.resize', () => {
    const { ipcMain, terminalService } = buildHarness()

    ipcMain.emit(IPC.terminalResize, { sessionId: 'session-1', cols: 100, rows: 40 })

    expect(terminalService.resize).toHaveBeenCalledWith('session-1', 100, 40)
  })

  it('silently drops a payload with out-of-range dimensions', () => {
    const { ipcMain, terminalService } = buildHarness()

    expect(() => ipcMain.emit(IPC.terminalResize, { sessionId: 'session-1', cols: 0, rows: 40 })).not.toThrow()
    expect(() => ipcMain.emit(IPC.terminalResize, { sessionId: 'session-1', cols: 100, rows: 1001 })).not.toThrow()

    expect(terminalService.resize).not.toHaveBeenCalled()
  })

  it('does not let a TerminalService.resize failure escape the listener', () => {
    const { ipcMain, terminalService } = buildHarness()
    terminalService.resize.mockImplementation(() => {
      throw new Error('Terminal session is not running: session-1')
    })

    expect(() => ipcMain.emit(IPC.terminalResize, { sessionId: 'session-1', cols: 100, rows: 40 })).not.toThrow()
  })
})

describe('registerIpc: event publication', () => {
  it('publishes stateChanged to the window webContents when it is not destroyed', () => {
    const { window, coordinator } = buildHarness({ windowDestroyed: false })
    const state = emptyState()

    coordinator.emitState(state)

    expect(window.webContents.send).toHaveBeenCalledWith(IPC.stateChanged, state)
  })

  it('does not publish stateChanged when the window webContents is destroyed', () => {
    const { window, coordinator } = buildHarness({ windowDestroyed: true })

    coordinator.emitState(emptyState())

    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('publishes terminal data only to a non-destroyed window', () => {
    const { window, terminalService } = buildHarness({ windowDestroyed: false })
    const payload = { sessionId: 'session-1', data: 'output' }

    terminalService.emitData(payload)

    expect(window.webContents.send).toHaveBeenCalledWith(IPC.terminalData, payload)
  })

  it('does not publish terminal data when the window webContents is destroyed', () => {
    const { window, terminalService } = buildHarness({ windowDestroyed: true })

    terminalService.emitData({ sessionId: 'session-1', data: 'output' })

    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('publishes terminal exit only to a non-destroyed window', () => {
    const { window, terminalService } = buildHarness({ windowDestroyed: false })
    const payload = { sessionId: 'session-1', exitCode: 0 }

    terminalService.emitExit(payload)

    expect(window.webContents.send).toHaveBeenCalledWith(IPC.terminalExit, payload)
  })

  it('does not publish terminal exit when the window webContents is destroyed', () => {
    const { window, terminalService } = buildHarness({ windowDestroyed: true })

    terminalService.emitExit({ sessionId: 'session-1', exitCode: 1 })

    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('publishes download progress only to a non-destroyed window', () => {
    const { window, updaterService } = buildHarness({ windowDestroyed: false })
    const progress: UpdateDownloadProgress = { version: '0.5.0', receivedBytes: 512, totalBytes: 2048 }

    updaterService.emitProgress(progress)

    expect(window.webContents.send).toHaveBeenCalledWith(IPC.appUpdateProgress, progress)
  })

  it('does not publish download progress when the window webContents is destroyed', () => {
    const { window, updaterService } = buildHarness({ windowDestroyed: true })

    updaterService.emitProgress({ version: '0.5.0', receivedBytes: 512, totalBytes: 2048 })

    expect(window.webContents.send).not.toHaveBeenCalled()
  })
})

describe('registerIpc: disposer', () => {
  it('removes every registered invoke handler', async () => {
    const { ipcMain, dispose } = buildHarness()

    dispose()

    for (const channel of [
      IPC.snapshotGet,
      IPC.projectAdd,
      IPC.projectReorder,
      IPC.projectOpenVSCode,
      IPC.projectOpenFolder,
      IPC.sessionCreate,
      IPC.sessionRestore,
      IPC.sessionDelete,
      IPC.sessionFirstInput,
      IPC.themeSet,
      IPC.appInfoGet,
      IPC.appUpdateCheck,
      IPC.appUpdateDownload,
      IPC.appUpdateCancel,
      IPC.appUpdateInstall,
      IPC.appOpenLink,
      IPC.appAutoLaunchGet,
      IPC.appAutoLaunchSet
    ]) {
      expect(ipcMain.handlers.has(channel)).toBe(false)
    }
  })

  it('removes every registered send-only listener', () => {
    const { ipcMain, dispose } = buildHarness()

    dispose()

    expect(ipcMain.listeners.get(IPC.terminalWrite)?.size ?? 0).toBe(0)
    expect(ipcMain.listeners.get(IPC.terminalResize)?.size ?? 0).toBe(0)
  })

  it('unsubscribes from coordinator state changes, terminal events, and download progress so nothing is published afterwards', () => {
    const { window, coordinator, terminalService, updaterService, dispose } = buildHarness({ windowDestroyed: false })

    dispose()
    coordinator.emitState(emptyState())
    terminalService.emitData({ sessionId: 'session-1', data: 'output' })
    terminalService.emitExit({ sessionId: 'session-1', exitCode: 0 })
    updaterService.emitProgress({ version: '0.5.0', receivedBytes: 1, totalBytes: 2 })

    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(coordinator.listenerCount()).toBe(0)
    expect(terminalService.listenerCounts()).toEqual({ data: 0, exit: 0 })
    expect(updaterService.listenerCount()).toBe(0)
  })
})
