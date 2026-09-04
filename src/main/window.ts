import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { ThemePreference } from '../shared/contracts'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

/** Must match the .title-bar height in styles.css so the native caption buttons the
 * titleBarOverlay draws line up exactly with the renderer's custom title-bar strip. */
export const TITLE_BAR_HEIGHT = 36

// Window-chrome colors per theme. These mirror the renderer's CSS tokens in styles.css
// (--color-canvas for background, --color-panel/--color-text for the caption-button overlay)
// because the overlay is drawn natively by Windows and cannot read CSS custom properties.
const WINDOW_THEME_COLORS: Record<ThemePreference, { background: string; overlayColor: string; overlaySymbol: string }> = {
  dark: { background: '#0b0f14', overlayColor: '#11161d', overlaySymbol: '#e7edf5' },
  light: { background: '#f5f7fa', overlayColor: '#ffffff', overlaySymbol: '#1c2733' }
}

/**
 * Applies a theme to everything the renderer's CSS cannot reach: the native theme source
 * (native scrollbars/dialogs), the window background painted behind the renderer, and the
 * native caption-button overlay colors. Called at startup implicitly via the window's
 * creation defaults (dark) and afterwards from the theme:set IPC handler whenever the
 * renderer applies its persisted preference or the user switches themes in Settings.
 */
export function applyWindowTheme(window: BrowserWindow, theme: ThemePreference, platform: NodeJS.Platform = process.platform): void {
  const colors = WINDOW_THEME_COLORS[theme]
  nativeTheme.themeSource = theme
  window.setBackgroundColor(colors.background)
  if (platform === 'win32') {
    window.setTitleBarOverlay({ color: colors.overlayColor, symbolColor: colors.overlaySymbol, height: TITLE_BAR_HEIGHT })
  }
}

/**
 * Pins (or unpins) the window above every other window. Called from the window:pinned-set
 * IPC handler when the user toggles the title bar's pin button, and once at startup when the
 * renderer replays its persisted preference. The flag is read back off the window rather than
 * echoed: a window manager that refuses to keep the window on top should leave the button
 * showing what actually happened, not what was asked for.
 */
export function applyWindowPinned(window: BrowserWindow, pinned: boolean): boolean {
  window.setAlwaysOnTop(pinned)
  return window.isAlwaysOnTop()
}

const safeDevelopmentRendererUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    const url = new URL(value)
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
    return (url.protocol === 'http:' || url.protocol === 'https:') && loopbackHosts.has(url.hostname) ? value : undefined
  } catch {
    return undefined
  }
}

export function createMainWindow(platform: NodeJS.Platform = process.platform): BrowserWindow {
  // CodeFly has no menu commands: remove the application menu entirely (also disables the
  // default Alt-key menu reveal); autoHideMenuBar is belt-and-braces for any platform path
  // that still attaches a default menu to the window.
  Menu.setApplicationMenu(null)

  // CodeFly starts dark: the renderer re-applies its persisted theme preference over the
  // theme:set IPC channel right after it loads (see use-app-store.ts initialize()), so a
  // light-theme user sees at most one dark first frame. Forcing the native theme here (not
  // 'system') keeps native scrollbars/dialogs consistent with the app theme; backgroundColor
  // keeps the first painted frame dark instead of flashing white before the renderer loads.
  nativeTheme.themeSource = 'dark'

  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: WINDOW_THEME_COLORS.dark.background,
    ...(platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: WINDOW_THEME_COLORS.dark.overlayColor,
            symbolColor: WINDOW_THEME_COLORS.dark.overlaySymbol,
            height: TITLE_BAR_HEIGHT
          }
        }),
    // In a packaged build the window/taskbar icon comes from the exe (electron-builder
    // win.icon); build/icon.ico only exists in the repo, so it is wired up for dev runs.
    ...(app.isPackaged || platform !== 'win32' ? {} : { icon: join(currentDirectory, '../../build/icon.ico') }),
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // CodeFly is a workspace, not a utility panel: a terminal beside a project sidebar wants all
  // the screen it can get, so the window opens maximized. The constructor width/height above
  // stay windowed-sized on purpose — they become the restore bounds when the user un-maximizes.
  window.maximize()

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const developmentUrl = app.isPackaged ? undefined : safeDevelopmentRendererUrl(process.env.ELECTRON_RENDERER_URL)
  if (developmentUrl) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'))
  }

  return window
}
