import { describe, expect, it } from 'vitest'

import {
  ptyHostEndpoint,
  PTY_HOST_ENV,
  PTY_PROTOCOL_VERSION,
  type PtyRequest,
  type PtyResponse
} from '../../shared/pty-protocol'
import {
  decodeResponses,
  FIRST_CLIENT_REQUEST_ID,
  PtyHostLauncher,
  type HostSpawnOptions,
  type HostSpawner,
  type PtyHostConnect,
  type PtyHostLogger,
  type PtyHostSocket,
  type PtyHostSocketEvents,
  type ResolveHostLaunchSpec,
  type Sleep
} from './pty-host-launcher'

const USER_DATA = 'C:\\Users\\tester\\AppData\\Roaming\\CodeFly'
const APP_VERSION = '0.16.0'
const PLATFORM: NodeJS.Platform = 'win32'
const ENDPOINT = ptyHostEndpoint(USER_DATA, PLATFORM)
const ENVIRONMENT: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\tester' }
const LAUNCH_SPEC = {
  runtime: `${USER_DATA}\\pty-host\\0.16.0\\codefly-pty-host.exe`,
  script: `${USER_DATA}\\pty-host\\0.16.0\\pty-host.mjs`,
  logPath: `${USER_DATA}\\logs\\pty-host.log`
}

/** A deadline that never expires: the default, so a test only times out when it means to. */
const neverExpires: Sleep = () => new Promise<void>(() => undefined)
/** A deadline that expires as soon as it is checked. */
const expiresAtOnce: Sleep = async () => undefined

const notListening = (): Error => Object.assign(new Error('connect ENOENT \\\\.\\pipe\\codefly-pty-host'), { code: 'ENOENT' })

const welcomeLine = (overrides: Partial<Extract<PtyResponse, { type: 'welcome' }>> = {}): string =>
  `${JSON.stringify({
    type: 'welcome',
    id: 0,
    protocolVersion: PTY_PROTOCOL_VERSION,
    hostAppVersion: APP_VERSION,
    hostPid: 4242,
    sessions: [],
    ...overrides
  })}\n`

const dataLine = (sessionId: string, data: string, sequence = 1): string =>
  `${JSON.stringify({ type: 'data', sessionId, data, sequence })}\n`

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

/**
 * In-memory stand-in for a connected socket. `answer` runs synchronously inside `write` with
 * the parsed request, which is enough to script every handshake case — the launcher binds its
 * listeners before it writes — and keeps the tests free of tick-chasing: a fragmented reply is
 * just several `emitData` calls in a row.
 */
class FakeSocket implements PtyHostSocket {
  readonly written: string[] = []
  ends = 0
  destroys = 0
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

  emitData(chunk: string): void {
    for (const listener of [...this.dataListeners]) listener(chunk)
  }

  emitClose(): void {
    for (const listener of [...this.closeListeners]) listener()
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error)
  }

  listenerCount(event: keyof PtyHostSocketEvents): number {
    return this.listenersFor(event).size
  }

  get requests(): PtyRequest[] {
    return this.written.map((line) => JSON.parse(line.trim()) as PtyRequest)
  }

  private listenersFor(event: keyof PtyHostSocketEvents): Set<unknown> {
    if (event === 'data') return this.dataListeners as Set<unknown>
    if (event === 'close') return this.closeListeners as Set<unknown>
    return this.errorListeners as Set<unknown>
  }
}

/** Hands out scripted connect outcomes; anything past the script behaves as "nothing listening". */
class FakeConnector {
  readonly endpoints: string[] = []
  private readonly outcomes: Array<FakeSocket | Error>

  constructor(outcomes: Array<FakeSocket | Error>) {
    this.outcomes = [...outcomes]
  }

  readonly connect: PtyHostConnect = async (endpoint) => {
    this.endpoints.push(endpoint)
    const next = this.outcomes.shift()
    if (next === undefined || next instanceof Error) throw next ?? notListening()
    return next
  }

  get calls(): number {
    return this.endpoints.length
  }
}

class FakeSpawner {
  readonly calls: Array<{ runtime: string; args: readonly string[]; options: HostSpawnOptions }> = []
  unrefs = 0
  /** Emitted to the child's 'error' listener on a later tick, the way spawn really reports it. */
  lateError?: Error
  throwOnSpawn?: Error

  readonly spawn: HostSpawner = (runtime, args, options) => {
    this.calls.push({ runtime, args, options })
    if (this.throwOnSpawn) throw this.throwOnSpawn
    const listeners = new Set<(error: Error) => void>()
    const lateError = this.lateError
    if (lateError) {
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(lateError)
      })
    }
    return {
      unref: () => {
        this.unrefs += 1
      },
      on: (_event, listener) => {
        listeners.add(listener)
      }
    }
  }
}

type Harness = {
  launcher: PtyHostLauncher
  connector: FakeConnector
  spawner: FakeSpawner
  delays: number[]
  logger: RecordingLogger
}

const buildHarness = (
  options: { sockets?: Array<FakeSocket | Error>; deadline?: Sleep; launchSpec?: ResolveHostLaunchSpec } = {}
): Harness => {
  const connector = new FakeConnector(options.sockets ?? [])
  const spawner = new FakeSpawner()
  const delays: number[] = []
  const logger = new RecordingLogger()
  const launcher = new PtyHostLauncher(
    USER_DATA,
    APP_VERSION,
    options.launchSpec ?? (() => LAUNCH_SPEC),
    connector.connect,
    spawner.spawn,
    PLATFORM,
    ENVIRONMENT,
    async (ms) => {
      delays.push(ms)
    },
    options.deadline ?? neverExpires,
    logger
  )
  return { launcher, connector, spawner, delays, logger }
}

const socketAnswering = (chunks: readonly string[]): FakeSocket => {
  const socket = new FakeSocket()
  socket.answer = (target) => {
    for (const chunk of chunks) target.emitData(chunk)
  }
  return socket
}

describe('decodeResponses', () => {
  it('decodes every complete line in one chunk and keeps the partial tail', () => {
    const text = `${dataLine('one', 'a')}${JSON.stringify({ type: 'ok', id: 7 })}\n{"type":"da`

    const decoded = decodeResponses(text, () => undefined)

    expect(decoded.responses).toEqual([
      { type: 'data', sessionId: 'one', data: 'a', sequence: 1 },
      { type: 'ok', id: 7 }
    ])
    expect(decoded.rest).toBe('{"type":"da')
  })

  it('reassembles a response split across chunks', () => {
    const line = dataLine('one', 'hello')
    const first = decodeResponses(line.slice(0, 12), () => undefined)
    expect(first.responses).toEqual([])

    const second = decodeResponses(first.rest + line.slice(12), () => undefined)

    expect(second.responses).toEqual([{ type: 'data', sessionId: 'one', data: 'hello', sequence: 1 }])
    expect(second.rest).toBe('')
  })

  it('reports and drops a line that is not JSON, then keeps decoding', () => {
    const malformed: string[] = []

    const decoded = decodeResponses(`not json at all\n${dataLine('one', 'a')}`, (line) => {
      malformed.push(line)
    })

    expect(malformed).toEqual(['not json at all'])
    expect(decoded.responses).toEqual([{ type: 'data', sessionId: 'one', data: 'a', sequence: 1 }])
  })

  it('reports and drops JSON the protocol does not describe', () => {
    const malformed: string[] = []
    const text = `${JSON.stringify({ type: 'data', sessionId: 'one' })}\n${JSON.stringify({ type: 'nope', id: 1 })}\n${JSON.stringify({ type: 'ok', id: 1, extra: true })}\n`

    const decoded = decodeResponses(text, (line) => {
      malformed.push(line)
    })

    // Missing field, unknown discriminant, and an unknown key on a strictObject.
    expect(malformed).toHaveLength(3)
    expect(decoded.responses).toEqual([])
  })

  it('ignores blank lines and a carriage return before the newline', () => {
    const decoded = decodeResponses(`\n${JSON.stringify({ type: 'ok', id: 3 })}\r\n`, () => undefined)

    expect(decoded.responses).toEqual([{ type: 'ok', id: 3 }])
    expect(decoded.rest).toBe('')
  })
})

describe('PtyHostLauncher', () => {
  it('derives the endpoint from the userData directory and the platform', () => {
    const harness = buildHarness()

    expect(harness.launcher.endpoint).toBe(ENDPOINT)
    expect(harness.launcher.endpoint).toContain('\\\\.\\pipe\\codefly-pty-host-')
  })

  it('attaches to a host that is already listening without spawning one', async () => {
    const socket = socketAnswering([welcomeLine({ sessions: [] })])
    const harness = buildHarness({ sockets: [socket] })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('attached')
    if (result.status !== 'attached') return
    expect(result.welcome.hostPid).toBe(4242)
    expect(result.residue).toBe('')
    expect(harness.spawner.calls).toHaveLength(0)
    expect(harness.delays).toEqual([])
    expect(harness.connector.endpoints).toEqual([ENDPOINT])
    expect(socket.requests).toEqual([
      { type: 'hello', id: 0, protocolVersion: PTY_PROTOCOL_VERSION, appVersion: APP_VERSION }
    ])
  })

  it('leaves the handed-over socket with no handshake listeners of its own', async () => {
    const socket = socketAnswering([welcomeLine()])
    const harness = buildHarness({ sockets: [socket] })

    await harness.launcher.attach()

    expect(socket.listenerCount('data')).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
    expect(socket.destroys).toBe(0)
  })

  it('reserves request ids 0 and 1 for the handshake so the client cannot collide', () => {
    expect(FIRST_CLIENT_REQUEST_ID).toBeGreaterThan(1)
  })

  it('spawns a host when nothing is listening and retries with backoff', async () => {
    const socket = socketAnswering([welcomeLine()])
    const harness = buildHarness({ sockets: [notListening(), notListening(), socket] })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('attached')
    expect(harness.connector.calls).toBe(3)
    expect(harness.delays).toEqual([50, 100])
    expect(harness.spawner.calls).toHaveLength(1)
    expect(harness.spawner.unrefs).toBe(1)
  })

  it('spawns the injected runtime and script with ELECTRON_RUN_AS_NODE and the host environment', async () => {
    const socket = socketAnswering([welcomeLine()])
    const harness = buildHarness({ sockets: [notListening(), socket] })

    await harness.launcher.attach()

    const call = harness.spawner.calls[0]
    expect(call?.runtime).toBe(LAUNCH_SPEC.runtime)
    expect(call?.args).toEqual([LAUNCH_SPEC.script])
    expect(call?.options).toEqual({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...ENVIRONMENT,
        ELECTRON_RUN_AS_NODE: '1',
        [PTY_HOST_ENV.endpoint]: ENDPOINT,
        [PTY_HOST_ENV.appVersion]: APP_VERSION,
        [PTY_HOST_ENV.logFile]: LAUNCH_SPEC.logPath
      }
    })
  })

  it('reports the host as unavailable when it never accepts a connection', async () => {
    const harness = buildHarness()

    const result = await harness.launcher.attach()

    expect(result).toEqual({ status: 'unavailable', message: expect.stringContaining(ENDPOINT) })
    expect(harness.spawner.calls).toHaveLength(1)
    // The whole backoff schedule was walked once, and it adds up to roughly ten seconds.
    expect(harness.delays).toHaveLength(13)
    expect(harness.delays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(9_000)
    expect(harness.delays[0]).toBe(50)
  })

  it('stops retrying as soon as the spawned process reports an error', async () => {
    const harness = buildHarness()
    harness.spawner.lateError = new Error('EACCES: permission denied')

    const result = await harness.launcher.attach()

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.message).toContain('EACCES')
    // One backoff, not thirteen: the process is known to be dead, so waiting is pointless.
    expect(harness.delays).toEqual([50])
    expect(harness.logger.joined).toContain('reported an error')
  })

  it('folds a synchronous spawn failure into a result', async () => {
    const harness = buildHarness()
    harness.spawner.throwOnSpawn = new Error('spawn EINVAL')

    const result = await harness.launcher.attach()

    expect(result).toEqual({ status: 'unavailable', message: expect.stringContaining('spawn EINVAL') })
    expect(harness.delays).toEqual([])
  })

  it('folds a failure to resolve the host location into a result', async () => {
    const harness = buildHarness({
      launchSpec: () => {
        throw new Error('app path is unknown')
      }
    })

    const result = await harness.launcher.attach()

    expect(result).toEqual({ status: 'unavailable', message: expect.stringContaining('app path is unknown') })
    expect(harness.spawner.calls).toHaveLength(0)
  })

  it('waits for a launch location that has to be prepared first', async () => {
    const socket = socketAnswering([welcomeLine()])
    const harness = buildHarness({
      sockets: [notListening(), socket],
      // Packaged Windows stages the runtime outside the install directory before it can spawn.
      launchSpec: async () => LAUNCH_SPEC
    })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('attached')
    expect(harness.spawner.calls[0]?.args).toEqual([LAUNCH_SPEC.script])
  })

  it('folds a rejected launch location into a result', async () => {
    const harness = buildHarness({
      launchSpec: () => Promise.reject(new Error('could not stage the host runtime'))
    })

    const result = await harness.launcher.attach()

    expect(result).toEqual({ status: 'unavailable', message: expect.stringContaining('could not stage the host runtime') })
    expect(harness.spawner.calls).toHaveLength(0)
  })

  it('gives up on a host that accepts the connection but never answers the handshake', async () => {
    const socket = new FakeSocket()
    const harness = buildHarness({ sockets: [socket], deadline: expiresAtOnce })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.message).toContain('did not answer the handshake')
    expect(socket.destroys).toBe(1)
  })

  it('gives up when the host closes the connection during the handshake', async () => {
    const socket = new FakeSocket()
    socket.answer = (target) => {
      target.emitClose()
    }
    const harness = buildHarness({ sockets: [socket] })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.message).toContain('closed the connection during the handshake')
  })

  it('survives an unreadable line before the welcome', async () => {
    const socket = socketAnswering(['{ not json }\n', welcomeLine()])
    const harness = buildHarness({ sockets: [socket] })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('attached')
    expect(harness.logger.joined).toContain('unreadable pty-host message')
  })

  it('completes a handshake whose welcome arrives in fragments', async () => {
    const welcome = welcomeLine({ hostPid: 99 })
    const socket = socketAnswering([welcome.slice(0, 10), welcome.slice(10, 30), welcome.slice(30)])
    const harness = buildHarness({ sockets: [socket] })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('attached')
    if (result.status !== 'attached') return
    expect(result.welcome.hostPid).toBe(99)
    expect(result.residue).toBe('')
  })

  it('hands back every frame that shared the handshake read, in arrival order', async () => {
    const before = dataLine('one', 'before')
    const after = dataLine('two', 'after')
    const partial = '{"type":"exit","sessionId":"th'
    const socket = socketAnswering([`${before}${welcomeLine()}${after}${partial}`])
    const harness = buildHarness({ sockets: [socket] })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('attached')
    if (result.status !== 'attached') return
    expect(result.residue).toBe(`${before}${after}${partial}`)
  })

  it('retires an incompatible host, starts its own, and attaches to that one', async () => {
    const stale = new FakeSocket()
    stale.answer = (target, request) => {
      if (request.type === 'hello') target.emitData(welcomeLine({ protocolVersion: PTY_PROTOCOL_VERSION + 1 }))
      if (request.type === 'retire') target.emitClose()
    }
    const fresh = socketAnswering([welcomeLine({ hostAppVersion: APP_VERSION })])
    const harness = buildHarness({ sockets: [stale, fresh] })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('attached')
    if (result.status !== 'attached') return
    expect(result.socket).toBe(fresh)
    expect(stale.requests.map((request) => request.type)).toEqual(['hello', 'retire'])
    expect(stale.requests[1]).toEqual({ type: 'retire', id: 1 })
    expect(stale.destroys).toBe(1)
    // The second round spawns before it connects, so the fresh host is this build's own.
    expect(harness.spawner.calls).toHaveLength(1)
    expect(harness.connector.calls).toBe(2)
    expect(harness.delays).toEqual([50])
    expect(harness.logger.joined).toContain('retiring a pty-host')
  })

  it('stops waiting for a retired host that will not close the connection', async () => {
    const stale = new FakeSocket()
    stale.answer = (target, request) => {
      if (request.type === 'hello') target.emitData(welcomeLine({ protocolVersion: 99 }))
    }
    const fresh = socketAnswering([welcomeLine()])
    const harness = buildHarness({ sockets: [stale, fresh], deadline: expiresAtOnce })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('attached')
    expect(stale.destroys).toBe(1)
    expect(harness.spawner.calls).toHaveLength(1)
  })

  it('retries exactly once, then reports the incompatibility instead of retiring again', async () => {
    const answerIncompatible = (target: FakeSocket, request: PtyRequest): void => {
      if (request.type === 'hello') target.emitData(welcomeLine({ protocolVersion: 7 }))
      if (request.type === 'retire') target.emitClose()
    }
    const first = new FakeSocket()
    first.answer = answerIncompatible
    const second = new FakeSocket()
    second.answer = answerIncompatible
    const harness = buildHarness({ sockets: [first, second] })

    const result = await harness.launcher.attach()

    expect(result.status).toBe('incompatible')
    if (result.status !== 'incompatible') return
    expect(result.hostProtocolVersion).toBe(7)
    expect(result.message).toContain(String(PTY_PROTOCOL_VERSION))
    // Only the first host is retired: two builds retiring each other in turn would kill PTYs forever.
    expect(first.requests.map((request) => request.type)).toEqual(['hello', 'retire'])
    expect(second.requests.map((request) => request.type)).toEqual(['hello'])
    expect(second.destroys).toBe(1)
    expect(harness.spawner.calls).toHaveLength(1)
  })

  it('never rejects, whatever the socket does', async () => {
    const socket = new FakeSocket()
    socket.answer = (target) => {
      target.emitError(new Error('EPIPE'))
    }
    const harness = buildHarness({ sockets: [socket] })

    await expect(harness.launcher.attach()).resolves.toEqual({
      status: 'unavailable',
      message: expect.stringContaining('EPIPE')
    })
  })
})
