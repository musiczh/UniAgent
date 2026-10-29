import assert from 'node:assert/strict'
import { loadDeepSeekHostHistory, listDeepSeekHostSessions, forkDeepSeekHostSession } from '../src/main/deepseekHostHistory.ts'
import type { DeepSeekHostClient } from '../src/main/deepseekHostClient.ts'

const calls: any[] = []
const entry = (seq: number, type: string, data: any) => ({ type: 'event', event: { seq, type, data, time: 1000 + seq } })
let cancelled = 0, stalled = false, forkSameId = false
const client = {
  async *stream(endpoint: string, args: any) {
    calls.push({ endpoint, args })
    try {
      yield { type: 'snapshot', header: { id: args.request.address.sessionId, cwd: '/workspace' }, cursor: 3, hasMore: true,
        records: [entry(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })] }
    } finally { cancelled++ }
  },
  async call(method: string, args: any) {
    calls.push({ method, args })
    if (method === 'session/page') return stalled ? { records: [], hasMore: true } : { records: [
      entry(0, 'turn/start', { turn: 1 }), entry(1, 'user/message', { id: 'user', content: [{ type: 'text', text: 'Question' }], source: { kind: 'user' } }),
      entry(2, 'assistant/message', { turn: 1, step: 1, message: { id: 'reply', content: [{ type: 'text', text: 'Answer' }] } })
    ], hasMore: false }
    if (method === 'session/list') return { items: [
      { sessionId: 'ordinary', updatedAt: 1, cwd: '/workspace', projections: { values: { title: 'Title' } } },
      { sessionId: 'child', origin: 'subagent' }, { sessionId: 'blank', blank: true }
    ] }
    if (method === 'session/fork') return { sessionId: forkSameId ? args.request.sessionId : 'forked' }
    throw new Error('Unexpected mutation: ' + method)
  }
} as unknown as DeepSeekHostClient
const history = await loadDeepSeekHostHistory('source', client)
assert.equal(history.cwd, '/workspace')
assert.deepEqual(history.events.filter(e => ['user_message', 'agent_message'].includes(e.type)).map(e => e.payload.text), ['Question', 'Answer'])
assert.equal(cancelled, 1, 'one-shot history always closes its live stream')
assert.deepEqual(calls.find(call => call.method === 'session/page').args.request, { address: { kind: 'session', sessionId: 'source' }, throughSeq: 3, beforeSeq: 3, maxMessages: 100 })
assert.ok(calls.every(call => !['session/create', 'session/prompt'].includes(call.method)), 'reading history never acquires a writer')
assert.deepEqual(await listDeepSeekHostSessions(client), [{ id: 'ordinary', title: 'Title', cwd: '/workspace', updatedAt: 1, agentId: 'deepseek' }])
const fork = await forkDeepSeekHostSession('source', 2, client)
assert.equal(fork.nativeId, 'forked')
assert.deepEqual(calls.find(call => call.method === 'session/fork').args, { request: { sessionId: 'source', atSeq: 2 } })
await assert.rejects(forkDeepSeekHostSession('source', -1, client), /invalid-fork-boundary/)
forkSameId = true
await assert.rejects(forkDeepSeekHostSession('source', undefined, client), /invalid-fork-identity/)
stalled = true
await assert.rejects(loadDeepSeekHostHistory('source', client), /history-pagination-stalled/)
console.log('PASS Host history: non-activating reads, pinned cursor pagination, independent fork and invalid boundaries')
