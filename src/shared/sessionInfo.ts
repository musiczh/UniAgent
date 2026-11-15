import type { Session } from './types'
import { APP_NAME } from './distribution'

export interface SessionInfoField {
  id: string
  label: string
  value: string
  /** Present only after the main process confirms this file or directory exists. */
  path?: string
}

export interface SessionInfo {
  native: SessionInfoField[]
  local: SessionInfoField[]
  errors: Array<{ label: string; message: string }>
}

/** Metadata already owned by the session; never infer a provider's file layout. */
export function sessionInfoSnapshot(session: Session): SessionInfo {
  const native: SessionInfoField[] = []
  const add = (id: string, label: string, value?: string): void => {
    if (value?.trim()) native.push({ id, label, value })
  }
  add('nativeSessionId', 'Session ID', session.nativeSessionId)
  add('workdir', '工作目录', session.config.workdir)
  if (session.config.agentId === 'kimi') add('kimiDataHome', '会话数据目录', session.config.kimiDataHome)
  if (session.config.agentId === 'zcode' && session.zcodeState) {
    add('workspaceKey', 'Workspace Key', session.zcodeState.workspaceKey)
    add('dataRootId', 'Data Root ID', session.zcodeState.dataRootId)
  }
  
  return { native, local: [{ id: 'sessionId', label: '会话 ID', value: session.id }], errors: [] }
}

export function formatSessionInfo(info: SessionInfo, agentName: string, task?: { title: string; description: string }): string {
  return [...(task ? ['任务信息', `任务名称: ${task.title}`, `任务描述: ${task.description}`, ''] : []), agentName, ...info.native.map(field => `${field.label}: ${field.value}`),
    '', APP_NAME, ...info.local.map(field => `${field.label}: ${field.value}`)].join('\n')
}

/** Reveal by field identity, never by a renderer-supplied filesystem path. */
export function sessionInfoRevealPath(info: SessionInfo, fieldId: string): string {
  const field = [...info.native, ...info.local].find(field => field.id === fieldId)
  if (!field?.path) throw new Error('该文件或目录当前不可用，请重新打开会话信息后重试')
  return field.path
}
