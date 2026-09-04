import type { SessionRecord } from '../../shared/contracts'
import type {
  PtyRequest,
  PtyRequestType,
  PtyResponse,
  PtySessionSummary,
  TerminalDataEvent
} from '../../shared/pty-protocol'
import {
  createChunkDecoder,
  decodeResponses,
  defaultPtyHostLogger,
  encodeRequest,
  FIRST_CLIENT_REQUEST_ID,
  type PtyHostAttachResult,
  type PtyHostLogger,
  type PtyHostSocket,
  type PtyWelcome
} from './pty-host-launcher'

/**
 * The geometry a session is born with. The renderer measures the pane and resizes within a
 * frame of attaching xterm, so these are only ever the dimensions the CLI sees while it draws
 * its very first output — but they have to be *something*, and they have to come from this
 * side: the host resolves the launch itself and the renderer has not laid out a pane yet when
 * the spawn request goes out. 120x30 is what TerminalService has always used, so a session's
 * first paint is unchanged by the move to the host.
 */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

/** Mirrors the protocol's `dimensionSchema` so a nonsensical resize never leaves this process. */
const MAX_DIMENSION = 1000

/**
 * Deliberately identical to TerminalService's exports rather than imported from it: this class
 * is the drop-in replacement for that service, and it must not depend on a file that goes away
 * once the last caller has moved over. SessionCoordinator and the IPC layer bind structurally,
 * so both declarations describe the same shape and neither side needs to know which it got.
 */
export type TerminalStartOptions = {
  /** Relaunch an agent CLI so it reattaches its previous conversation instead of starting a new one. */
  resume?: boolean
}

export type TerminalEventMap = {
  data: TerminalDataEvent
  exit: { sessionId: string; exitCode: number }
}

/** The launcher, injected: this class never decides where a host comes from. */
export type PtyHostAttacher = { attach(): Promise<PtyHostAttachResult> }

export type PtyHostConnectResult =
  /**
   * Attached. `sessions` is what the host is holding right now, which is the input to
   * reconciliation against the persisted session list — including `hostAppVersion`, which
   * after an in-place update is deliberately the build that was replaced.
   */
  | { status: 'connected'; hostAppVersion: string; hostPid: number; sessions: readonly PtySessionSummary[] }
  | { status: 'unavailable'; message: string }
  | { status: 'incompatible'; message: string; hostProtocolVersion: number }

export type PtyReplay = { data: string; cols: number; rows: number; throughSequence: number }

/** A request with the id stripped: `request()` owns the id space, callers never see it. */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
type PtyRequestPayload = WithoutId<PtyRequest>

type PendingRequest = {
  type: PtyRequestType
  resolve(response: PtyResponse): void
  reject(error: unknown): void
}

type Connection = {
  socket: PtyHostSocket
  welcome: PtyWelcome
  decodeChunk: (chunk: string | Uint8Array) => string
  buffer: string
  onData: (chunk: string | Uint8Array) => void
  onClose: () => void
  onError: (error: Error) => void
}

const payloadSessionId = (payload: PtyRequestPayload): string | undefined =>
  'sessionId' in payload ? payload.sessionId : undefined

/**
 * Speaks the pty-protocol to the resident host on behalf of the main process, behind exactly
 * the interface TerminalService exposed (`start` / `write` / `resize` / `stop` / `stopAll` /
 * `isRunning` / `on`). That is the point: SessionCoordinator and register-ipc keep the calls
 * they already make, and the difference between "the PTY lives in this process" and "the PTY
 * lives in a process that outlives this one" stays inside this file.
 *
 * The additions on top of that interface exist because outliving the UI creates a state this
 * app never had before: PTYs that were already running when this process started. `connect()`
 * reports what the host holds, `replay()` fetches the output a pane has never seen, and
 * `detach()` is how the app exits without touching any of it.
 */
export class PtyHostClient {
  private connection?: Connection
  private nextRequestId = FIRST_CLIENT_REQUEST_ID
  private readonly pending = new Map<number, PendingRequest>()
  /**
   * The sessions the host is holding, as last known: seeded from the welcome, added to by a
   * successful spawn, removed by a kill ack or an `exit` event. Kept across a lost connection
   * on purpose — a dropped socket says nothing about whether the PTYs behind it died, and the
   * last known truth beats inventing either answer. A reconnect replaces the set wholesale.
   */
  private readonly live = new Set<string>()
  private readonly starting = new Set<string>()
  private readonly listeners = {
    data: new Set<(payload: TerminalEventMap['data']) => void>(),
    exit: new Set<(payload: TerminalEventMap['exit']) => void>()
  }
  private readonly disconnectListeners = new Set<() => void>()

  constructor(
    private readonly launcher: PtyHostAttacher,
    private readonly logger: PtyHostLogger = defaultPtyHostLogger,
    private readonly cols: number = DEFAULT_COLS,
    private readonly rows: number = DEFAULT_ROWS
  ) {}

  /**
   * Attaches to the host, adopting whatever it is already running. Never rejects: the caller
   * runs at app startup and has to be able to describe every outcome, and the two failures are
   * distinguishable because they call for opposite recoveries (`unavailable` — start the
   * sessions; `incompatible` — do not touch PTYs that may still be alive over there).
   */
  async connect(): Promise<PtyHostConnectResult> {
    const current = this.connection
    if (current) return this.connected(current.welcome)

    const attachment = await this.launcher.attach()
    if (attachment.status !== 'attached') return attachment

    const socket = attachment.socket
    const welcome = attachment.welcome
    let connection!: Connection
    const onData = (chunk: string | Uint8Array): void => {
      if (this.connection !== connection) return
      this.ingest(connection, chunk)
    }
    const onClose = (): void => {
      this.handleDisconnect(connection)
    }
    const onError = (error: Error): void => {
      this.logger.error('PtyHostClient: the pty-host connection failed.', error)
      this.handleDisconnect(connection)
    }
    connection = { socket, welcome, decodeChunk: createChunkDecoder(), buffer: '', onData, onClose, onError }

    this.connection = connection
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.on('error', onError)

    this.live.clear()
    for (const session of welcome.sessions) this.live.add(session.sessionId)

    // Frames the handshake had already read off the socket. Fed in only after the listeners are
    // bound and `live` is seeded, so an `exit` in the residue is handled like any other.
    if (attachment.residue.length > 0) this.ingest(connection, attachment.residue)

    return this.connected(welcome)
  }

  /** The sessions the host is holding, as last known. See the `live` field for the caveats. */
  attachedSessionIds(): readonly string[] {
    return [...this.live]
  }

  /**
   * The output tail the host retained for a session, plus the geometry it currently has.
   *
   * This is what makes a reattached pane look like it was never gone: a UI that starts after
   * the sessions did has no scrollback of its own, and the host's byte tail plus the resize the
   * renderer performs on fit is enough for the agent TUIs to repaint themselves.
   */
  async replay(sessionId: string): Promise<PtyReplay> {
    const response = await this.request({ type: 'replay', sessionId })
    if (response.type !== 'replayed') {
      throw new Error(`The pty-host answered a replay for session ${sessionId} with '${response.type}'.`)
    }
    return {
      data: response.data,
      cols: response.cols,
      rows: response.rows,
      throughSequence: response.throughSequence
    }
  }

  /**
   * Drops the connection without touching a single PTY. This is the app-exit path: the whole
   * reason the host exists is that quitting CodeFly, reloading it, or replacing it with a new
   * build must leave the agents running.
   *
   * Does not notify `onDisconnected` — this disconnection is the caller's own decision, and
   * subscribers there are written to react to losing the host, not to being told they let go.
   */
  detach(): void {
    const connection = this.connection
    if (!connection) return
    this.unbind(connection)
    this.connection = undefined
    // Anything still awaiting an answer will never get one; leaving those promises pending
    // would wedge whatever is holding a session lock.
    this.rejectPending(new Error('The pty-host connection was detached before the request was answered.'))
    connection.socket.end()
  }

  /** Fires when the connection is lost without `detach()` — see `handleDisconnect`. */
  onDisconnected(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => {
      this.disconnectListeners.delete(listener)
    }
  }

  async start(session: SessionRecord, options: TerminalStartOptions = {}): Promise<void> {
    if (this.live.has(session.id) || this.starting.has(session.id)) {
      throw new Error(`Terminal session is already running or starting: ${session.id}`)
    }

    this.starting.add(session.id)
    try {
      // Only the session is named, never a command line: the host owns the launch adapters and
      // the CLI locator, which is what keeps "which executable, which bypass flag" on one side
      // of the boundary — the same rule the IPC layer follows for the updater's download URL.
      await this.acknowledged({
        type: 'spawn',
        sessionId: session.id,
        kind: session.kind,
        launchPath: session.launchPath,
        resume: options.resume === true,
        cols: this.cols,
        rows: this.rows
      })
      this.live.add(session.id)
    } finally {
      this.starting.delete(session.id)
    }
  }

  /**
   * Fire-and-forget, like the `terminal:write` IPC channel it serves: there is no reply path
   * to the renderer for a keystroke, so a failure can only be logged. The protocol still gives
   * the request an id and the host still acks it, which is what makes an `error` answer
   * (unknown session, PTY already gone) visible in the log instead of silent.
   */
  write(sessionId: string, data: string): void {
    this.post({ type: 'write', sessionId, data })
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_DIMENSION || rows > MAX_DIMENSION) {
      // Validated here as well as at the IPC edge: the host would reject the frame on its own
      // schema, and a rejected frame costs a round trip and a log line on both sides.
      this.logger.error(`PtyHostClient: refusing to resize session ${sessionId} to ${cols}x${rows}.`)
      return
    }
    this.post({ type: 'resize', sessionId, cols, rows })
  }

  /** Ends one session for good. The host's `exit` event follows and drives the persisted status. */
  async stop(sessionId: string): Promise<void> {
    if (!this.live.has(sessionId)) return
    await this.acknowledged({ type: 'kill', sessionId })
    this.live.delete(sessionId)
  }

  /**
   * Kills every session the host is holding.
   *
   * This used to be the app-exit path, and it is not any more: exiting must leave the PTYs
   * running, so the shutdown sequence calls `detach()` instead. What is left here is the
   * explicit "end all of this" action — the one place that still wants every agent gone. The
   * name and signature are unchanged so the migration is a one-line change at each call site
   * rather than an interface change, but a caller reaching for it as cleanup is a bug.
   */
  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.live].map((sessionId) => this.stop(sessionId)))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'One or more terminal sessions could not be stopped.')
  }

  isRunning(sessionId: string): boolean {
    return this.live.has(sessionId)
  }

  on<K extends keyof TerminalEventMap>(event: K, listener: (payload: TerminalEventMap[K]) => void): () => void {
    const listeners = this.listeners[event] as Set<(payload: TerminalEventMap[K]) => void>
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  private connected(welcome: PtyWelcome): PtyHostConnectResult {
    return {
      status: 'connected',
      hostAppVersion: welcome.hostAppVersion,
      hostPid: welcome.hostPid,
      sessions: welcome.sessions
    }
  }

  private ingest(connection: Connection, chunk: string | Uint8Array): void {
    connection.buffer += connection.decodeChunk(chunk)
    const decoded = decodeResponses(connection.buffer, this.logMalformed)
    connection.buffer = decoded.rest
    for (const response of decoded.responses) this.dispatch(response)
  }

  private dispatch(response: PtyResponse): void {
    if (response.type === 'data') {
      this.publish('data', { sessionId: response.sessionId, data: response.data, sequence: response.sequence })
      return
    }
    if (response.type === 'exit') {
      this.live.delete(response.sessionId)
      this.publish('exit', { sessionId: response.sessionId, exitCode: response.exitCode })
      return
    }

    const waiting = this.pending.get(response.id)
    if (!waiting) {
      this.logger.error(`PtyHostClient: the pty-host answered request ${response.id}, which nothing is waiting for.`)
      return
    }
    this.pending.delete(response.id)
    if (response.type === 'error') {
      waiting.reject(new Error(`The pty-host rejected '${waiting.type}': ${response.message}`))
      return
    }
    waiting.resolve(response)
  }

  /**
   * The connection went away on its own: the host crashed, was killed, or the pipe broke.
   *
   * No `exit` event is synthesised for the sessions, on purpose. SessionCoordinator treats
   * `exit` as proof that a PTY is gone and persists 'stopped', and here that is exactly what
   * is not known — a broken socket is just as likely to be a dead pipe in front of live PTYs,
   * and marking those sessions stopped would leave the UI offering to "restore" agents that
   * are still running and would then be started a second time in the same worktree. Only the
   * connection is reported, through `onDisconnected`, so the layer that can reconnect and
   * reconcile against the host's own session list is the one that decides.
   */
  private handleDisconnect(connection: Connection): void {
    if (this.connection !== connection) return
    this.unbind(connection)
    this.connection = undefined
    this.rejectPending(new Error('The pty-host connection closed before the request was answered.'))
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener()
      } catch (error) {
        this.logger.error('PtyHostClient: a disconnect listener threw.', error)
      }
    }
  }

  private unbind(connection: Connection): void {
    connection.socket.off('data', connection.onData)
    connection.socket.off('close', connection.onClose)
    connection.socket.off('error', connection.onError)
  }

  private rejectPending(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const request of waiting) request.reject(error)
  }

  private request(payload: PtyRequestPayload): Promise<PtyResponse> {
    const connection = this.connection
    if (!connection) return Promise.reject(new Error(`The pty-host is not connected; '${payload.type}' was not sent.`))

    const id = this.nextRequestId
    this.nextRequestId += 1
    // Sound because `payload` is one member of the request union with only `id` removed; the
    // union itself cannot express "spread of a member" for the compiler to check.
    const request = { ...payload, id } as PtyRequest

    return new Promise<PtyResponse>((resolve, reject) => {
      this.pending.set(id, { type: payload.type, resolve, reject })
      try {
        connection.socket.write(encodeRequest(request))
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private async acknowledged(payload: PtyRequestPayload): Promise<void> {
    const response = await this.request(payload)
    // `error` answers already rejected in `dispatch`, so this only catches a host that answered
    // the right id with the wrong message.
    if (response.type !== 'ok') {
      throw new Error(`The pty-host answered '${payload.type}' with '${response.type}'.`)
    }
  }

  private post(payload: PtyRequestPayload): void {
    void this.request(payload).then(undefined, (error: unknown) => {
      const sessionId = payloadSessionId(payload)
      this.logger.error(`PtyHostClient: '${payload.type}' failed${sessionId ? ` for session ${sessionId}` : ''}.`, error)
    })
  }

  private publish<K extends keyof TerminalEventMap>(event: K, payload: TerminalEventMap[K]): void {
    const listeners = this.listeners[event] as Set<(value: TerminalEventMap[K]) => void>
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch {
        // A renderer listener must not affect PTY lifecycle or other subscribers.
      }
    }
  }

  private readonly logMalformed = (line: string, error: unknown): void => {
    this.logger.error(`PtyHostClient: discarding an unreadable pty-host message: ${line}`, error)
  }
}
