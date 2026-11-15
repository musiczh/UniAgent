import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { AppServerRunner } from '../src/main/appServerAdapter'
import type { AppServerRpc } from '../src/main/appServerTransport'
import type { AgentDef, UAEvent } from '../src/shared/types'

const agent: AgentDef = { id: 'codex', name: 'Codex', adapter: 'codex', bin: 'fixture-codex', builtin: true, icon: '', models: [], capabilities: { modelSelect: true, reasoningEffort: false, permissionModes: [{ id: 'read-only', label: '只读', hint: '' }] } }
for (const mode of ['terminal', 'before-send', 'uncertain'] as const) {
  class Wire extends EventEmitter implements AppServerRpc {
    async start() { if (mode === 'before-send') throw new Error('connect failed') }
    async request<T>(method: string): Promise<T> {
      if (method === 'thread/resume') return { thread: { id: 'native' } } as T
      if (method === 'thread/goal/get') return { goal: null } as T
      if (method === 'turn/start') { if (mode === 'uncertain') throw new Error('transport disconnected'); return { turn: { id: 'turn' } } as T }
      return {} as T
    }
    notify() {}
    respond() {}
    interrupt() {}
    async dispose() {}
  }
  const wire = new Wire()
  const runner = new AppServerRunner('session', { n: 0 }, agent, { agentId: 'codex', workdir: tmpdir(), permissionMode: 'read-only' }, 'native', undefined, () => wire)
  const events: UAEvent[] = [], done: unknown[] = []
  runner.on('event', event => events.push(event))
  runner.on('done', value => done.push(value))
  try {
    await runner.startTurn('request')
    if (mode === 'terminal') {
      wire.emit('notification', 'error', { threadId: 'native', turnId: 'turn', willRetry: true, error: { message: 'capacity' } })
      assert.equal(done.length, 0, 'native retry keeps the turn open: ' + JSON.stringify(events.filter(event => event.type === 'error')))
      assert.equal(events.some(event => event.type === 'error'), false)
      wire.emit('notification', 'turn/completed', { threadId: 'native', turn: { id: 'turn', status: 'failed', error: { message: 'Selected model is at capacity.' } } })
      assert.equal(done.length, 1)
      assert.equal(events.find(event => event.type === 'turn_completed')?.payload.recoveryDelivery, 'accepted')
      wire.emit('notification', 'turn/completed', { threadId: 'native', turn: { id: 'turn', status: 'failed' } })
      assert.equal(done.length, 1, 'duplicate terminal notifications cannot start another recovery')
    } else {
      assert.equal(done.length, 1)
      assert.equal(events.find(event => event.type === 'turn_completed')?.payload.recoveryDelivery, mode === 'before-send' ? 'not-accepted' : undefined)
    }
  } finally { runner.dispose() }
}
console.log('PASS recovery native boundary: terminal acceptance, native retry, duplicate completion and uncertain delivery')
