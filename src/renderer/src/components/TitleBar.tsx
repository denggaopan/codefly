import { useCallback, useRef, useState, type MouseEvent } from 'react'

import logoUrl from '../assets/logo.svg'
import { useTranslation } from '../i18n/use-translation'
import type { Point } from '../rocket-flight'
import RocketFlight from './RocketFlight'
import SettingsDialog from './SettingsDialog'

interface RocketLaunch {
  id: number
  origin: Point
}

/**
 * Custom window title bar. Windows reserves its right-side titleBarOverlay; macOS reserves
 * the left-side traffic lights. Platform-specific padding in styles.css keeps this strip's
 * drag region and controls clear of the native window buttons.
 */
export default function TitleBar() {
  const { t } = useTranslation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [launches, setLaunches] = useState<RocketLaunch[]>([])
  const nextLaunchId = useRef(1)

  // The brand button is the easter egg's launch pad: every click drops another rocket from
  // wherever the logo currently sits, so several can be in the air at once.
  const launchRocket = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const id = nextLaunchId.current++
    setLaunches((current) => [...current, { id, origin: { x: box.left + box.width / 2, y: box.bottom } }])
  }

  const endLaunch = useCallback((id: number) => {
    setLaunches((current) => current.filter((launch) => launch.id !== id))
  }, [])

  return (
    <header className="title-bar">
      <button type="button" className="title-bar-brand" aria-label={t('titleBar.launchRocket')} onClick={launchRocket}>
        <img className="title-bar-logo" src={logoUrl} alt="" aria-hidden="true" />
        <span className="title-bar-app-name">CodeFly</span>
      </button>
      {/* Draggable filler: the brand button and the settings button are both no-drag, so
          without this the window would have almost no grab area left. */}
      <span className="title-bar-drag-area" aria-hidden="true" />
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
      {launches.map((launch) => (
        <RocketFlight key={launch.id} origin={launch.origin} onDone={() => endLaunch(launch.id)} />
      ))}
    </header>
  )
}
