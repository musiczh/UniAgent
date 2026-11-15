import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { IPC } from '../src/shared/types'
import { registerSessionDeletionIpc } from '../src/main/sessionDeletionIpc'

const handlers = new Map<string, (...args: any[]) => any>(), deletingIds = new Set<string>()
const sessions = new Map(['tree', 'local', 'leader', 'member'].map(id => [id, { id, title: id, config: { ...(id === 'tree' || id === 'member' ? { worktree: { removedAt: undefined as number | undefined } } : {}) } }]))
const team = { id: 'team', name: '团队', team: { leaderMemberId: 'l' }, memberSessions: { l: 'leader', m: 'member' } }
let hydrated: Promise<void> = Promise.resolve(), checkCalls = 0, deleteCalls = 0, changes = 0
let releaseDelete = () => {}, failDelete = false, lastSignal: AbortSignal | undefined
const preview = { confirmationId: 'checked', title: '任务', team: false, worktrees: [] }
const inspect = async (_id: string, signal: AbortSignal) => {
  checkCalls++; lastSignal = signal
  signal.throwIfAborted()
  await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  return preview
}
const remove = async () => { deleteCalls++; await new Promise<void>(resolve => { releaseDelete = resolve }); if (failDelete) throw Error('记录写入失败') }
registerSessionDeletionIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
  assertTrusted: event => { if (!(event as any).trusted) throw Error('untrusted') }, hydrate: () => hydrated,
  orchestrator: { getSessionById: id => sessions.get(id), assertUserSessionEnabled: id => { if (!sessions.has(id)) throw Error('missing') }, previewSessionDeletion: (id, signal) => id === 'local' ? Promise.resolve(preview) : inspect(id, signal!), deleteSession: remove } as any,
  teams: { catalog: () => ({ projects: [team] }), previewDeleteProject: (_id: string, signal: AbortSignal) => inspect('team', signal), deleteProject: remove } as any,
  deletingIds, changed: () => { changes++ }
})
function sender(id: number) {
  const value = Object.assign(new EventEmitter(), { id, messages: [] as any[], send: (channel: string, data: unknown) => { value.messages.push({ channel, data }) } })
  return { sender: value, trusted: true }
}
const first = sender(1), second = sender(2), invoke = (channel: string, event: any, ...args: any[]) => handlers.get(channel)!(event, ...args)
const tick = () => new Promise(resolve => setImmediate(resolve))
await assert.rejects(invoke(IPC.previewSessionDeletion, { ...first, trusted: false }, 'tree', 'a'), /untrusted/)
await assert.rejects(invoke(IPC.previewSessionDeletion, first, '', 'a'), /invalid_session/)
await assert.rejects(invoke(IPC.previewSessionDeletion, first, 'tree', {}), /invalid_deletion_request/)
assert.throws(() => invoke(IPC.cancelSessionDeletionPreview, first, ''), /invalid_deletion_request/)
await assert.rejects(invoke(IPC.deleteSession, first, 'tree', {}), /invalid_deletion_confirmation/)
await assert.rejects(invoke(IPC.deleteSession, first, 'member', 'checked'), /team_member_read_only/)

await invoke(IPC.previewSessionDeletion, first, 'local', 'local-check')
assert.equal(first.sender.messages.length, 0, 'local tasks skip worktree-check progress')
const inspection = invoke(IPC.previewSessionDeletion, first, 'tree', 'a')
const rejection = assert.rejects(inspection, { name: 'AbortError' })
await tick()
assert.deepEqual(first.sender.messages.at(-1), { channel: IPC.sessionDeletionChecking, data: { requestId: 'a', title: 'tree' } })
await assert.rejects(invoke(IPC.previewSessionDeletion, first, 'tree', 'a'), /正在进行/)
invoke(IPC.cancelSessionDeletionPreview, second, 'a')
assert.equal(lastSignal!.aborted, false, 'a different renderer cannot cancel this request')
invoke(IPC.cancelSessionDeletionPreview, first, 'a'); await rejection
assert.equal(first.sender.listenerCount('destroyed'), 0)

let hydrateRelease = () => {}
hydrated = new Promise(resolve => { hydrateRelease = resolve })
const callsBefore = checkCalls, waiting = invoke(IPC.previewSessionDeletion, first, 'tree', 'hydrate')
const waitingRejection = assert.rejects(waiting, { name: 'AbortError' })
invoke(IPC.cancelSessionDeletionPreview, first, 'hydrate'); hydrateRelease(); await waitingRejection
assert.equal(checkCalls, callsBefore, 'cancellation during hydration never starts Git')
hydrated = Promise.resolve()
const teamCheck = invoke(IPC.previewSessionDeletion, first, 'leader', 'team-check')
const teamRejection = assert.rejects(teamCheck, { name: 'AbortError' }); await tick()
assert.equal(first.sender.messages.at(-1).data.title, '团队', 'a member worktree is included when inspecting the leader task')
first.sender.emit('destroyed'); await teamRejection
assert.equal(first.sender.listenerCount('destroyed'), 0)

failDelete = true
const deletion = invoke(IPC.deleteSession, first, 'tree', 'checked'), deletionFailure = assert.rejects(deletion, /工作树已清理，任务记录删除失败.*记录写入失败/)
await tick()
assert.deepEqual([...deletingIds], ['tree'])
await assert.rejects(invoke(IPC.deleteSession, second, 'tree', 'checked'), /正在删除/)
assert.equal(deleteCalls, 1)
sessions.get('tree')!.config.worktree!.removedAt = 1
releaseDelete(); await deletionFailure
assert.equal(deletingIds.size, 0, 'failure restores the task to queried lists')
failDelete = false
const teamDelete = invoke(IPC.deleteSession, first, 'leader', 'checked'); await tick()
assert.deepEqual([...deletingIds], ['leader', 'member'])
releaseDelete(); await teamDelete
assert.equal(deletingIds.size, 0)
assert.equal(changes, 4, 'publish before cleanup and after success or failure')
console.log('PASS deletion IPC: trusted callers, input validation, request ownership, cancellation during hydration/checking/window destruction, local skip, team worktree, duplicate deletion, pending group and partial-failure recovery')
