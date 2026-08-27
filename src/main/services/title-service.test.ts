import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionKind } from '../../shared/contracts'
import {
  createCliTitleAdapter,
  TITLE_MAX_OUTPUT_BYTES,
  TITLE_PROMPT,
  TITLE_TIMEOUT_MS,
  TitleService,
  type SpawnedTitleProcess,
  type TitleAdapter
} from './title-service'

const adapterFor = (generate: TitleAdapter['generate']): TitleAdapter => ({ generate })

const serviceWith = (
  adapters: Partial<Record<'claude' | 'codex', TitleAdapter>>,
  ensureDirectory = vi.fn(async () => undefined)
): TitleService => new TitleService(adapters, () => 'C:\\CodeFlyData', ensureDirectory)

const promptFor = (input: string): string => `${TITLE_PROMPT}\n\n<input>\n${input}\n</input>`

afterEach(() => {
  vi.useRealTimers()
})

describe('TitleService', () => {
  it.each([
    ['claude' as const, '\u001b[32m  "**Fix   skipped trades**"  \u001b[0m\r\n', 'Fix skipped trades'],
    ['codex' as const, '“修复   中文标题”', '修复 中文标题']
  ])('sanitizes %s output in English and Chinese', async (kind, output, expected) => {
    const service = serviceWith({ [kind]: adapterFor(vi.fn(async () => output)) })

    await expect(service.generate('session-1', kind, 'ignored input')).resolves.toBe(expected)
  })

  it('strips ESC sequences containing intermediate bytes from AI output', async () => {
    const service = serviceWith({ claude: adapterFor(vi.fn(async () => '\u001b(BTitle\u001b)0')) })

    await expect(service.generate('session-1', 'claude', 'fallback')).resolves.toBe('Title')
  })

  it('limits a title to 24 Unicode code points', async () => {
    const service = serviceWith({ claude: adapterFor(vi.fn(async () => `${'😀'.repeat(23)}中文`)) })

    const title = await service.generate('session-1', 'claude', 'fallback')

    expect(Array.from(title)).toHaveLength(24)
    expect(title).toBe(`${'😀'.repeat(23)}中`)
  })

  it('uses the exact prompt and a dedicated userData directory with fixed limits', async () => {
    const generate = vi.fn(async () => 'Generated title')
    const ensureDirectory = vi.fn(async () => undefined)
    const service = serviceWith({ claude: adapterFor(generate) }, ensureDirectory)
    const input = '请修复 skipped trades'

    await expect(service.generate('session-1', 'claude', input)).resolves.toBe('Generated title')

    const cwd = join('C:\\CodeFlyData', 'title-generator')
    expect(ensureDirectory).toHaveBeenCalledWith(cwd)
    expect(generate).toHaveBeenCalledWith(promptFor(input), {
      cwd,
      signal: expect.any(AbortSignal),
      maxOutputBytes: TITLE_MAX_OUTPUT_BYTES
    })
  })

  it('aborts AI generation after 15 seconds and falls back locally', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const generate = vi.fn((_prompt: string, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise<string>(() => undefined)
    })
    const service = serviceWith({ claude: adapterFor(generate) })

    const pending = service.generate('session-1', 'claude', 'Fix the timeout. More details')
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS)

    await expect(pending).resolves.toBe('Fix the timeout')
    expect(signal?.aborted).toBe(true)
  })

  it('uses local normalization when AI returns empty output', async () => {
    const service = serviceWith({ codex: adapterFor(vi.fn(async () => '\u001b[0m  \r\n')) })

    await expect(service.generate('session-1', 'codex', 'PS C:\\repo> npm test。然后构建')).resolves.toBe('npm test')
  })

  it('uses AI, then local normalization, then direct raw truncation in priority order', async () => {
    const ai = serviceWith({ claude: adapterFor(vi.fn(async () => 'AI title')) })
    await expect(ai.generate('ai', 'claude', 'Local sentence. Details')).resolves.toBe('AI title')

    const local = serviceWith({ claude: adapterFor(vi.fn(async () => { throw new Error('offline') })) })
    await expect(local.generate('local', 'claude', '请帮我修复 skipped trades 统计。后面是细节')).resolves.toBe('请帮我修复 skipped trades 统计')

    const raw = serviceWith({ claude: adapterFor(vi.fn(async () => '')) })
    await expect(raw.generate('raw', 'claude', '.'.repeat(30))).resolves.toBe('.'.repeat(24))
  })

  it.each(['powershell', 'cmd'] satisfies SessionKind[])('%s starts locally and never calls an AI adapter', async (kind) => {
    const generate = vi.fn(async () => 'must not run')
    const ensureDirectory = vi.fn(async () => undefined)
    const service = serviceWith({ claude: adapterFor(generate), codex: adapterFor(generate) }, ensureDirectory)

    await expect(service.generate('session-1', kind, 'C:\\repo> npm run build. Then package')).resolves.toBe('npm run build')
    expect(generate).not.toHaveBeenCalled()
    expect(ensureDirectory).not.toHaveBeenCalled()
  })

  it('cancels only the requested session while another AI job completes', async () => {
    const signals = new Map<string, AbortSignal>()
    const resolvers = new Map<string, (value: string) => void>()
    const generate = vi.fn((prompt: string, { signal }: { signal: AbortSignal }) => {
      signals.set(prompt, signal)
      return new Promise<string>((resolve) => resolvers.set(prompt, resolve))
    })
    const service = serviceWith({ claude: adapterFor(generate) })
    const firstPrompt = promptFor('First request. Details')
    const secondPrompt = promptFor('Second request. Details')

    const first = service.generate('session-1', 'claude', 'First request. Details')
    const second = service.generate('session-2', 'claude', 'Second request. Details')
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2))
    service.cancel('session-1')
    resolvers.get(secondPrompt)?.('Second AI title')

    await expect(first).resolves.toBe('First request')
    await expect(second).resolves.toBe('Second AI title')
    expect(signals.get(firstPrompt)?.aborted).toBe(true)
    expect(signals.get(secondPrompt)?.aborted).toBe(false)
  })

  it('replaces a same-session job without letting its cleanup remove the newer job', async () => {
    const signals: AbortSignal[] = []
    const generate = vi.fn((_prompt: string, { signal }: { signal: AbortSignal }) => {
      signals.push(signal)
      return new Promise<string>(() => undefined)
    })
    const service = serviceWith({ codex: adapterFor(generate) })

    const first = service.generate('same-session', 'codex', 'First request')
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    const second = service.generate('same-session', 'codex', 'Second request')
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    await expect(first).resolves.toBe('First request')
    expect(signals[0]?.aborted).toBe(true)

    service.cancel('same-session')
    await expect(second).resolves.toBe('Second request')
    expect(signals[1]?.aborted).toBe(true)
  })
})

class FakeTitleProcess extends EventEmitter implements SpawnedTitleProcess {
  readonly stdout = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  readonly kill = vi.fn(() => true)
}

describe('createCliTitleAdapter', () => {
  it.each([
    ['claude' as const, ['--print']],
    ['codex' as const, ['exec', '--skip-git-repo-check', '-']]
  ])('launches %s shell-free with only its non-interactive argv', async (kind, expectedArgs) => {
    const child = new FakeTitleProcess()
    const spawn = vi.fn(() => child)
    const locator = { resolveAgent: vi.fn(async () => `C:\\bin\\${kind}.exe`) }
    const adapter = createCliTitleAdapter(kind, locator, spawn)
    const controller = new AbortController()

    const pending = adapter.generate('exact stdin prompt', {
      cwd: 'C:\\Data\\title-generator',
      signal: controller.signal,
      maxOutputBytes: TITLE_MAX_OUTPUT_BYTES
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    child.stdout.emit('data', Buffer.from('Title'))
    child.emit('close', 0, null)

    await expect(pending).resolves.toBe('Title')
    expect(locator.resolveAgent).toHaveBeenCalledWith(kind)
    expect(spawn).toHaveBeenCalledWith(`C:\\bin\\${kind}.exe`, expectedArgs, {
      cwd: 'C:\\Data\\title-generator',
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    expect(expectedArgs).not.toContain('--dangerously-skip-permissions')
    expect(expectedArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(child.stdin.end).toHaveBeenCalledWith('exact stdin prompt')
  })

  it('kills and rejects a child whose output exceeds 4 KiB', async () => {
    const child = new FakeTitleProcess()
    const adapter = createCliTitleAdapter(
      'claude',
      { resolveAgent: vi.fn(async () => 'claude.exe') },
      vi.fn(() => child)
    )

    const pending = adapter.generate('prompt', {
      cwd: 'C:\\Data\\title-generator',
      signal: new AbortController().signal,
      maxOutputBytes: TITLE_MAX_OUTPUT_BYTES
    })
    await vi.waitFor(() => expect(child.stdin.end).toHaveBeenCalled())
    child.stdout.emit('data', Buffer.alloc(TITLE_MAX_OUTPUT_BYTES + 1))

    await expect(pending).rejects.toThrow(/output limit/i)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('kills the spawned process when its job is cancelled', async () => {
    const child = new FakeTitleProcess()
    const adapter = createCliTitleAdapter(
      'codex',
      { resolveAgent: vi.fn(async () => 'codex.exe') },
      vi.fn(() => child)
    )
    const controller = new AbortController()

    const pending = adapter.generate('prompt', {
      cwd: 'C:\\Data\\title-generator',
      signal: controller.signal,
      maxOutputBytes: TITLE_MAX_OUTPUT_BYTES
    })
    await vi.waitFor(() => expect(child.stdin.end).toHaveBeenCalled())
    controller.abort()

    await expect(pending).rejects.toThrow(/cancelled/i)
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
