import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appStateSchema } from '../../shared/contracts'
import type { AppState, SessionRecord } from '../../shared/contracts'
import { SessionStore } from './session-store'

const stoppedSession: SessionRecord = {
  id: 's1',
  projectId: 'p1',
  kind: 'powershell',
  title: 'Terminal',
  titleState: 'pending',
  createdAt: '2026-08-26T00:00:00.000Z',
  mode: 'ordinary',
  launchPath: 'E:/project',
  status: 'stopped'
}

const stateWith = (sessions: SessionRecord[] = [stoppedSession]): AppState => ({
  version: 1,
  projects: [{ id: 'p1', name: 'Project', path: 'E:/project', createdAt: '2026-08-26T00:00:00.000Z' }],
  sessions
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('SessionStore', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'codefly-session-store-'))
    filePath = join(directory, 'state.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('returns a fresh empty version-one state when neither file exists', async () => {
    await expect(new SessionStore(filePath).load()).resolves.toEqual({ version: 1, projects: [], sessions: [] })
  })

  it('round-trips a valid stopped session', async () => {
    const store = new SessionStore(filePath)
    const state = stateWith()

    await store.save(state)

    await expect(store.load()).resolves.toEqual(state)
  })

  it('normalizes interrupted sessions to stopped while preserving other statuses', async () => {
    const statuses = ['running', 'creating', 'error', 'missing', 'stopped'] as const
    const persisted = stateWith(statuses.map((status, index) => ({ ...stoppedSession, id: `s${index}`, status })))
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const loaded = await new SessionStore(filePath).load()

    expect(loaded.sessions.map((session) => session.status)).toEqual(['stopped', 'stopped', 'error', 'missing', 'stopped'])
  })

  it('preserves live statuses across unrelated updates but normalizes recovered disk state once', async () => {
    const running = stateWith([{ ...stoppedSession, status: 'running' }])
    const store = new SessionStore(filePath)
    await store.save(running)

    const liveUpdate = await store.update((state) => ({
      ...state,
      projects: [...state.projects, { id: 'p2', name: 'Two', path: 'E:/two', createdAt: '2026-08-26T00:00:00.000Z' }]
    }))
    expect(liveUpdate.sessions[0]!.status).toBe('running')

    await writeFile(filePath, JSON.stringify(running), 'utf8')
    const recoveredUpdate = await new SessionStore(filePath).update((state) => ({
      ...state,
      projects: [...state.projects, { id: 'p2', name: 'Two', path: 'E:/two', createdAt: '2026-08-26T00:00:00.000Z' }]
    }))
    expect(recoveredUpdate.sessions[0]!.status).toBe('stopped')
  })

  it('surfaces operational file errors without replacing a directory', async () => {
    await mkdir(filePath)
    const store = new SessionStore(filePath)

    await expect(store.load()).rejects.toThrow()
    await expect(store.save(stateWith())).rejects.toThrow()
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()
  })

  it('uses a valid backup without modifying a malformed primary', async () => {
    const backup = stateWith()
    const malformed = '{not json'
    await writeFile(filePath, malformed, 'utf8')
    await writeFile(`${filePath}.bak`, JSON.stringify(backup), 'utf8')

    await expect(new SessionStore(filePath).load()).resolves.toEqual(backup)
    await expect(readFile(filePath, 'utf8')).resolves.toBe(malformed)
  })

  it('prefers a valid primary over a valid backup', async () => {
    const primary = stateWith()
    const backup = stateWith([{ ...stoppedSession, id: 'backup' }])
    await writeFile(filePath, JSON.stringify(primary), 'utf8')
    await writeFile(`${filePath}.bak`, JSON.stringify(backup), 'utf8')

    await expect(new SessionStore(filePath).load()).resolves.toEqual(primary)
  })

  it('backs up an existing valid primary before atomically replacing it', async () => {
    const store = new SessionStore(filePath)
    const previous = stateWith()
    const next = stateWith([{ ...stoppedSession, id: 's2' }])
    const previousJson = `${JSON.stringify(previous, null, 2)}\n`
    await writeFile(filePath, previousJson, 'utf8')

    await store.save(next)

    await expect(readFile(`${filePath}.bak`, 'utf8')).resolves.toBe(previousJson)
    await expect(store.load()).resolves.toEqual(next)
  })

  it('does not overwrite a valid backup when the current primary is malformed', async () => {
    const backup = stateWith()
    const backupJson = JSON.stringify(backup)
    await writeFile(filePath, '{malformed', 'utf8')
    await writeFile(`${filePath}.bak`, backupJson, 'utf8')

    await new SessionStore(filePath).save(stateWith([{ ...stoppedSession, id: 'next' }]))

    await expect(readFile(`${filePath}.bak`, 'utf8')).resolves.toBe(backupJson)
  })

  it('serializes concurrent saves so the backup contains the immediately prior primary', async () => {
    const store = new SessionStore(filePath)
    const stateA = stateWith([{ ...stoppedSession, id: 'a' }])
    const stateB = stateWith([{ ...stoppedSession, id: 'b' }])
    const stateC = stateWith([{ ...stoppedSession, id: 'c' }])
    await store.save(stateA)

    const saveB = store.save(stateB)
    const saveC = store.save(stateC)
    await Promise.all([saveB, saveC])

    await expect(readFile(filePath, 'utf8')).resolves.toBe(`${JSON.stringify(appStateSchema.parse(stateC), null, 2)}\n`)
    await expect(readFile(`${filePath}.bak`, 'utf8')).resolves.toBe(`${JSON.stringify(appStateSchema.parse(stateB), null, 2)}\n`)
  })

  it('rejects invalid input without changing valid primary or backup files', async () => {
    const invalid = { version: 2, projects: [], sessions: [] } as unknown as AppState
    const primaryJson = `${JSON.stringify(stateWith(), null, 2)}\n`
    const backupJson = JSON.stringify(stateWith([{ ...stoppedSession, id: 'backup' }]))
    await writeFile(filePath, primaryJson, 'utf8')
    await writeFile(`${filePath}.bak`, backupJson, 'utf8')

    await expect(new SessionStore(filePath).save(invalid)).rejects.toThrow()
    await expect(readFile(filePath, 'utf8')).resolves.toBe(primaryJson)
    await expect(readFile(`${filePath}.bak`, 'utf8')).resolves.toBe(backupJson)
  })

  it('serializes concurrent updates without losing additions', async () => {
    const store = new SessionStore(filePath)
    const firstGate = deferred<void>()
    const secondGate = deferred<void>()
    const invocationOrder: string[] = []
    const first = store.update(async (state) => {
      invocationOrder.push('first')
      await firstGate.promise
      return { ...state, projects: [...state.projects, { id: 'p1', name: 'One', path: 'E:/one', createdAt: '2026-08-26T00:00:00.000Z' }] }
    })
    const second = store.update(async (state) => {
      invocationOrder.push('second')
      await secondGate.promise
      return { ...state, projects: [...state.projects, { id: 'p2', name: 'Two', path: 'E:/two', createdAt: '2026-08-26T00:00:00.000Z' }] }
    })

    firstGate.resolve()
    await first
    secondGate.resolve()
    await second

    expect(invocationOrder).toEqual(['first', 'second'])
    await expect(store.load()).resolves.toMatchObject({ projects: [{ id: 'p1' }, { id: 'p2' }] })
  })

  it('continues processing updates after a mutator throws', async () => {
    const store = new SessionStore(filePath)

    await expect(store.update(() => { throw new Error('mutator failed') })).rejects.toThrow('mutator failed')
    await expect(store.update((state) => ({ ...state, projects: [{ id: 'p1', name: 'One', path: 'E:/one', createdAt: '2026-08-26T00:00:00.000Z' }] }))).resolves.toMatchObject({ projects: [{ id: 'p1' }] })
  })
})
