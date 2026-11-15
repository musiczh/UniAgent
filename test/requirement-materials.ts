import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import { setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { Session, UAEvent } from '../src/shared/types'

const home = await mkdtemp(join(tmpdir(), 'requirement-materials-'))
const store = new RequirementStore(home)
const requirement = await store.create({ name: '需求资料归集' })
const session = { id: 'materials', status: 'idle', config: { agentId: 'codex', workdir: home, requirementId: requirement.id } } as Session
const external = [
  ['Meego 工作项', 'https://example.com/meego/item/12'],
  ['需求 PRD', 'https://example.com/wiki/prd'],
  ['Figma 设计稿', 'https://www.figma.com/design/example'],
  ['iOS 技术方案', 'https://example.com/doc/ios'],
  ['相关群聊', 'https://example.com/chat/topic/34']
]
const report = join(home, 'verification.md')
const events: UAEvent[] = [
  { sessionId: session.id, seq: 1, ts: 1, type: 'user_message', payload: { text: external.map(([title, uri]) => `${title}：${uri}`).join('\n') } },
  { sessionId: session.id, seq: 2, ts: 2, type: 'command_exec', payload: { output: `已生成验证报告：${report}` } }
]
store.configureContext({ events: async () => events, requirementId: () => requirement.id, workdir: () => home })
const check = () => store.context(requirement.id, session.id, { action: 'check' })
try {
  setRequirementsEnabled(true)
  await writeFile(report, '# 验证报告\n仅生成，尚未验收。')
  await store.recordInput(requirement.id, events[0])
  await store.finishTurn(requirement.id, { ...events[0], seq: 3, type: 'turn_completed', state: 'success' })
  const before = await store.readingSources(requirement.id)
  const initial = (await check()).revision
  const selected = [...external.map(([title, uri], index) => ({ id: 'selected-' + index, kind: 'source' as const, title, summary: '外部需求资料入口', content: '仅记录入口，尚未读取原文。', memory: { type: 'material' as const, topic: title, basis: 'user' as const }, sources: [{ kind: 'reference' as const, uri }, { kind: 'user' as const, sessionId: session.id, seq: 1, quote: `${title}：${uri}` }] })),
    { id: 'report', kind: 'artifact' as const, title: '本次验证报告', content: '运行中生成的报告，尚未验收。', memory: { type: 'material' as const, topic: '报告', basis: 'tool' as const }, sources: [{ kind: 'reference' as const, uri: report }, { kind: 'tool' as const, sessionId: session.id, seq: 2, quote: `已生成验证报告：${report}` }] }]
  await store.context(requirement.id, session.id, { action: 'propose', expectedRevision: initial, operationId: 'selected-materials', documents: selected })
  const sources = await store.readOverview(requirement.id, undefined, { category: 'source' })
  assert.equal(sources.total, 5, 'external requirement inputs appear in the reference category')
  assert.deepEqual(sources.documents.map(doc => doc.title).sort(), external.map(([title]) => title).sort())
  for (const [title, uri] of external) {
    const doc = sources.documents.find(doc => doc.title === title)!
    assert.equal(doc.kind, 'source')
    assert.equal(doc.status, 'draft', 'recording a link cannot activate its contents')
    assert.equal(doc.freshness, 'needs-review')
    assert.ok(doc.sources.some(source => source.kind === 'reference' && source.uri === uri))
    assert.ok(doc.sources.some(source => source.kind === 'user' && source.seq === 1))
    const body = (await store.readOverview(requirement.id, doc.id)).document!
    assert.match(body.content, /尚未读取原文/)
  }
  const artifacts = await store.readOverview(requirement.id, undefined, { category: 'artifact' })
  assert.equal(artifacts.total, 1, 'generated materials appear in delivery and verification')
  assert.equal(artifacts.documents[0].status, 'draft')
  assert.ok(artifacts.documents[0].sources.some(source => source.kind === 'reference' && source.uri === report && source.observedVersion?.startsWith('sha256:')))
  assert.ok(artifacts.documents[0].sources.some(source => source.kind === 'tool' && source.seq === 2))
  const readingSources = (await store.readingSources(requirement.id))!.documents
  assert.deepEqual(readingSources.filter(doc => doc.status === 'active'), before?.documents, 'material records do not change authoritative context')
  assert.equal(readingSources.filter(doc => doc.memory?.type === 'material').length, 6, 'human projection can describe the saved material entries with their provenance')
  assert.equal((await store.routingSources(requirement.id)).documents.length, 2, 'saved material entries do not become Router ownership evidence')
  assert.equal((await store.readOverview(requirement.id, undefined, { category: 'decisions' })).total, 0)
  const catalog = await store.readOverview(requirement.id, undefined, { materials: 'all' })
  assert.equal(catalog.materials?.length, 6, 'the materials view contains actual reference entrances, not memory documents')
  assert.equal(catalog.documents.length, 0, 'the materials view does not mix in internal memory records')
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'user' })).total, 5)
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'agent' })).total, 1)
  assert.equal(catalog.materials?.find(item => item.uri === report)?.format, 'Markdown')
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'all', query: 'Figma' })).total, 1)
  assert.equal((await store.context(requirement.id, session.id, { action: 'read', query: 'Meego' })).total, 1, 'Sessions can discover material candidates on demand')
  const repeated = await store.context(requirement.id, session.id, { action: 'propose', expectedRevision: (await check()).revision, operationId: 'repeat-selected', documents: selected })
  assert.equal(repeated.unchanged, true, 'foreground selection updates the same material without duplication')
  for (const uri of [42, 'https://example.com/doc/actual?token=fixture-secret']) {
    await assert.rejects(store.context(requirement.id, session.id, { action: 'propose', expectedRevision: (await check()).revision, operationId: 'invalid-reference', documents: [{ id: 'bad-link', kind: 'source', title: '无效入口', content: '待核实。', sources: [{ kind: 'reference', uri: uri as string }] }] }))
  }
  const current = (await check()).revision
  await store.context(requirement.id, session.id, { action: 'propose', expectedRevision: current, operationId: 'material-catalog-boundaries', documents: [
    { id: 'summary-only', kind: 'artifact', title: '阶段总结', content: '完成一轮实现，但没有交付材料入口。' },
    { id: 'rule-with-link', kind: 'spec', title: '内部规范', content: '规范和材料分别展示。', sources: [{ kind: 'reference', uri: external[0][1] }] },
    { id: 'multi-artifact', kind: 'artifact', title: '设计评审材料', summary: '包含设计稿和说明。', content: '保存入口，尚未验收。', sources: [
      { kind: 'reference', uri: './design/设计稿.html' }, { kind: 'reference', uri: join(requirement.dir, 'design/设计稿.html') },
      { kind: 'reference', uri: './design/说明.pdf' }, { kind: 'reference', uri: report }
    ] }
  ] })
  const boundary = await store.readOverview(requirement.id, undefined, { materials: 'all' })
  assert.equal(boundary.total, 8, 'only important entrances remain, deduplicated across material records')
  assert.ok(!boundary.materials?.some(item => item.documentId === 'summary-only' || item.documentId === 'rule-with-link'), 'notes and specifications do not become material rows')
  assert.ok(boundary.materials?.some(item => item.uri === join(requirement.dir, 'design/设计稿.html') && item.format === 'HTML' && item.title.includes('设计稿.html')), 'relative entrances resolve from the requirement directory and multiple files retain their names')
  const first = await store.readOverview(requirement.id, undefined, { materials: 'all', limit: 3 })
  const second = await store.readOverview(requirement.id, undefined, { materials: 'all', limit: 3, offset: first.nextOffset! })
  assert.equal(new Set([...first.materials!, ...second.materials!].map(item => item.uri)).size, 6, 'paging happens after URI deduplication')
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'all', query: 'PDF' })).total, 1, 'format participates in search')
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'agent', query: 'zzmissing1741' })).total, 0)
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'all', offset: 100 })).materials?.length, 0)
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'all', query: '  ' })).total, boundary.total, 'whitespace search keeps the full catalog')
  const assets = [
    ['artifact', 'Ferry 修复交付', '供审查的技术方案与报告。', ['./deliverables/technical-plan.md', './deliverables/report.html', './deliverables/report.json', './deliverables/pack.log', './src/task-title.ts', './deliverables/config.yaml']],
    ['artifact', '用户要求生成的图片', '按用户要求生成的封面插画。', ['https://example.com/output/8a6e.png', 'https://example.com/output/image']],
    ['artifact', '资料页设计稿', '供用户确认的交互设计。', ['./design/materials-review.png', './screenshots/verification.png']],
    ['source', '需求 PRD', '用户提供的需求材料。', ['https://example.com/doc/product', './input/需求说明.docx', './input/附件.JSON']],
    ['source', '随手记录', '普通网页入口。', ['https://example.com/misc']],
    ['artifact', '运行中间文件', '本轮缓存与取证截图。', ['./run/notes.md', './run/screenshot.png']],
    ['artifact', '协议参考来源', '读取官方配置与 SDK 参考实现。', ['https://example.com/config-reference']],
    ['artifact', '验证报告附件', '报告引用的过程取证。', ['./run/trace.txt', './run/screenshot.png']]
  ] as const
  await store.context(requirement.id, session.id, { action: 'propose', expectedRevision: (await check()).revision, operationId: 'important-materials', documents: assets.map(([kind, title, summary, uris], index) => ({
    id: 'asset-' + index, kind, title, summary, content: summary, sources: uris.map(uri => ({ kind: 'reference' as const, uri }))
  })) })
  const important = await store.readOverview(requirement.id, undefined, { materials: 'all' })
  const newMaterials = important.materials!.filter(item => item.documentId.startsWith('asset-'))
  const expectedAssets = [
    join(requirement.dir, 'deliverables/technical-plan.md'), join(requirement.dir, 'deliverables/report.html'),
    'https://example.com/output/8a6e.png', 'https://example.com/output/image', join(requirement.dir, 'design/materials-review.png'),
    'https://example.com/doc/product', join(requirement.dir, 'input/需求说明.docx')
  ]
  assert.deepEqual(newMaterials.map(item => item.uri).sort(), expectedAssets.sort(), 'useful documents, design and requested images survive; process files and unrelated links do not')
  assert.equal(important.total, boundary.total! + expectedAssets.length)
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'all', query: 'JSON' })).total, 0, 'search cannot bring filtered process files back')
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'user' })).total, 7)
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'agent' })).total, 8)
  const filteredPage = await store.readOverview(requirement.id, undefined, { materials: 'all', limit: 2 })
  assert.equal(filteredPage.materials!.length, 2)
  assert.equal(filteredPage.nextOffset, 2, 'pagination is based on the filtered catalog')
  assert.ok((await store.readOverview(requirement.id, 'asset-0')).document!.sources.some(source => source.uri?.endsWith('report.json')), 'filtering leaves the underlying evidence record readable')
  await store.context(requirement.id, session.id, { action: 'commit', expectedRevision: (await check()).revision, operationId: 'material-catalog-history', documents: [
    { id: 'archived-material', kind: 'source', status: 'archived', title: '归档资料', content: '保留原记录。', sources: [{ kind: 'reference', uri: 'https://example.com/archive' }] },
    { id: 'superseded-material', kind: 'artifact', status: 'superseded', title: '被替代的产物', content: '保留原记录。', sources: [{ kind: 'reference', uri: 'https://example.com/old' }] }
  ] })
  assert.equal((await store.readOverview(requirement.id, undefined, { materials: 'all' })).total, important.total, 'archived and superseded materials stay out of the current list')
  await assert.rejects(() => store.readOverview(requirement.id, undefined, { materials: 'all', offset: -1 }), /分页无效/)
  await assert.rejects(() => store.readOverview(requirement.id, undefined, { materials: 'all', limit: 0 }), /分页无效/)
  console.log('PASS requirement materials: important assets, process file filtering, catalog counts/paging, provenance, draft boundaries, URI proof and retry')
} finally { setRequirementsEnabled(false); await rm(home, { recursive: true, force: true }) }
