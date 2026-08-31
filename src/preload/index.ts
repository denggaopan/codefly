import { contextBridge, ipcRenderer } from 'electron'

import type { AppSnapshot, AppState, DeleteSessionResult, ProjectRecord, SessionKind, SessionRecord } from '../shared/contracts'
import { IPC } from '../shared/ipc'

export type CodeFlyApi = {
  getSnapshot(): Promise<AppSnapshot>
  addProject(): Promise<ProjectRecord | null>
  reorderProjects(orderedProjectIds: readonly string[]): Promise<ProjectRecord[]>
  openProjectInVSCode(projectId: string): Promise<void>
  openProjectFolder(projectId: string): Promise<void>
  createSession(projectId: string, kind: SessionKind): Promise<SessionRecord>
  restoreSession(sessionId: string): Promise<SessionRecord>
  deleteSession(sessionId: string): Promise<DeleteSessionResult>
  submitFirstInput(sessionId: string, text: string): Promise<void>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  onStateChanged(listener: (state: AppState) => void): () => void
  onTerminalData(listener: (event: { sessionId: string; data: string }) => void): () => void
  onTerminalExit(listener: (event: { sessionId: string; exitCode: number }) => void): () => void
}

// Every method here is a thin bridge over ipcRenderer: no Node APIs, filesystem paths,
// or business logic are exposed to the renderer. All request validation happens in the
// main process (see src/main/ipc/register-ipc.ts) against the schemas in shared/contracts.ts.
const api: CodeFlyApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshotGet),
  addProject: () => ipcRenderer.invoke(IPC.projectAdd),
  reorderProjects: (orderedProjectIds) => ipcRenderer.invoke(IPC.projectReorder, { orderedProjectIds: [...orderedProjectIds] }),
  openProjectInVSCode: (projectId) => ipcRenderer.invoke(IPC.projectOpenVSCode, { projectId }),
  openProjectFolder: (projectId) => ipcRenderer.invoke(IPC.projectOpenFolder, { projectId }),
  createSession: (projectId, kind) => ipcRenderer.invoke(IPC.sessionCreate, { projectId, kind }),
  restoreSession: (sessionId) => ipcRenderer.invoke(IPC.sessionRestore, { sessionId }),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.sessionDelete, { sessionId }),
  submitFirstInput: (sessionId, text) => ipcRenderer.invoke(IPC.sessionFirstInput, { sessionId, text }),

  writeTerminal: (sessionId, data) => {
    ipcRenderer.send(IPC.terminalWrite, { sessionId, data })
  },
  resizeTerminal: (sessionId, cols, rows) => {
    ipcRenderer.send(IPC.terminalResize, { sessionId, cols, rows })
  },

  onStateChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: AppState): void => listener(state)
    ipcRenderer.on(IPC.stateChanged, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.stateChanged, wrapped)
    }
  },
  onTerminalData: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; data: string }): void => listener(payload)
    ipcRenderer.on(IPC.terminalData, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.terminalData, wrapped)
    }
  },
  onTerminalExit: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; exitCode: number }): void => listener(payload)
    ipcRenderer.on(IPC.terminalExit, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.terminalExit, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('codefly', api)
