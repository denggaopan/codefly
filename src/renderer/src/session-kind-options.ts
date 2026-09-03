import type { HostPlatform, SessionKind, SessionKindPreferences } from '../../shared/contracts'
import type { TranslationKey } from './i18n'

/**
 * `primary` kinds are the ones CodeFly has always offered and enables by default; `additional`
 * kinds are the opt-in agent CLIs. Settings renders the two groups separately — the additional
 * one collapsed — so switching on a tenth kind never turns the section into a wall of rows.
 * The launcher ignores the grouping entirely and just honours the enabled switches.
 */
export type SessionKindGroup = 'primary' | 'additional'

export type SessionKindOption = {
  kind: SessionKind
  labelKey: TranslationKey
  group: SessionKindGroup
  shortcut?: string
}

/**
 * The display name of every session kind, in one table so the launcher, the Settings rows and
 * the terminal header can never disagree about what a kind is called.
 */
const LABEL_KEYS: Readonly<Record<SessionKind, TranslationKey>> = {
  shell: 'sessionKind.shell',
  powershell: 'sessionKind.powershell',
  cmd: 'sessionKind.cmd',
  claude: 'sessionKind.claude',
  codex: 'sessionKind.codex',
  gemini: 'sessionKind.gemini',
  copilot: 'sessionKind.copilot',
  cursor: 'sessionKind.cursor',
  comate: 'sessionKind.comate',
  qwen: 'sessionKind.qwen'
}

export const sessionKindLabelKey = (kind: SessionKind): TranslationKey => LABEL_KEYS[kind]

const option = (kind: SessionKind, group: SessionKindGroup, shortcut?: string): SessionKindOption =>
  shortcut === undefined
    ? { kind, labelKey: LABEL_KEYS[kind], group }
    : { kind, labelKey: LABEL_KEYS[kind], group, shortcut }

// Appended to both platforms in the order the agent registry lists them. Every one of these
// CLIs is cross-platform, so neither host gets a shorter list.
const ADDITIONAL_OPTIONS: readonly SessionKindOption[] = [
  option('gemini', 'additional'),
  option('copilot', 'additional'),
  option('cursor', 'additional'),
  option('comate', 'additional'),
  option('qwen', 'additional')
]

const PLATFORM_OPTIONS: Readonly<Record<HostPlatform, readonly SessionKindOption[]>> = {
  win32: [
    option('powershell', 'primary'),
    option('cmd', 'primary'),
    option('claude', 'primary'),
    option('codex', 'primary'),
    ...ADDITIONAL_OPTIONS
  ],
  darwin: [
    option('shell', 'primary', 'Cmd+T'),
    option('claude', 'primary'),
    option('codex', 'primary'),
    ...ADDITIONAL_OPTIONS
  ]
}

export const sessionKindOptions = (platform: HostPlatform): readonly SessionKindOption[] => PLATFORM_OPTIONS[platform]

export const defaultSessionKindPreferences = (platform: HostPlatform): SessionKindPreferences => ({
  shell: { enabled: platform === 'darwin', worktree: false },
  powershell: { enabled: platform === 'win32', worktree: false },
  cmd: { enabled: platform === 'win32', worktree: false },
  claude: { enabled: true, worktree: true },
  codex: { enabled: true, worktree: true },
  // Off until the user asks for them, but pre-set to offer a worktree once they do.
  gemini: { enabled: false, worktree: true },
  copilot: { enabled: false, worktree: true },
  cursor: { enabled: false, worktree: true },
  comate: { enabled: false, worktree: true },
  qwen: { enabled: false, worktree: true }
})
