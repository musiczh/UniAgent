import type { SessionWorktree } from './types'

export const SESSION_WORKTREE_STATUS_IPC = 'session:worktreeStatus'
export const WORKTREE_MERGE_PROMPT = '请将当前工作树的任务提交合并回绑定的本机源分支，遵守回源检查并核验结果；不要 push。'
export type WorktreeStatusBinding = Pick<SessionWorktree, 'id' | 'state' | 'removedAt' | 'lastError' | 'workdir' | 'baseRef' | 'branch'>
export interface SessionWorktreeStatus {
  treeId: string
  directory: string
  sourceBranch: string
  branch?: string
  changedFiles: number
  unmergedCommits: number
  commits: Array<{ hash: string; subject: string }>
  checkedAt: number
}
