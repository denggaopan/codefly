import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApp, browserWindow, fakeWindow, mockMenu, mockNativeTheme } = vi.hoisted(() => {
  const fakeWindow = {
    loadURL: vi.fn(async () => undefined),
    loadFile: vi.fn(async () => undefined),
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    isAlwaysOnTop: vi.fn(() => false),
    webContents: { setWindowOpenHandler: vi.fn() }
  }
  return {
    mockApp: { isPackaged: false },
    browserWindow: vi.fn(function BrowserWindowMock() {
      return fakeWindow
    }),
    fakeWindow,
    mockMenu: { setApplicationMenu: vi.fn() },
    mockNativeTheme: { themeSource: 'system' as string }
  }
})

vi.mock('electron', () => ({ app: mockApp, BrowserWindow: browserWindow, Menu: mockMenu, nativeTheme: mockNativeTheme }))

import { applyWindowPinned, applyWindowTheme, createMainWindow, TITLE_BAR_HEIGHT } from './window'

describe('createMainWindow', () => {
  beforeEach(() => {
    mockApp.isPackaged = false
    browserWindow.mockClear()
    fakeWindow.loadURL.mockClear()
    fakeWindow.loadFile.mockClear()
    fakeWindow.setBackgroundColor.mockClear()
    fakeWindow.setTitleBarOverlay.mockClear()
    fakeWindow.webContents.setWindowOpenHandler.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('always loads the bundled renderer when the application is packaged', () => {
    mockApp.isPackaged = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://attacker.example/renderer')

    createMainWindow()

    expect(fakeWindow.loadURL).not.toHaveBeenCalled()
    expect(fakeWindow.loadFile).toHaveBeenCalledOnce()
  })

  it.each(['http://localhost:5173', 'https://127.0.0.1:5173', 'http://[::1]:5173'])(
    'loads a loopback development renderer URL: %s',
    (rendererUrl) => {
      vi.stubEnv('ELECTRON_RENDERER_URL', rendererUrl)

      createMainWindow()

      expect(fakeWindow.loadURL).toHaveBeenCalledWith(rendererUrl)
      expect(fakeWindow.loadFile).not.toHaveBeenCalled()
    }
  )

  it.each(['https://attacker.example/renderer', 'file:///C:/untrusted.html', 'not a URL'])(
    'falls back to the bundled renderer for an unsafe development URL: %s',
    (rendererUrl) => {
      vi.stubEnv('ELECTRON_RENDERER_URL', rendererUrl)

      createMainWindow()

      expect(fakeWindow.loadURL).not.toHaveBeenCalled()
      expect(fakeWindow.loadFile).toHaveBeenCalledOnce()
    }
  )

  it('denies renderer-created child windows', () => {
    createMainWindow()

    expect(fakeWindow.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
    const handler = fakeWindow.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => { action: string }
    expect(handler()).toEqual({ action: 'deny' })
  })

  it('removes the application menu bar entirely', () => {
    createMainWindow()

    expect(mockMenu.setApplicationMenu).toHaveBeenCalledWith(null)
    const [options] = browserWindow.mock.calls[0] as unknown as [{ autoHideMenuBar?: boolean }]
    expect(options.autoHideMenuBar).toBe(true)
  })

  it('sets the app icon on the window in development, deferring to the exe icon when packaged', () => {
    createMainWindow()
    const [devOptions] = browserWindow.mock.calls[0] as unknown as [{ icon?: string }]
    expect(devOptions.icon).toMatch(/icon\.ico$/)

    browserWindow.mockClear()
    mockApp.isPackaged = true
    createMainWindow()
    const [packagedOptions] = browserWindow.mock.calls[0] as unknown as [{ icon?: string }]
    expect(packagedOptions.icon).toBeUndefined()
  })

  it('starts dark: native theme, startup background, and caption-button overlay colors', () => {
    mockNativeTheme.themeSource = 'system'

    createMainWindow()

    expect(mockNativeTheme.themeSource).toBe('dark')
    const [options] = browserWindow.mock.calls[0] as unknown as [
      { backgroundColor?: string; titleBarStyle?: string; titleBarOverlay?: { color: string; symbolColor: string; height: number } }
    ]
    expect(options.backgroundColor).toBe('#0b0f14')
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.titleBarOverlay).toEqual({ color: '#11161d', symbolColor: '#e7edf5', height: TITLE_BAR_HEIGHT })
  })

  it('uses inset native traffic lights and no Windows icon on macOS', () => {
    createMainWindow('darwin')

    const [options] = browserWindow.mock.calls[0] as unknown as [
      { icon?: string; titleBarStyle?: string; titleBarOverlay?: unknown }
    ]
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.titleBarOverlay).toBeUndefined()
    expect(options.icon).toBeUndefined()
  })
})

describe('applyWindowTheme', () => {
  beforeEach(() => {
    fakeWindow.setBackgroundColor.mockClear()
    fakeWindow.setTitleBarOverlay.mockClear()
  })

  it('applies the light theme to the native theme source, window background, and overlay', () => {
    applyWindowTheme(fakeWindow as unknown as Electron.BrowserWindow, 'light')

    expect(mockNativeTheme.themeSource).toBe('light')
    expect(fakeWindow.setBackgroundColor).toHaveBeenCalledWith('#f5f7fa')
    expect(fakeWindow.setTitleBarOverlay).toHaveBeenCalledWith({ color: '#ffffff', symbolColor: '#1c2733', height: TITLE_BAR_HEIGHT })
  })

  it('applies the dark theme back', () => {
    applyWindowTheme(fakeWindow as unknown as Electron.BrowserWindow, 'dark')

    expect(mockNativeTheme.themeSource).toBe('dark')
    expect(fakeWindow.setBackgroundColor).toHaveBeenCalledWith('#0b0f14')
    expect(fakeWindow.setTitleBarOverlay).toHaveBeenCalledWith({ color: '#11161d', symbolColor: '#e7edf5', height: TITLE_BAR_HEIGHT })
  })

  it('does not call the Windows title-bar overlay API on macOS', () => {
    applyWindowTheme(fakeWindow as unknown as Electron.BrowserWindow, 'light', 'darwin')

    expect(mockNativeTheme.themeSource).toBe('light')
    expect(fakeWindow.setBackgroundColor).toHaveBeenCalledWith('#f5f7fa')
    expect(fakeWindow.setTitleBarOverlay).not.toHaveBeenCalled()
  })
})

describe('applyWindowPinned', () => {
  beforeEach(() => {
    fakeWindow.setAlwaysOnTop.mockClear()
    fakeWindow.isAlwaysOnTop.mockReturnValue(false)
  })

  it('pins the window and reports the flag it ended up with', () => {
    fakeWindow.isAlwaysOnTop.mockReturnValue(true)

    expect(applyWindowPinned(fakeWindow as unknown as Electron.BrowserWindow, true)).toBe(true)
    expect(fakeWindow.setAlwaysOnTop).toHaveBeenCalledWith(true)
  })

  it('unpins the window again', () => {
    expect(applyWindowPinned(fakeWindow as unknown as Electron.BrowserWindow, false)).toBe(false)
    expect(fakeWindow.setAlwaysOnTop).toHaveBeenCalledWith(false)
  })

  // The window is asked, not assumed: a window manager that refuses always-on-top must not
  // leave the title bar's pin button showing a state the window never took.
  it('reports the window back rather than echoing the request', () => {
    fakeWindow.isAlwaysOnTop.mockReturnValue(false)

    expect(applyWindowPinned(fakeWindow as unknown as Electron.BrowserWindow, true)).toBe(false)
  })
})
