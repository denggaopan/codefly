import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionKind } from '../shared/contracts'
import { REPLAY_BUFFER_CHARS } from '../shared/pty-protocol'
import type { LaunchSpec } from './launch-spec'
import {
  PtyRegistry,
  type IPtyFactory,
  type ManagedPty,
  type PtyHostEvent,
  type PtySpawnOptions
} from './pty-registry'

type Listener<T> = (event: T) => void

class FakePty implements ManagedPty {
  private readonly dataListeners = new Set<Listener<string>>()
  private readonly exitListeners = new Set<Listener<{ exitCode: number }>>()
  readonly write = vi.fn<(data: string) => void>()
  readonly resize = vi.fn<(cols: number, rows: number) => void>()
  readonly kill = vi.fn<() => void>()
  dataDisposals = 0
  exitDisposals = 0

  onData(listener: Listener<string>): { dispose(): void } {
    this.dataListeners.add(listener)
    return {
      dispose: () => {
        if (this.dataListeners.delete(listener)) this.dataDisposals += 1
      }
    }
  }

  onExit(listener: Listener<{ exitCode: number }>): { dispose(): void } {
    this.exitListeners.add(listener)
    return {
      dispose: () => {
        if (this.exitListeners.delete(listener)) this.exitDisposals += 1
      }
    }
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data)
  }

  emitExit(exitCode: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode })
  }
}

class FakePtyFactory implements IPtyFactory {
  readonly created: FakePty[] = []
  readonly spawn = vi.fn<(file: string, args: readonly string[] | string, options: PtySpawnOptions) => ManagedPty>()

  constructor() {
    this.spawn.mockImplementation(() => {
      const pty = new FakePty()
      this.created.push(pty)
      return pty
    })
  }
}

type HarnessOptions = {
  launch?: LaunchSpec | ((kind: SessionKind, resume: boolean) => Promise<LaunchSpec>)
  environment?: NodeJS.ProcessEnv
  startedAt?: string
  killTimeoutMs?: number
}

const buildHarness = (options: HarnessOptions = {}) => {
  const factory = new FakePtyFactory()
  const events: PtyHostEvent[] = []
  const logs: string[] = []
  const fallback: LaunchSpec = { file: 'C:\\npm\\claude.exe', args: ['--dangerously-skip-permissions'] }
  const launch = options.launch ?? fallback
  const resolveLaunchSpec = vi.fn(
    typeof launch === 'function' ? launch : async (_kind: SessionKind, _resume: boolean) => launch
  )
  const registry = new PtyRegistry(
    { resolveLaunchSpec },
    factory,
    options.environment ?? { PATH: 'C:\\Windows', KEEP_ME: 'yes' },
    (message) => logs.push(message),
    () => new Date(options.startedAt ?? '2026-09-04T10:00:00.000Z'),
    options.killTimeoutMs ?? 2_000
  )
  registry.onEvent((event) => events.push(event))
  return { registry, factory, events, logs, resolveLaunchSpec }
}

const pty = (factory: FakePtyFactory, index = 0): FakePty => {
  const created = factory.created[index]
  if (!created) throw new Error(`No PTY was created at index ${index}.`)
  return created
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PtyRegistry spawning', () => {
  it('spawns with the resolved launch spec, the requested geometry and the merged environment', async () => {
    const harness = buildHarness({
      launch: { file: 'C:\\npm\\comatecli.exe', args: [], env: { ZULU_TERMINAL_RUN_MODE: 'yolo' } },
      environment: { PATH: 'C:\\Windows', TERM: 'stale' }
    })

    await harness.registry.spawn('s1', 'comate', 'C:\\Projects\\App One', true, 96, 28)

    expect(harness.resolveLaunchSpec).toHaveBeenCalledWith('comate', true)
    expect(harness.factory.spawn).toHaveBeenCalledWith('C:\\npm\\comatecli.exe', [], {
      name: 'xterm-256color',
      cols: 96,
      rows: 28,
      cwd: 'C:\\Projects\\App One',
      env: { PATH: 'C:\\Windows', TERM: 'xterm-256color', ZULU_TERMINAL_RUN_MODE: 'yolo' }
    })
    expect(harness.registry.sessionCount).toBe(1)
  })

  it('passes a hosted shim command line through unchanged', async () => {
    const harness = buildHarness({
      launch: { file: 'C:\\Windows\\cmd.exe', args: '/d /s /c ""C:\\npm\\claude.cmd" --flag"', env: {} }
    })

    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 120, 30)

    expect(harness.factory.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\cmd.exe',
      '/d /s /c ""C:\\npm\\claude.cmd" --flag"',
      expect.objectContaining({ cols: 120, rows: 30 })
    )
  })

  it('rejects a duplicate session id, before and during resolution', async () => {
    let release!: (spec: LaunchSpec) => void
    const pending = new Promise<LaunchSpec>((resolve) => {
      release = resolve
    })
    const harness = buildHarness({ launch: () => pending })

    const first = harness.registry.spawn('same', 'claude', 'C:\\Projects', false, 80, 24)
    await expect(harness.registry.spawn('same', 'claude', 'C:\\Projects', false, 80, 24)).rejects.toThrow(
      /already running or starting/i
    )
    release({ file: 'C:\\npm\\claude.exe', args: [] })
    await first

    await expect(harness.registry.spawn('same', 'claude', 'C:\\Projects', false, 80, 24)).rejects.toThrow(
      /already running or starting/i
    )
    expect(harness.factory.spawn).toHaveBeenCalledOnce()
  })

  it('leaves no reservation behind when the launch spec cannot be resolved', async () => {
    const harness = buildHarness({
      launch: async () => {
        throw new Error('claude is not available.')
      }
    })

    await expect(harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)).rejects.toThrow(
      'claude is not available.'
    )
    expect(harness.registry.sessionCount).toBe(0)
    // The reservation is released, so a retry after installing the CLI is not blocked.
    await expect(harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)).rejects.toThrow(
      'claude is not available.'
    )
  })

  it.each([
    [0, 24],
    [80, 0],
    [1.5, 24],
    [80, Number.NaN],
    [1001, 24],
    [80, 1001]
  ])('refuses to spawn with %s x %s', async (cols, rows) => {
    const harness = buildHarness()

    await expect(harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, cols, rows)).rejects.toThrow(
      /dimensions/i
    )
    expect(harness.factory.spawn).not.toHaveBeenCalled()
  })
})

describe('PtyRegistry events and session table', () => {
  it('publishes data per session and removes an exited session before publishing its exit', async () => {
    const harness = buildHarness()
    await harness.registry.spawn('one', 'claude', 'C:\\Projects', false, 80, 24)
    await harness.registry.spawn('two', 'codex', 'C:\\Projects', false, 80, 24)
    const seenAtExit: number[] = []
    harness.registry.onEvent((event) => {
      if (event.type === 'exit') seenAtExit.push(harness.registry.sessionCount)
    })

    pty(harness.factory, 1).emitData('from two')
    pty(harness.factory, 0).emitData('from one')
    pty(harness.factory, 0).emitExit(17)

    expect(harness.events).toEqual([
      { type: 'data', sessionId: 'two', data: 'from two', sequence: 1 },
      { type: 'data', sessionId: 'one', data: 'from one', sequence: 1 },
      { type: 'exit', sessionId: 'one', exitCode: 17 }
    ])
    expect(seenAtExit).toEqual([1])
    expect(pty(harness.factory, 0).dataDisposals).toBe(1)
    expect(pty(harness.factory, 0).exitDisposals).toBe(1)
  })

  it('isolates a failing subscriber and supports unsubscribing', async () => {
    const harness = buildHarness()
    const retained = vi.fn()
    const removed = vi.fn()
    harness.registry.onEvent(() => {
      throw new Error('client transport failed')
    })
    harness.registry.onEvent(retained)
    const unsubscribe = harness.registry.onEvent(removed)
    unsubscribe()
    unsubscribe()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)

    expect(() => pty(harness.factory).emitData('safe')).not.toThrow()
    expect(retained).toHaveBeenCalledWith({ type: 'data', sessionId: 's1', data: 'safe', sequence: 1 })
    expect(removed).not.toHaveBeenCalled()
    expect(harness.logs.some((line) => line.includes('client transport failed'))).toBe(true)
  })

  it('lists live sessions with their kind, directory, geometry and start time', async () => {
    const harness = buildHarness({ startedAt: '2026-09-04T10:11:12.000Z' })
    await harness.registry.spawn('s1', 'codex', 'C:\\Projects\\App One', false, 100, 40)
    await harness.registry.spawn('s2', 'powershell', 'C:\\Projects\\App Two', false, 80, 24)

    harness.registry.resize('s1', 132, 43)
    pty(harness.factory, 1).emitExit(0)

    expect(harness.registry.list()).toEqual([
      {
        sessionId: 's1',
        kind: 'codex',
        launchPath: 'C:\\Projects\\App One',
        cols: 132,
        rows: 43,
        startedAt: '2026-09-04T10:11:12.000Z'
      }
    ])
  })

  it('rejects writes and resizes for sessions it does not hold', async () => {
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)

    harness.registry.write('s1', 'hello\r')

    expect(pty(harness.factory).write).toHaveBeenCalledWith('hello\r')
    expect(() => harness.registry.write('missing', 'x')).toThrow(/not running/i)
    expect(() => harness.registry.resize('missing', 80, 24)).toThrow(/not running/i)
    expect(() => harness.registry.replay('missing')).toThrow(/not running/i)
    expect(() => harness.registry.resize('s1', 0, 24)).toThrow(/dimensions/i)
    expect(pty(harness.factory).resize).not.toHaveBeenCalled()
  })
})

describe('PtyRegistry replay buffer', () => {
  it('replays everything a short-lived session produced, with its current geometry', async () => {
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)

    pty(harness.factory).emitData('\u001b[31mred\r\n')
    pty(harness.factory).emitData('plain')
    harness.registry.resize('s1', 120, 30)

    expect(harness.registry.replay('s1')).toEqual({
      data: '\u001b[31mred\r\nplain',
      cols: 120,
      rows: 30,
      throughSequence: 2
    })
  })

  it('keeps only the newest output once the session has produced more than the buffer holds', async () => {
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)

    pty(harness.factory).emitData('old'.repeat(1_000))
    pty(harness.factory).emitData('z'.repeat(REPLAY_BUFFER_CHARS + 100))

    // No newline anywhere, so the whole retained tail is kept as-is.
    const { data } = harness.registry.replay('s1')
    expect(data).toBe('z'.repeat(REPLAY_BUFFER_CHARS))
  })

  it('restarts the retained tail after a newline so no half escape sequence is replayed', async () => {
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)

    // Sized so the cut lands five characters into an eleven character SGR sequence: a blind
    // slice would hand the client ";5;208m" and xterm would eat the text that follows it.
    const straddling = '\u001b[38;5;208m'
    const line = 'visible\n'
    const survivor = 'r'.repeat(REPLAY_BUFFER_CHARS - straddling.length - line.length + 5)
    pty(harness.factory).emitData(straddling + line + survivor)

    const { data } = harness.registry.replay('s1')
    expect(data).toBe(survivor)
    expect(data).not.toContain('\u001b')
    expect(data.startsWith(';5;208m')).toBe(false)
    expect(data.length).toBeLessThanOrEqual(REPLAY_BUFFER_CHARS)
  })

  it('trims across chunk boundaries rather than per chunk', async () => {
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)

    for (let index = 0; index < 4; index += 1) pty(harness.factory).emitData(`${index}\n${'x'.repeat(100_000)}`)

    const { data } = harness.registry.replay('s1')
    expect(data.length).toBeLessThanOrEqual(REPLAY_BUFFER_CHARS)
    expect(data.endsWith('x'.repeat(100_000))).toBe(true)
    // The oldest markers fell out of the window; the newest survived.
    expect(data).not.toContain('0\n')
    expect(data).toContain('3\n')
  })

  it('stops buffering output from a session that is gone', async () => {
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)
    pty(harness.factory).emitExit(0)

    expect(() => pty(harness.factory).emitData('after exit')).not.toThrow()
    expect(harness.events).toEqual([{ type: 'exit', sessionId: 's1', exitCode: 0 }])
  })
})

describe('PtyRegistry kill', () => {
  it('signals first and resolves as soon as the PTY exits, without forcing anything', async () => {
    vi.useFakeTimers()
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)

    const pending = harness.registry.kill('s1')
    expect(pty(harness.factory).kill).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(harness.registry.sessionCount).toBe(1)
    pty(harness.factory).emitExit(0)

    await expect(pending).resolves.toBeUndefined()
    expect(harness.registry.sessionCount).toBe(0)
    expect(harness.events).toEqual([{ type: 'exit', sessionId: 's1', exitCode: 0 }])
    expect(vi.getTimerCount()).toBe(0)
    expect(pty(harness.factory).kill).toHaveBeenCalledOnce()
  })

  it('drops a session that ignores its kill and stays idempotent afterwards', async () => {
    vi.useFakeTimers()
    const harness = buildHarness()
    await harness.registry.spawn('stubborn', 'claude', 'C:\\Projects', false, 80, 24)

    const first = harness.registry.kill('stubborn')
    const second = harness.registry.kill('stubborn')
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(pty(harness.factory).kill).toHaveBeenCalledOnce()
    expect(harness.registry.sessionCount).toBe(0)
    expect(harness.registry.list()).toEqual([])
    expect(harness.logs.some((line) => line.includes('ignored its kill'))).toBe(true)
    await expect(harness.registry.kill('stubborn')).resolves.toBeUndefined()
    expect(pty(harness.factory).kill).toHaveBeenCalledOnce()
  })

  it('resolves a kill for a session it never had', async () => {
    const harness = buildHarness()

    await expect(harness.registry.kill('never-existed')).resolves.toBeUndefined()
  })

  it('treats a throwing kill as a session that is already gone', async () => {
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)
    pty(harness.factory).kill.mockImplementation(() => {
      throw new Error('ESRCH')
    })

    await expect(harness.registry.kill('s1')).resolves.toBeUndefined()
    expect(harness.registry.sessionCount).toBe(0)
    expect(harness.logs.some((line) => line.includes('ESRCH'))).toBe(true)
  })

  it('ignores late output from a dropped PTY, including after its id is reused', async () => {
    vi.useFakeTimers()
    const harness = buildHarness()
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', false, 80, 24)

    const killed = harness.registry.kill('s1')
    await vi.advanceTimersByTimeAsync(2_000)
    await killed
    await harness.registry.spawn('s1', 'claude', 'C:\\Projects', true, 80, 24)

    pty(harness.factory, 0).emitData('from the dead pty')
    pty(harness.factory, 0).emitExit(1)
    pty(harness.factory, 1).emitData('from the live pty')

    expect(harness.events).toEqual([{ type: 'data', sessionId: 's1', data: 'from the live pty', sequence: 1 }])
    expect(harness.registry.replay('s1').data).toBe('from the live pty')
  })

  it('kills every session on retire and leaves the table empty', async () => {
    vi.useFakeTimers()
    const harness = buildHarness()
    await harness.registry.spawn('one', 'claude', 'C:\\Projects', false, 80, 24)
    await harness.registry.spawn('two', 'codex', 'C:\\Projects', false, 80, 24)

    const pending = harness.registry.killAll()
    expect(pty(harness.factory, 0).kill).toHaveBeenCalledOnce()
    expect(pty(harness.factory, 1).kill).toHaveBeenCalledOnce()
    pty(harness.factory, 0).emitExit(0)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(pending).resolves.toBeUndefined()
    expect(harness.registry.sessionCount).toBe(0)
  })
})
