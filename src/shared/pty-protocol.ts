import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { z } from 'zod'

import { sessionKindSchema } from './contracts'

/**
 * The wire format between the Electron main process and the resident pty-host process.
 *
 * The host outlives the UI: closing the window, reloading the renderer, or quitting CodeFly
 * leaves every PTY — and therefore every agent CLI — running, and the next UI attaches to
 * them. That is only safe if both sides agree on this file, so the version below is bumped
 * whenever a message shape changes in a way an older peer would misread. A UI that meets a
 * host speaking a different version does not try to guess: it asks that host to retire (see
 * `retire`), then starts one of its own.
 *
 * Framing is newline-delimited JSON. PTY payloads are strings, because node-pty hands out
 * strings, so nothing here needs base64. Every request carries an `id` and is answered by
 * exactly one `result`; events arrive unsolicited and carry no `id`.
 */
export const PTY_PROTOCOL_VERSION = 1

/**
 * How much recent output the host retains per session so a freshly attached UI can repaint a
 * terminal it has never seen. Kept as raw bytes rather than a parsed screen: the agent TUIs
 * repaint themselves on the resize nudge that follows a replay, and a byte tail costs nothing
 * to maintain. 256 KB is roughly a full screen of dense output plus a deep scrollback.
 */
export const REPLAY_BUFFER_CHARS = 256 * 1024

/** Mirrors `terminalWriteRequestSchema` so a write cannot grow on its way through the host. */
const writeDataSchema = z.string().max(65536)

const sessionIdSchema = z.string().min(1)
const dimensionSchema = z.number().int().min(1).max(1000)

/**
 * What the host knows about one live PTY. `hostAppVersion` in the welcome tells the UI which
 * CodeFly build spawned these — after an in-place update the host is deliberately the older
 * build, still holding the sessions that were running before the installer ran.
 */
export const ptySessionSummarySchema = z.strictObject({
  sessionId: sessionIdSchema,
  kind: sessionKindSchema,
  launchPath: z.string().min(1),
  cols: dimensionSchema,
  rows: dimensionSchema,
  startedAt: z.string().datetime()
})

export const ptyRequestSchema = z.discriminatedUnion('type', [
  /** First message on every connection; the host answers `welcome`. */
  z.strictObject({
    type: z.literal('hello'),
    id: z.number().int().nonnegative(),
    protocolVersion: z.number().int().positive(),
    appVersion: z.string().min(1)
  }),
  /**
   * Starts a PTY. The host resolves the executable and argv itself (it owns the launch
   * adapters and the CLI locator), so the UI names only the session, never a command line —
   * the same rule the IPC layer already follows for the updater's download URL.
   */
  z.strictObject({
    type: z.literal('spawn'),
    id: z.number().int().nonnegative(),
    sessionId: sessionIdSchema,
    kind: sessionKindSchema,
    launchPath: z.string().min(1),
    resume: z.boolean(),
    cols: dimensionSchema,
    rows: dimensionSchema
  }),
  z.strictObject({
    type: z.literal('write'),
    id: z.number().int().nonnegative(),
    sessionId: sessionIdSchema,
    data: writeDataSchema
  }),
  z.strictObject({
    type: z.literal('resize'),
    id: z.number().int().nonnegative(),
    sessionId: sessionIdSchema,
    cols: dimensionSchema,
    rows: dimensionSchema
  }),
  /** Ends a session for good: the PTY is signalled, then force-killed if it lingers. */
  z.strictObject({
    type: z.literal('kill'),
    id: z.number().int().nonnegative(),
    sessionId: sessionIdSchema
  }),
  /** Hands back the retained output tail plus the session's current geometry. */
  z.strictObject({
    type: z.literal('replay'),
    id: z.number().int().nonnegative(),
    sessionId: sessionIdSchema
  }),
  /**
   * Asks the host to kill every session and exit. Used when a UI finds a host speaking an
   * incompatible protocol version: the sessions cannot be adopted, so they are ended cleanly
   * (and restored with the agents' own resume flags) instead of being orphaned forever.
   */
  z.strictObject({
    type: z.literal('retire'),
    id: z.number().int().nonnegative()
  })
])

export const ptyResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('welcome'),
    id: z.number().int().nonnegative(),
    protocolVersion: z.number().int().positive(),
    hostAppVersion: z.string().min(1),
    hostPid: z.number().int().positive(),
    sessions: z.array(ptySessionSummarySchema)
  }),
  z.strictObject({
    type: z.literal('replayed'),
    id: z.number().int().nonnegative(),
    data: z.string(),
    cols: dimensionSchema,
    rows: dimensionSchema,
    /** Last data-event sequence already represented in `data`. */
    throughSequence: z.number().int().nonnegative()
  }),
  /** The generic acknowledgement for spawn/write/resize/kill/retire. */
  z.strictObject({
    type: z.literal('ok'),
    id: z.number().int().nonnegative()
  }),
  z.strictObject({
    type: z.literal('error'),
    id: z.number().int().nonnegative(),
    message: z.string()
  }),
  /**
   * Unsolicited. Both payloads deliberately match the existing `terminal:data` and
   * `terminal:exit` IPC payloads, so the main process can forward them to the renderer
   * untouched and the whole preload/renderer surface stays as it was.
   */
  z.strictObject({
    type: z.literal('data'),
    sessionId: sessionIdSchema,
    data: z.string(),
    sequence: z.number().int().positive()
  }),
  z.strictObject({
    type: z.literal('exit'),
    sessionId: sessionIdSchema,
    exitCode: z.number().int()
  })
])

export type PtySessionSummary = z.infer<typeof ptySessionSummarySchema>

/**
 * What one attach needs to repaint a terminal the current window has never drawn: the
 * retained output tail plus the geometry the PTY is actually running at. Carried both on the
 * host's `replayed` response and across `terminal:replay` to the renderer, which is why it is
 * named here rather than restated in the IPC contracts — the renderer imports it as a TYPE
 * ONLY, so this module's Node built-ins never follow it into the browser bundle.
 */
export type TerminalReplay = { data: string; cols: number; rows: number; throughSequence: number }

/**
 * `sequence` is absent only for the in-process fallback, which has no replay to de-duplicate.
 * Every resident-host event carries it so the renderer can distinguish bytes already covered
 * by a replay snapshot from bytes emitted just after that snapshot.
 */
export type TerminalDataEvent = { sessionId: string; data: string; sequence?: number }

export type PtyRequest = z.infer<typeof ptyRequestSchema>
export type PtyResponse = z.infer<typeof ptyResponseSchema>
export type PtyRequestType = PtyRequest['type']

/** Environment variables the main process sets when it spawns a host. */
export const PTY_HOST_ENV = {
  endpoint: 'CODEFLY_PTY_HOST_ENDPOINT',
  appVersion: 'CODEFLY_PTY_HOST_APP_VERSION',
  logFile: 'CODEFLY_PTY_HOST_LOG'
} as const

/**
 * One endpoint per userData directory, so a portable copy, a second Windows account, and the
 * E2E suite's own `--user-data-dir` each get their own host instead of adopting each other's
 * sessions. The directory is hashed rather than embedded: a Windows pipe name cannot contain
 * a path separator, and a macOS socket path has ~104 bytes to spend.
 */
export const ptyHostEndpoint = (userDataPath: string, platform: NodeJS.Platform): string => {
  const fingerprint = createHash('sha256').update(userDataPath).digest('hex').slice(0, 16)
  return platform === 'win32'
    ? `\\\\.\\pipe\\codefly-pty-host-${fingerprint}`
    : join(tmpdir(), `codefly-pty-host-${fingerprint}.sock`)
}

/**
 * Whether a UI speaking `PTY_PROTOCOL_VERSION` can adopt the sessions of a host that
 * announced `hostVersion`. Exact match only: these messages carry PTY bytes and kill
 * commands, and a mismatched peer is always recoverable by retiring it and resuming the
 * agents, so there is no reason to gamble on a "probably compatible" shape.
 */
export const isProtocolCompatible = (hostVersion: number): boolean => hostVersion === PTY_PROTOCOL_VERSION
