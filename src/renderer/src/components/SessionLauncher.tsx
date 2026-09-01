import { useEffect, useState } from 'react'

import type { SessionKind } from '../../../shared/contracts'
import { sessionKindIconUrl } from '../session-kind-icons'
import { useAppStore } from '../store/use-app-store'

type LauncherItem = {
  kind: SessionKind
  label: string
  shortcut?: string
}

// Fixed order per spec: PowerShell, Command Prompt, Claude, Codex.
const LAUNCHER_ITEMS: readonly LauncherItem[] = [
  { kind: 'powershell', label: 'PowerShell', shortcut: 'Ctrl+T' },
  { kind: 'cmd', label: 'Command Prompt' },
  { kind: 'claude', label: 'Claude' },
  { kind: 'codex', label: 'Codex' }
]

type SessionLauncherProps = {
  projectId: string
}

/**
 * Popover for choosing which session kind to create in the currently active project.
 * Claude/Codex are disabled from CapabilityState with their lookup detail shown as
 * visible help text (not just a tooltip) so an unauthenticated/missing CLI is discoverable
 * without hovering. PowerShell and Command Prompt use Windows system executables and are
 * always available.
 */
export default function SessionLauncher({ projectId }: SessionLauncherProps) {
  const capabilities = useAppStore((state) => state.capabilities)
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

  const handleSelect = async (kind: SessionKind): Promise<void> => {
    if (!availability[kind].available || pending) return
    setPending(true)
    try {
      await createSession(projectId, kind)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="session-launcher" aria-label="Create session">
      <div className="session-launcher-header">
        <span>New session</span>
        <button type="button" className="session-launcher-close" aria-label="Close launcher" onClick={closeLauncher}>
          ×
        </button>
      </div>
      <ul className="session-launcher-list">
        {LAUNCHER_ITEMS.map((item) => {
          const info = availability[item.kind]
          return (
            <li key={item.kind} className="session-launcher-item" data-launcher-item>
              <button type="button" disabled={!info.available || pending} onClick={() => handleSelect(item.kind)}>
                <img src={sessionKindIconUrl(item.kind)} alt="" width={16} height={16} className="session-launcher-icon" />
                <span className="session-launcher-label">{item.label}</span>
                {item.shortcut && (
                  <span className="session-launcher-shortcut" aria-hidden="true">
                    {item.shortcut}
                  </span>
                )}
              </button>
              {!info.available && info.detail && <p className="session-launcher-detail">{info.detail}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
