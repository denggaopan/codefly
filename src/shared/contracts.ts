import { z } from 'zod'

import type { ExternalLinkTarget } from './links'

export const sessionKindSchema = z.enum(['powershell', 'cmd', 'claude', 'codex'])
export const runtimeStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'missing'])
export const titleStateSchema = z.enum(['pending', 'complete'])

export const projectRecordSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  repoRoot: z.string().min(1).optional(),
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

export const capabilityStateSchema = z.strictObject({
  claude: toolAvailabilitySchema,
  codex: toolAvailabilitySchema,
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
  powershell: sessionKindPreferenceSchema,
  cmd: sessionKindPreferenceSchema,
  claude: sessionKindPreferenceSchema,
  codex: sessionKindPreferenceSchema
}

export const sessionKindPreferencesSchema = z.strictObject(sessionKindPreferencesShape)

// Stored preferences are read leniently and merged over the defaults, per kind and per
// field: a value written by a different build may be missing a kind, missing a field, or
// carry one this build does not know about, and a partially readable preference is still
// better than silently resetting all four kinds.
export const storedSessionKindPreferencesSchema = z
  .object({
    powershell: z.object(sessionKindPreferenceShape).partial(),
    cmd: z.object(sessionKindPreferenceShape).partial(),
    claude: z.object(sessionKindPreferenceShape).partial(),
    codex: z.object(sessionKindPreferenceShape).partial()
  })
  .partial()

/**
 * Every kind is offered by default. Shells default to the project directory — a quick
 * terminal should not spawn a branch — while the agents default to an isolated worktree,
 * which is the reason CodeFly creates worktrees at all.
 */
export const DEFAULT_SESSION_KIND_PREFERENCES: Readonly<SessionKindPreferences> = {
  powershell: { enabled: true, worktree: false },
  cmd: { enabled: true, worktree: false },
  claude: { enabled: true, worktree: true },
  codex: { enabled: true, worktree: true }
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
export type ProjectRecord = z.infer<typeof projectRecordSchema>
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type SessionKind = z.infer<typeof sessionKindSchema>
export type CapabilityState = z.infer<typeof capabilityStateSchema>
export type ThemePreference = z.infer<typeof themePreferenceSchema>
export type SessionKindPreference = z.infer<typeof sessionKindPreferenceSchema>
export type SessionKindPreferences = z.infer<typeof sessionKindPreferencesSchema>

export type AppSnapshot = { state: AppState; capabilities: CapabilityState; recoveryWarning?: string }

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
