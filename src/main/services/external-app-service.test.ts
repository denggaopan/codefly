import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type { ProjectRecord } from '../../shared/contracts'
import { CliLocator } from '../infrastructure/cli-locator'
import {
  createSpawnDetached,
  ExternalAppLaunchError,
  ExternalAppService,
  ExternalAppUnavailableError,
  type SpawnedProcess
} from './external-app-service'

const project = (path: string): ProjectRecord => ({
  id: 'project-1',
  name: 'Example',
  path,
  createdAt: '2026-08-26T00:00:00.000Z'
})

const locatorFor = (resolved: string | undefined): CliLocator =>
  new CliLocator({ run: vi.fn().mockResolvedValue({ stdout: resolved ? `${resolved}\r\n` : '', stderr: '', exitCode: 0 }) }, async () => Boolean(resolved))

describe('ExternalAppService', () => {
  it('prefers the code command and does not check standard locations after it resolves', async () => {
    const pathExists = vi.fn(async () => true)
    const service = new ExternalAppService(locatorFor('C:\\bin\\code.cmd'), pathExists, vi.fn(), vi.fn(), {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files'
    })

    await expect(service.capabilities()).resolves.toEqual({ vscode: { available: true, detail: 'C:\\bin\\code.cmd' } })
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('checks the user install before the machine install, then uses the machine fallback', async () => {
    const userCode = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const machineCode = 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
    const pathExists = vi.fn(async (candidate: string) => candidate === machineCode)
    const service = new ExternalAppService(locatorFor(undefined), pathExists, vi.fn(), vi.fn(), {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files'
    })

    await expect(service.capabilities()).resolves.toEqual({ vscode: { available: true, detail: machineCode } })
    expect(pathExists.mock.calls).toEqual([[userCode], [machineCode]])
  })

  it('reports actionable unavailability when VS Code cannot be found', async () => {
    const service = new ExternalAppService(locatorFor(undefined), vi.fn(async () => false), vi.fn(), vi.fn(), {})

    await expect(service.capabilities()).resolves.toEqual({
      vscode: { available: false, detail: 'Install Visual Studio Code or enable the code command.' }
    })
  })

  it('opens the original spaced and Chinese project path as one VS Code argument', async () => {
    const spawnDetached = vi.fn(async () => undefined)
    const source = project('C:\\Projects\\My App\\中文')
    const service = new ExternalAppService(locatorFor('C:\\VS Code\\Code.exe'), vi.fn(async () => true), spawnDetached, vi.fn(), {})

    await service.openInVSCode(source)
    expect(spawnDetached).toHaveBeenCalledWith('C:\\VS Code\\Code.exe', [source.path])
  })

  it('throws a typed unavailable error without spawning when VS Code is missing', async () => {
    const spawnDetached = vi.fn()
    const service = new ExternalAppService(locatorFor(undefined), vi.fn(async () => true), spawnDetached, vi.fn(), {})

    await expect(service.openInVSCode(project('C:\\Projects\\One'))).rejects.toMatchObject({ app: 'vscode' } satisfies Partial<ExternalAppUnavailableError>)
    expect(spawnDetached).not.toHaveBeenCalled()
  })

  it('rejects a missing project directory before VS Code discovery or launch', async () => {
    const spawnDetached = vi.fn()
    const service = new ExternalAppService(locatorFor('C:\\VS Code\\Code.exe'), vi.fn(async () => false), spawnDetached, vi.fn(), {})

    await expect(service.openInVSCode(project('C:\\missing'))).rejects.toMatchObject({ app: 'vscode', target: 'C:\\missing' } satisfies Partial<ExternalAppLaunchError>)
    expect(spawnDetached).not.toHaveBeenCalled()
  })

  it('wraps VS Code spawn failures with the executable target and cause', async () => {
    const failure = new Error('spawn failed')
    const service = new ExternalAppService(locatorFor('C:\\VS Code\\Code.exe'), vi.fn(async () => true), vi.fn().mockRejectedValue(failure), vi.fn(), {})

    await expect(service.openInVSCode(project('C:\\Projects\\One'))).rejects.toMatchObject({
      app: 'vscode', target: 'C:\\VS Code\\Code.exe', cause: failure
    } satisfies Partial<ExternalAppLaunchError>)
  })

  it('opens Explorer with the exact original path when Electron returns an empty result', async () => {
    const openPath = vi.fn(async () => '')
    const source = project('C:\\Projects\\My App\\中文')
    const service = new ExternalAppService(locatorFor(undefined), vi.fn(async () => true), vi.fn(), openPath, {})

    await expect(service.openInExplorer(source)).resolves.toBeUndefined()
    expect(openPath).toHaveBeenCalledWith(source.path)
  })

  it('wraps Explorer result errors and thrown errors as typed launch errors', async () => {
    const source = project('C:\\Projects\\One')
    const resultService = new ExternalAppService(locatorFor(undefined), vi.fn(async () => true), vi.fn(), vi.fn(async () => 'Access denied'), {})
    await expect(resultService.openInExplorer(source)).rejects.toMatchObject({ app: 'explorer', target: source.path })

    const failure = new Error('Electron unavailable')
    const thrownService = new ExternalAppService(locatorFor(undefined), vi.fn(async () => true), vi.fn(), vi.fn().mockRejectedValue(failure), {})
    await expect(thrownService.openInExplorer(source)).rejects.toMatchObject({ app: 'explorer', target: source.path, cause: failure })
  })

  it('does not call Explorer for a missing project path and does not depend on VS Code', async () => {
    const openPath = vi.fn(async () => '')
    const missingService = new ExternalAppService(locatorFor(undefined), vi.fn(async () => false), vi.fn(), openPath, {})
    await expect(missingService.openInExplorer(project('C:\\missing'))).rejects.toMatchObject({ app: 'explorer', target: 'C:\\missing' })
    expect(openPath).not.toHaveBeenCalled()

    const availableService = new ExternalAppService(locatorFor(undefined), vi.fn(async () => true), vi.fn(), openPath, {})
    await expect(availableService.openInExplorer(project('C:\\Projects\\One'))).resolves.toBeUndefined()
  })
})

describe('createSpawnDetached', () => {
  it('uses a shell-free detached hidden process and unrefs only after spawn', async () => {
    const child = new EventEmitter()
    const unref = vi.fn()
    ;(child as EventEmitter & { unref: () => void }).unref = unref
    const spawn = vi.fn(() => child as unknown as SpawnedProcess)
    const launch = createSpawnDetached(spawn)

    const pending = launch('C:\\VS Code\\Code.exe', ['C:\\Projects\\One'])
    expect(spawn).toHaveBeenCalledWith('C:\\VS Code\\Code.exe', ['C:\\Projects\\One'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    })
    expect(unref).not.toHaveBeenCalled()
    child.emit('spawn')
    await expect(pending).resolves.toBeUndefined()
    expect(unref).toHaveBeenCalledOnce()
  })

  it('rejects when process creation emits an error and does not unref', async () => {
    const child = new EventEmitter()
    const unref = vi.fn()
    ;(child as EventEmitter & { unref: () => void }).unref = unref
    const launch = createSpawnDetached(vi.fn(() => child as unknown as SpawnedProcess))
    const failure = new Error('launch error')

    const pending = launch('Code.exe', ['C:\\Projects\\One'])
    child.emit('error', failure)
    await expect(pending).rejects.toBe(failure)
    expect(unref).not.toHaveBeenCalled()
  })
})
