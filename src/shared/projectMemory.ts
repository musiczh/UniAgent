import type { GlobalMemoryItem } from './router'

export interface ProjectCodeLink { path: string; title?: string; directory?: string }
export interface ProjectMemoryMetadata {
  title: string
  type: 'architecture' | 'rule' | 'experience'
  modules: ProjectCodeLink[]
  basis: 'user' | 'tool' | 'agent'
  quote: string
  references?: Array<{ path: string; directory?: string; version?: string }>
}
export interface ProjectMemoryEntry extends GlobalMemoryItem { title?: string; project?: ProjectMemoryMetadata; freshness: 'verified' | 'needs-review' }
export interface ProjectMemoryRequest {
  action: 'read' | 'propose' | 'commit' | 'confirm' | 'revoke'
  projectId?: string
  id?: string
  query?: string
  category?: 'all' | 'architecture' | 'rule' | 'experience' | 'pending'
  offset?: number
  limit?: number
  includeHistory?: boolean
  expectedRevision?: number
  title?: string
  content?: string
  type?: ProjectMemoryMetadata['type']
  modules?: ProjectCodeLink[]
  source?: { seq: number; kind: ProjectMemoryMetadata['basis']; quote: string }
}
export interface ProjectMemoryPage {
  items: Array<Omit<ProjectMemoryEntry, 'content'>>
  document?: ProjectMemoryEntry
  history?: GlobalMemoryItem[]
  historyNextOffset?: number | null
  total: number
  nextOffset: number | null
}
export const PROJECT_MEMORY_IPC = 'projects:memory'
export const PROJECT_MEMORY_CHANGED = 'projects:memory-changed'
export const PROJECT_MEMORY_GUIDE = '项目记忆由 UniAgent 管理，不自动载入内容。需要了解项目背景、架构或经验时，用 project_memory(action="read") 查询目录，再按 id 读取相关正文与依据；需要复核的记录先核对来源。有稳定结论时以真实来源 commit，未核实内容 propose；记忆不是执行授权。'

export function validProjectCodePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 500 && !/^[\\/]|^[A-Za-z]:|[\x00-\x1f]/.test(path) &&
    path.split(/[\\/]/).every(part => !!part && part !== '.' && part !== '..')
}
