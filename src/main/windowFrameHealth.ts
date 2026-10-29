import { app, ipcMain, powerMonitor, type BrowserWindow } from 'electron'
import { performance } from 'node:perf_hooks'
import { FRAME_HEALTH_PROBE, FRAME_HEALTH_REPLY } from '../shared/frameHealth'
import { FrameHealthMonitor, FRAME_PROBE_INTERVAL_MS } from './frameHealth'

const recoveries: number[] = []
let reporter: ((kind: string, data: Record<string, unknown>) => void) | undefined
const earlyRecords: { kind: string; data: Record<string, unknown> }[] = []

export function setFrameHealthReporter(record: typeof reporter): void {
  reporter = record
  if (record) for (const { kind, data } of earlyRecords.splice(0)) record(kind, data)
}

function record(kind: string, data: Record<string, unknown>): void {
  console.warn(`[${kind}]`, data)
  if (reporter) reporter(kind, data)
  else { earlyRecords.push({ kind, data }); if (earlyRecords.length > 10) earlyRecords.shift() }
}

export function monitorWindowFrames(window: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  const contents = window.webContents
  let stopped = false
  const paused = new Set<string>()
  const monitor = new FrameHealthMonitor({
    recoveries,
    send: id => contents.send(FRAME_HEALTH_PROBE, id),
    record,
    recover: () => {
      // Only Chromium's GPU child owned by this app is eligible. Never match
      // process names, restart the app, or reload a renderer with unsaved input.
      const gpu = app.getAppMetrics().find(metric => metric.type === 'GPU')
      if (!gpu || !Number.isSafeInteger(gpu.pid) || gpu.pid <= 1 || gpu.pid === process.pid) return false
      if (!app.getAppMetrics().some(metric => metric.type === 'GPU' && metric.pid === gpu.pid && metric.creationTime === gpu.creationTime)) return false
      record('frame_gpu_restart', { pid: gpu.pid, creationTime: gpu.creationTime })
      process.kill(gpu.pid, 'SIGTERM')
      return true
    }
  })
  const onReply = (event: Electron.IpcMainEvent, message: unknown): void => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return
    monitor.reply(message, performance.now())
  }
  const reset = (): void => monitor.reset()
  const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame && !inPlace) reset()
  }
  const suspend = (): void => { paused.add('suspend'); reset() }
  const resume = (): void => { paused.delete('suspend'); reset() }
  const lock = (): void => { paused.add('lock'); reset() }
  const unlock = (): void => { paused.delete('lock'); reset() }
  const timer = setInterval(() => {
    if (stopped || window.isDestroyed() || contents.isDestroyed()) return
    monitor.tick(performance.now(), paused.size === 0 && window.isVisible() && !window.isMinimized() && !contents.isLoadingMainFrame())
  }, FRAME_PROBE_INTERVAL_MS)
  timer.unref()
  ipcMain.on(FRAME_HEALTH_REPLY, onReply)
  contents.on('did-start-navigation', navigation)
  contents.on('render-process-gone', reset)
  window.on('show', reset)
  window.on('hide', reset)
  window.on('minimize', reset)
  window.on('restore', reset)
  powerMonitor.on('suspend', suspend)
  powerMonitor.on('resume', resume)
  powerMonitor.on('lock-screen', lock)
  powerMonitor.on('unlock-screen', unlock)
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    ipcMain.removeListener(FRAME_HEALTH_REPLY, onReply)
    contents.removeListener('did-start-navigation', navigation)
    contents.removeListener('render-process-gone', reset)
    window.removeListener('show', reset)
    window.removeListener('hide', reset)
    window.removeListener('minimize', reset)
    window.removeListener('restore', reset)
    powerMonitor.removeListener('suspend', suspend)
    powerMonitor.removeListener('resume', resume)
    powerMonitor.removeListener('lock-screen', lock)
    powerMonitor.removeListener('unlock-screen', unlock)
    app.removeListener('before-quit', stop)
    window.removeListener('closed', stop)
  }
  window.once('closed', stop)
  app.once('before-quit', stop)
}
