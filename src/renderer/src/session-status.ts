import type { SessionRecord } from '../../shared/contracts'
import type { Translator } from './i18n'
import { en } from './i18n/en'

/**
 * The disclosure shown while an interactive Claude/Codex session runs with its fixed
 * permission/sandbox bypass flag. Rendered as a compact warning badge in the active
 * session's terminal header for the whole lifetime of the running session.
 *
 * Read off the English dictionary instead of being spelled out twice: the badge itself
 * renders the translated string, while the unit and e2e specs assert against this constant,
 * so the wording can never drift between the two.
 */
export const BYPASS_WARNING_TEXT = en['terminal.bypassWarning']

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
 * shows two different status strings. Takes a `Translator` rather than calling the React
 * hook itself so this module stays a pure function usable outside a component tree.
 *
 * `lastError` is passed through untranslated: it is a runtime message produced by the main
 * process, not UI copy with a dictionary entry.
 */
export const sessionStatusLabel = (t: Translator, session: SessionRecord, agentIdle = false): string => {
  switch (session.status) {
    case 'running':
      return isAgentDone(session, agentIdle) ? t('status.done') : t('status.running')
    case 'stopped':
      return t('status.stopped')
    case 'creating':
      return t('status.creating')
    case 'missing':
      return t('status.missing')
    case 'error':
      return session.lastError ?? t('status.error')
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
