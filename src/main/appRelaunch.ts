import { app } from 'electron'

let requested = false
/** Shared by startup recovery and managed restarts: Electron queues every call. */
export function relaunchApp(options?: { execPath: string; args: string[] }): void {
  if (requested) throw new Error('应用已经安排重启')
  app.relaunch(options)
  requested = true
  app.quit()
}
