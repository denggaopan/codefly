import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { win32 as path } from 'node:path'

import { shell } from 'electron'

import type { CapabilityState, ProjectRecord } from '../../shared/contracts'
import { cliLocator, type CliLocator } from '../infrastructure/cli-locator'

type ExternalApp = 'vscode' | 'explorer'

export class ExternalAppUnavailableError extends Error {
  readonly app: ExternalApp

  constructor(app: ExternalApp) {
    super(app === 'vscode' ? 'Visual Studio Code is not available.' : 'Windows File Explorer is not available.')
    this.name = 'ExternalAppUnavailableError'
    this.app = app
  }
}

export class ExternalAppLaunchError extends Error {
  readonly app: ExternalApp
  readonly target: string

  // The renderer receives only `message` across the IPC boundary (Error `cause` is not
  // serialized by ipcRenderer.invoke), so everything a user needs to act on — the target,
  // the launcher executable, and the underlying failure — must be part of the message.
  constructor(app: ExternalApp, target: string, cause?: unknown, launcher?: string) {
    const appName = app === 'vscode' ? 'Visual Studio Code' : 'Windows File Explorer'
    const launcherText = launcher ? ` (launcher: ${launcher})` : ''
    const causeMessage = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : ''
    const causeText = causeMessage ? `: ${causeMessage}` : '.'
    super(`Could not open ${target} in ${appName}${launcherText}${causeText}`)
    this.name = 'ExternalAppLaunchError'
    this.app = app
    this.target = target
    if (cause !== undefined) this.cause = cause
  }
}

export type SpawnDetached = (file: string, args: readonly string[]) => Promise<void>
export type OpenPath = (path: string) => Promise<string>
export type PathExists = (path: string) => Promise<boolean>

export type SpawnedProcess = {
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'spawn', listener: () => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  unref(): void
}

export type ProcessSpawner = (
  file: string,
  args: readonly string[],
  options: { detached: true; stdio: 'ignore'; windowsHide: true; shell: false }
) => SpawnedProcess

const defaultPathExists: PathExists = async (candidate) => {
  try {
    await access(candidate, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const defaultOpenPath: OpenPath = (candidate) => shell.openPath(candidate)

export const createSpawnDetached = (processSpawner: ProcessSpawner = spawn): SpawnDetached =>
  (file, args) => new Promise<void>((resolve, reject) => {
    try {
      const child = processSpawner(file, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      })
      let settled = false
      const cleanup = (): void => {
        child.removeListener('spawn', onSpawn)
        child.removeListener('error', onError)
      }
      const onSpawn = (): void => {
        if (settled) return
        settled = true
        cleanup()
        try {
          child.unref()
          resolve()
        } catch (error) {
          reject(error)
        }
      }
      const onError = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    } catch (error) {
      reject(error)
    }
  })

const defaultSpawnDetached = createSpawnDetached()

export class ExternalAppService {
  constructor(
    private readonly locator: CliLocator = cliLocator,
    private readonly pathExists: PathExists = defaultPathExists,
    private readonly spawnDetached: SpawnDetached = defaultSpawnDetached,
    private readonly openPath: OpenPath = defaultOpenPath,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  async capabilities(): Promise<Pick<CapabilityState, 'vscode'>> {
    const executable = await this.findVSCode()
    return executable
      ? { vscode: { available: true, detail: executable } }
      : { vscode: { available: false, detail: 'Install Visual Studio Code or enable the code command.' } }
  }

  async openInVSCode(project: ProjectRecord): Promise<void> {
    await this.ensureProjectPath(project, 'vscode')
    const executable = await this.findVSCode()
    if (!executable) throw new ExternalAppUnavailableError('vscode')

    try {
      await this.spawnDetached(executable, [project.path])
    } catch (cause) {
      throw new ExternalAppLaunchError('vscode', project.path, cause, executable)
    }
  }

  async openInExplorer(project: ProjectRecord): Promise<void> {
    await this.ensureProjectPath(project, 'explorer')
    try {
      const result = await this.openPath(project.path)
      if (result.length > 0) throw new Error(result)
    } catch (cause) {
      throw new ExternalAppLaunchError('explorer', project.path, cause)
    }
  }

  private async findVSCode(): Promise<string | undefined> {
    const command = await this.locator.resolve('code')
    const commandExecutable = command ? await this.nativeVSCodeExecutable(command) : undefined
    if (commandExecutable) return commandExecutable

    const localAppData = this.environment.LOCALAPPDATA
    if (localAppData) {
      const userInstall = path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe')
      if (await this.pathExists(userInstall)) return userInstall
    }

    const programFiles = this.environment.ProgramFiles
    if (programFiles) {
      const machineInstall = path.join(programFiles, 'Microsoft VS Code', 'Code.exe')
      if (await this.pathExists(machineInstall)) return machineInstall
    }
    return undefined
  }

  private async nativeVSCodeExecutable(candidate: string): Promise<string | undefined> {
    const unquoted = candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')
      ? candidate.slice(1, -1)
      : candidate
    if (unquoted.toLowerCase().endsWith('.exe')) {
      return (await this.pathExists(unquoted)) ? unquoted : undefined
    }

    const fileName = path.basename(unquoted).toLowerCase()
    const parentName = path.basename(path.dirname(unquoted)).toLowerCase()
    if (parentName !== 'bin' || (fileName !== 'code' && fileName !== 'code.cmd')) return undefined

    const executable = path.resolve(path.dirname(unquoted), '..', 'Code.exe')
    return (await this.pathExists(executable)) ? executable : undefined
  }

  private async ensureProjectPath(project: ProjectRecord, app: ExternalApp): Promise<void> {
    if (!(await this.pathExists(project.path))) {
      throw new ExternalAppLaunchError(app, project.path, new Error('The project folder no longer exists.'))
    }
  }
}
