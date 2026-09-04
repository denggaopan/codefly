import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
// xterm's own stylesheet is REQUIRED for its layered DOM to lay out correctly: it makes
// .xterm-viewport an absolute overlay instead of a normal-flow block. Without it, the
// viewport's scroll area pushes .xterm-screen below the host, rendering the prompt outside
// the visible pane ("cannot see the input line").
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'

import { isAgentKind } from '../../../shared/agent-kinds'
import type { SessionRecord, ThemePreference } from '../../../shared/contracts'
import type { TerminalReplay } from '../../../shared/pty-protocol'
import { useTranslation } from '../i18n/use-translation'
import { sessionKindLabelKey } from '../session-kind-options'
import { isAgentDone, isSessionRestartable, sessionStatusLabel } from '../session-status'
import { useAppStore } from '../store/use-app-store'
import { alignBlockGlyphGrid } from '../terminal/block-glyph-alignment'
import { FirstInputTracker } from '../terminal/first-input-tracker'
import { resolveTerminalKey } from '../terminal/terminal-key-bindings'

// The WebGL renderer paints the screen into a canvas, so xterm keeps no DOM text for a test
// driver to read (see attachWebglRenderer). Each pane's host element carries a back-reference
// to its Terminal so e2e can assert on the rendered screen through xterm's own buffer; nothing
// in the application itself reads this property.
export type TerminalHostElement = HTMLDivElement & { codeflyTerminal?: Terminal }

type TerminalEntry = {
  terminal: Terminal
  fitAddon: FitAddon
  tracker: FirstInputTracker
  element: HTMLDivElement
  dataDisposable: { dispose(): void }
  resizeObserver: ResizeObserver
  lastCols: number
  lastRows: number
  // False until the session's retained output has been replayed into this instance. The PTY
  // outlives the window (it lives in the pty-host process), so a terminal opened after a
  // restart has to be repainted from the host's buffer BEFORE any live byte reaches it —
  // otherwise new output would be drawn on a blank screen and the replay would then overwrite
  // it. Live data arriving in the meantime waits in pendingDataRef; see hydrateEntry.
  hydrated: boolean
}

type PendingDataChunk = { data: string; sequence?: number }
type PendingData = { chunks: PendingDataChunk[]; chars: number }

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

// Swaps xterm's default DOM renderer for the WebGL one. This is a correctness fix, not just a
// performance one: the DOM renderer lays cells out on a FRACTIONAL CSS grid (a Cascadia Mono
// cell is 8.7875px wide at 100% zoom) and paints Block Elements with the font's glyphs, so the
// pixel art agents draw with U+2588 and the quadrant characters cannot meet on a device-pixel
// boundary and hairline seams of background colour run through what should be solid fill —
// visible as cracks through Claude Code's startup logo. The WebGL renderer sizes cells in whole
// device pixels and draws those code points from its own vector glyph table instead of the
// font, so adjacent cells join seamlessly.
//
// Never fatal: activation throws on a machine with no usable WebGL2 context (GPU blocklisted,
// --disable-gpu, a stale driver), and the context can be dropped at runtime — by the GPU
// process, or by Chromium itself once enough panes are open, since it keeps only a bounded
// number of WebGL contexts alive and reclaims the oldest. Disposing the addon on context loss
// puts that terminal back on the DOM renderer (xterm re-creates the default renderer from
// WebglAddon.dispose), which renders everything correctly apart from those seams; leaving a
// lost context in place would freeze the pane's output instead.
const attachWebglRenderer = (terminal: Terminal): void => {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => addon.dispose())
    terminal.loadAddon(addon)
  } catch {
    // DOM renderer stays in place.
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
  // Every agent CLI carries a permission bypass, whether as argv or as launch environment.
  const showBypass = running && isAgentKind(session.kind)
  const canRestart = isSessionRestartable(session)

  return (
    <header className="terminal-header">
      <div className="terminal-header-row">
        <span className="terminal-header-title" title={session.title}>
          {session.title}
        </span>
        <span className="terminal-header-kind">{t(sessionKindLabelKey(session.kind))}</span>
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
  const pendingDataRef = useRef<Map<string, PendingData>>(new Map())
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
    // Before fitting, not after: the spacing changes how wide a cell is and therefore how many
    // of them the pane holds. Re-checked on every fit because the device pixel ratio it depends
    // on can change under a running window (moved to a display at a different scale).
    alignBlockGlyphGrid(entry.terminal, entry.element)
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

  const ensureEntry = (sessionId: string, kind: SessionRecord['kind'], element: HTMLDivElement): void => {
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
    // After open(): the addon needs the live screen element to attach its canvas to.
    attachWebglRenderer(terminal)
    // Straight after the renderer exists, so the very first frame — the agent's startup logo —
    // is already drawn on an aligned grid rather than being corrected on a later resize.
    alignBlockGlyphGrid(terminal, element)
    ;(element as TerminalHostElement).codeflyTerminal = terminal

    const tracker = new FirstInputTracker()
    // Every byte bound for the PTY funnels through here — xterm's own key/paste output and the
    // agent key bindings below alike — so first-input capture always sees the complete stream.
    const forwardInput = (data: string): void => {
      const result = tracker.push(data)
      window.codefly.writeTerminal(sessionId, result.passthrough)
      if (result.submitted !== undefined) {
        window.codefly.submitFirstInput(sessionId, result.submitted).catch(() => undefined)
      }
    }
    const dataDisposable = terminal.onData(forwardInput)

    // Runs before xterm's own key handling (for keydown, keypress and keyup alike). Returning
    // false makes xterm skip the event entirely: for Ctrl/Cmd+V that leaves the browser's default
    // paste command in place, whose `paste` event xterm's own listener turns into (bracketed)
    // terminal input; for Shift+Enter we write the newline sequence ourselves and cancel the
    // event so no bare CR follows. Shell sessions resolve to 'xterm' for every key and behave
    // exactly as before — see terminal-key-bindings.ts for why only agent sessions need this.
    terminal.attachCustomKeyEventHandler((event) => {
      const resolved = resolveTerminalKey(kind, event)
      if (resolved.action === 'xterm') return true
      if (resolved.action === 'send') {
        event.preventDefault()
        forwardInput(resolved.data)
      }
      return false
    })

    const resizeObserver = new ResizeObserver(() => applyFit(sessionId))
    resizeObserver.observe(element)

    const entry: TerminalEntry = {
      terminal,
      fitAddon,
      tracker,
      element,
      dataDisposable,
      resizeObserver,
      lastCols: 0,
      lastRows: 0,
      hydrated: false
    }
    entriesRef.current.set(sessionId, entry)
    void hydrateEntry(sessionId, entry)
  }

  /**
   * Repaints a newly opened instance from the output the pty-host retained for that session,
   * then releases the live bytes that queued up during the round trip. Ordering is the whole
   * point: replay is older than anything in pendingDataRef, so it has to be written first.
   *
   * A session the host does not know about (never started, or stopped long ago) simply has no
   * replay — the request answers `undefined` rather than failing, exactly like the rest of the
   * app's "fold failures into a result" IPC surface, so a fresh session costs one no-op round
   * trip and takes the same code path as an adopted one.
   *
   * The forced re-fit at the end is not cosmetic: the host's PTY keeps whatever geometry the
   * previous window negotiated, and full-screen agent TUIs only repaint themselves when the
   * size changes. Zeroing lastCols/lastRows defeats applyFit's dedupe so the PTY always gets
   * one resize after an attach, which is what makes the agent redraw its current screen.
   */
  const hydrateEntry = async (sessionId: string, entry: TerminalEntry): Promise<void> => {
    let replay: TerminalReplay | undefined
    try {
      replay = await window.codefly.replayTerminal(sessionId)
    } catch {
      // A failed replay must never leave the pane wedged behind an unhydrated gate: the
      // session keeps working, it just starts from an empty screen.
      replay = undefined
    }

    // The pane may have been disposed (session deleted, component unmounted) or replaced
    // while the request was in flight; writing into a disposed Terminal throws.
    if (entriesRef.current.get(sessionId) !== entry) return

    if (replay !== undefined && replay.data.length > 0) entry.terminal.write(replay.data)
    entry.hydrated = true

    const pending = pendingDataRef.current.get(sessionId)
    pendingDataRef.current.delete(sessionId)
    if (pending !== undefined) {
      for (const chunk of pending.chunks) {
        // Host events at or below the snapshot watermark are already present in replay.data.
        // Sequence-less chunks come from the no-replay fallback or local exit notices and can
        // never safely be discarded.
        if (replay !== undefined && chunk.sequence !== undefined && chunk.sequence <= replay.throughSequence) continue
        entry.terminal.write(chunk.data)
      }
    }

    entry.lastCols = 0
    entry.lastRows = 0
    applyFit(sessionId)
  }

  const writeOrBuffer = (sessionId: string, data: string, sequence?: number): void => {
    const entry = entriesRef.current.get(sessionId)
    if (entry?.hydrated) {
      entry.terminal.write(data)
      return
    }

    if (!pendingDataRef.current.has(sessionId) && pendingDataRef.current.size >= MAX_PENDING_SESSIONS) {
      const oldestSessionId = pendingDataRef.current.keys().next().value as string | undefined
      if (oldestSessionId !== undefined) pendingDataRef.current.delete(oldestSessionId)
    }
    const previous = pendingDataRef.current.get(sessionId)
    const chunks = [...(previous?.chunks ?? []), { data, sequence }]
    let chars = (previous?.chars ?? 0) + data.length
    let overflow = chars - MAX_PENDING_DATA_PER_SESSION
    while (overflow > 0 && chunks.length > 0) {
      const first = chunks[0]!
      if (first.data.length <= overflow) {
        overflow -= first.data.length
        chars -= first.data.length
        chunks.shift()
      } else {
        chunks[0] = { ...first, data: first.data.slice(overflow) }
        chars -= overflow
        overflow = 0
      }
    }
    pendingDataRef.current.set(sessionId, { chunks, chars })
  }

  // `kind` is fixed for a session's lifetime, so capturing it in the callback created on first
  // render is safe.
  const getHostRef = (sessionId: string, kind: SessionRecord['kind']): ((element: HTMLDivElement | null) => void) => {
    let callback = hostRefCallbacks.current.get(sessionId)
    if (!callback) {
      callback = (element) => {
        if (element) ensureEntry(sessionId, kind, element)
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
    const disposeData = window.codefly.onTerminalData(({ sessionId, data, sequence }) => {
      writeOrBuffer(sessionId, data, sequence)
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
            <div className="terminal-instance-host" data-testid={`terminal-host-${id}`} ref={getHostRef(id, session.kind)} />
          </section>
        )
      })}
    </div>
  )
}
