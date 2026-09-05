import { contextBridge, ipcRenderer } from 'electron'

import type {
  AppInfo,
  AppSnapshot,
  AppState,
  CloneProjectRequest,
  DeleteSessionResult,
  ProjectRecord,
  SessionKind,
  SessionRecord,
  ThemePreference,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateInstallResult
} from '../shared/contracts'
import { IPC } from '../shared/ipc'
import type { ExternalLinkTarget } from '../shared/links'
import type { TerminalDataEvent, TerminalReplay } from '../shared/pty-protocol'

export type CodeFlyApi = {
  getSnapshot(): Promise<AppSnapshot>
  addProject(): Promise<ProjectRecord | null>
  reopenProject(projectId: string): Promise<ProjectRecord>
  selectCloneDirectory(): Promise<string | null>
  cloneProject(request: CloneProjectRequest): Promise<ProjectRecord>
  reorderProjects(orderedProjectIds: readonly string[]): Promise<ProjectRecord[]>
  openProjectInVSCode(projectId: string): Promise<void>
  openProjectFolder(projectId: string): Promise<void>
  // Only the project id crosses IPC: the main process opens the remote URL it recorded for the
  // project itself, so the renderer can never name the URL that reaches the browser.
  openProjectRepository(projectId: string): Promise<void>
  // Forgets the project and its session records; nothing on disk is touched.
  removeProject(projectId: string): Promise<void>
  createSession(projectId: string, kind: SessionKind, worktree: boolean): Promise<SessionRecord>
  restoreSession(sessionId: string): Promise<SessionRecord>
  deleteSession(sessionId: string): Promise<DeleteSessionResult>
  submitFirstInput(sessionId: string, text: string): Promise<void>
  setTheme(theme: ThemePreference): Promise<void>
  // Resolves with the always-on-top flag the window actually ended up with.
  setWindowPinned(pinned: boolean): Promise<boolean>
  getAppInfo(): Promise<AppInfo>
  checkForUpdates(): Promise<UpdateCheckResult>
  // No parameters by design: the main process re-resolves the release asset itself, so the
  // renderer can never name the URL that gets downloaded and executed.
  downloadUpdate(): Promise<UpdateDownloadResult>
  cancelUpdateDownload(): Promise<void>
  installUpdate(): Promise<UpdateInstallResult>
  openExternalLink(target: ExternalLinkTarget): Promise<void>
  getAutoLaunch(): Promise<boolean>
  setAutoLaunch(enabled: boolean): Promise<boolean>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  // Answers `undefined` — never rejects — for a session the pty-host is not holding, which is
  // every session that is not currently running. A terminal opened for one of those simply
  // starts empty, exactly as it did before the host existed.
  replayTerminal(sessionId: string): Promise<TerminalReplay | undefined>
  onStateChanged(listener: (state: AppState) => void): () => void
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void
  onTerminalExit(listener: (event: { sessionId: string; exitCode: number }) => void): () => void
  onUpdateProgress(listener: (progress: UpdateDownloadProgress) => void): () => void
}

// Every method here is a thin bridge over ipcRenderer: no Node APIs, filesystem paths,
// or business logic are exposed to the renderer. All request validation happens in the
// main process (see src/main/ipc/register-ipc.ts) against the schemas in shared/contracts.ts.
const api: CodeFlyApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshotGet),
  addProject: () => ipcRenderer.invoke(IPC.projectAdd),
  reopenProject: (projectId) => ipcRenderer.invoke(IPC.projectReopen, { projectId }),
  selectCloneDirectory: () => ipcRenderer.invoke(IPC.projectCloneDirectory),
  cloneProject: (request) => ipcRenderer.invoke(IPC.projectClone, request),
  reorderProjects: (orderedProjectIds) => ipcRenderer.invoke(IPC.projectReorder, { orderedProjectIds: [...orderedProjectIds] }),
  openProjectInVSCode: (projectId) => ipcRenderer.invoke(IPC.projectOpenVSCode, { projectId }),
  openProjectFolder: (projectId) => ipcRenderer.invoke(IPC.projectOpenFolder, { projectId }),
  openProjectRepository: (projectId) => ipcRenderer.invoke(IPC.projectOpenRepository, { projectId }),
  removeProject: (projectId) => ipcRenderer.invoke(IPC.projectRemove, { projectId }),
  createSession: (projectId, kind, worktree) => ipcRenderer.invoke(IPC.sessionCreate, { projectId, kind, worktree }),
  restoreSession: (sessionId) => ipcRenderer.invoke(IPC.sessionRestore, { sessionId }),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.sessionDelete, { sessionId }),
  submitFirstInput: (sessionId, text) => ipcRenderer.invoke(IPC.sessionFirstInput, { sessionId, text }),
  setTheme: (theme) => ipcRenderer.invoke(IPC.themeSet, { theme }),
  setWindowPinned: (pinned) => ipcRenderer.invoke(IPC.windowPinnedSet, { pinned }),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfoGet),
  checkForUpdates: () => ipcRenderer.invoke(IPC.appUpdateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IPC.appUpdateDownload),
  cancelUpdateDownload: () => ipcRenderer.invoke(IPC.appUpdateCancel),
  installUpdate: () => ipcRenderer.invoke(IPC.appUpdateInstall),
  openExternalLink: (target) => ipcRenderer.invoke(IPC.appOpenLink, { target }),
  getAutoLaunch: () => ipcRenderer.invoke(IPC.appAutoLaunchGet),
  setAutoLaunch: (enabled) => ipcRenderer.invoke(IPC.appAutoLaunchSet, { enabled }),

  writeTerminal: (sessionId, data) => {
    ipcRenderer.send(IPC.terminalWrite, { sessionId, data })
  },
  resizeTerminal: (sessionId, cols, rows) => {
    ipcRenderer.send(IPC.terminalResize, { sessionId, cols, rows })
  },
  replayTerminal: (sessionId) => ipcRenderer.invoke(IPC.terminalReplay, { sessionId }),

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
  },
  onUpdateProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: UpdateDownloadProgress): void => listener(payload)
    ipcRenderer.on(IPC.appUpdateProgress, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.appUpdateProgress, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('codefly', api)
