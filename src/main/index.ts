import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { Dialog } from 'electron'

import { AGENT_KINDS, type AgentKind } from '../shared/agent-kinds'
import {
  hostPlatformSchema,
  type AppSnapshot,
  type CapabilityState,
  type HostPlatform,
  type SessionRecord,
  type ToolAvailability
} from '../shared/contracts'
import type { TerminalReplay } from '../shared/pty-protocol'
import { cliLocator, type CliLocator } from './infrastructure/cli-locator'
import { registerIpc } from './ipc/register-ipc'
import { createBeforeQuitHandler } from './shutdown-controller'
import { AppInfoService } from './services/app-info-service'
import { ExternalAppService } from './services/external-app-service'
import { ProjectService } from './services/project-service'
import { PtyHostClient } from './services/pty-host-client'
import { PtyHostLauncher } from './services/pty-host-launcher'
import { PtyHostRuntime } from './services/pty-host-runtime'
import { SessionCoordinator, type SessionTerminal } from './services/session-coordinator'
import { SessionStore } from './services/session-store'
import { TerminalService, type TerminalEventMap } from './services/terminal-service'
import {
  createCliTitleAdapter,
  TitleService,
  type SpawnedTitleProcess,
  type TitleAdapter,
  type TitleProcessSpawner
} from './services/title-service'
import {
  UpdaterService,
  type FetchLike as UpdaterFetchLike,
  type InstallerSpawner,
  type UpdaterFileSystem
} from './services/updater-service'
import { WorktreeService } from './services/worktree-service'
import { applyWindowPinned, applyWindowTheme, createMainWindow } from './window'

// Shown verbatim in the launcher under a kind whose CLI could not be found, so each names the
// executable actually looked up (which is not always the kind — see AGENT_LAUNCH).
const agentUnavailableDetail: Readonly<Record<AgentKind, string>> = {
  claude: 'Install the Claude Code CLI (claude) and sign in.',
  codex: 'Install the Codex CLI (codex) and sign in.',
  gemini: 'Install the Gemini CLI (gemini) and sign in.',
  copilot: 'Install the GitHub Copilot CLI (copilot) and sign in.',
  cursor: 'Install the Cursor CLI (agent) and sign in.',
  comate: 'Install the Comate CLI (comatecli) and sign in.',
  qwen: 'Install the Qwen Code CLI (qwen) and sign in.'
}

type AgentLocator = Pick<CliLocator, 'resolveAgent'>
type TerminalLocator = Pick<CliLocator, 'resolveShell' | 'resolvePowerShell' | 'resolveAgent'>

const parsedPlatform = hostPlatformSchema.safeParse(process.platform)
if (!parsedPlatform.success) {
  throw new Error(`Unsupported platform: ${process.platform}. CodeFly supports Windows and macOS only.`)
}
const runtimePlatform: HostPlatform = parsedPlatform.data

const buildGetSnapshot = (
  coordinator: SessionCoordinator,
  projectService: Pick<ProjectService, 'refreshRemotes'>,
  externalAppService: ExternalAppService,
  agentLocator: AgentLocator,
  store: Pick<SessionStore, 'recoveryWarning'>,
  platform: HostPlatform,
  /**
   * Settles once the pty-host has been consulted and the session list reconciled against the
   * PTYs it is actually holding. Awaited here, rather than blocking the window, so the first
   * list the renderer ever draws is already the truth: without it a session that outlived the
   * previous window would be painted from the persisted intent, and a terminal opened in that
   * gap would ask for a replay no host had answered for yet and stay blank for good.
   */
  sessionsReconciled: Promise<void>
): (() => Promise<AppSnapshot>) => {
  return async () => {
    await sessionsReconciled
    // Every agent kind is probed, including the ones switched off by default: the renderer can
    // enable one at any moment without another snapshot, and the launcher looks availability
    // up by kind with nothing to fall back to.
    const [state, agentPaths, vscode] = await Promise.all([
      // Remotes are re-read before the state is handed out so the sidebar's repository
      // entries reflect the working trees as they are now, not as they were when added.
      projectService.refreshRemotes().then(() => coordinator.snapshot()),
      Promise.all(AGENT_KINDS.map(async (kind) => [kind, await agentLocator.resolveAgent(kind)] as const)),
      externalAppService.capabilities()
    ])

    const capabilities: CapabilityState = {
      ...(Object.fromEntries(
        agentPaths.map(([kind, path]) => [
          kind,
          path ? { available: true, detail: path } : { available: false, detail: agentUnavailableDetail[kind] }
        ])
      ) as Record<AgentKind, ToolAvailability>),
      ...vscode
    }

    const recoveryWarning = store.recoveryWarning()
    return recoveryWarning ? { platform, state, capabilities, recoveryWarning } : { platform, state, capabilities }
  }
}

/**
 * ---------------------------------------------------------------------------------------
 * End-to-end test composition (CODEFLY_E2E=1 only)
 * ---------------------------------------------------------------------------------------
 * Every switch below is read ONLY here, in the composition root, and wired through the
 * existing constructor/dependency-injection seams already exposed by TerminalService,
 * TitleService, ExternalAppService, and registerIpc's `dialog` dependency. None of those
 * services branch on environment variables themselves, and the bypass argv values
 * (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`) are never
 * touched here — only the resolved *executable* changes for the agent kinds in E2E mode, exactly
 * as production TerminalService/TitleService launch adapters would apply their fixed argv to
 * whatever executable the locator resolves. When CODEFLY_E2E is unset (every production
 * build), none of this file's E2E helpers are invoked and behavior is byte-for-byte identical
 * to the code path that existed before this test-mode composition was added.
 */

const isE2E = process.env.CODEFLY_E2E === '1'

const buildE2ETerminalLocator = (agentCommand: string): TerminalLocator => ({
  resolveShell: () => cliLocator.resolveShell(),
  resolvePowerShell: () => cliLocator.resolvePowerShell(),
  resolveAgent: async () => agentCommand
})

const buildE2ETitleAdapters = (
  agentCommand: string,
  titleArgvLogPath: string | undefined,
  platform: HostPlatform
): Partial<Record<'claude' | 'codex', TitleAdapter>> => {
  const locator: AgentLocator = { resolveAgent: async () => agentCommand }
  const processSpawner: TitleProcessSpawner = (file, args, options) =>
    spawn(file, [...args], {
      ...options,
      env: titleArgvLogPath ? { ...process.env, CODEFLY_E2E_ARGV_LOG: titleArgvLogPath } : process.env
    }) as unknown as SpawnedTitleProcess

  return {
    claude: createCliTitleAdapter('claude', locator, processSpawner, { platform }),
    codex: createCliTitleAdapter('codex', locator, processSpawner, { platform })
  }
}

const buildE2EExternalAppService = (platform: HostPlatform): ExternalAppService =>
  new ExternalAppService(
    cliLocator,
    async () => true,
    async () => {
      // Mocked launch: E2E coverage asserts the row action fires without toggling the
      // project row, never that a real VS Code window opens.
    },
    async () => '',
    process.env,
    async () => {
      // Mocked browser: the repository action must never open a real browser from the suite.
    },
    platform
  )

/**
 * An offline stand-in for one published GitHub release, supplied by the E2E suite as JSON in
 * CODEFLY_E2E_RELEASE. Without it the release endpoint answers 404 — what that endpoint
 * really returns for this repository today — and the suite exercises the "no release" path.
 * With it, the whole update journey runs against the real services: the real SemVer
 * comparison, the real asset picker and host allowlist, and a real streamed write into the
 * suite's own user-data directory. Only the network and the installer process are replaced.
 */
type E2EReleaseFixture = {
  release: unknown
  installerUrl: string
  installerBytes: number
  installLog: string | undefined
}

const readE2EReleaseFixture = (): E2EReleaseFixture | undefined => {
  const raw = process.env.CODEFLY_E2E_RELEASE
  if (!raw) return undefined

  const release = JSON.parse(raw) as { assets?: ReadonlyArray<{ browser_download_url?: string; size?: number }> }
  const asset = release.assets?.[0]
  if (!asset?.browser_download_url) return undefined

  return {
    release,
    installerUrl: asset.browser_download_url,
    installerBytes: asset.size ?? 0,
    installLog: process.env.CODEFLY_E2E_INSTALL_LOG
  }
}

const e2eReleaseFixture = isE2E ? readE2EReleaseFixture() : undefined

const RELEASE_NOT_FOUND = { ok: false, status: 404, json: async () => null }

// Splits the two requests the update flow makes: the release metadata, and the installer
// itself. The installer body is yielded in chunks so the throttled progress reporting and the
// renderer's progress bar are both exercised, not short-circuited by a single frame.
const buildE2EReleaseFetch = (fixture: E2EReleaseFixture): UpdaterFetchLike => {
  const CHUNK_BYTES = 64 * 1024

  return async (url) => {
    if (url !== fixture.installerUrl) return { ok: true, status: 200, json: async () => fixture.release }

    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(fixture.installerBytes) : null) },
      json: async () => null,
      body: (async function* () {
        for (let sent = 0; sent < fixture.installerBytes; sent += CHUNK_BYTES) {
          yield new Uint8Array(Math.min(CHUNK_BYTES, fixture.installerBytes - sent)).fill(0x41)
        }
      })()
    }
  }
}

const buildE2EAppInfoService = (platform: HostPlatform): AppInfoService =>
  new AppInfoService(
    () => app.getVersion(),
    e2eReleaseFixture
      ? async () => ({ ok: true, status: 200, json: async () => e2eReleaseFixture.release })
      : async () => RELEASE_NOT_FOUND,
    async () => {
      // Mocked launch: E2E asserts the Settings action fires, never that a real browser opens.
    },
    // In-memory login item: the suite must never write the real Windows "Run" registry key.
    (() => {
      let openAtLogin = false
      return {
        getOpenAtLogin: () => openAtLogin,
        setOpenAtLogin: (next: boolean) => {
          openAtLogin = next
        }
      }
    })(),
    undefined,
    platform
  )

// An updater that cannot reach the network, the disk, or a child process: with no release
// fixture the E2E suite must not be able to download a real installer or launch one. The 404
// stand-in stops the flow where production would when no release exists, so the renderer's
// "no update available" path is still the code path under test.
const buildE2EUpdaterService = (fixture: E2EReleaseFixture | undefined, platform: HostPlatform): UpdaterService => {
  const unusableFileSystem: UpdaterFileSystem = {
    ensureDirectory: async () => undefined,
    fileSize: async () => undefined,
    openWriteStream: async () => {
      throw new Error('The E2E updater never writes to disk.')
    },
    rename: async () => undefined,
    remove: async () => undefined,
    listFiles: async () => []
  }

  // Records the installer path the service would have executed. The real spawn is the one
  // thing this flow cannot rehearse — running an installer would modify the machine — so it
  // is replaced by the smallest possible observable side effect. It still has to behave like
  // a ChildProcess and announce 'spawn', because the service (rightly) refuses to quit until
  // the OS confirms the installer actually started.
  const recordingSpawner: InstallerSpawner = (file) => {
    if (fixture?.installLog) writeFileSync(fixture.installLog, file, 'utf8')

    const spawnListeners: Array<() => void> = []
    queueMicrotask(() => {
      for (const listener of spawnListeners) listener()
    })

    return {
      unref: () => undefined,
      on: (event: 'error' | 'spawn', listener: (error?: Error) => void) => {
        if (event === 'spawn') spawnListeners.push(listener as () => void)
      }
    } as ReturnType<InstallerSpawner>
  }

  return new UpdaterService(
    () => app.getVersion(),
    fixture ? buildE2EReleaseFetch(fixture) : async () => RELEASE_NOT_FOUND,
    () => app.getPath('userData'),
    // With a fixture the real filesystem is used, against the suite's own --user-data-dir:
    // the streamed write, the size check, and the .part rename are all real.
    fixture ? undefined : unusableFileSystem,
    fixture
      ? recordingSpawner
      : () => {
          throw new Error('The E2E updater never launches an installer.')
        },
    () => {
      // Mocked quit: the suite drives the window lifecycle itself, and quitting here would
      // tear down the window mid-assertion.
    },
    undefined,
    undefined,
    platform
  )
}

const buildE2EDialog = (projectPath: string | undefined): Dialog =>
  ({
    showOpenDialog: async () =>
      projectPath ? { canceled: false, filePaths: [projectPath] } : { canceled: true, filePaths: [] }
  }) as unknown as Dialog

/**
 * Everything the coordinator and the IPC layer need from a terminal implementation. Two
 * satisfy it: `PtyHostClient`, a proxy to the resident host that keeps PTYs across UI
 * restarts, and `TerminalService`, which owns them in this process and loses them with it.
 */
type TerminalImplementation = SessionTerminal & {
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  isRunning(sessionId: string): boolean
  replay?(sessionId: string): Promise<TerminalReplay>
}

/**
 * Forwards every call to whichever implementation this launch settles on.
 *
 * The coordinator and the IPC handlers must be wired before the pty-host connection attempt
 * can finish: the window has to open promptly, and the renderer's first request has to find
 * its handler already registered. But which implementation answers is only known once that
 * attempt resolves — the resident host if it can be reached, in-process PTYs if it cannot.
 *
 * Subscriptions taken before that point are held and re-issued against the winner. No other
 * call can arrive early, because the renderer cannot name a session before `snapshot:get`
 * answers, and that waits on the same reconciliation (see buildGetSnapshot).
 */
class DeferredTerminal implements TerminalImplementation {
  private target: TerminalImplementation | undefined
  private readonly heldSubscriptions: Array<(target: TerminalImplementation) => void> = []

  bind(target: TerminalImplementation): void {
    this.target = target
    for (const attach of this.heldSubscriptions.splice(0)) attach(target)
  }

  private require(): TerminalImplementation {
    if (!this.target) throw new Error('The terminal implementation was used before the pty-host attempt finished.')
    return this.target
  }

  on<K extends keyof TerminalEventMap>(event: K, listener: (payload: TerminalEventMap[K]) => void): () => void {
    const bound = this.target
    if (bound) return bound.on(event, listener)

    let dispose: (() => void) | undefined
    let cancelled = false
    this.heldSubscriptions.push((target) => {
      if (!cancelled) dispose = target.on(event, listener)
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }

  async start(session: SessionRecord, options?: { resume?: boolean }): Promise<void> {
    return this.require().start(session, options)
  }

  write(sessionId: string, data: string): void {
    this.require().write(sessionId, data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.require().resize(sessionId, cols, rows)
  }

  async stop(sessionId: string): Promise<void> {
    return this.require().stop(sessionId)
  }

  async stopAll(): Promise<void> {
    return this.require().stopAll()
  }

  isRunning(sessionId: string): boolean {
    return this.require().isRunning(sessionId)
  }

  async replay(sessionId: string): Promise<TerminalReplay> {
    const target = this.require()
    // The in-process fallback retains nothing, so there is nothing to repaint from. Reported
    // as a failure rather than an empty screen because the IPC layer already folds a failed
    // replay into "open this terminal empty", which is exactly right here.
    if (!target.replay) throw new Error('This terminal implementation retains no output to replay.')
    return target.replay(sessionId)
  }

  async detach(): Promise<void> {
    const target = this.require()
    if (target.detach) return target.detach()
    // The fallback owns its PTYs and they die with this process regardless, so stopping them
    // deliberately beats having the OS tear them down in the middle of a write.
    return target.stopAll()
  }
}

/**
 * Records the host's pid for the E2E suite, whose whole point is that the host is still alive
 * after the app it was started by has exited — so the suite needs a handle on it to clean up,
 * and to assert the keepalive at all. Nothing in the application reads this.
 */
const recordE2EHostPid = (hostPid: number): void => {
  const logPath = process.env.CODEFLY_E2E_HOST_PID_LOG
  if (logPath === undefined) return
  try {
    writeFileSync(logPath, String(hostPid), 'utf8')
  } catch (error) {
    console.error('CodeFly: failed to record the pty-host pid for the E2E suite.', error)
  }
}

/**
 * Picks the terminal implementation for this launch and squares the persisted session list
 * with the PTYs that actually exist. Never rejects: every outcome here has to leave a usable
 * app, so a failure downgrades what sessions can do rather than what the app can do.
 */
const attachSessions = async (options: {
  terminal: DeferredTerminal
  coordinator: SessionCoordinator
  client: PtyHostClient
  fallback: TerminalImplementation
}): Promise<void> => {
  const { terminal, coordinator, client, fallback } = options

  let liveSessionIds: ReadonlySet<string> = new Set()
  let autoResume = true

  const attachment = await client.connect()
  if (attachment.status === 'connected') {
    terminal.bind(client)
    recordE2EHostPid(attachment.hostPid)
    liveSessionIds = new Set(attachment.sessions.map((session) => session.sessionId))
  } else {
    // No host to talk to, so this window owns its PTYs and they end with it. The app stays
    // fully usable; only the keepalive is gone.
    console.error(
      `CodeFly: running without a pty-host (${attachment.status}): ${attachment.message} Sessions will not outlive this window.`
    )
    terminal.bind(fallback)
    // `unavailable` means no host exists, so nothing is running and resuming is safe.
    // `incompatible` means one IS running, holding PTYs this build could not adopt and could
    // not retire. Resuming then would start a SECOND agent process per session against the
    // same worktree, which is worse than leaving them stopped for the user to restart by hand.
    autoResume = attachment.status === 'unavailable'
  }

  await coordinator.reconcile(liveSessionIds, { autoResume })
}

app.whenReady().then(() => {
  const statePath = join(app.getPath('userData'), 'state.json')
  const store = new SessionStore(statePath)
  const projectService = new ProjectService(store, undefined, undefined, undefined, undefined, runtimePlatform)
  const worktreeService = new WorktreeService()

  const e2eAgentCommand = isE2E ? process.env.CODEFLY_E2E_AGENT_CMD : undefined

  const agentLocator: AgentLocator = e2eAgentCommand ? buildE2ETerminalLocator(e2eAgentCommand) : cliLocator
  const terminalService = e2eAgentCommand
    ? new TerminalService(buildE2ETerminalLocator(e2eAgentCommand), undefined, undefined, runtimePlatform)
    : new TerminalService(cliLocator, undefined, undefined, runtimePlatform)
  const titleService = e2eAgentCommand
    ? new TitleService(buildE2ETitleAdapters(e2eAgentCommand, process.env.CODEFLY_E2E_TITLE_ARGV_LOG, runtimePlatform))
    : new TitleService()
  const externalAppService = isE2E
    ? buildE2EExternalAppService(runtimePlatform)
    : new ExternalAppService(undefined, undefined, undefined, undefined, undefined, undefined, runtimePlatform)
  const appInfoService = isE2E
    ? buildE2EAppInfoService(runtimePlatform)
    : new AppInfoService(undefined, undefined, undefined, undefined, undefined, runtimePlatform)
  const updaterService = isE2E
    ? buildE2EUpdaterService(e2eReleaseFixture, runtimePlatform)
    : new UpdaterService(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtimePlatform)
  const dialogForIpc = isE2E ? buildE2EDialog(process.env.CODEFLY_E2E_PROJECT) : dialog

  const userDataPath = app.getPath('userData')

  /**
   * The resident pty-host: it holds every PTY, so closing this window, reloading the renderer,
   * or installing an update leaves the agents running and the next launch attaches to them.
   *
   * The endpoint is derived from the userData path, which keeps a second Windows account and
   * the E2E suite's own --user-data-dir on hosts of their own. A dev run is separated from an
   * installed build explicitly, even though both use the same userData: their `out/` builds
   * differ, and a `npm run dev` window adopting the sessions of the installed CodeFly (or the
   * reverse) would run this build's UI against the other build's host.
   */
  const ptyHostRuntime = new PtyHostRuntime({
    platform: runtimePlatform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    userDataPath,
    appVersion: app.getVersion()
  })
  const ptyHostLauncher = new PtyHostLauncher(
    app.isPackaged ? userDataPath : `${userDataPath}::dev`,
    app.getVersion(),
    async () => ({ ...(await ptyHostRuntime.resolve()), logPath: join(userDataPath, 'pty-host.log') })
  )
  const ptyHostClient = new PtyHostClient(ptyHostLauncher)
  ptyHostClient.onDisconnected(() => {
    // Deliberately not turned into 'stopped' status or a reconnect: a dropped socket says
    // nothing about whether the PTYs behind it died, and guessing either way is worse than
    // waiting. Restarting CodeFly reconciles against whatever is really there.
    console.error('CodeFly: the pty-host connection dropped. Restart CodeFly to reattach or resume its sessions.')
  })

  const terminal = new DeferredTerminal()
  const coordinator = new SessionCoordinator(store, projectService, worktreeService, terminal, titleService)
  const sessionsReconciled = attachSessions({
    terminal,
    coordinator,
    client: ptyHostClient,
    fallback: terminalService
  }).catch((error: unknown) => {
    // attachSessions is written not to reject; if it somehow does, the snapshot must still be
    // served or the window would sit empty forever.
    console.error('CodeFly: failed to reconcile sessions at startup.', error)
  })

  const window = createMainWindow(runtimePlatform)

  const disposeIpc = registerIpc({
    ipcMain,
    dialog: dialogForIpc,
    window,
    projectService,
    coordinator,
    externalAppService,
    appInfoService,
    updaterService,
    terminalService: terminal,
    saveWorkspace: (workspace) => store.saveWorkspace(workspace),
    getSnapshot: buildGetSnapshot(
      coordinator,
      projectService,
      externalAppService,
      agentLocator,
      store,
      runtimePlatform,
      sessionsReconciled
    ),
    applyTheme: (theme) => applyWindowTheme(window, theme, runtimePlatform),
    applyPinned: (pinned) => applyWindowPinned(window, pinned)
  })

  window.on('closed', () => {
    disposeIpc()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(runtimePlatform)
    }
  })

  app.on(
    'before-quit',
    createBeforeQuitHandler({
      shutdown: () => coordinator.shutdown(),
      quit: () => app.quit(),
      onError: (error) => {
        console.error('Failed to shut down SessionCoordinator cleanly before quit.', error)
      }
    })
  )
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
