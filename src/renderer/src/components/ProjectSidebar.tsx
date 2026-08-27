import { useEffect, useRef, useState } from 'react'

import type { SessionRecord } from '../../../shared/contracts'
import vscodeIconUrl from '../assets/vscode.svg'
import { isSessionRestartable, sessionStatusLabel } from '../session-status'
import { useAppStore } from '../store/use-app-store'
import ConfirmDialog from './ConfirmDialog'
import SessionLauncher from './SessionLauncher'

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

const vscodeHintId = (projectId: string): string => `vscode-hint-${projectId}`

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
  onRequestDelete: (trigger: HTMLButtonElement) => void
}

function SessionRow({ session, active, onActivate, onRequestDelete }: SessionRowProps) {
  const secondary = session.mode === 'worktree' ? session.worktreeName : 'Ordinary session'

  // The row is a plain <li>: its label and delete action are SIBLING <button> elements
  // rather than a delete button nested inside a role="button" container. An element with
  // role="button" must not have focusable descendants (screen readers flatten/misreport
  // that), and native <button> elements get keyboard (Enter/Space) activation for free, so
  // no manual onKeyDown is needed here either.
  return (
    <li className="session-row">
      <button type="button" className="session-row-content" aria-current={active ? 'true' : undefined} onClick={onActivate}>
        <span aria-hidden="true" className="session-kind-icon">
          {sessionKindGlyph(session.kind)}
        </span>
        <span className="session-title" title={session.title}>
          {session.title}
        </span>
        <span className="session-secondary" title={secondary}>
          {secondary}
        </span>
        <span className="session-status" data-status={session.status}>
          {sessionStatusLabel(session)}
        </span>
      </button>
      <button
        type="button"
        className="session-delete"
        aria-label={`Delete ${session.title}`}
        onClick={(event) => {
          event.stopPropagation()
          onRequestDelete(event.currentTarget)
        }}
      >
        ×
      </button>
    </li>
  )
}

/**
 * Left navigation: session search, project groups with their sessions, and a round
 * Add Project action docked at the bottom-left.
 * Each row's label and its trailing action button(s) are SIBLING <button> elements (never
 * one button nested inside another interactively-roled element), so every stopPropagation()
 * call below is defensive rather than load-bearing: it keeps a click on VS Code/folder/
 * expand/delete from ever being interpreted as also activating the row, even if the DOM
 * nesting changes later.
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
  const launcherOpen = useAppStore((state) => state.launcherOpen)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const closeLauncher = useAppStore((state) => state.closeLauncher)

  const [collapsedProjectIds, setCollapsedProjectIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null)

  // Focus restoration for the launcher: whichever project-row "+" trigger opened it gets
  // keyboard/screen-reader focus back when the launcher closes (close button, Escape, or a
  // successful creation collapsing it), instead of focus being dropped to <body>.
  const launcherTriggerRef = useRef<HTMLButtonElement | null>(null)
  const wasLauncherOpenRef = useRef(false)

  useEffect(() => {
    if (wasLauncherOpenRef.current && !launcherOpen) {
      launcherTriggerRef.current?.focus()
      launcherTriggerRef.current = null
    }
    wasLauncherOpenRef.current = launcherOpen
  }, [launcherOpen])

  // Focus restoration for the delete confirmation: remembers whichever "Delete" button
  // opened it so focus can return there once the dialog closes (Cancel, Escape, or a
  // completed/failed delete that leaves the row in place), instead of being dropped to
  // <body>.
  const pendingDeleteTriggerRef = useRef<HTMLButtonElement | null>(null)

  const toggleExpanded = (projectId: string): void => {
    setCollapsedProjectIds((previous) => {
      const next = new Set(previous)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const handleRowActivate = (session: SessionRecord): void => {
    if (isSessionRestartable(session)) {
      void restoreSession(session.id)
    } else {
      setActiveSession(session.id, session.projectId)
    }
  }

  const handleRequestDelete = (session: SessionRecord, trigger: HTMLButtonElement): void => {
    pendingDeleteTriggerRef.current = trigger
    setPendingDelete(session)
  }

  const restoreDeleteTriggerFocus = (): void => {
    pendingDeleteTriggerRef.current?.focus()
    pendingDeleteTriggerRef.current = null
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const session = pendingDelete
    setPendingDelete(null)
    await deleteSession(session.id)
    restoreDeleteTriggerFocus()
  }

  const handleCancelDelete = (): void => {
    setPendingDelete(null)
    restoreDeleteTriggerFocus()
  }

  const normalizedQuery = searchQuery.trim().toLowerCase()

  return (
    <aside className="project-sidebar">
      <div className="project-sidebar-header">
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
              {/*
                Plain container: the selectable label and the action buttons are SIBLING
                <button> elements rather than three real buttons nested inside a
                role="button" div. A role="button" element must not have focusable
                descendants (screen readers flatten/misreport that, and it produces four tab
                stops where the accessible tree advertises one), so the label itself is a
                native <button> here and gets keyboard (Enter/Space) activation for free.
              */}
              <div className="project-row" data-project-row aria-current={project.id === activeProjectId ? 'true' : undefined}>
                <button type="button" className="project-row-label" onClick={() => setActiveProject(project.id)}>
                  <span className="project-name" title={project.name}>
                    {project.name}
                  </span>
                  <span className="project-path" title={project.path}>
                    {project.path}
                  </span>
                </button>
                <div className="project-actions" data-project-actions>
                  <button
                    type="button"
                    aria-label="New session"
                    aria-haspopup="true"
                    aria-expanded={launcherOpen && project.id === activeProjectId}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (launcherOpen && activeProjectId === project.id) {
                        closeLauncher()
                        return
                      }
                      launcherTriggerRef.current = event.currentTarget
                      setActiveProject(project.id)
                      openLauncher()
                    }}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label="Open project in VS Code"
                    title={capabilities.vscode.available ? undefined : capabilities.vscode.detail}
                    aria-describedby={capabilities.vscode.available ? undefined : vscodeHintId(project.id)}
                    disabled={!capabilities.vscode.available}
                    onClick={(event) => {
                      event.stopPropagation()
                      void openProjectInVSCode(project.id)
                    }}
                  >
                    <img src={vscodeIconUrl} alt="" width={16} height={16} className="icon icon-vscode" />
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
                {launcherOpen && activeProjectId === project.id && <SessionLauncher projectId={project.id} />}
              </div>

              {/*
                Visible (not hover-only) explanation for a disabled tool: the `title`
                attribute above still gives mouse users a native tooltip, but an
                unauthenticated/missing VS Code install needs to be discoverable without
                hovering, matching SessionLauncher's visible capability-detail text.
              */}
              {!capabilities.vscode.available && (
                <p className="project-action-hint" id={vscodeHintId(project.id)}>
                  {capabilities.vscode.detail}
                </p>
              )}

              {expanded && (
                <ul className="session-list">
                  {visibleSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={session.id === activeSessionId}
                      onActivate={() => handleRowActivate(session)}
                      onRequestDelete={(trigger) => handleRequestDelete(session, trigger)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <div className="project-sidebar-footer">
        <button type="button" className="add-project-fab" aria-label="Add Project" title="Add Project" onClick={() => void addProject()}>
          +
        </button>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete session"
        description={pendingDelete ? `Delete "${pendingDelete.title}"? This cannot be undone.` : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleConfirmDelete()}
        onCancel={handleCancelDelete}
      />
    </aside>
  )
}
