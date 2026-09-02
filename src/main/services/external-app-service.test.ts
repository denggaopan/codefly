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

const locatorWith = (resolved: string | undefined): CliLocator => ({ resolve: vi.fn(async () => resolved) }) as unknown as CliLocator

describe('ExternalAppService', () => {
  it('prefers the code command and does not check standard locations after it resolves', async () => {
    const command = 'C:\\bin\\Code.exe'
    const pathExists = vi.fn(async (candidate: string) => candidate === command)
    const service = new ExternalAppService(locatorFor(command), pathExists, vi.fn(), vi.fn(), {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files'
    })

    await expect(service.capabilities()).resolves.toEqual({ vscode: { available: true, detail: command } })
    expect(pathExists.mock.calls).toEqual([[command]])
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

  it('derives and launches Code.exe from a bin\\code locator result', async () => {
    const shim = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code'
    const nativeExecutable = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const pathExists = vi.fn(async (candidate: string) => candidate === nativeExecutable || candidate === 'C:\\Projects\\One')
    const spawnDetached = vi.fn(async () => undefined)
    const service = new ExternalAppService(locatorWith(shim), pathExists, spawnDetached, vi.fn(), {})

    await expect(service.capabilities()).resolves.toEqual({ vscode: { available: true, detail: nativeExecutable } })
    await service.openInVSCode(project('C:\\Projects\\One'))
    expect(spawnDetached).toHaveBeenCalledWith(nativeExecutable, ['C:\\Projects\\One'])
    expect(spawnDetached).not.toHaveBeenCalledWith(shim, expect.anything())
  })

  it.each([
    'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
    '"C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd"'
  ])('derives Code.exe rather than launching a %s shim', async (shim) => {
    const nativeExecutable = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const spawnDetached = vi.fn(async () => undefined)
    const service = new ExternalAppService(locatorWith(shim), vi.fn(async (candidate: string) => candidate === nativeExecutable || candidate === 'C:\\Projects\\One'), spawnDetached, vi.fn(), {})

    await expect(service.capabilities()).resolves.toEqual({ vscode: { available: true, detail: nativeExecutable } })
    await service.openInVSCode(project('C:\\Projects\\One'))
    expect(spawnDetached).toHaveBeenCalledWith(nativeExecutable, ['C:\\Projects\\One'])
  })

  it('falls through from a missing derived executable to standard install paths', async () => {
    const derived = 'C:\\Tools\\VS Code\\Code.exe'
    const localInstall = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const machineInstall = 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
    const pathExists = vi.fn(async (candidate: string) => candidate === machineInstall)
    const service = new ExternalAppService(locatorWith('C:\\Tools\\VS Code\\bin\\code.cmd'), pathExists, vi.fn(), vi.fn(), {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files'
    })

    await expect(service.capabilities()).resolves.toEqual({ vscode: { available: true, detail: machineInstall } })
    expect(pathExists.mock.calls).toEqual([[derived], [localInstall], [machineInstall]])
  })

  it('accepts an existing direct .exe locator result but ignores unrelated non-executable candidates', async () => {
    const executable = 'C:\\Tools\\Code.exe'
    const directExists = vi.fn(async (candidate: string) => candidate === executable)
    const directService = new ExternalAppService(locatorWith(executable), directExists, vi.fn(), vi.fn(), {})
    await expect(directService.capabilities()).resolves.toEqual({ vscode: { available: true, detail: executable } })
    expect(directExists).toHaveBeenCalledWith(executable)

    const localInstall = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const unrelatedService = new ExternalAppService(locatorWith('C:\\Tools\\editor'), vi.fn(async (candidate: string) => candidate === localInstall), vi.fn(), vi.fn(), {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
    })
    await expect(unrelatedService.capabilities()).resolves.toEqual({ vscode: { available: true, detail: localInstall } })
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

  it('falls back to a ComSpec start chain when the direct VS Code spawn is denied, quoting the launcher and project', async () => {
    const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    const spawnDetached = vi.fn().mockRejectedValueOnce(denied).mockResolvedValueOnce(undefined)
    const service = new ExternalAppService(
      locatorFor('C:\\VS Code\\Code.exe'),
      vi.fn(async () => true),
      spawnDetached,
      vi.fn(),
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    )

    await service.openInVSCode(project('C:\\Projects\\My App\\中文'))

    expect(spawnDetached).toHaveBeenNthCalledWith(1, 'C:\\VS Code\\Code.exe', ['C:\\Projects\\My App\\中文'])
    expect(spawnDetached).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"start "" "C:\\VS Code\\Code.exe" "C:\\Projects\\My App\\中文""'],
      { windowsVerbatimArguments: true }
    )
  })

  it('throws with the original direct-spawn cause when the start-chain fallback also fails', async () => {
    const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    const spawnDetached = vi.fn().mockRejectedValue(denied)
    const service = new ExternalAppService(
      locatorFor('C:\\VS Code\\Code.exe'),
      vi.fn(async () => true),
      spawnDetached,
      vi.fn(),
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    )

    await expect(service.openInVSCode(project('C:\\Projects\\One'))).rejects.toMatchObject({
      app: 'vscode',
      target: 'C:\\Projects\\One',
      cause: denied
    } satisfies Partial<ExternalAppLaunchError>)
    expect(spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('wraps VS Code spawn failures with the project target, launcher path, and cause message', async () => {
    const failure = new Error('EACCES: permission denied')
    const service = new ExternalAppService(locatorFor('C:\\VS Code\\Code.exe'), vi.fn(async () => true), vi.fn().mockRejectedValue(failure), vi.fn(), {})

    const rejection = expect(service.openInVSCode(project('C:\\Projects\\One'))).rejects
    await rejection.toMatchObject({
      app: 'vscode', target: 'C:\\Projects\\One', cause: failure
    } satisfies Partial<ExternalAppLaunchError>)
    // The IPC boundary serializes only `message`, so the message itself must carry the
    // launcher executable and the underlying cause for the renderer notice to be actionable.
    await rejection.toThrow('C:\\Projects\\One')
    await rejection.toThrow('C:\\VS Code\\Code.exe')
    await rejection.toThrow('EACCES: permission denied')
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

describe('ExternalAppService.openRepository', () => {
  const remoteProject = (webUrl: string): ProjectRecord => ({
    ...project('C:\\Projects\\One'),
    repoRemote: { host: 'github', webUrl }
  })
  const serviceWith = (openExternal: (url: string) => Promise<void>) =>
    new ExternalAppService(locatorFor(undefined), vi.fn(async () => true), vi.fn(), vi.fn(), {}, openExternal)

  it('opens the recorded remote page in the default browser', async () => {
    const openExternal = vi.fn(async () => {})

    await expect(serviceWith(openExternal).openRepository(remoteProject('https://github.com/me/app'))).resolves.toBeUndefined()
    expect(openExternal).toHaveBeenCalledWith('https://github.com/me/app')
  })

  it('rejects a project without a remote before touching the browser', async () => {
    const openExternal = vi.fn(async () => {})

    await expect(serviceWith(openExternal).openRepository(project('C:\\Projects\\One'))).rejects.toMatchObject({
      app: 'browser',
      target: 'C:\\Projects\\One'
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it.each([['file:///C:/repos/app'], ['javascript:alert(1)'], ['ftp://example.com/repo']])(
    'refuses to hand a persisted non-http(s) remote %s to the browser',
    async (webUrl) => {
      const openExternal = vi.fn(async () => {})

      await expect(serviceWith(openExternal).openRepository(remoteProject(webUrl))).rejects.toBeInstanceOf(ExternalAppLaunchError)
      expect(openExternal).not.toHaveBeenCalled()
    }
  )

  it('wraps browser failures as typed launch errors that name the URL and the cause', async () => {
    const failure = new Error('No default browser')
    const rejection = expect(serviceWith(vi.fn().mockRejectedValue(failure)).openRepository(remoteProject('https://github.com/me/app'))).rejects

    await rejection.toMatchObject({ app: 'browser', target: 'https://github.com/me/app', cause: failure })
    await rejection.toThrow('No default browser')
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

  it('cleans up the opposite listener so duplicate process events cannot settle twice', async () => {
    const child = new EventEmitter()
    const unref = vi.fn()
    ;(child as EventEmitter & { unref: () => void }).unref = unref
    child.on('error', () => undefined)
    const launch = createSpawnDetached(vi.fn(() => child as unknown as SpawnedProcess))

    const pending = launch('Code.exe', ['C:\\Projects\\One'])
    child.emit('spawn')
    child.emit('error', new Error('late error'))
    await expect(pending).resolves.toBeUndefined()
    expect(child.listenerCount('error')).toBe(1)
    expect(unref).toHaveBeenCalledOnce()
  })

  it('rejects if unref or the synchronous spawner throws', async () => {
    const child = new EventEmitter()
    const unrefFailure = new Error('unref failed')
    ;(child as EventEmitter & { unref: () => void }).unref = () => { throw unrefFailure }
    const unrefLaunch = createSpawnDetached(vi.fn(() => child as unknown as SpawnedProcess))
    const unrefPending = unrefLaunch('Code.exe', ['C:\\Projects\\One'])
    child.emit('spawn')
    await expect(unrefPending).rejects.toBe(unrefFailure)

    const spawnFailure = new Error('spawn threw')
    const throwingLaunch = createSpawnDetached(vi.fn(() => { throw spawnFailure }))
    await expect(throwingLaunch('Code.exe', ['C:\\Projects\\One'])).rejects.toBe(spawnFailure)
  })
})
