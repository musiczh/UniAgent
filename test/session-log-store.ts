import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionLogStore } from '../src/main/sessionLogStore.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, SessionConfig } from '../src/shared/types.ts'

const root = mkdtempSync(join(tmpdir(), 'uniagent-session-logs-'))

try {
  const logs = new SessionLogStore(root, { maxFileBytes: 350, maxEntryBytes: 320 })
  logs.append('s_one', 'status_changed', { from: 'running', to: 'idle' })
  logs.append('s_one', 'provider_notification', {
    method: 'item/completed',
    payload: { text: 'x'.repeat(2_000) }
  })
  logs.append('s_two', 'ua_event', { type: 'error', payload: { message: 'boom' } })

  const firstPath = join(root, 's_one.jsonl')
  const rotatedPath = `${firstPath}.1`
  const secondPath = join(root, 's_two.jsonl')
  assert.equal(existsSync(firstPath), true)
  assert.equal(existsSync(rotatedPath), true, 'oversized session logs should rotate')
  assert.equal(existsSync(secondPath), true, 'each session should have its own log')

  const records = [rotatedPath, firstPath]
    .flatMap((file) => readFileSync(file, 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(records[0].sessionId, 's_one')
  assert.equal(records[0].kind, 'status_changed')
  assert.equal(records[1].kind, 'provider_notification')
  assert.equal(records[1].truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(records[1])) <= 320)

  const second = JSON.parse(readFileSync(secondPath, 'utf8').trim())
  assert.equal(second.sessionId, 's_two')
  assert.equal(second.data.payload.message, 'boom')

  const agent: AgentDef = {
    id: 'test-agent',
    name: 'Test',
    adapter: 'claude',
    bin: '/usr/bin/true',
    icon: '',
    installed: true,
    capabilities: {
      modelSelect: false,
      reasoningEffort: false,
      streaming: false,
      permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
    },
    models: []
  }
  const store = new SessionStore(join(root, 'orchestrator', 'sessions.json'))
  const orchestrator = new Orchestrator(
    (id) => id === agent.id ? agent : undefined,
    store,
    join(root, 'artifacts')
  ) as any
  const config: SessionConfig = {
    agentId: agent.id,
    workdir: root,
    permissionMode: 'read-only'
  }
  const { session } = orchestrator.createSessionRecord(config, '日志测试')
  orchestrator.record(session.id, { type: 'user_message', payload: { text: 'hello' } })
  orchestrator.setStatus(session, 'running')
  const sessionRecords = readFileSync(
    join(root, 'orchestrator', 'session-logs', `${session.id}.jsonl`),
    'utf8'
  ).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(
    sessionRecords.map((record) => record.kind),
    ['session_owner_installed', 'session_created', 'ua_event', 'status_changed']
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('session-log-store: ok')
