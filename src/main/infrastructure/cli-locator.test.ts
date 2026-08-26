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

  it('rejects unsafe command names before invoking where.exe', async () => {
    const run = vi.fn()
    const locator = new CliLocator(runnerWith(run), async () => true)

    await expect(locator.resolve('tool & injected')).rejects.toThrow('Invalid command name')
    expect(run).not.toHaveBeenCalled()
  })
})
