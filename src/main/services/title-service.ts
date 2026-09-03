import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { join, win32 as windowsPath } from 'node:path'

import { app } from 'electron'

import type { SessionKind } from '../../shared/contracts'
import { cliLocator, type CliLocator } from '../infrastructure/cli-locator'

export const TITLE_PROMPT = 'Return one concise session title only. Use the input language. No quotes, markdown, or explanation. Limit the title to 24 characters.'
export const TITLE_TIMEOUT_MS = 15_000
export const TITLE_MAX_OUTPUT_BYTES = 4 * 1024

/**
 * The agent CLIs whose non-interactive mode is verified enough to generate a title with.
 * Deliberately narrower than the shared `AgentKind` registry: every other agent kind falls
 * through to the local normalizer, because a title process must never carry a permission
 * bypass and each vendor's `--print` output would have to be checked before trusting it.
 */
type TitleCapableKind = Extract<SessionKind, 'claude' | 'codex'>

export type TitleAdapterOptions = {
  cwd: string
  signal: AbortSignal
  maxOutputBytes: number
}

export interface TitleAdapter {
  generate(prompt: string, options: TitleAdapterOptions): Promise<string>
}

type TitleReadable = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

type TitleWritable = {
  end(input: string): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnedTitleProcess = {
  readonly stdout: TitleReadable
  readonly stdin: TitleWritable
  on(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  kill(): boolean
}

export type TitleProcessSpawner = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string
    windowsHide: true
    windowsVerbatimArguments?: true
    shell: false
    stdio: ['pipe', 'pipe', 'ignore']
  }
) => SpawnedTitleProcess

const defaultProcessSpawner: TitleProcessSpawner = (file, args, options) =>
  spawn(file, [...args], options) as unknown as SpawnedTitleProcess

const argvFor = (kind: TitleCapableKind): readonly string[] =>
  kind === 'claude' ? ['--print'] : ['exec', '--skip-git-repo-check', '-']

type CandidateExists = (candidate: string) => Promise<boolean>

export type TitleAdapterHostOptions = {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  candidateExists?: CandidateExists
}

type TitleLaunchSpec = { file: string; args: readonly string[]; windowsVerbatimArguments?: true }

const defaultCandidateExists: CandidateExists = async (candidate) => {
  try {
    await access(candidate, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const commandForShim = (shim: string, logicalArgs: readonly string[]): string => {
  if (/["\u0000-\u001F\u007F]/u.test(shim)) throw new Error('Resolved command shim contains unsafe characters.')
  return `""${shim.replace(/%/g, '^%')}" ${logicalArgs.join(' ')}"`
}

const windowsLaunchSpec = async (
  resolved: string,
  logicalArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
  candidateExists: CandidateExists
): Promise<TitleLaunchSpec> => {
  if (/["\u0000-\u001F\u007F]/u.test(resolved)) throw new Error('Resolved agent path contains unsafe characters.')
  const extension = windowsPath.extname(resolved).toLowerCase()
  if (extension === '.exe' || extension === '.com') return { file: resolved, args: logicalArgs }

  let commandShim: string | undefined
  if (extension === '.cmd' || extension === '.bat') {
    const executable = `${resolved.slice(0, -extension.length)}.exe`
    if (await candidateExists(executable)) return { file: executable, args: logicalArgs }
    commandShim = resolved
  } else if (extension.length === 0) {
    const executable = `${resolved}.exe`
    if (await candidateExists(executable)) return { file: executable, args: logicalArgs }
    const siblingShim = `${resolved}.cmd`
    if (await candidateExists(siblingShim)) commandShim = siblingShim
    else {
      const siblingBatchShim = `${resolved}.bat`
      if (await candidateExists(siblingBatchShim)) commandShim = siblingBatchShim
    }
  }

  if (!commandShim) throw new Error('Resolved Windows agent command is not directly executable and has no command shim.')
  return {
    file: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', commandForShim(commandShim, logicalArgs)],
    windowsVerbatimArguments: true
  }
}

export const createCliTitleAdapter = (
  kind: TitleCapableKind,
  locator: Pick<CliLocator, 'resolveAgent'> = cliLocator,
  processSpawner: TitleProcessSpawner = defaultProcessSpawner,
  hostOptions: TitleAdapterHostOptions = {}
): TitleAdapter => ({
  async generate(prompt, options) {
    if (options.signal.aborted) throw new Error('Title generation cancelled.')
    const resolved = await locator.resolveAgent(kind)
    if (!resolved) throw new Error(`${kind} is not available.`)
    const logicalArgs = argvFor(kind)
    const launch = (hostOptions.platform ?? process.platform) === 'win32'
      ? await windowsLaunchSpec(
        resolved,
        logicalArgs,
        hostOptions.environment ?? process.env,
        hostOptions.candidateExists ?? defaultCandidateExists
      )
      : { file: resolved, args: logicalArgs }
    if (options.signal.aborted) throw new Error('Title generation cancelled.')

    return new Promise<string>((resolve, reject) => {
      let child: SpawnedTitleProcess
      try {
        child = processSpawner(launch.file, launch.args, {
          cwd: options.cwd,
          windowsHide: true,
          ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore']
        })
      } catch (error) {
        reject(error)
        return
      }

      const chunks: Buffer[] = []
      let outputBytes = 0
      let settled = false

      const stopTransientWork = (): void => {
        child.stdout.removeListener('data', onData)
        options.signal.removeEventListener('abort', onAbort)
      }
      const cleanupAfterClose = (): void => {
        stopTransientWork()
        child.removeListener('close', onClose)
        child.removeListener('error', onError)
        child.stdin.removeListener('error', onStdinError)
      }
      const rejectOnce = (error: Error, terminate: boolean): void => {
        if (settled) return
        settled = true
        stopTransientWork()
        reject(error)
        if (terminate) {
          try {
            child.kill()
          } catch {
            // The process may already have exited.
          }
        }
      }
      const onData = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        outputBytes += bytes.length
        if (outputBytes > options.maxOutputBytes) {
          rejectOnce(new Error('Title output limit exceeded.'), true)
          return
        }
        chunks.push(bytes)
      }
      const onClose = (code: number | null): void => {
        if (settled) {
          cleanupAfterClose()
          return
        }
        settled = true
        cleanupAfterClose()
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString('utf8'))
          return
        }
        reject(new Error(`${kind} title process exited with code ${code ?? 'unknown'}.`))
      }
      const onError = (error: Error): void => rejectOnce(error, false)
      const onStdinError = (error: Error): void => rejectOnce(error, true)
      const onAbort = (): void => rejectOnce(new Error('Title generation cancelled.'), true)

      child.stdout.on('data', onData)
      child.once('close', onClose)
      child.on('error', onError)
      child.stdin.on('error', onStdinError)
      options.signal.addEventListener('abort', onAbort, { once: true })

      if (options.signal.aborted) {
        onAbort()
        return
      }
      try {
        child.stdin.end(prompt)
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)), true)
      }
    })
  }
})

type TitleAdapterMap = Partial<Record<TitleCapableKind, TitleAdapter>>
type EnsureDirectory = (path: string) => Promise<unknown>
type InFlightJob = { controller: AbortController }

const productionAdapters = (): TitleAdapterMap => ({
  claude: createCliTitleAdapter('claude'),
  codex: createCliTitleAdapter('codex')
})

const removeAnsiAndControls = (value: string): string => value
  .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
  .replace(/(?:\x1B\[|\u009B)[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1B[\x20-\x2F]*[\x30-\x7E]/g, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')

const unwrapTitle = (value: string): string => {
  let title = value.trim().replace(/\s+/gu, ' ')
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['```', '```'], ['**', '**'], ['__', '__'], ['~~', '~~'],
    ['"', '"'], ["'", "'"], ['`', '`'], ['*', '*'], ['_', '_'],
    ['\u201c', '\u201d'], ['\u2018', '\u2019']
  ]

  let changed = true
  while (changed && title.length > 0) {
    changed = false
    for (const [start, end] of pairs) {
      if (title.length >= start.length + end.length && title.startsWith(start) && title.endsWith(end)) {
        title = title.slice(start.length, -end.length).trim()
        changed = true
        break
      }
    }
  }
  return title.replace(/^#{1,6}\s+/u, '').replace(/^(?:[-*+])\s+/u, '').trim()
}

const truncateCodePoints = (value: string): string => Array.from(value).slice(0, 24).join('')

export const sanitizeTitle = (value: string): string =>
  truncateCodePoints(unwrapTitle(removeAnsiAndControls(value)))

const removePromptPrefix = (value: string): string => value
  .replace(/^PS\s+[^>\r\n]+>\s*/iu, '')
  .replace(/^[A-Z]:\\[^>\r\n]*>\s*/iu, '')
  .replace(/^[\w.-]+@[\w.-]+(?::[^$#\r\n]*)?[$#]\s*/u, '')
  .replace(/^(?:claude|codex)\s*>\s*/iu, '')
  .replace(/^[$#>]\s*/u, '')

const trimRedundantPunctuation = (value: string): string => value
  .replace(/^[,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\s]+/u, '')
  .replace(/[,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\s]+$/u, '')

export const normalizeTitleLocally = (input: string): string => {
  const text = removeAnsiAndControls(input)
  for (const line of text.split(/\r?\n/u)) {
    const withoutPrompt = removePromptPrefix(line.trim())
    for (const sentence of withoutPrompt.split(/(?<=[.!?])\s+|[\u3002\uff01\uff1f\uff1b;]+/u)) {
      const normalized = trimRedundantPunctuation(sentence).replace(/\s+/gu, ' ').trim()
      if (normalized.length > 0) return sanitizeTitle(normalized)
    }
  }
  return ''
}

export class TitleService {
  private readonly jobs = new Map<string, InFlightJob>()

  constructor(
    private readonly adapters: TitleAdapterMap = productionAdapters(),
    private readonly getUserDataPath: () => string = () => app.getPath('userData'),
    private readonly ensureDirectory: EnsureDirectory = async (path) => { await mkdir(path, { recursive: true }) }
  ) {}

  async generate(sessionId: string, kind: SessionKind, input: string): Promise<string> {
    if (kind === 'claude' || kind === 'codex') {
      const adapter = this.adapters[kind]
      if (adapter) {
        this.cancel(sessionId)
        const job = { controller: new AbortController() }
        this.jobs.set(sessionId, job)
        try {
          const cwd = join(this.getUserDataPath(), 'title-generator')
          await this.ensureDirectory(cwd)
          if (job.controller.signal.aborted) throw new Error('Title generation cancelled.')

          const generated = await this.generateWithDeadline(adapter, promptFor(input), cwd, job.controller)
          const title = sanitizeTitle(generated)
          if (title.length > 0) return title
        } catch {
          // Adapter failures, cancellation, and timeouts all continue through deterministic fallbacks.
        } finally {
          if (this.jobs.get(sessionId) === job) this.jobs.delete(sessionId)
        }
      }
    }

    const local = normalizeTitleLocally(input)
    return local.length > 0 ? local : sanitizeTitle(input)
  }

  cancel(sessionId: string): void {
    this.jobs.get(sessionId)?.controller.abort()
  }

  private async generateWithDeadline(
    adapter: TitleAdapter,
    prompt: string,
    cwd: string,
    controller: AbortController
  ): Promise<string> {
    const signal = controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Title generation timed out.'))
      }, TITLE_TIMEOUT_MS)
    })
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Title generation cancelled.'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })

    try {
      return await Promise.race([
        adapter.generate(prompt, { cwd, signal, maxOutputBytes: TITLE_MAX_OUTPUT_BYTES }),
        timeout,
        cancellation
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

const promptFor = (input: string): string => `${TITLE_PROMPT}\n\n<input>\n${input}\n</input>`
