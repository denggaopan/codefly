import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { posix as posixPath } from 'node:path'

import { AGENT_LAUNCH, type AgentKind } from '../../shared/agent-kinds'
import { commandRunner } from './command-runner'
import type { CommandRunner } from './command-runner'

const safeName = /^[A-Za-z0-9._-]+$/

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const removeSurroundingQuotes = (candidate: string): string =>
  candidate.length >= 2 &&
  ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'")))
    ? candidate.slice(1, -1)
    : candidate

export type CliLocatorOptions = {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  loginShellTimeoutMs?: number
}

const MACOS_LOGIN_SHELL_TIMEOUT_MS = 5_000

export class CliLocator {
  constructor(
    private readonly runner: CommandRunner = commandRunner,
    private readonly candidateExists: (candidate: string) => Promise<boolean> = pathExists,
    private readonly options: CliLocatorOptions = {}
  ) {}

  async resolve(name: string): Promise<string | undefined> {
    if (!safeName.test(name)) throw new Error(`Invalid command name: ${name}`)

    return (this.options.platform ?? process.platform) === 'darwin' ? this.resolveMacOS(name) : this.resolveWindows(name)
  }

  private async resolveWindows(name: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.runner.run('where.exe', [name])
      const candidates = stdout.split(/\r?\n/).filter((line) => line.length > 0).map(removeSurroundingQuotes)
      for (const candidate of candidates) {
        if (await this.candidateExists(candidate)) return candidate
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private async resolveMacOS(name: string): Promise<string | undefined> {
    const shell = await this.resolveShell()
    if (shell) {
      try {
        const { stdout } = await this.runner.run(
          shell,
          ['-lic', `command -v -- ${name}`],
          undefined,
          { timeoutMs: this.options.loginShellTimeoutMs ?? MACOS_LOGIN_SHELL_TIMEOUT_MS }
        )
        const candidates = stdout
          .split(/\r?\n/u)
          .map((line) => removeSurroundingQuotes(line.trim()))
          .filter((line) => posixPath.isAbsolute(line))
        for (const candidate of candidates) {
          if (await this.candidateExists(candidate)) return candidate
        }
      } catch {
        // Shell startup failures fall through to deterministic install locations.
      }
    }

    const home = this.options.environment?.HOME ?? process.env.HOME
    const directories = ['/opt/homebrew/bin', '/usr/local/bin', ...(home ? [posixPath.join(home, '.local', 'bin')] : [])]
    for (const directory of directories) {
      const candidate = posixPath.join(directory, name)
      if (await this.candidateExists(candidate)) return candidate
    }
    return undefined
  }

  async resolveShell(): Promise<string | undefined> {
    if ((this.options.platform ?? process.platform) !== 'darwin') return undefined

    const configured = this.options.environment?.SHELL ?? process.env.SHELL
    const candidates = [configured, '/bin/zsh'].filter(
      (candidate, index, all): candidate is string =>
        typeof candidate === 'string' && posixPath.isAbsolute(candidate) && all.indexOf(candidate) === index
    )
    for (const candidate of candidates) {
      if (await this.candidateExists(candidate)) return candidate
    }
    return undefined
  }

  async resolvePowerShell(): Promise<string | undefined> {
    if ((this.options.platform ?? process.platform) !== 'win32') return undefined
    return (await this.resolve('pwsh.exe')) ?? this.resolve('powershell.exe')
  }

  /**
   * Looks up an agent CLI by the executable its vendor actually installs, which is not
   * always the session kind: `cursor` would find the editor launcher and `comate` nothing.
   */
  resolveAgent(agent: AgentKind): Promise<string | undefined> {
    return this.resolve(AGENT_LAUNCH[agent].command)
  }
}

export const cliLocator = new CliLocator()
