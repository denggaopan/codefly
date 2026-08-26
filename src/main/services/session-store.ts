import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { appStateSchema } from '../../shared/contracts'
import type { AppState } from '../../shared/contracts'

type WriteFileAtomic = (filePath: string, contents: string, options: { encoding: 'utf8' }) => Promise<void>

type DiskState =
  | { kind: 'absent' | 'invalid' }
  | { kind: 'valid'; contents: string; state: AppState }

const writeFileAtomic = createRequire(import.meta.url)('write-file-atomic') as WriteFileAtomic

const emptyState = (): AppState => ({ version: 1, projects: [], sessions: [] })

const cloneState = (state: AppState): AppState => appStateSchema.parse(structuredClone(state))

const normalizeRuntimeStatuses = (state: AppState): AppState => ({
  ...state,
  projects: [...state.projects],
  sessions: state.sessions.map((session) =>
    session.status === 'running' || session.status === 'creating' ? { ...session, status: 'stopped' } : { ...session }
  )
})

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

export class SessionStore {
  // A store instance owns one file and serializes all operations for that file.
  private operationTail: Promise<void> = Promise.resolve()
  private state: AppState | undefined

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
    return backup.kind === 'valid' ? backup.state : emptyState()
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
      return parsed.success ? { kind: 'valid', contents, state: parsed.data } : { kind: 'invalid' }
    } catch {
      return { kind: 'invalid' }
    }
  }
}
