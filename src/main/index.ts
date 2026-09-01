import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { Dialog } from 'electron'

import type { AppSnapshot, CapabilityState } from '../shared/contracts'
import { cliLocator, type CliLocator } from './infrastructure/cli-locator'
import { registerIpc } from './ipc/register-ipc'
import { createBeforeQuitHandler } from './shutdown-controller'
import { AppInfoService } from './services/app-info-service'
import { ExternalAppService } from './services/external-app-service'
import { ProjectService } from './services/project-service'
import { SessionCoordinator } from './services/session-coordinator'
import { SessionStore } from './services/session-store'
import { TerminalService } from './services/terminal-service'
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
import { applyWindowTheme, createMainWindow } from './window'

const agentUnavailableDetail: Readonly<Record<'claude' | 'codex', string>> = {
  claude: 'Install the Claude Code CLI (claude) and sign in.',
  codex: 'Install the Codex CLI (codex) and sign in.'
}

type AgentLocator = Pick<CliLocator, 'resolveAgent'>
type TerminalLocator = Pick<CliLocator, 'resolvePowerShell' | 'resolveAgent'>

const buildGetSnapshot = (
  coordinator: SessionCoordinator,
  externalAppService: ExternalAppService,
  agentLocator: AgentLocator,
  store: Pick<SessionStore, 'recoveryWarning'>
): (() => Promise<AppSnapshot>) => {
  return async () => {
    const [state, claudePath, codexPath, vscode] = await Promise.all([
      coordinator.snapshot(),
      agentLocator.resolveAgent('claude'),
      agentLocator.resolveAgent('codex'),
      externalAppService.capabilities()
    ])

    const capabilities: CapabilityState = {
      claude: claudePath ? { available: true, detail: claudePath } : { available: false, detail: agentUnavailableDetail.claude },
      codex: codexPath ? { available: true, detail: codexPath } : { available: false, detail: agentUnavailableDetail.codex },
      ...vscode
    }

    const recoveryWarning = store.recoveryWarning()
    return recoveryWarning ? { state, capabilities, recoveryWarning } : { state, capabilities }
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
 * touched here — only the resolved *executable* changes for Claude/Codex in E2E mode, exactly
 * as production TerminalService/TitleService launch adapters would apply their fixed argv to
 * whatever executable the locator resolves. When CODEFLY_E2E is unset (every production
 * build), none of this file's E2E helpers are invoked and behavior is byte-for-byte identical
 * to the code path that existed before this test-mode composition was added.
 */

const isE2E = process.env.CODEFLY_E2E === '1'

const buildE2ETerminalLocator = (agentCommand: string): TerminalLocator => ({
  resolvePowerShell: () => cliLocator.resolvePowerShell(),
  resolveAgent: async () => agentCommand
})

const buildE2ETitleAdapters = (
  agentCommand: string,
  titleArgvLogPath: string | undefined
): Partial<Record<'claude' | 'codex', TitleAdapter>> => {
  const locator: AgentLocator = { resolveAgent: async () => agentCommand }
  const processSpawner: TitleProcessSpawner = (file, args, options) =>
    spawn(file, [...args], {
      ...options,
      env: titleArgvLogPath ? { ...process.env, CODEFLY_E2E_ARGV_LOG: titleArgvLogPath } : process.env
    }) as unknown as SpawnedTitleProcess

  return {
    claude: createCliTitleAdapter('claude', locator, processSpawner),
    codex: createCliTitleAdapter('codex', locator, processSpawner)
  }
}

const buildE2EExternalAppService = (): ExternalAppService =>
  new ExternalAppService(
    cliLocator,
    async () => true,
    async () => {
      // Mocked launch: E2E coverage asserts the row action fires without toggling the
      // project row, never that a real VS Code window opens.
    },
    async () => ''
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

const buildE2EAppInfoService = (): AppInfoService =>
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
    })()
  )

// An updater that cannot reach the network, the disk, or a child process: with no release
// fixture the E2E suite must not be able to download a real installer or launch one. The 404
// stand-in stops the flow where production would when no release exists, so the renderer's
// "no update available" path is still the code path under test.
const buildE2EUpdaterService = (fixture: E2EReleaseFixture | undefined): UpdaterService => {
  const unusableFileSystem: UpdaterFileSystem = {
    ensureDirectory: async () => undefined,
    fileSize: async () => undefined,
    openWriteStream: async () => {
      throw new Error('The E2E updater never writes to disk.')
    },
    rename: async () => undefined,
    remove: async () => undefined
  }

  // Records the installer path the service would have executed. The real spawn is the one
  // thing this flow cannot rehearse — running an installer would modify the machine — so it
  // is replaced by the smallest possible observable side effect.
  const recordingSpawner: InstallerSpawner = (file) => {
    if (fixture?.installLog) writeFileSync(fixture.installLog, file, 'utf8')
    return { unref: () => undefined }
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
    }
  )
}

const buildE2EDialog = (projectPath: string | undefined): Dialog =>
  ({
    showOpenDialog: async () =>
      projectPath ? { canceled: false, filePaths: [projectPath] } : { canceled: true, filePaths: [] }
  }) as unknown as Dialog

app.whenReady().then(() => {
  const statePath = join(app.getPath('userData'), 'state.json')
  const store = new SessionStore(statePath)
  const projectService = new ProjectService(store)
  const worktreeService = new WorktreeService()

  const e2eAgentCommand = isE2E ? process.env.CODEFLY_E2E_AGENT_CMD : undefined

  const agentLocator: AgentLocator = e2eAgentCommand ? buildE2ETerminalLocator(e2eAgentCommand) : cliLocator
  const terminalService = e2eAgentCommand ? new TerminalService(buildE2ETerminalLocator(e2eAgentCommand)) : new TerminalService()
  const titleService = e2eAgentCommand
    ? new TitleService(buildE2ETitleAdapters(e2eAgentCommand, process.env.CODEFLY_E2E_TITLE_ARGV_LOG))
    : new TitleService()
  const externalAppService = isE2E ? buildE2EExternalAppService() : new ExternalAppService()
  const appInfoService = isE2E ? buildE2EAppInfoService() : new AppInfoService()
  const updaterService = isE2E ? buildE2EUpdaterService(e2eReleaseFixture) : new UpdaterService()
  const dialogForIpc = isE2E ? buildE2EDialog(process.env.CODEFLY_E2E_PROJECT) : dialog

  const coordinator = new SessionCoordinator(store, projectService, worktreeService, terminalService, titleService)

  const window = createMainWindow()

  const disposeIpc = registerIpc({
    ipcMain,
    dialog: dialogForIpc,
    window,
    projectService,
    coordinator,
    externalAppService,
    appInfoService,
    updaterService,
    terminalService,
    getSnapshot: buildGetSnapshot(coordinator, externalAppService, agentLocator, store),
    applyTheme: (theme) => applyWindowTheme(window, theme)
  })

  window.on('closed', () => {
    disposeIpc()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
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
