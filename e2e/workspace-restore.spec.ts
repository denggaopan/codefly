import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

import type { AppState } from '../src/shared/contracts'

const projectRoot = resolve(import.meta.dirname, '..')
const executablePath = process.env.CODEFLY_TEST_EXECUTABLE
const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

for (const exitMode of ['window close', 'forced termination', 'renderer reload'] as const) {
  test(`restores project folds and the active session after ${exitMode}`, async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'codefly-workspace-'))
    const userDataDir = join(fixtureDir, 'userdata')
    mkdirSync(userDataDir)
    const state: AppState = {
      version: 1,
      projects: ['first', 'second', 'third'].map((id) => ({
        id, name: id, path: join(fixtureDir, id), createdAt: '2026-09-05T00:00:00.000Z'
      })),
      sessions: ['first', 'second'].map((projectId) => ({
        id: `session-${projectId}`, projectId, kind: 'claude', title: `Session ${projectId}`,
        titleState: 'complete', mode: 'ordinary', launchPath: join(fixtureDir, projectId),
        createdAt: '2026-09-05T00:00:00.000Z', status: 'running'
      }))
    }
    for (const project of state.projects) mkdirSync(project.path)
    writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(state))
    let app: ElectronApplication | undefined
    let page: Page
    const launch = async () => {
      app = await electron.launch({
        ...(executablePath ? { executablePath } : {}),
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userDataDir}`],
        cwd: projectRoot,
        env: {
          ...process.env, CODEFLY_E2E: '1',
          CODEFLY_E2E_AGENT_CMD: resolve(projectRoot, 'e2e/fixtures/fake-agent.cmd'),
          CODEFLY_PTY_HOST_IDLE_MS: '250'
        }
      })
      page = await app.firstWindow()
      await expect(page.locator('.project-row-label')).toHaveCount(3, { timeout: 20_000 })
    }
    const projectLabel = (id: string) => page.locator(`[aria-controls="project-sessions-${id}"]`)
    const activeTerminal = () => page.getByTestId('terminal-host-session-second')

    try {
      await launch()
      await page.locator('.session-row-content', { hasText: 'Session second' }).click()
      await expect(activeTerminal()).toBeVisible()
      await expect(activeTerminal().locator('textarea')).toBeFocused()
      await page.keyboard.type('WORKSPACE_RESTORE')
      await projectLabel('second').click()
      await projectLabel('third').click()
      await expect(projectLabel('first')).toHaveAttribute('aria-expanded', 'true')
      await expect(projectLabel('second')).toHaveAttribute('aria-expanded', 'false')

      if (exitMode === 'renderer reload') {
        await page.reload()
      } else {
        const uiPid = await app!.evaluate(() => process.pid)
        if (exitMode === 'window close') {
          await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
        } else {
          // Kill the UI and its children with no quit/unload hooks, including Chromium storage.
          execFileSync('taskkill', ['/PID', String(uiPid), '/T', '/F'], { windowsHide: true })
        }
        // Playwright's close event also waits for the resident host's inherited pipes.
        await expect.poll(() => isProcessRunning(uiPid), { timeout: 10_000 }).toBe(false)
        await launch()
      }

      await expect(projectLabel('first')).toHaveAttribute('aria-expanded', 'true')
      await expect(projectLabel('second')).toHaveAttribute('aria-expanded', 'false')
      await expect(projectLabel('third')).toHaveAttribute('aria-expanded', 'false')
      await expect(activeTerminal()).toBeVisible()
      await expect(activeTerminal().locator('textarea')).toBeFocused()
      await page.keyboard.type('_AFTER')
      await expect.poll(() => activeTerminal().evaluate((element) => {
        const terminal = (element as HTMLElement & {
          codeflyTerminal?: { buffer: { active: { length: number; getLine(index: number): { translateToString(trim: boolean): string } | undefined } } }
        }).codeflyTerminal
        const buffer = terminal?.buffer.active
        return buffer ? Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true)).join('\n') : ''
      })).toContain('_AFTER')

      const search = page.getByRole('searchbox', { name: 'Search sessions' })
      await search.fill('Session')
      await expect(projectLabel('second')).toHaveAttribute('aria-expanded', 'true')
      await search.fill('')
      await expect(projectLabel('second')).toHaveAttribute('aria-expanded', 'false')
      await projectLabel('second').click()
      await expect(page.locator('.session-row-content[aria-current="true"]')).toContainText('Session second')
    } finally {
      if (app && app.process().exitCode === null) {
        const cleanupPage = await app.firstWindow()
        await cleanupPage.evaluate(async () => {
          const snapshot = await window.codefly.getSnapshot()
          for (const project of snapshot.state.projects) await window.codefly.removeProject(project.id)
        }).catch(() => undefined)
        await app.close()
      }
    }
  })
}
