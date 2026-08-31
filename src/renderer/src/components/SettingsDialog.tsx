import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { useAppStore } from '../store/use-app-store'

type SettingsDialogProps = {
  open: boolean
  onClose: () => void
}

/**
 * Application settings modal, opened from the title bar's gear button. Renders nothing when
 * `open` is false. Follows ConfirmDialog's modal conventions: fixed full-window backdrop
 * (click closes), Escape closes, and clicks inside the panel never bubble to the backdrop.
 * Currently holds a single setting — the dark/light appearance toggle — whose state lives in
 * the app store so the rest of the renderer (styles.css tokens, xterm themes) can react.
 */
export default function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const theme = useAppStore((state) => state.theme)
  const setTheme = useAppStore((state) => state.setTheme)

  useEffect(() => {
    if (!open) return undefined

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="settings-dialog-backdrop" onClick={onClose}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-dialog-header">
          <h2 id="settings-dialog-title" className="settings-dialog-title">
            Settings
          </h2>
          <button type="button" className="settings-dialog-close" aria-label="Close settings" onClick={onClose} autoFocus>
            ✕
          </button>
        </div>
        <div className="settings-dialog-section">
          <span className="settings-dialog-label" id="settings-appearance-label">
            Appearance
          </span>
          <div className="settings-theme-toggle" role="group" aria-labelledby="settings-appearance-label">
            <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
              Dark
            </button>
            <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
              Light
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
