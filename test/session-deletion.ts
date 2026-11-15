import assert from 'node:assert/strict'
import { clearSessionDeletionError, deleteConfirmedSession, getSessionDeletionSnapshot, sessionDeletionDetails } from '../src/renderer/sessionDeletion'
import type { SessionDeletionPreview } from '../src/shared/types'

const preview: SessionDeletionPreview = { confirmationId: 'checked', title: '优化工作树', team: false, worktrees: [] }
const tree = { path: '/fixture/task/repo', branch: 'uniagent/task-a', dirty: false, sharedCount: 0, removed: false }
assert.match(sessionDeletionDetails(preview).notes.join('\n'), /项目文件保留/)
const clean = sessionDeletionDetails({ ...preview, worktrees: [tree] })
assert.equal(clean.clean, true)
assert.equal(clean.removing[0].branch, 'uniagent/task-a')
assert.equal(clean.action, '删除任务及工作树')
assert.match(clean.notes.join('\n'), /Git 分支与标签保留/)
const dirty = { ...preview, worktrees: [{ ...tree, dirty: true }] }
assert.match(sessionDeletionDetails(dirty).warning, /永久丢弃/)
assert.match(sessionDeletionDetails(dirty).warning, /提交或备份/)
assert.match(sessionDeletionDetails(dirty).scope, /含 Git 忽略文件/)
const shared = sessionDeletionDetails({ ...preview, worktrees: [{ ...tree, dirty: true, sharedCount: 2 }] })
assert.match(shared.notes.join('\n'), /其他 2 个任务/)
assert.match(shared.notes.join('\n'), /本次保留工作树/)
assert.equal(shared.warning, '')
assert.equal(shared.removing.length, 0)
assert.match(sessionDeletionDetails({ ...preview, team: true, worktrees: [tree] }).scope, /成员会话记录/)
assert.match(sessionDeletionDetails({ ...preview, worktrees: [{ ...tree, removed: true }] }).notes.join('\n'), /已清理/)

const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
const calls: string[] = []
let release: () => void = () => {}, failDelete = true
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  uniagent: {
    deleteSession: async (id: string, confirmationId: string) => { calls.push('delete:' + id + ':' + confirmationId); await new Promise<void>(resolve => { release = resolve }); if (failDelete) throw Error('清理失败') }
  }
} })
try {
  const deletion = deleteConfirmedSession('task', 'checked', ['task', 'member'])
  assert.deepEqual([...getSessionDeletionSnapshot().hiddenIds], ['task', 'member'], 'confirmed tasks hide before the backend finishes')
  await assert.rejects(deleteConfirmedSession('task', 'checked'), /正在删除/)
  assert.equal(calls.length, 1, 'duplicate clicks never start a second deletion')
  release(); await assert.rejects(deletion, /清理失败/)
  assert.equal(getSessionDeletionSnapshot().hiddenIds.size, 0, 'failure restores the entire task group')
  assert.equal(getSessionDeletionSnapshot().error, '清理失败')
  clearSessionDeletionError(); assert.equal(getSessionDeletionSnapshot().error, '')
  failDelete = false
  const retry = deleteConfirmedSession('task', 'checked')
  release(); await retry
  assert.equal(getSessionDeletionSnapshot().hiddenIds.has('task'), true, 'late snapshots cannot reintroduce a successfully deleted task')
  assert.deepEqual(calls, ['delete:task:checked', 'delete:task:checked'])
  console.log('PASS deletion details and background state: clean/dirty/shared/team/removed, checked token, immediate hide, duplicate guard, group recovery and retry')
} finally {
  if (previous) Object.defineProperty(globalThis, 'window', previous); else delete (globalThis as any).window
}
