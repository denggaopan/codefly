import { describe, expect, it, vi } from 'vitest'

import type { CommandRunner } from './command-runner'
import { CliLocator } from './cli-locator'

const runnerWith = (run: CommandRunner['run']): CommandRunner => ({ run })

describe('CliLocator', () => {
  it('uses where.exe with an exact name and selects the first existing CRLF result', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '"C:\\missing\\tool.exe"\r\nC:\\tools\\tool.exe\r\n', stderr: '', exitCode: 0 })
    const exists = vi.fn(async (candidate: string) => candidate === 'C:\\tools\\tool.exe')
    const locator = new CliLocator(runnerWith(run), exists)

    await expect(locator.resolve('tool.exe')).resolves.toBe('C:\\tools\\tool.exe')
    expect(run).toHaveBeenCalledWith('where.exe', ['tool.exe'])
    expect(exists).toHaveBeenCalledTimes(2)
  })

  it('returns undefined when where.exe fails', async () => {
    const locator = new CliLocator(runnerWith(vi.fn().mockRejectedValue(new Error('not found'))))

    await expect(locator.resolve('missing')).resolves.toBeUndefined()
  })

  it('prefers pwsh.exe and falls back to powershell.exe', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\n', stderr: '', exitCode: 0 })
    const preferred = new CliLocator(runnerWith(run), async () => true)
    await expect(preferred.resolvePowerShell()).resolves.toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')

    const fallbackRun = vi.fn()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce({ stdout: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\n', stderr: '', exitCode: 0 })
    const fallback = new CliLocator(runnerWith(fallbackRun), async () => true)
    await expect(fallback.resolvePowerShell()).resolves.toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(fallbackRun.mock.calls).toEqual([['where.exe', ['pwsh.exe']], ['where.exe', ['powershell.exe']]])
  })

  it('looks up agents by exact name and preserves cmd paths', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd\n', stderr: '', exitCode: 0 })
    const locator = new CliLocator(runnerWith(run), async () => true)

    await expect(locator.resolveAgent('codex')).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd')
    expect(run).toHaveBeenCalledWith('where.exe', ['codex'])
  })

  // Two kinds are not named after their binary, and looking up the kind instead would find
  // nothing: Cursor's terminal agent is `agent`, and `comate` is not a command.
  it.each([
    ['cursor' as const, 'agent'],
    ['comate' as const, 'comatecli'],
    ['gemini' as const, 'gemini'],
    ['copilot' as const, 'copilot'],
    ['qwen' as const, 'qwen']
  ])('looks up %s as the executable its vendor installs', async (kind, executable) => {
    const run = vi.fn().mockResolvedValue({ stdout: `C:\\npm\\${executable}.cmd\n`, stderr: '', exitCode: 0 })
    const locator = new CliLocator(runnerWith(run), async () => true)

    await expect(locator.resolveAgent(kind)).resolves.toBe(`C:\\npm\\${executable}.cmd`)
    expect(run).toHaveBeenCalledWith('where.exe', [executable])
  })

  it('rejects unsafe command names before invoking where.exe', async () => {
    const run = vi.fn()
    const locator = new CliLocator(runnerWith(run), async () => true)

    await expect(locator.resolve('tool & injected')).rejects.toThrow('Invalid command name')
    expect(run).not.toHaveBeenCalled()
  })

  it('uses the macOS login shell and ignores startup noise around an executable path', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: 'Welcome from .zshrc\n/opt/homebrew/bin/claude\n',
      stderr: '',
      exitCode: 0
    })
    const executable = vi.fn(async (candidate: string) => candidate === '/bin/zsh' || candidate === '/opt/homebrew/bin/claude')
    const locator = new CliLocator(runnerWith(run), executable, {
      platform: 'darwin',
      environment: { SHELL: '/bin/zsh', HOME: '/Users/me' }
    })

    await expect(locator.resolveAgent('claude')).resolves.toBe('/opt/homebrew/bin/claude')
    expect(run).toHaveBeenCalledWith('/bin/zsh', ['-lic', 'command -v -- claude'], undefined, { timeoutMs: 5_000 })
  })

  it('checks standard macOS install paths when the login shell lookup fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('timed out'))
    const executable = vi.fn(async (candidate: string) => candidate === '/Users/me/.local/bin/codex')
    const locator = new CliLocator(runnerWith(run), executable, {
      platform: 'darwin',
      environment: { SHELL: '/missing/fish', HOME: '/Users/me' }
    })

    await expect(locator.resolveAgent('codex')).resolves.toBe('/Users/me/.local/bin/codex')
    expect(run).not.toHaveBeenCalled()
    expect(executable.mock.calls.map(([candidate]) => candidate)).toEqual([
      '/missing/fish',
      '/bin/zsh',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      '/Users/me/.local/bin/codex'
    ])
  })

  it('falls back to zsh when SHELL is invalid and exposes it for native Shell sessions', async () => {
    const executable = vi.fn(async (candidate: string) => candidate === '/bin/zsh')
    const locator = new CliLocator(runnerWith(vi.fn()), executable, {
      platform: 'darwin',
      environment: { SHELL: 'relative-shell', HOME: '/Users/me' }
    })

    await expect(locator.resolveShell()).resolves.toBe('/bin/zsh')
  })

  it('does not expose Windows PowerShell on macOS', async () => {
    const run = vi.fn()
    const locator = new CliLocator(runnerWith(run), async () => true, { platform: 'darwin' })

    await expect(locator.resolvePowerShell()).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })
})
