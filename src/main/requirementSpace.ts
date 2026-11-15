import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Requirement, RequirementContextRequest, RequirementDocument, RequirementDocumentInput, RequirementDocumentKind, RequirementSource, RequirementReading, RequirementOverviewQuery } from '../shared/requirementTypes'
import { REQUIREMENT_GUIDE } from './requirementGuide'
import { requirementCodec } from './requirementCodec'
import { requirementBrief, validateRequirementReading, requirementReadingRefs, requirementReadingPrompt, readingDocumentInput, REQUIREMENT_READING_MAX_INPUT_BYTES } from './requirementReading'
import { TaskTitleTokenCounter } from './taskTitleTokens'
import { readTaskDigests } from './requirementCurationStore'
import { isSharedMemory, requirementChanges, requirementMemories, requirementRelevance } from './requirementMemory'
import { requirementMaterials } from './requirementMaterials'
import { requirementDecisionTime } from '../shared/requirementTimeline'
import { validProjectCodePath } from '../shared/projectMemory'
import { requirementNavigation, validSkillPath } from './requirementNavigation'

type StoredDocument = Omit<RequirementDocument, 'content'> & { content?: string; contentHash?: string }

export interface RequirementSnapshot {
  formatVersion: 2
  revision: string
  documents: Record<string, StoredDocument>
  operations: Record<string, { fingerprint: string; revision: string }>
  projectionStatus?: 'ready' | 'pending'
}
export interface RequirementCursor { throughSeq: number; completedSeq: number; processedSeq: number; processedOffset?: number; origin: 'user' | 'team'; status: 'pending' | 'synced' | 'interrupted' }
export interface RequirementSync { sessions: Record<string, RequirementCursor>; background?: { status: 'pending' | 'unsupported' | 'failed' | 'synced'; reason?: string } }
export interface RequirementAccess {
  readOnly?: boolean
  background?: boolean
  projectId?: string
  verifySource?: (source: RequirementSource) => Promise<'user' | 'tool' | 'reference'>
  referenceVersion?: (uri: string) => Promise<string | undefined>
  readThrough?: { throughSeq: number; offset: number }
}
export interface RequirementValidationIssue {
  path: string
  documentId?: string
  code: string
  message: string
  hint: string
}
export class RequirementValidationError extends Error {
  readonly details: { code: 'requirement_validation_failed'; issues: RequirementValidationIssue[] }
  constructor(issues: RequirementValidationIssue[]) {
    super(`需求上下文校验未通过（${issues.length} 处），本批次未写入。\n` + issues.map((issue, index) =>
      `${index + 1}. ${issue.path}${issue.documentId ? `（文档 ${issue.documentId}）` : ''} [${issue.code}] ${issue.message}\n修改：${issue.hint}`).join('\n'))
    this.details = { code: 'requirement_validation_failed', issues }
  }
}
const credentials = /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}|\bsk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|密码)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{8,}/i
export const redactRequirementText = (text: string): string => text.replace(new RegExp(credentials.source, 'gi'), '[敏感值已隐藏]')
const digest = (value: unknown) => requirementCodec<string>('hash', value)
const folders: Record<RequirementDocumentKind, string> = { core: '', state: '', spec: 'specs', decision: 'decisions', knowledge: 'knowledge', source: 'sources', artifact: 'artifacts', proposal: 'proposals' }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)
export const requirementDocumentPath = (doc: Pick<RequirementDocument, 'id' | 'kind'>): string => doc.kind === 'core' ? 'context.md' : doc.kind === 'state' ? 'state.md' : `${folders[doc.kind]}/${doc.id}.md`

/** All heavy document I/O is asynchronous. Only the manifest rename publishes a revision. */
export async function requirementWrite(root: string, relative: string, content: string): Promise<void> {
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..') || relative.includes('\\') || relative.startsWith('/')) throw new Error('requirement_invalid_path')
  let current = root
  for (const part of ['', ...relative.split('/')]) {
    if (part) current = join(current, part)
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('requirement_symlink_rejected') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await mkdir(dirname(current), { recursive: true, mode: 0o700 })
  const temp = current + '.' + randomUUID() + '.tmp'
  const file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(content); await file.sync() } finally { await file.close() }
  await rename(temp, current)
  const directory = await open(dirname(current), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export async function safeRead(root: string, relative: string): Promise<string> {
  let path = root
  for (const part of ['', ...relative.split('/')]) {
    if (part) path = join(path, part)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('requirement_symlink_rejected')
  }
  return readFile(path, 'utf8')
}
interface RequirementManifest { formatVersion: number; revision: string; checkpoints?: Array<{ revision: string; slot: number }> }
export async function requirementSnapshot(r: Requirement): Promise<RequirementSnapshot | undefined> {
  let manifest: RequirementManifest
  try { manifest = JSON.parse(await safeRead(r.dir, '.uniagent/manifest.json')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (manifest.formatVersion !== 2 || !/^[a-f0-9]{64}$/.test(manifest.revision)) throw new Error('需求登记损坏，请恢复 manifest.json')
  return readRevision(r, manifest.revision, manifest)
}
async function readRevision(r: Requirement, revision: string, manifest?: RequirementManifest): Promise<RequirementSnapshot> {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('需求修订无效')
  manifest ??= JSON.parse(await safeRead(r.dir, '.uniagent/manifest.json'))
  const checkpoint = manifest!.checkpoints?.find(item => item.revision === revision)
  if (checkpoint) {
    if (!Number.isInteger(checkpoint.slot) || checkpoint.slot < 0 || checkpoint.slot > 20) throw new Error('需求恢复点无效')
    return requirementCodec<RequirementSnapshot>('unpack', { text: await safeRead(r.dir, `.uniagent/checkpoints/${checkpoint.slot}.json`), revision })
  }
  return requirementCodec<RequirementSnapshot>('decode', { text: await safeRead(r.dir, `.uniagent/revisions/${revision}.json`), revision })
}
export async function documentContent(r: Requirement, doc: StoredDocument): Promise<string> {
  if (doc.content !== undefined) return doc.content
  if (!doc.contentHash || !/^[a-f0-9]{64}$/.test(doc.contentHash)) throw new Error('需求正文引用损坏')
  const content = await safeRead(r.dir, `.uniagent/bodies/${doc.contentHash}.md`)
  if (await digest(content) !== doc.contentHash) throw new Error('需求正文校验失败，未使用损坏资料')
  return content
}
export async function requirementRoutingSources(r: Requirement): Promise<import('../shared/requirementTypes').RequirementRoutingSources> {
  const snapshot = await requirementSnapshot(r)
  if (!snapshot) {
    const content = await safeRead(r.dir, 'context.md'), contentHash = await digest(content)
    return { revision: contentHash, documents: [{ id: 'core', kind: 'core', title: r.name, content, contentHash, status: 'active', freshness: 'needs-review', summary: '', sources: [], dependencies: [], updatedAt: r.updatedAt }] }
  }
  const documents = await Promise.all(Object.values(snapshot.documents).filter(doc => doc.status === 'active' && doc.kind !== 'proposal' && (!doc.memory || doc.memory.basis === 'user')).sort((a, b) => a.id.localeCompare(b.id)).map(async doc => {
    const content = await documentContent(r, doc)
    return { ...doc, content, contentHash: doc.contentHash || await digest(content) }
  }))
  const revision = await digest({ id: r.id, name: r.name, projectId: r.projectId, status: r.status, documents: documents.map(({ content: _content, ...doc }) => doc) })
  return { revision, documents }
}
export async function readRequirementRouting(r: Requirement): Promise<{ snapshot: import('../shared/requirementTypes').RequirementRoutingSnapshot; sources: import('../shared/requirementTypes').RequirementRoutingSources }> {
  const sources = await requirementRoutingSources(r)
  try {
    const stored = JSON.parse(await safeRead(r.dir, '.uniagent/routing.json'))
    if (stored.view?.schemaVersion !== 1 || stored.view.generatorVersion !== 1 || stored.view.requirementId !== r.id || await digest(stored.view) !== stored.checksum) throw new Error('invalid_requirement_routing_cache')
    return { sources, snapshot: { status: stored.view.sourceRevision === sources.revision && stored.view.coverage.complete ? 'ready' : 'stale', sourceRevision: sources.revision, view: stored.view } }
  } catch (error) {
    return { sources, snapshot: { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed', sourceRevision: sources.revision,
      ...((error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { error: '需求路由缓存不可用，需读取原文' }) } }
  }
}
export async function saveRequirementRouting(r: Requirement, view: import('../shared/requirementTypes').RequirementRoutingView): Promise<void> {
  if (!view || view.schemaVersion !== 1 || view.generatorVersion !== 1 || !Number.isFinite(view.generatedAt) || !Array.isArray(view.fragments) || !view.coverage || !Array.isArray(view.coverage.pendingDocumentIds)) throw new Error('invalid_requirement_routing_cache')
  const sources = await requirementRoutingSources(r)
  if (view.sourceRevision !== sources.revision || view.requirementId !== r.id) throw new Error('requirement_routing_revision_changed')
  const { validateRoutingFragment, assembleRoutingFragments } = await import('./requirementRouting')
  for (const fragment of view.fragments) {
    const doc = sources.documents.find(doc => doc.id === fragment.documentId && doc.contentHash === fragment.documentHash)
    if (!doc) throw new Error('invalid_requirement_routing_evidence')
    if (!Number.isInteger(fragment.offset) || fragment.offset < 0 || !Number.isInteger(fragment.length) || fragment.length < 0 || fragment.offset + fragment.length > doc.content.length) throw new Error('invalid_requirement_routing_evidence')
    validateRoutingFragment({ features: fragment.features, exclusions: fragment.exclusions, conflicts: fragment.conflicts }, doc, { offset: fragment.offset, text: doc.content.slice(fragment.offset, fragment.offset + fragment.length) })
  }
  for (const doc of sources.documents) {
    const parts = view.fragments.filter(fragment => fragment.documentId === doc.id).sort((a, b) => a.offset - b.offset)
    let through = 0
    if (!parts.length) throw new Error('requirement_routing_incomplete')
    for (const part of parts) { if (part.offset > through) throw new Error('requirement_routing_incomplete'); through = Math.max(through, part.offset + part.length) }
    if (through !== doc.content.length) throw new Error('requirement_routing_incomplete')
  }
  if (!view.coverage.complete || view.coverage.pendingDocumentIds.length) throw new Error('requirement_routing_incomplete')
  if (await digest(assembleRoutingFragments(view.fragments)) !== await digest({ features: view.features, exclusions: view.exclusions, conflicts: view.conflicts })) throw new Error('invalid_requirement_routing_aggregate')
  await requirementWrite(r.dir, '.uniagent/routing.json', JSON.stringify({ view, checksum: await digest(view) }))
}
/** UI reads never initialize, repair projections, acknowledge cursors or mutate documents. */
export async function readRequirementReading(r: Requirement): Promise<RequirementReading | undefined> {
  try {
    const value = JSON.parse(await safeRead(r.dir, '.uniagent/reading.json'))
    if (![1, 2, 3].includes(value.reading?.version) || await digest(value.reading) !== value.checksum) throw new Error('需求阅读摘要校验失败')
    return value.reading
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
const descriptionTokens = new TaskTitleTokenCounter()
export async function saveRequirementReading(r: Requirement, reading: RequirementReading): Promise<void> {
  const snapshot = await requirementSnapshot(r)
  if (!snapshot || snapshot.revision !== reading.sourceRevision) throw new Error('阅读摘要来源已变化，请重新整理')
  const tasks = await readingTasks(r)
  if (reading.version === 3 && reading.taskRevision !== tasks.revision) throw new Error('阅读摘要任务来源已变化，请重新整理')
  const refs = requirementReadingRefs(reading)
  const ids = [...new Set([...refs.map(ref => ref.documentId), ...(reading.requirements || []).flatMap(section => section.image ? [section.image.documentId] : [])])]
  const sources = await Promise.all(ids.map(async id => {
    const task = tasks.documents.find(doc => doc.id === id)
    if (task) return task
    const doc = snapshot.documents[id]
    if (!doc || doc.status !== 'active' && !isSharedMemory(doc)) throw new Error('阅读摘要引用了失效资料')
    return { ...doc, content: await documentContent(r, doc) }
  }))
  validateRequirementReading(reading, sources, snapshot.revision)
  if (reading.version === 3 && reading.description && await descriptionTokens.count(reading.description.text) > 300) throw new Error('需求描述超过 300 token，请缩短后重新整理')
  await requirementWrite(r.dir, '.uniagent/reading.json', JSON.stringify({ reading, checksum: await digest(reading) }))
  await requirementWrite(r.dir, '.uniagent/reading-status.json', JSON.stringify({ revision: snapshot.revision }))
}
export async function readingFailure(r: Requirement, revision: string, error: string): Promise<void> {
  await requirementWrite(r.dir, '.uniagent/reading-status.json', JSON.stringify({ revision, error }))
}
export async function readingSources(r: Requirement) {
  const snapshot = await requirementSnapshot(r)
  if (!snapshot) return undefined
  const tasks = await readingTasks(r)
  const priority = (doc: StoredDocument) => doc.id === 'core' ? 3 : doc.status === 'active' && ['spec', 'decision'].includes(doc.kind) ? 2 : 1
  const all = [...Object.values(snapshot.documents).filter(doc => doc.status === 'active' || isSharedMemory(doc)), ...tasks.documents]
    .sort((a, b) => priority(b) - priority(a) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const documents: RequirementDocument[] = [], pendingDocumentIds: string[] = []
  let size = 0
  let bytes = Buffer.byteLength(requirementReadingPrompt(snapshot.revision, []))
  for (const doc of all) {
    const content = doc.id.startsWith('task:') ? doc.content! : await documentContent(r, doc)
    const document = { ...doc, content }
    const inputBytes = Buffer.byteLength(JSON.stringify(readingDocumentInput(document))) + (documents.length ? 1 : 0)
    if (size + content.length > 120000 || bytes + inputBytes > REQUIREMENT_READING_MAX_INPUT_BYTES) { pendingDocumentIds.push(doc.id); continue }
    documents.push(document); size += content.length; bytes += inputBytes
  }
  return { revision: snapshot.revision, taskRevision: tasks.revision, documents, coverage: { complete: !pendingDocumentIds.length, pendingDocumentIds } }
}

async function readingTasks(r: Requirement) {
  const tasks = await readTaskDigests(r)
  const documents: RequirementDocument[] = Object.values(tasks).map(task => ({ id: 'task:' + task.sessionId, kind: 'artifact', title: task.title, summary: task.summary,
    content: [task.summary, ...(['work', 'results', 'verification', 'remaining'] as const).map((key, index) => '## ' + ['工作', '结果', '验证', '未完成'][index] + '\n' + task[key].join('\n'))].join('\n\n'),
    status: 'active', freshness: 'needs-review', memory: { type: 'finding', basis: 'agent', topic: task.title, evidenceScope: task.coverage === 'partial' ? '仅覆盖部分讨论，未重新验证' : '任务 Agent 提交，未重新验证' },
    sources: [{ kind: 'agent', sessionId: task.sessionId }, ...(task.sources || [])], dependencies: task.documentIds || [], triggers: [], projectIds: [], updatedAt: task.updatedAt }))
  return { documents, revision: await digest(tasks) }
}
export async function readRequirementOverview(r: Requirement, documentId?: string, query: RequirementOverviewQuery = {}): Promise<import('../shared/requirementTypes').RequirementOverview> {
  if (documentId !== undefined && (typeof documentId !== 'string' || documentId.length > 256)) throw new Error('需求文档 ID 无效')
  const snapshot = await requirementSnapshot(r)
  if (!snapshot) {
    if (documentId && documentId !== 'core') throw new Error('需求文档不存在')
    const core = { id: 'core', kind: 'core' as const, title: r.name, content: await safeRead(r.dir, 'context.md'), status: 'active' as const, freshness: 'needs-review' as const, summary: '', sources: [], dependencies: [], updatedAt: 0 }
    return { revision: 'legacy', dir: r.dir, name: r.name, status: r.status, readingStatus: 'missing', document: documentId ? core : undefined, documents: [] }
  }
  const visible = Object.values(snapshot.documents)
  const read = async (id: string) => {
    if (id.startsWith('task:')) return (await readingTasks(r)).documents.find(doc => doc.id === id)
    const doc = visible.find(item => item.id === id)
    return doc && { ...doc, content: await documentContent(r, doc) }
  }
  if (documentId) {
    const sync = documentId === 'sync' ? await requirementSync(r) : undefined
    const document = sync ? { id: 'sync', kind: 'source' as const, title: '资料整理范围', status: 'active' as const, freshness: 'needs-review' as const, sources: [], dependencies: [], summary: '', updatedAt: 0,
      content: `尚有 ${Object.values(sync.sessions).filter(cursor => cursor.throughSeq > cursor.processedSeq).length} 个会话存在未整理内容。\n\n${sync.background?.reason || '已保存的资料仍可阅读；未整理的讨论不能视为已经覆盖。'}` } : await read(documentId)
    if (!document) throw new Error('需求文档不存在')
    const offset = query.offset ?? 0, limit = query.limit ?? 16000
    if (!Number.isInteger(offset) || offset < 0 || offset > document.content.length || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('资料正文分页无效')
    return { revision: documentId.startsWith('task:') ? await digest({ revision: snapshot.revision, document }) : snapshot.revision, dir: r.dir, documents: [], document: { ...document, content: document.content.slice(offset, offset + limit) }, totalLength: document.content.length, nextOffset: offset + limit < document.content.length ? offset + limit : null }
  }
  const offset = query.offset ?? 0, limit = query.limit ?? 30
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('资料分页无效')
  if (query.materials) {
    const search = query.query?.trim()
    const matches = requirementMaterials(visible, r.dir)
      .filter(item => query.materials === 'all' || item.origin === query.materials)
      .filter(item => !search || requirementRelevance({ id: item.uri, title: item.title, summary: item.summary, triggers: [item.format] }, search) > 0)
    return { revision: snapshot.revision, dir: r.dir, name: r.name, status: r.status, documents: [], materials: matches.slice(offset, offset + limit),
      total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null }
  }
  const matches = visible.filter(doc => !['core', 'state'].includes(doc.id))
    .filter(doc => query.includeHistory || !['archived', 'superseded'].includes(doc.status))
    .filter(doc => query.category !== 'decisions' || ['spec', 'decision'].includes(doc.kind) || doc.memory && ['decision', 'change', 'intent'].includes(doc.memory.type))
    .filter(doc => query.category !== 'proposal' || !isSharedMemory(doc))
    .filter(doc => !query.category || query.category === 'all' || query.category === 'decisions' || (query.category === 'discussion' ? doc.sources.some(source => source.sessionId) : doc.kind === query.category))
    .filter(doc => !query.query || requirementRelevance(doc, query.query) > 0)
    .sort((a, b) => (query.category === 'decisions' ? (requirementDecisionTime(b) ?? -1) - (requirementDecisionTime(a) ?? -1) : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
  const [reading, sync, readingState, tasks] = await Promise.all([
    readRequirementReading(r).catch(() => undefined), requirementSync(r),
    safeRead(r.dir, '.uniagent/reading-status.json').then(JSON.parse).catch(() => ({})), readingTasks(r)
  ])
  return { revision: snapshot.revision, dir: r.dir, name: r.name, status: r.status, reading,
    associations: await requirementNavigation(visible, r.projectId),
    readingStatus: readingState.error && readingState.revision === snapshot.revision ? 'failed' : reading ? reading.sourceRevision === snapshot.revision && reading.version === 3 && reading.taskRevision === tasks.revision ? 'ready' : 'stale' : 'missing',
    readingError: readingState.revision === snapshot.revision ? readingState.error : undefined,
    sync: { status: Object.values(sync.sessions).some(cursor => cursor.throughSeq > cursor.processedSeq) || sync.background?.status === 'failed' ? 'pending' : 'synced', pendingCount: Object.values(sync.sessions).filter(cursor => cursor.throughSeq > cursor.processedSeq).length, reason: sync.background?.reason },
    documents: matches.slice(offset, offset + limit).map(({ content, contentHash, ...metadata }) => metadata), total: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null }
}
export async function requirementSync(r: Requirement): Promise<RequirementSync> {
  try {
    const state = JSON.parse(await safeRead(r.dir, '.uniagent/sync.json'))
    if (!state.sessions && state.turns && typeof state.turns === 'object') return { sessions: {} }
    if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) throw new Error('需求同步游标损坏，未重置数据')
    for (const cursor of Object.values(state.sessions) as RequirementCursor[]) {
      if (!cursor || !Number.isInteger(cursor.throughSeq) || cursor.throughSeq < 0 || !Number.isInteger(cursor.processedSeq) || cursor.processedSeq < -1 || cursor.processedSeq > cursor.throughSeq || !Number.isInteger(cursor.completedSeq) || cursor.completedSeq < -1 || cursor.completedSeq > cursor.throughSeq || !Number.isInteger(cursor.processedOffset ?? 0) || (cursor.processedOffset ?? 0) < 0 || !['user','team'].includes(cursor.origin) || !['pending','synced','interrupted'].includes(cursor.status)) throw new Error('需求同步游标损坏，未重置数据')
    }
    return state
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: {} }; throw error }
}
export const saveRequirementSync = (r: Requirement, sync: RequirementSync) => requirementWrite(r.dir, '.uniagent/sync.json', JSON.stringify(sync))

function visible(doc: StoredDocument, projectId?: string): boolean {
  return (doc.status === 'active' || isSharedMemory(doc)) && (!projectId || !doc.projectIds.length || doc.projectIds.includes(projectId))
}
function navigation(snapshot: RequirementSnapshot, query = '', projectId?: string, drafts = false) {
  const all = Object.values(snapshot.documents).filter(doc => !['core', 'state'].includes(doc.kind) && (visible(doc, projectId) || drafts && doc.status === 'draft' && (!projectId || !doc.projectIds.length || doc.projectIds.includes(projectId))))
  const selected = query.trim() ? all.map(doc => ({ doc, score: requirementRelevance(doc, query) })).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt).map(row => row.doc) : all
  const included = new Set(selected.map(doc => doc.id))
  for (const doc of selected) for (const id of doc.dependencies) included.add(id)
  return [...selected, ...all.filter(doc => included.has(doc.id) && !selected.includes(doc))].map(({ id, kind, title, summary, status, projectIds, dependencies, freshness, memory }) => ({ id, kind, title, summary, status, projectIds, dependencies, freshness, ...(memory ? { memory } : {}) }))
}
export async function projectRequirement(r: Requirement, snapshot: RequirementSnapshot, full = false): Promise<void> {
  const index = navigation(snapshot).map(doc => `- ${doc.title}：${doc.summary}（read documentId=${doc.id}）`).join('\n')
  const complete = await safeRead(r.dir, '.uniagent/projection-revision').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }) === snapshot.revision
  const groups = new Map<string, string[]>()
  for (const doc of Object.values(snapshot.documents)) {
    if (!full && complete && !['core', 'state'].includes(doc.kind)) continue
    const path = ['core', 'state'].includes(doc.kind) ? requirementDocumentPath(doc) : `${folders[doc.kind]}/INDEX.md`
    if (!['core', 'state'].includes(doc.kind)) {
      const entries = groups.get(path) || []
      entries.push(`## ${doc.title}\n\nID：${doc.id} · ${doc.status}\n\n${doc.summary || '按 ID 读取正文与来源。'}\n`)
      groups.set(path, entries)
      continue
    }
    const text = `# ${doc.title}\n\n> 需求状态：${{ active: '进行中', done: '已完成', archived: '已归档' }[r.status]}；文档：${doc.id}；${doc.status}；${doc.freshness}\n\n${await documentContent(r, doc)}\n`
    if (await safeRead(r.dir, path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }) !== text) await requirementWrite(r.dir, path, text)
  }
  for (const [path, entries] of groups) {
    const text = '# 资料索引\n\n正文按 documentId 读取；索引不是当前有效规格。\n\n' + entries.join('\n')
    if (await safeRead(r.dir, path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }) !== text) await requirementWrite(r.dir, path, text)
  }
  const text = '# 需求资料导航\n\n核心：[context.md](context.md)；当前状态：[state.md](state.md)。详情按任务读取，实施前读取依赖条款。\n\n' + index + '\n'
  if (await safeRead(r.dir, 'INDEX.md').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }) !== text) await requirementWrite(r.dir, 'INDEX.md', text)
  if (!complete) await requirementWrite(r.dir, '.uniagent/projection-revision', snapshot.revision)
}
export async function publishRequirement(r: Requirement, documents: RequirementSnapshot['documents'], operations: RequirementSnapshot['operations'] = {}): Promise<RequirementSnapshot> {
  const stored: RequirementSnapshot['documents'] = {}
  for (const [id, doc] of Object.entries(documents)) {
    const contentHash = doc.content !== undefined ? await digest(doc.content) : doc.contentHash
    if (!contentHash) throw new Error('需求正文引用缺失')
    stored[id] = { ...doc, content: await documentContent(r, doc), contentHash }
  }
  const encoded = await requirementCodec<{ revision: string; text: string }>('pack', { documents: stored, operations })
  const { revision } = encoded
  const snapshot: RequirementSnapshot = { formatVersion: 2, revision, documents: stored, operations }
  const manifest: RequirementManifest | undefined = await safeRead(r.dir, '.uniagent/manifest.json').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  const checkpoints = (manifest?.checkpoints || []).filter(item => item.revision !== revision).slice(-19)
  // One spare slot prevents overwriting any checkpoint referenced by the published manifest.
  const occupied = new Set((manifest?.checkpoints || []).map(item => item.slot))
  const slot = Array.from({ length: 21 }, (_, index) => index).find(index => !occupied.has(index))!
  await requirementWrite(r.dir, `.uniagent/checkpoints/${slot}.json`, encoded.text)
  await requirementWrite(r.dir, '.uniagent/manifest.json', JSON.stringify({ formatVersion: 2, revision, checkpoints: [...checkpoints, { revision, slot }] }))
  // A committed snapshot remains readable even if a display projection cannot be refreshed.
  snapshot.projectionStatus = await projectRequirement(r, snapshot, true).then(() => 'ready' as const, () => 'pending' as const)
  return snapshot
}
function initialDocuments(r: Requirement): RequirementSnapshot['documents'] {
  const doc = (id: 'core' | 'state', title: string, content: string): RequirementDocument => ({ id, kind: id, title, content, summary: '', triggers: [], projectIds: [], dependencies: [], sources: [], status: 'active', freshness: 'needs-review', updatedAt: 0 })
  return { core: doc('core', r.name, '## 背景\n\n## 目标\n\n## 范围与非目标\n\n## 硬约束\n\n## 验收标准'), state: doc('state', '当前进展', '尚未整理。计划、已实现和已验证须分别记录。') }
}
export async function initializeRequirement(r: Requirement): Promise<void> { await publishRequirement(r, initialDocuments(r)) }

async function document(input: RequirementDocumentInput, access: RequirementAccess, propose: boolean, path: string, issues: RequirementValidationIssue[]): Promise<RequirementDocument | undefined> {
  const documentId = validId(input?.id) && !credentials.test(input.id) ? input.id : undefined
  const add = (field: string, code: string, message: string, hint: string): void => { issues.push({ path: path + (field ? '.' + field : ''), documentId, code, message, hint }) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) { add('', 'requirement_invalid_document', '文档必须是对象', '按文档契约填写 id、kind、title 和 content。'); return }
  if (!validId(input.id)) add('id', 'requirement_invalid_document', '文档 ID 无效', '使用 1–80 个字母、数字、下划线或连字符，首字符为字母或数字。')
  if (!Object.hasOwn(folders, input.kind)) add('kind', 'requirement_invalid_document', '文档类型无效', '使用 core、state、spec、decision、knowledge、source、artifact 或 proposal。')
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) add('title', 'requirement_invalid_document', '文档标题为空、类型错误或超过 200 字', '填写 1–200 字的非空标题。')
  if (typeof input.content !== 'string') add('content', 'requirement_invalid_document', '文档正文必须是字符串', '将正文放入 content 字符串。')
  if (['guide', 'sync'].includes(input.id) || (input.kind === 'core' && input.id !== 'core') || (input.kind === 'state' && input.id !== 'state') || (!['core', 'state'].includes(input.kind) && ['core', 'state'].includes(input.id))) add('id', 'requirement_reserved_document_id', '文档 ID 与类型不符或使用了保留 ID', 'core/state 使用同名 ID；其它文档使用独立 ID，不能写 guide/sync。')
  const maxContent = input.kind === 'core' ? 6000 : input.kind === 'state' ? 4000 : 100_000
  if (typeof input.content === 'string' && input.content.length > maxContent) add('content', 'document_content_too_long', '需求内容过长，请按专题拆分；不得裁掉有效约束', `正文最多 ${maxContent} 字；将详细材料拆为专题并保留依赖引用。`)
  if (credentials.test(JSON.stringify(input))) add('', 'credentials_detected', '需求资料疑似包含凭证，请移除敏感值后提交', '检查该文档的正文、引用与链接，移除密钥、token 和密码；诊断不回显敏感值。')
  const status = propose ? 'draft' : input.status === undefined ? 'active' : input.status
  if (!['active', 'draft', 'superseded', 'archived'].includes(status)) add('status', 'requirement_invalid_status', '文档状态无效', '使用 active、draft、superseded 或 archived。')
  if (['core', 'state'].includes(input.kind) && status !== 'active') add('status', 'core_status_invalid', '核心和当前状态不可归档或改为候选，请提交独立提案', '保留 core/state 为 active；候选使用独立 ID 和 proposal 类型。')
  if (input.freshness && !['verified', 'needs-review'].includes(input.freshness)) add('freshness', 'requirement_invalid_freshness', '证据状态无效', '使用 verified 或 needs-review；未完成验证不能填写 verified。')
  if (input.kind === 'proposal' && status === 'active') add('status', 'proposal_not_confirmed', '提案不能直接生效，请以有效规格提交并附用户确认来源', '保留候选为 draft；有真实用户确认后再提交 spec/decision。')
  const strings = (field: 'triggers' | 'projectIds' | 'dependencies'): string[] => {
    const value = input[field] === undefined ? [] : input[field]
    if (!Array.isArray(value) || value.length > 30) { add(field, 'requirement_invalid_metadata', '元数据必须是最多 30 项的字符串数组', '填写字符串数组；无此项时使用 []。'); return [] }
    const valid = value.filter((value, index) => {
      if (typeof value === 'string' && value.trim() && value.length <= 300) return true
      add(`${field}[${index}]`, 'requirement_invalid_metadata', '元数据项必须是 1–300 字的非空字符串', '修正此数组项的类型、空白或长度。'); return false
    })
    return [...new Set(valid)]
  }
  const triggers = strings('triggers'), projectIds = strings('projectIds'), dependencies = strings('dependencies')
  const codeLinks = input.codeLinks, skillLinks = input.skillLinks
  if (codeLinks !== undefined && (!Array.isArray(codeLinks) || codeLinks.length > 30 || codeLinks.some(link => !link || typeof link !== 'object' || Object.keys(link).some(key => !['path','title','directory','projectId','reason'].includes(key)) || !validProjectCodePath(link.path) || typeof link.reason !== 'string' || !link.reason.trim() || link.reason.length > 200 || link.title !== undefined && (typeof link.title !== 'string' || link.title.length > 120) || link.directory !== undefined && (typeof link.directory !== 'string' || link.directory.length > 1000) || link.projectId !== undefined && (typeof link.projectId !== 'string' || !link.projectId || link.projectId.length > 150)))) add('codeLinks', 'invalid_code_links', '代码关联无效', '填写最多 30 个项目相对路径与 reason；跨项目填写 projectId，附加目录填写 directory。')
  if (skillLinks !== undefined && (!Array.isArray(skillLinks) || skillLinks.length > 30 || skillLinks.some(link => !link || typeof link !== 'object' || Object.keys(link).some(key => !['name','path','reason'].includes(key)) || typeof link.name !== 'string' || !link.name.trim() || link.name.length > 120 || typeof link.reason !== 'string' || !link.reason.trim() || link.reason.length > 200 || link.path !== undefined && !validSkillPath(link.path)))) add('skillLinks', 'invalid_skill_links', 'Skill 关联无效', '填写最多 30 个 name 与 reason，可选 SKILL.md 的真实绝对路径；推荐不会自动加载或安装。')
  if (typeof input.summary !== 'undefined' && (typeof input.summary !== 'string' || input.summary.length > 400)) add('summary', 'requirement_invalid_summary', '摘要必须是最多 400 字的字符串', '填写简短字符串摘要，或省略 summary。')
  const rawSources = input.sources === undefined ? [] : input.sources
  const sources: RequirementSource[] = []
  const sourceInputs = Array.isArray(rawSources) && rawSources.length <= 30 ? rawSources : []
  if (!Array.isArray(rawSources) || rawSources.length > 30) add('sources', 'requirement_invalid_sources', '来源必须是最多 30 项的对象数组', '填写 sources 对象数组，使用真实用户/工具事件或稳定资料链接。')
  const sourceError = (field: string, code: string, message: string, hint: string): never => { throw new RequirementValidationError([{ path: field, code, message, hint }]) }
  const results = await Promise.allSettled(sourceInputs.map(async raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sourceError('', 'requirement_invalid_source', '来源必须是对象', '填写 kind 及对应的 sessionId、seq、quote 或 uri。')
    const { observedVersion: _ignored, ...source } = raw
    if (!['user', 'tool', 'agent', 'reference'].includes(source.kind)) return sourceError('kind', 'requirement_invalid_source', '来源类型无效', '使用 user、tool、agent 或 reference。')
    if (source.kind === 'reference') {
      if (typeof source.uri !== 'string' || !/^(?:https?:\/\/|\/|\.\.?\/)/.test(source.uri) || source.uri.length > 3000) return sourceError('uri', 'requirement_invalid_reference', '参考资料地址无效', '使用 http(s) URL、绝对路径或以 ./、../ 开头的相对路径，最多 3000 字。')
      if (/^https?:\/\//.test(source.uri)) {
        let url: URL
        try { url = new URL(source.uri) } catch { return sourceError('uri', 'requirement_invalid_reference', '参考资料 URL 无法解析', '修正 URL 格式后重试。') }
        if (url.username || url.password || [...url.searchParams.keys()].some(key => /^(?:token|access_token|api_key|password)$/i.test(key))) return sourceError('uri', 'reference_credentials_detected', '资料链接包含凭证，请使用不含敏感参数的稳定链接', '移除 URL 中的用户名、密码及 token/api_key 等查询参数。')
      }
      return { source: { ...source, observedVersion: await access.referenceVersion?.(source.uri) }, verified: 'reference' as const }
    }
    if (!access.verifySource) return sourceError('', 'source_verification_unavailable', '需求来源不可验证，请先保存为候选', '在关联需求的会话中引用可读取事件；无法验证时使用 propose 保存独立候选。')
    return { source, verified: await access.verifySource(source) }
  }))
  const verified: string[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') { sources.push(result.value.source); verified.push(result.value.verified); return }
    if (result.reason instanceof RequirementValidationError) for (const issue of result.reason.details.issues) add(`sources[${index}]${issue.path ? '.' + issue.path : ''}`, issue.code, issue.message, issue.hint)
    else add(`sources[${index}]`, 'source_verification_failed', String(result.reason instanceof Error ? result.reason.message : result.reason).replace(new RegExp(credentials.source, 'gi'), '[敏感值已隐藏]').slice(0, 300), '核对来源读取错误；修复后重试，无法验证时保存为独立候选。')
  })
  const sourcesFailed = results.some(result => result.status === 'rejected')
  const memory = input.memory
  if (memory !== undefined) {
    if (!memory || typeof memory !== 'object' || Array.isArray(memory) || Object.keys(memory).some(key => !['type', 'topic', 'basis', 'evidenceScope', 'occurredAt'].includes(key)) ||
      !['intent', 'decision', 'change', 'experience', 'finding', 'question', 'material'].includes(memory.type) ||
      typeof memory.topic !== 'string' || !memory.topic.trim() || memory.topic.length > 80 ||
      !['user', 'tool', 'agent', 'suggestion'].includes(memory.basis) ||
      memory.evidenceScope !== undefined && (typeof memory.evidenceScope !== 'string' || memory.evidenceScope.length > 300) ||
      memory.occurredAt !== undefined && (!Number.isFinite(memory.occurredAt) || memory.occurredAt < 0)) {
      add('memory', 'invalid_memory', 'memory 元数据无效', '使用规范中的类型、主题、来源性质及可选验证范围与真实发生时间。')
    } else if (!sourcesFailed && (memory.basis === 'user' ? !verified.includes('user') : memory.basis === 'tool' ? !verified.includes('tool') : memory.basis === 'agent' ? !sources.some(source => source.kind === 'agent') : false)) {
      add('memory.basis', 'memory_source_mismatch', 'memory 来源性质与真实事件不符', '用户陈述引用 user，工具观察引用 tool，Agent 报告引用 agent；建议使用 suggestion。')
    }
  }
  if (!sourcesFailed && !propose && status !== 'draft' && ['core', 'spec', 'decision'].includes(input.kind) && (!verified.includes('user') || access.background)) add('sources', 'user_evidence_required', '生效需求约定必须引用可核对的用户原文；AI 建议请用 propose 保存', '添加本需求真实用户事件的 sessionId、seq、quote；只有 AI 建议时使用独立 proposal。')
  if (!sourcesFailed && status === 'active' && ['state', 'knowledge', 'source', 'artifact'].includes(input.kind) && !verified.some(v => v === 'user' || v === 'tool')) add('sources', 'fact_evidence_required', '缺少事实来源，请先保存为候选', '添加本需求真实用户或 command_exec 工具证据；reference/agent 不能代替事实来源。')
  if (propose && ['core', 'state'].includes(input.kind)) add('kind', 'proposal_core_rejected', '提案请使用独立 id 和 proposal 类型，不覆盖核心或当前状态', '使用独立 ID 和 proposal 类型保存候选。')
  if (!validId(input.id) || !Object.hasOwn(folders, input.kind)) return
  return { id: input.id, kind: propose && !['source', 'artifact'].includes(input.kind) ? 'proposal' : input.kind, title: typeof input.title === 'string' ? input.title.trim() : '', content: typeof input.content === 'string' ? input.content.trim() : '', summary: typeof input.summary === 'string' ? input.summary.trim() : '', status,
    triggers, projectIds, dependencies, sources, ...(memory ? { memory } : {}), ...(codeLinks ? { codeLinks } : {}), ...(skillLinks ? { skillLinks } : {}),
    freshness: verified.includes('tool') && input.freshness !== 'needs-review' && !sources.some(source => source.kind === 'reference' && !source.observedVersion) ? 'verified' : 'needs-review', ...(input.supersedes ? { supersedes: input.supersedes } : {}), updatedAt: Date.now() }
}

export async function requirementContext(r: Requirement, sessionId: string, request: RequirementContextRequest, access: RequirementAccess = {}): Promise<any> {
  let snapshot = await requirementSnapshot(r)
  if (!snapshot) {
    const original = await safeRead(r.dir, 'context.md')
    const migrationRevision = await digest(original)
    if (request.action !== 'migrate') return { formatVersion: 1, migration: { required: true, migrationRevision, preview: original.split('\n## 日志\n')[0].slice(0, 16000), previewTruncated: original.split('\n## 日志\n')[0].length > 16000, originalPath: r.docPath, notice: '旧格式未修改。请先核对预览和原文，确认后 migrate；旧全文和来源将保留，旧内容只进入候选。' } }
    if (access.readOnly || access.background) throw new Error('需求上下文只读')
    if (request.migrationRevision !== migrationRevision) throw new Error('context_revision_conflict：迁移预览已变化，请重新读取')
    const backup = await safeRead(r.dir, 'archive/context-v1.md').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (backup !== undefined && backup !== original) throw new Error('已有迁移备份与原文不同，请核对，未覆盖备份')
    await requirementWrite(r.dir, 'archive/context-v1.md', original)
    const migrated: RequirementDocument = { id: 'legacy-review', kind: 'proposal', title: '旧需求资料待复核', summary: '旧正文保留为候选，核实后整理为有效约定。', content: '旧需求全文已保存在 archive/context-v1.md。请按专题核实整理，历史日志不是当前有效约定。\n\n' + original.split('\n## 日志\n')[0].slice(0, 16000), status: 'draft', triggers: [], projectIds: [], dependencies: [], sources: [{ kind: 'reference', uri: './archive/context-v1.md' }], freshness: 'needs-review', updatedAt: Date.now() }
    snapshot = await publishRequirement(r, { ...initialDocuments(r), [migrated.id]: migrated })
  }
  const sync = await requirementSync(r)
  let refreshed = false
  const unverifiedReferences: { documentId: string; uri: string }[] = []
  for (const doc of Object.values(snapshot.documents)) {
    if (doc.kind !== 'knowledge' || doc.status !== 'active' || doc.freshness !== 'verified' || access.projectId && doc.projectIds.length && !doc.projectIds.includes(access.projectId)) continue
    for (const source of doc.sources) if (source.observedVersion && source.uri) {
      const version = await access.referenceVersion?.(source.uri)
      if (version === undefined) { unverifiedReferences.push({ documentId: doc.id, uri: source.uri }); continue }
      if (version !== source.observedVersion) { doc.freshness = 'needs-review'; refreshed = true; break }
    }
  }
  if (refreshed) snapshot = await publishRequirement(r, snapshot.documents, snapshot.operations)
  const pending = Object.entries(sync.sessions).filter(([, v]) => v.throughSeq > v.processedSeq).map(([id, value]) => ({ sessionId: id, ...value }))
  const base = { formatVersion: 2, requirement: { id: r.id, name: r.name, status: r.status }, revision: snapshot.revision, unverifiedReferenceCount: unverifiedReferences.length, sync: { status: pending.length || sync.background?.status === 'failed' ? 'pending' : 'synced', pendingCount: pending.length, reason: sync.background?.reason }, migration: { required: false } }
  const detailed = { ...base, requirement: r, dir: r.dir, unverifiedReferences, sync: { ...base.sync, pending, background: sync.background } }
  if (request.action === 'read' && !request.documentId && (request.query !== undefined || request.offset !== undefined || request.limit !== undefined)) {
    const offset = request.offset ?? 0, limit = request.limit ?? 30
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('requirement_invalid_pagination')
    const all = navigation(snapshot, request.query, access.projectId, true)
    return { ...base, documents: all.slice(offset, offset + limit), nextOffset: offset + limit < all.length ? offset + limit : null, total: all.length }
  }
  if (request.action === 'check') {
    const changed = request.expectedRevision !== snapshot.revision
    let previous: RequirementSnapshot | undefined
    if (changed && /^[a-f0-9]{64}$/.test(request.expectedRevision || '')) previous = await readRevision(r, request.expectedRevision!).catch(() => undefined)
    const changedDocuments = changed ? Object.keys(snapshot.documents).filter(id => JSON.stringify(snapshot.documents[id]) !== JSON.stringify(previous?.documents[id])) : []
    const reading = await readRequirementReading(r).catch(() => undefined)
    const readingStale = reading?.version !== 3 || reading.sourceRevision !== snapshot.revision || reading.taskRevision !== (await readingTasks(r)).revision
    return { ...base, changed, changedDocuments: changedDocuments.slice(0, 30), moreChanges: changedDocuments.length > 30, changes: changed ? requirementChanges(snapshot.documents, previous?.documents) : requirementChanges(snapshot.documents, snapshot.documents), readingStale }
  }
  if (request.action === 'bootstrap' || request.action === 'read' && !request.documentId || request.action === 'migrate') {
    const topics = navigation(snapshot, request.query, access.projectId)
    const unresolved = Object.values(snapshot.documents).filter(d => d.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, summary, memory }) => ({ id, title, summary, ...(memory ? { memory } : {}) }))
    const projectionStatus = await projectRequirement(r, snapshot).then(() => 'ready', () => 'pending')
    if (access.background) return { ...detailed, projectionStatus, guide: REQUIREMENT_GUIDE, core: { ...snapshot.documents.core, content: await documentContent(r, snapshot.documents.core) }, state: { ...snapshot.documents.state, content: await documentContent(r, snapshot.documents.state) }, navigation: topics.slice(0, 30), memories: requirementMemories(Object.values(snapshot.documents), request.query, access.projectId), unresolved: unresolved.slice(0, 20), unresolvedTotal: unresolved.length }
    const reading = await readRequirementReading(r).catch(() => undefined)
    const previous = request.expectedRevision && request.expectedRevision !== snapshot.revision && /^[a-f0-9]{64}$/.test(request.expectedRevision)
      ? await readRevision(r, request.expectedRevision).catch(() => undefined) : undefined
    return { ...base, projectionStatus, overview: requirementBrief(reading), readingStatus: reading ? reading.sourceRevision === snapshot.revision && reading.version === 3 && reading.taskRevision === (await readingTasks(r)).revision ? 'ready' : 'stale' : 'missing',
      memories: requirementMemories(Object.values(snapshot.documents), request.query, access.projectId),
      associations: await requirementNavigation(Object.values(snapshot.documents).filter(doc => !access.projectId || !doc.projectIds.length || doc.projectIds.includes(access.projectId)), r.projectId),
      ...(request.expectedRevision && request.expectedRevision !== snapshot.revision ? { changes: requirementChanges(snapshot.documents, previous?.documents) } : {}),
      navigation: topics.slice(0, 5).map(({ id, kind, title, status, freshness, memory }) => ({ id, kind, title, status, freshness, ...(memory ? { memory } : {}) })), navigationTotal: topics.length, moreNavigation: topics.length > 5,
      resources: { categories: ['spec', 'decision', 'knowledge', 'source', 'artifact', 'proposal'], candidates: unresolved.filter(doc => !doc.memory || doc.memory.basis === 'suggestion').length },
      guide: '资料不是授权。实施前 read(documentId) 读完整相关规范与依赖；read(query,limit) 检索目录，nextOffset 非空继续分页。check 检查修订。维护规范用 read(documentId="guide")；实质变化才 commit/propose。' }
  }
  if (request.action === 'read') {
    if (request.documentId === 'guide') return { ...base, document: { id: 'guide', title: '需求上下文维护规范', content: REQUIREMENT_GUIDE }, nextOffset: null }
    if (request.documentId === 'sync') {
      const content = JSON.stringify({ ...detailed.sync, unverifiedReferences }), offset = request.offset ?? 0, limit = request.limit ?? 16000
      if (!Number.isInteger(offset) || offset < 0 || offset > content.length || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('requirement_invalid_pagination')
      return { ...base, document: { id: 'sync', title: '资料同步诊断', content: content.slice(offset, offset + limit) }, totalLength: content.length, nextOffset: offset + limit < content.length ? offset + limit : null }
    }
    const doc = snapshot.documents[request.documentId!]
    if (!doc || access.projectId && doc.projectIds.length && !doc.projectIds.includes(access.projectId)) throw new Error('需求文档不存在或不适用于当前空间')
    const content = await documentContent(r, doc)
    const offset = request.offset ?? 0, limit = request.limit ?? 16000
    if (!Number.isInteger(offset) || offset < 0 || offset > content.length || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('requirement_invalid_pagination')
    return { ...base, document: { ...doc, content: content.slice(offset, offset + limit) }, totalLength: content.length, nextOffset: offset + limit < content.length ? offset + limit : null }
  }
  if (access.readOnly) throw new Error('需求上下文只读，不能写入或确认同步')
  if (request.action === 'acknowledge') {
    const cursor = sync.sessions[sessionId]
    if (!cursor || !Number.isInteger(request.throughSeq) || request.throughSeq! > cursor.throughSeq || request.throughSeq! < cursor.processedSeq) throw new Error('requirement_invalid_cursor')
    if (request.throughSeq! > cursor.completedSeq) throw new Error('本轮仍未结束，请只确认 completedSeq 以内的稳定增量')
    if (request.expectedRevision !== snapshot.revision) throw new Error('context_revision_conflict：确认前请重读最新版本')
    const offset = request.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0 || request.throughSeq === cursor.processedSeq && offset < (cursor.processedOffset || 0)) throw new Error('requirement_invalid_cursor')
    if (!access.readThrough || request.throughSeq! > access.readThrough.throughSeq || request.throughSeq === access.readThrough.throughSeq && offset > access.readThrough.offset) throw new Error('不能确认未读取的增量，请先 pending 并完成分页')
    cursor.processedSeq = request.throughSeq!; cursor.processedOffset = offset
    cursor.status = cursor.processedSeq === cursor.throughSeq && !offset ? 'synced' : 'pending'
    await saveRequirementSync(r, sync)
    return { ok: true, revision: snapshot.revision }
  }
  if (!['commit', 'propose'].includes(request.action)) throw new Error('不支持的需求上下文操作')
  if (access.background && request.action !== 'propose') throw new Error('后台整理只能保存候选，不能直接生效')
  if (!validId(request.operationId)) throw new Error('requirement_operation_id_required')
  const fingerprint = await digest({ documents: request.documents, action: request.action })
  const previous = snapshot.operations[request.operationId]
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error('requirement_operation_id_reused')
    return { ok: true, revision: snapshot.revision, committedRevision: previous.revision, duplicate: true }
  }
  if (request.expectedRevision !== snapshot.revision) throw new Error('context_revision_conflict：请重新读取最新版本后合并')
  if (!Array.isArray(request.documents) || request.documents.length > 20) throw new RequirementValidationError([{ path: 'documents', code: 'requirement_invalid_documents', message: '文档批次必须是最多 20 项的数组', hint: '填写 documents 数组；超过 20 篇时分批提交，每批写前检查 revision。' }])
  const issues: RequirementValidationIssue[] = []
  const paths = new Map<string, string>()
  const seen = new Set<string>()
  const documents = { ...snapshot.documents }
  for (const [index, input] of request.documents.entries()) {
    const path = `documents[${index}]`
    if (validId(input?.id)) {
      if (seen.has(input.id)) issues.push({ path: path + '.id', code: 'duplicate_document_id', message: 'requirement_invalid_documents：文档 ID 在本批次重复', hint: '将同一文档的修改合并为一项，保留唯一 ID。' })
      seen.add(input.id); paths.set(input.id, path)
    }
    const previous = input && Object.hasOwn(documents, input.id) ? documents[input.id] : undefined
    const body = await document(previous ? { ...previous, ...input, freshness: input.freshness, sources: input.sources } as RequirementDocumentInput : input, access, request.action === 'propose', path, issues)
    if (!body) continue
    const add = (field: string, code: string, message: string, hint: string): void => { issues.push({ path: path + '.' + field, documentId: credentials.test(body.id) ? undefined : body.id, code, message, hint }) }
    const { content, ...metadata } = body
    const next: StoredDocument = { ...metadata, contentHash: await digest(content) }
    if (['core', 'state'].includes(next.kind) && next.projectIds.length) add('projectIds', 'core_scope_invalid', '核心和全局状态不能只属于单个空间，局部事实请存专题', '将 core/state 的 projectIds 清空；空间内事实使用独立专题。')
    const old = Object.hasOwn(documents, next.id) ? documents[next.id] : undefined
    if (old?.sources.some(source => source.kind === 'user') && (old.codeLinks?.length || old.skillLinks?.length)) {
      const changed = JSON.stringify([old.codeLinks,old.skillLinks]) !== JSON.stringify([next.codeLinks,next.skillLinks]) || next.status === 'active' && ['superseded','archived'].includes(old.status)
      const confirmation = next.sources.some(source => source.kind === 'user' && !old.sources.some(previous => previous.kind === 'user' && previous.sessionId === source.sessionId && previous.seq === source.seq))
      if (changed && !confirmation) add('codeLinks', 'navigation_confirmation_required', '修改或恢复用户指定的关联需要新的用户确认来源', '保留原代码与 Skills 关联，分析建议保存为独立提案；用户已明确变更时引用新的真实用户事件。')
    }
    if (old && old.kind !== next.kind) add('kind', 'document_kind_changed', '文档类型不可更改，请创建新文档并建立替代关系', '保留原文档类型；新类型使用新 ID，合法替代使用 supersedes。')
    if (old?.status === 'active' && next.status === 'draft' && ['core', 'spec', 'decision'].includes(next.kind)) add('status', 'active_rule_demoted', '不能将有效约定改为候选；建议请创建独立提案', '保留有效约定；候选使用独立 ID 和 proposal 类型。')
    if (next.supersedes) {
      const superseded = Object.hasOwn(documents, next.supersedes) ? documents[next.supersedes] : undefined
      const memoryChange = next.status === 'draft' && next.memory?.basis === 'user' && ['decision', 'change'].includes(next.memory.type) &&
        next.sources.some(source => source.kind === 'user') && superseded?.status === 'draft' && superseded.memory?.basis === 'user' &&
        ['intent', 'decision', 'change'].includes(superseded.memory.type) && superseded.memory.topic === next.memory.topic &&
        JSON.stringify([...superseded.projectIds].sort()) === JSON.stringify([...next.projectIds].sort())
      if (!superseded || superseded.kind !== next.kind || ['core', 'state'].includes(superseded.kind) || next.id === next.supersedes || next.status !== 'active' && !memoryChange) add('supersedes', 'requirement_invalid_supersedes', '替代关系无效', '引用同类型旧文档；有效决定须 active，或由真实用户变更同主题、同范围的 draft 用户记忆，不能替代自身或 core/state。')
      else documents[superseded.id] = { ...superseded, status: 'superseded' }
    }
    if (old) next.updatedAt = old.updatedAt
    const oldMetadata = old && Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'content'))
    if (JSON.stringify(next) !== JSON.stringify(oldMetadata)) next.updatedAt = Date.now()
    documents[next.id] = { ...next, content }
  }
  if (Object.values(documents).filter(doc => doc.status === 'active' && ['spec', 'decision', 'knowledge'].includes(doc.kind)).length > 500) issues.push({ path: 'documents', code: 'document_limit_exceeded', message: '有效主题过多，请合并相关主题', hint: '最多 500 篇有效主题；任务、候选和资料索引不占用主题配额。' })
  const dependencyIssue = (doc: StoredDocument, index: number, code: string, message: string, hint: string): void => {
    issues.push({ path: `${paths.get(doc.id) || `storedDocuments[${JSON.stringify(doc.id)}]`}.dependencies[${index}]`, documentId: credentials.test(doc.id) ? undefined : doc.id, code, message, hint })
  }
  for (const doc of Object.values(documents)) for (const [index, id] of doc.dependencies.entries()) if (!Object.hasOwn(documents, id) || doc.status === 'active' && documents[id].status !== 'active') dependencyIssue(doc, index, 'dependency_unavailable', '有效规格存在缺失或失效依赖', '读取并核对依赖 ID 与状态；将正确依赖的创建或更新加入同一批次。')
  const visiting = new Set<string>(), visited = new Set<string>()
  const stack: string[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    visiting.add(id); stack.push(id)
    for (const [index, dependency] of documents[id].dependencies.entries()) {
      if (visiting.has(dependency)) dependencyIssue(documents[id], index, 'dependency_cycle', '需求专题存在循环依赖', '解除此依赖边形成的循环：' + [...stack.slice(stack.indexOf(dependency)), dependency].map(value => credentials.test(value) ? '[敏感 ID 已隐藏]' : value).join(' → '))
      else if (Object.hasOwn(documents, dependency)) visit(dependency)
    }
    stack.pop(); visiting.delete(id); visited.add(id)
  }
  for (const id of Object.keys(documents)) visit(id)
  if (issues.length) throw new RequirementValidationError(issues)
  const normalized = Object.fromEntries(Object.entries(documents).map(([id, doc]) => { const { content, ...metadata } = doc; return [id, metadata] }))
  if (await digest(normalized) === snapshot.revision) return { ok: true, revision: snapshot.revision, unchanged: true }
  const revision = await digest(normalized)
  const operations = { ...snapshot.operations, [request.operationId]: { fingerprint, revision } }
  const next = await publishRequirement(r, documents, operations)
  return { ok: true, revision: next.revision, projectionStatus: next.projectionStatus }
}
