import { create } from 'zustand'

import { AGENT_KINDS, type AgentKind } from '../../../shared/agent-kinds'
import type {
  AppState,
  CapabilityState,
  DeleteSessionResult,
  HostPlatform,
  ProjectRecord,
  SessionKind,
  SessionRecord,
  SessionKindPreference,
  SessionKindPreferences,
  ThemePreference,
  ToolAvailability
} from '../../../shared/contracts'
import { DEFAULT_SESSION_KIND_PREFERENCES, storedSessionKindPreferencesSchema } from '../../../shared/contracts'
import { DEFAULT_LOCALE, isLocale, translate, type Locale } from '../i18n'
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, parseStoredSidebarWidth } from '../sidebar-width'
import { defaultSessionKindPreferences } from '../session-kind-options'

export type Notice = {
  message: string
  tone: 'error' | 'info'
}

/**
 * The in-app update flow, from "a newer release exists" to "the installer is on disk".
 * `idle` is the resting state and the only one that renders no dialog, so every terminal
 * outcome — declined, cancelled, or installed — comes back here. `downloadable` is false
 * when this platform cannot install the release in-app: the only thing left to offer is the
 * download page.
 */
export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string; downloadable: boolean }
  | { phase: 'downloading'; version: string; receivedBytes: number; totalBytes: number }
  | { phase: 'ready'; version: string }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; version: string; message: string }

export type AppStore = {
  platform: HostPlatform
  appState: AppState
  capabilities: CapabilityState
  activeProjectId: string | null
  activeSessionId: string | null
  launcherOpen: boolean
  searchQuery: string
  notice: Notice | null
  /** Running agent sessions whose PTY output has been quiet for AGENT_IDLE_MS. */
  idleAgentSessionIds: Record<string, true>
  theme: ThemePreference
  locale: Locale
  /** Which kinds the New session launcher lists, and which of them offer a worktree entry. */
  sessionKindPreferences: SessionKindPreferences
  /** Project sidebar width in CSS pixels, already clamped (see sidebar-width.ts). */
  sidebarWidth: number
  /** Drives UpdateDialog; `idle` renders nothing at all. */
  updater: UpdaterState

  initialize: () => () => void
  reset: () => void

  checkForUpdatesInBackground: () => Promise<void>
  beginUpdate: (version: string, downloadable: boolean) => void
  startUpdateDownload: () => Promise<void>
  cancelUpdateDownload: () => Promise<void>
  installUpdate: () => Promise<void>
  dismissUpdate: () => void

  setTheme: (theme: ThemePreference) => void
  setLocale: (locale: Locale) => void
  setSessionKindPreference: (kind: SessionKind, change: Partial<SessionKindPreference>) => void
  /** Clamps to the current viewport before storing, so callers can pass raw pointer maths. */
  setSidebarWidth: (width: number) => void
  resetSidebarWidth: () => void

  addProject: () => Promise<void>
  reorderProjects: (orderedProjectIds: readonly string[]) => Promise<void>
  openProjectInVSCode: (projectId: string) => Promise<void>
  openProjectFolder: (projectId: string) => Promise<void>
  openProjectRepository: (projectId: string) => Promise<void>
  removeProject: (projectId: string) => Promise<void>

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

// The resting state the launcher may already be reading from: it looks availability up by
// kind with nothing to fall back to, so every agent kind needs an entry before the first
// snapshot replaces the whole object.
const defaultCapabilities = (): CapabilityState => ({
  ...(Object.fromEntries(
    AGENT_KINDS.map((kind) => [kind, { available: false, detail: 'Checking availability…' }])
  ) as Record<AgentKind, ToolAvailability>),
  vscode: { available: false, detail: 'Checking availability…' }
})

const errorMessage = (error: unknown, locale: Locale): string =>
  error instanceof Error ? error.message : translate(locale, 'notice.genericError')

export const THEME_STORAGE_KEY = 'codefly.theme'
export const LOCALE_STORAGE_KEY = 'codefly.locale'
export const SESSION_KINDS_STORAGE_KEY = 'codefly.sessionKinds'
export const SIDEBAR_WIDTH_STORAGE_KEY = 'codefly.sidebarWidth'

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
const mergeStoredSessionKinds = (stored: unknown, platform: HostPlatform): SessionKindPreferences => {
  const defaults = defaultSessionKindPreferences(platform)
  const parsed = storedSessionKindPreferencesSchema.safeParse(stored)
  if (!parsed.success) return defaults
  const merged = { ...defaults }
  for (const kind of Object.keys(merged) as SessionKind[]) {
    merged[kind] = { ...merged[kind], ...parsed.data[kind] }
  }
  return merged
}

const readStoredSessionKindPreferences = (platform: HostPlatform): SessionKindPreferences => {
  try {
    const stored = window.localStorage.getItem(SESSION_KINDS_STORAGE_KEY)
    if (stored === null) return defaultSessionKindPreferences(platform)
    return mergeStoredSessionKinds(JSON.parse(stored), platform)
  } catch {
    return defaultSessionKindPreferences(platform)
  }
}

const persistSessionKindPreferences = (preferences: SessionKindPreferences): void => {
  try {
    window.localStorage.setItem(SESSION_KINDS_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // localStorage unavailable: the preference just won't survive a restart.
  }
}

// The sidebar width is renderer-owned (localStorage) like the theme: pure layout, never part
// of the persisted AppState. It is re-clamped against the viewport on read so a value saved
// on a wide monitor cannot swallow the workspace on a narrower one.
const readStoredSidebarWidth = (): number => {
  try {
    return parseStoredSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), window.innerWidth)
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

const persistSidebarWidth = (width: number): void => {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // localStorage unavailable: the preference just won't survive a restart.
  }
}

/**
 * How long a running agent session's PTY output must stay quiet before the session
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
    platform: 'win32',
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
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    updater: { phase: 'idle' },

    initialize: () => {
      set({ sidebarWidth: readStoredSidebarWidth() })

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
          document.documentElement.dataset.platform = snapshot.platform
          set((state) => ({
            platform: snapshot.platform,
            appState: snapshot.state,
            capabilities: snapshot.capabilities,
            sessionKindPreferences: readStoredSessionKindPreferences(snapshot.platform),
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
      // Merged only while a download is actually in progress, so an event arriving after a
      // cancel, a failure, or a completion cannot drag the dialog back into the downloading
      // phase. The version comes from the event rather than being matched against the stored
      // one: the main process re-resolves the release when the download starts, so a release
      // published between the check and the click legitimately reports a newer version, and
      // dropping those frames would freeze the progress bar at 0 for the whole transfer.
      const disposeUpdateProgress = window.codefly.onUpdateProgress((progress) => {
        set((state) =>
          state.updater.phase === 'downloading'
            ? {
                updater: {
                  phase: 'downloading',
                  version: progress.version,
                  receivedBytes: progress.receivedBytes,
                  totalBytes: progress.totalBytes
                }
              }
            : {}
        )
      })

      // Fire-and-forget: a startup check that finds nothing, fails, or cannot reach the
      // network must leave the app exactly as quiet as it would have been without it.
      void get().checkForUpdatesInBackground()

      return () => {
        disposeState()
        disposeData()
        disposeExit()
        disposeUpdateProgress()
        clearAllIdleTimers()
      }
    },

    reset: () => {
      clearAllIdleTimers()
      set({
        platform: 'win32',
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
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        updater: { phase: 'idle' }
      })
    },

    // A background check is allowed exactly one outcome that the user can see: a newer
    // version exists. Up-to-date, no releases, a network failure, and a rejected invoke all
    // leave the updater idle and silent — unlike Settings' explicit check, nobody asked.
    checkForUpdatesInBackground: async () => {
      try {
        const result = await window.codefly.checkForUpdates()
        if (result.status !== 'available') return
        set({ updater: { phase: 'available', version: result.latestVersion, downloadable: result.asset !== undefined } })
      } catch {
        // Silent by design.
      }
    },

    // Settings has just run its own check, so it hands the outcome over rather than making
    // the dialog repeat the round trip.
    beginUpdate: (version, downloadable) => set({ updater: { phase: 'available', version, downloadable } }),

    startUpdateDownload: async () => {
      const current = get().updater
      // Nothing to download from a resting dialog; a second call while bytes are already
      // moving would only reset the progress the main process is still reporting; and an
      // install already handed to the OS must not be undercut by a fresh download.
      if (current.phase === 'idle' || current.phase === 'downloading' || current.phase === 'installing') return
      const { version } = current

      set({ updater: { phase: 'downloading', version, receivedBytes: 0, totalBytes: 0 } })
      try {
        const result = await window.codefly.downloadUpdate()
        if (result.status === 'ready') {
          set({ updater: { phase: 'ready', version: result.version } })
        } else if (result.status === 'cancelled') {
          set({ updater: { phase: 'idle' } })
        } else {
          set({ updater: { phase: 'error', version, message: result.message } })
        }
      } catch (error) {
        set({ updater: { phase: 'error', version, message: errorMessage(error, get().locale) } })
      }
    },

    // The in-flight downloadUpdate() call is what reports the outcome (`cancelled`), so this
    // only asks; setting a phase here would race that answer.
    cancelUpdateDownload: async () => {
      try {
        await window.codefly.cancelUpdateDownload()
      } catch {
        // The download simply keeps going, and its own result still lands.
      }
    },

    // Quitting is not instant — the main process still has to tear down every PTY before the
    // app actually exits (see shutdown-controller) — so the dialog moves to `installing` and
    // stops offering the button. Two NSIS wizards racing on the same install directory is a
    // real outcome of a double click, and UpdaterService.install() is idempotent for the same
    // reason; this is the half the user can see.
    installUpdate: async () => {
      const current = get().updater
      if (current.phase === 'idle' || current.phase === 'installing') return
      const { version } = current

      set({ updater: { phase: 'installing', version } })
      try {
        const result = await window.codefly.installUpdate()
        // `launched` means the app is already quitting: staying on `installing` avoids a
        // flash of some other state during teardown.
        if (result.status === 'error') set({ updater: { phase: 'error', version, message: result.message } })
      } catch (error) {
        set({ updater: { phase: 'error', version, message: errorMessage(error, get().locale) } })
      }
    },

    // "Later" in every phase. A downloaded installer is deliberately left on disk: the main
    // process reuses it, so choosing to update again skips straight to the install prompt.
    dismissUpdate: () => set({ updater: { phase: 'idle' } }),

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

    setSidebarWidth: (width) => {
      const next = clampSidebarWidth(width, window.innerWidth)
      if (next === get().sidebarWidth) return
      set({ sidebarWidth: next })
      persistSidebarWidth(next)
    },

    resetSidebarWidth: () => {
      set({ sidebarWidth: DEFAULT_SIDEBAR_WIDTH })
      persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
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

    openProjectRepository: async (projectId) => {
      try {
        await window.codefly.openProjectRepository(projectId)
      } catch (error) {
        set({ notice: { message: errorMessage(error, get().locale), tone: 'error' } })
      }
    },

    removeProject: async (projectId) => {
      try {
        await window.codefly.removeProject(projectId)
        // The main process has already broadcast the state without this project; this only
        // moves the selection off the records that vanished (and is a no-op for the state).
        set((state) => {
          const projects = state.appState.projects.filter((project) => project.id !== projectId)
          const sessions = state.appState.sessions.filter((session) => session.projectId !== projectId)
          const activeProjectRemoved = state.activeProjectId === projectId
          const activeSessionRemoved =
            state.activeSessionId !== null && !sessions.some((session) => session.id === state.activeSessionId)
          return {
            appState: { ...state.appState, projects, sessions },
            activeProjectId: activeProjectRemoved ? (projects[0]?.id ?? null) : state.activeProjectId,
            activeSessionId: activeSessionRemoved ? null : state.activeSessionId,
            launcherOpen: activeProjectRemoved ? false : state.launcherOpen
          }
        })
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
