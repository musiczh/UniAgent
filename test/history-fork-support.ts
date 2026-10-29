import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRpcClient } from '../src/main/appServerTransport'
import type { AgentDef, UAEvent } from '../src/shared/types'

// Run with: node scripts/run-ts-test.mjs test/history-fork-support.ts
const scratch = await mkdtemp(join(tmpdir(), 'ua-fork-support-'))
const previousUserData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = scratch
const proto = AppServerRpcClient.prototype
const original = { start: proto.start, request: proto.request, notify: proto.notify, dispose: proto.dispose }

try {
  const { historyForkPoints, historyEventsThroughPoint } = await import('../src/main/historyFork')
  const calls: string[] = []
  proto.start = async () => {}
  proto.notify = () => {}
  proto.dispose = async () => {}
  proto.request = async function<T>(method: string, params: any): Promise<T> {
    if (method === 'thread/fork') {
      assert.equal(params.threadId, '__uniagent_fork_capability_probe__')
      const field = 'lastTurnId' in params ? 'lastTurnId' : 'deferGoalContinuation'
      calls.push(field)
      // TraeX supports the turn boundary but ignores the optional goal flag.
      throw new Error(field === 'lastTurnId'
        ? 'Invalid request: invalid type: map, expected a string'
        : 'invalid thread id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `_` at 1')
    }
    if (method === 'thread/turns/list') return { data: [{
      id: 'turn-1', status: 'completed',
      items: [{ type: 'agentMessage', text: 'Done', phase: 'final_answer' }]
    }] } as T
    assert.equal(method, 'initialize')
    return {} as T
  }
  const agent = { id: 'traex', adapter: 'traex', bin: process.execPath } as AgentDef
  const events = [
    { seq: 0, type: 'user_message', payload: { text: 'Hi' } },
    { seq: 1, type: 'turn_started', payload: { turnId: 'turn-1' } },
    { seq: 2, type: 'agent_message', payload: { text: 'Done' } }
  ] as UAEvent[]
  assert.deepEqual(await historyForkPoints(agent, 'thread-1', events), [
    { eventSeq: 2, kind: 'after-turn', nativeId: 'turn-1' }
  ], 'an unsupported optional goal flag must not hide a supported turn fork')
  assert.deepEqual(calls, ['lastTurnId', 'deferGoalContinuation'])

  const transcript = [
    ...events,
    { seq: 3, type: 'agent_message', payload: { text: 'Supplement', nativeMessageId: 'reply-1' } },
    { seq: 4, type: 'usage', payload: { totalTokens: 10 } },
    { seq: 5, type: 'turn_completed', payload: { turnId: 'turn-1' } },
    { seq: 6, type: 'user_message', payload: { text: 'Next question' } },
    { seq: 7, type: 'turn_started', payload: { turnId: 'turn-2' } },
    { seq: 8, type: 'agent_message', payload: { text: 'Later reply', nativeMessageId: 'reply-2' } }
  ] as UAEvent[]
  // Live renderer sequences differ from disk replay: native identities own the cutoff.
  assert.deepEqual(historyEventsThroughPoint(transcript, {
    eventSeq: 900, kind: 'after-turn', nativeId: 'turn-1'
  }).map((event) => event.seq), [0, 1, 2, 3, 4, 5], 'retain supplements but exclude later turns')
  assert.deepEqual(historyEventsThroughPoint(transcript, {
    eventSeq: 900, kind: 'message', nativeId: 'reply-1'
  }).map((event) => event.seq), [0, 1, 2, 3], 'a message fork includes exactly the selected reply')
  assert.deepEqual(historyEventsThroughPoint(transcript, {
    eventSeq: 900, kind: 'after-turn', nativeId: 'turn-2'
  }).map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'the last turn retains its full prefix')
  assert.throws(() => historyEventsThroughPoint(transcript, {
    eventSeq: 2, kind: 'after-turn', nativeId: 'missing-turn'
  }), /分叉位置/, 'a stale native boundary must fail instead of exporting the full session')
  const steered = [
    ...events,
    { seq: 3, type: 'user_message', payload: { text: 'One more detail in this turn' } },
    { seq: 4, type: 'turn_started', payload: { turnId: 'turn-1' } },
    { seq: 5, type: 'agent_message', payload: { text: 'Supplement' } },
    { seq: 6, type: 'user_message', payload: { text: 'Next turn' } }
  ] as UAEvent[]
  assert.deepEqual(historyEventsThroughPoint(steered, {
    eventSeq: 5, kind: 'after-turn', nativeId: 'turn-1'
  }).map((event) => event.seq), [0, 1, 2, 3, 4, 5], 'repeated native turn boundaries retain steering and supplements')
  assert.equal(transcript.length, 9, 'forking must leave the source history intact')
} finally {
  Object.assign(proto, original)
  if (previousUserData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousUserData
  await rm(scratch, { recursive: true, force: true })
}
console.log('history-fork-support: ok')
