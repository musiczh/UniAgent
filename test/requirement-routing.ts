import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import { RequirementRoutingService, validateRoutingFragment } from '../src/main/requirementRouting'
import { RouterContextService } from '../src/main/router/context'
import { RouterDatabase } from '../src/main/router/database'
import { setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { RequirementRoutingView } from '../src/shared/requirementTypes'

const home = await mkdtemp(join(tmpdir(), 'ua-requirement-routing-')), store = new RequirementStore(home), db = new RouterDatabase(join(home, 'router.sqlite'))
const r = await store.create({ name: '功能归属独立于实施阶段', projectId: 'space' })
const text = 'Router 与自动归属属于本需求后续分项。尚未实现，用户尚未验收。通用主题颜色属于另一需求。'
store.configureContext({ events: async () => [{ sessionId: 'source', seq: 1, ts: 1, type: 'user_message', payload: { text } }], requirementId: () => r.id })
const proof = [{ kind: 'user' as const, sessionId: 'source', seq: 1, quote: text }]
let generated = 0, saved = 0
const errors: unknown[] = []
const service = new RequirementRoutingService({ enabled: () => true, busy: () => false, sources: id => store.routingSources(id),
  save: async (id, view) => { await store.saveRouting(id, view); saved++ }, chunks: value => db.routingChunks(value), changed() {}, error: error => errors.push(error),
  generate: async prompt => {
    generated++
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)), refs = [{ documentId: input.documentId, documentHash: input.documentHash, quote: text }]
    return JSON.stringify(input.content.includes(text) ? { features: [{ name: 'Router', aliases: ['自动归属'], responsibility: '本需求承载路由及自动归属', ownershipRefs: refs,
      implementation: { status: 'planned', refs }, acceptance: { status: 'pending', refs } }], exclusions: [{ text: '通用主题颜色属于另一需求', refs }], conflicts: [] } : { features: [], exclusions: [], conflicts: [] })
  } })
try {
  setRequirementsEnabled(true)
  const initial = await store.context(r.id, 'source', { action: 'bootstrap' })
  await store.context(r.id, 'source', { action: 'commit', expectedRevision: initial.revision, operationId: 'routing-source', documents: [{ id: 'core', kind: 'core', title: '范围', content: text, sources: proof }] })
  const before = await store.readRouting(r.id)
  assert.equal(before.snapshot.status, 'missing')
  service.schedule(r.id, before.snapshot); await service.next()
  const ready = await store.readRouting(r.id)
  assert.equal(ready.snapshot.status, 'ready'); assert.equal(saved, 1)
  const view = ready.snapshot.view!
  assert.equal(view.features[0].name, 'Router'); assert.equal(view.features[0].implementation.status, 'planned'); assert.equal(view.features[0].acceptance.status, 'pending')
  assert.equal(view.features[0].responsibility, '本需求承载路由及自动归属')
  await assert.rejects(store.saveRouting(r.id, { ...view, generatorVersion: 2 } as unknown as RequirementRoutingView), /invalid_requirement_routing_cache/)
  await assert.rejects(store.saveRouting(r.id, { ...view, features: [{ ...view.features[0], name: '伪造' }] }), /invalid_requirement_routing_aggregate/)
  const source = ready.sources.documents.find(doc => doc.id === 'core')!, chunk = { offset: 0, text: source.content }, feature = view.features[0]
  assert.throws(() => validateRoutingFragment({ features: [{ ...feature, aliases: ['编造别名'] }], exclusions: [], conflicts: [] }, source, chunk), /evidence/)
  assert.throws(() => validateRoutingFragment({ features: [{ ...feature, acceptance: { status: 'accepted', refs: [] } }], exclusions: [], conflicts: [] }, source, chunk), /evidence/)
  assert.throws(() => validateRoutingFragment({ features: [{ ...feature, ownershipRefs: [{ documentId: 'draft', documentHash: source.contentHash, quote: text }] }], exclusions: [], conflicts: [] }, source, chunk), /evidence/)
  const count = generated
  service.schedule(r.id, ready.snapshot); await service.next(); assert.equal(generated, count)
  const snapshot = await store.context(r.id, 'source', { action: 'check' })
  await store.context(r.id, 'source', { action: 'propose', expectedRevision: snapshot.revision, operationId: 'draft-only', documents: [{ id: 'draft-routing', kind: 'proposal', title: '未确认功能', content: '尚未确认的新要求', sources: proof }] })
  assert.equal((await store.readRouting(r.id)).snapshot.status, 'ready', 'draft additions do not rewrite or invalidate effective routing facts')
  assert.equal((await store.routingSources(r.id)).documents.some(doc => doc.id === 'draft-routing'), false)
  const ctx = new RouterContextService({ projects: () => [], requirements: async () => [r], overview: async () => { throw Error('Router must use routing context instead of the body endpoint') },
    routing: id => store.readRouting(id), sessions: () => [], events: async () => [], seed: () => undefined })
  const object = (await ctx.objects())[0]
  assert.match(object.summary, /本需求承载/); assert.match(object.sources![0].text, /planned/)
  await db.index([object]); assert.equal(db.object(r.id).description!.freshness, 'ready'); assert.equal((await db.descriptionJobs()).some(job => job.id === r.id), false)
  const current = await store.context(r.id, 'source', { action: 'check' })
  await store.context(r.id, 'source', { action: 'commit', expectedRevision: current.revision, operationId: 'change-source', documents: [{ id: 'core', kind: 'core', title: '范围', content: text + '\n新增明确的范围说明。', sources: proof }] })
  assert.equal((await store.readRouting(r.id)).snapshot.status, 'stale')
  await assert.rejects(store.saveRouting(r.id, view), /revision_changed/)
  const corrupt = { ...view, sourceRevision: (await store.routingSources(r.id)).revision, features: [{ ...feature, name: '伪造' }] } as RequirementRoutingView
  // Aggregated facts must equal the validated document fragments.
  await assert.rejects(store.saveRouting(r.id, corrupt), /evidence|aggregate/)
  const unicode = '甲乙😀é'.repeat(12000), chunks = await db.routingChunks(unicode)
  assert.ok(chunks.length > 1)
  for (const part of chunks) assert.equal(unicode.slice(part.offset, part.offset + part.text.length), part.text)
  assert.equal(chunks.at(-1)!.offset + chunks.at(-1)!.text.length, unicode.length)
  const escaped = await db.routingChunks('\\\n"\t'.repeat(10000))
  assert.ok(escaped.every(part => Buffer.byteLength(JSON.stringify(part.text)) <= 10000), 'serialized chunk must leave room for the extraction prompt and document metadata')
  assert.ok((await readFile(join(r.dir, '.uniagent/routing.json'), 'utf8')).includes('checksum'))
  console.log('PASS requirement routing: cited ownership, independent progress/acceptance, active-only sources, cache, stale writes, original detail fallback, Unicode chunks and no double summary')
} finally { await service.close(); db.close() }
