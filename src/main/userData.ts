import { createRequire } from 'node:module'
import { join } from 'node:path'

export function resolveUserDataHome(legacyDefault?: string): string {
  if (process.env.UNIAGENT_USER_DATA) return process.env.UNIAGENT_USER_DATA
  if (legacyDefault !== undefined) return legacyDefault
  try {
    const electron = createRequire(import.meta.url)('electron') as { app?: { getPath(name: string): string } }
    if (electron.app?.getPath) return electron.app.getPath('userData')
  } catch { /* plain Node tests */ }
  return join(process.env.HOME || '.', '.uniagent-public')
}
