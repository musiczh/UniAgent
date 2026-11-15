import type { UAEvent } from './types'

export const TASK_GENERATION_IPC = { read: 'task-generation:read', changed: 'task-generation:changed' } as const
export type TaskGenerationKind = 'title-description' | 'quick-replies' | 'context-summary'
export const TASK_GENERATION_LABELS: Record<TaskGenerationKind, string> = {
  'title-description': '标题与描述', 'quick-replies': '快捷回复', 'context-summary': '生成上下文压缩'
}
export interface TaskGenerationConversation {
  taskId: string
  events: UAEvent[]
  running: boolean
  legacyHistory: boolean
}
