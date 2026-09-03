import { describe, expect, it } from 'vitest'

import { AGENT_KINDS, agentLaunchArgs, agentLaunchEnv, AGENT_LAUNCH, isAgentKind } from './agent-kinds'
import { sessionKindSchema } from './contracts'

describe('agent kind registry', () => {
  it('lists every agent kind once, with Claude and Codex first', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex', 'gemini', 'copilot', 'cursor', 'comate', 'qwen'])
    expect(new Set(AGENT_KINDS).size).toBe(AGENT_KINDS.length)
  })

  // The registry drives launcher entries, Settings switches and PTY argv alike, so a kind
  // missing from the shared schema would be offered in the UI and rejected at the IPC edge.
  it('keeps every registered agent kind a valid session kind', () => {
    for (const kind of AGENT_KINDS) {
      expect(sessionKindSchema.safeParse(kind).success).toBe(true)
    }
  })

  it('separates agent kinds from the native shells', () => {
    for (const kind of AGENT_KINDS) {
      expect(isAgentKind(kind)).toBe(true)
    }
    for (const kind of ['shell', 'powershell', 'cmd'] as const) {
      expect(isAgentKind(kind)).toBe(false)
    }
  })

  // Two vendors ship a binary whose name is not the kind: Cursor's terminal agent is
  // `agent`, and "comate" finds nothing at all.
  it('maps each kind to the executable its vendor actually installs', () => {
    expect(Object.fromEntries(AGENT_KINDS.map((kind) => [kind, AGENT_LAUNCH[kind].command]))).toEqual({
      claude: 'claude',
      codex: 'codex',
      gemini: 'gemini',
      copilot: 'copilot',
      cursor: 'agent',
      comate: 'comatecli',
      qwen: 'qwen'
    })
  })

  it('carries each agent CLI its own fixed bypass argv on a fresh session', () => {
    expect(Object.fromEntries(AGENT_KINDS.map((kind) => [kind, agentLaunchArgs(kind, false)]))).toEqual({
      claude: ['--dangerously-skip-permissions'],
      codex: ['--dangerously-bypass-approvals-and-sandbox'],
      gemini: ['--approval-mode=yolo'],
      copilot: ['--allow-all-tools'],
      cursor: ['--force'],
      comate: [],
      qwen: ['--approval-mode=yolo']
    })
  })

  // Codex is the one CLI whose resume is a subcommand rather than a flag, so it has to lead
  // the argv; every other kind appends its flag after the bypass argv.
  it('reattaches the previous conversation with each CLI own resume syntax', () => {
    expect(Object.fromEntries(AGENT_KINDS.map((kind) => [kind, agentLaunchArgs(kind, true)]))).toEqual({
      claude: ['--dangerously-skip-permissions', '--continue'],
      codex: ['resume', '--last', '--dangerously-bypass-approvals-and-sandbox'],
      gemini: ['--approval-mode=yolo', '--resume', 'latest'],
      copilot: ['--allow-all-tools', '--continue'],
      cursor: ['--force', '--resume'],
      comate: ['--resume'],
      qwen: ['--approval-mode=yolo', '--continue']
    })
  })

  // Comate is the only CLI with no bypass flag: its terminal run mode defaults to "manual"
  // and is overridden by environment, so the bypass has to travel outside argv.
  it('expresses a bypass that has no flag as launch environment instead', () => {
    expect(agentLaunchEnv('comate')).toEqual({ ZULU_TERMINAL_RUN_MODE: 'yolo' })
    for (const kind of AGENT_KINDS.filter((candidate) => candidate !== 'comate')) {
      expect(agentLaunchEnv(kind)).toEqual({})
    }
  })
})
