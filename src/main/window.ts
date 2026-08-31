import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

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

export function createMainWindow(): BrowserWindow {
  // CodeFly has no menu commands: remove the application menu entirely (also disables the
  // default Alt-key menu reveal); autoHideMenuBar is belt-and-braces for any platform path
  // that still attaches a default menu to the window.
  Menu.setApplicationMenu(null)

  // CodeFly's UI is dark-only. Forcing the dark native theme makes Windows render the OS
  // window title bar (and native scrollbars/dialogs) dark instead of following a light
  // system theme; backgroundColor keeps the first painted frame dark instead of flashing
  // white before the renderer loads. #0b0f14 mirrors --color-canvas in styles.css.
  nativeTheme.themeSource = 'dark'

  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    // In a packaged build the window/taskbar icon comes from the exe (electron-builder
    // win.icon); build/icon.ico only exists in the repo, so it is wired up for dev runs.
    ...(app.isPackaged ? {} : { icon: join(currentDirectory, '../../build/icon.ico') }),
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const developmentUrl = app.isPackaged ? undefined : safeDevelopmentRendererUrl(process.env.ELECTRON_RENDERER_URL)
  if (developmentUrl) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'))
  }

  return window
}
