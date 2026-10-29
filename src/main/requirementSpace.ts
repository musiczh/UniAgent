import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Requirement, RequirementContextRequest, RequirementDocument, RequirementDocumentInput, RequirementDocumentKind, RequirementSource } from '../shared/requirementTypes'
import { REQUIREMENT_GUIDE } from './requirementGuide'
import { requirementCodec } from './requirementCodec'

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

async function safeRead(root: string, relative: string): Promise<string> {
  let path = root
  for (const part of ['', ...relative.split('/')]) {
    if (part) path = join(path, part)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('requirement_symlink_rejected')
  }
  return readFile(path, 'utf8')
}
export async function requirementSnapshot(r: Requirement): Promise<RequirementSnapshot | undefined> {
  let manifest: { formatVersion: number; revision: string }
  try { manifest = JSON.parse(await safeRead(r.dir, '.uniagent/manifest.json')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (manifest.formatVersion !== 2 || !/^[a-f0-9]{64}$/.test(manifest.revision)) throw new Error('需求登记损坏，请恢复 manifest.json')
  return requirementCodec<RequirementSnapshot>('decode', { text: await safeRead(r.dir, `.uniagent/revisions/${manifest.revision}.json`), revision: manifest.revision })
}
async function documentContent(r: Requirement, doc: StoredDocument): Promise<string> {
  if (doc.content !== undefined) return doc.content
  if (!doc.contentHash || !/^[a-f0-9]{64}$/.test(doc.contentHash)) throw new Error('需求正文引用损坏')
  const content = await safeRead(r.dir, `.uniagent/bodies/${doc.contentHash}.md`)
  if (await digest(content) !== doc.contentHash) throw new Error('需求正文校验失败，未使用损坏资料')
  return content
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
  return doc.status === 'active' && (!projectId || !doc.projectIds.length || doc.projectIds.includes(projectId))
}
function navigation(snapshot: RequirementSnapshot, query = '', projectId?: string) {
  const all = Object.values(snapshot.documents).filter(doc => !['core', 'state'].includes(doc.kind) && visible(doc, projectId))
  const terms = query.toLocaleLowerCase()
  const matched = all.filter(doc => terms && [doc.id, doc.title, ...doc.triggers].some(term => term && terms.includes(term.toLocaleLowerCase())))
  const selected = matched.length ? matched : all
  const included = new Set(selected.map(doc => doc.id))
  for (const doc of selected) for (const id of doc.dependencies) included.add(id)
  return all.filter(doc => included.has(doc.id)).map(({ id, kind, title, summary, projectIds, dependencies, freshness }) => ({ id, kind, title, summary, projectIds, dependencies, freshness }))
}
export async function projectRequirement(r: Requirement, snapshot: RequirementSnapshot, full = false): Promise<void> {
  const index = navigation(snapshot).map(doc => `- [${doc.title}](${requirementDocumentPath(snapshot.documents[doc.id])})：${doc.summary}；状态：${doc.freshness}；范围：${doc.projectIds.join('、') || '共享'}；依赖：${doc.dependencies.join('、') || '无'}`).join('\n')
  const complete = await safeRead(r.dir, '.uniagent/projection-revision').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }) === snapshot.revision
  for (const doc of Object.values(snapshot.documents)) {
    if (!full && complete && !['core', 'state'].includes(doc.kind)) continue
    const text = `# ${doc.title}\n\n> 需求状态：${{ active: '进行中', done: '已完成', archived: '已归档' }[r.status]}；文档：${doc.id}；${doc.status}；${doc.freshness}\n\n${await documentContent(r, doc)}\n`
    const path = requirementDocumentPath(doc)
    if (await safeRead(r.dir, path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }) !== text) await requirementWrite(r.dir, path, text)
  }
  const text = '# 需求资料导航\n\n核心：[context.md](context.md)；当前状态：[state.md](state.md)。详情按任务读取，实施前读取依赖条款。\n\n' + index + '\n'
  if (await safeRead(r.dir, 'INDEX.md').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }) !== text) await requirementWrite(r.dir, 'INDEX.md', text)
  await requirementWrite(r.dir, '.uniagent/projection-revision', snapshot.revision)
}
export async function publishRequirement(r: Requirement, documents: RequirementSnapshot['documents'], operations: RequirementSnapshot['operations'] = {}): Promise<RequirementSnapshot> {
  const stored: RequirementSnapshot['documents'] = {}
  for (const [id, doc] of Object.entries(documents)) {
    const contentHash = doc.content !== undefined ? await digest(doc.content) : doc.contentHash
    if (!contentHash) throw new Error('需求正文引用缺失')
    if (doc.content !== undefined) {
      const path = `.uniagent/bodies/${contentHash}.md`
      const previous = await safeRead(r.dir, path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (previous !== undefined && previous !== doc.content) throw new Error('需求正文存储已损坏，未覆盖证据')
      if (previous === undefined) await requirementWrite(r.dir, path, doc.content)
    }
    const { content: _content, ...metadata } = doc
    stored[id] = { ...metadata, contentHash }
  }
  const encoded = await requirementCodec<{ revision: string; text: string }>('encode', { documents: stored, operations })
  const { revision } = encoded
  const snapshot: RequirementSnapshot = { formatVersion: 2, revision, documents: stored, operations }
  await requirementWrite(r.dir, `.uniagent/revisions/${revision}.json`, encoded.text)
  await requirementWrite(r.dir, '.uniagent/manifest.json', JSON.stringify({ formatVersion: 2, revision }))
  // A committed snapshot remains readable even if a display projection cannot be refreshed.
  snapshot.projectionStatus = await projectRequirement(r, snapshot, true).then(() => 'ready' as const, () => 'pending' as const)
  return snapshot
}
function initialDocuments(r: Requirement): RequirementSnapshot['documents'] {
  const doc = (id: 'core' | 'state', title: string, content: string): RequirementDocument => ({ id, kind: id, title, content, summary: '', triggers: [], projectIds: [], dependencies: [], sources: [], status: 'active', freshness: 'needs-review', updatedAt: 0 })
  return { core: doc('core', r.name, '## 背景\n\n## 目标\n\n## 范围与非目标\n\n## 硬约束\n\n## 验收标准'), state: doc('state', '当前进展', '尚未整理。计划、已实现和已验证须分别记录。') }
}
export async function initializeRequirement(r: Requirement): Promise<void> { await publishRequirement(r, initialDocuments(r)) }

function strings(value: unknown, max = 30): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 300)) throw new Error('requirement_invalid_metadata')
  return [...new Set(value)]
}
async function document(input: RequirementDocumentInput, access: RequirementAccess, propose: boolean): Promise<RequirementDocument> {
  if (!input || !validId(input.id) || !Object.hasOwn(folders, input.kind) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || typeof input.content !== 'string') throw new Error('requirement_invalid_document')
  if ((input.kind === 'core' && input.id !== 'core') || (input.kind === 'state' && input.id !== 'state') || (!['core', 'state'].includes(input.kind) && ['core', 'state'].includes(input.id))) throw new Error('requirement_reserved_document_id')
  if (input.content.length > (input.kind === 'core' ? 6000 : input.kind === 'state' ? 4000 : 100_000)) throw new Error('需求内容过长，请按专题拆分；不得裁掉有效约束')
  if (/\bBearer\s+[A-Za-z0-9._~+\/-]{20,}|\bsk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|密码)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{8,}/i.test(JSON.stringify(input))) throw new Error('需求资料疑似包含凭证，请移除敏感值后提交')
  const status = propose ? 'draft' : input.status === undefined ? 'active' : input.status
  if (!['active', 'draft', 'superseded', 'archived'].includes(status)) throw new Error('requirement_invalid_status')
  if (['core', 'state'].includes(input.kind) && status !== 'active') throw new Error('核心和当前状态不可归档或改为候选，请提交独立提案')
  if (input.freshness && !['verified', 'needs-review'].includes(input.freshness)) throw new Error('requirement_invalid_freshness')
  if (input.kind === 'proposal' && status === 'active') throw new Error('提案不能直接生效，请以有效规格提交并附用户确认来源')
  const rawSources = input.sources === undefined ? [] : input.sources
  if (!Array.isArray(rawSources) || rawSources.length > 30 || rawSources.some(source => !source || typeof source !== 'object')) throw new Error('requirement_invalid_sources')
  const sources = rawSources.map(({ observedVersion: _ignored, ...source }) => source) as RequirementSource[]
  const verified = await Promise.all(sources.map(async source => {
    if (!source || !['user', 'tool', 'agent', 'reference'].includes(source.kind)) throw new Error('requirement_invalid_source')
    if (source.kind === 'reference') {
      if (typeof source.uri !== 'string' || !/^(?:https?:\/\/|\/|\.\.?\/)/.test(source.uri) || source.uri.length > 3000) throw new Error('requirement_invalid_reference')
      if (/^https?:\/\//.test(source.uri)) {
        const url = new URL(source.uri)
        if (url.username || url.password || [...url.searchParams.keys()].some(key => /^(?:token|access_token|api_key|password)$/i.test(key))) throw new Error('资料链接包含凭证，请使用不含敏感参数的稳定链接')
      }
      source.observedVersion = await access.referenceVersion?.(source.uri)
      return 'reference'
    }
    if (!access.verifySource) throw new Error('需求来源不可验证，请先保存为候选')
    return access.verifySource(source)
  }))
  if (!propose && status !== 'draft' && ['core', 'spec', 'decision'].includes(input.kind) && (!verified.includes('user') || access.background)) throw new Error('生效需求约定必须引用可核对的用户原文；AI 建议请用 propose 保存')
  if (status === 'active' && ['state', 'knowledge', 'source', 'artifact'].includes(input.kind) && !verified.some(v => v === 'user' || v === 'tool')) throw new Error('缺少事实来源，请先保存为候选')
  if (propose && ['core', 'state'].includes(input.kind)) throw new Error('提案请使用独立 id 和 proposal 类型，不覆盖核心或当前状态')
  if (typeof input.summary !== 'undefined' && (typeof input.summary !== 'string' || input.summary.length > 400)) throw new Error('requirement_invalid_summary')
  return { id: input.id, kind: propose ? 'proposal' : input.kind, title: input.title.trim(), content: input.content.trim(), summary: input.summary?.trim() || '', status,
    triggers: strings(input.triggers === undefined ? [] : input.triggers), projectIds: strings(input.projectIds === undefined ? [] : input.projectIds), dependencies: strings(input.dependencies === undefined ? [] : input.dependencies), sources,
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
  const base = { formatVersion: 2, requirement: r, dir: r.dir, revision: snapshot.revision, unverifiedReferences, sync: { status: pending.length || sync.background?.status === 'failed' ? 'pending' : 'synced', pending, background: sync.background }, migration: { required: false } }
  if (request.action === 'read' && !request.documentId && (request.offset !== undefined || request.limit !== undefined)) {
    const offset = request.offset ?? 0, limit = request.limit ?? 30
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('requirement_invalid_pagination')
    const all = Object.values(snapshot.documents).filter(doc => !access.projectId || !doc.projectIds.length || doc.projectIds.includes(access.projectId))
    return { ...base, documents: all.slice(offset, offset + limit).map(({ content, ...metadata }) => metadata), nextOffset: offset + limit < all.length ? offset + limit : null, total: all.length }
  }
  if (request.action === 'check') return { ...base, changed: request.expectedRevision !== snapshot.revision }
  if (request.action === 'bootstrap' || request.action === 'read' && !request.documentId || request.action === 'migrate') {
    const topics = navigation(snapshot, request.query, access.projectId)
    const unresolved = Object.values(snapshot.documents).filter(d => d.status === 'draft').map(({ id, title, summary }) => ({ id, title, summary }))
    const projectionStatus = await projectRequirement(r, snapshot).then(() => 'ready', () => 'pending')
    return { ...base, projectionStatus, guide: REQUIREMENT_GUIDE, core: { ...snapshot.documents.core, content: await documentContent(r, snapshot.documents.core) }, state: { ...snapshot.documents.state, content: await documentContent(r, snapshot.documents.state) }, navigation: topics.slice(0, 30), navigationTotal: topics.length, moreNavigation: topics.length > 30, unresolved: unresolved.slice(0, 20), unresolvedTotal: unresolved.length }
  }
  if (request.action === 'read') {
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
  if (!Array.isArray(request.documents) || request.documents.length > 20 || new Set(request.documents.map(d => d.id)).size !== request.documents.length) throw new Error('requirement_invalid_documents')
  const documents = { ...snapshot.documents }
  for (const input of request.documents) {
    const previous = input && documents[input.id]
    const body = await document(previous ? { ...previous, ...input, freshness: input.freshness, sources: input.sources } as RequirementDocumentInput : input, access, request.action === 'propose')
    const { content, ...metadata } = body
    const next: StoredDocument = { ...metadata, contentHash: await digest(content) }
    if (['core', 'state'].includes(next.kind) && next.projectIds.length) throw new Error('核心和全局状态不能只属于单个空间，局部事实请存专题')
    const old = documents[next.id]
    if (old && old.kind !== next.kind) throw new Error('文档类型不可更改，请创建新文档并建立替代关系')
    if (old?.status === 'active' && next.status === 'draft' && ['core', 'spec', 'decision'].includes(next.kind)) throw new Error('不能将有效约定改为候选；建议请创建独立提案')
    if (next.supersedes) {
      const superseded = documents[next.supersedes]
      if (!superseded || superseded.kind !== next.kind || ['core', 'state'].includes(superseded.kind) || next.id === next.supersedes || next.status !== 'active') throw new Error('requirement_invalid_supersedes')
      documents[superseded.id] = { ...superseded, status: 'superseded' }
    }
    if (old) next.updatedAt = old.updatedAt
    if (JSON.stringify(next) !== JSON.stringify(old)) next.updatedAt = Date.now()
    documents[next.id] = { ...next, content }
  }
  if (Object.keys(documents).length > 500) throw new Error('需求专题过多，请先整理归档')
  for (const doc of Object.values(documents)) for (const id of doc.dependencies) if (!documents[id] || doc.status === 'active' && documents[id].status !== 'active') throw new Error('有效规格存在缺失或失效依赖：' + id)
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('需求专题存在循环依赖')
    if (visited.has(id)) return
    visiting.add(id); for (const dependency of documents[id].dependencies) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const id of Object.keys(documents)) visit(id)
  const normalized = Object.fromEntries(Object.entries(documents).map(([id, doc]) => { const { content, ...metadata } = doc; return [id, metadata] }))
  if (await digest(normalized) === snapshot.revision) return { ok: true, revision: snapshot.revision, unchanged: true }
  const revision = await digest(normalized)
  const operations = { ...snapshot.operations, [request.operationId]: { fingerprint, revision } }
  const next = await publishRequirement(r, documents, operations)
  return { ok: true, revision: next.revision, projectionStatus: next.projectionStatus }
}
