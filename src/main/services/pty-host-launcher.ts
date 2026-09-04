import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'

import {
  isProtocolCompatible,
  ptyHostEndpoint,
  ptyResponseSchema,
  PTY_HOST_ENV,
  PTY_PROTOCOL_VERSION,
  type PtyRequest,
  type PtyResponse
} from '../../shared/pty-protocol'

/**
 * Backoff before each reconnect attempt once a host has been spawned, in milliseconds. The
 * schedule sums to ~9.6 s, which is the whole budget for "a host was started, wait for it to
 * bind the endpoint": a cold Electron binary loading node-pty on a busy machine takes a
 * second or two, and anything past ten is a host that is not coming up at all.
 *
 * A fixed schedule rather than a wall-clock deadline, because the delay is injected: a test
 * that hands in an instant `sleep` still walks exactly this many attempts instead of either
 * spinning forever (Date.now never passes a deadline that no timer advanced) or having to
 * install fake timers.
 */
const CONNECT_BACKOFF_MS: readonly number[] = [50, 100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000]

/**
 * How long the host has to answer `hello`. A connection that is accepted but never answered
 * is the one failure mode that would otherwise hang the caller forever, so it is bounded
 * even though every other step fails fast on its own.
 */
const HANDSHAKE_TIMEOUT_MS = 5_000

/** How long a retired host has to close the connection before we stop waiting for it. */
const RETIRE_EXIT_TIMEOUT_MS = 3_000

/**
 * Request ids used by the handshake. The client that takes the connection over starts its own
 * ids at FIRST_CLIENT_REQUEST_ID, so a late `welcome` or retire ack can never be mistaken for
 * the answer to one of its requests.
 */
const HELLO_REQUEST_ID = 0
const RETIRE_REQUEST_ID = 1
export const FIRST_CLIENT_REQUEST_ID = 2

export type PtyHostSocketEvents = {
  data: (chunk: string | Uint8Array) => void
  close: () => void
  error: (error: Error) => void
}

/**
 * The slice of a connected socket both the handshake and the client use. Narrow on purpose:
 * everything here can be implemented by a plain object in a test, so no unit test ever has to
 * bind a real named pipe (and on Windows a stale pipe from a crashed run would be a genuinely
 * flaky dependency).
 */
export interface PtyHostSocket {
  write(data: string): void
  /** Half-closes: used to walk away from a host that must keep running. Never kills a PTY. */
  end(): void
  destroy(): void
  on<K extends keyof PtyHostSocketEvents>(event: K, listener: PtyHostSocketEvents[K]): void
  off<K extends keyof PtyHostSocketEvents>(event: K, listener: PtyHostSocketEvents[K]): void
}

/** Resolves with a connected socket, or rejects (ENOENT/ECONNREFUSED = no host listening). */
export type PtyHostConnect = (endpoint: string) => Promise<PtyHostSocket>

/**
 * The slice of ChildProcess the spawn needs. `on` matters as much as `unref`, for the same
 * reason it does in UpdaterService: spawn does NOT throw for a missing, blocked or quarantined
 * executable — it returns a process that emits `'error'` on a later tick, which is both the
 * failure that has to be reported and, with no listener attached, an unhandled event that
 * would take the main process down.
 */
export type SpawnedHost = {
  unref(): void
  on(event: 'error', listener: (error: Error) => void): void
}

export type HostSpawnOptions = {
  detached: true
  stdio: 'ignore'
  windowsHide: true
  env: NodeJS.ProcessEnv
}

export type HostSpawner = (runtime: string, args: readonly string[], options: HostSpawnOptions) => SpawnedHost

/**
 * Where the resident host lives and what runs it. Resolved by the composition root
 * (src/main/index.ts) and injected, never read here: this file has to stay importable under
 * vitest, and `app.getAppPath()` / `app.getPath('userData')` only exist inside a live Electron
 * main process.
 *
 * What the composition root is expected to hand over:
 * - `runtime`: an Electron binary — `process.execPath`, or a staged copy of it. Together with
 *   ELECTRON_RUN_AS_NODE=1 (set below) it behaves as a plain Node runtime while still being
 *   the exact ABI node-pty was built against, verified on Windows as the combination that
 *   loads node-pty and drives ConPTY from a detached process.
 * - `script`: the built host entry (`out/main/pty-host.mjs`), or a staged copy of it.
 * - `logPath`: a file under userData. The host is spawned with stdio 'ignore', so its log file
 *   is the only way to ever learn why it failed to start.
 *
 * Resolution may be asynchronous and may fail, because on packaged Windows it is not just path
 * arithmetic: the runtime has to be staged outside the install directory first, or the next
 * in-place update would kill the host it is supposed to survive. A rejection here is reported
 * as `unavailable`, like any other reason a host could not be started.
 */
export type HostLaunchSpec = { runtime: string; script: string; logPath: string }
export type ResolveHostLaunchSpec = () => HostLaunchSpec | Promise<HostLaunchSpec>

export type Sleep = (ms: number) => Promise<void>

export type PtyHostLogger = { error(message: string, detail?: unknown): void }

export type PtyWelcome = Extract<PtyResponse, { type: 'welcome' }>

export type PtyHostAttachResult =
  /**
   * A connected, protocol-compatible host. `residue` is the undelivered tail of the handshake
   * read (see `shakeHands`) and must be fed to whatever takes over reading the socket.
   */
  | { status: 'attached'; socket: PtyHostSocket; welcome: PtyWelcome; residue: string }
  /** No host is listening and none could be started (or it never accepted a connection). */
  | { status: 'unavailable'; message: string }
  /** A host is listening, but it speaks a protocol this build cannot adopt sessions over. */
  | { status: 'incompatible'; message: string; hostProtocolVersion: number }

export const defaultPtyHostLogger: PtyHostLogger = {
  error(message, detail) {
    if (detail === undefined) console.error(message)
    else console.error(message, detail)
  }
}

export const encodeRequest = (request: PtyRequest): string => `${JSON.stringify(request)}\n`

/**
 * Re-encodes an already validated response. Lossless because `ptyResponseSchema` is a union
 * of `strictObject`s: a parsed response holds exactly the declared fields, so writing it back
 * out yields a line the next reader parses into the same value. Used to hand back frames the
 * handshake had to decode before it found the welcome.
 */
export const encodeResponse = (response: PtyResponse): string => `${JSON.stringify(response)}\n`

/**
 * Splits NDJSON text into validated responses and returns the trailing partial line.
 *
 * Both directions of this connection are streams: one write can arrive as three chunks, three
 * writes can arrive as one, and a chunk can end in the middle of a JSON object. Callers keep
 * `rest` and prepend it to the next chunk. A line that is not JSON, or is JSON the protocol
 * does not describe, is reported and dropped — a peer that garbles one frame must not be able
 * to take down the process or desynchronise the framing of the frames around it.
 */
export const decodeResponses = (
  text: string,
  onMalformed: (line: string, error: unknown) => void
): { responses: PtyResponse[]; rest: string } => {
  const responses: PtyResponse[] = []
  let rest = text
  for (;;) {
    const newline = rest.indexOf('\n')
    if (newline < 0) break
    const line = rest.slice(0, newline).trim()
    rest = rest.slice(newline + 1)
    if (line.length === 0) continue
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch (error) {
      onMalformed(line, error)
      continue
    }
    const parsed = ptyResponseSchema.safeParse(payload)
    if (!parsed.success) {
      onMalformed(line, parsed.error)
      continue
    }
    responses.push(parsed.data)
  }
  return { responses, rest }
}

/**
 * Per-connection UTF-8 chunk decoder. Production sockets are read with `setEncoding('utf8')`,
 * so Node has already joined characters split across packets and chunks arrive as strings;
 * this streaming decoder covers a socket handed over without an encoding, where a naive
 * `toString()` per chunk would corrupt any multi-byte character that straddles a packet
 * boundary (agent CLIs draw their TUIs out of box-drawing characters, so this is the normal
 * case, not an exotic one).
 */
export const createChunkDecoder = (): ((chunk: string | Uint8Array) => string) => {
  const decoder = new TextDecoder('utf-8')
  return (chunk) => (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
}

class NodeSocketAdapter implements PtyHostSocket {
  constructor(private readonly socket: Socket) {
    // A socket that emits 'error' with no listener throws. Subscribers attach their own via
    // `on('error')`, but there are windows with none (between the handshake handing the socket
    // over and the client binding it, and after a deliberate `end()`), and an ECONNRESET in
    // one of those windows must not reach the process as an uncaught exception.
    socket.on('error', () => undefined)
  }

  write(data: string): void {
    this.socket.write(data)
  }

  end(): void {
    this.socket.end()
  }

  destroy(): void {
    this.socket.destroy()
  }

  on<K extends keyof PtyHostSocketEvents>(event: K, listener: PtyHostSocketEvents[K]): void {
    this.socket.on(event, listener as (...args: unknown[]) => void)
  }

  off<K extends keyof PtyHostSocketEvents>(event: K, listener: PtyHostSocketEvents[K]): void {
    this.socket.off(event, listener as (...args: unknown[]) => void)
  }
}

const defaultConnect: PtyHostConnect = (endpoint) =>
  new Promise<PtyHostSocket>((resolve, reject) => {
    const socket = createConnection(endpoint)
    // NDJSON is UTF-8 text, and Node's decoder is the only one that sees every byte of this
    // stream, so let it be the one that joins multi-byte characters split across packets.
    socket.setEncoding('utf8')
    const adapter = new NodeSocketAdapter(socket)
    const onConnect = (): void => {
      socket.removeListener('error', onConnectError)
      resolve(adapter)
    }
    const onConnectError = (error: Error): void => {
      socket.removeListener('connect', onConnect)
      socket.destroy()
      reject(error)
    }
    socket.once('connect', onConnect)
    socket.once('error', onConnectError)
  })

const defaultHostSpawner: HostSpawner = (runtime, args, options) => spawn(runtime, [...args], options)

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

type ReachResult = { status: 'connected'; socket: PtyHostSocket } | { status: 'failed'; message: string }

type HandshakeResult =
  | { status: 'ok'; welcome: PtyWelcome; residue: string }
  | { status: 'failed'; message: string }

type AttachAttempt = PtyHostAttachResult | { status: 'retire-and-retry'; socket: PtyHostSocket; welcome: PtyWelcome }

/**
 * Gets the main process a connected, protocol-compatible pty-host — or an explicit reason why
 * it could not. Discovery, spawning and version negotiation live here; everything about what
 * the messages mean lives in PtyHostClient.
 *
 * Nothing on this class rejects. The caller is the main process on a path that ends at the
 * renderer, and "there is no host and one cannot be started" is an outcome the UI has to be
 * able to describe, not an exception — the same rule AppInfoService and UpdaterService follow.
 * The two failures are kept apart on purpose: `unavailable` means no PTY exists anywhere and
 * the sessions can simply be started, while `incompatible` means PTYs may still be alive
 * inside a host this build cannot talk to.
 */
export class PtyHostLauncher {
  readonly endpoint: string

  constructor(
    userDataPath: string,
    private readonly appVersion: string,
    private readonly resolveLaunchSpec: ResolveHostLaunchSpec,
    private readonly connect: PtyHostConnect = defaultConnect,
    private readonly spawnHost: HostSpawner = defaultHostSpawner,
    platform: NodeJS.Platform = process.platform,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    /** Backoff between reconnect attempts. */
    private readonly sleep: Sleep = defaultSleep,
    /**
     * Timers for the handshake and retire deadlines. Separate from `sleep` so a test can make
     * backoff instant without also making every deadline expire immediately.
     */
    private readonly deadline: Sleep = defaultSleep,
    private readonly logger: PtyHostLogger = defaultPtyHostLogger
  ) {
    this.endpoint = ptyHostEndpoint(userDataPath, platform)
  }

  /**
   * Connect to the running host if there is one, otherwise start one and wait for it.
   *
   * A host that answers with a different protocol version is retired rather than adopted, and
   * this build starts its own. Guessing compatibility is not an option: these messages carry
   * PTY bytes and kill commands, and a shape either side reads differently means writes going
   * to the wrong session or a kill that silently does nothing. Retiring costs the user very
   * little, because ending an agent's PTY is not ending its conversation — the next start
   * passes the agent's own resume flag (see `agentLaunchArgs`) and the CLI picks the
   * conversation back up. This only happens right after an in-place update, where the host
   * still running is the build that was replaced.
   *
   * Exactly one retry. Two builds that each retire the other would otherwise take turns
   * killing PTYs forever, and the second failure is a fact worth reporting rather than
   * something to keep grinding at.
   */
  async attach(): Promise<PtyHostAttachResult> {
    const first = await this.attachOnce(false)
    if (first.status !== 'retire-and-retry') return first

    this.logger.error(
      `PtyHostLauncher: retiring a pty-host that speaks protocol ${first.welcome.protocolVersion} (this build speaks ${PTY_PROTOCOL_VERSION}).`
    )
    await this.retire(first.socket)

    const second = await this.attachOnce(true)
    if (second.status !== 'retire-and-retry') return second

    // Still incompatible after retiring one and starting our own: either the old host refused
    // to let go of the endpoint, or something else entirely is listening on it.
    second.socket.destroy()
    return {
      status: 'incompatible',
      message: `The pty-host at ${this.endpoint} speaks protocol ${second.welcome.protocolVersion}, but this build speaks ${PTY_PROTOCOL_VERSION}, and it could not be replaced.`,
      hostProtocolVersion: second.welcome.protocolVersion
    }
  }

  private async attachOnce(spawnFirst: boolean): Promise<AttachAttempt> {
    const reached = await this.reachHost(spawnFirst)
    if (reached.status === 'failed') return { status: 'unavailable', message: reached.message }

    const handshake = await this.shakeHands(reached.socket)
    if (handshake.status === 'failed') {
      reached.socket.destroy()
      return { status: 'unavailable', message: handshake.message }
    }

    if (isProtocolCompatible(handshake.welcome.protocolVersion)) {
      return { status: 'attached', socket: reached.socket, welcome: handshake.welcome, residue: handshake.residue }
    }
    return { status: 'retire-and-retry', socket: reached.socket, welcome: handshake.welcome }
  }

  private async reachHost(spawnFirst: boolean): Promise<ReachResult> {
    if (!spawnFirst) {
      // No log for this one: "nothing is listening" is the expected answer on a cold start.
      const existing = await this.tryConnect()
      if (existing) return { status: 'connected', socket: existing }
    }

    const started = await this.startHost()
    if (started.status === 'failed') return started

    for (const backoff of CONNECT_BACKOFF_MS) {
      await this.sleep(backoff)
      const failure = started.failure()
      if (failure) {
        return { status: 'failed', message: `The pty-host process could not be started: ${failure.message}` }
      }
      const socket = await this.tryConnect()
      if (socket) return { status: 'connected', socket }
    }
    return { status: 'failed', message: `Timed out waiting for a pty-host to accept a connection at ${this.endpoint}.` }
  }

  private async tryConnect(): Promise<PtyHostSocket | undefined> {
    try {
      return await this.connect(this.endpoint)
    } catch {
      return undefined
    }
  }

  private async startHost(): Promise<
    { status: 'started'; failure: () => Error | undefined } | { status: 'failed'; message: string }
  > {
    let spec: HostLaunchSpec
    try {
      spec = await this.resolveLaunchSpec()
    } catch (error) {
      return { status: 'failed', message: `The pty-host location could not be resolved: ${errorMessage(error)}` }
    }

    let failure: Error | undefined
    try {
      const child = this.spawnHost(spec.runtime, [spec.script], {
        // detached + stdio 'ignore' + unref is the whole point of the exercise: the host must
        // survive this process exiting, and it cannot hold pipes whose other end dies with us.
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...this.environment,
          // Required, not cosmetic: `runtime` is the Electron binary, and this is what makes it
          // run `hostScript` as Node instead of booting a second copy of the app. Verified on
          // Windows as the form that loads node-pty and drives ConPTY from the detached host.
          ELECTRON_RUN_AS_NODE: '1',
          [PTY_HOST_ENV.endpoint]: this.endpoint,
          [PTY_HOST_ENV.appVersion]: this.appVersion,
          [PTY_HOST_ENV.logFile]: spec.logPath
        }
      })
      child.on('error', (error) => {
        failure = error
        this.logger.error('PtyHostLauncher: the spawned pty-host process reported an error.', error)
      })
      child.unref()
    } catch (error) {
      return { status: 'failed', message: `The pty-host process could not be started: ${errorMessage(error)}` }
    }

    // Reported through a getter rather than awaited: the failure lands on a later tick, and the
    // reconnect loop is already waiting there. A host that starts fine never fails this check.
    return { status: 'started', failure: () => failure }
  }

  /**
   * Sends `hello` and waits for `welcome`.
   *
   * Reading the socket here means the handshake owns the framing for as long as it runs, and a
   * host with live sessions can start streaming `data` the moment it accepts the connection.
   * So everything decoded that is not the welcome — plus the partial line left in the buffer —
   * is handed back as `residue` for the next reader to prepend, in arrival order. Dropping it
   * would silently lose the first frames of a reattached session.
   */
  private shakeHands(socket: PtyHostSocket): Promise<HandshakeResult> {
    const decodeChunk = createChunkDecoder()
    let buffer = ''
    const carried: PtyResponse[] = []

    return new Promise<HandshakeResult>((resolve) => {
      let settled = false
      const finish = (result: HandshakeResult): void => {
        if (settled) return
        settled = true
        socket.off('data', onData)
        socket.off('close', onClose)
        socket.off('error', onError)
        resolve(result)
      }

      const onData = (chunk: string | Uint8Array): void => {
        buffer += decodeChunk(chunk)
        const decoded = decodeResponses(buffer, this.logMalformed)
        buffer = decoded.rest
        const welcome = decoded.responses.find((response): response is PtyWelcome => response.type === 'welcome')
        if (!welcome) {
          carried.push(...decoded.responses)
          return
        }
        carried.push(...decoded.responses.filter((response) => response !== welcome))
        finish({ status: 'ok', welcome, residue: carried.map(encodeResponse).join('') + buffer })
      }
      const onClose = (): void => {
        finish({ status: 'failed', message: `The pty-host at ${this.endpoint} closed the connection during the handshake.` })
      }
      const onError = (error: Error): void => {
        finish({ status: 'failed', message: `The pty-host connection failed during the handshake: ${error.message}` })
      }

      socket.on('data', onData)
      socket.on('close', onClose)
      socket.on('error', onError)

      try {
        socket.write(
          encodeRequest({
            type: 'hello',
            id: HELLO_REQUEST_ID,
            protocolVersion: PTY_PROTOCOL_VERSION,
            appVersion: this.appVersion
          })
        )
      } catch (error) {
        finish({ status: 'failed', message: `The pty-host connection could not be written to: ${errorMessage(error)}` })
        return
      }

      void this.deadline(HANDSHAKE_TIMEOUT_MS).then(() => {
        finish({ status: 'failed', message: `The pty-host at ${this.endpoint} did not answer the handshake.` })
      })
    })
  }

  /**
   * Asks a host to kill its sessions and exit, and waits for it to go.
   *
   * The connection closing is taken as proof of exit: the host's last act is to drop its
   * listeners, and waiting on the process itself is not possible from here (it was never our
   * child — it may well have been spawned by the build we just replaced). The wait is bounded
   * because a wedged host would otherwise hold the whole startup path; if it outlives the
   * timeout it keeps the endpoint, the next handshake meets it again, and `attach` reports
   * `incompatible` instead of pretending.
   */
  private async retire(socket: PtyHostSocket): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        socket.off('close', finish)
        socket.off('error', finish)
        resolve()
      }
      socket.on('close', finish)
      socket.on('error', finish)

      try {
        socket.write(encodeRequest({ type: 'retire', id: RETIRE_REQUEST_ID }))
      } catch (error) {
        this.logger.error('PtyHostLauncher: the retire request could not be written.', error)
        finish()
        return
      }
      void this.deadline(RETIRE_EXIT_TIMEOUT_MS).then(finish)
    })
    socket.destroy()
  }

  private readonly logMalformed = (line: string, error: unknown): void => {
    this.logger.error(`PtyHostLauncher: discarding an unreadable pty-host message: ${line}`, error)
  }
}
