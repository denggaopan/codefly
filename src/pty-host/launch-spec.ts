import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { win32 as windowsPath } from 'node:path'

import { agentLaunchArgs, agentLaunchEnv } from '../shared/agent-kinds'
import type { SessionKind } from '../shared/contracts'
import { cliLocator, type CliLocator } from '../main/infrastructure/cli-locator'

/**
 * How a session kind turns into an executable plus argv, moved into the pty-host because the
 * host is what owns node-pty now. The wire protocol deliberately carries only a session kind
 * and a directory (see pty-protocol.ts), so this file — not the UI — decides what actually
 * runs, which keeps the "the renderer can never name a command line" rule intact across the
 * process split.
 *
 * The adapters below are behaviour-identical to the ones the main process used to run: the
 * E2E suite asserts the exact argv Claude and Codex receive, and the Windows shim chain is
 * the result of npm's several shapes of installed command.
 */

export type CandidateExists = (candidate: string) => Promise<boolean>

// `env` is the launch adapter's contribution to the PTY environment, used by the agent whose
// permission bypass is a variable rather than a flag (see agentLaunchEnv). Absent for shells.
export type LaunchSpec = { file: string; args: readonly string[] | string; env?: Readonly<Record<string, string>> }

type LaunchLocator = Pick<CliLocator, 'resolveShell' | 'resolvePowerShell' | 'resolveAgent'>

export const defaultCandidateExists: CandidateExists = async (candidate) => {
  try {
    await access(candidate, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A shim path is pasted verbatim into a `cmd.exe /c` command line, so anything cmd would
 * reinterpret there (`%` expansion, `!` delayed expansion, quote and redirection operators)
 * has to be refused rather than escaped — there is no escaping that survives cmd's two
 * parsing passes reliably.
 */
export const validateShimPath = (candidate: string): void => {
  if (/[%!"&|<>^\u0000-\u001F\u007F]/u.test(candidate)) {
    throw new Error('Resolved agent command shim contains unsafe characters.')
  }
}

/**
 * Runs an npm `.cmd`/`.bat` shim through ComSpec. The doubled quotes are cmd's documented
 * `/s` form: with `/s` the outer pair is stripped whole, which is the only way a shim path
 * containing spaces survives together with its arguments.
 */
export const hostedShimSpec = (
  shim: string,
  logicalArgs: readonly string[],
  environment: NodeJS.ProcessEnv
): LaunchSpec => {
  validateShimPath(shim)
  const command = `""${shim}" ${logicalArgs.join(' ')}"`
  return {
    file: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
    args: `/d /s /c ${command}`
  }
}

/**
 * Windows installs the same CLI in three shapes and only one of them can be handed to
 * CreateProcess directly, so the resolved path is classified rather than trusted: a real
 * executable runs as-is, a batch shim needs an interpreter, and `where.exe` sometimes hands
 * back an extensionless path whose real sibling has to be probed.
 */
export const windowsAgentSpec = async (
  resolved: string,
  logicalArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
  candidateExists: CandidateExists
): Promise<LaunchSpec> => {
  validateShimPath(resolved)
  const extension = windowsPath.extname(resolved).toLowerCase()
  if (extension === '.exe' || extension === '.com') return { file: resolved, args: logicalArgs }

  if (extension === '.cmd' || extension === '.bat') {
    // A sibling `.exe` is the same CLI without cmd.exe in the middle, so it is preferred:
    // one less process to signal when the session is killed.
    const executable = `${resolved.slice(0, -extension.length)}.exe`
    if (await candidateExists(executable)) return { file: executable, args: logicalArgs }
    return hostedShimSpec(resolved, logicalArgs, environment)
  }

  if (extension.length === 0) {
    const executable = `${resolved}.exe`
    if (await candidateExists(executable)) return { file: executable, args: logicalArgs }
    const commandShim = `${resolved}.cmd`
    if (await candidateExists(commandShim)) return hostedShimSpec(commandShim, logicalArgs, environment)
    const batchShim = `${resolved}.bat`
    if (await candidateExists(batchShim)) return hostedShimSpec(batchShim, logicalArgs, environment)
  }

  throw new Error('Resolved Windows agent command is not executable and has no trusted command shim.')
}

export class LaunchSpecResolver {
  constructor(
    private readonly locator: LaunchLocator = cliLocator,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly candidateExists: CandidateExists = defaultCandidateExists
  ) {}

  async resolveLaunchSpec(kind: SessionKind, resume: boolean): Promise<LaunchSpec> {
    if (kind === 'shell') {
      if (this.platform !== 'darwin') throw new Error('Shell is not supported on Windows.')
      const executable = await this.locator.resolveShell()
      if (!executable) throw new Error('Shell is not available.')
      return { file: executable, args: ['-l'] }
    }
    if (kind === 'powershell') {
      if (this.platform === 'darwin') throw new Error('PowerShell is not supported on macOS.')
      const executable = await this.locator.resolvePowerShell()
      if (!executable) throw new Error('PowerShell is not available.')
      return { file: executable, args: [] }
    }
    if (kind === 'cmd') {
      if (this.platform === 'darwin') throw new Error('Command Prompt is not supported on macOS.')
      return { file: this.environment.ComSpec ?? this.environment.COMSPEC ?? 'cmd.exe', args: [] }
    }

    // Every remaining kind is an agent, so the registry decides the executable, the argv and
    // any bypass that has to travel as environment instead of a flag.
    const resolved = await this.locator.resolveAgent(kind)
    if (!resolved) throw new Error(`${kind} is not available.`)
    const logicalArgs = agentLaunchArgs(kind, resume)
    const env = agentLaunchEnv(kind)
    const spec = this.platform === 'win32'
      ? await windowsAgentSpec(resolved, logicalArgs, this.environment, this.candidateExists)
      : { file: resolved, args: logicalArgs }
    return { ...spec, env }
  }
}
