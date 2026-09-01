import { create } from 'zustand'

import type {
  AppState,
  CapabilityState,
  DeleteSessionResult,
  ProjectRecord,
  SessionKind,
  SessionRecord,
  SessionKindPreference,
  SessionKindPreferences,
  ThemePreference
} from '../../../shared/contracts'
import { DEFAULT_SESSION_KIND_PREFERENCES, storedSessionKindPreferencesSchema } from '../../../shared/contracts'
import { DEFAULT_LOCALE, isLocale, translate, type Locale } from '../i18n'

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
  /** Running Claude/Codex sessions whose PTY output has been quiet for AGENT_IDLE_MS. */
  idleAgentSessionIds: Record<string, true>
  theme: ThemePreference
  locale: Locale
  /** Which kinds the New session launcher lists, and which of them offer a worktree entry. */
  sessionKindPreferences: SessionKindPreferences

  initialize: () => () => void
  reset: () => void

  setTheme: (theme: ThemePreference) => void
  setLocale: (locale: Locale) => void
  setSessionKindPreference: (kind: SessionKind, change: Partial<SessionKindPreference>) => void

  addProject: () => Promise<void>
  reorderProjects: (orderedProjectIds: readonly string[]) => Promise<void>
  openProjectInVSCode: (projectId: string) => Promise<void>
  openProjectFolder: (projectId: string) => Promise<void>

  openLauncher: () => void
  closeLauncher: () => void
  createSession: (projectId: string, kind: SessionKind, worktree: boolean) => Promise<void>

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

const errorMessage = (error: unknown, locale: Locale): string =>
  error instanceof Error ? error.message : translate(locale, 'notice.genericError')

export const THEME_STORAGE_KEY = 'codefly.theme'
export const LOCALE_STORAGE_KEY = 'codefly.locale'
export const SESSION_KINDS_STORAGE_KEY = 'codefly.sessionKinds'

// The theme preference is renderer-owned (localStorage), not part of the main process's
// persisted AppState: it is pure presentation, and localStorage survives restarts without
// widening the state-file schema. Anything unrecognized (including a missing key on first
// launch) falls back to dark, the app's original and default look.
const readStoredTheme = (): ThemePreference => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

// Applies a theme everywhere outside this store's own state: the CSS token switch
// (styles.css keys off html[data-theme]), the persisted preference, and the main process
// (native theme + window caption-button overlay colors, via theme:set).
const applyThemeEffects = (theme: ThemePreference): void => {
  document.documentElement.dataset.theme = theme
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // localStorage unavailable: the preference just won't survive a restart.
  }
  window.codefly.setTheme(theme).catch(() => undefined)
}

// The UI language is renderer-owned (localStorage) for the same reasons as the theme: it is
// pure presentation and never crosses into the persisted AppState. Anything unrecognized —
// including a first launch with no stored key — falls back to DEFAULT_LOCALE (English), which
// keeps startup copy deterministic regardless of the host OS language.
const readStoredLocale = (): Locale => {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return isLocale(stored) ? stored : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

// Applies a locale everywhere outside this store's own state: the persisted preference and
// the document language (which drives font fallback and assistive-technology pronunciation).
const applyLocaleEffects = (locale: Locale): void => {
  document.documentElement.lang = locale
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // localStorage unavailable: the preference just won't survive a restart.
  }
}

// The per-kind launcher preferences are renderer-owned (localStorage) for the same reasons as
// the theme and locale: they configure the launcher menu rather than any persisted session,
// and the actual worktree decision crosses IPC explicitly with every create request. Stored
// values are merged over the defaults field by field, so anything unreadable or partial
// degrades to the documented defaults instead of an empty or half-filled record.
const mergeStoredSessionKinds = (stored: unknown): SessionKindPreferences => {
  const parsed = storedSessionKindPreferencesSchema.safeParse(stored)
  if (!parsed.success) return DEFAULT_SESSION_KIND_PREFERENCES
  const merged = { ...DEFAULT_SESSION_KIND_PREFERENCES }
  for (const kind of Object.keys(merged) as SessionKind[]) {
    merged[kind] = { ...merged[kind], ...parsed.data[kind] }
  }
  return merged
}

const readStoredSessionKindPreferences = (): SessionKindPreferences => {
  try {
    const stored = window.localStorage.getItem(SESSION_KINDS_STORAGE_KEY)
    if (stored === null) return DEFAULT_SESSION_KIND_PREFERENCES
    return mergeStoredSessionKinds(JSON.parse(stored))
  } catch {
    return DEFAULT_SESSION_KIND_PREFERENCES
  }
}

const persistSessionKindPreferences = (preferences: SessionKindPreferences): void => {
  try {
    window.localStorage.setItem(SESSION_KINDS_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // localStorage unavailable: the preference just won't survive a restart.
  }
}

/**
 * How long a running Claude/Codex session's PTY output must stay quiet before the session
 * counts as Done. Agent TUIs repaint continuously (spinners, streamed tokens) while they
 * work, so a quiet PTY is the reliable "finished, waiting for input" signal; 3s is long
 * enough to bridge repaint gaps and short enough to feel immediate in the sidebar.
 */
export const AGENT_IDLE_MS = 3_000

// Pending quiet-window timers per session, module-level because they are bookkeeping for
// the store's idleAgentSessionIds, not renderable state themselves.
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

const clearIdleTimer = (sessionId: string): void => {
  const timer = idleTimers.get(sessionId)
  if (timer === undefined) return
  clearTimeout(timer)
  idleTimers.delete(sessionId)
}

const clearAllIdleTimers = (): void => {
  for (const timer of idleTimers.values()) clearTimeout(timer)
  idleTimers.clear()
}

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
export const useAppStore = create<AppStore>()((set, get) => {
  const unmarkIdle = (sessionId: string): void => {
    clearIdleTimer(sessionId)
    if (get().idleAgentSessionIds[sessionId] !== true) return
    set((state) => {
      const { [sessionId]: _drop, ...rest } = state.idleAgentSessionIds
      return { idleAgentSessionIds: rest as Record<string, true> }
    })
  }

  // Any PTY output from an agent session restarts its quiet window; the session is marked
  // idle (Done) only when that window elapses with no further output. Shells and unknown
  // session ids (data can arrive before the snapshot loads) are ignored entirely.
  const noteAgentOutput = (sessionId: string): void => {
    const session = get().appState.sessions.find((candidate) => candidate.id === sessionId)
    if (!session || (session.kind !== 'claude' && session.kind !== 'codex')) return

    unmarkIdle(sessionId)
    idleTimers.set(
      sessionId,
      setTimeout(() => {
        idleTimers.delete(sessionId)
        set((state) => ({ idleAgentSessionIds: { ...state.idleAgentSessionIds, [sessionId]: true } }))
      }, AGENT_IDLE_MS)
    )
  }

  return {
    appState: emptyAppState(),
    capabilities: defaultCapabilities(),
    activeProjectId: null,
    activeSessionId: null,
    launcherOpen: false,
    searchQuery: '',
    notice: null,
    idleAgentSessionIds: {},
    theme: 'dark',
    locale: DEFAULT_LOCALE,
    sessionKindPreferences: DEFAULT_SESSION_KIND_PREFERENCES,

    initialize: () => {
      set({ sessionKindPreferences: readStoredSessionKindPreferences() })

      const storedLocale = readStoredLocale()
      set({ locale: storedLocale })
      applyLocaleEffects(storedLocale)

      const storedTheme = readStoredTheme()
      set({ theme: storedTheme })
      // Re-applied on every startup (even for the dark default) so the main process's
      // nativeTheme/overlay colors always converge with the renderer preference.
      applyThemeEffects(storedTheme)

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
          set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
        })

      const disposeState = window.codefly.onStateChanged((state) => {
        set({ appState: state })
      })
      const disposeData = window.codefly.onTerminalData(({ sessionId }) => {
        noteAgentOutput(sessionId)
      })
      const disposeExit = window.codefly.onTerminalExit(({ sessionId }) => {
        unmarkIdle(sessionId)
      })

      return () => {
        disposeState()
        disposeData()
        disposeExit()
        clearAllIdleTimers()
      }
    },

    reset: () => {
      clearAllIdleTimers()
      set({
        appState: emptyAppState(),
        capabilities: defaultCapabilities(),
        activeProjectId: null,
        activeSessionId: null,
        launcherOpen: false,
        searchQuery: '',
        notice: null,
        idleAgentSessionIds: {},
        theme: 'dark',
        locale: DEFAULT_LOCALE,
        sessionKindPreferences: DEFAULT_SESSION_KIND_PREFERENCES
      })
    },

    setTheme: (theme) => {
      set({ theme })
      applyThemeEffects(theme)
    },

    setLocale: (locale) => {
      set({ locale })
      applyLocaleEffects(locale)
    },

    setSessionKindPreference: (kind, change) => {
      const current = get().sessionKindPreferences
      const next = { ...current, [kind]: { ...current[kind], ...change } }
      set({ sessionKindPreferences: next })
      persistSessionKindPreferences(next)
    },

    addProject: async () => {
      try {
        const project = await window.codefly.addProject()
        if (!project) return
        set((state) => ({ appState: upsertProject(state.appState, project), activeProjectId: project.id }))
      } catch (error) {
        set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
      }
    },

    reorderProjects: async (orderedProjectIds) => {
      try {
        const projects = await window.codefly.reorderProjects(orderedProjectIds)
        set((state) => ({ appState: { ...state.appState, projects } }))
      } catch (error) {
        set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
      }
    },

    openProjectInVSCode: async (projectId) => {
      try {
        await window.codefly.openProjectInVSCode(projectId)
      } catch (error) {
        set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
      }
    },

    openProjectFolder: async (projectId) => {
      try {
        await window.codefly.openProjectFolder(projectId)
      } catch (error) {
        set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
      }
    },

    openLauncher: () => set({ launcherOpen: true }),
    closeLauncher: () => set({ launcherOpen: false }),

    createSession: async (projectId, kind, worktree) => {
      try {
        const session = await window.codefly.createSession(projectId, kind, worktree)
        set((state) => ({
          appState: upsertSession(state.appState, session),
          activeProjectId: session.projectId,
          activeSessionId: session.id,
          launcherOpen: false
        }))
      } catch (error) {
        set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
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
        set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
      }
    },

    deleteSession: async (sessionId) => {
      try {
        const result = await window.codefly.deleteSession(sessionId)

        if (result.status === 'deleted') {
          unmarkIdle(sessionId)
          set((state) => ({
            appState: { ...state.appState, sessions: state.appState.sessions.filter((session) => session.id !== sessionId) },
            activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId
          }))
        } else if (result.status === 'dirty') {
          set({
            notice: {
              message: translate(get().locale, 'notice.dirtyWorktree', { count: result.changedFiles }),
              tone: 'error'
            }
          })
        } else {
          set({ notice: { message: result.message, tone: 'error' } })
        }

        return result
      } catch (error) {
        set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
        return undefined
      }
    },

    setSearchQuery: (query) => set({ searchQuery: query }),
    dismissNotice: () => set({ notice: null })
  }
})
