import type { SessionKind } from '../../shared/contracts'
import claudeIconUrl from './assets/claude.svg'
import cmdIconUrl from './assets/cmd.svg'
import codexIconUrl from './assets/codex.svg'
import comateIconUrl from './assets/comate.svg'
import copilotIconUrl from './assets/copilot.svg'
import cursorIconUrl from './assets/cursor.png'
import geminiIconUrl from './assets/gemini.svg'
import powershellIconUrl from './assets/powershell.svg'
import qwenIconUrl from './assets/qwen.svg'
import shellIconUrl from './assets/shell.svg'

const iconUrls: Readonly<Record<SessionKind, string>> = {
  shell: shellIconUrl,
  powershell: powershellIconUrl,
  cmd: cmdIconUrl,
  claude: claudeIconUrl,
  codex: codexIconUrl,
  gemini: geminiIconUrl,
  copilot: copilotIconUrl,
  cursor: cursorIconUrl,
  comate: comateIconUrl,
  qwen: qwenIconUrl
}

/**
 * Brand icon for each session kind, shared by the sidebar rows and the session launcher so
 * a kind always shows the same mark. The codex/cmd sources are recolored light in their
 * asset files because CodeFly's UI is dark-only.
 *
 * Copilot, Cursor, Comate and Qwen use the vendors' own marks, supplied by the maintainer.
 * Cursor's is the only raster source: it arrived as a greyscale PNG on an opaque white
 * background, which would read as a white sticker in this dark-only UI, so the
 * border-connected white was cleared to transparency (the cube's own near-white top-right
 * face is interior and survives). Gemini keeps an original geometric mark — no artwork for
 * it was supplied, and a rough imitation of a trademark would be worse than a clean shape.
 */
export const sessionKindIconUrl = (kind: SessionKind): string => iconUrls[kind]
