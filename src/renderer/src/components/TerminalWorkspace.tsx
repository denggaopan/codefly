import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import type { SessionRecord } from '../../../shared/contracts'
import { useAppStore } from '../store/use-app-store'
import { FirstInputTracker } from '../terminal/first-input-tracker'
import { BYPASS_WARNING_TEXT } from './AgentBypassStatus'

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

const sessionKindLabel = (kind: SessionRecord['kind']): string => {
  switch (kind) {
    case 'powershell':
      return 'PowerShell'
    case 'cmd':
      return 'Command Prompt'
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    default:
      return kind
  }
}

type TerminalHeaderProps = {
  session: SessionRecord
  onRestart: () => void
}

function TerminalHeader({ session, onRestart }: TerminalHeaderProps) {
  const running = session.status === 'running'
  const showBypass = running && (session.kind === 'claude' || session.kind === 'codex')
  const canRestart = !running && session.status !== 'creating'

  return (
    <header className="terminal-header">
      <div className="terminal-header-row">
        <span className="terminal-header-title" title={session.title}>
          {session.title}
        </span>
        <span className="terminal-header-kind">{sessionKindLabel(session.kind)}</span>
        <span className="terminal-header-status">{running ? 'Running' : 'Stopped'}</span>
        {canRestart && (
          <button type="button" className="terminal-restart-button" onClick={onRestart}>
            Restart session
          </button>
        )}
      </div>
      <span className="terminal-header-path" title={session.launchPath}>
        {session.launchPath}
      </span>
      {showBypass && <div className="agent-bypass-status agent-bypass-status--destructive terminal-header-bypass">{BYPASS_WARNING_TEXT}</div>}
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
  const sessions = useAppStore((state) => state.appState.sessions)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const restoreSession = useAppStore((state) => state.restoreSession)

  const [mountedSessionIds, setMountedSessionIds] = useState<string[]>([])
  const entriesRef = useRef<Map<string, TerminalEntry>>(new Map())
  const hostRefCallbacks = useRef<Map<string, (element: HTMLDivElement | null) => void>>(new Map())

  const applyFit = (sessionId: string): void => {
    const entry = entriesRef.current.get(sessionId)
    if (!entry) return
    entry.fitAddon.fit()
    const dimensions = entry.fitAddon.proposeDimensions()
    if (!dimensions) return
    const { cols, rows } = dimensions
    if (cols <= 0 || rows <= 0) return
    if (cols === entry.lastCols && rows === entry.lastRows) return
    entry.lastCols = cols
    entry.lastRows = rows
    window.codefly.resizeTerminal(sessionId, cols, rows)
  }

  const ensureEntry = (sessionId: string, element: HTMLDivElement): void => {
    if (entriesRef.current.has(sessionId)) return

    const terminal = new Terminal({ convertEol: true, cursorBlink: true })
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

  // Fit on activation: runs whenever the active session changes AND whenever a new entry
  // becomes available (mountedSessionIds grows), since entry creation happens one render
  // after the id above is first tracked (the host div only mounts once its pane renders).
  useEffect(() => {
    if (!activeSessionId) return
    if (!entriesRef.current.has(activeSessionId)) return
    applyFit(activeSessionId)
  }, [activeSessionId, mountedSessionIds])

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
    }
    setMountedSessionIds((previous) => previous.filter((id) => !staleIds.includes(id)))
  }, [sessions, mountedSessionIds])

  // Subscribe to terminal data/exit exactly once and dispatch by session ID; dispose every
  // remaining entry and both subscriptions on unmount.
  useEffect(() => {
    const disposeData = window.codefly.onTerminalData(({ sessionId, data }) => {
      entriesRef.current.get(sessionId)?.terminal.write(data)
    })
    const disposeExit = window.codefly.onTerminalExit(({ sessionId, exitCode }) => {
      // The session record's status flips to 'stopped' via the main process's broadcast
      // state (session-coordinator marks it on PTY exit), which drives the header's restart
      // action; here we only append a notice to the owning terminal's own scrollback. The
      // entry itself is deliberately NOT disposed, preserving the visible xterm contents.
      entriesRef.current.get(sessionId)?.terminal.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`)
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
    }
  }, [])

  return (
    <div className="terminal-workspace" data-testid="terminal-workspace">
      {mountedSessionIds.length === 0 && (
        <div className="terminal-empty-state">
          <p>Select or start a session to see its terminal here.</p>
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
