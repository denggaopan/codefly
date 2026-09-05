import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ProjectRecord, SessionRecord } from '../../../shared/contracts'
import closeIconUrl from '../assets/close.svg'
import optionsIconUrl from '../assets/options.svg'
import removeIconUrl from '../assets/remove.svg'
import sessionIconUrl from '../assets/session.svg'
import vscodeIconUrl from '../assets/vscode.svg'
import { useTranslation } from '../i18n/use-translation'
import { repoHostIcon } from '../repo-host-icons'
import { isAgentDone, isSessionRestartable, sessionStatusLabel } from '../session-status'
import { sessionKindIconUrl } from '../session-kind-icons'
import { useAppStore } from '../store/use-app-store'
import ConfirmDialog from './ConfirmDialog'
import AddProjectDialog from './AddProjectDialog'
import SessionLauncher from './SessionLauncher'

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
  const { t } = useTranslation()
  const agentIdle = useAppStore((state) => state.idleAgentSessionIds[session.id] === true)
  // A worktree's branch name is user data, never translated; only the ordinary-session
  // fallback is UI copy.
  const secondary = session.mode === 'worktree' ? session.worktreeName : t('sidebar.ordinarySession')

  // The row is a plain <li>: its label and delete action are SIBLING <button> elements
  // rather than a delete button nested inside a role="button" container. An element with
  // role="button" must not have focusable descendants (screen readers flatten/misreport
  // that), and native <button> elements get keyboard (Enter/Space) activation for free, so
  // no manual onKeyDown is needed here either.
  // The status is carried by a coloured dot badged onto the top-right corner of the kind
  // icon rather than a text pill. Colour alone is not an accessible signal, so the dot keeps
  // the very same status string the pill used to render: as its accessible name
  // (role="img" + aria-label, which overrides the decorative bullet glyph for screen
  // readers) and as its hover tooltip. The dot therefore sits NEXT TO the aria-hidden kind
  // icon inside a shared positioning wrapper -- nesting it inside the icon would hide its
  // label from screen readers along with the icon.
  const statusLabel = sessionStatusLabel(t, session, agentIdle)

  return (
    <li className="session-row" data-active={active ? 'true' : undefined}>
      <button type="button" className="session-row-content" aria-current={active ? 'true' : undefined} onClick={onActivate}>
        <span className="session-icon">
          <span aria-hidden="true" className="session-kind-icon" data-kind={session.kind}>
            <img src={sessionKindIconUrl(session.kind)} alt="" width={16} height={16} />
          </span>
          <span
            className="session-status-dot"
            data-status={isAgentDone(session, agentIdle) ? 'done' : session.status}
            role="img"
            aria-label={statusLabel}
            title={statusLabel}
          >
            &bull;
          </span>
        </span>
        <span className="session-title" title={session.title}>
          {session.title}
        </span>
        <span className="session-secondary" title={secondary}>
          {secondary}
        </span>
      </button>
      <button
        type="button"
        className="session-delete"
        aria-label={t('sidebar.deleteSessionAria', { title: session.title })}
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
  const { t } = useTranslation()
  const platform = useAppStore((state) => state.platform)
  const appState = useAppStore((state) => state.appState)
  const capabilities = useAppStore((state) => state.capabilities)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const searchQuery = useAppStore((state) => state.searchQuery)
  const notice = useAppStore((state) => state.notice)
  const setSearchQuery = useAppStore((state) => state.setSearchQuery)
  const setActiveProject = useAppStore((state) => state.setActiveProject)
  const reorderProjects = useAppStore((state) => state.reorderProjects)
  const setActiveSession = useAppStore((state) => state.setActiveSession)
  const restoreSession = useAppStore((state) => state.restoreSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const openProjectInVSCode = useAppStore((state) => state.openProjectInVSCode)
  const openProjectFolder = useAppStore((state) => state.openProjectFolder)
  const openProjectRepository = useAppStore((state) => state.openProjectRepository)
  const removeProject = useAppStore((state) => state.removeProject)
  const createSession = useAppStore((state) => state.createSession)
  const dismissNotice = useAppStore((state) => state.dismissNotice)
  const sessionKindPreferences = useAppStore((state) => state.sessionKindPreferences)
  const launcherOpen = useAppStore((state) => state.launcherOpen)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const closeLauncher = useAppStore((state) => state.closeLauncher)

  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null)
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<ProjectRecord | null>(null)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
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

  // Cmd+T creates an ordinary Shell session, macOS only. Windows has no counterpart: Ctrl+T is a
  // live key inside the shells and agent CLIs we host, and a document-level listener would eat it
  // before the focused terminal ever sees it.
  useEffect(() => {
    if (platform !== 'darwin') return

    const handleShortcut = (event: KeyboardEvent): void => {
      if (
        event.repeat ||
        !event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (event.code !== 'KeyT' && event.key.toLowerCase() !== 't')
      ) {
        return
      }

      if (!activeProjectId || !sessionKindPreferences.shell.enabled) return
      event.preventDefault()
      void createSession(activeProjectId, 'shell', false)
    }

    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  }, [activeProjectId, createSession, platform, sessionKindPreferences])

  useEffect(() => {
    if (launcherOpen) {
      launcherTriggerRef.current
        ?.closest<HTMLElement>('[data-project-row]')
        ?.querySelector<HTMLButtonElement>('[data-launcher-item] button:not(:disabled)')
        // preventScroll for the same reason as the options menu: the launcher is an absolutely
        // positioned popover that can sit outside the scrollport when focus lands on it.
        ?.focus({ preventScroll: true })
    } else if (wasLauncherOpenRef.current && !launcherOpen) {
      launcherTriggerRef.current?.focus()
      launcherTriggerRef.current = null
    }
    wasLauncherOpenRef.current = launcherOpen
  }, [launcherFocusRequest, launcherOpen])

  useEffect(() => {
    if (!openOptionsProjectId) return

    const menu = optionsMenuRef.current
    // preventScroll: this passive effect runs before the placement layout effect's re-render
    // commits, so the menu is still at its provisional "below" offset. Letting the browser
    // scroll it into view would jump the project list and re-enter updateLayout through the
    // scroll listener; the layout effect keeps the menu inside the scrollport by itself.
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })

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

  // "Remove from list" is the one project action that goes through a confirmation: the
  // options menu closes first (returning focus to its trigger, which is also where focus goes
  // back to on Cancel), then the dialog takes over. On confirm the row is gone, so there is
  // nothing to restore focus to.
  const handleRequestRemove = (project: ProjectRecord): void => {
    closeProjectOptions(true)
    setPendingRemove(project)
  }

  const handleConfirmRemove = async (): Promise<void> => {
    if (!pendingRemove) return
    const project = pendingRemove
    setPendingRemove(null)
    await removeProject(project.id)
  }

  const handleCancelRemove = (): void => {
    setPendingRemove(null)
    optionsTriggerRef.current?.focus()
  }

  const pendingRemoveSessionCount = pendingRemove
    ? appState.sessions.filter((session) => session.projectId === pendingRemove.id).length
    : 0
  const removePrompt = pendingRemove
    ? pendingRemoveSessionCount > 0
      ? t('sidebar.removeProjectWithSessionsPrompt', { project: pendingRemove.name, count: pendingRemoveSessionCount })
      : t('sidebar.removeProjectPrompt', { project: pendingRemove.name })
    : undefined

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
          aria-label={t('sidebar.searchSessions')}
          placeholder={t('sidebar.searchSessions')}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
      </div>

      {notice && (
        <div className="sidebar-notice" role="alert">
          <span>{notice.message}</span>
          <button type="button" aria-label={t('sidebar.dismissNotice')} onClick={dismissNotice}>
            ×
          </button>
        </div>
      )}

      <div className="project-groups" ref={projectGroupsRef}>
        {appState.projects.map((project) => {
          // Search reveals matches without changing each project's saved collapse state.
          const expanded = !collapsedProjectIds.has(project.id) || normalizedQuery !== ''
          const sessions = appState.sessions.filter((session) => session.projectId === project.id)
          const visibleSessions = normalizedQuery
            ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
            : sessions

          return (
            <section key={project.id} className="project-group">
              {/*
                Plain container: the collapse toggle and options trigger are SIBLING
                <button> elements rather than real buttons nested inside a
                role="button" div. A role="button" element must not have focusable
                descendants (screen readers flatten/misreport that, and it produces two tab
                stops where the accessible tree advertises one), so the label itself is a
                native <button> here and gets keyboard (Enter/Space) activation for free.
              */}
              <div
                className="project-row"
                data-project-row
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
                <button
                  type="button"
                  className="project-row-label"
                  aria-expanded={expanded}
                  aria-controls={`project-sessions-${project.id}`}
                  onClick={() => {
                    setCollapsedProjectIds((current) => {
                      const next = new Set(current)
                      if (next.has(project.id)) next.delete(project.id)
                      else next.add(project.id)
                      return next
                    })
                  }}
                >
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
                    aria-label={t('sidebar.projectOptions', { project: project.name })}
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
                        // The launcher anchors to the same row edge as this menu, so it is
                        // dismissed rather than left stacked underneath.
                        closeLauncher()
                        setOptionsMenuLayout({ placement: 'below', maxHeight: null })
                        setOpenOptionsProjectId(project.id)
                      }
                    }}
                  >
                    <img
                      src={openOptionsProjectId === project.id ? closeIconUrl : optionsIconUrl}
                      alt=""
                      width={16}
                      height={16}
                      className="icon icon-options"
                    />
                  </button>
                </div>
                {openOptionsProjectId === project.id && (
                  <div
                    className="project-options-menu"
                    role="menu"
                    aria-label={t('sidebar.projectOptions', { project: project.name })}
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
                      {t('sidebar.newSession')}
                    </button>
                    <button
                      type="button"
                      className="project-options-menu-item"
                      role="menuitem"
                      title={capabilities.vscode.available ? undefined : capabilities.vscode.detail}
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
                      {t('sidebar.openInVSCode')}
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
                      {t('sidebar.openProjectFolder')}
                    </button>
                    {project.repoRemote && (
                      <button
                        type="button"
                        className="project-options-menu-item"
                        role="menuitem"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation()
                          closeProjectOptions(true)
                          void openProjectRepository(project.id)
                        }}
                      >
                        <img
                          src={repoHostIcon(project.repoRemote.host).url}
                          alt=""
                          width={16}
                          height={16}
                          className={repoHostIcon(project.repoRemote.host).className}
                        />
                        {t('sidebar.openRepository')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="project-options-menu-item"
                      role="menuitem"
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation()
                        handleRequestRemove(project)
                      }}
                    >
                      <img src={removeIconUrl} alt="" width={16} height={16} className="icon icon-remove icon-mono" />
                      {t('sidebar.removeProject')}
                    </button>
                  </div>
                )}
                {launcherOpen && activeProjectId === project.id && <SessionLauncher projectId={project.id} />}
              </div>

              {expanded && (
                <ul className="session-list" id={`project-sessions-${project.id}`}>
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
        <button
          type="button"
          className="add-project-fab"
          aria-label={t('sidebar.addProject')}
          title={t('sidebar.addProject')}
          aria-haspopup="dialog"
          onClick={() => {
            closeProjectOptions()
            closeLauncher()
            setAddProjectOpen(true)
          }}
        >
          +
        </button>
      </div>

      {addProjectOpen && <AddProjectDialog onClose={() => setAddProjectOpen(false)} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('sidebar.deleteSessionTitle')}
        description={pendingDelete ? t('sidebar.deleteSessionPrompt', { title: pendingDelete.title }) : undefined}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={() => void handleConfirmDelete()}
        onCancel={handleCancelDelete}
      />

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t('sidebar.removeProjectTitle')}
        description={removePrompt}
        confirmLabel={t('common.remove')}
        destructive
        onConfirm={() => void handleConfirmRemove()}
        onCancel={handleCancelRemove}
      />
    </aside>
  )
}
