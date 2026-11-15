import Database from 'better-sqlite3'
import { mkdirSync, chmodSync, constants } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { realpath, readFile, stat, access } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { taskRequestFingerprint } from '../../shared/taskRequest'
import { compareRouterQueue, routerInputId, routerObjectScope, routerScanFor, routerScopeKey, routerMemoryScopeKey, type GlobalMemoryItem, type RouterConfig, type RouterInput, type RouterObject, type RouterRequest, type RouterScope } from '../../shared/router'
import { assertRouterScope, RouterToolError } from './errors'
import { RouterReviewStore } from './reviewStore'
import type { RouterFeedbackInput, RouterReviewQuery, RouterTrace, RouterReviewDeletionItem } from '../../shared/routerReview'
import { sanitizeRouterReview } from '../../shared/routerReview'
import { loadRouterTokenizer, type RouterTokenizer } from './tokenizer'
import type { RouterConversationSession } from '../../shared/router'
import { validProjectCodePath, type ProjectCodeLink, type ProjectMemoryMetadata } from '../../shared/projectMemory'
import type { PickedFile, Project } from '../../shared/types'

interface ReadingSnapshot { id: string; requestId: string; key: string; asOf: number; items: RouterObject[]; readThrough: number; cursors: Record<string, number> }

const decode = <T>(row: unknown): T => JSON.parse((row as { data: string }).data)
function requestTiming(previous: RouterRequest, next: RouterRequest, now: number): RouterRequest['timing'] {
  if (next.state === 'queued' && ['needs_input', 'failed', 'cancelled'].includes(previous.state) && !next.autoRecovery?.nextAt) return { queuedAt: now, elapsedMs: 0 }
  if (!previous.timing) return undefined
  const timing = { ...previous.timing }
  const running = next.state === 'routing' || next.state === 'committing' || timing.startedAt !== undefined && !!next.autoRecovery?.nextAt && (next.state === 'queued' || next.delivery === 'unknown')
  if (running && timing.runningSince === undefined) {
    timing.startedAt ??= now
    timing.runningSince = now
    delete timing.stoppedAt
  } else if (!running && timing.runningSince !== undefined) {
    timing.elapsedMs += Math.max(0, now - timing.runningSince)
    timing.stoppedAt = now
    delete timing.runningSince
  } else if (!running && next.state !== 'queued') timing.stoppedAt ??= now
  return timing
}
export class RouterDatabase {
  private db: Database.Database
  private reviews: RouterReviewStore
  constructor(path: string, private tokenizerDirectory?: string, private now = () => Date.now()) {
    this.reviews = new RouterReviewStore(dirname(path))
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path)
    if (Number(this.db.pragma('user_version', { simple: true })) > 1) { this.db.close(); throw new Error('router_schema_newer_than_app') }
    chmodSync(path, 0o600)
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 3000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS router_meta (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS router_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS router_objects (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS router_objects_fts USING fts5(tokens, object_id UNINDEXED);
      CREATE TABLE IF NOT EXISTS global_memory (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS global_memory_revisions (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS global_memory_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version = 1;
    `)
  }
  draftImages(action: 'read' | 'save' | 'append' | 'submitted', images: PickedFile[] = []): PickedFile[] | void {
    if (!['read','save','append','submitted'].includes(action)) throw new Error('invalid_router_draft_action')
    if (action !== 'read' && (!Array.isArray(images) || images.some(image => !image || image.kind !== 'image' ||
      typeof image.path !== 'string' || !isAbsolute(image.path) || typeof image.name !== 'string' || !image.name ||
      image.mime !== undefined && typeof image.mime !== 'string' ||
      image.previewDataUrl !== undefined && (typeof image.previewDataUrl !== 'string' || !image.previewDataUrl.startsWith('data:image/'))))) throw new Error('invalid_router_draft_images')
    const read = (): PickedFile[] => {
      const row = this.db.prepare('SELECT value FROM router_meta WHERE id=?').get('draft-images') as { value: string } | undefined
      return row ? JSON.parse(row.value) : []
    }
    if (action === 'read') return read()
    const values = images.map(({kind,path,name,mime,previewDataUrl}) => ({kind,path,name,...(mime?{mime}:{}),...(previewDataUrl?{previewDataUrl}:{})}))
    const next = action === 'save' ? values : action === 'append' ? [...read(),...values]
      : read().filter(image => !images.some(submitted => submitted.path === image.path))
    this.db.prepare('INSERT INTO router_meta (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run('draft-images',JSON.stringify(next))
  }
  sessionId(): string {
    const row = this.db.prepare('SELECT value FROM router_meta WHERE id=?').get('session') as { value: string } | undefined
    if (row) return row.value
    const id = 's_' + randomUUID()
    this.db.prepare('INSERT INTO router_meta VALUES (?,?)').run('session', id)
    return id
  }
  sessionNotice(): { sessionId: string; kind: 'manual' | 'recovery' } | undefined {
    const row = this.db.prepare('SELECT value FROM router_meta WHERE id=?').get('session-notice') as { value: string } | undefined
    return row ? JSON.parse(row.value) : undefined
  }
  conversationSessions(): RouterConversationSession[] {
    const row = this.db.prepare('SELECT value FROM router_meta WHERE id=?').get('conversation-sessions') as { value: string } | undefined
    return row ? JSON.parse(row.value) : []
  }
  replaceSession(expectedId: string, id: string, retry?: { requestId: string; version: number }, agentSwitch?: { fromAgentId: string; toAgentId: string; switchedAt: number }): void {
    this.db.transaction(() => {
      if (this.sessionId() !== expectedId) throw new Error('Router 会话已变化，请刷新后重试')
      if (retry) {
        const request = this.request(retry.requestId)
        if (!request || request.version !== retry.version || request.state !== 'routing' || request.routerSessionId !== expectedId ||
            request.delivery !== 'pending' || request.decision || request.targetId || request.recovery?.attempts || (request.autoRecovery?.attempts || 0) >= 2) throw new Error('router_revision_conflict')
        this.update(request.requestId, request.version, { state: 'queued', routerSessionId: id, context: undefined, error: undefined, failure: undefined,
          recovery: { attempts: 1, previousSessionId: expectedId },
          autoRecovery: { attempts: (request.autoRecovery?.attempts || 0) + 1, total: (request.autoRecovery?.total || 0) + 1,
            phase: 'routing', reason: '连接暂时中断，正在自动创建新会话继续分配', nextAt: Date.now() + (request.autoRecovery?.attempts ? 8000 : 2000) } })
      } else {
        for (const request of this.reviewRequests()) {
          if (request.routerSessionId === expectedId && request.state === 'failed' && request.failure?.sessionId === expectedId &&
              request.failure.code === 'connection-lost-reopen-session' && request.delivery === 'pending' && !request.decision && !request.targetId) {
            this.update(request.requestId, request.version, { state: 'queued', routerSessionId: id, context: undefined, error: undefined, failure: undefined })
          }
        }
      }
      this.db.prepare('UPDATE router_meta SET value=? WHERE id=?').run(id, 'session')
      const history = agentSwitch ? this.conversationSessions() : []
      if (agentSwitch) {
        if (history.at(-1)?.sessionId !== expectedId) history.push({ sessionId: expectedId, agentId: agentSwitch.fromAgentId })
        history.push({ sessionId: id, agentId: agentSwitch.toAgentId, switchedAt: agentSwitch.switchedAt })
      }
      this.db.prepare('INSERT OR REPLACE INTO router_meta VALUES (?,?)').run('conversation-sessions', JSON.stringify(history))
      this.db.prepare('INSERT OR REPLACE INTO router_meta VALUES (?,?)').run('session-notice', JSON.stringify({ sessionId: id, kind: retry ? 'recovery' : 'manual' }))
    })()
  }
  request(id: string): RouterRequest | undefined {
    routerInputId(id)
    const row = this.db.prepare('SELECT data FROM router_requests WHERE id=?').get(id)
    return row ? decode(row) : undefined
  }
  replaceFeishuCard(id: string, expectedCardId: string, cardMessageId: string): RouterRequest {
    if (!cardMessageId || cardMessageId.length > 200) throw new Error('invalid_router_card')
    return this.db.transaction(() => {
      const request = this.request(id)
      if (!request?.feishu) throw new Error('router_source_missing')
      if (request.feishu.cardMessageId !== expectedCardId) return request
      const next = { ...request, feishu: { ...request.feishu, cardMessageId } }
      // The card ID is transport metadata; changing it must not invalidate an
      // allocation currently crossing the beforeDispatch display barrier.
      this.db.prepare('UPDATE router_requests SET data=? WHERE id=? AND version=?').run(JSON.stringify(next), id, request.version)
      return next
    })()
  }
  private nextQueuedAt(): number {
    const row = this.db.prepare("SELECT MAX(COALESCE(json_extract(data,'$.queuedAt'),created_at)) AS last FROM router_requests WHERE json_extract(data,'$.state')='queued'").get() as { last: number | null }
    return Math.max(Date.now(), (row.last ?? 0) + 1)
  }
  register(input: RouterInput, config: RouterConfig): RouterRequest {
    routerInputId(input.requestId)
    if (typeof input.prompt !== 'string' || input.prompt.length > 32000 || !input.prompt.trim() && !input.attachments?.length) throw new Error('请输入任务内容')
    const fingerprint = createHash('sha256').update(taskRequestFingerprint(input)).digest('hex')
    const existing = this.db.prepare('SELECT data,fingerprint FROM router_requests WHERE id=?').get(input.requestId) as { data: string; fingerprint: string } | undefined
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('相同输入 ID 对应不同内容'); return decode(existing) }
    const now = Date.now()
    const request: RouterRequest = { ...structuredClone(input), scope: input.scope || { kind: 'global' }, config: structuredClone(config), version: 1,
      state: 'queued', delivery: 'pending', createdAt: now, updatedAt: now, queuedAt: this.nextQueuedAt(), timing: { queuedAt: now, elapsedMs: 0 }, protocolVersion: 2 }
    this.db.prepare('INSERT INTO router_requests VALUES (?,?,?,?,?)').run(input.requestId, fingerprint, request.version, now, JSON.stringify(request))
    return request
  }
  update(id: string, expectedVersion: number, patch: Partial<RouterRequest>): RouterRequest {
    const previous = this.request(id)
    if (!previous || previous.version !== expectedVersion) throw new Error('router_revision_conflict')
    const now = Date.now()
    const next: RouterRequest = { ...previous, ...structuredClone(patch), requestId: id, prompt: previous.prompt,
      attachments: previous.attachments, scope: previous.scope,
      config: previous.state === 'queued' && patch.state === 'routing' && patch.config ? structuredClone(patch.config) : previous.config,
      createdAt: previous.createdAt, version: expectedVersion + 1, updatedAt: now }
    if (patch.state === 'queued' && ['needs_input','failed','cancelled'].includes(previous.state)) next.queuedAt = this.nextQueuedAt()
    next.timing = requestTiming(previous, next, now)
    const result = this.db.prepare('UPDATE router_requests SET version=?,data=? WHERE id=? AND version=?').run(next.version, JSON.stringify(next), id, expectedVersion)
    if (result.changes !== 1) throw new Error('router_revision_conflict')
    return next
  }
  requests(limit = 200): RouterRequest[] {
    return this.db.prepare('SELECT data FROM router_requests ORDER BY created_at DESC,rowid DESC LIMIT ?').all(Math.min(1000, Math.max(1,limit))).map(decode<RouterRequest>).reverse()
  }
  feishuTopic(botAppId: string, chatId: string, rootId?: string, parentId?: string, threadId?: string): RouterRequest | undefined {
    const exact = this.db.prepare(`SELECT data FROM router_requests WHERE json_extract(data,'$.feishu.botAppId')=?
      AND json_extract(data,'$.feishu.chatId')=? AND (json_extract(data,'$.feishu.rootMessageId') IN (?,?) OR json_extract(data,'$.feishu.cardMessageId')=?)
      ORDER BY CASE WHEN json_extract(data,'$.feishu.cardMessageId')=? THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1`)
      .get(botAppId, chatId, rootId || null, parentId || null, parentId || null, parentId || null)
    if (exact) return decode<RouterRequest>(exact)
    if (!threadId) return undefined
    const rows = this.db.prepare(`SELECT data FROM router_requests WHERE json_extract(data,'$.feishu.botAppId')=?
      AND json_extract(data,'$.feishu.chatId')=? AND json_extract(data,'$.feishu.threadId')=? LIMIT 2`).all(botAppId, chatId, threadId)
    if (rows.length > 1) throw new Error('router_topic_ambiguous')
    return rows[0] ? decode<RouterRequest>(rows[0]) : undefined
  }
  private reviewRequests(): RouterRequest[] { return this.db.prepare('SELECT data FROM router_requests ORDER BY created_at DESC,rowid DESC').all().map(decode<RouterRequest>) }
  reviewList(query?: RouterReviewQuery) { return this.reviews.list(this.reviewRequests(), query) }
  async reviewDeletion(ids?: string[]) {
    if (ids !== undefined) { if (!Array.isArray(ids)) throw new Error('删除路由记录格式无效'); ids.forEach(routerInputId) }
    return this.reviews.deletion(ids ? ids.map(id => this.request(id)).filter((row): row is RouterRequest => !!row) : this.reviewRequests())
  }
  reviewDelete(items: RouterReviewDeletionItem[]) { return this.reviews.delete(this.reviewRequests(), items) }
  reviewDetail(id: string, attemptId?: string, includeTrace = false) { const request = this.request(id); if (!request) throw new Error('路由记录不存在'); return this.reviews.detail(request, attemptId, includeTrace) }
  reviewSave(input: RouterFeedbackInput) { const request = this.request(input.requestId); if (!request) throw new Error('路由记录不存在'); return this.reviews.save(request, input) }
  reviewBegin(request: RouterRequest, sessionId: string, prompt: string, history: RouterTrace['history'], appVersion: string) { return this.reviews.begin(request, sessionId, prompt, history, appVersion) }
  reviewStep(id: string, kind: string, data: unknown) { return this.reviews.step(id, kind, data) }
  reviewLinkLegacy(id: string, sessionId: string, events: RouterTrace['events']) { return this.reviews.linkLegacy(id, sessionId, events) }
  reviewFinish(request: RouterRequest, events: RouterTrace['events'], error?: string, dismiss = false) { return this.reviews.finish(request, events, error, dismiss) }
  reviewDismiss(id: string, attemptId: string) { return this.reviews.dismiss(id, attemptId) }
  reviewPrompts() { return this.reviews.prompts(this.reviewRequests()) }
  async reviewExport(id?: string, sessionId?: string, events?: RouterTrace['events']) {
    const requests = this.reviewRequests()
    if (sessionId && events) for (const request of requests) if (!id || request.requestId === id) await this.reviews.linkLegacy(request.requestId, sessionId, events)
    return this.reviews.export(requests, id)
  }
  async reviewRecover() {
    const requests = this.db.transaction(() => this.reviewRequests().map(request =>
      request.state === 'bound' && ['accepted','queued','running','finished'].includes(request.delivery) && request.failure?.code === 'router-tool-recovery'
        ? this.update(request.requestId, request.version, { error: undefined, failure: undefined }) : request))()
    for (const request of requests) { if (await this.reviews.recoverDeleted(request.requestId)) continue; const detail = await this.reviews.detail(request); if (detail.attempts.at(-1) && !detail.attempts.at(-1)!.endedAt) await this.reviews.finish(request, [], '重启前路由未完整结束，日志仅保留已采集部分。', true) }
    await this.reviews.prompts(requests, true)
  }
  pending(): RouterRequest[] {
    return this.db.prepare("SELECT data FROM router_requests WHERE json_extract(data,'$.state') IN ('queued','routing','needs_input','committing') OR json_extract(data,'$.delivery')='unknown' ORDER BY created_at,rowid").all().map(decode<RouterRequest>).sort(compareRouterQueue)
  }
  async index(objects: RouterObject[], complete = true): Promise<void> {
    const tokenizer = await loadRouterTokenizer(this.tokenizerDirectory)
    this.db.transaction(() => {
      const incoming = new Set(objects.map(row => row.id))
      for (const existing of this.db.prepare('SELECT id FROM router_objects').all() as { id: string }[]) if (complete && !incoming.has(existing.id)) {
        this.db.prepare('DELETE FROM router_objects WHERE id=?').run(existing.id)
      }
      for (const raw of objects) {
        const previousRow = this.db.prepare('SELECT data FROM router_objects WHERE id=?').get(raw.id)
        const previous = previousRow ? decode<RouterObject>(previousRow) : undefined
        const sources = (raw.sources || []).map(row => ({ ...row, text: sanitizeRouterReview(row.text) }))
        const sourceRevision = createHash('sha256').update(JSON.stringify({ title: raw.title, summary: raw.summary, version: raw.version, sources, changes: raw.recentChanges,
          archived: raw.archived, readOnly: raw.readOnly, projectId: raw.projectId, requirementId: raw.requirementId,
          routing: raw.routing && { status: raw.routing.status, sourceRevision: raw.routing.sourceRevision, generatedAt: raw.routing.view?.generatedAt } })).digest('hex')
        if (previous?.sourceRevision === sourceRevision && previous.description?.tokenizerRevision === tokenizer.revision && previous.busy === raw.busy &&
          (raw.lastBusinessUpdatedAt || 0) <= (previous.lastBusinessUpdatedAt || 0)) continue
        const text = tokenizer.clip(sanitizeRouterReview(raw.summary || raw.title), 200)
        const oldDescription = previous?.description && previous.description.freshness !== 'source_excerpt' ? previous.description : undefined
        const object: RouterObject = { ...raw, sources, sourceRevision, lastBusinessUpdatedAt: Math.max(raw.lastBusinessUpdatedAt || 0, previous?.lastBusinessUpdatedAt || 0),
          recentChanges: (raw.recentChanges || []).slice(0, 3).map(row => ({ ...row, text: tokenizer.clip(sanitizeRouterReview(row.text), 80) })),
          description: raw.kind === 'requirement' && raw.routing ? { text, tokens: tokenizer.count(text), tokenizerRevision: tokenizer.revision, sourceRevision, generatedAt: Date.now(), freshness: raw.routing.status === 'ready' ? 'ready' : 'source_excerpt', sourceRefs: sources.map(row => row.ref) } : previous?.description?.sourceRevision === sourceRevision && previous.description.tokenizerRevision === tokenizer.revision ? previous.description : oldDescription ?
            { ...oldDescription, text: tokenizer.clip(oldDescription.text, 200), tokens: tokenizer.count(tokenizer.clip(oldDescription.text, 200)), tokenizerRevision: tokenizer.revision, freshness: 'stale' } :
            { text, tokens: tokenizer.count(text), tokenizerRevision: tokenizer.revision, sourceRevision, generatedAt: Date.now(), freshness: 'source_excerpt', sourceRefs: sources.map(row => row.ref) },
          ...(previous?.descriptionAttemptRevision === sourceRevision ? { descriptionAttemptRevision: sourceRevision } : {}) }
        const json = JSON.stringify(object)
        if (previous && JSON.stringify(previous) === json) continue
        this.db.prepare('INSERT OR REPLACE INTO router_objects VALUES (?,?,?)').run(object.id, object.kind, json)
      }
    })()
  }
  object(id: string): RouterObject {
    const row = this.db.prepare('SELECT data FROM router_objects WHERE id=?').get(id)
    if (!row) throw new Error('object_not_found')
    return decode(row)
  }
  private objects(): RouterObject[] { return this.db.prepare('SELECT data FROM router_objects').all().map(decode<RouterObject>) }
  private brief(object: RouterObject, tokenizer: RouterTokenizer) {
    return { id: object.id, kind: object.kind, title: tokenizer.clip(object.title, 100), projectId: object.projectId, requirementId: object.requirementId,
      archived: object.archived, readOnly: object.readOnly, busy: object.busy, agentId: object.agentId, lastBusinessUpdatedAt: object.lastBusinessUpdatedAt,
      description: object.description?.text || '', descriptionTokens: object.description?.tokens, freshness: object.description?.freshness,
      recentChanges: object.recentChanges?.slice(0, 3).map(row => ({ at: row.at, text: tokenizer.clip(row.text, 100), sourceRefs: row.sourceRefs.slice(0, 3) })),
      ...(object.routing ? { routing: { status: object.routing.status, featureCount: object.routing.view?.features.length, conflicts: object.routing.view?.conflicts.length } } : {}) }
  }
  async routingChunks(text: string) {
    const tokenizer = await loadRouterTokenizer(this.tokenizerDirectory), chunks: Array<{ offset: number; text: string }> = []
    let offset = 0
    do {
      let part = tokenizer.clip(text.slice(offset), 6000)
      while (Buffer.byteLength(JSON.stringify(part)) > 10000) part = tokenizer.clip(part, Math.max(1, Math.floor(tokenizer.count(part) * 0.75)))
      chunks.push({ offset, text: part })
      if (offset + part.length >= text.length) break
      const overlap = tokenizer.clip([...part].reverse().join(''), 200).length
      offset += Math.max(1, part.length - overlap)
    } while (offset < text.length)
    return chunks
  }
  private snapshot(id: string): ReadingSnapshot {
    const row = this.db.prepare('SELECT value FROM router_meta WHERE id=?').get('context:reading:' + id) as { value: string } | undefined
    if (!row) throw new Error('reading_snapshot_expired')
    return JSON.parse(row.value)
  }
  private saveSnapshot(value: ReadingSnapshot): void { this.manifest('reading:' + value.id, value) }
  private async page(requestId: string, key: string, objects: RouterObject[], cursor?: string, snapshotId?: string) {
    const tokenizer = await loadRouterTokenizer(this.tokenizerDirectory)
    let snapshot: ReadingSnapshot, offset = 0
    if (cursor) {
      const [id, token, ...extra] = cursor.split('.')
      if (extra.length) throw new Error('invalid_reading_cursor')
      snapshot = this.snapshot(id); offset = snapshot.cursors[token]
      if (offset === undefined || offset > snapshot.readThrough) throw new Error('invalid_reading_cursor')
    } else if (snapshotId) snapshot = this.snapshot(snapshotId)
    else snapshot = { id: randomUUID(), requestId, key, asOf: this.now(), items: objects, readThrough: 0, cursors: {} }
    if (snapshot.requestId !== requestId || snapshot.key !== key) throw new Error('invalid_reading_cursor')
    const page = tokenizer.page(snapshot.items.map(row => this.brief(row, tokenizer)), offset)
    const end = offset + page.items.length
    snapshot.readThrough = Math.max(snapshot.readThrough, end)
    let nextCursor: string | null = null
    if (page.next !== null) { const token = randomUUID(); snapshot.cursors[token] = page.next; nextCursor = snapshot.id + '.' + token }
    this.saveSnapshot(snapshot)
    return { snapshotId: snapshot.id, asOf: snapshot.asOf, items: page.items, objects: snapshot.items.slice(offset, end).map(row => ({ id: row.id, version: row.version })), total: snapshot.items.length, nextCursor,
      coverage: { read: snapshot.readThrough, total: snapshot.items.length, complete: snapshot.readThrough === snapshot.items.length },
      readTaskIds: snapshot.items.slice(0, snapshot.readThrough).map(row => row.id) }
  }
  async catalog(requestId: string, kind: 'space' | 'requirement', projectId?: string, cursor?: string) {
    const request = this.request(requestId)
    if (!request) throw new Error('router_scope_expired')
    const objects = this.objects(), scope = request.scope
    if (projectId) {
      const project = this.object(projectId)
      if (project.kind !== 'space') throw new Error('router_target_kind_conflict')
    }
    const owner = scope.kind === 'requirement' ? objects.find(row => row.id === scope.requirementId)?.projectId : scope.kind === 'space' ? scope.projectId : undefined
    if (projectId && owner && projectId !== owner) {
      if (request.context?.protocolVersion === 2) throw new RouterToolError({ code: 'hard_scope_conflict', message: '查询目标超出用户本轮明确范围', recovery: { action: 'clarify' } })
      throw new Error('router_scope_conflict')
    }
    const rows = objects.filter(row => row.kind === kind && (kind === 'space' ? !(projectId || owner) || row.id === (projectId || owner) :
      scope.kind === 'requirement' ? row.id === scope.requirementId : !(projectId || owner) || row.projectId === (projectId || owner)))
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    return this.page(requestId, 'catalog:' + kind + ':' + (projectId || ''), rows, cursor)
  }
  async taskBriefs(requestId: string, selectedScope: RouterScope, cursor?: string, refresh = false) {
    const request = this.request(requestId)
    if (!request || selectedScope.kind === 'global') throw new Error('router_scope_conflict')
    const id = selectedScope.kind === 'space' ? selectedScope.projectId : selectedScope.requirementId, target = this.object(id)
    if (target.kind !== selectedScope.kind) throw new Error('router_target_kind_conflict')
    assertRouterScope(request, target)
    if (target.archived || target.readOnly) throw new Error('task_not_eligible')
    if (this.objects().some(row => row.kind === 'space' && row.id === target.projectId && (row.archived || row.readOnly))) throw new Error('task_not_eligible')
    const key = 'tasks:' + routerScopeKey(selectedScope), reading = routerScanFor(request.context?.reading, selectedScope)
    const reuse = !refresh ? reading?.scanId : undefined
    const cutoff = this.now() - 72 * 3600000
    const rows = this.objects().filter(row => row.kind === 'task' && !row.archived && !row.readOnly && ((row.lastBusinessUpdatedAt || 0) >= cutoff || request.context?.references?.includes(row.id)) &&
      (selectedScope.kind === 'requirement' ? row.requirementId === id : row.projectId === id && !row.requirementId))
      .sort((a, b) => (b.lastBusinessUpdatedAt || 0) - (a.lastBusinessUpdatedAt || 0) || a.id.localeCompare(b.id))
    return this.page(requestId, key, rows, cursor, reuse)
  }
  async detail(requestId: string, objectId: string, sourceRef?: string, cursor?: string, scanId?: string) {
    const request = this.request(requestId), object = this.object(objectId), tokenizer = await loadRouterTokenizer(this.tokenizerDirectory)
    if (!request) throw new Error('router_scope_expired')
    assertRouterScope(request, object)
    const scan = routerScanFor(request.context?.reading, routerObjectScope(object))
    if (object.kind === 'task' && scanId && scan?.scanId !== scanId) throw new Error('scan_scope_mismatch')
    if (object.kind === 'task' && (object.archived || object.readOnly ||
      (object.lastBusinessUpdatedAt || 0) < this.now() - 72 * 3600000 && !request.context?.references?.includes(objectId) ||
      this.objects().some(row => row.kind !== 'task' && (row.id === object.projectId || row.id === object.requirementId) && (row.archived || row.readOnly)))) throw new Error('task_not_eligible')
    const sources = object.sources || []
    if (object.kind === 'task' && !sources.length) throw new Error('context_unavailable')
    let offset = 0
    if (cursor) {
      try {
        const stored = this.db.prepare('SELECT value FROM router_meta WHERE id=?').get('context:text-cursor:' + cursor) as { value: string } | undefined
        if (!stored) throw new Error()
        const position = JSON.parse(stored.value)
        if (position.requestId !== requestId || position.objectId !== objectId || position.ref !== sourceRef || position.revision !== object.sourceRevision) throw new Error()
        offset = position.offset
      } catch { throw new Error('invalid_reading_cursor') }
    }
    let nextCursor: string | null = null
    const item = this.brief(object, tokenizer)
    let texts: Array<{ ref: string; title: string; at: number; chars: number; hasMore: boolean; text?: string }>, next: number | null
    if (sourceRef) {
      const row = sources.find(row => row.ref === sourceRef)
      if (!row) throw new Error('context_unavailable')
      const text = tokenizer.clip(row.text.slice(offset), Math.max(1, 2500 - tokenizer.count(JSON.stringify(item))))
      next = offset + text.length < row.text.length ? offset + text.length : null
      texts = [{ ref: row.ref, title: tokenizer.clip(row.title, 100), at: row.at, text, chars: row.text.length, hasMore: next !== null }]
    } else {
      const page = tokenizer.page(sources.map(row => ({ ref: row.ref, title: tokenizer.clip(row.title, 100), at: row.at, chars: row.text.length, hasMore: !!row.text.length })), offset, 1000)
      texts = page.items; next = page.next
    }
    if (next !== null) {
      nextCursor = randomUUID()
      this.manifest('text-cursor:' + nextCursor, { requestId, objectId, ref: sourceRef, revision: object.sourceRevision, offset: next })
    }
    return { item, sources: texts, nextCursor, ...(!sourceRef ? { total: sources.length } : {}), sourceRevision: object.sourceRevision!,
      objects: [{ id: object.id, version: object.version }], evidenceRefs: sourceRef ? [sourceRef] : [] }
  }
  async descriptionJobs() {
    const tokenizer = await loadRouterTokenizer(this.tokenizerDirectory)
    return this.objects().filter(row => !row.routing && row.description?.freshness !== 'ready' && row.descriptionAttemptRevision !== row.sourceRevision)
      .sort((a, b) => (b.lastBusinessUpdatedAt || 0) - (a.lastBusinessUpdatedAt || 0)).slice(0, 5)
      .map(row => {
        const job = { id: row.id, sourceRevision: row.sourceRevision!, title: tokenizer.clip(row.title, 100), kind: row.kind, summary: tokenizer.clip(row.summary, 200),
          sources: (row.sources || []).slice(-6).map(source => ({ ...source, title: tokenizer.clip(source.title, 80), text: tokenizer.clip(source.text, 240) })) }
        while (Buffer.byteLength(JSON.stringify(job)) > 12000) {
          if (!job.sources.length) throw new Error('context_item_too_large')
          const longest = job.sources.reduce((a, b) => a.text.length > b.text.length ? a : b)
          if (!longest.text) job.sources.pop()
          else longest.text = tokenizer.clip(longest.text, Math.floor(tokenizer.count(longest.text) / 2))
        }
        return job
      })
  }
  descriptionAttempt(id: string, sourceRevision: string): void {
    const object = this.object(id)
    if (object.sourceRevision !== sourceRevision) throw new Error('object_revision_changed')
    object.descriptionAttemptRevision = sourceRevision
    this.db.prepare('UPDATE router_objects SET data=? WHERE id=?').run(JSON.stringify(object), id)
  }
  async saveDescription(id: string, sourceRevision: string, raw: unknown) {
    const object = this.object(id), tokenizer = await loadRouterTokenizer(this.tokenizerDirectory), value = raw as { description?: string; sourceRefs?: string[] }
    if (object.sourceRevision !== sourceRevision) throw new Error('object_revision_changed')
    if (!value || Object.keys(value).some(key => !['description', 'sourceRefs'].includes(key)) || typeof value.description !== 'string' || !value.description.trim() ||
      tokenizer.count(value.description) > 200 || !Array.isArray(value.sourceRefs) || !value.sourceRefs.length || value.sourceRefs.some(ref => !object.sources?.some(row => row.ref === ref))) throw new Error('invalid_router_description')
    const text = sanitizeRouterReview(value.description)
    if (tokenizer.count(text) > 200) throw new Error('invalid_router_description')
    object.description = { text, tokens: tokenizer.count(text), tokenizerRevision: tokenizer.revision, sourceRevision, generatedAt: Date.now(), freshness: 'ready', sourceRefs: value.sourceRefs }
    this.db.prepare('UPDATE router_objects SET data=? WHERE id=?').run(JSON.stringify(object), id)
    return object.description
  }
  memories(scope?: GlobalMemoryItem['scope'], includeCandidates = false): GlobalMemoryItem[] {
    return this.db.prepare('SELECT data FROM global_memory').all().map(decode<GlobalMemoryItem>).filter(row =>
      row.status !== 'revoked' && (includeCandidates || row.status === 'active') && (!scope || row.scope.kind === 'global' || routerMemoryScopeKey(scope) === routerMemoryScopeKey(row.scope)))
  }
  async memoryPage(requestId: string, scope: GlobalMemoryItem['scope'], items: GlobalMemoryItem[], cursor?: string) {
    const key = 'memory:' + routerMemoryScopeKey(scope), tokenizer = await loadRouterTokenizer(this.tokenizerDirectory)
    let offset = 0
    if (cursor) {
      const row = this.db.prepare('SELECT value FROM router_meta WHERE id=?').get('context:memory-cursor:' + cursor) as { value: string } | undefined
      if (!row) throw new Error('invalid_reading_cursor')
      const state = JSON.parse(row.value)
      if (state.requestId !== requestId || state.key !== key || state.versions !== JSON.stringify(items.map(row => [row.id,row.revision]))) throw new Error('memory_revision_changed')
      offset = state.offset
    }
    const page = tokenizer.page(items.slice(offset, offset + 8), 0, 2000), end = offset + page.items.length
    const nextCursor = end < items.length ? randomUUID() : null
    if (nextCursor) this.manifest('memory-cursor:' + nextCursor, { requestId, key, offset: end, versions: JSON.stringify(items.map(row => [row.id,row.revision])) })
    return { items: page.items, nextCursor }
  }
  recordToolFailure(requestId: string, signature: string): number {
    const key = 'context:tool-failure:' + requestId + ':' + signature, previous = this.db.prepare('SELECT value FROM router_meta WHERE id=?').get(key) as { value: string } | undefined
    const count = previous ? Number(previous.value) + 1 : 1
    this.db.prepare('INSERT OR REPLACE INTO router_meta VALUES (?,?)').run(key, String(count))
    return count
  }
  writeMemory(item: GlobalMemoryItem, expectedRevision = 0): GlobalMemoryItem {
    if (!item.content.trim() || item.content.length > 2000 || /\bsk-[\w-]{10,}|\b(?:api[_-]?key|password)\s*[:=]|authorization\s*:\s*bearer/i.test(item.content)) throw new Error('invalid_memory_content')
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT data FROM global_memory WHERE id=?').get(item.id)
      const revision = previous ? decode<GlobalMemoryItem>(previous).revision : 0
      if (revision !== expectedRevision) throw new Error('memory_revision_conflict')
      const next = { ...structuredClone(item), revision: revision + 1, updatedAt: Date.now() }
      this.db.prepare('INSERT OR REPLACE INTO global_memory VALUES (?,?)').run(next.id, JSON.stringify(next))
      this.db.prepare('INSERT INTO global_memory_revisions VALUES (?,?,?)').run(next.id, next.revision, JSON.stringify(next))
      if (next.supersedes) {
        const old = this.db.prepare('SELECT data FROM global_memory WHERE id=?').get(next.supersedes)
        if (old) this.writeMemory({ ...decode<GlobalMemoryItem>(old), status: 'revoked' }, decode<GlobalMemoryItem>(old).revision)
      }
      return next
    })()
  }
  memoryItem(id:string):GlobalMemoryItem|undefined{const row=this.db.prepare('SELECT data FROM global_memory WHERE id=?').get(id);return row?decode(row):undefined}
  memoryHistory(id: string, offset = 0, limit = 30): GlobalMemoryItem[] { return this.db.prepare('SELECT data FROM global_memory_revisions WHERE id=? ORDER BY revision DESC LIMIT ? OFFSET ?').all(id,limit,offset).map(decode<GlobalMemoryItem>) }
  async memoryReferences(project: Project, modules: ProjectCodeLink[]): Promise<NonNullable<ProjectMemoryMetadata['references']>> {
    const roots = [project.primaryDirectory, ...project.additionalDirectories]
    return Promise.all(modules.map(async module => {
      const directory = module.directory || project.primaryDirectory
      if (!roots.includes(directory) || !validProjectCodePath(module.path)) throw new Error('memory_code_scope_invalid')
      const ref = { path: module.path, ...(module.directory ? { directory: module.directory } : {}) }
      try {
        const root = await realpath(directory), target = await realpath(join(root, module.path)), rel = relative(root, target)
        if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('memory_code_scope_invalid')
        const info = await stat(target)
        await access(target,constants.R_OK)
        const version = info.isFile() && info.size <= 2_000_000 ? 'sha256:' + createHash('sha256').update(await readFile(target)).digest('hex') : 'stat:' + info.size + ':' + info.mtimeMs
        return { ...ref, version }
      } catch (error) {
        if ((error as Error).message === 'memory_code_scope_invalid') throw error
        return ref
      }
    }))
  }
  enqueueMemory(job:MemoryJob):void{this.db.prepare('INSERT OR IGNORE INTO global_memory_jobs VALUES (?,?)').run(job.id,JSON.stringify(job))}
  memoryJobs():MemoryJob[]{return this.db.prepare('SELECT data FROM global_memory_jobs ORDER BY rowid').all().map(decode<MemoryJob>)}
  updateMemoryJob(job:MemoryJob):void{this.db.prepare('UPDATE global_memory_jobs SET data=? WHERE id=?').run(JSON.stringify(job),job.id)}
  manifest(key:string,value:unknown):void{this.db.prepare('INSERT OR REPLACE INTO router_meta VALUES (?,?)').run('context:'+key,JSON.stringify(value))}
  close(): void { this.db.close() }
}
export interface MemoryJob{id:string;sessionId:string;sourceSeq:number;throughSeq:number;input:string;reply:string;scope:GlobalMemoryItem['scope'];state:'queued'|'running'|'complete'|'failed'|'stale';error?:string}
