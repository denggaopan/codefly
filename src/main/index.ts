import { spawn } from 'node:child_process'
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

const buildE2EAppInfoService = (): AppInfoService =>
  new AppInfoService(
    () => app.getVersion(),
    // Offline stand-in for the GitHub releases API. 404 is what that endpoint really answers
    // for this repository today, so the production mapping (404 -> `none`) is still the code
    // path under test; only the network round trip is removed.
    async () => ({ ok: false, status: 404, json: async () => null }),
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
