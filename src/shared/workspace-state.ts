import type { AppState, WorkspaceState } from './contracts'

export const emptyWorkspace = (): WorkspaceState => ({
  activeProjectId: null, activeSessionId: null, collapsedProjectIds: []
})

export const reconcileWorkspace = (workspace: WorkspaceState, state: AppState): WorkspaceState => {
  const projectIds = new Set(state.projects.map((project) => project.id))
  const activeSession = state.sessions.find((session) =>
    session.id === workspace.activeSessionId && projectIds.has(session.projectId)
  )
  const collapsedProjectIds = [...new Set(workspace.collapsedProjectIds.filter((id) => projectIds.has(id)))]
  return {
    activeProjectId: workspace.activeProjectId && projectIds.has(workspace.activeProjectId)
      ? workspace.activeProjectId
      : activeSession?.projectId ?? state.projects[0]?.id ?? null,
    activeSessionId: activeSession?.id ?? null,
    collapsedProjectIds: collapsedProjectIds.length === workspace.collapsedProjectIds.length
      ? workspace.collapsedProjectIds
      : collapsedProjectIds
  }
}
