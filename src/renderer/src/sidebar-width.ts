/**
 * Sidebar width bounds, shared by the store (persistence), SidebarResizer (drag/keyboard) and
 * mirrored by the CSS tokens in styles.css (`--sidebar-min-width`, `--workspace-min-width`).
 * Pure functions only: the store passes `window.innerWidth` in, so these stay testable without
 * a DOM and the CSS `clamp()` remains the single runtime safety net for a window that is
 * resized after the preference was applied.
 */

/** The historical fixed width, still what a fresh install gets. */
export const DEFAULT_SIDEBAR_WIDTH = 300
/** Narrow enough to be a compact icon-and-title rail, wide enough that titles stay legible. */
export const MIN_SIDEBAR_WIDTH = 200
export const MAX_SIDEBAR_WIDTH = 640
/** Space the terminal workspace always keeps, so the sidebar can never push it off-screen. */
export const MIN_WORKSPACE_WIDTH = 360
/** Pixels per ArrowLeft/ArrowRight press on the focused resize handle. */
export const SIDEBAR_WIDTH_KEYBOARD_STEP = 16

export const maxSidebarWidthFor = (viewportWidth: number): number =>
  Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(viewportWidth - MIN_WORKSPACE_WIDTH)))

export const clampSidebarWidth = (width: number, viewportWidth: number): number => {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(Math.max(Math.round(width), MIN_SIDEBAR_WIDTH), maxSidebarWidthFor(viewportWidth))
}

/**
 * Interprets the raw localStorage string. Anything that is not a finite number — a missing
 * key on first launch, a hand-edited value, a future format — degrades to the default rather
 * than to a collapsed or off-screen sidebar.
 */
export const parseStoredSidebarWidth = (stored: string | null, viewportWidth: number): number => {
  if (stored === null || stored.trim() === '') return DEFAULT_SIDEBAR_WIDTH
  const parsed = Number(stored)
  if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH
  return clampSidebarWidth(parsed, viewportWidth)
}
