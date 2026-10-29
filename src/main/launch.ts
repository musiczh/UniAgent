import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/types'
import { relaunchApp } from './appRelaunch'
import { createAppWindow, rememberStartupWindow, resolveUiPath, startupTimings } from './startupWindow'
import { APP_NAME, INTERNAL_DISTRIBUTION } from '../shared/distribution'

if (!INTERNAL_DISTRIBUTION) {
  app.setName(APP_NAME)
  process.env.UNIAGENT_USER_DATA ||= app.getPath('userData')
}

// Chromium 130's macOS display-link source can stop delivering BeginFrame while
// both JS event loops remain responsive. Retain GPU rendering with its bounded
// DelayBasedBeginFrameSourceMac fallback (must be selected before app readiness).
if (process.platform === 'darwin') {
  const disabled = app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean)
  if (!disabled.includes('CVDisplayLinkBeginFrameSource')) disabled.push('CVDisplayLinkBeginFrameSource')
  app.commandLine.appendSwitch('disable-features', disabled.join(','))
}
if (process.env.UA_DISABLE_GPU) app.disableHardwareAcceleration()

let startupWindow: BrowserWindow | undefined
let restartRequested = false

if (process.argv.includes('--uniagent-migrate-secrets') && process.send) {
  void import('./legacySecretMigration').then(module => module.runLegacySecretMigrationWorker()).catch(() => app.exit(1))
} else app.whenReady().then(async () => {
  startupTimings.electronReadyMs = Math.round(process.uptime() * 1000)
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const trustedUrls = rendererUrl
    ? [new URL(rendererUrl).href, new URL('index.html', rendererUrl).href, new URL('boot.html', rendererUrl).href]
    : ['index.html', 'boot.html'].map(file => pathToFileURL(resolveUiPath(`renderer/${file}`)).href)
  ipcMain.handle(IPC.restartApp, (event) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !trustedUrls.includes(frame.url)) {
      throw new Error('untrusted_restart_request')
    }
    if (restartRequested) return
    restartRequested = true
    relaunchApp()
  })
  const window = createAppWindow()
  startupWindow = window
  rememberStartupWindow(window)
  const painted = once(window, 'ready-to-show').then(() => {
    if (window.isDestroyed()) return
    window.show()
    startupTimings.windowShownMs = Math.round(process.uptime() * 1000)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(new URL('boot.html', process.env.ELECTRON_RENDERER_URL).href)
  } else {
    await window.loadFile(resolveUiPath('renderer/boot.html'))
  }
  startupTimings.bootLoadedMs = Math.round(process.uptime() * 1000)
  await painted
  if (window.isDestroyed()) return
  // Load stores, providers and their SDKs only after the small startup document is visible.
  await new Promise<void>((resolve) => setImmediate(resolve))
  await import('./index')
}).catch((error) => {
  console.error('[startup]', error)
  if (startupWindow && !startupWindow.isDestroyed() && startupWindow.webContents.getURL()) {
    startupWindow.show()
    startupWindow.webContents.send(IPC.startupFailed)
  } else {
    void dialog.showMessageBox({ type: 'error', title: `${APP_NAME} 启动失败`, message: `初始化未完成，请重新启动 ${APP_NAME}。` })
  }
})
