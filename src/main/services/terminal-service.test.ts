import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionRecord } from '../../shared/contracts'
import {
  TerminalService,
  type IPtyFactory,
  type ManagedPty,
  type PtySpawnOptions
} from './terminal-service'

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
  readonly spawn = vi.fn<(file: string, args: readonly string[] | string, options: PtySpawnOptions) => ManagedPty>()
  private readonly queued: FakePty[] = []

  constructor(...ptys: FakePty[]) {
    this.queued.push(...ptys)
    this.spawn.mockImplementation(() => {
      const pty = this.queued.shift()
      if (!pty) throw new Error('No fake PTY queued.')
      return pty
    })
  }
}

const session = (id: string, kind: SessionRecord['kind'] = 'powershell', launchPath = 'C:\\Projects\\App One'): SessionRecord => ({
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

type Locator = {
  resolvePowerShell(): Promise<string | undefined>
  resolveAgent(agent: 'claude' | 'codex'): Promise<string | undefined>
}

const locatorWith = (resolved: Partial<Record<'powershell' | 'claude' | 'codex', string>> = {}): Locator => ({
  resolvePowerShell: vi.fn(async () => resolved.powershell ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
  resolveAgent: vi.fn(async (agent: 'claude' | 'codex') => resolved[agent])
})

type ServiceOptions = {
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  candidateExists?: (candidate: string) => Promise<boolean>
  stopTimeoutMs?: number
  locator?: Locator
}

const serviceWith = (factory: IPtyFactory, options: ServiceOptions = {}): TerminalService => new TerminalService(
  options.locator ?? locatorWith(),
  factory,
  options.environment ?? { PATH: 'C:\\Windows', KEEP_ME: 'yes' },
  options.platform ?? 'win32',
  options.candidateExists ?? vi.fn(async () => false),
  options.stopTimeoutMs ?? 2_000
)

const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TerminalService launch adapters', () => {
  it('starts PowerShell in the session launch path with inherited terminal settings', async () => {
    const pty = new FakePty()
    const factory = new FakePtyFactory(pty)
    const locator = locatorWith({ powershell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })
    const service = serviceWith(factory, { locator, environment: { PATH: 'C:\\Windows', TERM: 'old', KEEP_ME: 'yes' } })

    await service.start(session('shell-1'))

    expect(locator.resolvePowerShell).toHaveBeenCalledOnce()
    expect(factory.spawn).toHaveBeenCalledWith('C:\\Program Files\\PowerShell\\7\\pwsh.exe', [], {
      cwd: 'C:\\Projects\\App One',
      env: { PATH: 'C:\\Windows', TERM: 'xterm-256color', KEEP_ME: 'yes' },
      name: 'xterm-256color',
      cols: 120,
      rows: 30
    })
    expect(service.isRunning('shell-1')).toBe(true)
  })

  it('starts CMD from ComSpec without agent bypass arguments', async () => {
    const factory = new FakePtyFactory(new FakePty())
    const locator = locatorWith()
    const service = serviceWith(factory, {
      locator,
      environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    })

    await service.start(session('cmd-1', 'cmd'))

    expect(factory.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      [],
      expect.objectContaining({ cwd: 'C:\\Projects\\App One' })
    )
    expect(locator.resolveAgent).not.toHaveBeenCalled()
  })

  it.each([
    ['claude' as const, 'C:\\Agents With Spaces\\claude.exe', ['--dangerously-skip-permissions']],
    ['codex' as const, 'C:\\Agents With Spaces\\codex.com', ['--dangerously-bypass-approvals-and-sandbox']]
  ])('spawns a direct %s executable with only its fixed bypass arguments', async (kind, executable, expectedArgs) => {
    const factory = new FakePtyFactory(new FakePty())
    const service = serviceWith(factory, { locator: locatorWith({ [kind]: executable }) })

    await service.start(session(`${kind}-direct`, kind))

    expect(factory.spawn).toHaveBeenCalledWith(executable, expectedArgs, expect.any(Object))
  })

  it.each([
    ['claude' as const, 'cmd', '--dangerously-skip-permissions'],
    ['codex' as const, 'bat', '--dangerously-bypass-approvals-and-sandbox']
  ])('hosts a resolved %s .%s shim with ComSpec and a raw double-wrapped command', async (kind, extension, bypassFlag) => {
    const shim = `C:\\Users\\Dev Name\\AppData\\Roaming\\npm\\${kind}.${extension}`
    const comspec = 'C:\\Windows\\System32\\cmd.exe'
    const factory = new FakePtyFactory(new FakePty())
    const service = serviceWith(factory, {
      locator: locatorWith({ [kind]: shim }),
      environment: { ComSpec: comspec },
      candidateExists: vi.fn(async () => false)
    })

    await service.start(session(`${kind}-shim`, kind))

    expect(factory.spawn).toHaveBeenCalledWith(
      comspec,
      `/d /s /c ""${shim}" ${bypassFlag}"`,
      expect.any(Object)
    )
  })

  it('resolves an extensionless npm command to a sibling .cmd shim', async () => {
    const resolved = 'C:\\Users\\Dev Name\\AppData\\Roaming\\npm\\claude'
    const commandShim = `${resolved}.cmd`
    const candidateExists = vi.fn(async (candidate: string) => candidate === commandShim)
    const factory = new FakePtyFactory(new FakePty())
    const service = serviceWith(factory, {
      locator: locatorWith({ claude: resolved }),
      environment: { COMSPEC: 'C:\\Windows\\cmd.exe' },
      candidateExists
    })

    await service.start(session('claude-extensionless', 'claude'))

    expect(candidateExists.mock.calls).toEqual([[`${resolved}.exe`], [commandShim]])
    expect(factory.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\cmd.exe',
      `/d /s /c ""${commandShim}" --dangerously-skip-permissions"`,
      expect.any(Object)
    )
  })

  it('prefers an executable sibling for an extensionless npm command', async () => {
    const resolved = 'C:\\Program Files\\agents\\codex'
    const executable = `${resolved}.exe`
    const candidateExists = vi.fn(async (candidate: string) => candidate === executable)
    const factory = new FakePtyFactory(new FakePty())
    const service = serviceWith(factory, {
      locator: locatorWith({ codex: resolved }),
      candidateExists
    })

    await service.start(session('codex-extensionless', 'codex'))

    expect(candidateExists.mock.calls).toEqual([[executable]])
    expect(factory.spawn).toHaveBeenCalledWith(
      executable,
      ['--dangerously-bypass-approvals-and-sandbox'],
      expect.any(Object)
    )
  })

  it.each([
    ['claude' as const, 'C:\\Agents With Spaces\\claude.exe', ['--dangerously-skip-permissions', '--continue']],
    ['codex' as const, 'C:\\Agents With Spaces\\codex.com', ['resume', '--last', '--dangerously-bypass-approvals-and-sandbox']]
  ])('spawns a restored direct %s executable with its conversation resume arguments', async (kind, executable, expectedArgs) => {
    const factory = new FakePtyFactory(new FakePty())
    const service = serviceWith(factory, { locator: locatorWith({ [kind]: executable }) })

    await service.start(session(`${kind}-resume`, kind), { resume: true })

    expect(factory.spawn).toHaveBeenCalledWith(executable, expectedArgs, expect.any(Object))
  })

  it('hosts a restored claude .cmd shim with the continue flag inside the wrapped command', async () => {
    const shim = 'C:\\Users\\Dev Name\\AppData\\Roaming\\npm\\claude.cmd'
    const comspec = 'C:\\Windows\\System32\\cmd.exe'
    const factory = new FakePtyFactory(new FakePty())
    const service = serviceWith(factory, {
      locator: locatorWith({ claude: shim }),
      environment: { ComSpec: comspec },
      candidateExists: vi.fn(async () => false)
    })

    await service.start(session('claude-resume-shim', 'claude'), { resume: true })

    expect(factory.spawn).toHaveBeenCalledWith(
      comspec,
      `/d /s /c ""${shim}" --dangerously-skip-permissions --continue"`,
      expect.any(Object)
    )
  })

  it('starts a restored shell without resume arguments', async () => {
    const factory = new FakePtyFactory(new FakePty())
    const service = serviceWith(factory, { locator: locatorWith() })

    await service.start(session('shell-resume'), { resume: true })

    expect(factory.spawn).toHaveBeenCalledWith(expect.any(String), [], expect.any(Object))
  })

  it('rejects unavailable and unsafe agent commands without spawning', async () => {
    const factory = new FakePtyFactory()
    const unavailable = serviceWith(factory, { locator: locatorWith() })
    await expect(unavailable.start(session('missing', 'claude'))).rejects.toThrow(/not available/i)

    const unsafe = serviceWith(factory, {
      locator: locatorWith({ codex: 'C:\\bad"name\\codex.cmd' }),
      candidateExists: vi.fn(async () => true)
    })
    await expect(unsafe.start(session('unsafe', 'codex'))).rejects.toThrow(/unsafe/i)
    expect(factory.spawn).not.toHaveBeenCalled()
  })
})

describe('TerminalService lifecycle', () => {
  it('rejects a concurrent duplicate start before resolution and spawns once', async () => {
    const resolution = deferred<string | undefined>()
    const locator: Locator = {
      resolvePowerShell: vi.fn(() => resolution.promise),
      resolveAgent: vi.fn(async () => undefined)
    }
    const factory = new FakePtyFactory(new FakePty())
    const service = serviceWith(factory, { locator })

    const first = service.start(session('same'))
    await expect(service.start(session('same'))).rejects.toThrow(/already running|starting/i)
    resolution.resolve('C:\\Windows\\pwsh.exe')
    await first

    expect(factory.spawn).toHaveBeenCalledOnce()
  })

  it('writes and resizes only a running session', async () => {
    const pty = new FakePty()
    const service = serviceWith(new FakePtyFactory(pty))
    await service.start(session('active'))

    service.write('active', 'hello\r')
    service.resize('active', 160, 48)

    expect(pty.write).toHaveBeenCalledWith('hello\r')
    expect(pty.resize).toHaveBeenCalledWith(160, 48)
    expect(() => service.write('missing', 'x')).toThrow(/not running/i)
    expect(() => service.resize('missing', 80, 24)).toThrow(/not running/i)
  })

  it.each([
    [0, 24], [80, 0], [1.5, 24], [80, Number.NaN], [1001, 24], [80, 1001]
  ])('rejects unsafe terminal dimensions %s x %s', async (cols, rows) => {
    const pty = new FakePty()
    const service = serviceWith(new FakePtyFactory(pty))
    await service.start(session('active'))

    expect(() => service.resize('active', cols, rows)).toThrow(/dimensions/i)
    expect(pty.resize).not.toHaveBeenCalled()
  })

  it('routes data by session id and removes a naturally exited PTY before publishing exit', async () => {
    const first = new FakePty()
    const second = new FakePty()
    const service = serviceWith(new FakePtyFactory(first, second))
    const data = vi.fn()
    const exit = vi.fn((payload: { sessionId: string; exitCode: number }) => {
      expect(service.isRunning(payload.sessionId)).toBe(false)
    })
    service.on('data', data)
    service.on('exit', exit)
    await service.start(session('one'))
    await service.start(session('two'))

    second.emitData('from two')
    first.emitData('from one')
    first.emitExit(17)

    expect(data.mock.calls).toEqual([
      [{ sessionId: 'two', data: 'from two' }],
      [{ sessionId: 'one', data: 'from one' }]
    ])
    expect(exit).toHaveBeenCalledWith({ sessionId: 'one', exitCode: 17 })
    expect(service.isRunning('two')).toBe(true)
    expect(first.dataDisposals).toBe(1)
    expect(first.exitDisposals).toBe(1)
  })

  it('isolates listener failures and supports unsubscribe', async () => {
    const pty = new FakePty()
    const service = serviceWith(new FakePtyFactory(pty))
    const broken = vi.fn(() => { throw new Error('listener failed') })
    const retained = vi.fn()
    const removed = vi.fn()
    service.on('data', broken)
    service.on('data', retained)
    const unsubscribe = service.on('data', removed)
    unsubscribe()
    unsubscribe()
    await service.start(session('listeners'))

    expect(() => pty.emitData('safe')).not.toThrow()
    expect(broken).toHaveBeenCalledOnce()
    expect(retained).toHaveBeenCalledWith({ sessionId: 'listeners', data: 'safe' })
    expect(removed).not.toHaveBeenCalled()
  })

  it('lets a PTY exit naturally during stop without killing it', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const service = serviceWith(new FakePtyFactory(pty))
    await service.start(session('natural-stop'))

    const pending = service.stop('natural-stop')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(pty.kill).not.toHaveBeenCalled()
    pty.emitExit(0)

    await expect(pending).resolves.toBeUndefined()
    expect(pty.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kills once after the stop deadline and makes repeated stop idempotent', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const service = serviceWith(new FakePtyFactory(pty))
    await service.start(session('stubborn'))

    const first = service.stop('stubborn')
    const second = service.stop('stubborn')
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(pty.kill).toHaveBeenCalledOnce()
    expect(service.isRunning('stubborn')).toBe(false)
    await expect(service.stop('stubborn')).resolves.toBeUndefined()
    expect(pty.kill).toHaveBeenCalledOnce()
  })

  it('stops every session and aggregates kill failures after all attempts', async () => {
    vi.useFakeTimers()
    const first = new FakePty()
    const second = new FakePty()
    first.kill.mockImplementation(() => { throw new Error('first kill failed') })
    const service = serviceWith(new FakePtyFactory(first, second))
    await service.start(session('one'))
    await service.start(session('two'))

    const pending = service.stopAll()
    const rejection = expect(pending).rejects.toThrow(AggregateError)
    await vi.advanceTimersByTimeAsync(2_000)

    await rejection
    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).toHaveBeenCalledOnce()
    expect(service.isRunning('one')).toBe(false)
    expect(service.isRunning('two')).toBe(false)
  })
})

describe.skipIf(process.platform !== 'win32')('TerminalService Windows shim integration', () => {
  it('runs a spaced command shim with the exact fixed argument through node-pty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codefly terminal shim '))
    const shim = join(directory, 'claude.cmd')
    const argsFile = join(directory, 'received args.txt')
    const script = ['@echo off', `> "${argsFile}" echo %*`, 'exit /b 0', ''].join('\r\n')

    try {
      await writeFile(shim, script, 'utf8')
      const service = new TerminalService(
        locatorWith({ claude: shim }),
        undefined,
        process.env,
        'win32',
        vi.fn(async () => false)
      )
      const exited = new Promise<void>((resolve) => service.on('exit', () => resolve()))

      await service.start(session('real-shim', 'claude', directory))
      await exited

      expect((await readFile(argsFile, 'utf8')).trim()).toBe('--dangerously-skip-permissions')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
