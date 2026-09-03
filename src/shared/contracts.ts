import { z } from 'zod'

import type { ExternalLinkTarget } from './links'

export const hostPlatformSchema = z.enum(['win32', 'darwin'])
// Native shells first, then the agent CLIs in the order `AGENT_KINDS` lists them. The two
// halves are spelled out here rather than derived from that registry so this file stays the
// one place to read the wire format; `agent-kinds.test.ts` asserts the halves agree.
export const sessionKindSchema = z.enum([
  'shell',
  'powershell',
  'cmd',
  'claude',
  'codex',
  'gemini',
  'copilot',
  'cursor',
  'comate',
  'qwen'
])
export const runtimeStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'missing'])
export const titleStateSchema = z.enum(['pending', 'complete'])

// Where the project's Git remote is hosted, derived from the remote URL's hostname (any host
// containing "github"/"gitlab" counts, so self-hosted instances pick up their brand mark too).
export const repoHostSchema = z.enum(['github', 'gitlab', 'git'])

// The browsable page for the project's remote. `webUrl` is what the main process hands to
// shell.openExternal — the renderer only ever names the project, never a URL — so it is
// always http(s), never a local path or file: URL (see main/services/git-remote.ts).
export const repoRemoteSchema = z.strictObject({
  host: repoHostSchema,
  webUrl: z.string().url()
})

export const projectRecordSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  repoRoot: z.string().min(1).optional(),
  repoRemote: repoRemoteSchema.optional(),
  createdAt: z.string().datetime()
})

const commonSessionRecordShape = {
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: sessionKindSchema,
  title: z.string().min(1),
  titleState: titleStateSchema,
  createdAt: z.string().datetime(),
  launchPath: z.string().min(1),
  status: runtimeStatusSchema,
  lastError: z.string().optional()
}

export const sessionRecordSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...commonSessionRecordShape,
    mode: z.literal('worktree'),
    worktreeName: z.string().min(1),
    worktreePath: z.string().min(1),
    branchName: z.string().min(1)
  }),
  z.strictObject({
    ...commonSessionRecordShape,
    mode: z.literal('ordinary'),
    worktreeName: z.string().min(1).optional(),
    worktreePath: z.string().min(1).optional(),
    branchName: z.string().min(1).optional()
  })
])

export const appStateSchema = z.strictObject({
  version: z.literal(1),
  projects: z.array(projectRecordSchema),
  sessions: z.array(sessionRecordSchema)
})

export const toolAvailabilitySchema = z.strictObject({
  available: z.boolean(),
  detail: z.string()
})

// One entry per agent kind plus VS Code. Every agent is probed when the snapshot is built,
// including the ones switched off by default: a kind can be enabled in Settings at any time
// and the launcher reads availability by kind, with nothing to fall back to.
export const capabilityStateSchema = z.strictObject({
  claude: toolAvailabilitySchema,
  codex: toolAvailabilitySchema,
  gemini: toolAvailabilitySchema,
  copilot: toolAvailabilitySchema,
  cursor: toolAvailabilitySchema,
  comate: toolAvailabilitySchema,
  qwen: toolAvailabilitySchema,
  vscode: toolAvailabilitySchema
})

// `worktree` is the explicit per-creation choice made in the launcher (kinds with the
// preference enabled offer both a plain and a "(new worktree)" entry), not a lookup of the
// stored preference: the main process never has to know what the menu currently offers.
// Omitting it means "run in the project directory", the choice that creates nothing.
export const createSessionRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  kind: sessionKindSchema,
  worktree: z.boolean().default(false)
})

export const sessionIdRequestSchema = z.strictObject({
  sessionId: z.string().min(1)
})

export const projectIdRequestSchema = z.strictObject({
  projectId: z.string().min(1)
})

// The full ordered id list (not a moved-id/index pair) so the request is idempotent and the
// service can verify it is an exact permutation of the currently persisted projects.
export const reorderProjectsRequestSchema = z.strictObject({
  orderedProjectIds: z.array(z.string().min(1)).min(1)
})

export const terminalWriteRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  data: z.string().max(65536)
})

export const terminalResizeRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
})

export const firstInputRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(65536)
})

// What the New session menu offers per kind: `enabled` decides whether the kind is listed at
// all, `worktree` whether it also gets a second "(new worktree)" entry. Renderer-owned (see
// the app store) exactly like the theme and locale — it configures the menu, while the
// actual per-session worktree decision always crosses IPC explicitly.
const sessionKindPreferenceShape = {
  enabled: z.boolean(),
  worktree: z.boolean()
}

export const sessionKindPreferenceSchema = z.strictObject(sessionKindPreferenceShape)

const sessionKindPreferencesShape = {
  shell: sessionKindPreferenceSchema,
  powershell: sessionKindPreferenceSchema,
  cmd: sessionKindPreferenceSchema,
  claude: sessionKindPreferenceSchema,
  codex: sessionKindPreferenceSchema,
  gemini: sessionKindPreferenceSchema,
  copilot: sessionKindPreferenceSchema,
  cursor: sessionKindPreferenceSchema,
  comate: sessionKindPreferenceSchema,
  qwen: sessionKindPreferenceSchema
}

export const sessionKindPreferencesSchema = z.strictObject(sessionKindPreferencesShape)

// Stored preferences are read leniently and merged over the defaults, per kind and per
// field: a value written by a different build may be missing a kind, missing a field, or
// carry one this build does not know about, and a partially readable preference is still
// better than silently resetting every known kind.
export const storedSessionKindPreferencesSchema = z
  .object({
    shell: z.object(sessionKindPreferenceShape).partial(),
    powershell: z.object(sessionKindPreferenceShape).partial(),
    cmd: z.object(sessionKindPreferenceShape).partial(),
    claude: z.object(sessionKindPreferenceShape).partial(),
    codex: z.object(sessionKindPreferenceShape).partial(),
    gemini: z.object(sessionKindPreferenceShape).partial(),
    copilot: z.object(sessionKindPreferenceShape).partial(),
    cursor: z.object(sessionKindPreferenceShape).partial(),
    comate: z.object(sessionKindPreferenceShape).partial(),
    qwen: z.object(sessionKindPreferenceShape).partial()
  })
  .partial()

/**
 * Windows-compatible defaults used before the platform snapshot arrives and by browser
 * tests. Platform-aware renderer defaults enable only that host's native shell; all native
 * shells default to the project directory while agents default to an isolated worktree.
 *
 * Only Claude and Codex are offered out of the box. The other agent CLIs stay switched off
 * so the New session menu does not list five tools the user may not have installed — but
 * their worktree switch still defaults on, so enabling one immediately gives it the same
 * pair of entries Claude and Codex have.
 */
export const DEFAULT_SESSION_KIND_PREFERENCES: Readonly<SessionKindPreferences> = {
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
}

export const themePreferenceSchema = z.enum(['dark', 'light'])

export const setThemeRequestSchema = z.strictObject({
  theme: themePreferenceSchema
})

// The renderer picks a link by key; the URL table itself lives in shared/links.ts and is
// resolved in the main process, so no renderer-supplied URL ever reaches the OS browser.
export const externalLinkTargetSchema = z.enum(['repository', 'changelog', 'download'])

export const openExternalLinkRequestSchema = z.strictObject({
  target: externalLinkTargetSchema
})

export const setAutoLaunchRequestSchema = z.strictObject({
  enabled: z.boolean()
})

export type AppState = z.infer<typeof appStateSchema>
export type HostPlatform = z.infer<typeof hostPlatformSchema>
export type ProjectRecord = z.infer<typeof projectRecordSchema>
export type RepoHost = z.infer<typeof repoHostSchema>
export type RepoRemote = z.infer<typeof repoRemoteSchema>
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type SessionKind = z.infer<typeof sessionKindSchema>
export type CapabilityState = z.infer<typeof capabilityStateSchema>
export type ThemePreference = z.infer<typeof themePreferenceSchema>
export type ToolAvailability = z.infer<typeof toolAvailabilitySchema>
export type SessionKindPreference = z.infer<typeof sessionKindPreferenceSchema>
export type SessionKindPreferences = z.infer<typeof sessionKindPreferencesSchema>

export type AppSnapshot = { platform: HostPlatform; state: AppState; capabilities: CapabilityState; recoveryWarning?: string }

export type DeleteSessionResult =
  | { status: 'deleted' }
  | { status: 'dirty'; changedFiles: number }
  | { status: 'failed'; message: string }

export type AppInfo = { version: string; links: Readonly<Record<ExternalLinkTarget, string>> }

// The installer the release publishes, without its download URL: the renderer only needs
// the file name and size to describe the download, and never gets to say *what* the main
// process downloads (see UpdaterService — it resolves the URL itself, exactly like
// shared/links.ts keeps renderer-supplied URLs away from shell.openExternal).
export type UpdateAssetInfo = { fileName: string; size: number }

// `none` is distinct from `up-to-date`: the repository has published no release at all, so
// there is no version to compare against rather than a comparison that came out equal.
// `asset` is absent when the release carries no Windows installer, which is what tells the
// UI to fall back to the download page instead of offering an in-app download.
export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string; latestVersion: string }
  | { status: 'available'; currentVersion: string; latestVersion: string; releaseUrl: string; asset?: UpdateAssetInfo }
  | { status: 'none'; currentVersion: string }
  | { status: 'error'; message: string }

// Streamed to the renderer while an installer downloads. `totalBytes` is 0 when the server
// sends no length, which the progress bar renders as indeterminate rather than as 0%.
export type UpdateDownloadProgress = {
  version: string
  receivedBytes: number
  totalBytes: number
}

// `cancelled` is a first-class outcome, not an error: the user asked for it, so the UI
// returns to its resting state instead of showing a failure.
export type UpdateDownloadResult =
  | { status: 'ready'; version: string; fileName: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

// `launched` means the installer process was handed to the OS and CodeFly is quitting; the
// renderer will not get another turn, so there is nothing to report on success beyond that.
export type UpdateInstallResult = { status: 'launched' } | { status: 'error'; message: string }
