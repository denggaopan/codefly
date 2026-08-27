import { useAppStore } from '../store/use-app-store'

export const BYPASS_WARNING_TEXT = 'Permissions and sandbox bypass enabled'

/**
 * Persistent bottom-of-workspace disclosure that the active Claude/Codex session is
 * running with permission and sandbox protections bypassed. Renders nothing unless the
 * active session is a RUNNING claude or codex session (spec: absent for stopped sessions,
 * PowerShell, Command Prompt, or no active session).
 */
export default function AgentBypassStatus() {
  // Select the raw sessions array and activeSessionId separately, then derive the match in
  // the render body: a selector returning a freshly computed value on every call (even one
  // that is often referentially stable, like Array#find) risks defeating
  // useSyncExternalStore's equality check the moment it isn't, so keep selectors to plain
  // field reads and do the derivation below.
  const sessions = useAppStore((state) => state.appState.sessions)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const activeSession = sessions.find((session) => session.id === activeSessionId)

  if (!activeSession) return null
  if (activeSession.status !== 'running') return null
  if (activeSession.kind !== 'claude' && activeSession.kind !== 'codex') return null

  return (
    <div className="agent-bypass-status agent-bypass-status--destructive" role="status">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" className="agent-bypass-icon">
        <path
          d="M12 3 1 21h22L12 3zm0 6.5v5.5m0 3h.01"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="agent-bypass-status-text">{BYPASS_WARNING_TEXT}</span>
    </div>
  )
}
