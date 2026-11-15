import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequirementStore } from '../src/main/requirementStore'
import { setRequirementsEnabled } from '../src/main/requirementRuntime'
import { validateRequirementReading } from '../src/main/requirementReading'
import { requirementMemories } from '../src/main/requirementMemory'
import type { UAEvent } from '../src/shared/types'

const home = await mkdtemp(join(tmpdir(), 'requirement-memory-'))
const store = new RequirementStore(home)
const requirement = await store.create({ name: '持续共享记忆' })
const events: UAEvent[] = [
  { sessionId: 'a', seq: 1, ts: 100, type: 'user_message', payload: { text: '登录需要复用已有账号，后续 Session 要知道之前的决定。' } },
  { sessionId: 'b', seq: 2, ts: 200, type: 'agent_message', payload: { text: '已修改登录重试模块，尚未运行测试，用户未验收。' } },
  { sessionId: 'b', seq: 3, ts: 300, type: 'command_exec', payload: { output: 'SQLite 写入失败：database is locked。仅验证本机单个样例。' } },
  { sessionId: 'a', seq: 4, ts: 400, type: 'user_message', payload: { text: '登录改为提供独立账号入口，取代之前复用已有账号的决定。' } }
]
store.configureContext({ events: async id => events.filter(event => event.sessionId === id), requirementId: () => requirement.id })
const proof = (index: number, kind: 'user' | 'tool' | 'agent') => [{ kind, sessionId: events[index].sessionId, seq: events[index].seq, quote: String(events[index].payload.text || events[index].payload.output) }]
const boot = (query = '') => store.context(requirement.id, 'c', { action: 'bootstrap', query })
try {
  setRequirementsEnabled(true)
  const important = ['跨 Session 继承', '用户阅读', 'RouterAgent 用途', '用户确认设计', '三场景真实数据测试', '测试不理想继续迭代'].map((title, index) => ({
    id: 'essential-' + index, kind: 'proposal' as const, title, content: title, summary: title, status: 'draft' as const, triggers: [], projectIds: [], dependencies: [], sources: proof(0, 'user'), freshness: 'needs-review' as const, updatedAt: index,
    memory: { type: index === 3 ? 'decision' as const : 'intent' as const, topic: title, basis: 'user' as const, occurredAt: index }
  }))
  const noisy = Array.from({ length: 8 }, (_, index) => ({ ...important[0], id: 'relevant-' + index, title: '设计交付资料 ' + index, summary: '设计交付', memory: undefined, status: 'active' as const, kind: 'artifact' as const }))
  const startingPoint = requirementMemories([...important, ...noisy], '设计交付具体情况是什么？')
  assert.deepEqual(startingPoint.essentials, [], 'unrelated recent user intentions are not injected as global essentials')
  assert.ok(startingPoint.items.length <= 3)
  assert.deepEqual(requirementMemories(important, '完全无关的话题').items, [])
  assert.ok(startingPoint.items.every(item => item.title.includes('设计交付')), 'relevant work remains a separate retrieval layer')
  let revision = (await boot()).revision
  revision = (await store.context(requirement.id, 'a', { action: 'commit', expectedRevision: revision, operationId: 'intent', documents: [
    { id: 'login-rule', kind: 'decision', title: '登录复用账号', content: String(events[0].payload.text), sources: proof(0, 'user'), triggers: ['登录', '账号'] }
  ] })).revision
  const before = revision
  revision = (await store.context(requirement.id, 'b', { action: 'propose', expectedRevision: revision, operationId: 'reports', documents: [
    { id: 'login-report', kind: 'proposal', title: '登录重试的修改报告', summary: '登录模块已报告修改，测试及用户验收未完成。', content: String(events[1].payload.text), sources: proof(1, 'agent'), memory: { type: 'change', topic: '登录重试', basis: 'agent', occurredAt: 200 } },
    { id: 'sqlite-failure', kind: 'proposal', title: 'SQLite 写入失败经历', summary: 'SQLite 单样例因数据库锁写入失败。', content: String(events[2].payload.output), sources: proof(2, 'tool'), memory: { type: 'experience', topic: 'SQLite', basis: 'tool', evidenceScope: '本机单个样例', occurredAt: 300 } },
    { id: 'unconfirmed', kind: 'proposal', title: '新架构建议', content: '建议重新实现整个登录架构。' }
  ] })).revision
  const current = await boot('后续如何处理 SQLite 数据库锁？')
  assert.equal(current.memories.items[0].id, 'sqlite-failure', 'relevant earlier failures are recovered by topic')
  assert.equal(current.memories.items[0].basis, 'tool')
  assert.ok(current.memories.items.every((item: any) => item.id !== 'unconfirmed'), 'unmarked legacy proposals are not promoted')
  assert.ok(!(await store.readOverview(requirement.id, undefined, { category: 'proposal' })).documents.some(doc => doc.id === 'login-report'), 'a recorded experience is not presented as a suggestion awaiting approval')
  const login = await boot('登录重试')
  assert.ok(login.memories.items.some((item: any) => item.id === 'login-report' && item.basis === 'agent'))
  assert.ok(login.navigation.some((item: any) => item.id === 'login-report'), 'shared reports have a detail entry across Sessions')
  const detail = await store.context(requirement.id, 'c', { action: 'read', documentId: 'login-report' })
  assert.equal(detail.document.status, 'draft')
  assert.equal(detail.document.memory.basis, 'agent', 'sharing a report does not activate or verify it')
  assert.equal(detail.document.freshness, 'needs-review')
  assert.match(detail.document.sources[0].eventId, /^[a-f0-9]{64}$/)
  events[1].seq = 202
  revision = (await store.context(requirement.id, 'c', { action: 'propose', expectedRevision: revision, operationId: 'native-replay', documents: [
    { id: 'replay-report', kind: 'proposal', title: '重放后的来源校验', content: detail.document.content, sources: detail.document.sources, memory: detail.document.memory }
  ] })).revision
  assert.equal((await store.context(requirement.id, 'c', { action: 'read', documentId: 'replay-report' })).document.memory.basis, 'agent', 'stable source identity survives native history resequencing')
  events[1].seq = 2
  assert.ok((await store.readingSources(requirement.id))!.documents.some(doc => doc.id === 'login-report'), 'human projection can read labelled experiences')
  const record = { version: 2 as const, sourceRevision: revision, updatedAt: Date.now(), constraints: [], stages: [], issues: [], next: [],
    current: { text: 'Agent 报告修改了登录模块，测试和验收待完成。', basis: 'agent' as const, refs: [{ documentId: 'login-report', quote: detail.document.content }] } }
  const readingInput = (await store.readingSources(requirement.id))!.documents
  assert.throws(() => validateRequirementReading({ ...record, current: { ...record.current, basis: undefined } }, readingInput, revision), /来源/, 'a shared report cannot become an unlabelled current fact')
  validateRequirementReading(record, readingInput, revision)
  assert.ok(!(await store.routingSources(requirement.id)).documents.some(doc => doc.id === 'login-report'), 'Router ownership excludes draft reports')
  await assert.rejects(() => store.context(requirement.id, 'b', { action: 'propose', expectedRevision: revision, operationId: 'spoof', documents: [
    { id: 'spoof', kind: 'proposal', title: '伪造用户决定', content: '用户已经决定上线。', sources: proof(1, 'agent'), memory: { type: 'decision', topic: '发布', basis: 'user' } }
  ] }), /memory|来源/)
  const changes = await store.context(requirement.id, 'c', { action: 'check', expectedRevision: before })
  assert.ok(changes.changes.added.includes('login-report'))
  revision = (await store.context(requirement.id, 'a', { action: 'commit', expectedRevision: revision, operationId: 'replace', documents: [
    { id: 'new-login-rule', kind: 'decision', title: '登录独立账号入口', content: String(events[3].payload.text), sources: proof(3, 'user'), supersedes: 'login-rule' }
  ] })).revision
  const changed = await store.context(requirement.id, 'c', { action: 'check', expectedRevision: changes.revision })
  assert.ok(changed.changes.invalidated.includes('login-rule'))
  assert.equal((await store.context(requirement.id, 'c', { action: 'read', documentId: 'login-rule' })).document.status, 'superseded')
  assert.ok(!(await boot('登录')).navigation.some((doc: any) => doc.id === 'login-rule'))
  assert.ok((await store.readOverview(requirement.id, undefined, { category: 'decisions', includeHistory: true })).documents.some(doc => doc.id === 'login-rule'))
  revision = (await store.context(requirement.id, 'a', { action: 'propose', expectedRevision: revision, operationId: 'old-shared-intent', documents: [
    { id: 'old-memory', kind: 'proposal', title: '旧账号意图', content: String(events[0].payload.text), sources: proof(0, 'user'), memory: { type: 'intent', topic: '登录账号', basis: 'user' } }
  ] })).revision
  await assert.rejects(() => store.context(requirement.id, 'b', { action: 'propose', expectedRevision: revision, operationId: 'agent-cannot-replace-user', documents: [
    { id: 'agent-replacement', kind: 'proposal', title: '报告不能改写用户决定', content: String(events[1].payload.text), sources: proof(1, 'agent'), memory: { type: 'change', topic: '登录账号', basis: 'agent' }, supersedes: 'old-memory' }
  ] }), /替代关系无效/)
  await store.context(requirement.id, 'a', { action: 'propose', expectedRevision: revision, operationId: 'replace-shared-intent', documents: [
    { id: 'new-memory', kind: 'proposal', title: '账号意图变化', content: String(events[3].payload.text), sources: proof(3, 'user'), memory: { type: 'change', topic: '登录账号', basis: 'user' }, supersedes: 'old-memory' }
  ] })
  assert.equal((await store.context(requirement.id, 'c', { action: 'read', documentId: 'old-memory' })).document.status, 'superseded')
  assert.ok(!(await boot('登录账号')).memories.items.some((doc: any) => doc.id === 'old-memory'), 'a changed user statement leaves default shared recall without activating a draft rule')
  const latest = await store.context(requirement.id, 'c', { action: 'check' })
  await store.context(requirement.id, 'b', { action: 'propose', expectedRevision: latest.revision, operationId: 'large-history', documents: ['a', 'b'].map(suffix => ({
    id: 'long-history-' + suffix, kind: 'proposal' as const, title: '较长历史资料 ' + suffix, content: '历史技术背景。'.repeat(12000), sources: proof(1, 'agent'),
    memory: { type: 'experience' as const, topic: '历史资料', basis: 'agent' as const }
  })) })
  const bounded = (await store.readingSources(requirement.id))!
  assert.equal(bounded.coverage.complete, false, 'large history leaves explicit coverage instead of failing every overview')
  assert.ok(bounded.documents.some(doc => doc.id === 'core'), 'old core constraints remain in the bounded overview input')
  assert.equal((await store.context(requirement.id, 'c', { action: 'read', documentId: bounded.coverage.pendingDocumentIds[0], limit: 8 })).document.content.length, 8, 'uncovered history remains readable on demand')
  console.log('PASS shared memory: cross-Session report/failure recall, source identity, human/Router boundaries, supersession and history')
} finally { setRequirementsEnabled(false); await rm(home, { recursive: true, force: true }) }
