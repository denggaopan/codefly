import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { appStateSchema } from '../../shared/contracts'
import type { AppState } from '../../shared/contracts'

const emptyState = (): AppState => ({ version: 1, projects: [], sessions: [] })

type WriteFileAtomic = (filePath: string, contents: string, options: { encoding: 'utf8' }) => Promise<void>

const writeFileAtomic = createRequire(import.meta.url)('write-file-atomic') as WriteFileAtomic

const normalizeRuntimeStatuses = (state: AppState): AppState => ({
  ...state,
  projects: [...state.projects],
  sessions: state.sessions.map((session) =>
    session.status === 'running' || session.status === 'creating' ? { ...session, status: 'stopped' } : { ...session }
  )
})

export class SessionStore {
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppState> {
    const primary = await this.readState(this.filePath)
    if (primary) return normalizeRuntimeStatuses(primary)

    const backup = await this.readState(`${this.filePath}.bak`)
    return backup ? normalizeRuntimeStatuses(backup) : emptyState()
  }

  async save(state: AppState): Promise<void> {
    const validState = appStateSchema.parse(state)
    await mkdir(dirname(this.filePath), { recursive: true })

    const primaryContents = await this.readValidContents(this.filePath)
    if (primaryContents !== undefined) {
      await writeFileAtomic(`${this.filePath}.bak`, primaryContents, { encoding: 'utf8' })
    }

    await writeFileAtomic(this.filePath, `${JSON.stringify(validState, null, 2)}\n`, { encoding: 'utf8' })
  }

  update(mutator: (state: AppState) => AppState | Promise<AppState>): Promise<AppState> {
    const operation = this.updateQueue.then(async () => {
      const nextState = appStateSchema.parse(await mutator(await this.load()))
      await this.save(nextState)
      return nextState
    })

    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async readState(filePath: string): Promise<AppState | undefined> {
    try {
      return appStateSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8'))).data
    } catch {
      return undefined
    }
  }

  private async readValidContents(filePath: string): Promise<string | undefined> {
    try {
      const contents = await readFile(filePath, 'utf8')
      return appStateSchema.safeParse(JSON.parse(contents)).success ? contents : undefined
    } catch {
      return undefined
    }
  }
}
