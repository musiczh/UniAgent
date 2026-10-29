import assert from 'node:assert/strict'
import { readThreadTurns, readThreadTurnItems } from '../src/main/appServerHistory.ts'

function client(handler: (method: string, params: any) => unknown) {
  const calls: Array<{ method: string; params: any }> = []
  return {
    calls,
    async request<T>(method: string, params: any): Promise<T> {
      calls.push({ method, params })
      return await handler(method, params) as T
    }
  }
}

const turns = client((method, params) => {
  assert.equal(method, 'thread/turns/list')
  assert.equal(params.itemsView, 'full')
  return params.cursor
    ? { data: [{ id: 'turn-2', items: [] }], nextCursor: null }
    : { data: [{ id: 'turn-1', items: [] }], nextCursor: 'older' }
})
assert.deepEqual(await readThreadTurns(turns, 'thread-1'), [
  { id: 'turn-1', items: [] }, { id: 'turn-2', items: [] }
])
assert.equal(turns.calls[1].params.cursor, 'older')

const items = client((method, params) => {
  assert.equal(method, 'thread/items/list')
  assert.equal(params.turnId, 'turn-2')
  return params.cursor
    ? { data: [{ turnId: 'turn-2', item: { id: 'image-2' } }], nextCursor: null }
    : { data: [{ turnId: 'turn-2', item: { id: 'image-1' } }], nextCursor: 'next' }
})
assert.deepEqual(await readThreadTurnItems(items, 'thread-1', 'turn-2'), [
  { id: 'image-1' }, { id: 'image-2' }
])

const unsupportedItems = client((method) => {
  if (method === 'thread/items/list') throw new Error('thread/items/list is not supported yet')
  assert.equal(method, 'thread/turns/list')
  return { data: [{ id: 'turn-2', items: [{ id: 'image-1' }] }], nextCursor: null }
})
assert.deepEqual(await readThreadTurnItems(unsupportedItems, 'thread-1', 'turn-2'), [{ id: 'image-1' }])

const legacy = client((method) => {
  if (method === 'thread/items/list') throw Object.assign(new Error('Method not found'), { code: -32601 })
  if (method === 'thread/turns/list') throw new Error('Invalid request: unknown variant `thread/turns/list`')
  assert.equal(method, 'thread/read')
  return { thread: { turns: [{ id: 'turn-2', items: [{ id: 'image-1' }] }] } }
})
assert.deepEqual(await readThreadTurnItems(legacy, 'thread-1', 'turn-2'), [{ id: 'image-1' }])
assert.deepEqual(legacy.calls.at(-1)?.params, { threadId: 'thread-1', includeTurns: true })

for (const message of ['thread not found', 'permission denied', 'app-server disconnected']) {
  const failed = client(() => { throw new Error(message) })
  await assert.rejects(readThreadTurns(failed, 'thread-1'), { message })
  await assert.rejects(readThreadTurnItems(failed, 'thread-1', 'turn-2'), { message })
  assert.equal(failed.calls.length, 2, 'real failures must not trigger a full-history fallback')
}

const repeated = client(() => ({ data: [], nextCursor: 'same' }))
await assert.rejects(readThreadTurns(repeated, 'thread-1'), /重复分页游标/)
assert.equal(repeated.calls.length, 2)
const malformed = client(() => ({}))
await assert.rejects(readThreadTurns(malformed, 'thread-1'), /未返回分页数据/)

console.log('appserver-history: ok')
