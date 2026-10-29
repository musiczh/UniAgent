import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HandoffTaskStore } from '../src/main/handoffTaskStore.ts'
import type { UAEvent } from '../src/shared/types.ts'

// Catches lost early/final output, duplicated cumulative text, follow-up leakage,
// false completion after a crash, and stale callbacks recreating deleted logs.
const root = mkdtempSync(join(tmpdir(), 'uniagent-task-files-'))
const store = new HandoffTaskStore(root)
const snapshot = (id: string) => JSON.parse(readFileSync(join(root, id + '.json'), 'utf8'))
const records = (id: string) => readFileSync(join(root, id + '.events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
let seq = 0
function emit(id: string, text: string, state: UAEvent['state'] = 'running', itemId = 'message'): void {
  store.recordEvent(id, { sessionId: 'session', seq: seq++, ts: Date.now(), type: 'agent_message', state, payload: { id: itemId, text } })
}

try {
  assert.throws(() => store.begin('../escape'), /invalid_handoff_task_id/)
  assert.equal(store.begin('first'), true)
  assert.equal(store.begin('first'), false, 'duplicate delivery must not start another task')
  assert.equal(snapshot('first').done, false)
  assert.equal(statSync(join(root, 'first.events.jsonl')).mode & 0o777, 0o600)
  emit('first', '开始分析')
  await new Promise((resolve) => setTimeout(resolve, 850))
  const cursor = snapshot('first').logBytes
  assert.equal(snapshot('first').latestReply, '开始分析')
  assert.ok(cursor > 0)
  emit('first', '开始分析，找到问题')
  emit('first', '修正结论')
  emit('first', '修正结论', 'success')
  emit('first', '最终回复', 'success', 'final')
  store.recordEvent('first', {
    sessionId: 'session', seq: seq++, ts: Date.now(), type: 'command_exec', state: 'success',
    payload: { id: 'command', command: 'pwd', output: '/workspace\n', exitCode: 0 }
  })
  store.writeResult('first', { status: 'idle', sessionId: 'session', text: store.latestReply('first')! })
  const first = snapshot('first')
  assert.equal(new HandoffTaskStore(root).begin('first'), false, 'disk reservation also rejects another writer or replay')
  assert.deepEqual(snapshot('first'), first, 'duplicate reservation must preserve the original result')
  assert.equal(first.done, true)
  assert.equal(first.logComplete, true)
  assert.equal(first.latestReply, '最终回复')
  assert.equal(first.logBytes, statSync(first.eventsFile).size)
  const lines = records('first')
  assert.deepEqual(lines.map((line) => line.seq), lines.map((_, index) => index + 1))
  assert.equal(first.lastSeq, lines.at(-1).seq)
  assert.equal(lines.at(-1).data.status, 'idle')
  const replies = lines.filter((line) => line.kind === 'event' && line.data.type === 'agent_message')
  assert.deepEqual(replies.map((line) => line.data.payload.text), ['开始分析', '，找到问题', '修正结论', undefined, '最终回复'])
  assert.deepEqual(replies.map((line) => line.data.fieldOps?.text), ['replace', 'append', 'replace', undefined, 'replace'])
  const added = readFileSync(first.eventsFile).subarray(cursor).toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(added[0].data.payload.text, '，找到问题')
  assert.ok(lines.some((line) => line.data.payload?.output === '/workspace\n'))

  // Late delivery confirmation preserves both terminal status and the final reply.
  store.writeResult('first', { status: 'running', sessionId: 'session', text: 'older', delivery: 'started' })
  assert.equal(snapshot('first').status, 'idle')
  assert.equal(snapshot('first').text, '最终回复')

  store.begin('followup', 'first', 'session')
  assert.equal(snapshot('followup').latestReply, '')
  assert.equal(snapshot('followup').followupTaskId, 'first')
  emit('followup', '追问回复', 'success')
  store.writeResult('followup', { status: 'idle', sessionId: 'session', text: store.latestReply('followup')! })
  assert.equal(snapshot('first').text, '最终回复')
  assert.equal(records('followup').filter((line) => line.data.type === 'agent_message').length, 1)

  const restoredId = '53f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e'
  store.begin(restoredId, undefined, 'restored-session', 'caller')
  store.writeResult(restoredId, { status: 'idle', sessionId: 'restored-session', text: '恢复的最终结果' })
  for (const [name, input] of [
    ['uniagent_task', { action: 'create' }], ['uniagent_task', { action: 'followup', taskId: 'previous' }],
    ['create_uniagent_task', {}], ['create_uniagent_task', { followupTaskId: 'previous' }]
  ] as const) {
    const restored = await store.loadCallerEvents('caller', [{
      sessionId: 'caller', seq: 0, ts: 1, type: 'tool_call',
      payload: { name, input, result: 'taskId=' + restoredId }
    }])
    assert.equal(restored.length, 1, 'both current actions and historical tool names must restore terminal facts')
    assert.equal(restored[0].payload.reply, '恢复的最终结果')
    assert.equal(restored[0].payload.targetSessionId, 'restored-session')
  }

  store.begin('failed', undefined, 'failed-session')
  const circular: any = {}; circular.self = circular
  store.recordEvent('failed', { sessionId: 'failed-session', seq: 0, ts: 0, type: 'tool_call', payload: circular })
  store.writeResult('failed', { status: 'error', sessionId: 'failed-session', text: 'failed' })
  assert.equal(snapshot('failed').logComplete, false)
  assert.ok(snapshot('failed').logError)
  assert.equal(snapshot('failed').lastSeq, records('failed').at(-1).seq)

  store.begin('missing', undefined, 'missing-session')
  rmSync(join(root, 'missing.events.jsonl'))
  store.recordEvent('missing', { sessionId: 'missing-session', seq: 0, ts: 0, type: 'tool_call', payload: { name: 'example' } })
  store.writeResult('missing', { status: 'idle', sessionId: 'missing-session', text: '' })
  assert.equal(snapshot('missing').logComplete, false)
  assert.ok(snapshot('missing').logError)
  assert.equal(existsSync(join(root, 'missing.events.jsonl')), false)

  // Simulate a crash record without starting a second live writer.
  writeFileSync(join(root, 'crashed.json'), JSON.stringify({ ...first, taskId: 'crashed', status: 'running', done: false }))
  store.recover()
  assert.equal(snapshot('crashed').status, 'interrupted')
  assert.equal(snapshot('crashed').done, true)
  assert.equal(snapshot('crashed').logComplete, false)
  assert.ok(snapshot('crashed').logError)
  assert.equal(snapshot('first').status, 'idle')

  store.begin('closing', undefined, 'other-session')
  store.close()
  assert.equal(snapshot('closing').status, 'interrupted')
  assert.equal(snapshot('closing').lastSeq, records('closing').at(-1).seq)

  store.removeSession('session')
  store.writeResult('first', { status: 'idle', sessionId: 'session', text: 'late', delivery: 'started' })
  assert.equal(existsSync(first.statusFile), false)
  assert.equal(existsSync(first.eventsFile), false)
  assert.equal(existsSync(join(root, 'followup.events.jsonl')), false)
  assert.equal(existsSync(join(root, 'closing.json')), true)
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}
console.log('handoff-task-files: ok')
