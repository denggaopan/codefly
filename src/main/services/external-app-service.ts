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

  constructor(app: ExternalApp, target: string, cause?: unknown) {
    super(`Could not open ${target} in ${app === 'vscode' ? 'Visual Studio Code' : 'Windows File Explorer'}.`)
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
  once(event: 'spawn' | 'error', listener: (error?: Error) => void): unknown
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
    const child = processSpawner(file, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    })
    child.once('error', (error) => reject(error))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
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
      throw new ExternalAppLaunchError('vscode', executable, cause)
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
    if (command) return command

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

  private async ensureProjectPath(project: ProjectRecord, app: ExternalApp): Promise<void> {
    if (!(await this.pathExists(project.path))) throw new ExternalAppLaunchError(app, project.path)
  }
}
