import { describe, expect, it } from 'vitest'

import {
  appStateSchema,
  capabilityStateSchema,
  createSessionRequestSchema,
  firstInputRequestSchema,
  projectIdRequestSchema,
  sessionRecordSchema,
  sessionIdRequestSchema,
  terminalWriteRequestSchema,
  terminalResizeRequestSchema
} from './contracts'
import type { SessionRecord } from './contracts'
import { IPC } from './ipc'

describe('shared contracts', () => {
  it('rejects a create-session request without a valid session kind', () => {
    expect(createSessionRequestSchema.safeParse({ projectId: 'p1', kind: 'bash' }).success).toBe(false)
  })

  it('rejects unknown fields in every IPC request', () => {
    for (const valid of [
      createSessionRequestSchema.safeParse({ projectId: 'p1', kind: 'powershell', unexpected: true }).success,
      sessionIdRequestSchema.safeParse({ sessionId: 's1', unexpected: true }).success,
      projectIdRequestSchema.safeParse({ projectId: 'p1', unexpected: true }).success,
      terminalWriteRequestSchema.safeParse({ sessionId: 's1', data: 'ls', unexpected: true }).success,
      terminalResizeRequestSchema.safeParse({ sessionId: 's1', cols: 80, rows: 24, unexpected: true }).success,
      firstInputRequestSchema.safeParse({ sessionId: 's1', text: 'hello', unexpected: true }).success
    ]) {
      expect(valid).toBe(false)
    }
  })

  it('accepts the initial application state', () => {
    expect(appStateSchema.safeParse({ version: 1, projects: [], sessions: [] }).success).toBe(true)
  })

  it('rejects unknown fields in application state records and capabilities', () => {
    const project = {
      id: 'p1',
      name: 'Project',
      path: 'E:/project',
      createdAt: '2026-08-26T00:00:00.000Z'
    }
    const ordinarySession = {
      id: 's1',
      projectId: 'p1',
      kind: 'powershell',
      title: 'Terminal',
      titleState: 'pending',
      createdAt: '2026-08-26T00:00:00.000Z',
      mode: 'ordinary',
      launchPath: 'E:/project',
      status: 'creating'
    }
    const capabilities = {
      claude: { available: true, detail: 'installed' },
      codex: { available: true, detail: 'installed' },
      vscode: { available: true, detail: 'installed' }
    }

    expect(appStateSchema.safeParse({ version: 1, projects: [], sessions: [], unexpected: true }).success).toBe(false)
    expect(appStateSchema.safeParse({ version: 1, projects: [{ ...project, unexpected: true }], sessions: [] }).success).toBe(false)
    expect(appStateSchema.safeParse({ version: 1, projects: [], sessions: [{ ...ordinarySession, unexpected: true }] }).success).toBe(false)
    expect(capabilityStateSchema.safeParse({ ...capabilities, unexpected: true }).success).toBe(false)
    expect(capabilityStateSchema.safeParse({ ...capabilities, claude: { ...capabilities.claude, unexpected: true } }).success).toBe(false)
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

  it('accepts ordinary sessions with omitted or valid optional worktree metadata', () => {
    const ordinarySession = {
      id: 's1',
      projectId: 'p1',
      kind: 'powershell',
      title: 'Terminal',
      titleState: 'pending',
      createdAt: '2026-08-26T00:00:00.000Z',
      mode: 'ordinary',
      launchPath: 'E:/project',
      status: 'creating'
    }

    expect(sessionRecordSchema.safeParse(ordinarySession).success).toBe(true)
    expect(
      sessionRecordSchema.safeParse({
        ...ordinarySession,
        worktreeName: 'feature-branch',
        worktreePath: 'E:/project/.worktrees/feature-branch',
        branchName: 'feature/branch'
      }).success
    ).toBe(true)
  })

  it('rejects empty optional worktree metadata on ordinary sessions', () => {
    const ordinarySession = {
      id: 's1',
      projectId: 'p1',
      kind: 'powershell',
      title: 'Terminal',
      titleState: 'pending',
      createdAt: '2026-08-26T00:00:00.000Z',
      mode: 'ordinary',
      launchPath: 'E:/project',
      status: 'creating'
    }

    for (const field of ['worktreeName', 'worktreePath', 'branchName'] as const) {
      expect(sessionRecordSchema.safeParse({ ...ordinarySession, [field]: '' }).success).toBe(false)
    }
  })

  it('validates terminal write and first-input length boundaries', () => {
    const maxData = 'a'.repeat(65536)

    expect(terminalWriteRequestSchema.safeParse({ sessionId: 's1', data: maxData }).success).toBe(true)
    expect(terminalWriteRequestSchema.safeParse({ sessionId: 's1', data: `${maxData}a` }).success).toBe(false)
    expect(firstInputRequestSchema.safeParse({ sessionId: 's1', text: '' }).success).toBe(false)
    expect(firstInputRequestSchema.safeParse({ sessionId: 's1', text: maxData }).success).toBe(true)
    expect(firstInputRequestSchema.safeParse({ sessionId: 's1', text: `${maxData}a` }).success).toBe(false)
  })

  it('validates terminal resize boundaries and integer dimensions', () => {
    for (const [dimensions, expected] of [
      [{ cols: 1, rows: 1 }, true],
      [{ cols: 1000, rows: 1000 }, true],
      [{ cols: 0, rows: 24 }, false],
      [{ cols: 80, rows: 1001 }, false],
      [{ cols: 80.5, rows: 24 }, false]
    ] as const) {
      expect(terminalResizeRequestSchema.safeParse({ sessionId: 's1', ...dimensions }).success).toBe(expected)
    }
  })

  it('defines every IPC channel once', () => {
    expect(IPC).toEqual({
      snapshotGet: 'snapshot:get',
      projectAdd: 'project:add',
      projectOpenVSCode: 'project:open-vscode',
      projectOpenFolder: 'project:open-folder',
      sessionCreate: 'session:create',
      sessionRestore: 'session:restore',
      sessionDelete: 'session:delete',
      sessionFirstInput: 'session:first-input',
      terminalWrite: 'terminal:write',
      terminalResize: 'terminal:resize',
      stateChanged: 'state:changed',
      terminalData: 'terminal:data',
      terminalExit: 'terminal:exit'
    })
    expect(new Set(Object.values(IPC)).size).toBe(Object.values(IPC).length)
  })
})

const validWorktreeSession: SessionRecord = {
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

// @ts-expect-error Worktree sessions must include all worktree metadata.
const incompleteWorktreeSession: SessionRecord = {
  id: 's1',
  projectId: 'p1',
  kind: 'powershell',
  title: 'Terminal',
  titleState: 'pending',
  createdAt: '2026-08-26T00:00:00.000Z',
  mode: 'worktree',
  worktreeName: 'feature-branch',
  worktreePath: 'E:/project/.worktrees/feature-branch',
  launchPath: 'E:/project',
  status: 'creating'
}

void incompleteWorktreeSession
