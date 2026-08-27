import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApp, browserWindow, fakeWindow, mockMenu } = vi.hoisted(() => {
  const fakeWindow = {
    loadURL: vi.fn(async () => undefined),
    loadFile: vi.fn(async () => undefined),
    webContents: { setWindowOpenHandler: vi.fn() }
  }
  return {
    mockApp: { isPackaged: false },
    browserWindow: vi.fn(function BrowserWindowMock() {
      return fakeWindow
    }),
    fakeWindow,
    mockMenu: { setApplicationMenu: vi.fn() }
  }
})

vi.mock('electron', () => ({ app: mockApp, BrowserWindow: browserWindow, Menu: mockMenu }))

import { createMainWindow } from './window'

describe('createMainWindow', () => {
  beforeEach(() => {
    mockApp.isPackaged = false
    browserWindow.mockClear()
    fakeWindow.loadURL.mockClear()
    fakeWindow.loadFile.mockClear()
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
})
