import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantDatabase } from '../src/main/assistant/database'

const directory = await mkdtemp(join(tmpdir(), 'ua-assistant-'))
const path = join(directory, 'assistant.sqlite')
let db = new AssistantDatabase(path)
try {
  const first = db.detail()
  assert.equal(first.assistant.id, 'personal')
  assert.equal(first.documents.length, 4)
  const config = { enabled: true, autoReviewEnabled: true, defaultAgentId: 'codex' }
  assert.throws(() => db.save({ ...config, defaultWorkdir: 'relative/path' }, []), /绝对路径/)
  assert.throws(() => db.save({ ...config, defaultWorkdir: join(directory, 'missing') }, []), /运行目录不可用/)
  db.save({ ...config, defaultWorkdir: directory }, [])
  assert.equal(db.detail().assistant.defaultWorkdir, directory)
  db.save(config, [])
  assert.equal(db.detail().assistant.defaultWorkdir, undefined)
  const expectedConfig = db.detail().assistant
  db.save({ ...config, defaultWorkdir: directory }, [], expectedConfig)
  assert.throws(() => db.save(config, [{ type: 'soul', content: '过期身份', expectedRevision: 1 }], expectedConfig), /revision_conflict/)
  assert.equal(db.detail().assistant.defaultWorkdir, directory)
  assert.notEqual(db.detail().documents.find(d => d.type === 'soul')!.content, '过期身份')
  db.save(config, [])
  db.save({ enabled: true, autoReviewEnabled: true, defaultAgentId: 'codex' }, [{ type: 'user', content: '偏好中文', expectedRevision: 1 }])
  assert.throws(() => db.save({ enabled: true, autoReviewEnabled: true, defaultAgentId: 'codex' }, [{ type: 'user', content: '过期覆盖', expectedRevision: 1 }]), /revision_conflict/)
  assert.throws(() => db.memory({ action: 'batch', operations: [
    { action: 'add', document: 'user', content: '偏好简短回答', expectedRevision: 2 },
    { action: 'add', document: 'memory', content: '超额'.repeat(2000), expectedRevision: 1 }
  ] }, { writer: 'agent', sessionId: 's_a' }), /budget_exceeded/)
  assert.equal(db.detail().documents.find(d => d.type === 'user')!.content, '偏好中文')
  db.transcript({ id: 's_a', title: '整理待办', agentId: 'codex', createdAt: 1, archived: true }, [
    { id: 'm1', sessionId: 's_a', seq: 1, ts: 1, role: 'user', content: '管理待办和提醒', visibility: 'live' }
  ])
  assert.equal(db.search({ query: '待办 提醒' }).sessions[0].sessionId, 's_a')
  db.transcript({ id: 's_a', title: '更新标题', agentId: 'codex', createdAt: 1, archived: false }, [])
  assert.equal(db.search({ query: '待办' }).sessions[0].messages[0].content, '管理待办和提醒', 'metadata update must retain messages')
  assert.throws(() => db.search({ sessionId: 's_unbound' }), /session_out_of_scope/)
  db.removeSession('s_a')
  assert.equal(db.search({ query: '待办' }).sessions.length, 0)
  const generation = db.generation()
  const job = db.enqueue({ sessionId: 's_a', turnKey: 't1', throughSeq: 2, agentId: 'codex', model: undefined })
  db.memory({ action: 'add', document: 'user', content: '喜欢咖啡', expectedRevision: 2 }, { writer: 'auto_review', jobId: job.id })
  db.invalidate()
  assert.ok(db.generation() > generation)
  assert.equal(db.commitReview(job.id), false)
  assert.equal(db.detail().documents.find(d => d.type === 'user')!.content, '偏好中文')
  const fresh = db.enqueue({ sessionId: 's_a', turnKey: 't2', throughSeq: 3, agentId: 'codex', model: undefined })
  db.setReviewState(fresh.id, 'running', 1)
  db.memory({ action: 'batch', operations: [
    { action: 'add', document: 'user', content: '喜欢咖啡', expectedRevision: 2 },
    { action: 'add', document: 'memory', content: '项目使用 Electron', expectedRevision: 1 }
  ] }, { writer: 'auto_review', jobId: fresh.id })
  assert.equal(db.detail().documents.find(d => d.type === 'memory')!.content, '')
  assert.equal(db.commitReview(fresh.id), true)
  assert.equal(db.detail().documents.find(d => d.type === 'memory')!.content, '项目使用 Electron')
  db.rollback('memory', 1, 2)
  assert.equal(db.detail().documents.find(d => d.type === 'memory')!.revision, 3)
  assert.equal(db.detail().documents.find(d => d.type === 'memory')!.content, '')
  db.close()
  db = new AssistantDatabase(path)
  assert.equal(db.detail().documents.find(d => d.type === 'user')!.content, '偏好中文\n喜欢咖啡')
} finally { db.close(); await rm(directory, { recursive: true, force: true }) }
