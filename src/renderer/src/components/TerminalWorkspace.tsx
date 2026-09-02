import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
// xterm's own stylesheet is REQUIRED for its layered DOM to lay out correctly: it makes
// .xterm-viewport an absolute overlay instead of a normal-flow block. Without it, the
// viewport's scroll area pushes .xterm-screen below the host, rendering the prompt outside
// the visible pane ("cannot see the input line").
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'

import type { SessionRecord, ThemePreference } from '../../../shared/contracts'
import type { Translator } from '../i18n'
import { useTranslation } from '../i18n/use-translation'
import { isAgentDone, isSessionRestartable, sessionStatusLabel } from '../session-status'
import { useAppStore } from '../store/use-app-store'
import { FirstInputTracker } from '../terminal/first-input-tracker'

type TerminalEntry = {
  terminal: Terminal
  fitAddon: FitAddon
  tracker: FirstInputTracker
  element: HTMLDivElement
  dataDisposable: { dispose(): void }
  resizeObserver: ResizeObserver
  lastCols: number
  lastRows: number
}

// Kept identical to the --font-mono value in styles.css: xterm renders to its own canvas,
// so it cannot inherit the CSS custom property and needs the same Windows system font stack
// spelled out here.
const TERMINAL_FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace'

// Like the font above, xterm renders to its own canvas and cannot read CSS custom
// properties: these mirror the --color-canvas/--color-text tokens per theme in styles.css
// (selection uses the accent purple at low alpha) so the terminal follows the app theme.
const XTERM_THEMES: Record<ThemePreference, { background: string; foreground: string; cursor: string; selectionBackground: string }> = {
  dark: { background: '#0b0f14', foreground: '#e7edf5', cursor: '#e7edf5', selectionBackground: 'rgba(148, 113, 199, 0.35)' },
  light: { background: '#f5f7fa', foreground: '#1c2733', cursor: '#1c2733', selectionBackground: 'rgba(110, 84, 148, 0.25)' }
}
const MAX_PENDING_DATA_PER_SESSION = 65_536
const MAX_PENDING_SESSIONS = 32

const sessionKindLabel = (t: Translator, kind: SessionRecord['kind']): string => {
  switch (kind) {
    case 'powershell':
      return t('sessionKind.powershell')
    case 'cmd':
      return t('sessionKind.cmd')
    case 'claude':
      return t('sessionKind.claude')
    case 'codex':
      return t('sessionKind.codex')
    default:
      return kind
  }
}

type TerminalHeaderProps = {
  session: SessionRecord
  onRestart: () => void
}

function TerminalHeader({ session, onRestart }: TerminalHeaderProps) {
  const { t } = useTranslation()
  const agentIdle = useAppStore((state) => state.idleAgentSessionIds[session.id] === true)
  const running = session.status === 'running'
  const showBypass = running && (session.kind === 'claude' || session.kind === 'codex')
  const canRestart = isSessionRestartable(session)

  return (
    <header className="terminal-header">
      <div className="terminal-header-row">
        <span className="terminal-header-title" title={session.title}>
          {session.title}
        </span>
        <span className="terminal-header-kind">{sessionKindLabel(t, session.kind)}</span>
        <span className="terminal-header-status" data-status={isAgentDone(session, agentIdle) ? 'done' : session.status}>
          {sessionStatusLabel(t, session, agentIdle)}
        </span>
        {showBypass && (
          <span className="terminal-header-bypass" role="status" title={t('terminal.bypassTooltip')}>
            {t('terminal.bypassWarning')}
          </span>
        )}
        {canRestart && (
          <button type="button" className="terminal-restart-button" onClick={onRestart}>
            {t('terminal.restartSession')}
          </button>
        )}
      </div>
      <span className="terminal-header-path" title={session.launchPath}>
        {session.launchPath}
      </span>
    </header>
  )
}

/**
 * Owns one persistent xterm.js instance per opened session in a Map<sessionId, TerminalEntry>
 * (kept in a ref, not React state, since xterm manages its own DOM/canvas internals that must
 * never be reconciled by React). An entry is created the first time a session becomes active
 * (via the `mountedSessionIds` list) and its pane stays mounted with display:none while
 * inactive so scrollback survives tab switches; it is disposed only when its session is
 * deleted (no longer present in appState.sessions) or this component unmounts.
 *
 * Terminal data/exit events are subscribed to exactly once and dispatched to the owning
 * entry by session ID, matching the main process's per-window, per-session PTY routing.
 */
export default function TerminalWorkspace() {
  const { t } = useTranslation()
  const sessions = useAppStore((state) => state.appState.sessions)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const restoreSession = useAppStore((state) => state.restoreSession)
  const theme = useAppStore((state) => state.theme)

  const [mountedSessionIds, setMountedSessionIds] = useState<string[]>([])
  const entriesRef = useRef<Map<string, TerminalEntry>>(new Map())
  const pendingDataRef = useRef<Map<string, string>>(new Map())
  const hostRefCallbacks = useRef<Map<string, (element: HTMLDivElement | null) => void>>(new Map())

  // Mirrors `activeSessionId` for use inside stable closures (the ResizeObserver callback
  // created once per entry in `ensureEntry`) that must always see the LATEST active session,
  // not a value snapshotted at entry-creation time. Written during render (not in an effect)
  // so it is current by the time any event fires after this commit; read-only outside render.
  const activeSessionIdRef = useRef<string | null>(null)
  activeSessionIdRef.current = activeSessionId

  // Status last observed for each session, used to spot a restart in place (see the effect
  // that re-pushes the terminal size below). Rebuilt from `sessions` on every run of that
  // effect so entries for deleted sessions drop out on their own.
  const lastStatusesRef = useRef<Map<string, SessionRecord['status']>>(new Map())

  const applyFit = (sessionId: string): void => {
    const entry = entriesRef.current.get(sessionId)
    if (!entry) return
    // A pane not currently active is rendered with display:none; fitting/resizing it would
    // reflow xterm against a zero-size box and can hand back degenerate (0 or NaN) dimensions.
    // The ResizeObserver keeps observing hidden panes (so it's ready the instant they become
    // visible again), so this guard — not the observer subscription — is what makes hidden
    // panes inert.
    if (sessionId !== activeSessionIdRef.current) return
    entry.fitAddon.fit()
    const dimensions = entry.fitAddon.proposeDimensions()
    if (!dimensions) return
    const { cols, rows } = dimensions
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
    if (cols === entry.lastCols && rows === entry.lastRows) return
    entry.lastCols = cols
    entry.lastRows = rows
    window.codefly.resizeTerminal(sessionId, cols, rows)
  }

  const ensureEntry = (sessionId: string, element: HTMLDivElement): void => {
    if (entriesRef.current.has(sessionId)) return

    const terminal = new Terminal({
      // convertEol stays OFF: a PTY-backed terminal must treat LF as a bare line feed. ConPTY
      // paints a row with 'ESC[<row>;4H ESC[K <LF> text' to continue at the SAME column, so
      // rewriting LF to CR+LF drags that text to column 1. Worse, because ConPTY repaints
      // differentially it never learns about cells it did not mean to write, so those shifted
      // characters survive every later repaint — leaving 3-character stubs down the left edge
      // after a full-screen panel such as Claude Code's /usage is dismissed.
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      // Read via getState() rather than the subscribed `theme`: ensureEntry runs inside a
      // stable ref callback, and the theme-change effect below re-themes live entries anyway.
      theme: XTERM_THEMES[useAppStore.getState().theme]
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(element)

    const tracker = new FirstInputTracker()
    const dataDisposable = terminal.onData((data) => {
      const result = tracker.push(data)
      window.codefly.writeTerminal(sessionId, result.passthrough)
      if (result.submitted !== undefined) {
        window.codefly.submitFirstInput(sessionId, result.submitted).catch(() => undefined)
      }
    })

    const resizeObserver = new ResizeObserver(() => applyFit(sessionId))
    resizeObserver.observe(element)

    entriesRef.current.set(sessionId, { terminal, fitAddon, tracker, element, dataDisposable, resizeObserver, lastCols: 0, lastRows: 0 })
    const pendingData = pendingDataRef.current.get(sessionId)
    if (pendingData !== undefined) {
      pendingDataRef.current.delete(sessionId)
      terminal.write(pendingData)
    }
  }

  const writeOrBuffer = (sessionId: string, data: string): void => {
    const entry = entriesRef.current.get(sessionId)
    if (entry) {
      entry.terminal.write(data)
      return
    }

    if (!pendingDataRef.current.has(sessionId) && pendingDataRef.current.size >= MAX_PENDING_SESSIONS) {
      const oldestSessionId = pendingDataRef.current.keys().next().value as string | undefined
      if (oldestSessionId !== undefined) pendingDataRef.current.delete(oldestSessionId)
    }
    const combined = `${pendingDataRef.current.get(sessionId) ?? ''}${data}`
    pendingDataRef.current.set(sessionId, combined.slice(-MAX_PENDING_DATA_PER_SESSION))
  }

  const getHostRef = (sessionId: string): ((element: HTMLDivElement | null) => void) => {
    let callback = hostRefCallbacks.current.get(sessionId)
    if (!callback) {
      callback = (element) => {
        if (element) ensureEntry(sessionId, element)
      }
      hostRefCallbacks.current.set(sessionId, callback)
    }
    return callback
  }

  // Track the active session ID as "opened" exactly once, the first time it becomes active.
  useEffect(() => {
    if (!activeSessionId) return
    setMountedSessionIds((previous) => (previous.includes(activeSessionId) ? previous : [...previous, activeSessionId]))
  }, [activeSessionId])

  // Fit and focus on activation: runs whenever the active session changes AND whenever a new
  // entry becomes available (mountedSessionIds grows), since entry creation happens one render
  // after the id above is first tracked (the host div only mounts once its pane renders).
  // Focusing here is what lets the user type immediately after creating, restoring, or
  // switching to a session — without it, keyboard focus stays on the sidebar/launcher control
  // that triggered the change and keystrokes never reach xterm.
  useEffect(() => {
    if (!activeSessionId) return
    const entry = entriesRef.current.get(activeSessionId)
    if (!entry) return
    applyFit(activeSessionId)
    entry.terminal.focus()
  }, [activeSessionId, mountedSessionIds])

  // Re-focus when the ACTIVE session's status returns to running (the header's
  // "Restart session" action restarts in place: neither the active id nor the mounted list
  // changes, so the activation effect above does not re-fire). Guarded to running-only so an
  // unexpected exit (running -> stopped) never steals focus from wherever the user is typing.
  const activeSessionStatus = sessions.find((session) => session.id === activeSessionId)?.status
  useEffect(() => {
    if (!activeSessionId) return
    if (activeSessionStatus !== 'running') return
    entriesRef.current.get(activeSessionId)?.terminal.focus()
  }, [activeSessionId, activeSessionStatus, mountedSessionIds])

  // Re-push the terminal size whenever a session transitions back to running. A restart in
  // place hands it a BRAND NEW pty, spawned at TerminalService's own 120x30 default, while this
  // entry's xterm instance and its lastCols/lastRows memo (of what the now-dead pty was last
  // told) both survive. Neither activeSessionId, mountedSessionIds nor the host's box changes,
  // so no other path re-fits: forgetting the memo here is what lets applyFit push again.
  // Without it the new pty would sit at 120x30 while xterm renders at its fitted size, and
  // ConPTY's differential repaints — which skip every cell it believes already correct — would
  // land on the wrong geometry and leave residue behind.
  useEffect(() => {
    const previousStatuses = lastStatusesRef.current
    const currentStatuses = new Map<string, SessionRecord['status']>()
    for (const session of sessions) {
      currentStatuses.set(session.id, session.status)
      if (session.status !== 'running' || previousStatuses.get(session.id) === 'running') continue
      const entry = entriesRef.current.get(session.id)
      if (!entry) continue
      entry.lastCols = 0
      entry.lastRows = 0
      applyFit(session.id)
    }
    lastStatusesRef.current = currentStatuses
  }, [sessions, mountedSessionIds])

  // Re-theme every live terminal when the app theme changes: xterm applies option updates
  // to its canvas immediately, so existing scrollback repaints in the new palette.
  useEffect(() => {
    for (const entry of entriesRef.current.values()) {
      entry.terminal.options.theme = XTERM_THEMES[theme]
    }
  }, [theme])

  // Dispose entries whose session no longer exists (deleted), and drop their pane.
  useEffect(() => {
    const currentIds = new Set(sessions.map((session) => session.id))
    const staleIds = mountedSessionIds.filter((id) => !currentIds.has(id))
    if (staleIds.length === 0) return

    for (const id of staleIds) {
      const entry = entriesRef.current.get(id)
      if (entry) {
        entry.resizeObserver.disconnect()
        entry.dataDisposable.dispose()
        entry.terminal.dispose()
        entriesRef.current.delete(id)
      }
      hostRefCallbacks.current.delete(id)
      pendingDataRef.current.delete(id)
    }
    setMountedSessionIds((previous) => previous.filter((id) => !staleIds.includes(id)))
  }, [sessions, mountedSessionIds])

  // Subscribe to terminal data/exit exactly once and dispatch by session ID; dispose every
  // remaining entry and both subscriptions on unmount.
  useEffect(() => {
    const disposeData = window.codefly.onTerminalData(({ sessionId, data }) => {
      writeOrBuffer(sessionId, data)
    })
    const disposeExit = window.codefly.onTerminalExit(({ sessionId, exitCode }) => {
      // The session record's status flips to 'stopped' via the main process's broadcast
      // state (session-coordinator marks it on PTY exit), which drives the header's restart
      // action; here we only append a notice to the owning terminal's own scrollback. The
      // entry itself is deliberately NOT disposed, preserving the visible xterm contents.
      writeOrBuffer(sessionId, `\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`)
    })

    return () => {
      disposeData()
      disposeExit()
      for (const entry of entriesRef.current.values()) {
        entry.resizeObserver.disconnect()
        entry.dataDisposable.dispose()
        entry.terminal.dispose()
      }
      entriesRef.current.clear()
      pendingDataRef.current.clear()
    }
  }, [])

  return (
    <div className="terminal-workspace" data-testid="terminal-workspace">
      {mountedSessionIds.length === 0 && (
        <div className="terminal-empty-state">
          <p>{t('terminal.emptyState')}</p>
        </div>
      )}
      {mountedSessionIds.map((id) => {
        const session = sessions.find((candidate) => candidate.id === id)
        if (!session) return null
        const isActive = id === activeSessionId
        return (
          <section key={id} className="terminal-pane" style={{ display: isActive ? 'flex' : 'none' }}>
            <TerminalHeader session={session} onRestart={() => void restoreSession(id)} />
            <div className="terminal-instance-host" data-testid={`terminal-host-${id}`} ref={getHostRef(id)} />
          </section>
        )
      })}
    </div>
  )
}
