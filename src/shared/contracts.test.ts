import { describe, expect, it } from 'vitest'

import {
  appStateSchema,
  capabilityStateSchema,
  createSessionRequestSchema,
  firstInputRequestSchema,
  hostPlatformSchema,
  projectIdRequestSchema,
  reorderProjectsRequestSchema,
  sessionKindSchema,
  sessionRecordSchema,
  sessionIdRequestSchema,
  openExternalLinkRequestSchema,
  storedSessionKindPreferencesSchema,
  DEFAULT_SESSION_KIND_PREFERENCES,
  setAutoLaunchRequestSchema,
  setThemeRequestSchema,
  setWindowPinnedRequestSchema,
  terminalWriteRequestSchema,
  terminalResizeRequestSchema
} from './contracts'
import type { SessionRecord } from './contracts'
import { IPC } from './ipc'

describe('shared contracts', () => {
  it('rejects a create-session request without a valid session kind', () => {
    expect(createSessionRequestSchema.safeParse({ projectId: 'p1', kind: 'bash' }).success).toBe(false)
  })

  it('accepts the native Shell kind and only the supported desktop platforms', () => {
    expect(sessionKindSchema.safeParse('shell').success).toBe(true)
    expect(createSessionRequestSchema.safeParse({ projectId: 'p1', kind: 'shell' }).success).toBe(true)
    expect(hostPlatformSchema.safeParse('win32').success).toBe(true)
    expect(hostPlatformSchema.safeParse('darwin').success).toBe(true)
    expect(hostPlatformSchema.safeParse('linux').success).toBe(false)
  })

  it('treats an omitted worktree flag as "run in the project directory"', () => {
    const parsed = createSessionRequestSchema.parse({ projectId: 'p1', kind: 'claude' })
    expect(parsed.worktree).toBe(false)
    expect(createSessionRequestSchema.parse({ projectId: 'p1', kind: 'claude', worktree: true }).worktree).toBe(true)
    expect(createSessionRequestSchema.safeParse({ projectId: 'p1', kind: 'claude', worktree: 'yes' }).success).toBe(false)
  })

  // The opt-in agents default to off so the launcher does not grow five entries for CLIs the
  // user may not have; their worktree switch still defaults on, so enabling one immediately
  // offers the same isolated-worktree entry Claude and Codex have.
  it('offers the established kinds by default and leaves the opt-in agents switched off', () => {
    expect(DEFAULT_SESSION_KIND_PREFERENCES).toEqual({
      shell: { enabled: false, worktree: false },
      powershell: { enabled: true, worktree: false },
      cmd: { enabled: true, worktree: false },
      claude: { enabled: true, worktree: true },
      codex: { enabled: true, worktree: true },
      gemini: { enabled: false, worktree: true },
      copilot: { enabled: false, worktree: true },
      cursor: { enabled: false, worktree: true },
      comate: { enabled: false, worktree: true },
      qwen: { enabled: false, worktree: true }
    })
  })

  it('reads stored session-kind preferences leniently so a partial or foreign value still merges', () => {
    expect(storedSessionKindPreferencesSchema.parse({ claude: { worktree: false } })).toEqual({ claude: { worktree: false } })
    expect(storedSessionKindPreferencesSchema.parse({ shell: { enabled: true } })).toEqual({ shell: { enabled: true } })
    // Keys this build does not know about are dropped rather than failing the whole read.
    expect(storedSessionKindPreferencesSchema.parse({ cmd: { enabled: false, bash: true }, zsh: {} })).toEqual({
      cmd: { enabled: false }
    })
    expect(storedSessionKindPreferencesSchema.safeParse({ claude: { worktree: 'yes' } }).success).toBe(false)
    // A build that predates the opt-in agents stored nothing for them; a build that has them
    // must still read its own writes back.
    expect(storedSessionKindPreferencesSchema.parse({ cursor: { enabled: true }, comate: { worktree: false } })).toEqual({
      cursor: { enabled: true },
      comate: { worktree: false }
    })
  })

  it('rejects unknown fields in every IPC request', () => {
    for (const valid of [
      createSessionRequestSchema.safeParse({ projectId: 'p1', kind: 'powershell', unexpected: true }).success,
      sessionIdRequestSchema.safeParse({ sessionId: 's1', unexpected: true }).success,
      projectIdRequestSchema.safeParse({ projectId: 'p1', unexpected: true }).success,
      terminalWriteRequestSchema.safeParse({ sessionId: 's1', data: 'ls', unexpected: true }).success,
      terminalResizeRequestSchema.safeParse({ sessionId: 's1', cols: 80, rows: 24, unexpected: true }).success,
      firstInputRequestSchema.safeParse({ sessionId: 's1', text: 'hello', unexpected: true }).success,
      setThemeRequestSchema.safeParse({ theme: 'dark', unexpected: true }).success
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
      gemini: { available: true, detail: 'installed' },
      copilot: { available: true, detail: 'installed' },
      cursor: { available: true, detail: 'installed' },
      comate: { available: true, detail: 'installed' },
      qwen: { available: true, detail: 'installed' },
      vscode: { available: true, detail: 'installed' }
    }

    // Every agent kind is probed at startup, so the snapshot must carry an entry for each —
    // the launcher reads availability by kind and has nowhere to fall back to.
    expect(capabilityStateSchema.safeParse(capabilities).success).toBe(true)

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

  it('accepts only a non-empty list of non-empty project ids for project reordering', () => {
    expect(reorderProjectsRequestSchema.safeParse({ orderedProjectIds: ['p1', 'p2'] }).success).toBe(true)
    expect(reorderProjectsRequestSchema.safeParse({ orderedProjectIds: [] }).success).toBe(false)
    expect(reorderProjectsRequestSchema.safeParse({ orderedProjectIds: ['p1', ''] }).success).toBe(false)
    expect(reorderProjectsRequestSchema.safeParse({}).success).toBe(false)
    expect(reorderProjectsRequestSchema.safeParse({ orderedProjectIds: ['p1'], extra: true }).success).toBe(false)
  })

  it('accepts only dark/light theme requests', () => {
    expect(setThemeRequestSchema.safeParse({ theme: 'dark' }).success).toBe(true)
    expect(setThemeRequestSchema.safeParse({ theme: 'light' }).success).toBe(true)
    expect(setThemeRequestSchema.safeParse({ theme: 'blue' }).success).toBe(false)
    expect(setThemeRequestSchema.safeParse({}).success).toBe(false)
  })

  // The named targets are the whole point of the schema: the renderer never sends a URL,
  // so anything that is not one of the three known keys must be rejected here.
  it('accepts only the three whitelisted external link targets', () => {
    expect(openExternalLinkRequestSchema.safeParse({ target: 'repository' }).success).toBe(true)
    expect(openExternalLinkRequestSchema.safeParse({ target: 'changelog' }).success).toBe(true)
    expect(openExternalLinkRequestSchema.safeParse({ target: 'download' }).success).toBe(true)
    expect(openExternalLinkRequestSchema.safeParse({ target: 'https://example.test' }).success).toBe(false)
    expect(openExternalLinkRequestSchema.safeParse({}).success).toBe(false)
    expect(openExternalLinkRequestSchema.safeParse({ target: 'repository', extra: true }).success).toBe(false)
  })

  it('accepts only a boolean auto-launch request', () => {
    expect(setAutoLaunchRequestSchema.safeParse({ enabled: true }).success).toBe(true)
    expect(setAutoLaunchRequestSchema.safeParse({ enabled: false }).success).toBe(true)
    expect(setAutoLaunchRequestSchema.safeParse({ enabled: 'true' }).success).toBe(false)
    expect(setAutoLaunchRequestSchema.safeParse({}).success).toBe(false)
    expect(setAutoLaunchRequestSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false)
  })

  it('accepts only a boolean window-pin request', () => {
    expect(setWindowPinnedRequestSchema.safeParse({ pinned: true }).success).toBe(true)
    expect(setWindowPinnedRequestSchema.safeParse({ pinned: false }).success).toBe(true)
    expect(setWindowPinnedRequestSchema.safeParse({ pinned: 'true' }).success).toBe(false)
    expect(setWindowPinnedRequestSchema.safeParse({}).success).toBe(false)
    expect(setWindowPinnedRequestSchema.safeParse({ pinned: true, extra: 1 }).success).toBe(false)
  })

  it('defines every IPC channel once', () => {
    expect(IPC).toEqual({
      snapshotGet: 'snapshot:get',
      projectAdd: 'project:add',
      projectOpenVSCode: 'project:open-vscode',
      projectOpenFolder: 'project:open-folder',
      projectOpenRepository: 'project:open-repository',
      projectRemove: 'project:remove',
      projectReorder: 'project:reorder',
      sessionCreate: 'session:create',
      sessionRestore: 'session:restore',
      sessionDelete: 'session:delete',
      sessionFirstInput: 'session:first-input',
      themeSet: 'theme:set',
      windowPinnedSet: 'window:pinned-set',
      appInfoGet: 'app:info',
      appUpdateCheck: 'app:update-check',
      appUpdateDownload: 'app:update-download',
      appUpdateCancel: 'app:update-cancel',
      appUpdateInstall: 'app:update-install',
      appOpenLink: 'app:open-link',
      appAutoLaunchGet: 'app:auto-launch-get',
      appAutoLaunchSet: 'app:auto-launch-set',
      terminalWrite: 'terminal:write',
      terminalResize: 'terminal:resize',
      terminalReplay: 'terminal:replay',
      stateChanged: 'state:changed',
      terminalData: 'terminal:data',
      terminalExit: 'terminal:exit',
      appUpdateProgress: 'app:update-progress'
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
