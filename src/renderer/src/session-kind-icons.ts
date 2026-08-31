import type { SessionKind } from '../../shared/contracts'
import claudeIconUrl from './assets/claude.svg'
import cmdIconUrl from './assets/cmd.svg'
import codexIconUrl from './assets/codex.svg'
import powershellIconUrl from './assets/powershell.svg'

const iconUrls: Readonly<Record<SessionKind, string>> = {
  powershell: powershellIconUrl,
  cmd: cmdIconUrl,
  claude: claudeIconUrl,
  codex: codexIconUrl
}

/**
 * Brand icon for each session kind, shared by the sidebar rows and the session launcher so
 * a kind always shows the same mark. The codex/cmd sources are recolored light in their
 * asset files because CodeFly's UI is dark-only.
 */
export const sessionKindIconUrl = (kind: SessionKind): string => iconUrls[kind]
