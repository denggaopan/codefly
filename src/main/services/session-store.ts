import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { appStateSchema } from '../../shared/contracts'
import type { AppState } from '../../shared/contracts'

type WriteFileAtomic = (filePath: string, contents: string, options: { encoding: 'utf8' }) => Promise<void>

type DiskState =
  | { kind: 'absent' }
  | { kind: 'invalid'; contents?: string }
  | { kind: 'valid'; contents: string; state: AppState }

const writeFileAtomic = createRequire(import.meta.url)('write-file-atomic') as WriteFileAtomic

const emptyState = (): AppState => ({ version: 1, projects: [], sessions: [] })

const cloneState = (state: AppState): AppState => appStateSchema.parse(structuredClone(state))

/**
 * Reconciles the statuses read from disk with what a fresh process can actually know.
 *
 * `creating` becomes `stopped`: a session interrupted mid-creation has neither a PTY we can
 * trust nor an agent conversation worth resuming (the CLI may never have printed a prompt),
 * so it must not be picked up automatically. The user can start a new session instead.
 *
 * `running` is deliberately left alone. PTYs now live in the resident pty-host rather than in
 * the Electron main process, so a `running` record that outlived a restart is no longer a lie
 * — but it is not a verified fact either. Read it as *intent*: "the user wants this session
 * alive". The only source of truth for what is actually alive is the session table the
 * pty-host reports in its `welcome`, which `SessionCoordinator.reconcile()` diffs against this
 * state at startup; until that diff runs, nothing here should claim to know.
 *
 * This is also why telling an involuntary interruption apart from a deliberate stop needs no
 * extra field: `stop()` persists `stopped`, so a session the user stopped on purpose reads
 * `stopped` here and is never a candidate for auto-resume, while a session that was `running`
 * when the UI closed, crashed, or was replaced by an installer still reads `running`.
 */
const normalizeRuntimeStatuses = (state: AppState): AppState => ({
  ...state,
  projects: [...state.projects],
  sessions: state.sessions.map((session) =>
    session.status === 'creating' ? { ...session, status: 'stopped' } : { ...session }
  )
})

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const isEexist = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'

export class SessionStore {
  // A store instance owns one file and serializes all operations for that file.
  private operationTail: Promise<void> = Promise.resolve()
  private state: AppState | undefined
  private startupRecoveryWarning: string | undefined

  constructor(private readonly filePath: string) {}

  load(): Promise<AppState> {
    return this.enqueue(async () => {
      await this.initializeState()
      return cloneState(this.state!)
    })
  }

  async save(state: AppState): Promise<void> {
    const validState = appStateSchema.parse(state)
    return this.enqueue(async () => {
      await this.commit(validState)
      this.state = cloneState(validState)
    })
  }

  update(mutator: (state: AppState) => AppState | Promise<AppState>): Promise<AppState> {
    return this.enqueue(async () => {
      await this.initializeState()
      const validState = appStateSchema.parse(await mutator(cloneState(this.state!)))
      await this.commit(validState)
      this.state = cloneState(validState)
      return cloneState(this.state)
    })
  }

  recoveryWarning(): string | undefined {
    return this.startupRecoveryWarning
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async initializeState(): Promise<void> {
    if (this.state) return
    this.state = normalizeRuntimeStatuses(await this.readRecoveredState())
  }

  private async readRecoveredState(): Promise<AppState> {
    const primary = await this.readRecoveryDiskState(this.filePath)
    if (primary.kind === 'valid') return primary.state

    const backup = await this.readRecoveryDiskState(`${this.filePath}.bak`)
    if (primary.kind !== 'invalid') return backup.kind === 'valid' ? backup.state : emptyState()

    const archivePath = await this.archiveCorruptPrimary(primary.contents)
    const archiveDetail = archivePath
      ? ` The corrupt state was preserved at ${archivePath}.`
      : ' The corrupt state could not be archived.'

    if (backup.kind === 'valid') {
      this.startupRecoveryWarning = `CodeFly recovered from backup.${archiveDetail}`
      return backup.state
    }

    this.startupRecoveryWarning = `CodeFly could not recover a valid state file and started with empty state.${archiveDetail}`
    return emptyState()
  }

  private async archiveCorruptPrimary(contents: string | undefined): Promise<string | undefined> {
    if (contents === undefined) return undefined

    for (let sequence = 0; sequence < 100; sequence += 1) {
      const archivePath = sequence === 0 ? `${this.filePath}.corrupt` : `${this.filePath}.corrupt-${sequence}`
      try {
        await copyFile(this.filePath, archivePath, fsConstants.COPYFILE_EXCL)
        return archivePath
      } catch (error) {
        if (isEexist(error)) continue
        return undefined
      }
    }
    return undefined
  }

  private async readRecoveryDiskState(filePath: string): Promise<DiskState> {
    try {
      return await this.readDiskState(filePath)
    } catch {
      return { kind: 'invalid' }
    }
  }

  private async commit(state: AppState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const primary = await this.readDiskState(this.filePath)
    if (primary.kind === 'valid') {
      await writeFileAtomic(`${this.filePath}.bak`, primary.contents, { encoding: 'utf8' })
    }
    await writeFileAtomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' })
  }

  private async readDiskState(filePath: string): Promise<DiskState> {
    let contents: string
    try {
      contents = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isEnoent(error)) return { kind: 'absent' }
      throw error
    }

    try {
      const parsed = appStateSchema.safeParse(JSON.parse(contents))
      return parsed.success ? { kind: 'valid', contents, state: parsed.data } : { kind: 'invalid', contents }
    } catch {
      return { kind: 'invalid', contents }
    }
  }
}
