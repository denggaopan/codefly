import type { SessionRecord } from '../../shared/contracts'

/**
 * The disclosure shown while an interactive Claude/Codex session runs with its fixed
 * permission/sandbox bypass flag. Rendered as a compact warning badge in the active
 * session's terminal header for the whole lifetime of the running session.
 */
export const BYPASS_WARNING_TEXT = 'Permissions and sandbox bypass enabled'

const isAgentKind = (kind: SessionRecord['kind']): boolean => kind === 'claude' || kind === 'codex'

/**
 * A running Claude/Codex session whose PTY output has been quiet for the store's idle
 * window (`agentIdle`) is presented as Done — the agent finished its current work and is
 * waiting for input. Shells idle constantly at their prompt, so the flag only ever applies
 * to agent kinds; every non-running status keeps its own label regardless of idleness.
 */
export const isAgentDone = (session: SessionRecord, agentIdle: boolean): boolean =>
  agentIdle && session.status === 'running' && isAgentKind(session.kind)

/**
 * Shared presentation logic for a session's runtime status, used by both the sidebar row
 * (ProjectSidebar) and the terminal header (TerminalWorkspace) so the same session never
 * shows two different status strings.
 */
export const sessionStatusLabel = (session: SessionRecord, agentIdle = false): string => {
  switch (session.status) {
    case 'running':
      return isAgentDone(session, agentIdle) ? 'Done' : 'Running'
    case 'stopped':
      return 'Click to restore'
    case 'creating':
      return 'Starting…'
    case 'missing':
      return 'Path missing'
    case 'error':
      return session.lastError ?? 'Error'
    default:
      return session.status
  }
}

/**
 * A session is restartable (click-to-restore in the sidebar, the header's restart action)
 * for every status except 'running' (already live) and 'creating' (a start is already in
 * flight).
 */
export const isSessionRestartable = (session: SessionRecord): boolean => session.status !== 'running' && session.status !== 'creating'
