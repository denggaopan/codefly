import { execFile } from 'node:child_process'

export type CommandResult = { stdout: string; stderr: string; exitCode: number }

export class CommandError extends Error {
  readonly file: string
  readonly args: readonly string[]
  readonly result: CommandResult

  constructor(message: string, file: string, args: readonly string[], result: CommandResult) {
    super(message)
    this.name = 'CommandError'
    this.file = file
    this.args = args
    this.result = result
  }
}

export interface CommandRunner {
  run(file: string, args: readonly string[], cwd?: string): Promise<CommandResult>
}

const exitCodeFor = (error: { code?: number | string }): number =>
  typeof error.code === 'number' ? error.code : -1

export const commandRunner: CommandRunner = {
  run(file, args, cwd) {
    return new Promise((resolve, reject) => {
      execFile(file, [...args], { cwd, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
        const result = { stdout, stderr, exitCode: error ? exitCodeFor(error) : 0 }
        if (error) {
          reject(new CommandError(`Command failed: ${file}: ${error.message}`, file, args, result))
          return
        }
        resolve(result)
      })
    })
  }
}
