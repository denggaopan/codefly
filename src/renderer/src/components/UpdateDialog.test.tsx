// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateDownloadResult, UpdateInstallResult } from '../../../shared/contracts'
import { useAppStore, type UpdaterState } from '../store/use-app-store'
import UpdateDialog, { formatBytes } from './UpdateDialog'

// Only the bridge methods the update flow touches; the cast keeps the fake narrow without
// widening every vi.fn() to a plain function type (App.test.tsx type-checks the full shape).
const createFakeApi = () => ({
  downloadUpdate: vi.fn(async (): Promise<UpdateDownloadResult> => ({ status: 'ready', version: '2.0.0', fileName: 'Setup.exe' })),
  cancelUpdateDownload: vi.fn(async (): Promise<void> => undefined),
  installUpdate: vi.fn(async (): Promise<UpdateInstallResult> => ({ status: 'launched' })),
  openExternalLink: vi.fn(async (): Promise<void> => undefined)
})

type FakeApi = ReturnType<typeof createFakeApi>

const renderDialog = (updater: UpdaterState, api: FakeApi = createFakeApi()): FakeApi => {
  window.codefly = api as unknown as typeof window.codefly
  useAppStore.setState({ updater })
  render(<UpdateDialog />)
  return api
}

const phase = (): UpdaterState['phase'] => useAppStore.getState().updater.phase

describe('formatBytes', () => {
  it('scales from bytes to megabytes, sparing a fraction only where one is readable', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('UpdateDialog', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
  })

  it('renders nothing at all while the updater is idle', () => {
    renderDialog({ phase: 'idle' })

    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('offers the in-app download when the release ships an installer', async () => {
    const user = userEvent.setup()
    const api = renderDialog({ phase: 'available', version: '2.0.0', downloadable: true })

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Version 2.0.0 is available')

    await user.click(screen.getByRole('button', { name: 'Update now' }))

    expect(api.downloadUpdate).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useAppStore.getState().updater).toEqual({ phase: 'ready', version: '2.0.0' }))
  })

  it('falls back to the download page when the release publishes no installer', async () => {
    const user = userEvent.setup()
    const api = renderDialog({ phase: 'available', version: '2.0.0', downloadable: false })

    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open download page' }))

    expect(api.openExternalLink).toHaveBeenCalledWith('download')
    // Handing off to the browser ends the in-app flow: nothing is left to come back to.
    expect(phase()).toBe('idle')
  })

  it('"Later" leaves the updater idle without touching the bridge', async () => {
    const user = userEvent.setup()
    const api = renderDialog({ phase: 'available', version: '2.0.0', downloadable: true })

    await user.click(screen.getByRole('button', { name: 'Later' }))

    expect(phase()).toBe('idle')
    expect(api.downloadUpdate).not.toHaveBeenCalled()
  })

  it('reports download progress against the known total', () => {
    renderDialog({ phase: 'downloading', version: '2.0.0', receivedBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024 })

    const bar = screen.getByRole('progressbar', { name: 'Download progress' })
    expect(bar).toHaveAttribute('aria-valuenow', String(512 * 1024))
    expect(bar).toHaveAttribute('aria-valuemax', String(2 * 1024 * 1024))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('512.0 KB of 2.0 MB')
  })

  it('goes indeterminate rather than claiming a percentage when the total is unknown', () => {
    renderDialog({ phase: 'downloading', version: '2.0.0', receivedBytes: 4096, totalBytes: 0 })

    const bar = screen.getByRole('progressbar', { name: 'Download progress' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('4.0 KB downloaded')
  })

  it('cancels the download only from its own button, never from a stray click or Escape', async () => {
    const user = userEvent.setup()
    const api = renderDialog({ phase: 'downloading', version: '2.0.0', receivedBytes: 0, totalBytes: 100 })

    // Throwing away a large transfer is far too destructive for a full-window click target.
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull()
    await user.keyboard('{Escape}')
    await user.click(document.querySelector('.update-dialog-backdrop') as HTMLElement)
    expect(api.cancelUpdateDownload).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.cancelUpdateDownload).toHaveBeenCalledTimes(1)
  })

  it('offers nothing at all while the installer is being launched', async () => {
    const user = userEvent.setup()
    const api = renderDialog({ phase: 'installing', version: '2.0.0' })

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Starting the installer for version 2.0.0')
    expect(screen.queryByRole('button')).toBeNull()

    // The app is already quitting: neither gesture may leave this phase.
    await user.keyboard('{Escape}')
    await user.click(document.querySelector('.update-dialog-backdrop') as HTMLElement)
    expect(phase()).toBe('installing')
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it('installs on demand once the installer is on disk, and stops offering the button', async () => {
    const user = userEvent.setup()
    const api = renderDialog({ phase: 'ready', version: '2.0.0' })

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Version 2.0.0 is ready to install')

    await user.click(screen.getByRole('button', { name: 'Install now' }))

    expect(api.installUpdate).toHaveBeenCalledTimes(1)
    // Quitting is not instant, so the button must not survive to be clicked a second time.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install now' })).toBeNull())
  })

  it('keeps the downloaded installer when the user postpones the install', async () => {
    const user = userEvent.setup()
    const api = renderDialog({ phase: 'ready', version: '2.0.0' })

    await user.click(screen.getByRole('button', { name: 'Later' }))

    expect(phase()).toBe('idle')
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it('shows a failure with a retry and a way out to the download page', async () => {
    const user = userEvent.setup()
    const api = renderDialog({ phase: 'error', version: '2.0.0', message: 'Network request failed.' })

    expect(screen.getByRole('alert')).toHaveTextContent('Network request failed.')

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('Escape means "Later" in every phase that is not downloading', async () => {
    const user = userEvent.setup()
    renderDialog({ phase: 'ready', version: '2.0.0' })

    await user.keyboard('{Escape}')

    expect(phase()).toBe('idle')
  })
})
