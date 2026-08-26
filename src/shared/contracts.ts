import { z } from 'zod'

export const sessionKindSchema = z.enum(['powershell', 'cmd', 'claude', 'codex'])
export const runtimeStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'missing'])
export const titleStateSchema = z.enum(['pending', 'complete'])

export const projectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  repoRoot: z.string().min(1).optional(),
  createdAt: z.string().datetime()
})

export const sessionRecordSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    kind: sessionKindSchema,
    title: z.string().min(1),
    titleState: titleStateSchema,
    createdAt: z.string().datetime(),
    mode: z.enum(['worktree', 'ordinary']),
    worktreeName: z.string().min(1).optional(),
    worktreePath: z.string().min(1).optional(),
    branchName: z.string().min(1).optional(),
    launchPath: z.string().min(1),
    status: runtimeStatusSchema,
    lastError: z.string().optional()
  })
  .superRefine((session, ctx) => {
    if (session.mode !== 'worktree') return

    for (const field of ['worktreeName', 'worktreePath', 'branchName'] as const) {
      if (!session[field]) {
        ctx.addIssue({
          code: 'custom',
          message: `${field} is required for worktree sessions`,
          path: [field]
        })
      }
    }
  })

export const appStateSchema = z.object({
  version: z.literal(1),
  projects: z.array(projectRecordSchema),
  sessions: z.array(sessionRecordSchema)
})

export const toolAvailabilitySchema = z.object({
  available: z.boolean(),
  detail: z.string()
})

export const capabilityStateSchema = z.object({
  claude: toolAvailabilitySchema,
  codex: toolAvailabilitySchema,
  vscode: toolAvailabilitySchema
})

export const createSessionRequestSchema = z.object({
  projectId: z.string().min(1),
  kind: sessionKindSchema
})

export const sessionIdRequestSchema = z.object({
  sessionId: z.string().min(1)
})

export const projectIdRequestSchema = z.object({
  projectId: z.string().min(1)
})

export const terminalWriteRequestSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string().max(65536)
})

export const terminalResizeRequestSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
})

export const firstInputRequestSchema = z.object({
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
