import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, DurableQueueItem, Session } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-claude-queue-failure-'))
const bin = join(root, 'claude.cjs')
await writeFile(bin, `#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);if(value.type==='control_request')process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:value.request_id,error:'role rejected'}})+'\\n');});\n`, { mode: 0o700 })
const agent: AgentDef = {
  id: 'claude', name: 'Claude Code', adapter: 'claude', bin, builtin: true, icon: '', installed: true, version: '2.1.296', models: [],
  capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [{ id: 'full-access', label: '', hint: '' }] }
}
const store = new SessionStore(join(root, 'sessions.json'))
const orchestrator = new Orchestrator(() => agent, store, join(root, 'artifacts'))
const session: Session = {
  id: 'role-queue', title: 'Role queue', status: 'running', createdAt: 1,
  config: { agentId: 'claude', permissionMode: 'full-access', workdir: root,
    roleSnapshot: { id: 'review', name: 'Review', agentId: 'claude', permissionMode: 'full-access', skills: ['review'] } }
}
const queue: DurableQueueItem[] = [
  { id: 'active', prompt: 'Current task', state: 'dispatching', attempts: 1, acceptedAt: 1 },
  { id: 'next', prompt: 'Next task', state: 'pending', attempts: 0, acceptedAt: 2 }
]
session.pendingQueue = queue
;(orchestrator as any).sessions.set(session.id, session)
;(orchestrator as any).queues.set(session.id, queue)
;(orchestrator as any).activeQueueItems.set(session.id, 'active')
;(orchestrator as any).seqRefs.set(session.id, { n: 0 })
;(orchestrator as any).events.set(session.id, [])
try {
  const settled = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('One-shot failure did not settle')), 4000)
    orchestrator.on('statusChange', ({ status }) => {
      if (status !== 'running' && status !== 'awaiting-approval') { clearTimeout(timer); resolve() }
    })
  })
  ;(orchestrator as any).runOneShot(session, agent, 'Current task')
  await settled
  assert.equal(session.status, 'error', 'a rejected role initialization must not acknowledge success or drain the next message')
  assert.deepEqual((orchestrator as any).queues.get(session.id).map((item: DurableQueueItem) => ({ id: item.id, state: item.state })), [
    { id: 'active', state: 'pending' }, { id: 'next', state: 'pending' }
  ])
  assert.equal((orchestrator as any).activeQueueItems.has(session.id), false)
  assert.equal((orchestrator as any).deferredDispatches.has(session.id), false)
  console.log('Claude role orchestrator: native rejection leaves both queued messages retryable and stops dispatch')
} finally {
  orchestrator.disposeAll()
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
