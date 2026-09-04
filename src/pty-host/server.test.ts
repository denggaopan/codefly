import { describe, expect, it, vi } from 'vitest'

import type { SessionKind } from '../shared/contracts'
import {
  PTY_PROTOCOL_VERSION,
  type PtyResponse,
  type PtySessionSummary
} from '../shared/pty-protocol'
import type { PtyHostEvent, ReplaySnapshot } from './pty-registry'
import { PtyHostServer, type HostServer, type HostSocket } from './server'

const flush = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, 0)
})

class FakeSocket {
  private readonly listeners = new Map<string, (...args: unknown[]) => void>()
  readonly written: string[] = []
  encoding?: string
  destroyed = false

  on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener)
  }

  setEncoding(encoding: 'utf8'): void {
    this.encoding = encoding
  }

  write(data: string): void {
    this.written.push(data)
  }

  destroy(): void {
    this.destroyed = true
  }

  send(text: string): void {
    this.listeners.get('data')?.(text)
  }

  emitError(error: Error): void {
    this.listeners.get('error')?.(error)
  }

  emitClose(): void {
    this.listeners.get('close')?.()
  }

  responses(): PtyResponse[] {
    return this.written.map((line) => JSON.parse(line) as PtyResponse)
  }

  last(): PtyResponse | undefined {
    return this.responses().at(-1)
  }
}

class FakeHostServer {
  private connection?: (socket: HostSocket) => void
  private failure?: (error: NodeJS.ErrnoException) => void
  listenedTo?: string
  closed = false

  constructor(private readonly outcome: 'ok' | NodeJS.ErrnoException) {}

  on(event: 'connection' | 'error', listener: (...args: never[]) => void): void {
    if (event === 'connection') this.connection = listener as unknown as (socket: HostSocket) => void
    else this.failure = listener as unknown as (error: NodeJS.ErrnoException) => void
  }

  listen(endpoint: string, listener: () => void): void {
    this.listenedTo = endpoint
    if (this.outcome === 'ok') listener()
    else this.failure?.(this.outcome)
  }

  close(listener?: (error?: Error) => void): void {
    this.closed = true
    listener?.()
  }

  attach(socket: HostSocket): void {
    this.connection?.(socket)
  }

  fail(error: NodeJS.ErrnoException): void {
    this.failure?.(error)
  }
}

class FakeRegistry {
  readonly spawn = vi.fn<
    (
      sessionId: string,
      kind: SessionKind,
      launchPath: string,
      resume: boolean,
      cols: number,
      rows: number
    ) => Promise<void>
  >(async () => {})
  readonly write = vi.fn<(sessionId: string, data: string) => void>()
  readonly resize = vi.fn<(sessionId: string, cols: number, rows: number) => void>()
  readonly kill = vi.fn<(sessionId: string) => Promise<void>>(async () => {})
  readonly killAll = vi.fn<() => Promise<void>>(async () => {})
  readonly replay = vi.fn<(sessionId: string) => ReplaySnapshot>(() => ({
    data: 'tail',
    cols: 80,
    rows: 24,
    throughSequence: 0
  }))
  readonly list = vi.fn<() => PtySessionSummary[]>(() => [])
  private readonly listeners = new Set<(event: PtyHostEvent) => void>()

  onEvent(listener: (event: PtyHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get subscribers(): number {
    return this.listeners.size
  }

  publish(event: PtyHostEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

const inUse = (): NodeJS.ErrnoException => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })

type HarnessOptions = {
  platform?: NodeJS.Platform
  outcomes?: ('ok' | NodeJS.ErrnoException)[]
  probeLive?: boolean
  endpoint?: string
}

const buildHarness = (options: HarnessOptions = {}) => {
  const registry = new FakeRegistry()
  const logs: string[] = []
  const trace: string[] = []
  const servers: FakeHostServer[] = []
  const outcomes = [...(options.outcomes ?? ['ok' as const])]
  const probeEndpoint = vi.fn(async () => options.probeLive ?? false)
  const removeFile = vi.fn(async () => {
    trace.push('removeFile')
  })
  const exitProcess = vi.fn(() => {
    trace.push('exit')
  })
  registry.killAll.mockImplementation(async () => {
    trace.push('killAll')
  })
  const stateChanges = vi.fn()
  const server = new PtyHostServer({
    endpoint: options.endpoint ?? '\\\\.\\pipe\\codefly-pty-host-test',
    registry,
    appVersion: '0.15.1',
    platform: options.platform ?? 'win32',
    log: (message) => logs.push(message),
    hostPid: 4242,
    createServer: () => {
      const created = new FakeHostServer(outcomes.shift() ?? 'ok')
      servers.push(created)
      return created as unknown as HostServer
    },
    probeEndpoint,
    removeFile,
    onStateChanged: stateChanges,
    exitProcess
  })
  return { server, registry, logs, trace, servers, probeEndpoint, removeFile, exitProcess, stateChanges }
}

const attach = async (harness: ReturnType<typeof buildHarness>): Promise<FakeSocket> => {
  await expect(harness.server.listen()).resolves.toBe('listening')
  const socket = new FakeSocket()
  const listening = harness.servers.at(-1)
  listening?.attach(socket as unknown as HostSocket)
  return socket
}

const request = async (socket: FakeSocket, payload: unknown): Promise<void> => {
  socket.send(`${JSON.stringify(payload)}\n`)
  await flush()
}

describe('PtyHostServer requests', () => {
  it('answers hello with its own protocol version, build, pid and session table', async () => {
    const harness = buildHarness()
    const sessions: PtySessionSummary[] = [
      {
        sessionId: 's1',
        kind: 'claude',
        launchPath: 'C:\\Projects\\App One',
        cols: 120,
        rows: 30,
        startedAt: '2026-09-04T10:00:00.000Z'
      }
    ]
    harness.registry.list.mockReturnValue(sessions)
    const socket = await attach(harness)

    await request(socket, { type: 'hello', id: 1, protocolVersion: PTY_PROTOCOL_VERSION, appVersion: '0.15.1' })

    expect(socket.encoding).toBe('utf8')
    expect(socket.last()).toEqual({
      type: 'welcome',
      id: 1,
      protocolVersion: PTY_PROTOCOL_VERSION,
      hostAppVersion: '0.15.1',
      hostPid: 4242,
      sessions
    })
  })

  it('welcomes a client that speaks another protocol version and leaves the decision to it', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)

    await request(socket, { type: 'hello', id: 7, protocolVersion: 99, appVersion: '0.99.0' })

    expect(socket.last()).toMatchObject({ type: 'welcome', id: 7, protocolVersion: PTY_PROTOCOL_VERSION })
    expect(harness.registry.killAll).not.toHaveBeenCalled()
    expect(harness.logs.some((line) => line.includes('Client speaks protocol 99'))).toBe(true)
  })

  it('forwards spawn, write, resize, kill and replay to the registry', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)
    harness.registry.replay.mockReturnValue({ data: '\u001b[31mred', cols: 132, rows: 43, throughSequence: 7 })

    await request(socket, {
      type: 'spawn',
      id: 1,
      sessionId: 's1',
      kind: 'codex',
      launchPath: 'C:\\Projects\\App One',
      resume: true,
      cols: 96,
      rows: 28
    })
    await request(socket, { type: 'write', id: 2, sessionId: 's1', data: 'hello\r' })
    await request(socket, { type: 'resize', id: 3, sessionId: 's1', cols: 132, rows: 43 })
    await request(socket, { type: 'kill', id: 4, sessionId: 's1' })
    await request(socket, { type: 'replay', id: 5, sessionId: 's1' })

    expect(harness.registry.spawn).toHaveBeenCalledWith('s1', 'codex', 'C:\\Projects\\App One', true, 96, 28)
    expect(harness.registry.write).toHaveBeenCalledWith('s1', 'hello\r')
    expect(harness.registry.resize).toHaveBeenCalledWith('s1', 132, 43)
    expect(harness.registry.kill).toHaveBeenCalledWith('s1')
    expect(socket.responses()).toEqual([
      { type: 'ok', id: 1 },
      { type: 'ok', id: 2 },
      { type: 'ok', id: 3 },
      { type: 'ok', id: 4 },
      { type: 'replayed', id: 5, data: '\u001b[31mred', cols: 132, rows: 43, throughSequence: 7 }
    ])
  })

  it('writes a replay snapshot before live output that follows the replay request', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)
    harness.registry.replay.mockReturnValue({ data: 'history', cols: 80, rows: 24, throughSequence: 4 })

    socket.send(`${JSON.stringify({ type: 'replay', id: 5, sessionId: 's1' })}\n`)
    harness.registry.publish({ type: 'data', sessionId: 's1', data: 'live', sequence: 5 })
    await flush()

    expect(socket.responses()).toEqual([
      { type: 'replayed', id: 5, data: 'history', cols: 80, rows: 24, throughSequence: 4 },
      { type: 'data', sessionId: 's1', data: 'live', sequence: 5 }
    ])
  })

  it('answers exactly one error when the registry refuses a request', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)
    harness.registry.spawn.mockRejectedValue(new Error('claude is not available.'))
    harness.registry.write.mockImplementation(() => {
      throw new Error('Terminal session is not running: gone')
    })

    await request(socket, {
      type: 'spawn',
      id: 1,
      sessionId: 's1',
      kind: 'claude',
      launchPath: 'C:\\Projects',
      resume: false,
      cols: 80,
      rows: 24
    })
    await request(socket, { type: 'write', id: 2, sessionId: 'gone', data: 'x' })

    expect(socket.responses()).toEqual([
      { type: 'error', id: 1, message: 'claude is not available.' },
      { type: 'error', id: 2, message: 'Terminal session is not running: gone' }
    ])
  })

  it('kills every session and exits on retire, answering before it does', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)

    await request(socket, { type: 'retire', id: 9 })

    expect(socket.responses()).toEqual([{ type: 'ok', id: 9 }])
    // The acknowledgement has to be on the wire before the sessions die, because the socket
    // dies with them.
    expect(harness.trace).toEqual(['killAll', 'exit'])
    expect(harness.servers.at(-1)?.closed).toBe(true)
    expect(harness.registry.subscribers).toBe(0)
  })
})

describe('PtyHostServer framing and validation', () => {
  it('handles several requests in one chunk, a request split across chunks, and CRLF framing', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)
    const hello = (id: number): string =>
      JSON.stringify({ type: 'hello', id, protocolVersion: PTY_PROTOCOL_VERSION, appVersion: '0.15.1' })

    socket.send(`${hello(1)}\n${hello(2)}\n`)
    socket.send(`\r\n${hello(3)}`)
    socket.send('\r\n')
    socket.send(hello(4).slice(0, 10))
    socket.send(`${hello(4).slice(10)}\n`)
    await flush()

    expect(socket.responses().map((response) => response.type === 'welcome' && response.id)).toEqual([1, 2, 3, 4])
  })

  it('ignores a line that is not JSON instead of crashing', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)

    socket.send('not json at all\n')
    await flush()

    expect(socket.written).toEqual([])
    expect(harness.logs.some((line) => line.includes('not JSON'))).toBe(true)
  })

  it.each([
    [{ type: 'write', id: 5, sessionId: 's1' }, 'data'],
    [{ type: 'resize', id: 5, sessionId: 's1', cols: 0, rows: 24 }, 'cols'],
    [{ type: 'spawn', id: 5, sessionId: 's1', kind: 'nano', launchPath: 'C:\\x', resume: false, cols: 80, rows: 24 }, 'kind'],
    [{ type: 'kill', id: 5, sessionId: 's1', extra: true }, 'extra'],
    [{ type: 'nonsense', id: 5 }, 'type']
  ])('answers a validation failure with an error naming the field (%#)', async (payload, mentioned) => {
    const harness = buildHarness()
    const socket = await attach(harness)

    await request(socket, payload)

    const response = socket.last()
    expect(response?.type).toBe('error')
    expect(response).toMatchObject({ id: 5 })
    expect(response?.type === 'error' && response.message).toContain(mentioned)
    expect(harness.registry.spawn).not.toHaveBeenCalled()
    expect(harness.registry.write).not.toHaveBeenCalled()
  })

  it('drops an unaddressable request rather than resolving an unrelated call', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)

    await request(socket, { type: 'write', sessionId: 's1', data: 'x' })
    await request(socket, { type: 'write', id: -1, sessionId: 's1', data: 'x' })

    expect(socket.written).toEqual([])
    expect(harness.logs.filter((line) => line.includes('unaddressable'))).toHaveLength(2)
  })

  it('handles a burst of complete requests bigger than the unterminated-line cap', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)
    const data = 'x'.repeat(65_536)
    const burst = Array.from({ length: 20 }, (_, index) =>
      JSON.stringify({ type: 'write', id: index, sessionId: 's1', data })
    ).join('\n')

    socket.send(`${burst}\n`)
    await flush()

    // Well over a megabyte, but every line is terminated: being fast is not a protocol error.
    expect(socket.destroyed).toBe(false)
    expect(harness.registry.write).toHaveBeenCalledTimes(20)
  })

  it('drops a client that never terminates its request', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)

    socket.send('x'.repeat(1024 * 1024 + 1))
    await flush()

    expect(socket.destroyed).toBe(true)
    expect(harness.logs.some((line) => line.includes('unterminated'))).toBe(true)
  })
})

describe('PtyHostServer clients', () => {
  it('broadcasts data and exit to every attached client', async () => {
    const harness = buildHarness()
    const first = await attach(harness)
    const second = new FakeSocket()
    harness.servers.at(-1)?.attach(second as unknown as HostSocket)

    harness.registry.publish({ type: 'data', sessionId: 's1', data: 'out', sequence: 1 })
    harness.registry.publish({ type: 'exit', sessionId: 's1', exitCode: 0 })

    expect(harness.server.clientCount).toBe(2)
    expect(first.responses()).toEqual([
      { type: 'data', sessionId: 's1', data: 'out', sequence: 1 },
      { type: 'exit', sessionId: 's1', exitCode: 0 }
    ])
    expect(second.responses()).toEqual(first.responses())
  })

  it('treats a disconnect as a detach and never kills a session', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)
    harness.registry.list.mockReturnValue([
      {
        sessionId: 's1',
        kind: 'claude',
        launchPath: 'C:\\Projects',
        cols: 80,
        rows: 24,
        startedAt: '2026-09-04T10:00:00.000Z'
      }
    ])

    socket.emitError(new Error('ECONNRESET'))
    socket.emitClose()
    harness.registry.publish({ type: 'data', sessionId: 's1', data: 'still running', sequence: 1 })

    expect(harness.server.clientCount).toBe(0)
    expect(harness.registry.kill).not.toHaveBeenCalled()
    expect(harness.registry.killAll).not.toHaveBeenCalled()
    expect(socket.destroyed).toBe(false)
    expect(socket.written).toEqual([])
    expect(harness.logs.some((line) => line.includes('sessions keep running'))).toBe(true)
  })

  it('reports every population change so the idle watchdog can re-evaluate', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)
    expect(harness.stateChanges).toHaveBeenCalledTimes(1)

    await request(socket, { type: 'hello', id: 1, protocolVersion: PTY_PROTOCOL_VERSION, appVersion: '0.15.1' })
    expect(harness.stateChanges).toHaveBeenCalledTimes(2)

    socket.emitClose()
    expect(harness.stateChanges).toHaveBeenCalledTimes(3)
  })

  it('drops its clients and its registry subscription when closed, without killing anything', async () => {
    const harness = buildHarness()
    const socket = await attach(harness)

    await harness.server.close()
    harness.registry.publish({ type: 'data', sessionId: 's1', data: 'ignored', sequence: 1 })

    expect(socket.destroyed).toBe(true)
    expect(harness.server.clientCount).toBe(0)
    expect(harness.registry.subscribers).toBe(0)
    expect(harness.registry.killAll).not.toHaveBeenCalled()
    expect(socket.written).toEqual([])
    await expect(harness.server.close()).resolves.toBeUndefined()
  })

  it('survives a client whose socket rejects a write', async () => {
    const harness = buildHarness()
    const healthy = await attach(harness)
    const broken = new FakeSocket()
    vi.spyOn(broken, 'write').mockImplementation(() => {
      throw new Error('EPIPE')
    })
    harness.servers.at(-1)?.attach(broken as unknown as HostSocket)

    expect(() => harness.registry.publish({ type: 'data', sessionId: 's1', data: 'out', sequence: 1 })).not.toThrow()
    expect(healthy.responses()).toEqual([{ type: 'data', sessionId: 's1', data: 'out', sequence: 1 }])
    expect(harness.logs.some((line) => line.includes('EPIPE'))).toBe(true)
  })
})

describe('PtyHostServer single instance', () => {
  it('listens on the endpoint it was given', async () => {
    const harness = buildHarness({ endpoint: '\\\\.\\pipe\\codefly-pty-host-abc' })

    await expect(harness.server.listen()).resolves.toBe('listening')

    expect(harness.servers.at(-1)?.listenedTo).toBe('\\\\.\\pipe\\codefly-pty-host-abc')
    expect(harness.logs.some((line) => line.includes('Listening on'))).toBe(true)
  })

  it('yields to the host that already owns a Windows pipe without probing it', async () => {
    const harness = buildHarness({ platform: 'win32', outcomes: [inUse()] })

    await expect(harness.server.listen()).resolves.toBe('occupied')

    // A named pipe exists only while its server does, so there is nothing to clean up and
    // nothing to probe.
    expect(harness.probeEndpoint).not.toHaveBeenCalled()
    expect(harness.removeFile).not.toHaveBeenCalled()
    expect(harness.logs.some((line) => line.includes('already owns'))).toBe(true)
  })

  it('yields to a macOS host that answers on the socket', async () => {
    const harness = buildHarness({
      platform: 'darwin',
      outcomes: [inUse()],
      probeLive: true,
      endpoint: '/tmp/codefly-pty-host-abc.sock'
    })

    await expect(harness.server.listen()).resolves.toBe('occupied')

    expect(harness.probeEndpoint).toHaveBeenCalledWith('/tmp/codefly-pty-host-abc.sock')
    expect(harness.removeFile).not.toHaveBeenCalled()
  })

  it('removes a stale macOS socket file and claims the endpoint', async () => {
    const harness = buildHarness({
      platform: 'darwin',
      outcomes: [inUse(), 'ok'],
      probeLive: false,
      endpoint: '/tmp/codefly-pty-host-abc.sock'
    })

    await expect(harness.server.listen()).resolves.toBe('listening')

    expect(harness.removeFile).toHaveBeenCalledWith('/tmp/codefly-pty-host-abc.sock')
    expect(harness.servers).toHaveLength(2)
    expect(harness.servers.at(-1)?.listenedTo).toBe('/tmp/codefly-pty-host-abc.sock')
    expect(harness.logs.some((line) => line.includes('stale socket'))).toBe(true)
  })

  it('gives up when another host claims the socket during the cleanup', async () => {
    const harness = buildHarness({
      platform: 'darwin',
      outcomes: [inUse(), inUse()],
      probeLive: false,
      endpoint: '/tmp/codefly-pty-host-abc.sock'
    })

    await expect(harness.server.listen()).resolves.toBe('occupied')

    expect(harness.removeFile).toHaveBeenCalledOnce()
    expect(harness.logs.some((line) => line.includes('Could not claim'))).toBe(true)
  })

  it('propagates a failure that is not a busy endpoint', async () => {
    const denied = Object.assign(new Error('listen EACCES'), { code: 'EACCES' })
    const harness = buildHarness({ platform: 'darwin', outcomes: [denied] })

    await expect(harness.server.listen()).rejects.toThrow('listen EACCES')
    expect(harness.removeFile).not.toHaveBeenCalled()
  })

  it('logs a runtime endpoint failure instead of letting it reach the default handler', async () => {
    const harness = buildHarness()
    await expect(harness.server.listen()).resolves.toBe('listening')

    expect(() => harness.servers.at(-1)?.fail(new Error('pipe broke'))).not.toThrow()
    expect(harness.logs.some((line) => line.includes('Endpoint error: pipe broke'))).toBe(true)
  })
})
