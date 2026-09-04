import { describe, expect, it, vi } from 'vitest'

import type { SessionRecord } from '../../shared/contracts'
import { PTY_PROTOCOL_VERSION, type PtyRequest, type PtySessionSummary } from '../../shared/pty-protocol'
import { PtyHostClient, type PtyHostAttacher, type TerminalEventMap } from './pty-host-client'
import {
  FIRST_CLIENT_REQUEST_ID,
  type PtyHostAttachResult,
  type PtyHostLogger,
  type PtyHostSocket,
  type PtyHostSocketEvents,
  type PtyWelcome
} from './pty-host-launcher'

const HOST_VERSION = '0.15.1'
const LAUNCH_PATH = 'C:\\Projects\\App One'

/** Lets every queued microtask (a settled request, a logged rejection) run before asserting. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const session = (id: string, kind: SessionRecord['kind'] = 'claude', launchPath = LAUNCH_PATH): SessionRecord => ({
  id,
  projectId: 'project-1',
  kind,
  title: 'Session',
  titleState: 'complete',
  createdAt: '2026-08-27T00:00:00.000Z',
  launchPath,
  status: 'running',
  mode: 'ordinary'
})

const summary = (sessionId: string): PtySessionSummary => ({
  sessionId,
  kind: 'claude',
  launchPath: LAUNCH_PATH,
  cols: 120,
  rows: 30,
  startedAt: '2026-09-04T09:00:00.000Z'
})

const welcomeOf = (sessions: readonly PtySessionSummary[]): PtyWelcome => ({
  type: 'welcome',
  id: 0,
  protocolVersion: PTY_PROTOCOL_VERSION,
  hostAppVersion: HOST_VERSION,
  hostPid: 8181,
  sessions: [...sessions]
})

const line = (response: Record<string, unknown>): string => `${JSON.stringify(response)}\n`
const okLine = (id: number): string => line({ type: 'ok', id })
const dataLine = (sessionId: string, data: string, sequence = 1): string =>
  line({ type: 'data', sessionId, data, sequence })
const exitLine = (sessionId: string, exitCode: number): string => line({ type: 'exit', sessionId, exitCode })

class RecordingLogger implements PtyHostLogger {
  readonly messages: string[] = []
  readonly details: unknown[] = []

  error(message: string, detail?: unknown): void {
    this.messages.push(message)
    this.details.push(detail)
  }

  get joined(): string {
    return this.messages.join('\n')
  }
}

class FakeSocket implements PtyHostSocket {
  readonly written: string[] = []
  ends = 0
  destroys = 0
  /** Runs synchronously inside `write`, with the parsed request. */
  answer?: (socket: FakeSocket, request: PtyRequest) => void
  private readonly dataListeners = new Set<PtyHostSocketEvents['data']>()
  private readonly closeListeners = new Set<PtyHostSocketEvents['close']>()
  private readonly errorListeners = new Set<PtyHostSocketEvents['error']>()

  write(data: string): void {
    this.written.push(data)
    this.answer?.(this, JSON.parse(data.trim()) as PtyRequest)
  }

  end(): void {
    this.ends += 1
  }

  destroy(): void {
    this.destroys += 1
  }

  on<K extends keyof PtyHostSocketEvents>(event: K, listener: PtyHostSocketEvents[K]): void {
    const listeners = this.listenersFor(event) as Set<PtyHostSocketEvents[K]>
    listeners.add(listener)
  }

  off<K extends keyof PtyHostSocketEvents>(event: K, listener: PtyHostSocketEvents[K]): void {
    const listeners = this.listenersFor(event) as Set<PtyHostSocketEvents[K]>
    listeners.delete(listener)
  }

  emitData(chunk: string | Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener(chunk)
  }

  emitClose(): void {
    for (const listener of [...this.closeListeners]) listener()
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error)
  }

  /** Answers every request from now on with the generic ack. */
  acknowledgeAll(): void {
    this.answer = (target, request) => {
      target.emitData(okLine(request.id))
    }
  }

  /** Answers every request from now on with a typed error. */
  rejectAll(message: string): void {
    this.answer = (target, request) => {
      target.emitData(line({ type: 'error', id: request.id, message }))
    }
  }

  get requests(): PtyRequest[] {
    return this.written.map((entry) => JSON.parse(entry.trim()) as PtyRequest)
  }

  private listenersFor(event: keyof PtyHostSocketEvents): Set<unknown> {
    if (event === 'data') return this.dataListeners as Set<unknown>
    if (event === 'close') return this.closeListeners as Set<unknown>
    return this.errorListeners as Set<unknown>
  }
}

class FakeAttacher implements PtyHostAttacher {
  calls = 0

  constructor(private readonly result: PtyHostAttachResult) {}

  async attach(): Promise<PtyHostAttachResult> {
    this.calls += 1
    return this.result
  }
}

type Harness = {
  client: PtyHostClient
  socket: FakeSocket
  logger: RecordingLogger
  attacher: FakeAttacher
}

const connectedHarness = async (
  options: { sessions?: readonly PtySessionSummary[]; residue?: string } = {}
): Promise<Harness> => {
  const socket = new FakeSocket()
  const logger = new RecordingLogger()
  const attacher = new FakeAttacher({
    status: 'attached',
    socket,
    welcome: welcomeOf(options.sessions ?? []),
    residue: options.residue ?? ''
  })
  const client = new PtyHostClient(attacher, logger)
  const result = await client.connect()
  expect(result.status).toBe('connected')
  return { client, socket, logger, attacher }
}

describe('PtyHostClient.connect', () => {
  it('reports what the host is holding so the caller can reconcile', async () => {
    const sessions = [summary('one'), summary('two')]
    const { client } = await connectedHarness({ sessions })

    const result = await client.connect()

    expect(result).toEqual({ status: 'connected', hostAppVersion: HOST_VERSION, hostPid: 8181, sessions })
    expect(client.attachedSessionIds()).toEqual(['one', 'two'])
    expect(client.isRunning('one')).toBe(true)
    expect(client.isRunning('missing')).toBe(false)
  })

  it('does not attach a second time while it is already connected', async () => {
    const { client, attacher } = await connectedHarness()

    await client.connect()

    expect(attacher.calls).toBe(1)
  })

  it('passes an unavailable host through as a result', async () => {
    const client = new PtyHostClient(new FakeAttacher({ status: 'unavailable', message: 'no host' }))

    await expect(client.connect()).resolves.toEqual({ status: 'unavailable', message: 'no host' })
  })

  it('passes an incompatible host through as a distinct result', async () => {
    const client = new PtyHostClient(
      new FakeAttacher({ status: 'incompatible', message: 'protocol 7', hostProtocolVersion: 7 })
    )

    await expect(client.connect()).resolves.toEqual({
      status: 'incompatible',
      message: 'protocol 7',
      hostProtocolVersion: 7
    })
  })

  it('handles the frames the handshake had already read off the socket', async () => {
    const received: TerminalEventMap['data'][] = []
    const socket = new FakeSocket()
    const attacher = new FakeAttacher({
      status: 'attached',
      socket,
      welcome: welcomeOf([summary('one')]),
      residue: `${dataLine('one', 'left over')}${exitLine('one', 0)}`
    })
    const client = new PtyHostClient(attacher)
    client.on('data', (payload) => received.push(payload))
    const exits: TerminalEventMap['exit'][] = []
    client.on('exit', (payload) => exits.push(payload))

    await client.connect()

    expect(received).toEqual([{ sessionId: 'one', data: 'left over', sequence: 1 }])
    expect(exits).toEqual([{ sessionId: 'one', exitCode: 0 }])
    expect(client.isRunning('one')).toBe(false)
  })
})

describe('PtyHostClient request correlation', () => {
  it('keeps concurrent requests apart even when the answers come back out of order', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one'), summary('two')] })

    const first = client.replay('one')
    const second = client.replay('two')
    const ids = socket.requests.map((request) => request.id)
    socket.emitData(
      line({ type: 'replayed', id: ids[1] ?? -1, data: 'second', cols: 80, rows: 24, throughSequence: 4 })
    )
    socket.emitData(
      line({ type: 'replayed', id: ids[0] ?? -1, data: 'first', cols: 120, rows: 30, throughSequence: 8 })
    )

    await expect(first).resolves.toEqual({ data: 'first', cols: 120, rows: 30, throughSequence: 8 })
    await expect(second).resolves.toEqual({ data: 'second', cols: 80, rows: 24, throughSequence: 4 })
    expect(ids).toEqual([FIRST_CLIENT_REQUEST_ID, FIRST_CLIENT_REQUEST_ID + 1])
  })

  it('rejects only the request the host answered with an error', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one'), summary('two')] })

    const first = client.replay('one')
    const second = client.replay('two')
    const ids = socket.requests.map((request) => request.id)
    socket.emitData(line({ type: 'error', id: ids[0] ?? -1, message: 'unknown session' }))
    socket.emitData(
      line({ type: 'replayed', id: ids[1] ?? -1, data: 'ok', cols: 80, rows: 24, throughSequence: 2 })
    )

    await expect(first).rejects.toThrow('unknown session')
    await expect(second).resolves.toEqual({ data: 'ok', cols: 80, rows: 24, throughSequence: 2 })
  })

  it('logs an answer nothing is waiting for instead of throwing', async () => {
    const { socket, logger } = await connectedHarness()

    socket.emitData(okLine(99))

    expect(logger.joined).toContain('request 99')
  })
})

describe('PtyHostClient framing', () => {
  it('reassembles a response that arrives in fragments', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one')] })

    const replaying = client.replay('one')
    const answer = line({
      type: 'replayed',
      id: FIRST_CLIENT_REQUEST_ID,
      data: 'hello',
      cols: 80,
      rows: 24,
      throughSequence: 3
    })
    socket.emitData(answer.slice(0, 9))
    socket.emitData(answer.slice(9, 25))
    socket.emitData(answer.slice(25))

    await expect(replaying).resolves.toEqual({ data: 'hello', cols: 80, rows: 24, throughSequence: 3 })
  })

  it('handles several frames that arrive in one chunk', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one')] })
    const received: string[] = []
    client.on('data', (payload) => received.push(payload.data))

    const stopping = client.stop('one')
    socket.emitData(`${dataLine('one', 'a')}${dataLine('one', 'b')}${okLine(FIRST_CLIENT_REQUEST_ID)}`)

    await expect(stopping).resolves.toBeUndefined()
    expect(received).toEqual(['a', 'b'])
  })

  it('decodes a multi-byte character split across two chunks', async () => {
    const { client, socket } = await connectedHarness()
    const received: string[] = []
    client.on('data', (payload) => received.push(payload.data))

    // The three bytes of U+259B start at offset 41, so this cut lands inside the character —
    // the shape agent TUIs draw themselves out of, and the one a per-chunk toString() ruins.
    const bytes = new TextEncoder().encode(dataLine('one', '▛ box'))
    socket.emitData(bytes.slice(0, 42))
    socket.emitData(bytes.slice(42))

    expect(received).toEqual(['▛ box'])
  })

  it('drops an unreadable line and keeps the connection usable', async () => {
    const { client, socket, logger } = await connectedHarness({ sessions: [summary('one')] })

    const replaying = client.replay('one')
    socket.emitData('this is not json\n')
    socket.emitData(
      line({ type: 'replayed', id: FIRST_CLIENT_REQUEST_ID, data: 'still here', cols: 80, rows: 24, throughSequence: 0 })
    )

    await expect(replaying).resolves.toMatchObject({ data: 'still here' })
    expect(logger.joined).toContain('unreadable pty-host message')
  })

  it('drops a line the protocol does not describe', async () => {
    const { socket, logger } = await connectedHarness()

    socket.emitData(line({ type: 'data', sessionId: 'one' }))

    expect(logger.joined).toContain('unreadable pty-host message')
  })
})

describe('PtyHostClient events', () => {
  it('forwards data and exit to subscribers untouched', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one')] })
    const data = vi.fn<(payload: TerminalEventMap['data']) => void>()
    const exit = vi.fn<(payload: TerminalEventMap['exit']) => void>()
    const unsubscribe = client.on('data', data)
    client.on('exit', exit)

    socket.emitData(dataLine('one', 'hello\r\n'))
    unsubscribe()
    socket.emitData(dataLine('one', 'unheard'))
    socket.emitData(exitLine('one', 3))

    expect(data.mock.calls).toEqual([[{ sessionId: 'one', data: 'hello\r\n', sequence: 1 }]])
    expect(exit).toHaveBeenCalledWith({ sessionId: 'one', exitCode: 3 })
    expect(client.isRunning('one')).toBe(false)
  })

  it('keeps serving other subscribers when one of them throws', async () => {
    const { client, socket } = await connectedHarness()
    const healthy = vi.fn<(payload: TerminalEventMap['data']) => void>()
    client.on('data', () => {
      throw new Error('renderer listener blew up')
    })
    client.on('data', healthy)

    socket.emitData(dataLine('one', 'a'))

    expect(healthy).toHaveBeenCalledWith({ sessionId: 'one', data: 'a', sequence: 1 })
  })
})

describe('PtyHostClient disconnection', () => {
  it('rejects in-flight requests, notifies subscribers, and invents no exit events', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one'), summary('two')] })
    const exit = vi.fn<(payload: TerminalEventMap['exit']) => void>()
    client.on('exit', exit)
    const disconnected = vi.fn<() => void>()
    client.onDisconnected(disconnected)

    const first = client.replay('one')
    const second = client.replay('two')
    socket.emitClose()

    await expect(first).rejects.toThrow('closed before the request was answered')
    await expect(second).rejects.toThrow('closed before the request was answered')
    expect(disconnected).toHaveBeenCalledTimes(1)
    // A dead socket is not proof of a dead PTY: synthesising 'exit' here would have
    // SessionCoordinator persist 'stopped' for agents that may still be running.
    expect(exit).not.toHaveBeenCalled()
    expect(client.isRunning('one')).toBe(true)
  })

  it('reports a socket error as a disconnection once', async () => {
    const { client, socket, logger } = await connectedHarness()
    const disconnected = vi.fn<() => void>()
    client.onDisconnected(disconnected)

    socket.emitError(new Error('ECONNRESET'))
    socket.emitClose()

    expect(disconnected).toHaveBeenCalledTimes(1)
    expect(logger.joined).toContain('connection failed')
  })

  it('refuses further requests once the connection is gone', async () => {
    const { client, socket, logger } = await connectedHarness({ sessions: [summary('one')] })
    socket.emitClose()

    await expect(client.replay('one')).rejects.toThrow('not connected')
    client.write('one', 'typed')
    await flush()

    expect(socket.requests).toEqual([])
    expect(logger.joined).toContain("'write' failed for session one")
  })
})

describe('PtyHostClient.detach', () => {
  it('walks away without killing anything', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one'), summary('two')] })
    const disconnected = vi.fn<() => void>()
    client.onDisconnected(disconnected)

    client.detach()

    expect(socket.requests).toEqual([])
    expect(socket.ends).toBe(1)
    expect(socket.destroys).toBe(0)
    // Detaching is this process's own decision, not a lost host.
    expect(disconnected).not.toHaveBeenCalled()
  })

  it('settles requests that will never be answered', async () => {
    const { client } = await connectedHarness({ sessions: [summary('one')] })

    const replaying = client.replay('one')
    client.detach()

    await expect(replaying).rejects.toThrow('detached')
  })

  it('stops reading a socket it has let go of', async () => {
    const { client, socket } = await connectedHarness()
    const data = vi.fn<(payload: TerminalEventMap['data']) => void>()
    client.on('data', data)

    client.detach()
    socket.emitData(dataLine('one', 'from another UI'))

    expect(data).not.toHaveBeenCalled()
  })
})

describe('PtyHostClient session lifecycle', () => {
  it('starts a session by naming it, never a command line', async () => {
    const { client, socket } = await connectedHarness()
    socket.acknowledgeAll()

    await client.start(session('one', 'codex', 'D:\\Work\\repo'))

    expect(socket.requests).toEqual([
      {
        type: 'spawn',
        id: FIRST_CLIENT_REQUEST_ID,
        sessionId: 'one',
        kind: 'codex',
        launchPath: 'D:\\Work\\repo',
        resume: false,
        cols: 120,
        rows: 30
      }
    ])
    expect(client.isRunning('one')).toBe(true)
  })

  it('passes the resume intent to the host', async () => {
    const { client, socket } = await connectedHarness()
    socket.acknowledgeAll()

    await client.start(session('one'), { resume: true })

    expect(socket.requests[0]).toMatchObject({ type: 'spawn', resume: true })
  })

  it('refuses to start a session the host is already running', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one')] })
    socket.acknowledgeAll()

    await expect(client.start(session('one'))).rejects.toThrow('already running or starting: one')
    expect(socket.requests).toEqual([])
  })

  it('leaves a session startable again after the host rejects the spawn', async () => {
    const { client, socket } = await connectedHarness()
    socket.rejectAll('claude is not available')

    await expect(client.start(session('one'))).rejects.toThrow('claude is not available')
    expect(client.isRunning('one')).toBe(false)

    socket.acknowledgeAll()
    await expect(client.start(session('one'))).resolves.toBeUndefined()
  })

  it('kills a session on stop and forgets it', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one')] })
    socket.acknowledgeAll()

    await client.stop('one')

    expect(socket.requests).toEqual([{ type: 'kill', id: FIRST_CLIENT_REQUEST_ID, sessionId: 'one' }])
    expect(client.isRunning('one')).toBe(false)
  })

  it('says nothing to the host about stopping a session it does not hold', async () => {
    const { client, socket } = await connectedHarness()

    await expect(client.stop('ghost')).resolves.toBeUndefined()

    expect(socket.requests).toEqual([])
  })

  it('kills every session on stopAll, which is no longer the exit path', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one'), summary('two')] })
    socket.acknowledgeAll()

    await client.stopAll()

    expect(socket.requests.map((request) => request)).toEqual([
      { type: 'kill', id: FIRST_CLIENT_REQUEST_ID, sessionId: 'one' },
      { type: 'kill', id: FIRST_CLIENT_REQUEST_ID + 1, sessionId: 'two' }
    ])
    expect(client.attachedSessionIds()).toEqual([])
  })

  it('aggregates the sessions stopAll could not kill', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one'), summary('two')] })
    socket.answer = (target, request) => {
      const failing = request.type === 'kill' && request.sessionId === 'two'
      target.emitData(failing ? line({ type: 'error', id: request.id, message: 'pty is wedged' }) : okLine(request.id))
    }

    await expect(client.stopAll()).rejects.toThrow(AggregateError)
    expect(client.attachedSessionIds()).toEqual(['two'])
  })
})

describe('PtyHostClient write and resize', () => {
  it('sends keystrokes as fire-and-forget frames', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one')] })
    socket.acknowledgeAll()

    client.write('one', 'npm test\r')

    expect(socket.requests).toEqual([
      { type: 'write', id: FIRST_CLIENT_REQUEST_ID, sessionId: 'one', data: 'npm test\r' }
    ])
  })

  it('only logs when the host rejects a write', async () => {
    const { client, socket, logger } = await connectedHarness({ sessions: [summary('one')] })
    socket.rejectAll('unknown session')

    expect(() => client.write('one', 'x')).not.toThrow()
    await flush()

    expect(logger.joined).toContain("'write' failed for session one")
  })

  it('sends a resize with the dimensions it was given', async () => {
    const { client, socket } = await connectedHarness({ sessions: [summary('one')] })
    socket.acknowledgeAll()

    client.resize('one', 200, 60)

    expect(socket.requests).toEqual([
      { type: 'resize', id: FIRST_CLIENT_REQUEST_ID, sessionId: 'one', cols: 200, rows: 60 }
    ])
  })

  it('never sends a resize the protocol would reject', async () => {
    const { client, socket, logger } = await connectedHarness({ sessions: [summary('one')] })
    socket.acknowledgeAll()

    client.resize('one', 0, 30)
    client.resize('one', 120.5, 30)
    client.resize('one', 120, 4_000)

    expect(socket.requests).toEqual([])
    expect(logger.messages).toHaveLength(3)
    expect(logger.joined).toContain('refusing to resize session one')
  })
})
