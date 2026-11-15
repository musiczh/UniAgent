import assert from 'node:assert/strict'
import { projectTaskBoard } from '../src/shared/taskBoard'
import { DEFAULT_ROUTER_CONFIG, type RouterRequest } from '../src/shared/router'
import type { Session } from '../src/shared/types'

const request = (requestId: string, extra: Partial<RouterRequest> = {}): RouterRequest => ({
  requestId, prompt: '看板新增路由占位卡片', scope: { kind: 'global' }, config: DEFAULT_ROUTER_CONFIG,
  version: 1, state: 'queued', delivery: 'pending', createdAt: 1, updatedAt: 2, ...extra
})
const target: Session = { id: 'target', title: '目标任务', createdAt: 1, updatedAt: 3, status: 'running', config: { agentId: 'codex', workdir: '/fixture', projectId: 'p', requirementId: 'r' } }
const board = (requests: RouterRequest[], sessions: Session[] = [], query = {}) => projectTaskBoard(sessions, () => [], query, () => false, requests)
const rows = (value: ReturnType<typeof board>) => Object.values(value.columns).flatMap(column => column.items)

for (const state of ['queued', 'routing', 'committing', 'needs_input', 'failed'] as const) {
  const value = board([request('input', { state })])
  assert.equal(value.columns.active.total, 1, state + ' retains a reachable routing card')
  const card = value.columns.active.items[0]
  assert.equal(card.routerRequestId, 'input')
  assert.equal(card.id, 'router:input')
  assert.equal(card.title, '看板新增路由占位卡片')
  assert.equal(card.status, state === 'needs_input' ? '待确认' : state === 'failed' ? '路由失败' : '路由中')
  assert.equal(card.readOnly, true)
  assert.equal(card.canPause, false); assert.equal(card.canDecide, false)
  assert.equal(card.canDelete, state === 'failed', 'only failed routing placeholders expose deletion')
  assert.equal(card.routerRequestVersion, 1, 'routing deletion uses the version displayed to the user')
  assert.equal(value.focus.length, 0, 'routing cards do not enter the business task decision queue')
}
assert.equal(rows(board([request('cancelled', { state: 'cancelled' })])).length, 0)
const bound = request('input', { state: 'bound', targetId: target.id, delivery: 'running', version: 2 })
const completed = board([bound], [target])
assert.equal(completed.columns.active.total, 1)
assert.equal(completed.columns.active.items[0].id, target.id)
assert.equal(completed.columns.active.items[0].routerRequestId, undefined)
assert.equal(completed.columns.active.items[0].canPause, true)
assert.equal(rows(board([bound, { ...bound, requestId: 'reuse' }], [target, target])).length, 1, 'multiple inputs reuse one target card')
assert.equal(rows(board([request('input'), bound], [target])).length, 1, 'latest request version wins over a stale pending version')
assert.equal(rows(board([bound], [{ ...target, status: 'completed' }]))[0].column, 'decision', 'bound cards follow normal task lifecycle')
assert.equal(rows(board([{ ...bound, delivery: 'unknown' }], [target]))[0].id, target.id, 'uncertain delivery retains the actual target identity')

const scoped = request('requirement', { scope: { kind: 'requirement', requirementId: 'r' } })
const space = request('space', { scope: { kind: 'space', projectId: 'p' } })
assert.deepEqual(rows(board([scoped, space, request('global')], [], { requirementId: 'r' })).map(row => row.routerRequestId), ['requirement'])
assert.equal(rows(board([scoped]))[0].requirementId, 'r')
assert.equal(rows(board([space]))[0].projectId, 'p')
assert.equal(rows(board([request('global', { execution: target.config })]))[0].projectId, undefined, 'execution defaults do not invent a routing ownership')
const registered = { ...target, taskRegistration: { requestId: 'input', inputId: 'input', phase: 'provisioning' as const, delivery: 'registered' as const, inputText: '原输入', events: [] } }
const committing = board([request('input', { state: 'committing' })], [registered])
assert.equal(committing.columns.active.total, 1, 'registration before routing receipt does not duplicate a newly created task')
assert.equal(committing.columns.active.items[0].routerRequestId, 'input')
assert.equal(rows(board([bound], [registered]))[0].id, target.id)
const pagination = board(Array.from({ length: 31 }, (_, i) => request('input-' + i, { updatedAt: i + 1 })), [], { pages: { active: 1 } })
assert.equal(pagination.columns.active.total, 31); assert.equal(pagination.columns.active.pages, 2)
assert.equal(pagination.columns.active.items.length, 1)
assert.equal(pagination.columns.active.items[0].routerRequestId, 'input-0')
console.log('PASS routing card projection, all pending states, binding replacement, reuse dedup, ownership, registration race and pagination')
