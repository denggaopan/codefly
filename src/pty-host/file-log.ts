import { appendFileSync } from 'node:fs'

export type AppendLine = (filePath: string, line: string) => void

const defaultAppendLine: AppendLine = (filePath, line) => {
  appendFileSync(filePath, line, 'utf8')
}

/**
 * The host's only diagnostic channel. It is spawned detached with `stdio: 'ignore'`, so a
 * console line goes nowhere and a crash leaves no trace unless it was written to this file.
 *
 * Synchronous appends are the point rather than an oversight: the lines worth having are the
 * ones written immediately before the process exits (a lost single-instance race, a retire,
 * an uncaught exception), and an async write would still be queued when the process is gone.
 * Only lifecycle lines are logged — never PTY output — so the file stays small enough that
 * appending forever is not a problem.
 */
export const createFileLogger = (
  filePath: string | undefined,
  appendLine: AppendLine = defaultAppendLine,
  now: () => Date = () => new Date(),
  pid: number = process.pid
): ((message: string) => void) => {
  if (filePath === undefined || filePath.length === 0) return () => {}
  return (message) => {
    try {
      appendLine(filePath, `${now().toISOString()} [${pid}] ${message}\n`)
    } catch {
      // Losing a log line must never be worse than the problem being logged: an unwritable
      // path (a removed userData directory, a full disk) has to leave the PTYs running.
    }
  }
}
