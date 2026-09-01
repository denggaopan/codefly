// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateCheckResult } from '../../../shared/contracts'
import type { ExternalLinkTarget } from '../../../shared/links'
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
  setTheme: vi.fn(async () => undefined)
})

type FakeApi = ReturnType<typeof createFakeApi>

const renderDialog = (api: FakeApi = createFakeApi()): FakeApi => {
  window.codefly = api as unknown as typeof window.codefly
  render(<SettingsDialog open onClose={vi.fn()} />)
  return api
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
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Downloads' }))
    expect(api.openExternalLink).toHaveBeenCalledWith('download')
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

    expect(await screen.findByText(links.repository)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Project repository/ }))
    await user.click(screen.getByRole('button', { name: /Changelog/ }))
    await user.click(screen.getByRole('button', { name: /Downloads/ }))

    expect(api.openExternalLink.mock.calls.map(([target]) => target)).toEqual(['repository', 'changelog', 'download'])
  })
})
