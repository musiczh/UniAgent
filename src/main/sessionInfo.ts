import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Session } from '../shared/types'
import { sessionInfoSnapshot, type SessionInfo, type SessionInfoField } from '../shared/sessionInfo'
import { resolveNativeSessionFile } from './history'

const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')

/** Read-only and on demand: no provider process, history replay or network request. */
export async function readSessionInfo(session: Session, diagnosticLog?: string): Promise<SessionInfo> {
  const info = sessionInfoSnapshot(session)
  const inspectPath = async (field: SessionInfoField, fileOnly = false): Promise<boolean> => {
    if (!isAbsolute(field.value) || field.value.includes('\0')) return false
    try {
      const entry = await stat(field.value)
      if (!entry.isFile() && !entry.isDirectory() || fileOnly && !entry.isFile()) return false
      field.path = field.value
      return true
    } catch (error) {
      if (!missing(error)) info.errors.push({ label: field.label, message: '读取失败' })
      return false
    }
  }
  await Promise.all([
    ...info.native.filter(field => ['workdir', 'kimiDataHome',
      
    ].includes(field.id)).map(field => inspectPath(field)),
    (async () => {
      if (!session.nativeSessionId) return
      try {
        const file = await resolveNativeSessionFile(session.config.agentId, session.nativeSessionId, true)
        if (!file) return
        const field = { id: 'sessionFile', label: '会话文件', value: file }
        if (await inspectPath(field, true)) info.native.push(field)
      } catch {
        info.errors.push({ label: '会话文件', message: '读取失败' })
      }
    })(),
    (async () => {
      if (!diagnosticLog) return
      const field = { id: 'diagnosticLog', label: '诊断日志', value: diagnosticLog }
      if (await inspectPath(field, true)) info.local.push(field)
    })()
  ])
  return info
}
