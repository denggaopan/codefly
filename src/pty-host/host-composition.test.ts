import { describe, expect, it, vi } from 'vitest'

import { AGENT_KINDS, type AgentKind } from '../shared/agent-kinds'
import { IDLE_EXIT_TIMEOUT_MS } from './idle-watchdog'
import { IDLE_TIMEOUT_ENV, resolveHostComposition, type HostLocator } from './host-composition'
import { LaunchSpecResolver } from './launch-spec'

const productionLocator = (): HostLocator => ({
  resolveShell: vi.fn(async () => '/bin/zsh'),
  resolvePowerShell: vi.fn(async () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
  resolveAgent: vi.fn(async (agent: AgentKind) => `C:\\real\\${agent}.exe`)
})

const fixture = 'E:\\repo\\e2e\\fixtures\\fake-agent.cmd'

describe('resolveHostComposition without E2E switches', () => {
  it('keeps the production locator and the default idle timeout', async () => {
    const production = productionLocator()

    const { locator, idleTimeoutMs } = resolveHostComposition({}, production)

    expect(locator).toBe(production)
    expect(idleTimeoutMs).toBe(IDLE_EXIT_TIMEOUT_MS)
    await expect(locator.resolveAgent('claude')).resolves.toBe('C:\\real\\claude.exe')
  })

  it.each([
    [{ CODEFLY_E2E_AGENT_CMD: fixture }],
    [{ CODEFLY_E2E: '0', CODEFLY_E2E_AGENT_CMD: fixture }],
    [{ CODEFLY_E2E: 'true', CODEFLY_E2E_AGENT_CMD: fixture }],
    [{ CODEFLY_E2E: '1' }],
    [{ CODEFLY_E2E: '1', CODEFLY_E2E_AGENT_CMD: '' }]
  ])('refuses to substitute anything for %o', async (environment) => {
    const production = productionLocator()

    const { locator } = resolveHostComposition(environment, production)

    expect(locator).toBe(production)
    await expect(locator.resolveAgent('codex')).resolves.toBe('C:\\real\\codex.exe')
  })
})

describe('resolveHostComposition in E2E mode', () => {
  it('substitutes the fixture for every agent kind and leaves the shells alone', async () => {
    const production = productionLocator()

    const { locator } = resolveHostComposition(
      { CODEFLY_E2E: '1', CODEFLY_E2E_AGENT_CMD: fixture },
      production
    )

    const resolved = await Promise.all(AGENT_KINDS.map((kind) => locator.resolveAgent(kind)))
    expect(resolved).toEqual(AGENT_KINDS.map(() => fixture))
    expect(production.resolveAgent).not.toHaveBeenCalled()
    // Shells are the real thing even in E2E mode: only the agent executable is faked.
    await expect(locator.resolveShell()).resolves.toBe('/bin/zsh')
    await expect(locator.resolvePowerShell()).resolves.toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(production.resolveShell).toHaveBeenCalledOnce()
    expect(production.resolvePowerShell).toHaveBeenCalledOnce()
  })

  // The suite asserts the exact argv Claude and Codex receive, which is only meaningful while
  // that argv is produced by the production launch adapters. Substituting the executable must
  // therefore leave the bypass argv, the resume argv and the bypass environment untouched.
  it('changes the executable only, never the argv or the bypass environment', async () => {
    const { locator } = resolveHostComposition(
      { CODEFLY_E2E: '1', CODEFLY_E2E_AGENT_CMD: '/tmp/fake-agent.cjs' },
      productionLocator()
    )
    const resolver = new LaunchSpecResolver(locator, {}, 'darwin')

    await expect(resolver.resolveLaunchSpec('claude', false)).resolves.toEqual({
      file: '/tmp/fake-agent.cjs',
      args: ['--dangerously-skip-permissions'],
      env: {}
    })
    await expect(resolver.resolveLaunchSpec('codex', true)).resolves.toEqual({
      file: '/tmp/fake-agent.cjs',
      args: ['resume', '--last', '--dangerously-bypass-approvals-and-sandbox'],
      env: {}
    })
    await expect(resolver.resolveLaunchSpec('comate', false)).resolves.toEqual({
      file: '/tmp/fake-agent.cjs',
      args: [],
      env: { ZULU_TERMINAL_RUN_MODE: 'yolo' }
    })
  })
})

describe('resolveHostComposition idle timeout', () => {
  it.each([
    ['250', 250],
    ['1', 1],
    ['60000', 60_000]
  ])('honours a positive whole number of milliseconds (%s)', (raw, expected) => {
    expect(resolveHostComposition({ [IDLE_TIMEOUT_ENV]: raw }, productionLocator()).idleTimeoutMs).toBe(expected)
  })

  it.each(['0', '-250', '2.5', 'soon', '', ' '])('falls back to the default for %s', (raw) => {
    // A zero or a typo would otherwise produce a host that exits immediately, taking a real
    // user's sessions with it.
    expect(resolveHostComposition({ [IDLE_TIMEOUT_ENV]: raw }, productionLocator()).idleTimeoutMs).toBe(
      IDLE_EXIT_TIMEOUT_MS
    )
  })
})
