import { BrowserWindow, shell } from 'electron'

export interface CreateWindowOptions {
  readonly preloadPath: string
}

/**
 * Creates the main renderer window with a secure default posture.
 *
 * Security baseline:
 *   - contextIsolation enabled
 *   - nodeIntegration disabled
 *   - sandbox enabled (sandbox-compatible preload only)
 *   - no remote module
 *   - allowlist-based navigation (see main/index.ts)
 */
export function createWindow(options: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Min Plane DXF',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // electron-vite injects ELECTRON_RENDERER_URL during `pnpm dev` and writes
  // the bundled index.html into out/renderer/index.html for `pnpm build`.
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(new URL('../../renderer/index.html', import.meta.url).pathname)
  }

  return window
}
