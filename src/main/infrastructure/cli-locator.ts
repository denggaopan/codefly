import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

import { commandRunner } from './command-runner'
import type { CommandRunner } from './command-runner'

const safeName = /^[A-Za-z0-9._-]+$/

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const removeSurroundingQuotes = (candidate: string): string =>
  candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"') ? candidate.slice(1, -1) : candidate

export class CliLocator {
  constructor(
    private readonly runner: CommandRunner = commandRunner,
    private readonly candidateExists: (candidate: string) => Promise<boolean> = pathExists
  ) {}

  async resolve(name: string): Promise<string | undefined> {
    if (!safeName.test(name)) throw new Error(`Invalid command name: ${name}`)

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

  async resolvePowerShell(): Promise<string | undefined> {
    return (await this.resolve('pwsh.exe')) ?? this.resolve('powershell.exe')
  }

  resolveAgent(agent: 'claude' | 'codex'): Promise<string | undefined> {
    return this.resolve(agent)
  }
}

export const cliLocator = new CliLocator()
