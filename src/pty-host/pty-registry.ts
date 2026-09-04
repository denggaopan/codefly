import { spawn as spawnPty } from 'node-pty'

import type { SessionKind } from '../shared/contracts'
import {
  REPLAY_BUFFER_CHARS,
  type PtyResponse,
  type PtySessionSummary
} from '../shared/pty-protocol'
import type { LaunchSpecResolver } from './launch-spec'

/** Mirrors the protocol's `dimensionSchema`, which is what the wire already enforces. */
const MAX_DIMENSION = 1000
const KILL_TIMEOUT_MS = 2_000

export type PtyDisposable = { dispose(): void }

export interface ManagedPty {
  onData(listener: (data: string) => void): PtyDisposable
  onExit(listener: (event: { exitCode: number }) => void): PtyDisposable
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type PtySpawnOptions = {
  name: 'xterm-256color'
  cols: number
  rows: number
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface IPtyFactory {
  spawn(file: string, args: readonly string[] | string, options: PtySpawnOptions): ManagedPty
}

/** The two unsolicited messages of the protocol; the only things the registry publishes. */
export type PtyHostEvent = Extract<PtyResponse, { type: 'data' | 'exit' }>

export type ReplaySnapshot = { data: string; cols: number; rows: number; throughSequence: number }

type LaunchResolver = Pick<LaunchSpecResolver, 'resolveLaunchSpec'>

type KillState = {
  promise: Promise<void>
  timer: ReturnType<typeof setTimeout>
  resolve(): void
}

type PtyEntry = {
  readonly sessionId: string
  readonly kind: SessionKind
  readonly launchPath: string
  readonly startedAt: string
  readonly pty: ManagedPty
  readonly dataSubscription: PtyDisposable
  readonly exitSubscription: PtyDisposable
  cols: number
  rows: number
  replay: string
  sequence: number
  kill?: KillState
}

const productionPtyFactory: IPtyFactory = {
  spawn(file, args, options) {
    return spawnPty(file, typeof args === 'string' ? args : [...args], options) as ManagedPty
  }
}

/**
 * Keeps only the newest `REPLAY_BUFFER_CHARS` of a session's output, then discards everything
 * up to and including the first newline in what is left.
 *
 * That second step is what makes a replay safe to hand to xterm. A blind cut can land inside
 * an escape sequence, and a parser fed `[3` with no introducer — or worse, the tail of an OSC
 * string with no terminator — swallows the printable bytes that follow while it waits for the
 * parameters or the terminator that were trimmed away, so the repainted screen loses a
 * random-looking chunk of its first lines. A line feed can never appear inside an escape
 * sequence, so resuming just after one guarantees the buffer starts on a boundary the parser
 * accepts (and, incidentally, never splits a surrogate pair). Output with no newline at all
 * in the whole tail is rare enough — and the alternative, dropping it entirely, bad enough —
 * that it is passed through as-is.
 */
const trimReplayBuffer = (buffer: string): string => {
  if (buffer.length <= REPLAY_BUFFER_CHARS) return buffer
  const tail = buffer.slice(buffer.length - REPLAY_BUFFER_CHARS)
  const lineBreak = tail.indexOf('\n')
  return lineBreak === -1 ? tail : tail.slice(lineBreak + 1)
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The session table of the pty-host: every live PTY, its geometry, and a tail of its output.
 *
 * Nothing here reacts to a client coming or going — that is the whole point of the host. A
 * PTY leaves this table for exactly two reasons: its process exited, or someone asked for it
 * to be killed.
 */
export class PtyRegistry {
  private readonly entries = new Map<string, PtyEntry>()
  private readonly starting = new Set<string>()
  private readonly listeners = new Set<(event: PtyHostEvent) => void>()

  constructor(
    private readonly resolver: LaunchResolver,
    private readonly ptyFactory: IPtyFactory = productionPtyFactory,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly log: (message: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
    private readonly killTimeoutMs = KILL_TIMEOUT_MS
  ) {}

  get sessionCount(): number {
    return this.entries.size
  }

  onEvent(listener: (event: PtyHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async spawn(
    sessionId: string,
    kind: SessionKind,
    launchPath: string,
    resume: boolean,
    cols: number,
    rows: number
  ): Promise<void> {
    if (this.entries.has(sessionId) || this.starting.has(sessionId)) {
      throw new Error(`Terminal session is already running or starting: ${sessionId}`)
    }
    this.assertDimensions(cols, rows)

    this.starting.add(sessionId)
    try {
      const launch = await this.resolver.resolveLaunchSpec(kind, resume)
      const pty = this.ptyFactory.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: launchPath,
        env: { ...this.environment, TERM: 'xterm-256color', ...(launch.env ?? {}) }
      })

      // The identity comparisons below are what keep a dead PTY's late events from being
      // attributed to the live session that reused its id: a `kill` can resolve before
      // node-pty has finished draining, and the next spawn is allowed immediately.
      let entry!: PtyEntry
      const dataSubscription = pty.onData((data) => {
        if (this.entries.get(sessionId) !== entry) return
        entry.sequence += 1
        entry.replay = trimReplayBuffer(entry.replay + data)
        this.publish({ type: 'data', sessionId, data, sequence: entry.sequence })
      })
      const exitSubscription = pty.onExit(({ exitCode }) => {
        if (this.entries.get(sessionId) !== entry) return
        this.forget(entry)
        entry.kill?.resolve()
        this.publish({ type: 'exit', sessionId, exitCode })
      })
      entry = {
        sessionId,
        kind,
        launchPath,
        startedAt: this.now().toISOString(),
        pty,
        dataSubscription,
        exitSubscription,
        cols,
        rows,
        replay: '',
        sequence: 0
      }
      this.entries.set(sessionId, entry)
    } finally {
      this.starting.delete(sessionId)
    }
  }

  write(sessionId: string, data: string): void {
    this.runningEntry(sessionId).pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.runningEntry(sessionId)
    this.assertDimensions(cols, rows)
    entry.pty.resize(cols, rows)
    // Remembered so a UI that attaches later — possibly with a different window size — is
    // told the geometry the agent's TUI has actually been drawing for, and can match it
    // before repainting the replay.
    entry.cols = cols
    entry.rows = rows
  }

  replay(sessionId: string): ReplaySnapshot {
    const entry = this.runningEntry(sessionId)
    return { data: entry.replay, cols: entry.cols, rows: entry.rows, throughSequence: entry.sequence }
  }

  list(): PtySessionSummary[] {
    return [...this.entries.values()].map((entry) => ({
      sessionId: entry.sessionId,
      kind: entry.kind,
      launchPath: entry.launchPath,
      cols: entry.cols,
      rows: entry.rows,
      startedAt: entry.startedAt
    }))
  }

  /**
   * Ends a session for good, politely first: `pty.kill()` closes the ConPTY on Windows and
   * sends SIGHUP on posix, which is what lets an agent CLI flush its transcript, so the
   * force path below is only reached by a child that ignored it.
   *
   * Idempotent — a second call joins the first — because the UI can ask twice (delete right
   * after stop) and because a killed session must never be resurrected by a retry.
   */
  kill(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (!entry) return Promise.resolve()
    if (entry.kill) return entry.kill.promise

    let resolve!: () => void
    const promise = new Promise<void>((complete) => {
      resolve = complete
    })
    const timer = setTimeout(() => {
      if (this.entries.get(sessionId) !== entry) return
      // Nothing better is available than forgetting it: the signal was already sent, the
      // caller wants the session gone, and keeping an unreachable handle would leave the
      // session in `list()` — and therefore in the next UI's window — forever.
      this.forget(entry)
      this.log(`Session ${sessionId} ignored its kill for ${this.killTimeoutMs}ms; dropping it.`)
      resolve()
    }, this.killTimeoutMs)
    entry.kill = { promise, timer, resolve }

    try {
      entry.pty.kill()
    } catch (error) {
      // A throwing kill means the OS has no such process any more (ESRCH) or the ConPTY is
      // already torn down, so the session is over either way. Reporting it as a failure
      // would only make the UI offer a retry that cannot succeed.
      this.log(`Signalling session ${sessionId} failed: ${describe(error)}`)
      if (this.entries.get(sessionId) === entry) {
        this.forget(entry)
        resolve()
      }
    }
    return promise
  }

  /** Used only by `retire`: every other path leaves PTYs running on purpose. */
  async killAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((sessionId) => this.kill(sessionId)))
  }

  private runningEntry(sessionId: string): PtyEntry {
    const entry = this.entries.get(sessionId)
    if (!entry) throw new Error(`Terminal session is not running: ${sessionId}`)
    return entry
  }

  private assertDimensions(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > MAX_DIMENSION ||
      rows > MAX_DIMENSION
    ) {
      throw new Error('Terminal dimensions must be positive integers no greater than 1000.')
    }
  }

  private forget(entry: PtyEntry): void {
    this.entries.delete(entry.sessionId)
    if (entry.kill) clearTimeout(entry.kill.timer)
    entry.dataSubscription.dispose()
    entry.exitSubscription.dispose()
  }

  private publish(event: PtyHostEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        // A broken client transport must not take a PTY, or another client, down with it.
        this.log(`Publishing a ${event.type} event failed: ${describe(error)}`)
      }
    }
  }
}
