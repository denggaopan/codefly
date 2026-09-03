import { describe, expect, it } from 'vitest'

import { defaultSessionKindPreferences, sessionKindOptions } from './session-kind-options'

describe('session kind options', () => {
  it('keeps the established Windows kinds and advertises no accelerator', () => {
    expect(sessionKindOptions('win32')).toMatchObject([
      { kind: 'powershell' },
      { kind: 'cmd' },
      { kind: 'claude' },
      { kind: 'codex' }
    ])
    expect(sessionKindOptions('win32').map((option) => option.shortcut)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })

  it('offers the native Shell and agents on macOS', () => {
    expect(sessionKindOptions('darwin')).toMatchObject([
      { kind: 'shell', shortcut: 'Cmd+T' },
      { kind: 'claude' },
      { kind: 'codex' }
    ])
  })

  it('uses platform-specific defaults without changing agent isolation', () => {
    expect(defaultSessionKindPreferences('win32')).toEqual({
      shell: { enabled: false, worktree: false },
      powershell: { enabled: true, worktree: false },
      cmd: { enabled: true, worktree: false },
      claude: { enabled: true, worktree: true },
      codex: { enabled: true, worktree: true }
    })
    expect(defaultSessionKindPreferences('darwin')).toEqual({
      shell: { enabled: true, worktree: false },
      powershell: { enabled: false, worktree: false },
      cmd: { enabled: false, worktree: false },
      claude: { enabled: true, worktree: true },
      codex: { enabled: true, worktree: true }
    })
  })
})
