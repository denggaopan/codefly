import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { win32 as windowsPath } from 'node:path'

import { spawn as spawnPty } from 'node-pty'

import type { SessionKind, SessionRecord } from '../../shared/contracts'
import { cliLocator, type CliLocator } from '../infrastructure/cli-locator'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
const MAX_DIMENSION = 1000
const STOP_TIMEOUT_MS = 2_000

type AgentKind = Extract<SessionKind, 'claude' | 'codex'>

// On restore the previous agent conversation must come back, not a fresh one: claude
// continues the newest conversation recorded for the launch directory, while codex only
// exposes resume as a subcommand that reopens its most recent session.
const agentArguments = (kind: AgentKind, resume: boolean): readonly string[] => {
  if (kind === 'claude') {
    return resume ? ['--dangerously-skip-permissions', '--continue'] : ['--dangerously-skip-permissions']
  }
  return resume
    ? ['resume', '--last', '--dangerously-bypass-approvals-and-sandbox']
    : ['--dangerously-bypass-approvals-and-sandbox']
}

export type TerminalStartOptions = {
  /** Relaunch an agent CLI so it reattaches its previous conversation instead of starting a new one. */
  resume?: boolean
}

export type TerminalEventMap = {
  data: { sessionId: string; data: string }
  exit: { sessionId: string; exitCode: number }
}

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
  cols: 120
  rows: 30
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface IPtyFactory {
  spawn(file: string, args: readonly string[] | string, options: PtySpawnOptions): ManagedPty
}

type TerminalLocator = Pick<CliLocator, 'resolvePowerShell' | 'resolveAgent'>
type CandidateExists = (candidate: string) => Promise<boolean>
type LaunchSpec = { file: string; args: readonly string[] | string }

type StopState = {
  promise: Promise<void>
  timer: ReturnType<typeof setTimeout>
  resolve(): void
  reject(error: unknown): void
}

type PtyEntry = {
  pty: ManagedPty
  dataSubscription: PtyDisposable
  exitSubscription: PtyDisposable
  stop?: StopState
}

const productionPtyFactory: IPtyFactory = {
  spawn(file, args, options) {
    return spawnPty(file, typeof args === 'string' ? args : [...args], options) as ManagedPty
  }
}

const defaultCandidateExists: CandidateExists = async (candidate) => {
  try {
    await access(candidate, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const validateShimPath = (candidate: string): void => {
  if (/[%!"&|<>^\u0000-\u001F\u007F]/u.test(candidate)) {
    throw new Error('Resolved agent command shim contains unsafe characters.')
  }
}

const hostedShimSpec = (shim: string, logicalArgs: readonly string[], environment: NodeJS.ProcessEnv): LaunchSpec => {
  validateShimPath(shim)
  const command = `""${shim}" ${logicalArgs.join(' ')}"`
  return {
    file: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
    args: `/d /s /c ${command}`
  }
}

const windowsAgentSpec = async (
  resolved: string,
  logicalArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
  candidateExists: CandidateExists
): Promise<LaunchSpec> => {
  validateShimPath(resolved)
  const extension = windowsPath.extname(resolved).toLowerCase()
  if (extension === '.exe' || extension === '.com') return { file: resolved, args: logicalArgs }

  if (extension === '.cmd' || extension === '.bat') {
    const executable = `${resolved.slice(0, -extension.length)}.exe`
    if (await candidateExists(executable)) return { file: executable, args: logicalArgs }
    return hostedShimSpec(resolved, logicalArgs, environment)
  }

  if (extension.length === 0) {
    const executable = `${resolved}.exe`
    if (await candidateExists(executable)) return { file: executable, args: logicalArgs }
    const commandShim = `${resolved}.cmd`
    if (await candidateExists(commandShim)) return hostedShimSpec(commandShim, logicalArgs, environment)
    const batchShim = `${resolved}.bat`
    if (await candidateExists(batchShim)) return hostedShimSpec(batchShim, logicalArgs, environment)
  }

  throw new Error('Resolved Windows agent command is not executable and has no trusted command shim.')
}

export class TerminalService {
  private readonly entries = new Map<string, PtyEntry>()
  private readonly starting = new Set<string>()
  private readonly listeners = {
    data: new Set<(payload: TerminalEventMap['data']) => void>(),
    exit: new Set<(payload: TerminalEventMap['exit']) => void>()
  }

  constructor(
    private readonly locator: TerminalLocator = cliLocator,
    private readonly ptyFactory: IPtyFactory = productionPtyFactory,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly candidateExists: CandidateExists = defaultCandidateExists,
    private readonly stopTimeoutMs = STOP_TIMEOUT_MS
  ) {}

  async start(session: SessionRecord, options: TerminalStartOptions = {}): Promise<void> {
    if (this.entries.has(session.id) || this.starting.has(session.id)) {
      throw new Error(`Terminal session is already running or starting: ${session.id}`)
    }

    this.starting.add(session.id)
    try {
      const launch = await this.resolveLaunchSpec(session.kind, options.resume === true)
      const pty = this.ptyFactory.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: session.launchPath,
        env: { ...this.environment, TERM: 'xterm-256color' }
      })

      let entry!: PtyEntry
      const dataSubscription = pty.onData((data) => {
        if (this.entries.get(session.id) === entry) this.publish('data', { sessionId: session.id, data })
      })
      const exitSubscription = pty.onExit(({ exitCode }) => {
        if (this.entries.get(session.id) !== entry) return
        this.entries.delete(session.id)
        this.disposeEntry(entry)
        entry.stop?.resolve()
        this.publish('exit', { sessionId: session.id, exitCode })
      })
      entry = { pty, dataSubscription, exitSubscription }
      this.entries.set(session.id, entry)
    } finally {
      this.starting.delete(session.id)
    }
  }

  write(sessionId: string, data: string): void {
    this.runningEntry(sessionId).pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.runningEntry(sessionId)
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_DIMENSION || rows > MAX_DIMENSION) {
      throw new Error('Terminal dimensions must be positive integers no greater than 1000.')
    }
    entry.pty.resize(cols, rows)
  }

  stop(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (!entry) return Promise.resolve()
    if (entry.stop) return entry.stop.promise

    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((complete, fail) => {
      resolve = complete
      reject = fail
    })
    const timer = setTimeout(() => {
      if (this.entries.get(sessionId) !== entry) return
      this.entries.delete(sessionId)
      this.disposeEntry(entry)
      try {
        entry.pty.kill()
        resolve()
      } catch (error) {
        reject(error)
      }
    }, this.stopTimeoutMs)
    entry.stop = { promise, timer, resolve, reject }
    return promise
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.keys()].map((sessionId) => this.stop(sessionId)))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'One or more terminal sessions could not be stopped.')
  }

  isRunning(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  on<K extends keyof TerminalEventMap>(event: K, listener: (payload: TerminalEventMap[K]) => void): () => void {
    const listeners = this.listeners[event] as Set<(payload: TerminalEventMap[K]) => void>
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  private async resolveLaunchSpec(kind: SessionKind, resume: boolean): Promise<LaunchSpec> {
    if (kind === 'powershell') {
      const executable = await this.locator.resolvePowerShell()
      if (!executable) throw new Error('PowerShell is not available.')
      return { file: executable, args: [] }
    }
    if (kind === 'cmd') {
      return { file: this.environment.ComSpec ?? this.environment.COMSPEC ?? 'cmd.exe', args: [] }
    }

    const resolved = await this.locator.resolveAgent(kind)
    if (!resolved) throw new Error(`${kind} is not available.`)
    const logicalArgs = agentArguments(kind, resume)
    return this.platform === 'win32'
      ? windowsAgentSpec(resolved, logicalArgs, this.environment, this.candidateExists)
      : { file: resolved, args: logicalArgs }
  }

  private runningEntry(sessionId: string): PtyEntry {
    const entry = this.entries.get(sessionId)
    if (!entry) throw new Error(`Terminal session is not running: ${sessionId}`)
    return entry
  }

  private disposeEntry(entry: PtyEntry): void {
    if (entry.stop) clearTimeout(entry.stop.timer)
    entry.dataSubscription.dispose()
    entry.exitSubscription.dispose()
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
}
