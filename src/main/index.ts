import { app, BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createWindow } from './app/createWindow.js'
import {
  initializeWorkspaceProject,
  registerIpcHandlers,
  unregisterIpcHandlers
} from './ipc/handlers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Single instance: a second launch focuses the existing window.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const all = BrowserWindow.getAllWindows()
    const first = all[0]
    if (first) {
      if (first.isMinimized()) first.restore()
      first.focus()
    }
  })
}

/**
 * Open external links in the default browser instead of inside the app.
 * Deny navigation to anything other than the local renderer.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    const isLocal = url.startsWith('file://') || url.startsWith('devtools://')
    if (!isLocal) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
})

app.whenReady().then(async () => {
  await initializeWorkspaceProject()
  registerIpcHandlers()

  createWindow({ preloadPath: join(__dirname, '../preload/index.cjs') })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow({ preloadPath: join(__dirname, '../preload/index.cjs') })
    }
  })
})

app.on('window-all-closed', () => {
  unregisterIpcHandlers()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
