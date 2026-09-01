import { useEffect, useState } from 'react'

import type { SessionKind } from '../../../shared/contracts'
import type { TranslationKey } from '../i18n'
import { useTranslation } from '../i18n/use-translation'
import { sessionKindIconUrl } from '../session-kind-icons'
import { useAppStore } from '../store/use-app-store'

type LauncherKind = {
  kind: SessionKind
  // A dictionary key, not a string: the table is module-level, so it cannot be rebuilt when
  // the locale changes — the label is resolved at render time instead.
  labelKey: TranslationKey
  shortcut?: string
}

// Fixed order per spec: PowerShell, Command Prompt, Claude, Codex.
const LAUNCHER_KINDS: readonly LauncherKind[] = [
  { kind: 'powershell', labelKey: 'sessionKind.powershell', shortcut: 'Ctrl+T' },
  { kind: 'cmd', labelKey: 'sessionKind.cmd' },
  { kind: 'claude', labelKey: 'sessionKind.claude' },
  { kind: 'codex', labelKey: 'sessionKind.codex' }
]

type LauncherEntry = {
  id: string
  kind: SessionKind
  worktree: boolean
  label: string
  shortcut?: string
}

type SessionLauncherProps = {
  projectId: string
}

/**
 * Popover for choosing which session kind to create in the currently active project.
 * Claude/Codex are disabled from CapabilityState with their lookup detail shown as
 * visible help text (not just a tooltip) so an unauthenticated/missing CLI is discoverable
 * without hovering. PowerShell and Command Prompt use Windows system executables and are
 * always available.
 *
 * Which kinds appear at all, and which of them offer a worktree, comes from the per-kind
 * Settings switches: an enabled kind always has a plain entry that launches in the project
 * directory, and one whose worktree switch is also on gets a SECOND "(new worktree)" entry
 * right beneath it — so the choice between the two is made per session at creation time
 * rather than being implied by a global mode. A kind switched off is absent entirely, which
 * is different from a kind whose CLI is missing: that one stays listed but disabled, with
 * the lookup detail explaining why.
 */
export default function SessionLauncher({ projectId }: SessionLauncherProps) {
  const { t } = useTranslation()
  const capabilities = useAppStore((state) => state.capabilities)
  const sessionKindPreferences = useAppStore((state) => state.sessionKindPreferences)
  const createSession = useAppStore((state) => state.createSession)
  const closeLauncher = useAppStore((state) => state.closeLauncher)
  const [pending, setPending] = useState(false)

  // Escape closes the launcher from the keyboard; ProjectSidebar's focus-restoration effect
  // (watching launcherOpen) then returns focus to the project options trigger.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeLauncher()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeLauncher])

  const availability: Record<SessionKind, { available: boolean; detail?: string }> = {
    powershell: { available: true },
    cmd: { available: true },
    claude: capabilities.claude,
    codex: capabilities.codex
  }

  // The accelerator hint belongs to the plain PowerShell entry only: it is what Ctrl+T
  // stands for, and repeating it on the worktree variant would advertise a shortcut that
  // does something else.
  const entries: readonly LauncherEntry[] = LAUNCHER_KINDS.flatMap((item) => {
    const preference = sessionKindPreferences[item.kind]
    if (!preference.enabled) return []
    const plain: LauncherEntry = { id: item.kind, kind: item.kind, worktree: false, label: t(item.labelKey), shortcut: item.shortcut }
    if (!preference.worktree) return [plain]
    return [plain, { id: `${item.kind}:worktree`, kind: item.kind, worktree: true, label: t('launcher.worktreeVariant', { kind: t(item.labelKey) }) }]
  })

  const handleSelect = async (kind: SessionKind, worktree: boolean): Promise<void> => {
    if (!availability[kind].available || pending) return
    setPending(true)
    try {
      await createSession(projectId, kind, worktree)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="session-launcher" aria-label={t('launcher.createSession')}>
      <div className="session-launcher-header">
        <span>{t('launcher.newSession')}</span>
        <button type="button" className="session-launcher-close" aria-label={t('launcher.close')} onClick={closeLauncher}>
          ×
        </button>
      </div>
      {/* Every kind can be switched off, so the list can legitimately end up empty; say so
          instead of rendering a blank popover the user cannot explain. */}
      {entries.length === 0 && <p className="session-launcher-empty">{t('launcher.allKindsDisabled')}</p>}
      <ul className="session-launcher-list">
        {entries.map((entry) => {
          const info = availability[entry.kind]
          return (
            <li key={entry.id} className="session-launcher-item" data-launcher-item>
              <button
                type="button"
                data-kind={entry.kind}
                data-worktree={entry.worktree ? 'true' : 'false'}
                disabled={!info.available || pending}
                onClick={() => handleSelect(entry.kind, entry.worktree)}
              >
                <img src={sessionKindIconUrl(entry.kind)} alt="" width={16} height={16} className="session-launcher-icon" />
                <span className="session-launcher-label">{entry.label}</span>
                {/* The accelerator is a literal key combination, identical in every language. */}
                {entry.shortcut && (
                  <span className="session-launcher-shortcut" aria-hidden="true">
                    {entry.shortcut}
                  </span>
                )}
              </button>
              {/* The unavailability detail belongs to the kind, not the entry: showing it once
                  per entry would repeat the same CLI-lookup sentence twice for one tool. */}
              {!info.available && info.detail && !entry.worktree && <p className="session-launcher-detail">{info.detail}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
