import { useAppStore } from '../store/use-app-store'
import SessionLauncher from './SessionLauncher'

/**
 * Top window chrome: the CodeFly mark, tabs for currently running sessions, and the
 * launcher trigger. The launcher creates a session in whichever project is currently
 * "active" (selected via a project row or the most recently touched session/project), so
 * the plus button is disabled until a project has been selected.
 */
export default function TitleBar() {
  // Select the raw sessions array (a stable reference from the store) and filter in the
  // render body rather than inside the selector: a selector that returns a fresh array
  // literal every call defeats useSyncExternalStore's reference-equality check and causes
  // React to re-render (and re-select) forever.
  const sessions = useAppStore((state) => state.appState.sessions)
  const runningSessions = sessions.filter((session) => session.status === 'running')
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const launcherOpen = useAppStore((state) => state.launcherOpen)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const closeLauncher = useAppStore((state) => state.closeLauncher)
  const setActiveSession = useAppStore((state) => state.setActiveSession)

  return (
    <header className="title-bar">
      <div className="title-bar-brand">CodeFly</div>
      <div className="title-bar-tabs" role="tablist" aria-label="Open sessions">
        {runningSessions.map((session) => (
          <button
            key={session.id}
            type="button"
            role="tab"
            className="title-bar-tab"
            aria-selected={session.id === activeSessionId}
            title={session.title}
            onClick={() => setActiveSession(session.id, session.projectId)}
          >
            {session.title}
          </button>
        ))}
      </div>
      <div className="title-bar-launcher">
        <button
          type="button"
          className="title-bar-plus"
          aria-label="New session"
          aria-haspopup="true"
          aria-expanded={launcherOpen}
          disabled={!activeProjectId}
          onClick={() => (launcherOpen ? closeLauncher() : openLauncher())}
        >
          +
        </button>
        {launcherOpen && activeProjectId && <SessionLauncher projectId={activeProjectId} />}
      </div>
    </header>
  )
}
