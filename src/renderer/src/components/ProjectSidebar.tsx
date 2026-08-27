import { useState, type KeyboardEvent } from 'react'

import type { SessionRecord } from '../../../shared/contracts'
import { useAppStore } from '../store/use-app-store'
import ConfirmDialog from './ConfirmDialog'

const sessionStatusLabel = (session: SessionRecord): string => {
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

const sessionKindGlyph = (kind: SessionRecord['kind']): string => {
  switch (kind) {
    case 'powershell':
      return 'PS'
    case 'cmd':
      return 'CMD'
    case 'claude':
      return 'CL'
    case 'codex':
      return 'CX'
    default:
      return '?'
  }
}

function VSCodeGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" className="icon icon-vscode">
      <path d="M17 3l4 2v14l-4 2-9-8 9-8z" fill="currentColor" />
    </svg>
  )
}

function FolderGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" className="icon icon-folder">
      <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z" fill="currentColor" />
    </svg>
  )
}

function ChevronGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      className={expanded ? 'icon icon-chevron icon-chevron--expanded' : 'icon icon-chevron'}
    >
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

type SessionRowProps = {
  session: SessionRecord
  active: boolean
  onActivate: () => void
  onRequestDelete: () => void
}

function SessionRow({ session, active, onActivate, onRequestDelete }: SessionRowProps) {
  const secondary = session.mode === 'worktree' ? session.worktreeName : 'Ordinary session'

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onActivate()
    }
  }

  return (
    <li className="session-row">
      <div
        className="session-row-content"
        role="button"
        tabIndex={0}
        aria-current={active ? 'true' : undefined}
        onClick={onActivate}
        onKeyDown={handleKeyDown}
      >
        <span aria-hidden="true" className="session-kind-icon">
          {sessionKindGlyph(session.kind)}
        </span>
        <span className="session-title" title={session.title}>
          {session.title}
        </span>
        <span className="session-secondary">{secondary}</span>
        <span className="session-status">{sessionStatusLabel(session)}</span>
        <button
          type="button"
          className="session-delete"
          aria-label={`Delete ${session.title}`}
          onClick={(event) => {
            event.stopPropagation()
            onRequestDelete()
          }}
        >
          ×
        </button>
      </div>
    </li>
  )
}

/**
 * Left navigation: Add Project, session search, and project groups with their sessions.
 * Project-row actions (VS Code, folder, expand) and the session delete action all
 * stopPropagation() because they sit inside a clickable row that otherwise selects the
 * project or activates the session.
 */
export default function ProjectSidebar() {
  const appState = useAppStore((state) => state.appState)
  const capabilities = useAppStore((state) => state.capabilities)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const searchQuery = useAppStore((state) => state.searchQuery)
  const notice = useAppStore((state) => state.notice)
  const setSearchQuery = useAppStore((state) => state.setSearchQuery)
  const addProject = useAppStore((state) => state.addProject)
  const setActiveProject = useAppStore((state) => state.setActiveProject)
  const setActiveSession = useAppStore((state) => state.setActiveSession)
  const restoreSession = useAppStore((state) => state.restoreSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const openProjectInVSCode = useAppStore((state) => state.openProjectInVSCode)
  const openProjectFolder = useAppStore((state) => state.openProjectFolder)
  const dismissNotice = useAppStore((state) => state.dismissNotice)

  const [collapsedProjectIds, setCollapsedProjectIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null)

  const toggleExpanded = (projectId: string): void => {
    setCollapsedProjectIds((previous) => {
      const next = new Set(previous)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const handleRowActivate = (session: SessionRecord): void => {
    if (session.status === 'running' || session.status === 'creating') {
      setActiveSession(session.id, session.projectId)
    } else {
      void restoreSession(session.id)
    }
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const session = pendingDelete
    setPendingDelete(null)
    await deleteSession(session.id)
  }

  const normalizedQuery = searchQuery.trim().toLowerCase()

  return (
    <aside className="project-sidebar">
      <div className="project-sidebar-header">
        <button type="button" className="add-project-button" onClick={() => void addProject()}>
          Add Project
        </button>
        <input
          type="search"
          className="session-search"
          aria-label="Search sessions"
          placeholder="Search sessions"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
      </div>

      {notice && (
        <div className="sidebar-notice" role="alert">
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss notice" onClick={dismissNotice}>
            ×
          </button>
        </div>
      )}

      <div className="project-groups">
        {appState.projects.map((project) => {
          const expanded = !collapsedProjectIds.has(project.id)
          const sessions = appState.sessions.filter((session) => session.projectId === project.id)
          const visibleSessions = normalizedQuery
            ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
            : sessions

          return (
            <section key={project.id} className="project-group">
              <div
                className="project-row"
                data-project-row
                role="button"
                tabIndex={0}
                aria-current={project.id === activeProjectId ? 'true' : undefined}
                onClick={() => setActiveProject(project.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveProject(project.id)
                  }
                }}
              >
                <span className="project-name" title={project.name}>
                  {project.name}
                </span>
                <span className="project-path" title={project.path}>
                  {project.path}
                </span>
                <div className="project-actions">
                  <button
                    type="button"
                    aria-label="Open project in VS Code"
                    title={capabilities.vscode.available ? undefined : capabilities.vscode.detail}
                    disabled={!capabilities.vscode.available}
                    onClick={(event) => {
                      event.stopPropagation()
                      void openProjectInVSCode(project.id)
                    }}
                  >
                    <VSCodeGlyph />
                  </button>
                  <button
                    type="button"
                    aria-label="Open project folder"
                    onClick={(event) => {
                      event.stopPropagation()
                      void openProjectFolder(project.id)
                    }}
                  >
                    <FolderGlyph />
                  </button>
                  <button
                    type="button"
                    aria-label={expanded ? 'Collapse sessions' : 'Expand sessions'}
                    aria-expanded={expanded}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleExpanded(project.id)
                    }}
                  >
                    <ChevronGlyph expanded={expanded} />
                  </button>
                </div>
              </div>

              {expanded && (
                <ul className="session-list">
                  {visibleSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={session.id === activeSessionId}
                      onActivate={() => handleRowActivate(session)}
                      onRequestDelete={() => setPendingDelete(session)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete session"
        description={pendingDelete ? `Delete "${pendingDelete.title}"? This cannot be undone.` : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </aside>
  )
}
