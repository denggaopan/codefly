import type { BrowserWindow, Dialog, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

import type { AppSnapshot, DeleteSessionResult, ProjectRecord, SessionRecord, ThemePreference } from '../../shared/contracts'
import {
  createSessionRequestSchema,
  firstInputRequestSchema,
  projectIdRequestSchema,
  reorderProjectsRequestSchema,
  sessionIdRequestSchema,
  setThemeRequestSchema,
  terminalResizeRequestSchema,
  terminalWriteRequestSchema
} from '../../shared/contracts'
import { IPC } from '../../shared/ipc'
import type { ExternalAppService } from '../services/external-app-service'
import type { ProjectService } from '../services/project-service'
import type { SessionCoordinator } from '../services/session-coordinator'
import type { TerminalService } from '../services/terminal-service'

export type RegisterIpcDependencies = {
  ipcMain: IpcMain
  dialog: Dialog
  window: BrowserWindow
  projectService: ProjectService
  coordinator: SessionCoordinator
  externalAppService: ExternalAppService
  terminalService: TerminalService
  getSnapshot: () => Promise<AppSnapshot>
  applyTheme: (theme: ThemePreference) => void
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
  const { ipcMain, dialog, window, projectService, coordinator, externalAppService, terminalService, getSnapshot, applyTheme } = deps

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
      IPC.sessionCreate,
      async (_event, payload): Promise<SessionRecord> => {
        const { projectId, kind } = createSessionRequestSchema.parse(payload)
        return coordinator.create(projectId, kind)
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

  return () => {
    for (const [channel] of invokeHandlers) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.removeListener(IPC.terminalWrite, onTerminalWrite)
    ipcMain.removeListener(IPC.terminalResize, onTerminalResize)
    unsubscribeState()
    unsubscribeTerminalData()
    unsubscribeTerminalExit()
  }
}
