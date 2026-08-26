import { z } from 'zod'

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

export const createSessionRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  kind: sessionKindSchema
})

export const sessionIdRequestSchema = z.strictObject({
  sessionId: z.string().min(1)
})

export const projectIdRequestSchema = z.strictObject({
  projectId: z.string().min(1)
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

export type AppState = z.infer<typeof appStateSchema>
export type ProjectRecord = z.infer<typeof projectRecordSchema>
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type SessionKind = z.infer<typeof sessionKindSchema>
export type CapabilityState = z.infer<typeof capabilityStateSchema>

export type AppSnapshot = { state: AppState; capabilities: CapabilityState }

export type DeleteSessionResult =
  | { status: 'deleted' }
  | { status: 'dirty'; changedFiles: number }
  | { status: 'failed'; message: string }
