import { app, BrowserWindow } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { monitorWindowFrames } from './windowFrameHealth'

const directory = dirname(fileURLToPath(import.meta.url))
let previewUrl: string | undefined
let startupWindow: BrowserWindow | undefined
export const startupTimings: Record<string, number> = { entryMs: Math.round(process.uptime() * 1000) }

export function resolveUiPath(relativePath: string): string {
  // Read physical files so repacking cannot reuse cached ASAR offsets or integrity metadata.
  const root = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'out')
    : join(directory, '..')
  return join(root, relativePath)
}

export function resolveHtmlPreviewUrl(): string {
  if (previewUrl) return previewUrl
  if (process.env.ELECTRON_RENDERER_URL) return new URL('html-preview.html', process.env.ELECTRON_RENDERER_URL).href
  const temporary = mkdtempSync(join(app.getPath('temp'), 'uniagent-preview-'))
  app.once('will-quit', () => rmSync(temporary, { recursive: true, force: true }))
  const path = join(temporary, 'html-preview.html')
  writeFileSync(path, readFileSync(resolveUiPath('renderer/html-preview.html')))
  previewUrl = pathToFileURL(path).href
  return previewUrl
}

export function createAppWindow(): BrowserWindow {
  const window = new BrowserWindow({
    show: false, width: 1280, height: 820, minWidth: 1024, minHeight: 640,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f1011',
    webPreferences: {
      preload: resolveUiPath('preload/index.cjs'),
      additionalArguments: [`--ua-html-preview-url=${resolveHtmlPreviewUrl()}`],
      sandbox: false
    }
  })
  monitorWindowFrames(window)
  return window
}

export function rememberStartupWindow(window: BrowserWindow): void { startupWindow = window }
export function takeStartupWindow(): BrowserWindow | undefined {
  const window = startupWindow
  startupWindow = undefined
  return window && !window.isDestroyed() ? window : undefined
}
