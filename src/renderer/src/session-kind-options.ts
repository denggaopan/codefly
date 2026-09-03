import type { HostPlatform, SessionKind, SessionKindPreferences } from '../../shared/contracts'
import type { TranslationKey } from './i18n'

export type SessionKindOption = {
  kind: SessionKind
  labelKey: TranslationKey
  shortcut?: string
}

const PLATFORM_OPTIONS: Readonly<Record<HostPlatform, readonly SessionKindOption[]>> = {
  win32: [
    { kind: 'powershell', labelKey: 'sessionKind.powershell' },
    { kind: 'cmd', labelKey: 'sessionKind.cmd' },
    { kind: 'claude', labelKey: 'sessionKind.claude' },
    { kind: 'codex', labelKey: 'sessionKind.codex' }
  ],
  darwin: [
    { kind: 'shell', labelKey: 'sessionKind.shell', shortcut: 'Cmd+T' },
    { kind: 'claude', labelKey: 'sessionKind.claude' },
    { kind: 'codex', labelKey: 'sessionKind.codex' }
  ]
}

export const sessionKindOptions = (platform: HostPlatform): readonly SessionKindOption[] => PLATFORM_OPTIONS[platform]

export const defaultSessionKindPreferences = (platform: HostPlatform): SessionKindPreferences => ({
  shell: { enabled: platform === 'darwin', worktree: false },
  powershell: { enabled: platform === 'win32', worktree: false },
  cmd: { enabled: platform === 'win32', worktree: false },
  claude: { enabled: true, worktree: true },
  codex: { enabled: true, worktree: true }
})
