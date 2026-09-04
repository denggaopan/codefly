import { cliLocator, type CliLocator } from '../main/infrastructure/cli-locator'
import { IDLE_EXIT_TIMEOUT_MS } from './idle-watchdog'

/**
 * The wiring of the pty-host entry point, kept in its own module only so it can be tested
 * without starting a host. It takes the environment as an argument and never reads
 * `process.env` itself — the entry does that, and nothing downstream of it is allowed to.
 */

export type HostLocator = Pick<CliLocator, 'resolveShell' | 'resolvePowerShell' | 'resolveAgent'>

export type HostComposition = {
  locator: HostLocator
  idleTimeoutMs: number
}

/**
 * Not part of `PTY_HOST_ENV`: that file is the wire contract shared with the main process,
 * while this switch exists so a test suite does not have to sit through a real idle timeout.
 */
export const IDLE_TIMEOUT_ENV = 'CODEFLY_PTY_HOST_IDLE_MS'

/**
 * Ignores anything that is not a positive whole number of milliseconds — a zero, a negative
 * or a typo would otherwise turn into a host that exits the moment it starts, taking the
 * sessions a real user is running with it.
 */
const parseIdleTimeout = (raw: string | undefined): number => {
  if (raw === undefined) return IDLE_EXIT_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : IDLE_EXIT_TIMEOUT_MS
}

/**
 * Replaces the agent *executable* with the suite's fixture and nothing else. The bypass argv
 * and bypass environment still come from `agentLaunchArgs()`/`agentLaunchEnv()` exactly as in
 * production — the E2E suite asserts the precise argv Claude and Codex receive, which only
 * means anything while the argv is produced by production code.
 */
const e2eLocator = (agentCommand: string, production: HostLocator): HostLocator => ({
  resolveShell: () => production.resolveShell(),
  resolvePowerShell: () => production.resolvePowerShell(),
  resolveAgent: async () => agentCommand
})

export const resolveHostComposition = (
  environment: NodeJS.ProcessEnv,
  production: HostLocator = cliLocator
): HostComposition => {
  const idleTimeoutMs = parseIdleTimeout(environment[IDLE_TIMEOUT_ENV])
  const agentCommand = environment.CODEFLY_E2E_AGENT_CMD
  if (environment.CODEFLY_E2E === '1' && agentCommand !== undefined && agentCommand.length > 0) {
    return { locator: e2eLocator(agentCommand, production), idleTimeoutMs }
  }
  return { locator: production, idleTimeoutMs }
}
