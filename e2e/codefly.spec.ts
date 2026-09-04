import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 * The 18 tests below run in one serial journey against one fixture repository/project so
 * that worktree sequence numbers, title generation, restart persistence, and deletion all
 * build on realistic prior state, the same way a user would experience them. Test 6
 * (relaunch) closes and re-opens the Electron app in the middle of the journey while keeping
 * the same --user-data-dir and resident pty-host, so the remaining tests continue against the
 * same live sessions in the relaunched window.
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
 *   8  Relaunch, reattach to the same live PTYs                 -> test 6
 *   9  Mocked VS Code/Explorer actions don't toggle the row    -> test 7
 *  10  Dirty worktree blocks delete                            -> test 8
 *  11  Clean delete removes the directory, retains the branch  -> test 8
 *
 * Session kinds are configured per kind in Settings (enabled, and whether the launcher also
 * offers a "(new worktree)" entry). The defaults are the ones asserted here: all four kinds
 * enabled, worktrees on for Claude/Codex and off for the shells — so the Claude and Codex
 * sessions below are created from their worktree entries, PowerShell runs ordinary in the
 * project directory, and Command Prompt only becomes a worktree session after its switch is
 * turned on in Settings.
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
let hostPidLog: string
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
      CODEFLY_E2E_TITLE_ARGV_LOG: titleArgvLog,
      CODEFLY_E2E_HOST_PID_LOG: hostPidLog,
      CODEFLY_PTY_HOST_IDLE_MS: '250'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const terminateUiProcess = async (app: ElectronApplication): Promise<void> => {
  const uiPid = await app.evaluate(() => process.pid)
  await app.evaluate(({ app }) => {
    setImmediate(() => app.exit(0))
  })
  await expect.poll(() => isProcessRunning(uiPid), { timeout: 10_000 }).toBe(false)
}

const readJsonArgvLog = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

const sessionRowByKind = (kind: 'powershell' | 'cmd' | 'claude' | 'codex') =>
  window.locator('.session-row', { has: window.locator(`.session-kind-icon[data-kind="${kind}"]`) })

const projectOptionsTrigger = () => window.getByRole('button', { name: /^Project options for / })

const openProjectOptions = async () => {
  await projectOptionsTrigger().click()
  return window.getByRole('menu', { name: /^Project options for / })
}

const openNewSessionLauncher = async () => {
  const menu = await openProjectOptions()
  await menu.getByRole('menuitem', { name: 'New session' }).click()
  return window.locator('.session-launcher')
}

// The bypass disclosure is a single compact badge in the active session's terminal header
// (TerminalWorkspace.tsx's TerminalHeader). Every session that has ever been made active
// keeps its terminal pane — and thus its header — mounted in the DOM, just hidden
// (display:none on the pane) while inactive, so a still-running-but-inactive Claude/Codex
// session's header would inflate a raw, non-visibility filtered DOM count. Only the
// currently ACTIVE session's pane is ever visible, so filtering to :visible pins this to
// exactly what the user can see: 1 badge when the active session is a running Claude/Codex
// session, 0 otherwise (including while a running Claude/Codex session isn't the active one).
const visibleBypassWarnings = () => window.locator('.terminal-header-bypass:visible')

// The active pane's rendered screen, read out of xterm's own buffer. It CANNOT be read from
// the DOM: TerminalWorkspace loads the WebGL renderer (so Block Elements — the pixel art
// agents draw their logos with — join seamlessly instead of showing hairline cracks), and
// that renderer paints into a canvas, leaving no .xterm-rows text behind. The pane's host
// element carries a `codeflyTerminal` back-reference for exactly this purpose.
const visibleTerminalText = (): Promise<string> =>
  window.locator('.terminal-pane:visible .terminal-instance-host').evaluate((host) => {
    const terminal = (host as HTMLElement & { codeflyTerminal?: { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).codeflyTerminal
    if (!terminal) return ''
    const buffer = terminal.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  })

const expectVisibleTerminalToContain = async (text: string): Promise<void> => {
  await expect.poll(visibleTerminalText, { timeout: 20_000 }).toContain(text)
}

test.beforeAll(async () => {
  repoPath = createRepo()
  userDataDir = mkdtempSync(join(tmpdir(), 'codefly-e2e-userdata-'))
  const logsDir = mkdtempSync(join(tmpdir(), 'codefly-e2e-logs-'))
  terminalArgvLog = join(logsDir, 'terminal-argv.json')
  titleArgvLog = join(logsDir, 'title-argv.json')
  hostPidLog = join(logsDir, 'pty-host.pid')

  const launched = await launchApp()
  electronApp = launched.app
  window = launched.page
})

test.afterAll(async () => {
  try {
    // Explicitly removing the project ends every PTY before the short E2E idle deadline lets
    // the detached host exit. Without this, Playwright correctly sees the keepalive process
    // still running and waits for its worker forever.
    if (window && !window.isClosed()) {
      await window.evaluate(async () => {
        const snapshot = await window.codefly.getSnapshot()
        for (const project of snapshot.state.projects) await window.codefly.removeProject(project.id)
      })
    }
  } finally {
    await electronApp?.close()
  }
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

/**
 * Pinning is the one title-bar control whose entire effect lives in the main process, so this
 * reads the real BrowserWindow flag rather than trusting the button. It is unpinned again at
 * the end: the preference persists in the shared user-data dir, and an always-on-top window
 * would hover over everything else the rest of the journey opens.
 */
test('pins the window on top from the title bar and unpins it again', async () => {
  const isAlwaysOnTop = (): Promise<boolean> =>
    electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop() ?? false)
  const pin = window.getByRole('button', { name: 'Keep window on top' })
  const pinned = window.getByRole('button', { name: 'Stop keeping window on top' })

  expect(await isAlwaysOnTop()).toBe(false)

  await pin.click()
  await expect(pinned).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(isAlwaysOnTop).toBe(true)
  expect(await window.evaluate(() => window.localStorage.getItem('codefly.windowPinned'))).toBe('true')

  await pinned.click()
  await expect(pin).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(isAlwaysOnTop).toBe(false)
  expect(await window.evaluate(() => window.localStorage.getItem('codefly.windowPinned'))).toBe('false')
})

/**
 * The splitter between the sidebar and the workspace is driven through Chromium's real input
 * pipeline (pointer capture, the grid track clamp) rather than synthetic React events. The
 * width is put back to its default at the end so the later tests — which position popovers
 * against the sidebar's scrollport — see the layout they were written against.
 */
test('resizes the sidebar by dragging the splitter and restores the default on double-click', async () => {
  const sidebar = window.locator('.project-sidebar')
  const workspace = window.locator('.app-main')
  const splitter = window.getByRole('separator', { name: 'Resize sidebar' })

  const initial = (await sidebar.boundingBox())!
  expect(Math.round(initial.width)).toBe(300)
  await expect(splitter).toHaveAttribute('aria-valuenow', '300')

  const handleBox = (await splitter.boundingBox())!
  const startX = handleBox.x + handleBox.width / 2
  const y = handleBox.y + handleBox.height / 2
  await window.mouse.move(startX, y)
  await window.mouse.down()
  await window.mouse.move(startX + 120, y, { steps: 8 })
  // Mid-drag the body carries the resize marker that switches the cursor and suspends
  // terminal hit-testing.
  await expect(window.locator('body')).toHaveAttribute('data-sidebar-resizing', 'true')
  await window.mouse.up()
  await expect(window.locator('body')).not.toHaveAttribute('data-sidebar-resizing', 'true')

  const widened = (await sidebar.boundingBox())!
  expect(Math.round(widened.width)).toBe(420)
  expect(Math.round((await workspace.boundingBox())!.x)).toBe(Math.round(widened.x + 420))
  await expect(splitter).toHaveAttribute('aria-valuenow', '420')
  expect(await window.evaluate(() => window.localStorage.getItem('codefly.sidebarWidth'))).toBe('420')

  await splitter.dblclick()
  expect(Math.round((await sidebar.boundingBox())!.width)).toBe(300)
  expect(await window.evaluate(() => window.localStorage.getItem('codefly.sidebarWidth'))).toBe('300')
})

/**
 * The startup switch, update check, and About links all read through the main process. Under
 * CODEFLY_E2E their seams are test doubles (in-memory login item, an offline 404 for the
 * GitHub release endpoint, a no-op openExternal — see buildE2EAppInfoService), so the real
 * IPC, schema validation, and result mapping still run while nothing touches the registry or
 * the network. The language switch must be returned to English before this test ends: the
 * preference persists in the user-data dir, and every later assertion is English copy.
 */
test('exposes the startup toggle, version check, About links, and language switch in Settings', async () => {
  const trigger = window.getByRole('button', { name: 'Settings' })
  const dialog = window.getByRole('dialog', { name: 'Settings' })

  await trigger.click()
  await expect(dialog).toBeVisible()

  const startup = dialog.getByRole('switch', { name: 'Launch at startup' })
  await expect(startup).toBeEnabled()
  await expect(startup).toHaveAttribute('aria-checked', 'false')
  await startup.click()
  await expect(startup).toHaveAttribute('aria-checked', 'true')
  await startup.click()
  await expect(startup).toHaveAttribute('aria-checked', 'false')

  // The established kinds are offered by default; only the agents default to also offering a
  // worktree. The opt-in agent CLIs are off and collapsed away — see the disclosure test.
  for (const kind of ['PowerShell', 'Command Prompt', 'Claude', 'Codex']) {
    await expect(dialog.getByRole('switch', { name: `Enable ${kind}` })).toHaveAttribute('aria-checked', 'true')
  }
  await expect(dialog.getByRole('switch', { name: 'New worktree for PowerShell' })).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.getByRole('switch', { name: 'New worktree for Claude' })).toHaveAttribute('aria-checked', 'true')

  // Comes from app.getVersion(), so assert the shape rather than pinning a version number.
  await expect(dialog.locator('.settings-version-value')).toHaveText(/^\d+\.\d+\.\d+/)

  await dialog.getByRole('button', { name: 'Check for updates' }).click()
  await expect(dialog.getByRole('status')).toHaveText('No release has been published yet.')

  // About rows print their label and a chain glyph; the URL only ever appears as the tooltip.
  await expect(dialog.getByRole('button', { name: 'Project repository' })).toHaveAttribute(
    'title',
    'https://github.com/denggaopan/codefly'
  )
  await expect(dialog.getByRole('button', { name: 'Changelog' })).toHaveAttribute(
    'title',
    'https://github.com/denggaopan/codefly/releases'
  )
  await expect(dialog.getByRole('button', { name: 'Downloads' })).toHaveAttribute(
    'title',
    'https://github.com/denggaopan/codefly/releases/latest'
  )
  await expect(dialog.getByText('https://github.com/denggaopan/codefly', { exact: true })).toHaveCount(0)

  await dialog.getByRole('button', { name: '简体中文' }).click()
  await expect(window.getByRole('dialog', { name: '设置' })).toBeVisible()
  await expect(window.getByRole('switch', { name: '开机自动启动' })).toBeVisible()
  // The whole window re-renders, not just the dialog.
  await expect(window.getByPlaceholder('搜索会话')).toBeVisible()

  await window.getByRole('button', { name: 'English' }).click()
  await expect(window.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(window.getByPlaceholder('Search sessions')).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})


test('adds the fixture project and creates a Claude session as the first worktree', async () => {
  await window.getByRole('button', { name: 'Add Project' }).click()
  await expect(window.locator('[data-project-row]')).toHaveCount(1, { timeout: 20_000 })

  const launcher = await openNewSessionLauncher()
  // Both Claude entries are offered by default; this journey wants the worktree one.
  await expect(launcher.getByRole('button', { name: 'Claude', exact: true })).toBeVisible()
  await launcher.getByRole('button', { name: 'Claude (new worktree)', exact: true }).click()

  const claudeRow = sessionRowByKind('claude')
  await expect(claudeRow).toHaveCount(1, { timeout: 20_000 })
  await expect(claudeRow.locator('.session-secondary')).toHaveText(/^worktree-\d{6}-1$/)
  await expectVisibleTerminalToContain('CODEFLY_E2E_FAKE_AGENT_READY')
})

// Agents draw their startup logos as pixel art out of Block Elements (U+2588 and the quadrant
// characters). xterm's default DOM renderer lays cells out on a fractional CSS grid and paints
// those code points with the font's glyphs, so neighbouring cells cannot meet on a device-pixel
// boundary and hairline background-coloured seams run through the artwork — reported as cracks
// in the Claude Code logo. The WebGL renderer sizes cells in whole device pixels and draws
// those code points from its own vector glyph table, which is what this pins down. It also
// confirms that a real Electron renderer process actually gets a WebGL2 context: activation
// failure is deliberately silent (TerminalWorkspace falls back to the DOM renderer), so
// without this assertion the cracks could come back unnoticed.
test('renders the terminal through the WebGL renderer so Block Elements have no seams', async () => {
  const pane = window.locator('.terminal-pane:visible')
  await expect(pane.locator('.xterm-screen canvas')).not.toHaveCount(0)
  // The DOM renderer's text rows are the tell-tale of a silent fallback.
  await expect(pane.locator('.xterm-rows')).toHaveCount(0)

  // The WebGL renderer on its own still is not enough. It composes U+259B (▛) — the character
  // Claude Code's logo draws its head from — out of two rectangles that MEET at
  // deviceCellWidth / 2 rather than overlapping. On an ODD cell width that join lands on a
  // half pixel: both fillRects anti-alias into the same pixel column and the two 50% passes
  // composite to 75%, leaking a hairline of the cell's black background down through solid
  // orange (measured at 13 device pixels wide — Cascadia Mono at 150% scaling — before the
  // fix). TerminalWorkspace nudges the grid onto an even width with one device pixel of
  // letterSpacing; this is the only place that check runs against real font metrics and a
  // real device pixel ratio. See src/renderer/src/terminal/block-glyph-alignment.ts.
  const deviceCellWidth = await pane.locator('.terminal-instance-host').evaluate((host) => {
    const canvas = host.querySelector('.xterm-screen canvas')
    const terminal = (host as HTMLElement & { codeflyTerminal?: { cols: number } }).codeflyTerminal
    if (!(canvas instanceof HTMLCanvasElement) || !terminal) return Number.NaN
    return canvas.width / terminal.cols
  })
  expect(Number.isInteger(deviceCellWidth)).toBe(true)
  expect(deviceCellWidth % 2).toBe(0)
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
  const status = claudeRow.locator('.session-status-dot')
  await expect(status).toHaveAttribute('aria-label', 'Done', { timeout: 20_000 })
  await expect(status).toHaveAttribute('data-status', 'done')
})

test('keeps the terminal workflow usable at the 900 by 600 minimum window size', async () => {
  const { wasMaximized, size } = await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) throw new Error('CodeFly main window is missing')
    // CodeFly opens maximized (see createMainWindow), and a maximized window ignores
    // setSize — so the resize below has to un-maximize first. Asserted rather than merely
    // done, since this is the first test to touch the window frame and no earlier test
    // changes it.
    const maximized = mainWindow.isMaximized()
    mainWindow.unmaximize()
    mainWindow.setSize(900, 600)
    return { wasMaximized: maximized, size: mainWindow.getSize() }
  })
  expect(wasMaximized).toBe(true)
  expect(size[0]).toBeGreaterThanOrEqual(900)
  expect(size[0]).toBeLessThanOrEqual(902)
  expect(size[1]).toBeGreaterThanOrEqual(600)
  expect(size[1]).toBeLessThanOrEqual(602)

  await expect(projectOptionsTrigger()).toHaveCount(1)
  await expect(projectOptionsTrigger()).toBeVisible()
  await expect(window.getByRole('button', { name: 'New session' })).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Open project in VS Code' })).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Open project folder' })).toHaveCount(0)
  await expect(window.locator('.terminal-pane:visible .terminal-instance-host')).toBeVisible()
  await expect(visibleBypassWarnings()).toHaveText([BYPASS_WARNING_TEXT])

  const optionsMenu = await openProjectOptions()
  // Five entries: the fixture repository carries a GitHub-shaped `origin`, so the repository
  // action is offered (with the GitHub mark) between the folder action and removal.
  await expect(optionsMenu.getByRole('menuitem')).toHaveText([
    'New session',
    'Open project in VS Code',
    'Open project folder',
    'Open Git repository',
    'Remove from list'
  ])
  // The built bundle inlines the small SVGs as data URIs, so the mark is identified by its
  // styling class: only the GitHub glyph is mono (inverted in the dark theme); GitLab/Git are
  // brand-colored and never carry it.
  await expect(optionsMenu.getByRole('menuitem', { name: 'Open Git repository' }).locator('img')).toHaveClass(/\bicon-mono\b/)
  expect(await optionsMenu.evaluate((element) => getComputedStyle(element).position)).toBe('absolute')
  const darkMenuBackground = await optionsMenu.evaluate((element) => getComputedStyle(element).backgroundColor)
  const [menuBounds, menuViewport] = await Promise.all([
    optionsMenu.boundingBox(),
    window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  ])
  expect(menuBounds).not.toBeNull()
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0)
  expect(menuBounds!.y).toBeGreaterThanOrEqual(0)
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(menuViewport.width)
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(menuViewport.height)

  await window.keyboard.press('Escape')
  await expect(optionsMenu).toHaveCount(0)
  await expect(projectOptionsTrigger()).toBeFocused()

  const settingsTrigger = window.getByRole('button', { name: 'Settings' })
  await settingsTrigger.click()
  const settingsDialog = window.getByRole('dialog', { name: 'Settings' })
  await settingsDialog.getByRole('button', { name: 'Light' }).click()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()

  const lightOptionsMenu = await openProjectOptions()
  const lightMenuBackground = await lightOptionsMenu.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(lightMenuBackground).not.toBe(darkMenuBackground)
  await window.keyboard.press('Escape')

  await settingsTrigger.click()
  await settingsDialog.getByRole('button', { name: 'Dark' }).click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
  await window.keyboard.press('Escape')

  const launcher = await openNewSessionLauncher()
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

  const projectGroup = window.locator('.project-group')
  await projectGroup.evaluate((element) => {
    const scrollport = element.closest<HTMLElement>('.project-groups')
    const row = element.querySelector<HTMLElement>('[data-project-row]')
    if (!scrollport || !row) throw new Error('Project scrollport or row is missing')

    const scrollportRect = scrollport.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const targetTop = scrollportRect.bottom - rowRect.height - 2
    element.style.marginTop = `${Math.max(0, targetTop - rowRect.top)}px`
  })
  await expect(projectOptionsTrigger()).toBeVisible()

  const lowerRowOptionsMenu = await openProjectOptions()
  await expect(lowerRowOptionsMenu).toHaveAttribute('data-placement', 'above')
  const [lowerMenuBounds, scrollportBounds] = await Promise.all([
    lowerRowOptionsMenu.boundingBox(),
    window.locator('.project-groups').boundingBox()
  ])
  expect(lowerMenuBounds).not.toBeNull()
  expect(scrollportBounds).not.toBeNull()
  expect(lowerMenuBounds!.x).toBeGreaterThanOrEqual(scrollportBounds!.x)
  expect(lowerMenuBounds!.y).toBeGreaterThanOrEqual(scrollportBounds!.y)
  expect(lowerMenuBounds!.x + lowerMenuBounds!.width).toBeLessThanOrEqual(scrollportBounds!.x + scrollportBounds!.width)
  expect(lowerMenuBounds!.y + lowerMenuBounds!.height).toBeLessThanOrEqual(scrollportBounds!.y + scrollportBounds!.height)

  await window.keyboard.press('Escape')
  await expect(lowerRowOptionsMenu).toHaveCount(0)
  await projectGroup.evaluate((element) => element.style.removeProperty('margin-top'))

  const scrollDismissMenu = await openProjectOptions()
  const scrollState = await projectGroup.evaluate((element) => {
    const scrollport = element.closest<HTMLElement>('.project-groups')
    const row = element.querySelector<HTMLElement>('[data-project-row]')
    const trigger = element.querySelector<HTMLElement>('.project-options-trigger')
    if (!scrollport || !row || !trigger) throw new Error('Project scrollport, row, or options trigger is missing')

    const originalPaddingBottom = element.style.paddingBottom
    const originalScrollTop = scrollport.scrollTop
    element.style.paddingBottom = `${scrollport.clientHeight}px`
    const scrollportRect = scrollport.getBoundingClientRect()
    const triggerRect = trigger.getBoundingClientRect()
    scrollport.scrollTop += Math.ceil(triggerRect.bottom - scrollportRect.top)

    const rowAfterScroll = row.getBoundingClientRect()
    const triggerAfterScroll = trigger.getBoundingClientRect()
    const scrollportAfterScroll = scrollport.getBoundingClientRect()
    scrollport.dispatchEvent(new Event('scroll'))
    return {
      originalPaddingBottom,
      originalScrollTop,
      rowIntersects:
        rowAfterScroll.bottom > scrollportAfterScroll.top && rowAfterScroll.top < scrollportAfterScroll.bottom,
      triggerFullyOutside:
        triggerAfterScroll.bottom <= scrollportAfterScroll.top || triggerAfterScroll.top >= scrollportAfterScroll.bottom
    }
  })
  try {
    expect(scrollState.rowIntersects).toBe(true)
    expect(scrollState.triggerFullyOutside).toBe(true)
    await expect(scrollDismissMenu).toHaveCount(0)
  } finally {
    await projectGroup.evaluate((element, state) => {
      const scrollport = element.closest<HTMLElement>('.project-groups')
      if (!scrollport) throw new Error('Project scrollport is missing')

      element.style.paddingBottom = state.originalPaddingBottom
      scrollport.scrollTop = state.originalScrollTop
      scrollport.dispatchEvent(new Event('scroll'))
    }, scrollState)
  }

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

test('Ctrl+V pastes the clipboard text into the Claude session instead of sending ^V', async () => {
  // xterm's own key handling turns Ctrl+V into a literal ^V byte, which neither Claude nor
  // Codex treats as "paste text". Agent sessions hand the key back to the browser so its
  // native paste event feeds xterm's paste path (see terminal-key-bindings.ts). The fake agent
  // echoes its stdin, so the text can only appear on screen if the clipboard reached the PTY.
  const previousClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('CODEFLY_PASTE_CHECK'))
  try {
    await window.locator('.terminal-pane:visible .terminal-instance-host').click()
    await window.keyboard.press('Control+V')
    await expectVisibleTerminalToContain('CODEFLY_PASTE_CHECK')
  } finally {
    await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard)
  }
})

test('creates a Codex session as the second worktree, receiving exactly its own bypass flag', async () => {
  const launcher = await openNewSessionLauncher()
  await launcher.getByRole('button', { name: 'Codex (new worktree)', exact: true }).click()

  const codexRow = sessionRowByKind('codex')
  await expect(codexRow).toHaveCount(1, { timeout: 20_000 })
  await expect(codexRow.locator('.session-secondary')).toHaveText(/^worktree-\d{6}-2$/)

  await expect
    .poll(() => (existsSync(terminalArgvLog) ? readJsonArgvLog(terminalArgvLog) : undefined), { timeout: 20_000 })
    .toEqual(['--dangerously-bypass-approvals-and-sandbox'])

  await expect(visibleBypassWarnings()).toHaveText([BYPASS_WARNING_TEXT])
})

test('creates PowerShell and Command Prompt sessions with the bypass warning absent', async () => {
  const powershellLauncher = await openNewSessionLauncher()
  // A shell defaults to worktrees off, so it has exactly one entry and runs in the project
  // directory itself — no branch is created for a quick terminal.
  await expect(powershellLauncher.getByRole('button', { name: /^PowerShell/ })).toHaveCount(1)
  await powershellLauncher.getByRole('button', { name: 'PowerShell', exact: true }).click()
  const powershellRow = sessionRowByKind('powershell')
  await expect(powershellRow).toHaveCount(1, { timeout: 20_000 })
  await expect(powershellRow.locator('.session-status-dot')).toHaveAttribute('data-status', 'running', { timeout: 20_000 })
  await expect(powershellRow.locator('.session-secondary')).toHaveText('Ordinary session')
  await expect(visibleBypassWarnings()).toHaveCount(0)

  // Regression guard: a freshly created session's terminal must own keyboard focus, so
  // typing works immediately WITHOUT clicking into the terminal first. (No Enter pressed:
  // the guarded behavior is keystroke echo, not command execution or first-input titling.)
  await window.keyboard.type('CODEFLY_FOCUS_CHECK')
  await expectVisibleTerminalToContain('CODEFLY_FOCUS_CHECK')

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

  // Turning Command Prompt's worktree switch on adds its second launcher entry; the delete
  // test further down needs a real worktree session to work with.
  const settingsTrigger = window.getByRole('button', { name: 'Settings' })
  const settingsDialog = window.getByRole('dialog', { name: 'Settings' })
  await settingsTrigger.click()
  await settingsDialog.getByRole('switch', { name: 'New worktree for Command Prompt' }).click()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  const cmdLauncher = await openNewSessionLauncher()
  await cmdLauncher.getByRole('button', { name: 'Command Prompt (new worktree)', exact: true }).click()
  const cmdRow = sessionRowByKind('cmd')
  await expect(cmdRow).toHaveCount(1, { timeout: 20_000 })
  await expect(cmdRow.locator('.session-status-dot')).toHaveAttribute('data-status', 'running', { timeout: 20_000 })
  await expect(visibleBypassWarnings()).toHaveCount(0)
})

test('removes a session kind from the launcher while its Settings switch is off', async () => {
  const settingsTrigger = window.getByRole('button', { name: 'Settings' })
  const settingsDialog = window.getByRole('dialog', { name: 'Settings' })

  await settingsTrigger.click()
  const codexEnabled = settingsDialog.getByRole('switch', { name: 'Enable Codex' })
  await codexEnabled.click()
  await expect(codexEnabled).toHaveAttribute('aria-checked', 'false')
  // A kind that is not offered cannot offer a worktree variant either.
  await expect(settingsDialog.getByRole('switch', { name: 'New worktree for Codex' })).toBeDisabled()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()

  const launcher = await openNewSessionLauncher()
  await expect(launcher.getByRole('button', { name: /^Codex/ })).toHaveCount(0)
  await expect(launcher.getByRole('button', { name: 'Claude', exact: true })).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(launcher).toHaveCount(0)

  // Restored for the rest of the journey: the switch persists in the user-data dir.
  await settingsTrigger.click()
  await codexEnabled.click()
  await expect(codexEnabled).toHaveAttribute('aria-checked', 'true')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()

  const restoredLauncher = await openNewSessionLauncher()
  await expect(restoredLauncher.getByRole('button', { name: 'Codex (new worktree)', exact: true })).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(restoredLauncher).toHaveCount(0)
})

/**
 * The opt-in agent CLIs (Gemini, GitHub Copilot, Cursor, Comate, Qwen Code) ship switched off
 * and collapsed behind a disclosure, so a fresh install still shows the same four switches and
 * the same launcher entries it always did. Turning one on gives it both launcher entries, since
 * its worktree switch defaults on.
 *
 * Deliberately does NOT create a session: the worktree sequence numbers other tests pin
 * (Claude=1, Codex=2, cmd=3) would shift. Both switches are restored before the test ends.
 */
test('keeps the opt-in agent CLIs collapsed and off until enabled in Settings', async () => {
  const settingsTrigger = window.getByRole('button', { name: 'Settings' })
  const settingsDialog = window.getByRole('dialog', { name: 'Settings' })

  await settingsTrigger.click()
  const disclosure = settingsDialog.getByRole('button', { name: 'More agent CLIs (5)' })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  for (const kind of ['Gemini', 'GitHub Copilot', 'Cursor', 'Comate', 'Qwen Code']) {
    await expect(settingsDialog.getByRole('switch', { name: `Enable ${kind}` })).toHaveCount(0)
  }

  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  for (const kind of ['Gemini', 'GitHub Copilot', 'Cursor', 'Comate', 'Qwen Code']) {
    await expect(settingsDialog.getByRole('switch', { name: `Enable ${kind}` })).toHaveAttribute('aria-checked', 'false')
    await expect(settingsDialog.getByRole('switch', { name: `New worktree for ${kind}` })).toBeDisabled()
  }

  const geminiEnabled = settingsDialog.getByRole('switch', { name: 'Enable Gemini' })
  await geminiEnabled.click()
  await expect(geminiEnabled).toHaveAttribute('aria-checked', 'true')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()

  // Enabled kinds are appended after the established ones, and the worktree default gives it
  // a second entry immediately.
  const launcher = await openNewSessionLauncher()
  await expect(launcher.getByRole('button', { name: 'Gemini', exact: true })).toBeVisible()
  await expect(launcher.getByRole('button', { name: 'Gemini (new worktree)', exact: true })).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(launcher).toHaveCount(0)

  // Reopening always starts collapsed, enabled kind or not: Settings leads with the four
  // established kinds and the opt-in group stays one caret click away. Turning Gemini back
  // off restores the state the rest of the journey expects.
  await settingsTrigger.click()
  await expect(settingsDialog.getByRole('button', { name: 'More agent CLIs (5)' })).toHaveAttribute('aria-expanded', 'false')
  await settingsDialog.getByRole('button', { name: 'More agent CLIs (5)' }).click()
  await settingsDialog.getByRole('switch', { name: 'Enable Gemini' }).click()
  await expect(settingsDialog.getByRole('switch', { name: 'Enable Gemini' })).toHaveAttribute('aria-checked', 'false')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
})

test('relaunches onto the same pty-host and keeps every session interactive', async () => {
  const powershellRowBefore = sessionRowByKind('powershell')
  await powershellRowBefore.locator('.session-row-content').click()
  // The earlier focus test deliberately left text at this prompt. Clear it so this marker
  // stays on one xterm row and a visual line wrap cannot turn a substring check into noise.
  await window.keyboard.press('Control+C')
  await window.keyboard.type('KEEPALIVE')
  await expectVisibleTerminalToContain('KEEPALIVE')
  await expect.poll(() => (existsSync(hostPidLog) ? Number(readFileSync(hostPidLog, 'utf8')) : 0)).toBeGreaterThan(0)
  const originalHostPid = Number(readFileSync(hostPidLog, 'utf8'))

  // Playwright's graceful close waits for every process in Electron's Windows job, including
  // the resident host whose survival is the assertion. Terminating only the UI process models
  // the crash/forced-close path and lets the next application attach to that same host.
  await terminateUiProcess(electronApp)

  const relaunched = await launchApp()
  electronApp = relaunched.app
  window = relaunched.page

  await expect(window.locator('[data-project-row]')).toHaveCount(1, { timeout: 20_000 })
  await expect(window.locator('.session-row')).toHaveCount(4, { timeout: 20_000 })

  const rows = window.locator('.session-row')
  for (let index = 0; index < 4; index += 1) {
    await expect(rows.nth(index).locator('.session-status-dot')).toHaveAttribute('data-status', 'running')
  }
  await expect.poll(() => (existsSync(hostPidLog) ? Number(readFileSync(hostPidLog, 'utf8')) : 0)).toBe(originalHostPid)

  // The session-kind switches live in the renderer's localStorage inside --user-data-dir, so
  // the Command Prompt worktree switch turned on earlier must still be on after the relaunch.
  await window.getByRole('button', { name: 'Settings' }).click()
  const relaunchedSettings = window.getByRole('dialog', { name: 'Settings' })
  await expect(relaunchedSettings.getByRole('switch', { name: 'New worktree for Command Prompt' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await window.keyboard.press('Escape')
  await expect(relaunchedSettings).toHaveCount(0)

  const powershellRow = sessionRowByKind('powershell')
  await powershellRow.locator('.session-row-content').click()
  await expect(powershellRow.locator('.session-row-content')).toHaveAttribute('aria-current', 'true')
  await expectVisibleTerminalToContain('KEEPALIVE')

  // Reattachment must also hand keyboard focus to the adopted terminal, and input must reach
  // the original PTY rather than a replacement process.
  await window.keyboard.type('_AFTER')
  await expectVisibleTerminalToContain('KEEPALIVE_AFTER')
})

test('mocked VS Code, Explorer, and repository project-row actions do not toggle the row or change the active session', async () => {
  const activeRowBefore = window.locator('.session-row-content[aria-current="true"]')
  const activeKindBefore = await activeRowBefore.locator('.session-kind-icon').getAttribute('data-kind')
  expect(activeKindBefore).not.toBeNull()
  // The expand control is gone (project groups are an accordion on activation): "not
  // toggling the row" now means the session list stays visible and the active session
  // unchanged after each project-row action.
  const sessionRowCount = await window.locator('.session-row').count()
  expect(sessionRowCount).toBeGreaterThan(0)

  const vscodeMenu = await openProjectOptions()
  await vscodeMenu.getByRole('menuitem', { name: 'Open project in VS Code' }).click()
  await expect(window.locator('.sidebar-notice')).toHaveCount(0)
  await expect(window.locator('.session-row')).toHaveCount(sessionRowCount)
  await expect(window.locator('.session-row-content[aria-current="true"] .session-kind-icon')).toHaveAttribute('data-kind', activeKindBefore!)

  const explorerMenu = await openProjectOptions()
  await explorerMenu.getByRole('menuitem', { name: 'Open project folder' }).click()
  await expect(window.locator('.sidebar-notice')).toHaveCount(0)
  await expect(window.locator('.session-row')).toHaveCount(sessionRowCount)
  await expect(window.locator('.session-row-content[aria-current="true"] .session-kind-icon')).toHaveAttribute('data-kind', activeKindBefore!)

  // The repository action resolves the fixture's `origin` in the main process and hands the
  // derived https URL to the (mocked) browser: no notice means it was accepted end to end.
  const repositoryMenu = await openProjectOptions()
  await repositoryMenu.getByRole('menuitem', { name: 'Open Git repository' }).click()
  await expect(window.locator('.sidebar-notice')).toHaveCount(0)
  await expect(window.locator('.session-row')).toHaveCount(sessionRowCount)
  await expect(window.locator('.session-row-content[aria-current="true"] .session-kind-icon')).toHaveAttribute('data-kind', activeKindBefore!)
})

test('blocks deleting a dirty worktree, then deletes cleanly and retains the branch', async () => {
  const cmdRow = sessionRowByKind('cmd')
  // Third worktree, not fourth: the PowerShell session runs ordinary in the project directory.
  const worktreeName = (await cmdRow.locator('.session-secondary').textContent())?.trim()
  expect(worktreeName).toMatch(/^worktree-\d{6}-3$/)
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

/**
 * The in-app update journey, driven against a second Electron instance with its own
 * user-data directory. CODEFLY_E2E_RELEASE (see src/main/index.ts) supplies one published
 * release offline and CODEFLY_E2E_INSTALL_LOG records the installer that would have been
 * executed — those two seams, plus the process spawn, are the only substitutions: the SemVer
 * comparison, the asset picker, the GitHub host allowlist, the streamed write, the size check
 * and the `.part` rename are all the real production code, writing into a real directory.
 *
 * It runs in its own instance because the startup check fires once per launch, and a modal
 * update dialog on the shared window would block every other test in the journey.
 */
test('prompts on startup, downloads the installer in-app, and launches it on demand', async () => {
  const updaterUserDataDir = mkdtempSync(join(tmpdir(), 'codefly-e2e-update-'))
  const installLog = join(updaterUserDataDir, 'install-launch.log')
  const installerName = 'CodeFly-Setup-99.0.0-win-x64.exe'
  const installerBytes = 512 * 1024
  const release = {
    tag_name: 'v99.0.0',
    html_url: 'https://github.com/denggaopan/codefly/releases/tag/v99.0.0',
    assets: [
      {
        name: installerName,
        size: installerBytes,
        browser_download_url: `https://github.com/denggaopan/codefly/releases/download/v99.0.0/${installerName}`
      }
    ]
  }

  const updaterApp = await electron.launch({
    args: ['.', `--user-data-dir=${updaterUserDataDir}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEFLY_E2E: '1',
      CODEFLY_E2E_PROJECT: repoPath,
      CODEFLY_E2E_AGENT_CMD: fakeAgentCmd,
      CODEFLY_E2E_RELEASE: JSON.stringify(release),
      CODEFLY_E2E_INSTALL_LOG: installLog,
      CODEFLY_PTY_HOST_IDLE_MS: '250'
    }
  })

  try {
    const page = await updaterApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Nothing is clicked to get here: the startup check raises the dialog by itself.
    const updateDialog = page.getByRole('alertdialog')
    await expect(updateDialog).toContainText('Version 99.0.0 is available', { timeout: 20_000 })

    // "Later" must leave no trace — no dialog, and nothing downloaded.
    await updateDialog.getByRole('button', { name: 'Later' }).click()
    await expect(updateDialog).toHaveCount(0)
    const installerPath = join(updaterUserDataDir, 'updates', installerName)
    expect(existsSync(installerPath)).toBe(false)

    // The same flow is reachable on demand from Settings, which hands off and closes itself.
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
    await page.getByRole('button', { name: 'Settings' }).click()
    await settingsDialog.getByRole('button', { name: 'Check for updates' }).click()
    await expect(settingsDialog.getByRole('status')).toContainText('Version 99.0.0 is available.')
    await settingsDialog.getByRole('button', { name: 'Update now' }).click()
    await expect(settingsDialog).toHaveCount(0)

    await expect(updateDialog).toContainText('Version 99.0.0 is ready to install', { timeout: 30_000 })

    // The installer really was streamed to disk, at exactly its declared size.
    expect(existsSync(installerPath)).toBe(true)
    expect(statSync(installerPath).size).toBe(installerBytes)

    await updateDialog.getByRole('button', { name: 'Install now' }).click()
    await expect
      .poll(() => (existsSync(installLog) ? readFileSync(installLog, 'utf8') : null), { timeout: 15_000 })
      .toBe(installerPath)
  } finally {
    await updaterApp.close()
    rmSync(updaterUserDataDir, { recursive: true, force: true })
  }
})
