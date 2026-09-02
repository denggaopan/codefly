import { randomUUID } from 'node:crypto'

import type { AppState, DeleteSessionResult, SessionKind, SessionRecord } from '../../shared/contracts'
import type { ProjectService } from './project-service'
import type { SessionStore } from './session-store'
import type { SessionLocation, WorktreeService } from './worktree-service'
import type { TerminalEventMap, TerminalService } from './terminal-service'
import type { TitleService } from './title-service'

export class SessionNotFoundError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

const initialTitles: Readonly<Record<SessionKind, string>> = {
  powershell: 'New PowerShell session',
  cmd: 'New Command Prompt session',
  claude: 'New Claude session',
  codex: 'New Codex session'
}

const withoutError = (session: SessionRecord): SessionRecord => {
  if (session.lastError === undefined) return session
  const { lastError: _drop, ...rest } = session
  return rest as SessionRecord
}

const buildLocationFields = (
  location: SessionLocation
): Pick<Extract<SessionRecord, { mode: 'worktree' }>, 'mode' | 'worktreeName' | 'worktreePath' | 'branchName'> | { mode: 'ordinary' } =>
  location.mode === 'worktree'
    ? {
        mode: 'worktree',
        worktreeName: location.worktreeName,
        worktreePath: location.worktreePath,
        branchName: location.branchName
      }
    : { mode: 'ordinary' }

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Per-creation options. `worktree: false` (the default) launches straight in the project
 * directory without asking WorktreeService for anything, so no branch, directory, or
 * `.git/info/exclude` entry is created for a session that did not ask for one.
 */
export type CreateSessionOptions = {
  worktree?: boolean
}

/**
 * Orchestrates the full lifecycle of a persistent session (create, restore, first-input
 * titling, stop, and delete) across SessionStore, ProjectService, WorktreeService,
 * TerminalService, and TitleService. State changes are only announced to subscribers
 * after they have been durably (and schema-validated) persisted.
 */
export class SessionCoordinator {
  private readonly listeners = new Set<(state: AppState) => void>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly titleJobs = new Set<string>()

  constructor(
    private readonly store: SessionStore,
    private readonly projectService: ProjectService,
    private readonly worktreeService: WorktreeService,
    private readonly terminalService: TerminalService,
    private readonly titleService: TitleService,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID
  ) {
    this.terminalService.on('exit', this.handleExit)
  }

  async snapshot(): Promise<AppState> {
    return this.store.load()
  }

  async create(projectId: string, kind: SessionKind, options: CreateSessionOptions = {}): Promise<SessionRecord> {
    return this.withLock(`project:${projectId}`, async () => {
      const project = await this.projectService.get(projectId)
      const current = await this.store.load()
      // WorktreeService is only consulted when a worktree was actually requested; it can
      // still answer 'ordinary' (non-Git project, no commit yet), which is why the record's
      // mode always comes from the returned location rather than from the request.
      const location: SessionLocation = options.worktree
        ? await this.worktreeService.create(project, current.sessions)
        : { mode: 'ordinary', launchPath: project.path }

      const record: SessionRecord = {
        id: this.createId(),
        projectId,
        kind,
        title: initialTitles[kind],
        titleState: 'pending',
        createdAt: this.clock().toISOString(),
        status: 'creating',
        launchPath: location.launchPath,
        ...buildLocationFields(location)
      } as SessionRecord

      await this.appendSession(record)

      try {
        await this.terminalService.start(record)
      } catch (error) {
        await this.removeSession(record.id)
        if (location.mode === 'worktree') {
          await this.worktreeService.rollback(location)
        }
        throw error
      }

      try {
        const running = await this.updateSession(record.id, (existing) => ({ ...existing, status: 'running' }))
        return running ?? { ...record, status: 'running' }
      } catch (error) {
        await this.compensateStartedSession(record.id, error)
        throw error
      }
    })
  }

  async restore(sessionId: string): Promise<SessionRecord> {
    return this.withLock(`session:${sessionId}`, async () => {
      const current = await this.store.load()
      const session = current.sessions.find((candidate) => candidate.id === sessionId)
      if (!session) throw new SessionNotFoundError(sessionId)
      if (session.status === 'running') return session

      const project = await this.projectService.get(session.projectId)
      const validity = await this.worktreeService.validate(session, project)

      if (validity === 'missing') {
        const missing = await this.updateSession(sessionId, (existing) => withoutError({ ...existing, status: 'missing' }))
        return missing ?? withoutError({ ...session, status: 'missing' })
      }

      try {
        await this.terminalService.start(session, { resume: true })
      } catch (error) {
        await this.updateSession(sessionId, (existing) => ({ ...existing, status: 'error', lastError: errorMessage(error) }))
        throw error
      }

      try {
        const running = await this.updateSession(sessionId, (existing) => withoutError({ ...existing, status: 'running' }))
        return running ?? withoutError({ ...session, status: 'running' })
      } catch (error) {
        await this.compensateStartedSession(sessionId, error)
        throw error
      }
    })
  }

  async stop(sessionId: string): Promise<void> {
    return this.withLock(`session:${sessionId}`, () => this.stopAndPersist(sessionId))
  }

  async submitFirstInput(sessionId: string, text: string): Promise<void> {
    // Fast path only: an in-memory guard cannot be the source of truth for "one attempt ever"
    // because a fresh coordinator (e.g. after a restart) would have no memory of a prior
    // attempt. The real, durable guard is claimTitleJob's persisted titleState transition below.
    if (this.titleJobs.has(sessionId)) return
    this.titleJobs.add(sessionId)

    // Flip titleState to 'complete' (keeping the current temporary title) and claim the job
    // BEFORE calling TitleService.generate, so a concurrent or later submission — in this
    // process or, after a restart, in a fresh one — sees titleState already 'complete' and
    // never starts a second attempt, even if this attempt never finishes.
    const claimed = await this.claimTitleJob(sessionId)
    if (!claimed) return

    let generated = ''
    try {
      generated = await this.titleService.generate(sessionId, claimed.kind, text)
    } catch {
      generated = ''
    }

    if (generated.length > 0) {
      await this.updateSession(sessionId, (existing) => ({ ...existing, title: generated }))
    }
  }

  /**
   * Atomically transitions a session's titleState from 'pending' to 'complete' and returns
   * the updated record only when this call performed that transition. Returns undefined when
   * the session is missing or titleState was already 'complete' (a previous claim won).
   */
  private async claimTitleJob(sessionId: string): Promise<SessionRecord | undefined> {
    let claimed: SessionRecord | undefined
    const next = await this.store.update((state) => {
      const index = state.sessions.findIndex((session) => session.id === sessionId)
      if (index === -1) return state
      const session = state.sessions[index]!
      if (session.titleState !== 'pending') return state
      const updated: SessionRecord = { ...session, titleState: 'complete' }
      claimed = updated
      const sessions = [...state.sessions]
      sessions[index] = updated
      return { ...state, sessions }
    })
    if (claimed) this.emit(next)
    return claimed
  }

  async delete(sessionId: string): Promise<DeleteSessionResult> {
    return this.withLock(`session:${sessionId}`, async () => {
      try {
        this.titleService.cancel(sessionId)
        await this.stopAndPersist(sessionId)

        const current = await this.store.load()
        const session = current.sessions.find((candidate) => candidate.id === sessionId)
        if (!session) return { status: 'deleted' }

        const project = await this.projectService.get(session.projectId)
        const result = await this.worktreeService.remove(session, project)

        if (result.status === 'removed' || result.status === 'missing') {
          await this.removeSession(sessionId)
          return { status: 'deleted' }
        }

        return { status: 'dirty', changedFiles: result.changedFiles }
      } catch (error) {
        return { status: 'failed', message: errorMessage(error) }
      }
    })
  }

  /**
   * Forgets a project: stops whichever of its sessions are still alive, then drops the
   * project and every one of its session records in a single persisted write. Nothing on
   * disk is touched — the directory, its worktrees, and their branches stay exactly as they
   * are, which is what "remove from list" promises. A PTY that refuses to stop is logged and
   * skipped rather than blocking the removal: the record is going away either way.
   */
  async removeProject(projectId: string): Promise<void> {
    return this.withLock(`project:${projectId}`, async () => {
      await this.projectService.get(projectId)
      const current = await this.store.load()
      const sessions = current.sessions.filter((session) => session.projectId === projectId)

      for (const session of sessions) {
        this.titleService.cancel(session.id)
        if (session.status !== 'running' && session.status !== 'creating') continue
        try {
          await this.terminalService.stop(session.id)
        } catch (error) {
          console.error(`SessionCoordinator: failed to stop PTY for session ${session.id} while removing project ${projectId}.`, error)
        }
      }

      const next = await this.store.update((state) => ({
        ...state,
        projects: state.projects.filter((project) => project.id !== projectId),
        sessions: state.sessions.filter((session) => session.projectId !== projectId)
      }))
      this.emit(next)
    })
  }

  async shutdown(): Promise<void> {
    const current = await this.store.load()
    for (const session of current.sessions) {
      this.titleService.cancel(session.id)
    }

    await this.terminalService.stopAll()

    const next = await this.store.update((state) => ({
      ...state,
      sessions: state.sessions.map((session) =>
        session.status === 'running' || session.status === 'creating' ? { ...session, status: 'stopped' } : session
      )
    }))
    this.emit(next)
  }

  onStateChanged(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private readonly handleExit = (payload: TerminalEventMap['exit']): void => {
    this.persistStopped(payload.sessionId).catch((error: unknown) => {
      console.error(`SessionCoordinator: failed to persist stopped status after PTY exit for session ${payload.sessionId}.`, error)
    })
  }

  /**
   * Stops the PTY, then persists 'stopped' regardless of whether the stop resolved or
   * rejected (the force-kill timeout path can reject after TerminalService has already
   * removed its own entry, so the session must not be left stuck at a stale status such
   * as 'running' — that would make restore() treat it as already running and no-op forever).
   * The original stop error, if any, still propagates to the caller after persisting.
   */
  private async stopAndPersist(sessionId: string): Promise<void> {
    try {
      await this.terminalService.stop(sessionId)
    } finally {
      await this.persistStopped(sessionId)
    }
  }

  private async compensateStartedSession(sessionId: string, originalError: unknown): Promise<void> {
    try {
      await this.terminalService.stop(sessionId)
    } catch (stopError) {
      console.error(`SessionCoordinator: failed to stop PTY after persistence failure for session ${sessionId}.`, stopError)
    }

    try {
      await this.updateSession(sessionId, (existing) => ({
        ...existing,
        status: 'error',
        lastError: errorMessage(originalError)
      }))
    } catch (reconciliationError) {
      console.error(`SessionCoordinator: failed to reconcile session ${sessionId} after persistence failure.`, reconciliationError)
    }
  }

  private async persistStopped(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, (existing) => (existing.status === 'stopped' ? existing : { ...existing, status: 'stopped' }))
  }

  private async appendSession(record: SessionRecord): Promise<void> {
    const next = await this.store.update((state) => ({ ...state, sessions: [...state.sessions, record] }))
    this.emit(next)
  }

  private async removeSession(sessionId: string): Promise<void> {
    const next = await this.store.update((state) => ({
      ...state,
      sessions: state.sessions.filter((session) => session.id !== sessionId)
    }))
    this.emit(next)
  }

  private async updateSession(
    sessionId: string,
    mutator: (session: SessionRecord) => SessionRecord
  ): Promise<SessionRecord | undefined> {
    let updated: SessionRecord | undefined
    const next = await this.store.update((state) => {
      const index = state.sessions.findIndex((session) => session.id === sessionId)
      if (index === -1) return state
      const sessions = [...state.sessions]
      updated = mutator(sessions[index]!)
      sessions[index] = updated
      return { ...state, sessions }
    })
    if (updated) this.emit(next)
    return updated
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    const tail = current.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(key, tail)
    try {
      return await current
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  private emit(state: AppState): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(state)
      } catch {
        // A subscriber failure must not affect coordinator transactions or other subscribers.
      }
    }
  }
}
