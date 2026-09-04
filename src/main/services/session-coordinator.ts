import { randomUUID } from 'node:crypto'

import type { AppState, DeleteSessionResult, SessionKind, SessionRecord } from '../../shared/contracts'
import type { ProjectService } from './project-service'
import type { SessionStore } from './session-store'
import type { SessionLocation, WorktreeService } from './worktree-service'
import type { TerminalEventMap } from './terminal-service'
import type { TitleService } from './title-service'

export class SessionNotFoundError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

// Placeholder titles shown until the first input produces a real one. English regardless of
// the renderer's locale: these are persisted into AppState, not UI copy, so they must not
// change meaning when the user switches language.
const initialTitles: Readonly<Record<SessionKind, string>> = {
  shell: 'New Shell session',
  powershell: 'New PowerShell session',
  cmd: 'New Command Prompt session',
  claude: 'New Claude session',
  codex: 'New Codex session',
  gemini: 'New Gemini session',
  copilot: 'New GitHub Copilot session',
  cursor: 'New Cursor session',
  comate: 'New Comate session',
  qwen: 'New Qwen Code session'
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
 * Everything the coordinator needs from whatever owns the PTYs — and nothing more. Declared
 * structurally rather than as `TerminalService` so both the in-process implementation and the
 * pty-host client (which owns no PTY itself, it only talks to the resident host) satisfy it
 * without either one having to know about the other.
 *
 * Only the members the coordinator actually calls are listed: `write`, `resize`, and
 * `isRunning` belong to the IPC layer's path to the terminal, never to this class, so putting
 * them here would widen the contract for no reason. There is deliberately no way to ask *this*
 * object which sessions are alive either — `reconcile()` is handed that set, because the
 * composition root already has it from the host's `welcome` handshake and is the only place
 * that knows whether a host was reached at all.
 */
export interface SessionTerminal {
  start(session: SessionRecord, options?: { resume?: boolean }): Promise<void>
  /** Ends one session for good. Used where the user asked for it: stop, delete, remove project. */
  stop(sessionId: string): Promise<void>
  stopAll(): Promise<void>
  on<K extends keyof TerminalEventMap>(event: K, listener: (payload: TerminalEventMap[K]) => void): () => void
  /**
   * Optional pty-host capability: drop the connection to the host and leave every PTY running.
   * Absent on the in-process TerminalService, whose PTYs are children of this process and
   * therefore cannot outlive it — see `shutdown()` for how that fallback is handled.
   *
   * Both return shapes are accepted because closing a socket needs no round trip (PtyHostClient
   * detaches synchronously) while a future implementation might have to flush; `shutdown()`
   * awaits the result either way, so neither side has to care which it is.
   */
  detach?(): void | Promise<void>
}

/**
 * Options for `reconcile()`. `autoResume: false` is the degraded path for a startup where no
 * host could be reached at all: without a host there is nothing to resume into, so the
 * sessions the user had running are marked `stopped` and left for a manual click instead of
 * being restarted into a void.
 */
export type ReconcileOptions = {
  autoResume?: boolean
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
    private readonly terminalService: SessionTerminal,
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
    return this.withLock(`session:${sessionId}`, () => this.restoreLocked(sessionId))
  }

  /**
   * The body of `restore()`, callable by `reconcile()` while it already holds the session lock
   * (withLock is not reentrant). `adoptStaleRunning` exists because `running` is now intent
   * rather than a verified fact: for a UI-driven restore, `running` means a PTY is already
   * attached and the call is a no-op, but reconcile has just been told by the host that this
   * particular `running` record has no PTY behind it, so the guard has to be skipped. The
   * record is left at `running` while the relaunch is in flight rather than being demoted
   * first: a crash mid-reconcile then still reads as "the user wants this alive" next time.
   */
  private async restoreLocked(sessionId: string, adoptStaleRunning = false): Promise<SessionRecord> {
    const current = await this.store.load()
    const session = current.sessions.find((candidate) => candidate.id === sessionId)
    if (!session) throw new SessionNotFoundError(sessionId)
    if (session.status === 'running' && !adoptStaleRunning) return session

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
   *
   * Unlike `shutdown()`, this really does kill: the keepalive contract is "the sessions outlive
   * the UI", not "the sessions outlive the record that names them". Once the last record is
   * gone nothing could ever attach to those PTYs again, and an agent CLI running with its
   * permission bypass on and no UI to show it is exactly what reconcile() has to hunt down.
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

  /**
   * Startup handshake: diffs the sessions the pty-host reports as alive against what was
   * persisted, so the UI ends up showing what is actually running rather than what happened
   * to be running when it last quit. Call it once the host's session table is known — the
   * composition root owns the connection, this class only owns the bookkeeping.
   *
   * Four cases:
   *
   * - **alive and known** — the PTY survived the UI, so the record is (re)marked `running` and
   *   any stale `lastError` is dropped. This is the whole point of the resident host.
   * - **known but not alive, record says `running`** — the host itself was replaced (installer,
   *   reboot, crash) while the user still wanted those sessions. Each one is relaunched through
   *   the normal restore path, which passes the agent's own resume flag so the previous
   *   conversation continues. One failure never blocks the others.
   * - **known but not alive, record says `creating`** — demoted to `stopped`. SessionStore
   *   already does this when it loads a state file, but that only covers a state file read by
   *   *this* process: reconcile also runs after a mid-session host restart, against state that
   *   is already in memory and was never re-normalized. Cheap belt and braces for a status
   *   that must never be auto-resumed.
   * - **alive but unknown** — an orphan: the state file rolled back to a backup, or a delete
   *   landed while the host was unreachable. It is killed. Leaving it would mean an agent CLI
   *   running with its vendor's permission bypass fully enabled, in a directory the user is
   *   working in, with no record anywhere in the UI and no way to stop it.
   *
   * Follows the usual rules: every status change is persisted before it is broadcast, and each
   * session's transition happens under that session's lock.
   */
  async reconcile(liveSessionIds: ReadonlySet<string>, options: ReconcileOptions = {}): Promise<AppState> {
    const autoResume = options.autoResume !== false
    const current = await this.store.load()

    const adopt: string[] = []
    const resume: string[] = []
    const demote: string[] = []

    for (const session of current.sessions) {
      if (liveSessionIds.has(session.id)) {
        adopt.push(session.id)
      } else if (session.status === 'creating') {
        demote.push(session.id)
      } else if (session.status === 'running') {
        // `running` with no PTY behind it is the user's intent, not a fact: honour it by
        // resuming, unless the caller told us there is no host to resume into.
        if (autoResume) resume.push(session.id)
        else demote.push(session.id)
      }
    }

    for (const sessionId of adopt) {
      try {
        await this.withLock(`session:${sessionId}`, () => this.persistRunning(sessionId))
      } catch (error) {
        console.error(`SessionCoordinator: failed to adopt live session ${sessionId} during reconciliation.`, error)
      }
    }

    for (const sessionId of demote) {
      try {
        await this.withLock(`session:${sessionId}`, () => this.persistStopped(sessionId))
      } catch (error) {
        console.error(`SessionCoordinator: failed to mark session ${sessionId} stopped during reconciliation.`, error)
      }
    }

    for (const sessionId of resume) {
      try {
        // The lock is taken here rather than inside restore() so the "is it running" check and
        // the relaunch cannot be interleaved with a UI-driven restore of the same session.
        await this.withLock(`session:${sessionId}`, () => this.restoreLocked(sessionId, true))
      } catch (error) {
        // restoreLocked has already persisted 'error' (or 'missing'); a single unresumable
        // session must not stop the rest of the user's workspace from coming back.
        console.error(`SessionCoordinator: failed to resume session ${sessionId} during reconciliation.`, error)
      }
    }

    const known = new Set(current.sessions.map((session) => session.id))
    for (const sessionId of liveSessionIds) {
      if (known.has(sessionId)) continue
      console.warn(`SessionCoordinator: killing orphaned pty-host session ${sessionId} with no persisted record.`)
      try {
        await this.terminalService.stop(sessionId)
      } catch (error) {
        console.error(`SessionCoordinator: failed to kill orphaned pty-host session ${sessionId}.`, error)
      }
    }

    return this.store.load()
  }

  /**
   * Lets go of the sessions rather than ending them — the method name predates the pty-host
   * and is kept because the composition root's `before-quit` hook still calls it.
   *
   * Quitting CodeFly (or replacing it with an installer) must leave every PTY, and therefore
   * every agent CLI, running in the resident host so the next UI can attach to them; that is
   * the entire feature. So nothing here kills a PTY. `detach()` drops the connection where the
   * implementation has one. The `stopAll()` fallback is for an implementation that owns its
   * PTYs inside this process (TerminalService, still used by unit tests and any build without
   * a host): those children die with the process no matter what, so stopping them deliberately
   * beats having the OS tear them down mid-write.
   *
   * Ending sessions on purpose still belongs to `stop()`, `delete()`, and `removeProject()`.
   */
  async shutdown(): Promise<void> {
    const current = await this.store.load()
    for (const session of current.sessions) {
      this.titleService.cancel(session.id)
    }

    if (this.terminalService.detach) {
      await this.terminalService.detach()
    } else {
      await this.terminalService.stopAll()
    }

    // `running` survives on purpose: it is the record of intent that reconcile() needs on the
    // next start to decide between "attach" and "resume". `creating` does not — whether those
    // PTYs ever came up is exactly what nobody knows, so they are never auto-resumed.
    const next = await this.store.update((state) => ({
      ...state,
      sessions: state.sessions.map((session) => (session.status === 'creating' ? { ...session, status: 'stopped' } : session))
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

  /**
   * Marks a session running because a PTY for it was found alive, dropping any `lastError`
   * left over from an earlier failed attempt — the same cleanup restore() does on success, and
   * for the same reason: a running session showing a stale error message is a lie in the UI.
   */
  private async persistRunning(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, (existing) =>
      existing.status === 'running' && existing.lastError === undefined ? existing : withoutError({ ...existing, status: 'running' })
    )
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
