import type { Session, SessionStatus } from './types'
import { isTaskTitleEligible, taskDisplayTitle } from './taskTitle'

/** Ordinary tasks have an App title; managed sessions keep their native name. */
export function sessionDisplayTitle(session: Session): string {
  return isTaskTitleEligible(session) ? taskDisplayTitle(session) : session.title || '未命名会话'
}

export type TaskInputState = 'registered' | 'accepted' | 'dispatching' | 'dispatched' | 'unknown'
export interface TaskRegistration {
  requestId: string
  inputId: string
  phase: 'provisioning' | 'active'
  delivery: TaskInputState
  inputText: string
  events: Array<{ state: TaskInputState; ts: number }>
}

export type TaskScope = { kind: 'space'; projectId: string } | { kind: 'requirement'; requirementId: string }

export const TASK_EXECUTION_LABELS: Record<SessionStatus, string> = {
  draft: '尚未开始', idle: '等待继续', running: '正在执行', queued: '正在执行 · 有排队输入',
  'awaiting-approval': '等待你处理', cancelling: '正在停止', cancelled: '已停止',
  interrupted: '执行已中断', error: '执行异常', completed: '本轮已结束', archived: '已归档'
}
