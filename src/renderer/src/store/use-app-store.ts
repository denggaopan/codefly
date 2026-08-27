import { create } from 'zustand'

import type { AppState, CapabilityState, DeleteSessionResult, ProjectRecord, SessionKind, SessionRecord } from '../../../shared/contracts'

export type Notice = {
  message: string
  tone: 'error' | 'info'
}

export type AppStore = {
  appState: AppState
  capabilities: CapabilityState
  activeProjectId: string | null
  activeSessionId: string | null
  launcherOpen: boolean
  searchQuery: string
  notice: Notice | null

  initialize: () => () => void
  reset: () => void

  addProject: () => Promise<void>
  openProjectInVSCode: (projectId: string) => Promise<void>
  openProjectFolder: (projectId: string) => Promise<void>

  openLauncher: () => void
  closeLauncher: () => void
  createSession: (projectId: string, kind: SessionKind) => Promise<void>

  setActiveProject: (projectId: string) => void
  setActiveSession: (sessionId: string, projectId?: string) => void
  restoreSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<DeleteSessionResult | undefined>

  setSearchQuery: (query: string) => void
  dismissNotice: () => void
}

const emptyAppState = (): AppState => ({ version: 1, projects: [], sessions: [] })

const defaultCapabilities = (): CapabilityState => ({
  claude: { available: false, detail: 'Checking availability…' },
  codex: { available: false, detail: 'Checking availability…' },
  vscode: { available: false, detail: 'Checking availability…' }
})

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'Something went wrong.')

const upsertProject = (state: AppState, project: ProjectRecord): AppState => {
  const index = state.projects.findIndex((candidate) => candidate.id === project.id)
  const projects = index === -1 ? [...state.projects, project] : state.projects.map((candidate, i) => (i === index ? project : candidate))
  return { ...state, projects }
}

const upsertSession = (state: AppState, session: SessionRecord): AppState => {
  const index = state.sessions.findIndex((candidate) => candidate.id === session.id)
  const sessions = index === -1 ? [...state.sessions, session] : state.sessions.map((candidate, i) => (i === index ? session : candidate))
  return { ...state, sessions }
}

/**
 * Renderer-side application state. Actions call window.codefly and merge the returned
 * record into appState immediately (an optimistic-but-authoritative update, since the
 * record IS what the main process just persisted); onStateChanged additionally replaces
 * appState wholesale whenever the main process broadcasts it, which is the durable source
 * of truth for anything this store did not itself just request. Rejections crossing
 * ipcRenderer.invoke arrive as generic Error instances (Electron strips subclass identity),
 * so every catch here only reads error.message and never branches on error type.
 */
export const useAppStore = create<AppStore>()((set) => ({
  appState: emptyAppState(),
  capabilities: defaultCapabilities(),
  activeProjectId: null,
  activeSessionId: null,
  launcherOpen: false,
  searchQuery: '',
  notice: null,

  initialize: () => {
    window.codefly
      .getSnapshot()
      .then((snapshot) => {
        set((state) => ({
          appState: snapshot.state,
          capabilities: snapshot.capabilities,
          activeProjectId: state.activeProjectId ?? snapshot.state.projects[0]?.id ?? null,
          notice: snapshot.recoveryWarning ? { message: snapshot.recoveryWarning, tone: 'info' } : state.notice
        }))
      })
      .catch((error: unknown) => {
        set({ notice: { message: errorMessage(error), tone: 'error' } })
      })

    return window.codefly.onStateChanged((state) => {
      set({ appState: state })
    })
  },

  reset: () => {
    set({
      appState: emptyAppState(),
      capabilities: defaultCapabilities(),
      activeProjectId: null,
      activeSessionId: null,
      launcherOpen: false,
      searchQuery: '',
      notice: null
    })
  },

  addProject: async () => {
    try {
      const project = await window.codefly.addProject()
      if (!project) return
      set((state) => ({ appState: upsertProject(state.appState, project), activeProjectId: project.id }))
    } catch (error) {
      set({ notice: { message: errorMessage(error), tone: 'error' } })
    }
  },

  openProjectInVSCode: async (projectId) => {
    try {
      await window.codefly.openProjectInVSCode(projectId)
    } catch (error) {
      set({ notice: { message: errorMessage(error), tone: 'error' } })
    }
  },

  openProjectFolder: async (projectId) => {
    try {
      await window.codefly.openProjectFolder(projectId)
    } catch (error) {
      set({ notice: { message: errorMessage(error), tone: 'error' } })
    }
  },

  openLauncher: () => set({ launcherOpen: true }),
  closeLauncher: () => set({ launcherOpen: false }),

  createSession: async (projectId, kind) => {
    try {
      const session = await window.codefly.createSession(projectId, kind)
      set((state) => ({
        appState: upsertSession(state.appState, session),
        activeProjectId: session.projectId,
        activeSessionId: session.id,
        launcherOpen: false
      }))
    } catch (error) {
      set({ notice: { message: errorMessage(error), tone: 'error' } })
    }
  },

  setActiveProject: (projectId) => set({ activeProjectId: projectId }),

  setActiveSession: (sessionId, projectId) =>
    set((state) => ({ activeSessionId: sessionId, activeProjectId: projectId ?? state.activeProjectId })),

  restoreSession: async (sessionId) => {
    try {
      const session = await window.codefly.restoreSession(sessionId)
      set((state) => ({
        appState: upsertSession(state.appState, session),
        activeProjectId: session.projectId,
        activeSessionId: session.id
      }))
    } catch (error) {
      set({ notice: { message: errorMessage(error), tone: 'error' } })
    }
  },

  deleteSession: async (sessionId) => {
    try {
      const result = await window.codefly.deleteSession(sessionId)

      if (result.status === 'deleted') {
        set((state) => ({
          appState: { ...state.appState, sessions: state.appState.sessions.filter((session) => session.id !== sessionId) },
          activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId
        }))
      } else if (result.status === 'dirty') {
        set({
          notice: {
            message: `Worktree has ${result.changedFiles} changed files. Commit or discard them before deleting.`,
            tone: 'error'
          }
        })
      } else {
        set({ notice: { message: result.message, tone: 'error' } })
      }

      return result
    } catch (error) {
      set({ notice: { message: errorMessage(error), tone: 'error' } })
      return undefined
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  dismissNotice: () => set({ notice: null })
}))
