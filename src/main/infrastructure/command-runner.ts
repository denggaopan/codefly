import { execFile } from 'node:child_process'

export type CommandResult = { stdout: string; stderr: string; exitCode: number }
export type CommandOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv }
export const COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024

export class CommandError extends Error {
  readonly file: string
  readonly args: readonly string[]
  readonly result: CommandResult
  readonly code?: string | number
  readonly signal?: string

  constructor(
    message: string,
    file: string,
    args: readonly string[],
    result: CommandResult,
    error: { code?: string | number; signal?: string | null }
  ) {
    super(message, { cause: error })
    this.name = 'CommandError'
    this.file = file
    this.args = args
    this.result = result
    this.code = error.code
    this.signal = error.signal ?? undefined
  }
}

export interface CommandRunner {
  run(file: string, args: readonly string[], cwd?: string, options?: CommandOptions): Promise<CommandResult>
}

const exitCodeFor = (error: { code?: number | string }): number =>
  typeof error.code === 'number' ? error.code : -1

export const commandRunner: CommandRunner = {
  run(file, args, cwd, options) {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          cwd,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: COMMAND_MAX_BUFFER_BYTES,
          ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
          ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs })
        },
        (error, stdout, stderr) => {
          const result = { stdout, stderr, exitCode: error ? exitCodeFor(error) : 0 }
          if (error) {
            reject(new CommandError(`Command failed: ${file}: ${error.message}`, file, args, result, error))
            return
          }
          resolve(result)
        }
      )
    })
  }
}
