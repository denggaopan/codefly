import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import type { AppInfo, UpdateCheckResult } from '../../../shared/contracts'
import type { ExternalLinkTarget } from '../../../shared/links'
import { LOCALES, type TranslationKey, type Translator } from '../i18n'
import { useTranslation } from '../i18n/use-translation'
import { sessionKindOptions } from '../session-kind-options'
import { useAppStore } from '../store/use-app-store'

type SettingsDialogProps = {
  open: boolean
  onClose: () => void
}

// Order matches the About section top to bottom: where the project lives, what changed,
// where to get a build. Each entry is a whitelisted target key rather than a URL — the main
// process resolves it against shared/links.ts, so the renderer can never ask it to open an
// arbitrary address.
const LINK_ITEMS: ReadonlyArray<{ target: ExternalLinkTarget; labelKey: TranslationKey }> = [
  { target: 'repository', labelKey: 'settings.linkRepository' },
  { target: 'changelog', labelKey: 'settings.linkChangelog' },
  { target: 'download', labelKey: 'settings.linkDownload' }
]

type UpdateState = { phase: 'idle' } | { phase: 'checking' } | { phase: 'done'; result: UpdateCheckResult }

const updateMessage = (result: UpdateCheckResult, t: Translator): string => {
  switch (result.status) {
    case 'up-to-date':
      return t('settings.upToDate')
    case 'available':
      return t('settings.updateAvailable', { version: result.latestVersion })
    case 'none':
      return t('settings.updateNoReleases')
    case 'error':
      return t('settings.updateFailed', { reason: result.message })
  }
}

const failureReason = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback)

/**
 * Application settings modal, opened from the title bar's gear button. Renders nothing when
 * `open` is false. Follows ConfirmDialog's modal conventions: fixed full-window backdrop
 * (click closes), Escape closes, and clicks inside the panel never bubble to the backdrop.
 *
 * Sections, in order: startup behaviour (a system-level setting, so it leads), the
 * presentation preferences that live in the app store (theme, language), the installed
 * version with its update check, the per-kind session switches that decide which entries the
 * New session launcher offers, and the About links. Everything the main process owns —
 * version, update check, startup flag, link opening — is read lazily when the dialog opens
 * rather than kept in the app store, since none of it is needed until the user looks.
 */
export default function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const { t } = useTranslation()
  const platform = useAppStore((state) => state.platform)
  const theme = useAppStore((state) => state.theme)
  const setTheme = useAppStore((state) => state.setTheme)
  const locale = useAppStore((state) => state.locale)
  const setLocale = useAppStore((state) => state.setLocale)
  const sessionKindPreferences = useAppStore((state) => state.sessionKindPreferences)
  const setSessionKindPreference = useAppStore((state) => state.setSessionKindPreference)
  const beginUpdate = useAppStore((state) => state.beginUpdate)
  const startUpdateDownload = useAppStore((state) => state.startUpdateDownload)

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  // null while the main process has not answered yet: the switch stays disabled rather than
  // rendering a guessed "off" that the user could toggle against the real setting.
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null)
  const [autoLaunchError, setAutoLaunchError] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: 'idle' })

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

  // Re-read on every open (not once per mount): the startup flag can be changed outside
  // CodeFly, and a stale update result from a previous visit would be misleading.
  useEffect(() => {
    if (!open) return undefined

    let cancelled = false
    setUpdateState({ phase: 'idle' })
    setAutoLaunchError(null)

    void window.codefly
      .getAppInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info)
      })
      .catch(() => undefined)

    void window.codefly
      .getAutoLaunch()
      .then((enabled) => {
        if (!cancelled) setAutoLaunch(enabled)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) return null

  const handleAutoLaunchToggle = async (): Promise<void> => {
    if (autoLaunch === null) return
    const next = !autoLaunch
    setAutoLaunchError(null)
    try {
      // The main process answers with the value it read back after writing, so a setting the
      // OS silently refused shows as unchanged instead of as a switch that lies.
      setAutoLaunch(await window.codefly.setAutoLaunch(next))
    } catch (error) {
      setAutoLaunchError(t('settings.launchAtLoginFailed', { reason: failureReason(error, t('notice.genericError')) }))
    }
  }

  const handleCheckForUpdates = async (): Promise<void> => {
    setUpdateState({ phase: 'checking' })
    try {
      setUpdateState({ phase: 'done', result: await window.codefly.checkForUpdates() })
    } catch (error) {
      setUpdateState({
        phase: 'done',
        result: { status: 'error', message: failureReason(error, t('notice.genericError')) }
      })
    }
  }

  const openLink = (target: ExternalLinkTarget): void => {
    void window.codefly.openExternalLink(target).catch(() => undefined)
  }

  // Hands the check's outcome to the app store instead of making UpdateDialog repeat the
  // round trip, then closes Settings so the update dialog is the only thing on screen.
  const handleUpdateNow = (version: string): void => {
    beginUpdate(version, true)
    void startUpdateDownload()
    onClose()
  }

  // Extracted before the JSX so the narrowing survives into the click handler's closure.
  const downloadableUpdate =
    updateState.phase === 'done' && updateState.result.status === 'available' && updateState.result.asset
      ? updateState.result
      : null

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
            {t('settings.title')}
          </h2>
          <button type="button" className="settings-dialog-close" aria-label={t('settings.close')} onClick={onClose} autoFocus>
            ✕
          </button>
        </div>

        <div className="settings-dialog-section">
          <span className="settings-dialog-label" id="settings-startup-label">
            {t('settings.launchAtLogin')}
          </span>
          <button
            type="button"
            className="settings-switch"
            role="switch"
            aria-checked={autoLaunch === true}
            aria-labelledby="settings-startup-label"
            disabled={autoLaunch === null}
            onClick={() => void handleAutoLaunchToggle()}
          >
            <span className="settings-switch-thumb" aria-hidden="true" />
          </button>
        </div>
        {autoLaunchError && (
          <p className="settings-dialog-error" role="alert">
            {autoLaunchError}
          </p>
        )}

        <div className="settings-dialog-section">
          <span className="settings-dialog-label" id="settings-appearance-label">
            {t('settings.appearance')}
          </span>
          <div className="settings-theme-toggle" role="group" aria-labelledby="settings-appearance-label">
            <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
              {t('settings.themeDark')}
            </button>
            <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
              {t('settings.themeLight')}
            </button>
          </div>
        </div>

        <div className="settings-dialog-section">
          <span className="settings-dialog-label" id="settings-language-label">
            {t('settings.language')}
          </span>
          <div className="settings-theme-toggle" role="group" aria-labelledby="settings-language-label">
            {LOCALES.map((option) => (
              <button key={option.value} type="button" aria-pressed={locale === option.value} onClick={() => setLocale(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-dialog-section">
          <span className="settings-dialog-label">
            {t('settings.version')}
            <span className="settings-version-value">{appInfo?.version ?? t('settings.versionUnknown')}</span>
          </span>
          <button
            type="button"
            className="settings-update-button"
            disabled={updateState.phase === 'checking'}
            onClick={() => void handleCheckForUpdates()}
          >
            {updateState.phase === 'checking' ? t('settings.checking') : t('settings.checkForUpdates')}
          </button>
        </div>
        {updateState.phase === 'done' && (
          <p className="settings-update-status" role="status" data-status={updateState.result.status}>
            {updateMessage(updateState.result, t)}
            {/* Only a release with an installer supported by this platform can be downloaded
                in-app; otherwise the Releases page stays the only thing to offer. */}
            {downloadableUpdate && (
              <button type="button" className="settings-inline-action" onClick={() => handleUpdateNow(downloadableUpdate.latestVersion)}>
                {t('settings.updateNow')}
              </button>
            )}
            {updateState.result.status === 'available' && (
              <button type="button" className="settings-inline-link" onClick={() => openLink('download')}>
                {t('settings.linkDownload')}
              </button>
            )}
          </p>
        )}

        <div className="settings-dialog-group">
          <span className="settings-dialog-label" id="settings-session-kinds-label">
            {t('settings.sessionKinds')}
          </span>
          <p className="settings-dialog-hint">{t('settings.sessionKindsHint')}</p>
          <ul className="settings-kind-list" aria-labelledby="settings-session-kinds-label">
            {/* Column captions only: each switch below carries its own full accessible name
                ("Enable Claude", "New worktree for Claude"), so these are decorative. */}
            <li className="settings-kind-row settings-kind-head" aria-hidden="true">
              <span />
              <span>{t('settings.columnEnabled')}</span>
              <span>{t('settings.columnWorktree')}</span>
            </li>
            {sessionKindOptions(platform).map((item) => {
              const preference = sessionKindPreferences[item.kind]
              const kindLabel = t(item.labelKey)
              return (
                <li key={item.kind} className="settings-kind-row">
                  <span className="settings-kind-name">{kindLabel}</span>
                  <button
                    type="button"
                    className="settings-switch"
                    role="switch"
                    aria-checked={preference.enabled}
                    aria-label={t('settings.enableKind', { kind: kindLabel })}
                    onClick={() => setSessionKindPreference(item.kind, { enabled: !preference.enabled })}
                  >
                    <span className="settings-switch-thumb" aria-hidden="true" />
                  </button>
                  {/* A kind that is not offered at all cannot offer a worktree variant: the
                      switch keeps its stored value but is disabled until the kind is back on. */}
                  <button
                    type="button"
                    className="settings-switch"
                    role="switch"
                    aria-checked={preference.worktree}
                    aria-label={t('settings.worktreeForKind', { kind: kindLabel })}
                    disabled={!preference.enabled}
                    onClick={() => setSessionKindPreference(item.kind, { worktree: !preference.worktree })}
                  >
                    <span className="settings-switch-thumb" aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="settings-dialog-about">
          <span className="settings-dialog-label">{t('settings.about')}</span>
          <ul className="settings-link-list">
            {LINK_ITEMS.map((item) => (
              <li key={item.target}>
                <button
                  type="button"
                  className="settings-link"
                  title={appInfo?.links[item.target]}
                  onClick={() => openLink(item.target)}
                >
                  <span className="settings-link-label">{t(item.labelKey)}</span>
                  <svg
                    className="settings-link-icon"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>,
    document.body
  )
}
