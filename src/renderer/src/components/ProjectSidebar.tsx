import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { SessionRecord } from '../../../shared/contracts'
import optionsIconUrl from '../assets/options.svg'
import sessionIconUrl from '../assets/session.svg'
import vscodeIconUrl from '../assets/vscode.svg'
import { isAgentDone, isSessionRestartable, sessionStatusLabel } from '../session-status'
import { sessionKindIconUrl } from '../session-kind-icons'
import { useAppStore } from '../store/use-app-store'
import ConfirmDialog from './ConfirmDialog'
import SessionLauncher from './SessionLauncher'

const vscodeHintId = (projectId: string): string => `vscode-hint-${projectId}`
const PROJECT_OPTIONS_GAP = 6

type ProjectOptionsLayout = {
  placement: 'below' | 'above'
  maxHeight: number | null
}

function FolderGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" className="icon icon-folder">
      <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z" fill="currentColor" />
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
  const agentIdle = useAppStore((state) => state.idleAgentSessionIds[session.id] === true)
  const secondary = session.mode === 'worktree' ? session.worktreeName : 'Ordinary session'

  // The row is a plain <li>: its label and delete action are SIBLING <button> elements
  // rather than a delete button nested inside a role="button" container. An element with
  // role="button" must not have focusable descendants (screen readers flatten/misreport
  // that), and native <button> elements get keyboard (Enter/Space) activation for free, so
  // no manual onKeyDown is needed here either.
  return (
    <li className="session-row">
      <button type="button" className="session-row-content" aria-current={active ? 'true' : undefined} onClick={onActivate}>
        <span aria-hidden="true" className="session-kind-icon" data-kind={session.kind}>
          <img src={sessionKindIconUrl(session.kind)} alt="" width={16} height={16} />
        </span>
        <span className="session-title" title={session.title}>
          {session.title}
        </span>
        <span className="session-secondary" title={secondary}>
          {secondary}
        </span>
        <span className="session-status" data-status={isAgentDone(session, agentIdle) ? 'done' : session.status}>
          {sessionStatusLabel(session, agentIdle)}
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
 * Each project label and options trigger are sibling buttons, with menu and launcher sibling
 * popovers. Every stopPropagation() call is defensive rather than load-bearing: it keeps a
 * click on an action from ever being interpreted as also activating the row, even if the DOM
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
  const reorderProjects = useAppStore((state) => state.reorderProjects)
  const setActiveSession = useAppStore((state) => state.setActiveSession)
  const restoreSession = useAppStore((state) => state.restoreSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const openProjectInVSCode = useAppStore((state) => state.openProjectInVSCode)
  const openProjectFolder = useAppStore((state) => state.openProjectFolder)
  const dismissNotice = useAppStore((state) => state.dismissNotice)
  const launcherOpen = useAppStore((state) => state.launcherOpen)
  const openLauncher = useAppStore((state) => state.openLauncher)

  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null)
  const [openOptionsProjectId, setOpenOptionsProjectId] = useState<string | null>(null)
  const [optionsMenuLayout, setOptionsMenuLayout] = useState<ProjectOptionsLayout>({ placement: 'below', maxHeight: null })
  const [launcherFocusRequest, setLauncherFocusRequest] = useState(0)
  const optionsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const optionsMenuRef = useRef<HTMLDivElement | null>(null)
  const projectGroupsRef = useRef<HTMLDivElement | null>(null)

  const closeProjectOptions = (restoreFocus = false): void => {
    if (restoreFocus) optionsTriggerRef.current?.focus()
    setOpenOptionsProjectId(null)
  }

  // Project drag-reordering: the whole project row is the drag handle unless the pointer began
  // in the options trigger, menu, or launcher. Dragging is disabled while a search filter is
  // active — the filtered view hides rows, so a drop position would be ambiguous.
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ projectId: string; position: 'before' | 'after' } | null>(null)
  const dragOriginIsExemptRef = useRef(false)

  // Focus restoration for the launcher: the project options trigger that opened it gets
  // keyboard/screen-reader focus back when the launcher closes (close button, Escape, or a
  // successful creation collapsing it), instead of focus being dropped to <body>.
  const launcherTriggerRef = useRef<HTMLButtonElement | null>(null)
  const wasLauncherOpenRef = useRef(false)

  useEffect(() => {
    if (launcherOpen) {
      launcherTriggerRef.current
        ?.closest<HTMLElement>('[data-project-row]')
        ?.querySelector<HTMLButtonElement>('[data-launcher-item] button:not(:disabled)')
        ?.focus()
    } else if (wasLauncherOpenRef.current && !launcherOpen) {
      launcherTriggerRef.current?.focus()
      launcherTriggerRef.current = null
    }
    wasLauncherOpenRef.current = launcherOpen
  }, [launcherFocusRequest, launcherOpen])

  useEffect(() => {
    if (!openOptionsProjectId) return

    const menu = optionsMenuRef.current
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Node &&
        (menu?.contains(target) || optionsTriggerRef.current?.contains(target))
      ) {
        return
      }
      closeProjectOptions()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [openOptionsProjectId])

  // The menu remains inside the sidebar's scrolling project area even when its row sits at
  // the scrollport edge. Layout timing prevents a visible below-then-above placement flash.
  useLayoutEffect(() => {
    if (!openOptionsProjectId) return

    const menu = optionsMenuRef.current
    const scrollport = projectGroupsRef.current
    const row = menu?.closest<HTMLElement>('[data-project-row]')
    if (!menu || !scrollport || !row) return
    const trigger = row.querySelector<HTMLElement>('.project-options-trigger')
    if (!trigger) {
      setOpenOptionsProjectId(null)
      return
    }

    const updateLayout = (): void => {
      const rowRect = row.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const scrollportRect = scrollport.getBoundingClientRect()
      // A zero-height browser layout has no visible anchor; a layoutless test DOM has no
      // client rect at all and cannot provide meaningful visibility geometry.
      const scrollportHasLayout = scrollport.getClientRects().length > 0
      if (
        scrollportHasLayout &&
        (scrollportRect.height <= 0 || triggerRect.bottom <= scrollportRect.top || triggerRect.top >= scrollportRect.bottom)
      ) {
        // The trigger is no longer visible, so leave focus alone rather than restoring it to
        // an offscreen row while dismissing the clipped menu.
        setOpenOptionsProjectId(null)
        return
      }

      const menuRect = menu.getBoundingClientRect()
      const menuScrollHeight = menu.scrollHeight
      const menuStyle = window.getComputedStyle(menu)
      const verticalBorders = (Number.parseFloat(menuStyle.borderTopWidth) || 0) + (Number.parseFloat(menuStyle.borderBottomWidth) || 0)
      // scrollHeight excludes borders, while max-height uses the app-wide border-box sizing.
      // It therefore remains the stable natural content/padding height after a prior clamp.
      const naturalMenuHeight = menuScrollHeight > 0 ? menuScrollHeight + verticalBorders : menuRect.height
      const belowSpace = Math.max(0, scrollportRect.bottom - rowRect.bottom - PROJECT_OPTIONS_GAP)
      const aboveSpace = Math.max(0, rowRect.top - scrollportRect.top - PROJECT_OPTIONS_GAP)
      const placement = belowSpace >= naturalMenuHeight || belowSpace >= aboveSpace ? 'below' : 'above'
      const availableSpace = placement === 'below' ? belowSpace : aboveSpace
      const maxHeight = availableSpace >= naturalMenuHeight ? null : Math.floor(availableSpace)

      setOptionsMenuLayout((current) =>
        current.placement === placement && current.maxHeight === maxHeight ? current : { placement, maxHeight }
      )
    }

    updateLayout()
    scrollport.addEventListener('scroll', updateLayout)
    window.addEventListener('resize', updateLayout)
    return () => {
      scrollport.removeEventListener('scroll', updateLayout)
      window.removeEventListener('resize', updateLayout)
    }
  }, [openOptionsProjectId])

  useEffect(() => {
    if (openOptionsProjectId && !appState.projects.some((project) => project.id === openOptionsProjectId)) {
      setOpenOptionsProjectId(null)
    }
  }, [appState.projects, openOptionsProjectId])

  // Focus restoration for the delete confirmation: remembers whichever "Delete" button
  // opened it so focus can return there once the dialog closes (Cancel, Escape, or a
  // completed/failed delete that leaves the row in place), instead of being dropped to
  // <body>.
  const pendingDeleteTriggerRef = useRef<HTMLButtonElement | null>(null)

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
  const dragEnabled = normalizedQuery === ''

  const clearDragState = (): void => {
    dragOriginIsExemptRef.current = false
    setDraggingProjectId(null)
    setDropTarget(null)
  }

  const handleProjectOptionsMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeProjectOptions(true)
      return
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()

    const menuItems = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (menuItems.length === 0) return

    const activeIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = activeIndex === -1 || activeIndex === menuItems.length - 1 ? 0 : activeIndex + 1
        break
      case 'ArrowUp':
        nextIndex = activeIndex <= 0 ? menuItems.length - 1 : activeIndex - 1
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = menuItems.length - 1
        break
      default:
        return
    }
    menuItems[nextIndex]?.focus()
  }

  const handleProjectOptionsMenuBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
      closeProjectOptions()
    }
  }

  const handleRowPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragOriginIsExemptRef.current =
      event.target instanceof Element && event.target.closest('[data-project-actions], .project-options-menu, .session-launcher') !== null
  }

  const clearDragOrigin = (): void => {
    dragOriginIsExemptRef.current = false
  }

  const handleRowDragStart = (event: React.DragEvent<HTMLDivElement>, projectId: string): void => {
    if (dragOriginIsExemptRef.current) {
      event.preventDefault()
      event.stopPropagation()
      clearDragState()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', projectId)
    setDraggingProjectId(projectId)
  }

  const handleRowDragOver = (event: React.DragEvent<HTMLDivElement>, projectId: string): void => {
    if (!draggingProjectId || draggingProjectId === projectId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (dropTarget?.projectId !== projectId || dropTarget.position !== position) {
      setDropTarget({ projectId, position })
    }
  }

  const handleRowDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (!draggingProjectId || !dropTarget) {
      clearDragState()
      return
    }
    const orderedIds = appState.projects.map((project) => project.id).filter((id) => id !== draggingProjectId)
    const targetIndex = orderedIds.indexOf(dropTarget.projectId)
    if (targetIndex === -1) {
      clearDragState()
      return
    }
    orderedIds.splice(dropTarget.position === 'before' ? targetIndex : targetIndex + 1, 0, draggingProjectId)
    const changed = orderedIds.some((id, index) => appState.projects[index]?.id !== id)
    if (changed) void reorderProjects(orderedIds)
    clearDragState()
  }

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

      <div className="project-groups" ref={projectGroupsRef}>
        {appState.projects.map((project) => {
          // Accordion: activating a project (clicking its row, creating a session, or one of
          // its sessions) expands it and collapses every other project. Before anything is
          // active, every group shows. An active search overrides collapse so matches in
          // every project stay discoverable.
          const expanded = activeProjectId === null || project.id === activeProjectId || normalizedQuery !== ''
          const sessions = appState.sessions.filter((session) => session.projectId === project.id)
          const visibleSessions = normalizedQuery
            ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
            : sessions

          return (
            <section key={project.id} className="project-group">
              {/*
                Plain container: the selectable label and options trigger are SIBLING
                <button> elements rather than real buttons nested inside a
                role="button" div. A role="button" element must not have focusable
                descendants (screen readers flatten/misreport that, and it produces two tab
                stops where the accessible tree advertises one), so the label itself is a
                native <button> here and gets keyboard (Enter/Space) activation for free.
              */}
              <div
                className="project-row"
                data-project-row
                aria-current={project.id === activeProjectId ? 'true' : undefined}
                draggable={dragEnabled}
                data-dragging={draggingProjectId === project.id ? 'true' : undefined}
                data-drop={dropTarget?.projectId === project.id ? dropTarget.position : undefined}
                onDragStart={(event) => handleRowDragStart(event, project.id)}
                onDragOver={(event) => handleRowDragOver(event, project.id)}
                onDrop={handleRowDrop}
                onDragEnd={clearDragState}
                onPointerDownCapture={handleRowPointerDownCapture}
                onPointerUp={clearDragOrigin}
                onPointerCancel={clearDragOrigin}
              >
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
                    className="project-options-trigger"
                    aria-label={`Project options for ${project.name}`}
                    aria-haspopup="menu"
                    aria-expanded={openOptionsProjectId === project.id}
                    onPointerDown={(event) => {
                      if (openOptionsProjectId === project.id) event.preventDefault()
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      optionsTriggerRef.current = event.currentTarget
                      if (openOptionsProjectId === project.id) {
                        closeProjectOptions(true)
                      } else {
                        setOptionsMenuLayout({ placement: 'below', maxHeight: null })
                        setOpenOptionsProjectId(project.id)
                      }
                    }}
                  >
                    <img src={optionsIconUrl} alt="" width={16} height={16} className="icon icon-options" />
                  </button>
                </div>
                {openOptionsProjectId === project.id && (
                  <div
                    className="project-options-menu"
                    role="menu"
                    aria-label={`Project options for ${project.name}`}
                    data-placement={optionsMenuLayout.placement}
                    data-clamped={optionsMenuLayout.maxHeight !== null}
                    style={
                      {
                        '--project-options-menu-max-height':
                          optionsMenuLayout.maxHeight === null ? undefined : `${optionsMenuLayout.maxHeight}px`
                      } as React.CSSProperties
                    }
                    ref={optionsMenuRef}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={handleProjectOptionsMenuKeyDown}
                    onBlur={handleProjectOptionsMenuBlur}
                  >
                    <button
                      type="button"
                      className="project-options-menu-item"
                      role="menuitem"
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation()
                        launcherTriggerRef.current = optionsTriggerRef.current
                        setOpenOptionsProjectId(null)
                        setActiveProject(project.id)
                        openLauncher()
                        setLauncherFocusRequest((request) => request + 1)
                      }}
                    >
                      <img src={sessionIconUrl} alt="" width={16} height={16} className="icon icon-session" />
                      New session
                    </button>
                    <button
                      type="button"
                      className="project-options-menu-item"
                      role="menuitem"
                      title={capabilities.vscode.available ? undefined : capabilities.vscode.detail}
                      aria-describedby={capabilities.vscode.available ? undefined : vscodeHintId(project.id)}
                      disabled={!capabilities.vscode.available}
                      tabIndex={-1}
                      onPointerDown={(event) => {
                        if (!capabilities.vscode.available) event.preventDefault()
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        closeProjectOptions(true)
                        void openProjectInVSCode(project.id)
                      }}
                    >
                      <img src={vscodeIconUrl} alt="" width={16} height={16} className="icon icon-vscode" />
                      Open project in VS Code
                    </button>
                    <button
                      type="button"
                      className="project-options-menu-item"
                      role="menuitem"
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation()
                        closeProjectOptions(true)
                        void openProjectFolder(project.id)
                      }}
                    >
                      <FolderGlyph />
                      Open project folder
                    </button>
                  </div>
                )}
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
