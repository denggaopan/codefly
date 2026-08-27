import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain } from 'electron'

import type { AppSnapshot, CapabilityState } from '../shared/contracts'
import { cliLocator } from './infrastructure/cli-locator'
import { registerIpc } from './ipc/register-ipc'
import { ExternalAppService } from './services/external-app-service'
import { ProjectService } from './services/project-service'
import { SessionCoordinator } from './services/session-coordinator'
import { SessionStore } from './services/session-store'
import { TerminalService } from './services/terminal-service'
import { TitleService } from './services/title-service'
import { WorktreeService } from './services/worktree-service'
import { createMainWindow } from './window'

const agentUnavailableDetail: Readonly<Record<'claude' | 'codex', string>> = {
  claude: 'Install the Claude Code CLI (claude) and sign in.',
  codex: 'Install the Codex CLI (codex) and sign in.'
}

const buildGetSnapshot = (
  coordinator: SessionCoordinator,
  externalAppService: ExternalAppService
): (() => Promise<AppSnapshot>) => {
  return async () => {
    const [state, claudePath, codexPath, vscode] = await Promise.all([
      coordinator.snapshot(),
      cliLocator.resolveAgent('claude'),
      cliLocator.resolveAgent('codex'),
      externalAppService.capabilities()
    ])

    const capabilities: CapabilityState = {
      claude: claudePath ? { available: true, detail: claudePath } : { available: false, detail: agentUnavailableDetail.claude },
      codex: codexPath ? { available: true, detail: codexPath } : { available: false, detail: agentUnavailableDetail.codex },
      ...vscode
    }

    return { state, capabilities }
  }
}

app.whenReady().then(() => {
  const statePath = join(app.getPath('userData'), 'state.json')
  const store = new SessionStore(statePath)
  const projectService = new ProjectService(store)
  const worktreeService = new WorktreeService()
  const terminalService = new TerminalService()
  const titleService = new TitleService()
  const externalAppService = new ExternalAppService()
  const coordinator = new SessionCoordinator(store, projectService, worktreeService, terminalService, titleService)

  const window = createMainWindow()

  const disposeIpc = registerIpc({
    ipcMain,
    dialog,
    window,
    projectService,
    coordinator,
    externalAppService,
    terminalService,
    getSnapshot: buildGetSnapshot(coordinator, externalAppService)
  })

  window.on('closed', () => {
    disposeIpc()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })

  app.on('before-quit', () => {
    // coordinator.shutdown() can reject (e.g. TerminalService.stopAll() failing to
    // force-kill a PTY); that must never block quit or escape as an unhandled rejection.
    coordinator.shutdown().catch((error: unknown) => {
      console.error('Failed to shut down SessionCoordinator cleanly before quit.', error)
    })
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
