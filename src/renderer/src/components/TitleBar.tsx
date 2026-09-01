import { useState } from 'react'

import logoUrl from '../assets/logo.svg'
import { useTranslation } from '../i18n/use-translation'
import SettingsDialog from './SettingsDialog'

/**
 * Custom window title bar. The main window is created with titleBarStyle:'hidden' plus a
 * titleBarOverlay (src/main/window.ts), so Windows draws its native minimize/maximize/close
 * buttons as an overlay in the top-right corner ON TOP of this strip. The strip itself is
 * the drag region (-webkit-app-region: drag in styles.css); padding-right reserves exactly
 * the overlay's width via env(titlebar-area-width), which is what places the settings
 * button — the strip's last flex child — directly left of the native minimize button.
 */
export default function TitleBar() {
  const { t } = useTranslation()
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <header className="title-bar">
      <img className="title-bar-logo" src={logoUrl} alt="" aria-hidden="true" />
      <span className="title-bar-app-name">CodeFly</span>
      <button
        type="button"
        className="title-bar-settings"
        aria-label={t('titleBar.settings')}
        title={t('titleBar.settings')}
        aria-haspopup="dialog"
        onClick={() => setSettingsOpen(true)}
      >
        <svg
          className="icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}
