import { describe, expect, it, vi } from 'vitest'

import type { AgentKind } from '../shared/agent-kinds'
import type { SessionKind } from '../shared/contracts'
import { LaunchSpecResolver, hostedShimSpec, validateShimPath } from './launch-spec'

type Locator = {
  resolveShell(): Promise<string | undefined>
  resolvePowerShell(): Promise<string | undefined>
  resolveAgent(agent: AgentKind): Promise<string | undefined>
}

const locatorWith = (resolved: Partial<Record<'shell' | 'powershell' | AgentKind, string>> = {}): Locator => ({
  resolveShell: vi.fn(async () => resolved.shell),
  resolvePowerShell: vi.fn(async () => resolved.powershell ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
  resolveAgent: vi.fn(async (agent: AgentKind) => resolved[agent])
})

type ResolverOptions = {
  locator?: Locator
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  candidateExists?: (candidate: string) => Promise<boolean>
}

const resolverWith = (options: ResolverOptions = {}): LaunchSpecResolver => new LaunchSpecResolver(
  options.locator ?? locatorWith(),
  options.environment ?? { PATH: 'C:\\Windows', KEEP_ME: 'yes' },
  options.platform ?? 'win32',
  options.candidateExists ?? vi.fn(async () => false)
)

describe('LaunchSpecResolver shells', () => {
  it('starts the resolved macOS Shell as a login shell', async () => {
    const locator = locatorWith({ shell: '/bin/zsh' })
    const resolver = resolverWith({ locator, platform: 'darwin', environment: { SHELL: '/bin/zsh' } })

    await expect(resolver.resolveLaunchSpec('shell', false)).resolves.toEqual({ file: '/bin/zsh', args: ['-l'] })
    expect(locator.resolveShell).toHaveBeenCalledOnce()
  })

  it('starts PowerShell without arguments', async () => {
    const locator = locatorWith({ powershell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })
    const resolver = resolverWith({ locator })

    await expect(resolver.resolveLaunchSpec('powershell', true)).resolves.toEqual({
      file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: []
    })
    expect(locator.resolvePowerShell).toHaveBeenCalledOnce()
  })

  it.each([
    [{ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'C:\\Windows\\System32\\cmd.exe'],
    [{ COMSPEC: 'C:\\Windows\\cmd.exe' }, 'C:\\Windows\\cmd.exe'],
    [{}, 'cmd.exe']
  ])('starts CMD from %o without consulting the CLI locator', async (environment, expected) => {
    const locator = locatorWith()
    const resolver = resolverWith({ locator, environment })

    await expect(resolver.resolveLaunchSpec('cmd', false)).resolves.toEqual({ file: expected, args: [] })
    expect(locator.resolveAgent).not.toHaveBeenCalled()
  })

  it.each([
    ['darwin' as const, 'powershell' as const, 'PowerShell is not supported on macOS.'],
    ['darwin' as const, 'cmd' as const, 'Command Prompt is not supported on macOS.'],
    ['win32' as const, 'shell' as const, 'Shell is not supported on Windows.']
  ])('rejects %s/%s before touching the locator', async (platform, kind, message) => {
    const locator = locatorWith({ shell: '/bin/zsh' })
    const resolver = resolverWith({ locator, platform })

    await expect(resolver.resolveLaunchSpec(kind, false)).rejects.toThrow(message)
    expect(locator.resolveShell).not.toHaveBeenCalled()
    expect(locator.resolvePowerShell).not.toHaveBeenCalled()
  })

  it.each([
    ['shell' as const, 'darwin' as const, 'Shell is not available.'],
    ['powershell' as const, 'win32' as const, 'PowerShell is not available.']
  ])('rejects %s when the locator finds nothing', async (kind, platform, message) => {
    const locator: Locator = {
      resolveShell: vi.fn(async () => undefined),
      resolvePowerShell: vi.fn(async () => undefined),
      resolveAgent: vi.fn(async () => undefined)
    }

    await expect(resolverWith({ locator, platform }).resolveLaunchSpec(kind, false)).rejects.toThrow(message)
  })
})

describe('LaunchSpecResolver agents', () => {
  it('launches macOS agents directly with the existing create and resume arguments', async () => {
    const resolver = resolverWith({
      locator: locatorWith({ claude: '/opt/homebrew/bin/claude', codex: '/usr/local/bin/codex' }),
      platform: 'darwin',
      environment: { PATH: '/usr/bin' }
    })

    await expect(resolver.resolveLaunchSpec('claude', false)).resolves.toEqual({
      file: '/opt/homebrew/bin/claude',
      args: ['--dangerously-skip-permissions'],
      env: {}
    })
    await expect(resolver.resolveLaunchSpec('codex', true)).resolves.toEqual({
      file: '/usr/local/bin/codex',
      args: ['resume', '--last', '--dangerously-bypass-approvals-and-sandbox'],
      env: {}
    })
  })

  // The full registry, asserted as one table so a registry edit that drops or reorders a flag
  // fails per kind rather than as one vague failure. Codex is the only kind whose resume is a
  // leading subcommand, which is exactly what the ordering here pins down.
  it.each([
    ['claude' as const, ['--dangerously-skip-permissions'], ['--dangerously-skip-permissions', '--continue']],
    [
      'codex' as const,
      ['--dangerously-bypass-approvals-and-sandbox'],
      ['resume', '--last', '--dangerously-bypass-approvals-and-sandbox']
    ],
    ['gemini' as const, ['--approval-mode=yolo'], ['--approval-mode=yolo', '--resume', 'latest']],
    ['copilot' as const, ['--allow-all-tools'], ['--allow-all-tools', '--continue']],
    ['cursor' as const, ['--force'], ['--force', '--resume']],
    ['comate' as const, [], ['--resume']],
    ['qwen' as const, ['--approval-mode=yolo'], ['--approval-mode=yolo', '--continue']]
  ])('resolves %s with its own bypass argv fresh and its own resume argv on restore', async (kind, freshArgs, resumeArgs) => {
    const executable = `/opt/homebrew/bin/${kind}`
    const resolver = resolverWith({ locator: locatorWith({ [kind]: executable }), platform: 'darwin' })

    expect((await resolver.resolveLaunchSpec(kind, false)).args).toEqual(freshArgs)
    expect((await resolver.resolveLaunchSpec(kind, true)).args).toEqual(resumeArgs)
  })

  it('looks the agent up by kind so the registry decides the executable name', async () => {
    const locator = locatorWith({ cursor: '/opt/homebrew/bin/agent' })
    const resolver = resolverWith({ locator, platform: 'darwin' })

    await expect(resolver.resolveLaunchSpec('cursor', false)).resolves.toEqual({
      file: '/opt/homebrew/bin/agent',
      args: ['--force'],
      env: {}
    })
    expect(locator.resolveAgent).toHaveBeenCalledWith('cursor')
  })

  // Comate's TUI resets its run mode to `ZULU_TERMINAL_RUN_MODE || 'manual'` on every launch,
  // so its bypass travels as environment rather than argv — and must not leak elsewhere.
  it('carries the Comate bypass as environment and leaves other kinds without one', async () => {
    const resolver = resolverWith({
      locator: locatorWith({ comate: 'C:\\npm\\comatecli.exe', claude: 'C:\\npm\\claude.exe' })
    })

    await expect(resolver.resolveLaunchSpec('comate', false)).resolves.toEqual({
      file: 'C:\\npm\\comatecli.exe',
      args: [],
      env: { ZULU_TERMINAL_RUN_MODE: 'yolo' }
    })
    await expect(resolver.resolveLaunchSpec('claude', false)).resolves.toEqual({
      file: 'C:\\npm\\claude.exe',
      args: ['--dangerously-skip-permissions'],
      env: {}
    })
  })

  it('rejects an agent the locator cannot find', async () => {
    await expect(resolverWith().resolveLaunchSpec('claude', false)).rejects.toThrow('claude is not available.')
  })
})

describe('LaunchSpecResolver Windows shim chain', () => {
  it.each([
    ['claude' as const, 'C:\\Agents With Spaces\\claude.exe', ['--dangerously-skip-permissions']],
    ['codex' as const, 'C:\\Agents With Spaces\\codex.com', ['--dangerously-bypass-approvals-and-sandbox']]
  ])('runs a direct %s executable as-is', async (kind, executable, expectedArgs) => {
    const candidateExists = vi.fn(async () => false)
    const resolver = resolverWith({ locator: locatorWith({ [kind]: executable }), candidateExists })

    await expect(resolver.resolveLaunchSpec(kind, false)).resolves.toEqual({
      file: executable,
      args: expectedArgs,
      env: {}
    })
    expect(candidateExists).not.toHaveBeenCalled()
  })

  it.each([
    ['claude' as const, 'cmd', '--dangerously-skip-permissions'],
    ['codex' as const, 'bat', '--dangerously-bypass-approvals-and-sandbox']
  ])('hosts a resolved %s .%s shim with ComSpec and a raw double-wrapped command', async (kind, extension, bypassFlag) => {
    const shim = `C:\\Users\\Dev Name\\AppData\\Roaming\\npm\\${kind}.${extension}`
    const comspec = 'C:\\Windows\\System32\\cmd.exe'
    const resolver = resolverWith({
      locator: locatorWith({ [kind]: shim }),
      environment: { ComSpec: comspec },
      candidateExists: vi.fn(async () => false)
    })

    await expect(resolver.resolveLaunchSpec(kind, false)).resolves.toEqual({
      file: comspec,
      args: `/d /s /c ""${shim}" ${bypassFlag}"`,
      env: {}
    })
  })

  it('hosts a restored claude .cmd shim with the continue flag inside the wrapped command', async () => {
    const shim = 'C:\\Users\\Dev Name\\AppData\\Roaming\\npm\\claude.cmd'
    const comspec = 'C:\\Windows\\System32\\cmd.exe'
    const resolver = resolverWith({
      locator: locatorWith({ claude: shim }),
      environment: { ComSpec: comspec },
      candidateExists: vi.fn(async () => false)
    })

    await expect(resolver.resolveLaunchSpec('claude', true)).resolves.toEqual({
      file: comspec,
      args: `/d /s /c ""${shim}" --dangerously-skip-permissions --continue"`,
      env: {}
    })
  })

  it('prefers a sibling executable over a resolved .cmd shim', async () => {
    const shim = 'C:\\npm\\claude.cmd'
    const executable = 'C:\\npm\\claude.exe'
    const candidateExists = vi.fn(async (candidate: string) => candidate === executable)
    const resolver = resolverWith({ locator: locatorWith({ claude: shim }), candidateExists })

    await expect(resolver.resolveLaunchSpec('claude', false)).resolves.toEqual({
      file: executable,
      args: ['--dangerously-skip-permissions'],
      env: {}
    })
    expect(candidateExists.mock.calls).toEqual([[executable]])
  })

  it('probes .exe, then .cmd, then .bat for an extensionless npm command', async () => {
    const resolved = 'C:\\Users\\Dev Name\\AppData\\Roaming\\npm\\claude'
    const batchShim = `${resolved}.bat`
    const candidateExists = vi.fn(async (candidate: string) => candidate === batchShim)
    const resolver = resolverWith({
      locator: locatorWith({ claude: resolved }),
      environment: { COMSPEC: 'C:\\Windows\\cmd.exe' },
      candidateExists
    })

    await expect(resolver.resolveLaunchSpec('claude', false)).resolves.toEqual({
      file: 'C:\\Windows\\cmd.exe',
      args: `/d /s /c ""${batchShim}" --dangerously-skip-permissions"`,
      env: {}
    })
    expect(candidateExists.mock.calls).toEqual([[`${resolved}.exe`], [`${resolved}.cmd`], [batchShim]])
  })

  it('prefers an executable sibling for an extensionless npm command', async () => {
    const resolved = 'C:\\Program Files\\agents\\codex'
    const executable = `${resolved}.exe`
    const candidateExists = vi.fn(async (candidate: string) => candidate === executable)
    const resolver = resolverWith({ locator: locatorWith({ codex: resolved }), candidateExists })

    await expect(resolver.resolveLaunchSpec('codex', false)).resolves.toEqual({
      file: executable,
      args: ['--dangerously-bypass-approvals-and-sandbox'],
      env: {}
    })
    expect(candidateExists.mock.calls).toEqual([[executable]])
  })

  it('rejects an extensionless command with no executable and no shim', async () => {
    const resolver = resolverWith({
      locator: locatorWith({ claude: 'C:\\npm\\claude' }),
      candidateExists: vi.fn(async () => false)
    })

    await expect(resolver.resolveLaunchSpec('claude', false)).rejects.toThrow(/not executable and has no trusted/i)
  })

  it('rejects a resolved path cmd.exe would reinterpret', async () => {
    const resolver = resolverWith({
      locator: locatorWith({ codex: 'C:\\bad"name\\codex.cmd' }),
      candidateExists: vi.fn(async () => true)
    })

    await expect(resolver.resolveLaunchSpec('codex', false)).rejects.toThrow(/unsafe/i)
  })

  it.each([
    'C:\\npm\\clau%PATH%de.cmd',
    'C:\\npm\\claude!.cmd',
    'C:\\npm\\claude&whoami.cmd',
    'C:\\npm\\claude|more.cmd',
    'C:\\npm\\claude>out.cmd',
    'C:\\npm\\claude<in.cmd',
    'C:\\npm\\claude^.cmd',
    'C:\\npm\\clau\u0000de.cmd',
    'C:\\npm\\clau\u001Fde.cmd',
    'C:\\npm\\clau\u007Fde.cmd'
  ])('refuses to build a hosted command for %s', (shim) => {
    expect(() => validateShimPath(shim)).toThrow(/unsafe/i)
    expect(() => hostedShimSpec(shim, [], { ComSpec: 'cmd.exe' })).toThrow(/unsafe/i)
  })

  it('accepts a spaced path and keeps the ComSpec fallback chain', () => {
    const shim = 'C:\\Users\\Dev Name\\npm\\claude.cmd'

    expect(hostedShimSpec(shim, ['--flag'], { COMSPEC: 'C:\\Windows\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\cmd.exe',
      args: `/d /s /c ""${shim}" --flag"`
    })
    expect(hostedShimSpec(shim, [], {})).toEqual({ file: 'cmd.exe', args: `/d /s /c ""${shim}" "` })
  })

  it('gates every kind the same way the main process did', async () => {
    const kinds: SessionKind[] = ['shell', 'powershell', 'cmd', 'claude']
    const resolver = resolverWith({ platform: 'darwin', locator: locatorWith({ shell: '/bin/zsh' }) })
    const outcomes = await Promise.all(
      kinds.map(async (kind) => {
        try {
          return (await resolver.resolveLaunchSpec(kind, false)).file
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      })
    )

    expect(outcomes).toEqual([
      '/bin/zsh',
      'PowerShell is not supported on macOS.',
      'Command Prompt is not supported on macOS.',
      'claude is not available.'
    ])
  })
})
