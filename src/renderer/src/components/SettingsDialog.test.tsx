// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateCheckResult, UpdateDownloadResult } from '../../../shared/contracts'
import type { ExternalLinkTarget } from '../../../shared/links'
import { defaultSessionKindPreferences } from '../session-kind-options'
import { useAppStore } from '../store/use-app-store'
import SettingsDialog from './SettingsDialog'

const links = {
  repository: 'https://example.test/repo',
  changelog: 'https://example.test/changelog',
  download: 'https://example.test/download'
} as const

// Only the handful of bridge methods this dialog touches are stubbed; the cast keeps the
// fake narrow without widening every vi.fn() to a plain function type (which would cost the
// mock helpers used below). App.test.tsx still type-checks the full CodeFlyApi shape.
const createFakeApi = () => ({
  getAppInfo: vi.fn(async () => ({ version: '9.9.9', links })),
  getAutoLaunch: vi.fn(async () => false),
  setAutoLaunch: vi.fn(async (enabled: boolean) => enabled),
  checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult> => ({ status: 'none', currentVersion: '9.9.9' })),
  openExternalLink: vi.fn(async (_target: ExternalLinkTarget): Promise<void> => undefined),
  downloadUpdate: vi.fn(async (): Promise<UpdateDownloadResult> => ({ status: 'ready', version: '10.0.0', fileName: 'Setup.exe' })),
  setTheme: vi.fn(async () => undefined)
})

type FakeApi = ReturnType<typeof createFakeApi>

const renderDialog = (api: FakeApi = createFakeApi(), onClose: () => void = vi.fn()): FakeApi => {
  window.codefly = api as unknown as typeof window.codefly
  render(<SettingsDialog open onClose={onClose} />)
  return api
}

const availableWithInstaller: UpdateCheckResult = {
  status: 'available',
  currentVersion: '9.9.9',
  latestVersion: '10.0.0',
  releaseUrl: 'https://example.test/release',
  asset: { fileName: 'CodeFly-Setup-10.0.0-win-x64.exe', size: 4096 }
}

describe('SettingsDialog', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    window.localStorage.clear()
  })

  it('shows the startup switch first, reflecting the value the main process reports', async () => {
    const api = renderDialog()

    // Startup leads the dialog: it is the first section after the header.
    const sections = document.querySelectorAll('.settings-dialog-section')
    expect(sections[0]).toHaveTextContent('Launch at startup')

    const toggle = screen.getByRole('switch', { name: 'Launch at startup' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(api.getAutoLaunch).toHaveBeenCalledTimes(1)
  })

  it('persists a startup change and adopts the value read back by the main process', async () => {
    const user = userEvent.setup()
    const api = renderDialog()
    const toggle = screen.getByRole('switch', { name: 'Launch at startup' })
    await waitFor(() => expect(toggle).toBeEnabled())

    await user.click(toggle)

    expect(api.setAutoLaunch).toHaveBeenCalledWith(true)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })

  it('keeps the switch honest and explains itself when the write fails', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    api.setAutoLaunch.mockRejectedValueOnce(new Error('Access denied.'))
    renderDialog(api)
    const toggle = screen.getByRole('switch', { name: 'Launch at startup' })
    await waitFor(() => expect(toggle).toBeEnabled())

    await user.click(toggle)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the startup setting: Access denied.')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  // Ten kinds in one flat list would bury the four that matter, and the opt-in CLIs are off
  // anyway — so they are collapsed away entirely, not merely dimmed.
  it('hides the opt-in agent CLIs behind a collapsed group', async () => {
    const user = userEvent.setup()
    renderDialog()
    const optInKinds = ['Gemini', 'GitHub Copilot', 'Cursor', 'Comate', 'Qwen Code']

    const toggle = screen.getByRole('button', { name: 'More agent CLIs (5)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    for (const kind of optInKinds) {
      expect(screen.queryByRole('switch', { name: `Enable ${kind}` })).not.toBeInTheDocument()
    }
    // The established kinds are never behind the disclosure.
    expect(screen.getByRole('switch', { name: 'Enable Claude' })).toBeInTheDocument()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    for (const kind of optInKinds) {
      expect(screen.getByRole('switch', { name: `Enable ${kind}` })).toHaveAttribute('aria-checked', 'false')
      // Off means the worktree switch is disabled but keeps its stored value, exactly as for
      // an established kind the user turned off.
      expect(screen.getByRole('switch', { name: `New worktree for ${kind}` })).toBeDisabled()
    }
  })

  // The dialog stays mounted while closed (it renders null), so the disclosure state has to be
  // re-derived when it reopens — and it always reopens collapsed, whether or not an opt-in kind
  // is enabled: the four established kinds are what the dialog is about, and an enabled kind is
  // one caret click away.
  it('always reopens collapsed, even with an opt-in agent enabled', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    window.codefly = createFakeApi() as unknown as typeof window.codefly
    const view = render(<SettingsDialog open onClose={onClose} />)
    const disclosureName = { name: 'More agent CLIs (5)' }

    // Expanded to look, nothing turned on: reopening must not keep ten rows on screen.
    await user.click(screen.getByRole('button', disclosureName))
    expect(screen.getByRole('button', disclosureName)).toHaveAttribute('aria-expanded', 'true')
    view.rerender(<SettingsDialog open={false} onClose={onClose} />)
    view.rerender(<SettingsDialog open onClose={onClose} />)
    expect(screen.getByRole('button', disclosureName)).toHaveAttribute('aria-expanded', 'false')

    await user.click(screen.getByRole('button', disclosureName))
    await user.click(screen.getByRole('switch', { name: 'Enable Qwen Code' }))
    view.rerender(<SettingsDialog open={false} onClose={onClose} />)
    view.rerender(<SettingsDialog open onClose={onClose} />)

    // Still collapsed: the enabled switch is preserved behind the caret, not shown by default.
    expect(screen.getByRole('button', disclosureName)).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', disclosureName))
    expect(screen.getByRole('switch', { name: 'Enable Qwen Code' })).toHaveAttribute('aria-checked', 'true')
  })

  it('enables an opt-in agent from the expanded group and persists it', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: 'More agent CLIs (5)' }))
    await user.click(screen.getByRole('switch', { name: 'Enable Comate' }))

    expect(useAppStore.getState().sessionKindPreferences.comate).toEqual({ enabled: true, worktree: true })
    expect(JSON.parse(window.localStorage.getItem('codefly.sessionKinds')!).comate).toEqual({
      enabled: true,
      worktree: true
    })
  })

  it('offers an enable and a worktree switch per established session kind', async () => {
    renderDialog()

    for (const kind of ['PowerShell', 'Command Prompt', 'Claude', 'Codex']) {
      expect(screen.getByRole('switch', { name: `Enable ${kind}` })).toHaveAttribute('aria-checked', 'true')
    }
    expect(screen.getByRole('switch', { name: 'New worktree for PowerShell' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'New worktree for Command Prompt' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'New worktree for Claude' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'New worktree for Codex' })).toHaveAttribute('aria-checked', 'true')
  })

  it('persists flipped session-kind switches to the store and localStorage', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('switch', { name: 'New worktree for Command Prompt' }))
    expect(screen.getByRole('switch', { name: 'New worktree for Command Prompt' })).toHaveAttribute('aria-checked', 'true')
    expect(useAppStore.getState().sessionKindPreferences.cmd).toEqual({ enabled: true, worktree: true })

    await user.click(screen.getByRole('switch', { name: 'Enable Codex' }))
    expect(useAppStore.getState().sessionKindPreferences.codex).toEqual({ enabled: false, worktree: true })

    expect(JSON.parse(window.localStorage.getItem('codefly.sessionKinds')!)).toEqual({
      shell: { enabled: false, worktree: false },
      powershell: { enabled: true, worktree: false },
      cmd: { enabled: true, worktree: true },
      claude: { enabled: true, worktree: true },
      codex: { enabled: false, worktree: true },
      gemini: { enabled: false, worktree: true },
      copilot: { enabled: false, worktree: true },
      cursor: { enabled: false, worktree: true },
      comate: { enabled: false, worktree: true },
      qwen: { enabled: false, worktree: true }
    })
  })

  it('shows exactly Shell, Claude, and Codex session settings on macOS', () => {
    act(() => {
      useAppStore.setState({
        platform: 'darwin',
        sessionKindPreferences: defaultSessionKindPreferences('darwin')
      })
    })

    renderDialog()

    expect(screen.getByRole('switch', { name: 'Enable Shell' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'Enable Claude' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable Codex' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Enable PowerShell' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Enable Command Prompt' })).not.toBeInTheDocument()
  })

  it('disables the worktree switch of a kind that is turned off, without discarding its value', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('switch', { name: 'Enable Claude' }))

    const worktreeSwitch = screen.getByRole('switch', { name: 'New worktree for Claude' })
    expect(worktreeSwitch).toBeDisabled()
    expect(worktreeSwitch).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('switch', { name: 'Enable Claude' }))
    expect(screen.getByRole('switch', { name: 'New worktree for Claude' })).toBeEnabled()
  })

  it('switches the whole dialog to Simplified Chinese and back', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: '简体中文' }))

    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '开机自动启动' })).toBeInTheDocument()
    expect(useAppStore.getState().locale).toBe('zh-CN')
    expect(window.localStorage.getItem('codefly.locale')).toBe('zh-CN')

    await user.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('shows the installed version and reports that no release has been published', async () => {
    const user = userEvent.setup()
    const api = renderDialog()

    expect(await screen.findByText('9.9.9')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    expect(api.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('status')).toHaveTextContent('No release has been published yet.')
  })

  it('names the newer version and offers the download page when an update exists', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    api.checkForUpdates.mockResolvedValueOnce({
      status: 'available',
      currentVersion: '9.9.9',
      latestVersion: '10.0.0',
      releaseUrl: 'https://example.test/release'
    })
    renderDialog(api)

    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Version 10.0.0 is available.')
    // No installer in this release, so the download page is the only thing on offer.
    expect(within(screen.getByRole('status')).queryByRole('button', { name: 'Update now' })).toBeNull()
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Downloads' }))
    expect(api.openExternalLink).toHaveBeenCalledWith('download')
  })

  it('hands a downloadable release to the update dialog and gets out of the way', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const api = createFakeApi()
    api.checkForUpdates.mockResolvedValueOnce(availableWithInstaller)
    renderDialog(api, onClose)

    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    await user.click(within(await screen.findByRole('status')).getByRole('button', { name: 'Update now' }))

    // The download starts straight away and Settings closes, leaving UpdateDialog on screen.
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useAppStore.getState().updater).toEqual({ phase: 'ready', version: '10.0.0' }))
  })

  it('surfaces the reason an update check failed', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    api.checkForUpdates.mockResolvedValueOnce({ status: 'error', message: 'Network request failed.' })
    renderDialog(api)

    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Could not check for updates: Network request failed.')
  })

  it('opens each About destination through the whitelisted main-process bridge', async () => {
    const user = userEvent.setup()
    const api = renderDialog()

    // Each row shows its label and a chain glyph only — the destination stays in the tooltip.
    const repository = screen.getByRole('button', { name: 'Project repository' })
    await waitFor(() => expect(repository).toHaveAttribute('title', links.repository))
    expect(repository.querySelector('.settings-link-icon')).not.toBeNull()
    expect(screen.queryByText(links.repository)).not.toBeInTheDocument()

    await user.click(repository)
    await user.click(screen.getByRole('button', { name: /Changelog/ }))
    await user.click(screen.getByRole('button', { name: /Downloads/ }))

    expect(api.openExternalLink.mock.calls.map(([target]) => target)).toEqual(['repository', 'changelog', 'download'])
  })
})
