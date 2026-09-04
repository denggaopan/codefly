import { connect, createServer } from 'node:net'
import { unlink } from 'node:fs/promises'

import {
  PTY_PROTOCOL_VERSION,
  isProtocolCompatible,
  ptyRequestSchema,
  type PtyRequest,
  type PtyResponse
} from '../shared/pty-protocol'
import type { PtyHostEvent, PtyRegistry } from './pty-registry'

/**
 * A single request is at most a `write` of 65536 characters plus its envelope, so an
 * unterminated line this long comes from a peer that will never send a newline. Dropping the
 * connection is the only way not to grow a buffer forever on its behalf.
 */
const MAX_PENDING_CHARS = 1024 * 1024

/** How long a connect attempt may take before a socket file is assumed to have a live owner. */
const PROBE_TIMEOUT_MS = 1_000

export type HostSocket = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  setEncoding(encoding: 'utf8'): unknown
  write(data: string): unknown
  destroy(): unknown
}

export type HostServer = {
  on(event: 'connection', listener: (socket: HostSocket) => void): unknown
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  listen(endpoint: string, listener: () => void): unknown
  close(listener?: (error?: Error) => void): unknown
}

/** Whether something is listening on `endpoint` right now. */
export type ProbeEndpoint = (endpoint: string) => Promise<boolean>

type RegistryPort = Pick<
  PtyRegistry,
  'spawn' | 'write' | 'resize' | 'kill' | 'killAll' | 'replay' | 'list' | 'onEvent'
>

export type PtyHostServerOptions = {
  endpoint: string
  registry: RegistryPort
  /** The CodeFly build that started this host, reported in `welcome`. */
  appVersion: string
  platform: NodeJS.Platform
  log: (message: string) => void
  hostPid?: number
  createServer?: () => HostServer
  probeEndpoint?: ProbeEndpoint
  removeFile?: (path: string) => Promise<void>
  /** Called whenever the client or session population may have changed (see IdleWatchdog). */
  onStateChanged?: () => void
  exitProcess?: () => void
}

export type ListenOutcome = 'listening' | 'occupied'

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Compact enough for a log line and for an `error` response; the full zod dump is not. */
const summarizeIssues = (error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string =>
  error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')

/**
 * Best effort at the `id` of a request that failed validation, so the client's pending call
 * can be rejected instead of waiting for a timeout that the protocol does not define.
 */
const requestId = (value: unknown): number | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : undefined
}

const defaultProbeEndpoint: ProbeEndpoint = (endpoint) =>
  new Promise((resolve) => {
    const socket = connect(endpoint)
    const settle = (live: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(live)
    }
    const timer = setTimeout(() => settle(true), PROBE_TIMEOUT_MS)
    socket.on('connect', () => settle(true))
    socket.on('error', () => settle(false))
  })

const defaultRemoveFile = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch {
    // Already gone, which is the state this call was asking for.
  }
}

/**
 * The NDJSON server the UI talks to. Two rules shape everything below:
 *
 * 1. A disconnect is a detach, never a shutdown. Closing the window, reloading the renderer
 *    and quitting CodeFly all look identical here — the client socket goes away and every
 *    PTY keeps running until someone asks for it to be killed.
 * 2. Requests are handled concurrently, not queued. A `spawn` can spend seconds inside the
 *    CLI locator (macOS asks a login shell, with a five second budget), and head-of-line
 *    blocking there would freeze keystrokes for every other session. Each request carries an
 *    `id` and is answered by exactly one `result`, which is what lets them overlap.
 */
export class PtyHostServer {
  private readonly clients = new Set<HostSocket>()
  private readonly options: PtyHostServerOptions
  private readonly createServer: () => HostServer
  private readonly probeEndpoint: ProbeEndpoint
  private readonly removeFile: (path: string) => Promise<void>
  private readonly unsubscribe: () => void
  private server?: HostServer
  private closed = false

  constructor(options: PtyHostServerOptions) {
    this.options = options
    this.createServer = options.createServer ?? (() => createServer())
    this.probeEndpoint = options.probeEndpoint ?? defaultProbeEndpoint
    this.removeFile = options.removeFile ?? defaultRemoveFile
    this.unsubscribe = options.registry.onEvent((event) => this.broadcast(event))
  }

  get clientCount(): number {
    return this.clients.size
  }

  /**
   * Claims the endpoint, which is also the host's single-instance lock: one host per userData
   * directory owns every session in it, so a second one must not start.
   */
  async listen(): Promise<ListenOutcome> {
    const first = await this.tryListen()
    if (first.ok) return 'listening'
    if (first.error.code !== 'EADDRINUSE') throw first.error

    if (this.options.platform === 'win32') {
      // A named pipe exists only while its server does, so EADDRINUSE here always means a
      // live host — there is no stale-file case to clean up.
      this.options.log(`Another pty-host already owns ${this.options.endpoint}; exiting.`)
      return 'occupied'
    }

    // A unix socket file outlives the process that created it, so EADDRINUSE says nothing
    // about whether anyone is listening. Only a refused connection proves the file is
    // stale; a successful one — or one that hangs — means someone is home, and unlinking
    // the file underneath them would leave the UI talking to a host nobody can find again.
    if (await this.probeEndpoint(this.options.endpoint)) {
      this.options.log(`Another pty-host already answers on ${this.options.endpoint}; exiting.`)
      return 'occupied'
    }
    this.options.log(`Removing the stale socket left at ${this.options.endpoint}.`)
    await this.removeFile(this.options.endpoint)

    const second = await this.tryListen()
    if (second.ok) return 'listening'
    // Lost a race with another host that claimed the endpoint between the probe and here.
    this.options.log(`Could not claim ${this.options.endpoint}: ${describe(second.error)}`)
    return 'occupied'
  }

  /** Stops accepting clients and drops the ones connected. PTYs are untouched. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    for (const socket of [...this.clients]) socket.destroy()
    this.clients.clear()
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  private tryListen(): Promise<{ ok: true } | { ok: false; error: NodeJS.ErrnoException }> {
    return new Promise((resolve) => {
      const server = this.createServer()
      let settled = false
      server.on('error', (error) => {
        if (settled) {
          // Runtime failure of an already listening server: nothing to answer, but it must
          // not reach the default handler and take the host — and its PTYs — down.
          this.options.log(`Endpoint error: ${describe(error)}`)
          return
        }
        settled = true
        resolve({ ok: false, error })
      })
      server.on('connection', (socket) => this.accept(socket))
      server.listen(this.options.endpoint, () => {
        settled = true
        this.server = server
        this.options.log(`Listening on ${this.options.endpoint}.`)
        resolve({ ok: true })
      })
    })
  }

  private accept(socket: HostSocket): void {
    // Decoding here rather than per chunk is what makes multi-byte UTF-8 output survive a
    // chunk boundary: Node's decoder holds the partial sequence until the rest arrives.
    socket.setEncoding('utf8')
    this.clients.add(socket)
    this.options.log(`Client attached (${this.clients.size} connected).`)

    let pending = ''
    socket.on('data', (chunk) => {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let lineBreak = pending.indexOf('\n')
      while (lineBreak !== -1) {
        const line = pending.slice(0, lineBreak)
        pending = pending.slice(lineBreak + 1)
        this.receive(socket, line)
        lineBreak = pending.indexOf('\n')
      }
      // Only the unterminated remainder is capped. A burst of complete requests arriving in
      // one read is legitimate — they were all handled above — so measuring the whole chunk
      // instead would drop a client for being fast.
      if (pending.length > MAX_PENDING_CHARS) {
        this.options.log('Dropping a client that sent an unterminated request.')
        pending = ''
        socket.destroy()
      }
    })
    socket.on('error', (error) => {
      // A close always follows, which is where the client is forgotten.
      this.options.log(`Client socket error: ${describe(error)}`)
    })
    socket.on('close', () => {
      this.clients.delete(socket)
      this.options.log(`Client detached (${this.clients.size} connected); sessions keep running.`)
      this.options.onStateChanged?.()
    })
    this.options.onStateChanged?.()
  }

  private receive(socket: HostSocket, line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      this.options.log(`Ignoring a line that is not JSON: ${describe(error)}`)
      return
    }

    const request = ptyRequestSchema.safeParse(parsed)
    if (!request.success) {
      const id = requestId(parsed)
      const message = summarizeIssues(request.error)
      if (id === undefined) {
        // Without an id there is nothing to answer, and guessing one would resolve some
        // unrelated pending call on the client.
        this.options.log(`Ignoring an unaddressable request: ${message}`)
        return
      }
      this.send(socket, { type: 'error', id, message })
      return
    }

    void this.dispatch(socket, request.data)
  }

  private async dispatch(socket: HostSocket, request: PtyRequest): Promise<void> {
    if (request.type === 'retire') {
      // Answered before the sessions die so the UI knows the host accepted, even though the
      // socket is about to be dropped along with the process.
      this.send(socket, { type: 'ok', id: request.id })
      await this.retire()
      return
    }

    if (request.type === 'replay') {
      // This response is the ordering boundary for live output on this socket. Do not cross an
      // `await`: a data event emitted after the snapshot must be written after the response.
      try {
        const snapshot = this.options.registry.replay(request.sessionId)
        this.send(socket, { type: 'replayed', id: request.id, ...snapshot })
      } catch (error) {
        this.send(socket, { type: 'error', id: request.id, message: describe(error) })
      } finally {
        this.options.onStateChanged?.()
      }
      return
    }

    try {
      this.send(socket, await this.handle(request))
    } catch (error) {
      this.send(socket, { type: 'error', id: request.id, message: describe(error) })
    } finally {
      this.options.onStateChanged?.()
    }
  }

  private async handle(request: Exclude<PtyRequest, { type: 'retire' | 'replay' }>): Promise<PtyResponse> {
    const { registry } = this.options
    switch (request.type) {
      case 'hello': {
        if (!isProtocolCompatible(request.protocolVersion)) {
          // Answered anyway: only the client can decide whether to retire this host, and it
          // needs the welcome to find out what it is talking to.
          this.options.log(
            `Client speaks protocol ${request.protocolVersion}, host speaks ${PTY_PROTOCOL_VERSION}; awaiting its decision.`
          )
        }
        return {
          type: 'welcome',
          id: request.id,
          protocolVersion: PTY_PROTOCOL_VERSION,
          hostAppVersion: this.options.appVersion,
          hostPid: this.options.hostPid ?? process.pid,
          sessions: registry.list()
        }
      }
      case 'spawn': {
        await registry.spawn(
          request.sessionId,
          request.kind,
          request.launchPath,
          request.resume,
          request.cols,
          request.rows
        )
        return { type: 'ok', id: request.id }
      }
      case 'write': {
        registry.write(request.sessionId, request.data)
        return { type: 'ok', id: request.id }
      }
      case 'resize': {
        registry.resize(request.sessionId, request.cols, request.rows)
        return { type: 'ok', id: request.id }
      }
      case 'kill': {
        await registry.kill(request.sessionId)
        return { type: 'ok', id: request.id }
      }
    }
  }

  private async retire(): Promise<void> {
    this.options.log('Retiring: killing every session, then exiting.')
    await this.options.registry.killAll()
    await this.close()
    this.options.exitProcess?.()
  }

  /**
   * Events go to every attached client rather than to per-session subscribers, which is the
   * semantic the IPC layer already had: the main process forwards all terminal output to the
   * renderer and lets it route by session id.
   */
  private broadcast(event: PtyHostEvent): void {
    for (const socket of [...this.clients]) this.send(socket, event)
  }

  private send(socket: HostSocket, response: PtyResponse): void {
    try {
      socket.write(`${JSON.stringify(response)}\n`)
    } catch (error) {
      this.options.log(`Writing a ${response.type} to a client failed: ${describe(error)}`)
    }
  }
}
