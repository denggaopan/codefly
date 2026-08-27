import type { SessionRecord } from '../../shared/contracts'

/**
 * The disclosure shown while an interactive Claude/Codex session runs with its fixed
 * permission/sandbox bypass flag. Rendered as a compact warning badge in the active
 * session's terminal header for the whole lifetime of the running session.
 */
export const BYPASS_WARNING_TEXT = 'Permissions and sandbox bypass enabled'

/**
 * Shared presentation logic for a session's runtime status, used by both the sidebar row
 * (ProjectSidebar) and the terminal header (TerminalWorkspace) so the same session never
 * shows two different status strings.
 */
export const sessionStatusLabel = (session: SessionRecord): string => {
  switch (session.status) {
    case 'running':
      return 'Running'
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
