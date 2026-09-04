import type { BrowserWindow, Dialog, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

import type {
  AppInfo,
  AppSnapshot,
  DeleteSessionResult,
  ProjectRecord,
  SessionRecord,
  ThemePreference,
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateInstallResult
} from '../../shared/contracts'
import {
  createSessionRequestSchema,
  firstInputRequestSchema,
  openExternalLinkRequestSchema,
  projectIdRequestSchema,
  reorderProjectsRequestSchema,
  sessionIdRequestSchema,
  setAutoLaunchRequestSchema,
  setThemeRequestSchema,
  setWindowPinnedRequestSchema,
  terminalResizeRequestSchema,
  terminalWriteRequestSchema
} from '../../shared/contracts'
import { IPC } from '../../shared/ipc'
import type { AppInfoService } from '../services/app-info-service'
import type { ExternalAppService } from '../services/external-app-service'
import type { ProjectService } from '../services/project-service'
import type { SessionCoordinator } from '../services/session-coordinator'
import type { TerminalService } from '../services/terminal-service'
import type { UpdaterService } from '../services/updater-service'

export type RegisterIpcDependencies = {
  ipcMain: IpcMain
  dialog: Dialog
  window: BrowserWindow
  projectService: ProjectService
  coordinator: SessionCoordinator
  externalAppService: ExternalAppService
  appInfoService: AppInfoService
  updaterService: UpdaterService
  terminalService: TerminalService
  getSnapshot: () => Promise<AppSnapshot>
  applyTheme: (theme: ThemePreference) => void
  /** Returns the flag the window actually ended up with, which the renderer renders. */
  applyPinned: (pinned: boolean) => boolean
}

type InvokeHandler = (event: IpcMainInvokeEvent, payload?: unknown) => unknown

const publish = (window: BrowserWindow, channel: string, payload: unknown): void => {
  if (window.webContents.isDestroyed()) return
  window.webContents.send(channel, payload)
}

/**
 * Registers every main-process IPC handler and event publisher for the CodeFly desktop
 * app. Every command parses its renderer-supplied request with the matching Zod schema
 * from shared/contracts.ts before touching a service; unknown project/session ids are
 * left for the services to reject with their own typed errors (SessionNotFoundError,
 * ProjectNotFoundError, ...) rather than being pre-checked here. Returns a single
 * disposer that removes every handler/listener registered by this call.
 */
export function registerIpc(deps: RegisterIpcDependencies): () => void {
  const {
    ipcMain,
    dialog,
    window,
    projectService,
    coordinator,
    externalAppService,
    appInfoService,
    updaterService,
    terminalService,
    getSnapshot,
    applyTheme,
    applyPinned
  } = deps

  const invokeHandlers: ReadonlyArray<readonly [string, InvokeHandler]> = [
    [IPC.snapshotGet, async (): Promise<AppSnapshot> => getSnapshot()],

    [
      IPC.projectAdd,
      async (): Promise<ProjectRecord | null> => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        const selectedPath = result.filePaths[0]
        if (result.canceled || !selectedPath) return null
        return projectService.register(selectedPath)
      }
    ],

    [
      IPC.projectReorder,
      async (_event, payload): Promise<ProjectRecord[]> => {
        const { orderedProjectIds } = reorderProjectsRequestSchema.parse(payload)
        return projectService.reorder(orderedProjectIds)
      }
    ],

    [
      IPC.projectOpenVSCode,
      async (_event, payload): Promise<void> => {
        const { projectId } = projectIdRequestSchema.parse(payload)
        const project = await projectService.get(projectId)
        await externalAppService.openInVSCode(project)
      }
    ],

    [
      IPC.projectOpenFolder,
      async (_event, payload): Promise<void> => {
        const { projectId } = projectIdRequestSchema.parse(payload)
        const project = await projectService.get(projectId)
        await externalAppService.openInExplorer(project)
      }
    ],

    [
      IPC.projectOpenRepository,
      async (_event, payload): Promise<void> => {
        const { projectId } = projectIdRequestSchema.parse(payload)
        const project = await projectService.get(projectId)
        await externalAppService.openRepository(project)
      }
    ],

    [
      IPC.projectRemove,
      async (_event, payload): Promise<void> => {
        const { projectId } = projectIdRequestSchema.parse(payload)
        await coordinator.removeProject(projectId)
      }
    ],

    [
      IPC.sessionCreate,
      async (_event, payload): Promise<SessionRecord> => {
        const { projectId, kind, worktree } = createSessionRequestSchema.parse(payload)
        return coordinator.create(projectId, kind, { worktree })
      }
    ],

    [
      IPC.sessionRestore,
      async (_event, payload): Promise<SessionRecord> => {
        const { sessionId } = sessionIdRequestSchema.parse(payload)
        return coordinator.restore(sessionId)
      }
    ],

    [
      IPC.sessionDelete,
      async (_event, payload): Promise<DeleteSessionResult> => {
        const { sessionId } = sessionIdRequestSchema.parse(payload)
        return coordinator.delete(sessionId)
      }
    ],

    [
      IPC.sessionFirstInput,
      async (_event, payload): Promise<void> => {
        const { sessionId, text } = firstInputRequestSchema.parse(payload)
        await coordinator.submitFirstInput(sessionId, text)
      }
    ],

    [
      IPC.themeSet,
      async (_event, payload): Promise<void> => {
        const { theme } = setThemeRequestSchema.parse(payload)
        applyTheme(theme)
      }
    ],

    [
      IPC.windowPinnedSet,
      async (_event, payload): Promise<boolean> => {
        const { pinned } = setWindowPinnedRequestSchema.parse(payload)
        return applyPinned(pinned)
      }
    ],

    [IPC.appInfoGet, async (): Promise<AppInfo> => appInfoService.info()],

    [IPC.appUpdateCheck, async (): Promise<UpdateCheckResult> => appInfoService.checkForUpdates()],

    // The three update commands carry no payload on purpose: UpdaterService resolves the
    // release asset itself, so the renderer can never name the file that gets downloaded
    // and executed. There is nothing to parse, but the sender check below still applies.
    [IPC.appUpdateDownload, async (): Promise<UpdateDownloadResult> => updaterService.download()],

    [IPC.appUpdateCancel, async (): Promise<void> => updaterService.cancel()],

    [IPC.appUpdateInstall, async (): Promise<UpdateInstallResult> => updaterService.install()],

    [
      IPC.appOpenLink,
      async (_event, payload): Promise<void> => {
        const { target } = openExternalLinkRequestSchema.parse(payload)
        await appInfoService.openLink(target)
      }
    ],

    [IPC.appAutoLaunchGet, async (): Promise<boolean> => appInfoService.autoLaunch()],

    [
      IPC.appAutoLaunchSet,
      async (_event, payload): Promise<boolean> => {
        const { enabled } = setAutoLaunchRequestSchema.parse(payload)
        return appInfoService.setAutoLaunch(enabled)
      }
    ]
  ]

  const assertOwningSender = (event: IpcMainInvokeEvent | IpcMainEvent): void => {
    if (event.sender !== window.webContents) throw new Error('Unauthorized IPC sender.')
  }

  for (const [channel, handler] of invokeHandlers) {
    ipcMain.handle(channel, async (event, payload) => {
      assertOwningSender(event)
      return handler(event, payload)
    })
  }

  // terminal:write and terminal:resize are one-way, send-only channels: there is no
  // invoke/reply round trip, so a parse failure or a downstream service error (e.g. the
  // PTY already exited) is logged and dropped rather than thrown back across ipcMain's
  // listener dispatch, which has no rejection path back to the renderer.
  const onTerminalWrite = (event: IpcMainEvent, payload: unknown): void => {
    if (event.sender !== window.webContents) return
    const parsed = terminalWriteRequestSchema.safeParse(payload)
    if (!parsed.success) return
    try {
      terminalService.write(parsed.data.sessionId, parsed.data.data)
    } catch (error) {
      console.error(`registerIpc: terminal:write failed for session ${parsed.data.sessionId}.`, error)
    }
  }

  const onTerminalResize = (event: IpcMainEvent, payload: unknown): void => {
    if (event.sender !== window.webContents) return
    const parsed = terminalResizeRequestSchema.safeParse(payload)
    if (!parsed.success) return
    try {
      terminalService.resize(parsed.data.sessionId, parsed.data.cols, parsed.data.rows)
    } catch (error) {
      console.error(`registerIpc: terminal:resize failed for session ${parsed.data.sessionId}.`, error)
    }
  }

  ipcMain.on(IPC.terminalWrite, onTerminalWrite)
  ipcMain.on(IPC.terminalResize, onTerminalResize)

  const unsubscribeState = coordinator.onStateChanged((state) => {
    publish(window, IPC.stateChanged, state)
  })
  const unsubscribeTerminalData = terminalService.on('data', (payload) => {
    publish(window, IPC.terminalData, payload)
  })
  const unsubscribeTerminalExit = terminalService.on('exit', (payload) => {
    publish(window, IPC.terminalExit, payload)
  })
  const unsubscribeUpdateProgress = updaterService.onProgress((progress) => {
    publish(window, IPC.appUpdateProgress, progress)
  })

  return () => {
    for (const [channel] of invokeHandlers) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.removeListener(IPC.terminalWrite, onTerminalWrite)
    ipcMain.removeListener(IPC.terminalResize, onTerminalResize)
    unsubscribeState()
    unsubscribeTerminalData()
    unsubscribeTerminalExit()
    unsubscribeUpdateProgress()
  }
}
