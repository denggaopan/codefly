import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { createRepo } from './create-repo'

/**
 * End-to-end coverage for the CodeFly desktop app, driven through a real Electron window
 * via Playwright. The app is launched with CODEFLY_E2E=1, which (see src/main/index.ts)
 * swaps only the *executable* resolved for Claude/Codex for the fixture at
 * e2e/fixtures/fake-agent.cmd/.cjs, and the project-add directory-picker result for
 * CODEFLY_E2E_PROJECT — every other seam (Git, PowerShell, cmd.exe, the persisted state
 * file, worktree lifecycle) is the real production implementation. Production builds
 * without CODEFLY_E2E never exercise any of this file's env-driven wiring.
 *
 * The 8 tests below run in one serial journey against one fixture repository/project so
 * that worktree sequence numbers, title generation, restart persistence, and deletion all
 * build on realistic prior state, the same way a user would experience them. Test 6
 * (relaunch) closes and re-opens the Electron app in the middle of the journey while
 * keeping the same --user-data-dir, so the remaining tests continue against the relaunched
 * window.
 *
 * Covers the brief's 11 scenarios:
 *   1  Add the fixture project                              -> test 1
 *   2  First worktree "worktree-YYMMDD-1" is displayed        -> test 1
 *   3  Claude argv is exactly the bypass flag + warning shown -> test 2
 *   4  First-input title replacement; no bypass flag leaks
 *      into the title-process argv log                       -> test 3
 *   5  Codex argv is exactly its bypass flag                  -> test 4
 *   6  PowerShell/CMD sessions: bypass warning absent          -> test 5
 *   7  Second worktree session shows sequence 2 (the Codex
 *      session created in test 4 IS that second worktree)     -> test 4
 *   8  Stop/relaunch, click a stopped session to restore it    -> test 6
 *   9  Mocked VS Code/Explorer actions don't toggle the row    -> test 7
 *  10  Dirty worktree blocks delete                            -> test 8
 *  11  Clean delete removes the directory, retains the branch  -> test 8
 */

test.describe.configure({ mode: 'serial' })

const currentDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(currentDir, '..')
const fakeAgentCmd = resolve(currentDir, 'fixtures', 'fake-agent.cmd')

const BYPASS_WARNING_TEXT = 'Permissions and sandbox bypass enabled'

let repoPath: string
let userDataDir: string
let terminalArgvLog: string
let titleArgvLog: string
let electronApp: ElectronApplication
let window: Page

const launchApp = async (): Promise<{ app: ElectronApplication; page: Page }> => {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEFLY_E2E: '1',
      CODEFLY_E2E_PROJECT: repoPath,
      CODEFLY_E2E_AGENT_CMD: fakeAgentCmd,
      CODEFLY_E2E_ARGV_LOG: terminalArgvLog,
      CODEFLY_E2E_TITLE_ARGV_LOG: titleArgvLog
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

const readJsonArgvLog = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

const sessionRowByKind = (kind: 'powershell' | 'cmd' | 'claude' | 'codex') =>
  window.locator('.session-row', { has: window.locator(`.session-kind-icon[data-kind="${kind}"]`) })

// The bypass disclosure is a single compact badge in the active session's terminal header
// (TerminalWorkspace.tsx's TerminalHeader). Every session that has ever been made active
// keeps its terminal pane — and thus its header — mounted in the DOM, just hidden
// (display:none on the pane) while inactive, so a still-running-but-inactive Claude/Codex
// session's header would inflate a raw, non-visibility filtered DOM count. Only the
// currently ACTIVE session's pane is ever visible, so filtering to :visible pins this to
// exactly what the user can see: 1 badge when the active session is a running Claude/Codex
// session, 0 otherwise (including while a running Claude/Codex session isn't the active one).
const visibleBypassWarnings = () => window.locator('.terminal-header-bypass:visible')

test.beforeAll(async () => {
  repoPath = createRepo()
  userDataDir = mkdtempSync(join(tmpdir(), 'codefly-e2e-userdata-'))
  const logsDir = mkdtempSync(join(tmpdir(), 'codefly-e2e-logs-'))
  terminalArgvLog = join(logsDir, 'terminal-argv.json')
  titleArgvLog = join(logsDir, 'title-argv.json')

  const launched = await launchApp()
  electronApp = launched.app
  window = launched.page
})

test.afterAll(async () => {
  await electronApp?.close()
})

test('keeps Settings interactive outside the draggable title bar', async () => {
  const trigger = window.getByRole('button', { name: 'Settings' })
  const dialog = window.getByRole('dialog', { name: 'Settings' })

  await trigger.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Light' }).click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(dialog.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')

  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(dialog).toHaveCount(0)

  await trigger.click()
  await expect(dialog).toBeVisible()
  await window.locator('.settings-dialog-backdrop').click({ position: { x: 8, y: 8 } })
  await expect(dialog).toHaveCount(0)

  await trigger.click()
  await expect(dialog).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await trigger.click()
  await dialog.getByRole('button', { name: 'Dark' }).click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
  await window.keyboard.press('Escape')
})

test('adds the fixture project and creates a Claude session as the first worktree', async () => {
  await window.getByRole('button', { name: 'Add Project' }).click()
  await expect(window.locator('[data-project-row]')).toHaveCount(1, { timeout: 20_000 })

  await window.getByRole('button', { name: 'New session' }).click()
  await window.locator('.session-launcher').getByRole('button', { name: 'Claude', exact: true }).click()

  const claudeRow = sessionRowByKind('claude')
  await expect(claudeRow).toHaveCount(1, { timeout: 20_000 })
  await expect(claudeRow.locator('.session-secondary')).toHaveText(/^worktree-\d{6}-1$/)
  await expect(window.locator('.terminal-pane:visible .xterm-rows')).toContainText('CODEFLY_E2E_FAKE_AGENT_READY', { timeout: 20_000 })
})

test('Claude receives exactly its bypass flag and the persistent warning is visible', async () => {
  await expect
    .poll(() => (existsSync(terminalArgvLog) ? readJsonArgvLog(terminalArgvLog) : undefined), { timeout: 20_000 })
    .toEqual(['--dangerously-skip-permissions'])

  await expect(visibleBypassWarnings()).toHaveText([BYPASS_WARNING_TEXT])
})

test('marks the running Claude session Done once its output has gone quiet', async () => {
  // The fake agent prints one ready marker and then stays silent, so after the renderer's
  // quiet window (AGENT_IDLE_MS) the sidebar row must flip from Running to Done.
  const claudeRow = sessionRowByKind('claude')
  const status = claudeRow.locator('.session-status')
  await expect(status).toHaveText('Done', { timeout: 20_000 })
  await expect(status).toHaveAttribute('data-status', 'done')
})

test('keeps the terminal workflow usable at the 900 by 600 minimum window size', async () => {
  const size = await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) throw new Error('CodeFly main window is missing')
    mainWindow.setSize(900, 600)
    return mainWindow.getSize()
  })
  expect(size[0]).toBeGreaterThanOrEqual(900)
  expect(size[0]).toBeLessThanOrEqual(902)
  expect(size[1]).toBeGreaterThanOrEqual(600)
  expect(size[1]).toBeLessThanOrEqual(602)

  await expect(window.getByRole('button', { name: 'Open project in VS Code' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Open project folder' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'New session' })).toBeVisible()
  await expect(window.locator('.terminal-pane:visible .terminal-instance-host')).toBeVisible()
  await expect(visibleBypassWarnings()).toHaveText([BYPASS_WARNING_TEXT])

  await window.getByRole('button', { name: 'New session' }).click()
  const launcher = window.locator('.session-launcher')
  await expect(launcher).toBeVisible()
  const [bounds, viewport] = await Promise.all([
    launcher.boundingBox(),
    window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  ])
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)

  await window.keyboard.press('Escape')
  await expect(launcher).toHaveCount(0)
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 760))
})

test('submitting the first input replaces the title and never leaks a bypass flag to the title process', async () => {
  const claudeRow = sessionRowByKind('claude')
  const originalTitle = await claudeRow.locator('.session-title').textContent()

  const terminalHost = window.locator('.terminal-pane:visible .terminal-instance-host')
  await terminalHost.click()
  await window.keyboard.type('hello codefly')
  await window.keyboard.press('Enter')

  await expect
    .poll(() => (existsSync(titleArgvLog) ? readJsonArgvLog(titleArgvLog) : undefined), { timeout: 20_000 })
    .toEqual(['--print'])

  const titleArgv = readJsonArgvLog(titleArgvLog) as string[]
  expect(titleArgv).not.toContain('--dangerously-skip-permissions')
  expect(titleArgv).not.toContain('--dangerously-bypass-approvals-and-sandbox')

  await expect(claudeRow.locator('.session-title')).not.toHaveText(originalTitle ?? '', { timeout: 20_000 })
})

test('creates a Codex session as the second worktree, receiving exactly its own bypass flag', async () => {
  await window.getByRole('button', { name: 'New session' }).click()
  await window.locator('.session-launcher').getByRole('button', { name: 'Codex', exact: true }).click()

  const codexRow = sessionRowByKind('codex')
  await expect(codexRow).toHaveCount(1, { timeout: 20_000 })
  await expect(codexRow.locator('.session-secondary')).toHaveText(/^worktree-\d{6}-2$/)

  await expect
    .poll(() => (existsSync(terminalArgvLog) ? readJsonArgvLog(terminalArgvLog) : undefined), { timeout: 20_000 })
    .toEqual(['--dangerously-bypass-approvals-and-sandbox'])

  await expect(visibleBypassWarnings()).toHaveText([BYPASS_WARNING_TEXT])
})

test('creates PowerShell and Command Prompt sessions with the bypass warning absent', async () => {
  await window.getByRole('button', { name: 'New session' }).click()
  await window.locator('.session-launcher').getByRole('button', { name: 'PowerShell', exact: true }).click()
  const powershellRow = sessionRowByKind('powershell')
  await expect(powershellRow).toHaveCount(1, { timeout: 20_000 })
  await expect(powershellRow.locator('.session-status')).toHaveText('Running', { timeout: 20_000 })
  await expect(visibleBypassWarnings()).toHaveCount(0)

  // Regression guard: a freshly created session's terminal must own keyboard focus, so
  // typing works immediately WITHOUT clicking into the terminal first. (No Enter pressed:
  // the guarded behavior is keystroke echo, not command execution or first-input titling.)
  await window.keyboard.type('CODEFLY_FOCUS_CHECK')
  await expect(window.locator('.terminal-pane:visible .xterm-rows')).toContainText('CODEFLY_FOCUS_CHECK', { timeout: 20_000 })

  // Regression guard: the terminal's rendered screen must sit at the TOP of its host and stay
  // inside it. Without xterm.css, the viewport layer participates in normal flow and pushes
  // .xterm-screen below the host (prompt clipped at the window's bottom edge — reported as
  // "cannot see the input line"). Text-based assertions cannot catch this: the DOM text is
  // present either way, so this must check geometry.
  const hostBox = await window.locator('.terminal-pane:visible .terminal-instance-host').boundingBox()
  const screenBox = await window.locator('.terminal-pane:visible .xterm-screen').boundingBox()
  expect(hostBox).not.toBeNull()
  expect(screenBox).not.toBeNull()
  expect(Math.abs(screenBox!.y - hostBox!.y)).toBeLessThan(16)
  expect(screenBox!.y + screenBox!.height).toBeLessThanOrEqual(hostBox!.y + hostBox!.height + 2)

  await window.getByRole('button', { name: 'New session' }).click()
  await window.locator('.session-launcher').getByRole('button', { name: 'Command Prompt', exact: true }).click()
  const cmdRow = sessionRowByKind('cmd')
  await expect(cmdRow).toHaveCount(1, { timeout: 20_000 })
  await expect(cmdRow.locator('.session-status')).toHaveText('Running', { timeout: 20_000 })
  await expect(visibleBypassWarnings()).toHaveCount(0)
})

test('stopping and relaunching the app preserves sessions as stopped, and clicking one restores it', async () => {
  await electronApp.close()

  const relaunched = await launchApp()
  electronApp = relaunched.app
  window = relaunched.page

  await expect(window.locator('[data-project-row]')).toHaveCount(1, { timeout: 20_000 })
  await expect(window.locator('.session-row')).toHaveCount(4, { timeout: 20_000 })

  const rows = window.locator('.session-row')
  for (let index = 0; index < 4; index += 1) {
    await expect(rows.nth(index).locator('.session-status')).toHaveText('Click to restore')
  }

  const powershellRow = sessionRowByKind('powershell')
  await powershellRow.locator('.session-row-content').click()
  await expect(powershellRow.locator('.session-status')).toHaveText('Running', { timeout: 20_000 })
  await expect(powershellRow.locator('.session-row-content')).toHaveAttribute('aria-current', 'true')

  // Regression guard: restoring a session must also hand keyboard focus to its terminal —
  // this exact flow (relaunch, click to restore, start typing) is where the missing focus
  // was reported as "cannot type".
  await window.keyboard.type('CODEFLY_RESTORE_FOCUS_CHECK')
  await expect(window.locator('.terminal-pane:visible .xterm-rows')).toContainText('CODEFLY_RESTORE_FOCUS_CHECK', { timeout: 20_000 })
})

test('mocked VS Code and Explorer project-row actions do not toggle the row or change the active session', async () => {
  const activeRowBefore = window.locator('.session-row-content[aria-current="true"]')
  const activeKindBefore = await activeRowBefore.locator('.session-kind-icon').getAttribute('data-kind')
  expect(activeKindBefore).not.toBeNull()
  // The expand control is gone (project groups are an accordion on activation): "not
  // toggling the row" now means the session list stays visible and the active session
  // unchanged after each project-row action.
  const sessionRowCount = await window.locator('.session-row').count()
  expect(sessionRowCount).toBeGreaterThan(0)

  await window.getByRole('button', { name: 'Open project in VS Code' }).click()
  await expect(window.locator('.sidebar-notice')).toHaveCount(0)
  await expect(window.locator('.session-row')).toHaveCount(sessionRowCount)
  await expect(window.locator('.session-row-content[aria-current="true"] .session-kind-icon')).toHaveAttribute('data-kind', activeKindBefore!)

  await window.getByRole('button', { name: 'Open project folder' }).click()
  await expect(window.locator('.sidebar-notice')).toHaveCount(0)
  await expect(window.locator('.session-row')).toHaveCount(sessionRowCount)
  await expect(window.locator('.session-row-content[aria-current="true"] .session-kind-icon')).toHaveAttribute('data-kind', activeKindBefore!)
})

test('blocks deleting a dirty worktree, then deletes cleanly and retains the branch', async () => {
  const cmdRow = sessionRowByKind('cmd')
  const worktreeName = (await cmdRow.locator('.session-secondary').textContent())?.trim()
  expect(worktreeName).toMatch(/^worktree-\d{6}-4$/)
  const worktreePath = join(repoPath, '.worktrees', worktreeName!)
  expect(existsSync(worktreePath)).toBe(true)

  const scratchFile = join(worktreePath, 'scratch.txt')
  writeFileSync(scratchFile, 'uncommitted change from the E2E test\n', 'utf8')

  await cmdRow.locator('.session-delete').click()
  const confirmDialog = window.getByRole('alertdialog')
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: 'Delete' }).click()

  await expect(window.locator('.sidebar-notice')).toContainText(/changed files/i, { timeout: 20_000 })
  await expect(sessionRowByKind('cmd')).toHaveCount(1)
  expect(existsSync(worktreePath)).toBe(true)

  await window.getByRole('button', { name: 'Dismiss notice' }).click()
  rmSync(scratchFile)

  await cmdRow.locator('.session-delete').click()
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: 'Delete' }).click()

  await expect(sessionRowByKind('cmd')).toHaveCount(0, { timeout: 20_000 })
  expect(existsSync(worktreePath)).toBe(false)

  const branches = execFileSync('git', ['-C', repoPath, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' })
  expect(branches.split(/\r?\n/u).map((line) => line.trim())).toContain(worktreeName)
})
