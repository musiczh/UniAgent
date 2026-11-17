import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import { RequirementDistiller } from '../src/main/requirementDistiller'
import { validateRequirementReading, requirementReadingPrompt, resolveRequirementReadingReferences, requirementBrief } from '../src/main/requirementReading'
import { TaskTitleTokenCounter } from '../src/main/taskTitleTokens'
import { saveRequirementSync, publishRequirement, requirementSnapshot } from '../src/main/requirementSpace'
import { configureRequirementRuntime, initialRequirementSnapshot, prepareRequirementTurn, setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { RequirementReading } from '../src/shared/requirementTypes'
import type { Session, UAEvent } from '../src/shared/types'
import { requirementDecisionTime } from '../src/shared/requirementTimeline'

const timelineMemory = { type: 'decision' as const, topic: '时间轴', basis: 'user' as const }
assert.equal(requirementDecisionTime({ updatedAt: 200, memory: { ...timelineMemory, occurredAt: 100 } }), 100)
assert.equal(requirementDecisionTime({ updatedAt: 200, memory: { ...timelineMemory, occurredAt: 0 } }), 0, 'explicit epoch time is valid')
for (const occurredAt of [-1, NaN, Infinity, Number.MAX_VALUE]) assert.equal(requirementDecisionTime({ updatedAt: 200, memory: { ...timelineMemory, occurredAt } }), 200, 'invalid occurrence times fall back to the recording time')
for (const updatedAt of [0, -1, NaN, Infinity, Number.MAX_VALUE]) assert.equal(requirementDecisionTime({ updatedAt }), undefined, 'missing or invalid recording times remain unknown')

const passageSource = { id: 'passages', status: 'active' as const, content: '甲'.repeat(319) + '🧠' + '乙'.repeat(190) + '。\n' + '丙'.repeat(400) }
const passagePrompt = requirementReadingPrompt('passage-revision', [passageSource])
const passageInput = JSON.parse(passagePrompt.slice(passagePrompt.lastIndexOf('\n\n') + 2))
const passages = passageInput.documents[0].passages as Array<{ id: string; text: string }>
assert.equal(passages.map(passage => passage.text).join(''), passageSource.content, 'host passages preserve every original character')
assert.ok(passages.every(passage => passage.text.length <= 320 && !/[\uD800-\uDBFF]$/.test(passage.text) && !/^[\uDC00-\uDFFF]/.test(passage.text)), 'passages never split a surrogate pair')
const passageReading = { version: 2, sourceRevision: 'passage-revision', updatedAt: 1, goal: { text: '有来源的目标', refs: [{ documentId: passageSource.id, passageId: passages[1].id }] }, constraints: [], issues: [], next: [], stages: [] }
const restored = resolveRequirementReadingReferences(passageReading, [passageSource]) as RequirementReading
assert.equal(restored.goal!.refs[0].quote, passages[1].text, 'host restores the exact original quote instead of model paraphrases')
validateRequirementReading(restored, [passageSource], 'passage-revision')
assert.throws(() => resolveRequirementReadingReferences({ ...passageReading, goal: { text: '目标', refs: [{ documentId: passageSource.id, passageId: 'p999' }] } }, [passageSource]), /片段/)
assert.throws(() => resolveRequirementReadingReferences({ ...passageReading, goal: { text: '目标', refs: [{ documentId: 'unknown', passageId: 'p0' }] } }, [passageSource]), /片段/)
assert.throws(() => resolveRequirementReadingReferences({ ...passageReading, goal: { text: '目标', refs: [{ documentId: passageSource.id, passageId: 'p0', quote: '模型改写的引文' }] } }, [passageSource]), /改写/)
assert.throws(() => validateRequirementReading(resolveRequirementReadingReferences({ ...passageReading, goal: { text: '目标', refs: [{ documentId: passageSource.id, quote: '原文不存在' }] } }, [passageSource]), [passageSource], 'passage-revision'), /来源/)

const home = await mkdtemp(join(tmpdir(), 'requirement-reading-'))
const store = new RequirementStore(home)
const requirement = await store.create({ name: '人读需求' })
const session = { id: 'reader', status: 'completed', config: { agentId: 'codex', workdir: home, requirementId: requirement.id } } as Session
const event: UAEvent = { sessionId: session.id, seq: 1, ts: 1, type: 'user_message', payload: { text: '保存需求背景。基础已交付，用户验收待确认。下一步审查设计。' } }
store.configureContext({ events: async () => [event], requirementId: () => requirement.id })
let worker: RequirementDistiller | undefined
try {
  setRequirementsEnabled(true)
  const initial = await store.context(requirement.id, session.id, { action: 'bootstrap' })
  const proof = [{ kind: 'user' as const, sessionId: session.id, seq: 1, quote: event.payload.text as string }]
  await store.context(requirement.id, session.id, { action: 'commit', expectedRevision: initial.revision, operationId: 'reader-seed', documents: [
    { id: 'core', kind: 'core', title: '人读需求', content: '保存需求背景。', sources: proof },
    { id: 'state', kind: 'state', title: '当前进展', summary: '这是一段并非逐字原文的摘要', content: '基础已交付，用户验收待确认。下一步审查设计。', sources: proof },
    { id: 'design', kind: 'spec', title: '概览设计', content: '保存需求背景。', triggers: ['概览'], sources: proof },
    { id: 'old', kind: 'decision', title: '旧决定', content: '保存需求背景。', sources: proof }
  ] })
  const source = (await store.readingSources(requirement.id))!
  const reading: RequirementReading = { version: 3, sourceRevision: source.revision, taskRevision: source.taskRevision, updatedAt: Date.now(),
    description: { text: '保存需求背景，支持持续补充需求。', refs: [{ documentId: 'core', quote: '保存需求背景。' }] },
    requirements: Array.from({ length: 9 }, (_, index) => ({ title: '分项 ' + index, text: '保存需求背景', refs: [{ documentId: 'design', quote: '保存需求背景。' }] })),
    goal: { text: '保存需求背景', refs: [{ documentId: 'core', quote: '保存需求背景。' }] },
    scope: { text: '背景与设计审查', refs: [{ documentId: 'core', quote: '保存需求背景。' }, { documentId: 'state', quote: '下一步审查设计。' }] },
    current: { text: '基础已交付，用户验收待确认', refs: [{ documentId: 'state', quote: '基础已交付，用户验收待确认。' }] },
    constraints: [], stages: [{ title: '基础能力', detail: '用户验收待确认', status: 'delivered', refs: [{ documentId: 'state', quote: '基础已交付，用户验收待确认。' }] }], issues: [],
    next: [{ text: '审查设计', kind: 'confirmed', refs: [{ documentId: 'state', quote: '下一步审查设计。' }] }] }
  assert.throws(() => validateRequirementReading({ ...reading, goal: { text: '不可信结论', refs: [{ documentId: 'core', quote: '原文没有的证据' }] } }, source.documents, source.revision), /来源/)
  assert.throws(() => validateRequirementReading({ ...reading, sourceRevision: 'wrong' }, source.documents, source.revision), /版本/)
  const coreBefore = await readFile(requirement.docPath, 'utf8')
  await store.saveReading(requirement.id, reading)
  await store.saveReading(requirement.id, { ...reading, version: 1 })
  assert.equal((await store.readOverview(requirement.id)).readingStatus, 'stale', 'old stage projections remain readable and request the new topic projection')
  await store.saveReading(requirement.id, reading)
  assert.equal(await readFile(requirement.docPath, 'utf8'), coreBefore, 'projection never edits authoritative documents')
  let overview = await store.readOverview(requirement.id)
  assert.equal(overview.reading?.current?.text, reading.current?.text)
  assert.equal(overview.readingStatus, 'ready')
  assert.equal(overview.reading?.requirements?.length, 9, 'all requirement groups survive saving and reading')
  assert.equal(requirementBrief(reading)?.requirements, undefined, 'human detail never expands Session injection')
  const counter = new TaskTitleTokenCounter()
  try {
    assert.equal(await counter.count(' hello'.repeat(300)), 300)
    await store.saveReading(requirement.id, { ...reading, description: { ...reading.description!, text: ' hello'.repeat(300) } })
    await assert.rejects(() => store.saveReading(requirement.id, { ...reading, description: { ...reading.description!, text: ' hello'.repeat(301) } }), /300 token/)
    assert.equal((await store.readReading(requirement.id))?.description?.text, ' hello'.repeat(300), 'invalid budget preserves the last valid projection')
  } finally { await counter.close() }
  await store.saveReading(requirement.id, reading)
  assert.equal(overview.core, undefined, 'overview does not load full Markdown')
  const catalog = await store.context(requirement.id, session.id, { action: 'read', query: '概览', limit: 1 })
  assert.equal(catalog.documents[0].id, 'design')
  assert.equal(catalog.documents[0].content, undefined)
  assert.equal((await store.context(requirement.id, session.id, { action: 'read', query: '没有这个主题', limit: 1 })).total, 0)
  assert.ok((await store.context(requirement.id, session.id, { action: 'read', documentId: 'guide' })).document.content.includes('expectedRevision'))
  await saveRequirementSync(requirement, { sessions: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [String(index), { throughSeq: 1, completedSeq: 1, processedSeq: -1, origin: 'user', status: 'pending' }])) as any })
  const boot = await store.context(requirement.id, session.id, { action: 'bootstrap', query: '概览' })
  assert.equal(boot.sync.pendingCount, 1000)
  assert.equal(boot.sync.pending, undefined)
  assert.equal(boot.core, undefined)
  const document = await store.context(requirement.id, session.id, { action: 'read', documentId: 'state', limit: 3 })
  assert.equal(document.sync.pending, undefined)
  assert.equal(document.document.content, '基础已')
  assert.equal(document.nextOffset, 3)
  const stateRemainder = await store.context(requirement.id, session.id, { action: 'read', documentId: 'state', offset: document.nextOffset })
  assert.equal(document.document.content + stateRemainder.document.content, '基础已交付，用户验收待确认。下一步审查设计。', 'on-demand paging preserves the full progress and next action')
  assert.equal(stateRemainder.nextOffset, null)
  configureRequirementRuntime(() => session, async () => boot)
  const initialContext = await initialRequirementSnapshot(session)
  assert.deepEqual(initialContext, { id: requirement.id, name: '人读需求', overview: { goal: '保存需求背景', scope: '背景与设计审查' }, readingStatus: 'ready' }, 'initial context contains identity, short goal/scope and reading status while detailed progress remains available on demand')
  assert.ok(JSON.stringify(initialContext).length < 3000, 'many historical Sessions cannot expand default injection')
  const turn = prepareRequirementTurn(session, '继续')
  const prompt = await turn.ready; turn.complete()
  assert.equal(prompt, '继续', 'ordinary turn preparation preserves the original user input')
  await store.context(requirement.id, session.id, { action: 'propose', expectedRevision: source.revision, operationId: 'draft-next', documents: [{ id: 'draft', kind: 'proposal', title: '待确认建议', content: '建议并不生效' }] })
  overview = await store.readOverview(requirement.id)
  assert.equal(overview.readingStatus, 'stale')
  assert.equal(overview.reading?.sourceRevision, source.revision)
  await assert.rejects(() => store.saveReading(requirement.id, reading), /来源已变化/)
  let calls = 0, response = 'invalid JSON'
  worker = new RequirementDistiller(store, { session: () => session, unsupported: () => undefined, extract: async () => { throw new Error('UI summary must not extract turns') }, report: () => {}, summarize: async () => { calls++; return response } })
  for (let index = 0; index < 5; index++) worker.scheduleReading(requirement.id, session.id)
  await worker.flush(requirement.id)
  assert.equal(calls, 0, 'opening the page does not call a model')
  worker.scheduleReading(requirement.id, session.id, true)
  await worker.flush(requirement.id)
  assert.equal(calls, 1, 'invalid output is collected without an expensive repair loop')
  assert.equal((await store.readCuration(requirement.id)).status, 'idle')
  assert.equal((await store.readCuration(requirement.id)).failures?.length, 1)
  assert.equal((await store.readReading(requirement.id))?.current?.text, reading.current?.text, 'failed organization preserves the previous projection')
  response = JSON.stringify({ ...reading, current: { text: '基础能力已交付；下一步审查设计，用户验收待确认', refs: [{ documentId: 'state', passageId: 'p0' }] }, constraints: [], issues: [], next: [] })
  await worker.retryFailed(requirement.id)
  await worker.flush(requirement.id)
  assert.equal(calls, 2)
  assert.equal((await store.readOverview(requirement.id)).readingStatus, 'ready')
  const reorganized = await store.readReading(requirement.id)
  assert.deepEqual(reorganized?.next, reading.next, 'empty model selection cannot clear an already recorded action')
  assert.equal(reorganized?.current?.text, '基础能力已交付；下一步审查设计，用户验收待确认', 'new evidence replaces the old cached progress')
  assert.equal((await store.context(requirement.id, session.id, { action: 'read', query: '待确认', limit: 5 })).documents[0].status, 'draft')
  const currentRevision = (await store.context(requirement.id, session.id, { action: 'check' })).revision
  await store.context(requirement.id, session.id, { action: 'commit', expectedRevision: currentRevision, operationId: 'replace-decision', documents: [{ id: 'current-decision', kind: 'decision', title: '当前决定', content: '保存需求背景。', sources: proof, supersedes: 'old' }] })
  const decisions = await store.readOverview(requirement.id, undefined, { category: 'decisions' })
  assert.ok(decisions.documents.some(doc => doc.id === 'current-decision'))
  assert.ok(!decisions.documents.some(doc => doc.id === 'old'), 'replaced decisions only appear through explicit history navigation')
  assert.equal((await store.readOverview(requirement.id, 'old')).document?.status, 'superseded', 'history remains readable by ID')
  const eventTime = Date.now() - 86400000
  const timelineRevision = (await store.context(requirement.id, session.id, { action: 'check' })).revision
  await store.context(requirement.id, session.id, { action: 'commit', expectedRevision: timelineRevision, operationId: 'timeline-order', documents: [
    ...[['timeline-z-new', eventTime], ['timeline-m-middle', eventTime - 1000], ['timeline-a-old', eventTime - 2000]].map(([id, occurredAt]) => ({ id: id as string, kind: 'decision' as const, title: '时间轴排序 ' + id, content: '保存需求背景。', sources: proof, memory: { type: 'decision' as const, topic: '时间轴排序', basis: 'user' as const, occurredAt: occurredAt as number } })),
    { id: 'timeline-recorded', kind: 'decision', title: '时间轴排序 无发生时间', content: '保存需求背景。', sources: proof }
  ] })
  const timelineQuery = { category: 'decisions', query: '时间轴排序', includeHistory: true, limit: 2 }
  const timelineFirst = await store.readOverview(requirement.id, undefined, timelineQuery)
  assert.deepEqual(timelineFirst.documents.map(doc => doc.id), ['timeline-recorded', 'timeline-z-new'], 'timeline uses occurrence time before pagination, falling back to recording time')
  assert.equal(timelineFirst.nextOffset, 2)
  const timelineSecond = await store.readOverview(requirement.id, undefined, { ...timelineQuery, offset: timelineFirst.nextOffset! })
  assert.deepEqual(timelineSecond.documents.map(doc => doc.id), ['timeline-m-middle', 'timeline-a-old'], 'older records continue in descending order on the next page')
  const currentOrder = await store.readOverview(requirement.id, undefined, { query: '时间轴排序', limit: 10 })
  assert.deepEqual(currentOrder.documents.map(doc => doc.id).filter(id => id !== 'timeline-recorded'), ['timeline-a-old', 'timeline-m-middle', 'timeline-z-new'], 'other catalogs retain their update-time ordering')
  await store.saveTaskDigest(requirement.id, { sessionId: 'report', title: '实现报告', summary: '已有实现，用户验收待确认。', work: ['实现功能'], results: ['代码已提交'], verification: ['离线测试通过'], remaining: ['用户验收'], throughSeq: 2, updatedAt: Date.now(), origin: 'agent', coverage: 'submitted' })
  assert.equal((await store.readOverview(requirement.id)).readingStatus, 'stale', 'task changes invalidate the displayed progress')
  const taskSource = (await store.readingSources(requirement.id))!
  const task = taskSource.documents.find(doc => doc.id === 'task:report')!
  const progress = { text: '已有实现，用户验收待确认', basis: 'agent' as const, refs: [{ documentId: task.id, quote: '已有实现，用户验收待确认。' }] }
  const withTask: RequirementReading = { ...reading, sourceRevision: taskSource.revision, taskRevision: taskSource.taskRevision, requirements: [{ ...reading.requirements![0], progress }] }
  await store.saveReading(requirement.id, withTask)
  assert.equal((await store.readOverview(requirement.id, task.id)).document?.title, '实现报告', 'task citations open the virtual report without registering a material')
  assert.equal((await store.readOverview(requirement.id)).readingStatus, 'ready')
  assert.throws(() => validateRequirementReading({ ...withTask, requirements: [{ title: '错误地提升报告为需求', ...progress }] }, taskSource.documents, taskSource.revision), /分项/, 'Agent reports cannot become requirement scope')
  assert.throws(() => validateRequirementReading({ ...withTask, requirements: [{ ...reading.requirements![0], image: { documentId: 'design', uri: '/invented.png', caption: '伪造图片' } }] }, taskSource.documents, taskSource.revision), /配图/)
  const imageDocument = { ...source.documents.find(doc => doc.id === 'design')!, id: 'image', kind: 'artifact' as const, sources: [{ kind: 'reference' as const, uri: '/design/preview.png' }] }
  const imageReading = { ...withTask, requirements: [{ ...reading.requirements![0], image: { documentId: 'image', uri: '/design/preview.png', caption: '已登记设计' } }] }
  validateRequirementReading(imageReading, [...taskSource.documents, imageDocument], taskSource.revision)
  assert.throws(() => validateRequirementReading({ ...imageReading, requirements: [{ ...imageReading.requirements[0], image: { ...imageReading.requirements[0].image, uri: '/design/unrecorded.png' } }] }, [...taskSource.documents, imageDocument], taskSource.revision), /配图/)
  const reportPage = await store.readOverview(requirement.id, task.id, { limit: 5 })
  await store.saveTaskDigest(requirement.id, { ...((await store.taskDigests(requirement.id)).report), throughSeq: 3, updatedAt: Date.now(), summary: '报告已有变化' })
  await assert.rejects(() => store.saveReading(requirement.id, withTask), /任务来源已变化/)
  assert.notEqual((await store.readOverview(requirement.id, task.id, { offset: 5 })).revision, reportPage.revision, 'task report pagination detects a changed report')
  assert.equal((await store.context(requirement.id, session.id, { action: 'check', expectedRevision: taskSource.revision })).readingStale, true, 'Agent revision checks also notice outdated task progress')
  const budgetRequirement = await store.create({ name: '带完整元数据的资料预算' })
  const baseline = (await requirementSnapshot(budgetRequirement))!
  const budgetDocuments = Object.fromEntries(Array.from({ length: 150 }, (_, index) => {
    const id = 'budget-' + index
    return [id, { ...task, id, title: '资料 ' + index, content: '甲'.repeat(500), memory: { ...task.memory!, evidenceScope: '依据'.repeat(500) }, updatedAt: index }]
  }))
  await publishRequirement(budgetRequirement, { ...baseline.documents, ...budgetDocuments })
  const budgetSource = (await store.readingSources(budgetRequirement.id))!
  assert.ok(Buffer.byteLength(requirementReadingPrompt(budgetSource.revision, budgetSource.documents)) <= 512 * 1024, 'input budget includes JSON, metadata, passages and instructions rather than body characters alone')
  assert.equal(budgetSource.coverage.complete, false)
  assert.ok(budgetSource.coverage.pendingDocumentIds.length > 0, 'excluded materials remain explicit coverage gaps')
  assert.equal(budgetSource.documents.length + budgetSource.coverage.pendingDocumentIds.length, Object.keys(baseline.documents).length + 150)
  assert.ok(budgetSource.documents.filter(doc => doc.id.startsWith('budget-')).every(doc => doc.content === '甲'.repeat(500)), 'selected source documents remain complete for quotation validation')
  console.log('PASS requirement reading: citations, 300-token boundary, full scope, task provenance/staleness, refreshed progress, retries, short injection and paging')
} finally { worker?.dispose(); setRequirementsEnabled(false); configureRequirementRuntime(() => undefined); await rm(home, { recursive: true, force: true }) }
