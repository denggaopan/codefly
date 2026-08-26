import { describe, expect, it } from 'vitest'

import {
  appStateSchema,
  createSessionRequestSchema,
  sessionRecordSchema,
  terminalResizeRequestSchema
} from './contracts'
import { IPC } from './ipc'

describe('shared contracts', () => {
  it('rejects a create-session request without a valid session kind', () => {
    expect(createSessionRequestSchema.safeParse({ projectId: 'p1', kind: 'bash' }).success).toBe(false)
  })

  it('rejects terminal dimensions outside the supported range', () => {
    for (const dimensions of [
      { cols: 0, rows: 24 },
      { cols: 80, rows: 0 },
      { cols: 1001, rows: 24 },
      { cols: 80, rows: 1001 }
    ]) {
      expect(terminalResizeRequestSchema.safeParse({ sessionId: 's1', ...dimensions }).success).toBe(false)
    }
  })

  it('accepts the initial application state', () => {
    expect(appStateSchema.safeParse({ version: 1, projects: [], sessions: [] }).success).toBe(true)
  })

  it('rejects worktree sessions missing any worktree metadata', () => {
    const session = {
      id: 's1',
      projectId: 'p1',
      kind: 'powershell',
      title: 'Terminal',
      titleState: 'pending',
      createdAt: '2026-08-26T00:00:00.000Z',
      mode: 'worktree',
      worktreeName: 'feature-branch',
      worktreePath: 'E:/project/.worktrees/feature-branch',
      branchName: 'feature/branch',
      launchPath: 'E:/project',
      status: 'creating'
    }

    for (const field of ['worktreeName', 'worktreePath', 'branchName'] as const) {
      const invalidSession = { ...session }
      delete invalidSession[field]

      expect(sessionRecordSchema.safeParse(invalidSession).success).toBe(false)
    }
  })

  it('accepts ordinary sessions without worktree metadata', () => {
    expect(
      sessionRecordSchema.safeParse({
        id: 's1',
        projectId: 'p1',
        kind: 'powershell',
        title: 'Terminal',
        titleState: 'pending',
        createdAt: '2026-08-26T00:00:00.000Z',
        mode: 'ordinary',
        launchPath: 'E:/project',
        status: 'creating'
      }).success
    ).toBe(true)
  })

  it('defines every IPC channel once', () => {
    expect(Object.keys(IPC).sort()).toEqual([
      'projectAdd',
      'projectOpenFolder',
      'projectOpenVSCode',
      'sessionCreate',
      'sessionDelete',
      'sessionFirstInput',
      'sessionRestore',
      'snapshotGet',
      'stateChanged',
      'terminalData',
      'terminalExit',
      'terminalResize',
      'terminalWrite'
    ])
    expect(new Set(Object.values(IPC)).size).toBe(Object.values(IPC).length)
  })
})
