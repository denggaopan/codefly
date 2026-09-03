import type { SessionKind } from './contracts'

/**
 * Every coding-agent CLI CodeFly can host, in the order they are offered in the UI. Claude
 * and Codex lead because they were the original two and are the ones enabled by default;
 * the rest are opt-in (see the renderer's `defaultSessionKindPreferences`).
 *
 * This list is the single source of truth for "is this session an agent rather than a
 * shell", a question asked in six different places — PTY argv, capability probing, title
 * generation, the bypass badge, the Shift+Enter/Ctrl+V key bindings and the idle "Done"
 * status. Before this registry each of those spelled out `kind === 'claude' || kind ===
 * 'codex'`, so adding a CLI meant finding all six.
 */
export const AGENT_KINDS = ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'comate', 'qwen'] as const

export type AgentKind = (typeof AGENT_KINDS)[number]

export type AgentLaunchSpec = {
  /**
   * The executable to look up on PATH. Usually the kind itself, but two vendors ship a
   * binary under another name and guessing wrong finds the wrong program: `cursor` is the
   * editor launcher, and `comate` is not installed at all.
   */
  command: string
  /**
   * The CLI's fixed permission/sandbox bypass argv, carried by every interactive session
   * (see README — this build has no switch to turn it off). Empty when the CLI expresses
   * the same thing through the environment instead; see `bypassEnv`.
   */
  bypassArgs: readonly string[]
  /**
   * A bypass that is not an argv flag. Comate's TUI resets its run mode to
   * `process.env.ZULU_TERMINAL_RUN_MODE || 'manual'` on every launch, so full auto-execution
   * can only be requested through the environment — and passing an invented `--yolo` flag
   * would be silently ignored at best.
   */
  bypassEnv?: Readonly<Record<string, string>>
  /** Argv appended after the bypass argv to reattach the previous conversation. */
  resumeArgs: readonly string[]
  /**
   * A resume expressed as a leading subcommand rather than a flag, which therefore has to
   * precede the bypass argv. Codex is the only CLI shaped this way.
   */
  resumeSubcommand?: readonly string[]
}

/**
 * How each agent CLI is started.
 *
 * Verified against the installed binaries for Gemini, GitHub Copilot, Comate and Qwen Code
 * (their `--help` output, or the shipped argv parser where there is no useful help). Cursor
 * was not installed and comes from its vendor's published flag reference.
 */
export const AGENT_LAUNCH: Readonly<Record<AgentKind, AgentLaunchSpec>> = {
  claude: {
    command: 'claude',
    bypassArgs: ['--dangerously-skip-permissions'],
    // Continues the newest conversation recorded for the launch directory.
    resumeArgs: ['--continue']
  },
  codex: {
    command: 'codex',
    bypassArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    resumeArgs: [],
    // Codex exposes resume only as a subcommand, which reopens its most recent session.
    resumeSubcommand: ['resume', '--last']
  },
  gemini: {
    command: 'gemini',
    // `--yolo` is deprecated in favour of the unified approval-mode flag.
    bypassArgs: ['--approval-mode=yolo'],
    resumeArgs: ['--resume', 'latest']
  },
  copilot: {
    command: 'copilot',
    bypassArgs: ['--allow-all-tools'],
    // `--continue` resumes the most recent session; bare `--resume` opens an interactive
    // picker, which is not what click-to-restore means.
    resumeArgs: ['--continue']
  },
  cursor: {
    command: 'cursor-agent',
    bypassArgs: ['--force'],
    resumeArgs: ['--resume']
  },
  comate: {
    command: 'comatecli',
    bypassArgs: [],
    bypassEnv: { ZULU_TERMINAL_RUN_MODE: 'yolo' },
    // Not implemented by comatecli 1.0.8: its argv parser knows only -h/-l/-m/-t/-v, and a
    // bare `comatecli --resume` opens a fresh TUI instead of failing. Carried anyway so the
    // flag starts working the moment the CLI grows it, at no cost until then.
    resumeArgs: ['--resume']
  },
  qwen: {
    command: 'qwen',
    // Documented by Qwen Code, but NOT implemented by every build: 0.22.3's argv parser knows
    // no approval flag at all and ignores this one without erroring (verified: exit 0, the CLI
    // still starts). There is nothing better to send — that build takes its approval mode from
    // ~/.qwen/settings.json or interactively, and CodeFly has no business writing a user's
    // settings file. Keeping the flag means it starts working the moment the CLI supports it,
    // and until then the bypass badge over-warns rather than under-warns.
    bypassArgs: ['--approval-mode=yolo'],
    // Real in 0.22.3: "Resume the most recent session for the current project". Its `--resume`
    // wants a session id (or opens a picker), which is not what click-to-restore means.
    resumeArgs: ['--continue']
  }
}

export const isAgentKind = (kind: SessionKind): kind is AgentKind =>
  (AGENT_KINDS as readonly string[]).includes(kind)

/**
 * The complete argv for an interactive agent session. `resume` relaunches the CLI so it
 * reattaches its previous conversation instead of starting a new one, which each vendor
 * spells differently — a trailing flag for most, a leading subcommand for Codex.
 */
export const agentLaunchArgs = (kind: AgentKind, resume: boolean): readonly string[] => {
  const spec = AGENT_LAUNCH[kind]
  if (!resume) return spec.bypassArgs
  return [...(spec.resumeSubcommand ?? []), ...spec.bypassArgs, ...spec.resumeArgs]
}

/**
 * Extra environment for an interactive agent session, merged over the inherited environment
 * when the PTY spawns. Empty for every CLI whose bypass is an argv flag.
 *
 * Only interactive sessions get this: the title-generation process must never run with a
 * bypass (see TitleService), and it spawns from CodeFly's own environment, which never
 * carries these variables.
 */
export const agentLaunchEnv = (kind: AgentKind): Readonly<Record<string, string>> =>
  AGENT_LAUNCH[kind].bypassEnv ?? {}
