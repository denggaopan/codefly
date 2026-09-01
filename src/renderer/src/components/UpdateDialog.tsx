import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { useTranslation } from '../i18n/use-translation'
import { useAppStore } from '../store/use-app-store'

/**
 * Formats a byte count for the download progress line. One decimal place from KB up, none
 * for raw bytes — a download measured in bytes is over before a fraction could be read.
 */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`
  return `${(kilobytes / 1024).toFixed(1)} MB`
}

/**
 * The single surface for the whole update flow — the startup check and Settings' explicit
 * check both route through the app store's `updater` state, so there is only ever one
 * dialog and one download in flight. Renders nothing in the `idle` phase.
 *
 * Modal conventions follow ConfirmDialog: a fixed full-window backdrop that dismisses on
 * click, Escape to dismiss, and clicks inside the panel that never reach the backdrop. Both
 * dismissal gestures mean "Later" — but neither is wired up while a download or an install
 * is running: the backdrop covers the whole window, and throwing away 90 MB at 85% (or
 * abandoning a dialog whose app is already quitting) is far too destructive for a stray
 * click. Cancel is then the only way to stop the download, and it says so.
 */
export default function UpdateDialog() {
  const { t } = useTranslation()
  const updater = useAppStore((state) => state.updater)
  const startUpdateDownload = useAppStore((state) => state.startUpdateDownload)
  const cancelUpdateDownload = useAppStore((state) => state.cancelUpdateDownload)
  const installUpdate = useAppStore((state) => state.installUpdate)
  const dismissUpdate = useAppStore((state) => state.dismissUpdate)

  const downloading = updater.phase === 'downloading'
  // A phase with work in flight owns the dialog: only its own explicit button can leave it.
  const busy = downloading || updater.phase === 'installing'

  useEffect(() => {
    if (updater.phase === 'idle' || busy) return undefined

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismissUpdate()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [updater.phase, busy, dismissUpdate])

  if (updater.phase === 'idle') return null

  const openDownloadPage = (): void => {
    void window.codefly.openExternalLink('download').catch(() => undefined)
    dismissUpdate()
  }

  const dismiss = (): void => {
    if (busy) return
    dismissUpdate()
  }

  const title = ((): string => {
    switch (updater.phase) {
      case 'available':
        return t('update.availableTitle', { version: updater.version })
      case 'downloading':
        return t('update.downloadingTitle', { version: updater.version })
      case 'ready':
        return t('update.readyTitle', { version: updater.version })
      case 'installing':
        return t('update.installingTitle', { version: updater.version })
      case 'error':
        return t('update.failedTitle')
    }
  })()

  return createPortal(
    <div className="update-dialog-backdrop" onClick={dismiss}>
      <div
        className="update-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="update-dialog-title" className="update-dialog-title">
          {title}
        </h2>

        {updater.phase === 'available' && (
          <p className="update-dialog-description">{updater.downloadable ? t('update.availableBody') : t('update.noInstallerBody')}</p>
        )}
        {updater.phase === 'ready' && <p className="update-dialog-description">{t('update.readyBody')}</p>}
        {updater.phase === 'installing' && <p className="update-dialog-description">{t('update.installingBody')}</p>}
        {updater.phase === 'error' && (
          <p className="update-dialog-description update-dialog-error" role="alert">
            {updater.message}
          </p>
        )}

        {updater.phase === 'downloading' && (
          <div className="update-dialog-progress">
            {/* A server that sends no length leaves totalBytes at 0: the bar goes
                indeterminate (no aria-valuenow, no width) rather than claiming 0%. */}
            <div
              className={updater.totalBytes > 0 ? 'update-progress-track' : 'update-progress-track update-progress-track--indeterminate'}
              role="progressbar"
              aria-label={t('update.downloadProgressLabel')}
              aria-valuemin={0}
              aria-valuemax={updater.totalBytes > 0 ? updater.totalBytes : undefined}
              aria-valuenow={updater.totalBytes > 0 ? updater.receivedBytes : undefined}
            >
              <div
                className="update-progress-fill"
                style={
                  updater.totalBytes > 0
                    ? { width: `${Math.min(100, (updater.receivedBytes / updater.totalBytes) * 100)}%` }
                    : undefined
                }
              />
            </div>
            <p className="update-dialog-progress-text">
              {updater.totalBytes > 0
                ? t('update.progress', { received: formatBytes(updater.receivedBytes), total: formatBytes(updater.totalBytes) })
                : t('update.progressUnknownTotal', { received: formatBytes(updater.receivedBytes) })}
            </p>
          </div>
        )}

        <div className="update-dialog-actions">
          {updater.phase === 'downloading' && (
            <button type="button" className="update-dialog-secondary" onClick={() => void cancelUpdateDownload()}>
              {t('update.cancelDownload')}
            </button>
          )}
          {/* The installing phase offers nothing: the installer is already with the OS and
              the app is on its way out, so there is no action left that could still matter. */}
          {!busy && (
            <button type="button" className="update-dialog-secondary" onClick={dismissUpdate}>
              {t('update.later')}
            </button>
          )}

          {updater.phase === 'error' && (
            <button type="button" className="update-dialog-secondary" onClick={openDownloadPage}>
              {t('update.openDownloadPage')}
            </button>
          )}

          {updater.phase === 'available' &&
            (updater.downloadable ? (
              <button type="button" className="update-dialog-primary" onClick={() => void startUpdateDownload()} autoFocus>
                {t('update.updateNow')}
              </button>
            ) : (
              <button type="button" className="update-dialog-primary" onClick={openDownloadPage} autoFocus>
                {t('update.openDownloadPage')}
              </button>
            ))}

          {updater.phase === 'ready' && (
            <button type="button" className="update-dialog-primary" onClick={() => void installUpdate()} autoFocus>
              {t('update.installNow')}
            </button>
          )}

          {updater.phase === 'error' && (
            <button type="button" className="update-dialog-primary" onClick={() => void startUpdateDownload()} autoFocus>
              {t('update.tryAgain')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
