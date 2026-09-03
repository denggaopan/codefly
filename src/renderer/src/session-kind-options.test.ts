import { describe, expect, it } from 'vitest'

import { defaultSessionKindPreferences, sessionKindOptions } from './session-kind-options'

describe('session kind options', () => {
  it('keeps the established Windows kinds first and advertises no accelerator', () => {
    expect(sessionKindOptions('win32').slice(0, 4)).toMatchObject([
      { kind: 'powershell', group: 'primary' },
      { kind: 'cmd', group: 'primary' },
      { kind: 'claude', group: 'primary' },
      { kind: 'codex', group: 'primary' }
    ])
    expect(sessionKindOptions('win32').slice(0, 4).map((option) => option.shortcut)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })

  it('offers the native Shell and agents on macOS', () => {
    expect(sessionKindOptions('darwin').slice(0, 3)).toMatchObject([
      { kind: 'shell', shortcut: 'Cmd+T', group: 'primary' },
      { kind: 'claude', group: 'primary' },
      { kind: 'codex', group: 'primary' }
    ])
  })

  // The opt-in agents are appended after the established kinds and marked so Settings can
  // collapse them into their own group instead of showing a ten-row list.
  it('appends the opt-in agents as an additional group on both platforms', () => {
    const additional = [
      { kind: 'gemini', group: 'additional' },
      { kind: 'copilot', group: 'additional' },
      { kind: 'cursor', group: 'additional' },
      { kind: 'comate', group: 'additional' },
      { kind: 'qwen', group: 'additional' }
    ]

    expect(sessionKindOptions('win32').slice(4)).toMatchObject(additional)
    expect(sessionKindOptions('darwin').slice(3)).toMatchObject(additional)
  })

  it('uses platform-specific defaults without changing agent isolation', () => {
    expect(defaultSessionKindPreferences('win32')).toEqual({
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
    expect(defaultSessionKindPreferences('darwin')).toEqual({
      shell: { enabled: true, worktree: false },
      powershell: { enabled: false, worktree: false },
      cmd: { enabled: false, worktree: false },
      claude: { enabled: true, worktree: true },
      codex: { enabled: true, worktree: true },
      gemini: { enabled: false, worktree: true },
      copilot: { enabled: false, worktree: true },
      cursor: { enabled: false, worktree: true },
      comate: { enabled: false, worktree: true },
      qwen: { enabled: false, worktree: true }
    })
  })
})
