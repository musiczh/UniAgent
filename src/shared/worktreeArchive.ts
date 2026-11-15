export const WORKTREE_ARCHIVE_IPC = { list: 'worktree-archive:list', act: 'worktree-archive:act', changed: 'worktree-archive:changed' } as const
export const ARCHIVE_CANCELLED = 'worktree_archive_cancelled'
export const isArchiveCancelled = (error: unknown): boolean => String(error).includes(ARCHIVE_CANCELLED)
export interface WorktreeArchiveCheck { treeId: string; sourceBranch: string; changedFiles: number; unmergedCommits: number; gitOperation?: string }
export interface WorktreeArchiveReview {
  id: string; taskId: string; title: string; version: number
  phase: 'checking' | 'pending' | 'sending' | 'waiting' | 'failed'
  checks: WorktreeArchiveCheck[]; error?: string
}
export interface WorktreeArchiveAction { id: string; version: number; action: 'cancel' | 'merge' | 'retry' }
