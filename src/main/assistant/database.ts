import Database from 'better-sqlite3'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ASSISTANT_DOCUMENTS, type AssistantDetail, type AssistantDocument, type AssistantDocumentType,
  type AssistantInput, type DocumentEdit, type DocumentRevision, type DocumentSource,
  type IndexedMessage, type IndexedSession, type MemoryRequest, type MemoryResult,
  type PersonalAssistant, type ReviewJob, type SessionSearchRequest, type SessionSearchResult
} from '../../shared/assistant'
import { applyMemoryOperations, checkContent } from './memory'
import { compileSearch, searchTime, searchTokens, validateSearch } from './search'
import { PERMISSION_MODE_IDS } from '../../shared/types'

type JsonRow = { data: string }
const decode = <T>(row: unknown): T => JSON.parse((row as JsonRow).data)

export class AssistantDatabase {
  private db: Database.Database
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path)
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > 1) { this.db.close(); throw new Error('assistant_schema_newer_than_app') }
    chmodSync(path, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 3000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_assistant (id TEXT PRIMARY KEY CHECK(id='personal'), data TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS assistant_documents (type TEXT PRIMARY KEY CHECK(type IN ('soul','working_rules','user','memory')), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_document_revisions (type TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(type,revision));
      CREATE TABLE IF NOT EXISTS assistant_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, ts INTEGER NOT NULL, role TEXT NOT NULL, visibility TEXT NOT NULL, content TEXT NOT NULL, UNIQUE(session_id,seq));
      CREATE INDEX IF NOT EXISTS assistant_messages_session ON assistant_messages(session_id,seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(tokens, message_id UNINDEXED);
      CREATE TABLE IF NOT EXISTS assistant_review_jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,turn_key));
      CREATE TABLE IF NOT EXISTS assistant_review_stages (job_id TEXT PRIMARY KEY REFERENCES assistant_review_jobs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_review_cursors (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `)
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT id FROM personal_assistant').get()) {
        const now = Date.now()
        const assistant: PersonalAssistant = { id: 'personal', enabled: false, autoReviewEnabled: true, defaultAgentId: 'codex', createdAt: now, updatedAt: now }
        this.db.prepare('INSERT INTO personal_assistant(id,data) VALUES (?,?)').run('personal', JSON.stringify(assistant))
        for (const type of ASSISTANT_DOCUMENTS) {
          const doc: AssistantDocument = { assistantId: 'personal', type, content: '', revision: 1, updatedAt: now, updatedBy: 'user' }
          this.writeDocument(doc, { writer: 'user' })
        }
      }
      this.db.prepare('DELETE FROM assistant_review_stages').run()
      for (const job of this.jobs()) if (job.state === 'running') this.setReviewState(job.id, 'queued', job.attempt, '上次运行已中断')
    })()
  }

  private assistant(): PersonalAssistant { return decode(this.db.prepare('SELECT data FROM personal_assistant').get()) }
  private documents(): AssistantDocument[] { return ASSISTANT_DOCUMENTS.map(type => decode<AssistantDocument>(this.db.prepare('SELECT data FROM assistant_documents WHERE type=?').get(type))) }
  detail(): AssistantDetail {
    const assistant = this.assistant()
    const recent = this.jobs().reverse().find(j => j.generation === this.generation() && j.state !== 'stale')
    return { assistant, documents: this.documents(), review: !assistant.enabled || !assistant.autoReviewEnabled ? { status: 'off' } : recent && recent.state !== 'complete' ? { status: recent.state as 'queued' | 'running' | 'failed' | 'unsupported', reason: recent.reason, updatedAt: recent.createdAt } : { status: 'idle' } }
  }
  private writeDocument(doc: AssistantDocument, source: DocumentSource): void {
    this.db.prepare('INSERT OR REPLACE INTO assistant_documents(type,data) VALUES (?,?)').run(doc.type, JSON.stringify(doc))
    this.db.prepare('INSERT INTO assistant_document_revisions(type,revision,data) VALUES (?,?,?)').run(doc.type, doc.revision, JSON.stringify({ ...doc, source }))
  }
  private writeChanges(next: AssistantDocument[], source: DocumentSource): boolean {
    let changed = false
    for (const current of this.documents()) {
      const doc = next.find(d => d.type === current.type)!
      if (doc.content === current.content) continue
      this.writeDocument({ ...doc, revision: current.revision + 1, updatedAt: Date.now(), updatedBy: source.writer }, source)
      changed = true
    }
    return changed
  }
  save(input: AssistantInput, edits: DocumentEdit[], expectedConfig?: PersonalAssistant): AssistantDetail {
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['enabled','defaultAgentId','defaultModel','defaultPermissionMode','defaultWorkdir','autoReviewEnabled','reviewRuntime'].includes(k)) ||
      typeof input.enabled !== 'boolean' || typeof input.autoReviewEnabled !== 'boolean' || typeof input.defaultAgentId !== 'string' || !input.defaultAgentId || input.defaultAgentId.length > 100 ||
      (input.defaultModel !== undefined && (typeof input.defaultModel !== 'string' || input.defaultModel.length > 500)) ||
      (input.defaultPermissionMode !== undefined && !PERMISSION_MODE_IDS.includes(input.defaultPermissionMode))) throw new Error('invalid_assistant_config')
    if (input.defaultWorkdir !== undefined) {
      if (typeof input.defaultWorkdir !== 'string' || input.defaultWorkdir.length > 4096 || input.defaultWorkdir.includes('\0') || !isAbsolute(input.defaultWorkdir)) throw new Error('运行目录必须是绝对路径')
      try { if (!statSync(input.defaultWorkdir).isDirectory()) throw new Error('not_directory') }
      catch { throw new Error(`运行目录不可用：${input.defaultWorkdir}`) }
    }
    if (input.reviewRuntime !== undefined && (!input.reviewRuntime || typeof input.reviewRuntime !== 'object' || Array.isArray(input.reviewRuntime) || Object.keys(input.reviewRuntime).some(k => !['agentId','model'].includes(k)) || typeof input.reviewRuntime.agentId !== 'string' || !input.reviewRuntime.agentId || input.reviewRuntime.agentId.length > 100 || (input.reviewRuntime.model !== undefined && (typeof input.reviewRuntime.model !== 'string' || input.reviewRuntime.model.length > 500)))) throw new Error('invalid_review_runtime')
    if (!Array.isArray(edits) || edits.length > 4 || edits.some(e => !e || typeof e !== 'object') || new Set(edits.map(e => e.type)).size !== edits.length) throw new Error('invalid_document_edits')
    this.db.transaction(() => {
      if (expectedConfig && JSON.stringify(this.assistant()) !== JSON.stringify(expectedConfig)) throw new Error('revision_conflict')
      const next = this.documents()
      for (const edit of edits) {
        if (!edit || Object.keys(edit).some(k => !['type','content','expectedRevision'].includes(k)) || !ASSISTANT_DOCUMENTS.includes(edit.type)) throw new Error('invalid_document_edit')
        const doc = next.find(d => d.type === edit.type)!
        if (!Number.isSafeInteger(edit.expectedRevision) || doc.revision !== edit.expectedRevision) throw new Error('revision_conflict')
        checkContent(edit.type, edit.content)
        doc.content = edit.content
      }
      const old = this.assistant()
      const updated = { ...input, id: 'personal', createdAt: old.createdAt, updatedAt: Date.now() }
      this.db.prepare('UPDATE personal_assistant SET data=?').run(JSON.stringify(updated))
      const changed = this.writeChanges(next, { writer: 'user' })
      if (changed && edits.some(edit => ['user','memory'].includes(edit.type))) this.invalidateAndForgetPast()
      else this.invalidate()
    })()
    return this.detail()
  }
  versions(type: AssistantDocumentType): DocumentRevision[] {
    if (!ASSISTANT_DOCUMENTS.includes(type)) throw new Error('invalid_document_type')
    return this.db.prepare('SELECT data FROM assistant_document_revisions WHERE type=? ORDER BY revision DESC LIMIT 100').all(type).map(row => decode<DocumentRevision>(row))
  }
  rollback(type: AssistantDocumentType, revision: number, expectedRevision: number): AssistantDocument {
    if (!ASSISTANT_DOCUMENTS.includes(type) || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(expectedRevision)) throw new Error('invalid_document_version')
    const row = this.db.prepare('SELECT data FROM assistant_document_revisions WHERE type=? AND revision=?').get(type, revision)
    if (!row) throw new Error('version_not_found')
    this.save(this.config(), [{ type, content: decode<AssistantDocument>(row).content, expectedRevision }])
    return this.documents().find(d => d.type === type)!
  }
  private config(): AssistantInput { const { id, createdAt, updatedAt, ...config } = this.assistant(); return config }
  memory(request: MemoryRequest, source: DocumentSource): MemoryResult {
    return this.db.transaction(() => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid_memory_request')
      if (!['agent','auto_review'].includes(source.writer)) throw new Error('invalid_memory_writer')
      let documents = this.documents()
      const job = source.writer === 'auto_review' ? this.job(source.jobId || '') : undefined
      if (source.writer === 'auto_review' && (!job || !this.reviewValid(job))) throw new Error('stale_review')
      if (job) {
        const stage = this.db.prepare('SELECT data FROM assistant_review_stages WHERE job_id=?').get(job.id)
        if (stage) documents = decode<AssistantDocument[]>(stage)
      }
      if (request.action === 'read') {
        if (Object.keys(request).some(k => !['action','document'].includes(k)) || (request.document && !['user','memory'].includes(request.document))) throw new Error('invalid_memory_request')
        return { documents: documents.filter(d => request.document ? d.type === request.document : ['user','memory'].includes(d.type)), staged: !!job }
      }
      if (!this.assistant().enabled) throw new Error('assistant_disabled')
      const next = applyMemoryOperations(documents, request)
      if (job) this.db.prepare('INSERT OR REPLACE INTO assistant_review_stages(job_id,data) VALUES (?,?)').run(job.id, JSON.stringify(next))
      else if (this.writeChanges(next, source)) this.invalidate()
      return { documents: (job ? next : this.documents()).filter(d => ['user','memory'].includes(d.type)), staged: !!job }
    })()
  }

  transcript(session: IndexedSession, messages: IndexedMessage[]): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO assistant_sessions(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(session.id, JSON.stringify(session))
      for (const message of messages) {
        if (message.sessionId !== session.id) throw new Error('session_out_of_scope')
        this.db.prepare('DELETE FROM session_messages_fts WHERE message_id=?').run(message.id)
        const prior = this.db.prepare('SELECT seq,visibility FROM assistant_messages WHERE id=?').get(message.id) as { seq: number; visibility: string } | undefined
        if (prior?.visibility === 'removed') continue
        const nextSeq = prior?.seq ?? (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 seq FROM assistant_messages WHERE session_id=?').get(session.id) as { seq: number }).seq
        this.db.prepare('INSERT INTO assistant_messages(id,session_id,seq,ts,role,visibility,content) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,visibility=excluded.visibility,ts=excluded.ts').run(message.id, session.id, nextSeq, message.ts, message.role, message.visibility, message.content)
        if (message.visibility !== 'removed') this.db.prepare('INSERT INTO session_messages_fts(tokens,message_id) VALUES (?,?)').run(searchTokens(message.content).join(' '), message.id)
      }
    })()
  }
  lastSeq(sessionId: string): number { return (this.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM assistant_messages WHERE session_id=?').get(sessionId) as { seq: number }).seq }
  markCompacted(sessionId: string): void { this.db.prepare("UPDATE assistant_messages SET visibility='compacted' WHERE session_id=? AND visibility='live'").run(sessionId) }
  truncate(sessionId: string, after: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM session_messages_fts WHERE message_id IN (SELECT id FROM assistant_messages WHERE session_id=? AND ts>?)").run(sessionId, after)
      this.db.prepare("UPDATE assistant_messages SET visibility='removed' WHERE session_id=? AND ts>?").run(sessionId, after)
      this.invalidate()
    })()
  }
  removeSession(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_messages_fts WHERE message_id IN (SELECT id FROM assistant_messages WHERE session_id=?)').run(id)
      this.db.prepare('DELETE FROM assistant_sessions WHERE id=?').run(id)
      this.invalidate()
    })()
  }
  private message(row: any): IndexedMessage { return { id: row.id, sessionId: row.session_id, seq: row.seq, ts: row.ts, role: row.role, visibility: row.visibility, content: row.content.slice(0, 8000) } }
  search(input: SessionSearchRequest): SessionSearchResult {
    const req = validateSearch(input)
    const limit = Math.min(20, Math.max(1, Number.isSafeInteger(req.limit) ? req.limit! : 5))
    const window = Math.min(20, Math.max(1, Number.isSafeInteger(req.window) ? req.window! : 4))
    const result: SessionSearchResult = { mode: req.aroundMessageId ? 'scroll' : req.sessionId ? 'read' : req.query?.trim() ? 'discover' : 'browse', sessions: [], rebuilding: false, incomplete: false }
    const filters = ["m.visibility != 'removed'"]
    const params: unknown[] = []
    if (req.sessionId) {
      if (!this.db.prepare('SELECT id FROM assistant_sessions WHERE id=?').get(req.sessionId)) throw new Error('session_out_of_scope')
      filters.push('m.session_id=?'); params.push(req.sessionId)
    }
    const roles = req.roles?.length ? req.roles : ['user','assistant']
    filters.push(`m.role IN (${roles.map(() => '?').join(',')})`); params.push(...roles)
    if (req.excludeSessionIds?.length) { filters.push(`m.session_id NOT IN (${req.excludeSessionIds.map(() => '?').join(',')})`); params.push(...req.excludeSessionIds) }
    const after = searchTime(req.after), before = searchTime(req.before)
    if (after !== undefined) { filters.push('m.ts>=?'); params.push(after) }
    if (before !== undefined) { filters.push('m.ts<?'); params.push(before) }
    if (req.aroundMessageId) {
      if (!req.sessionId) throw new Error('search_session_required')
      const anchor = this.db.prepare('SELECT seq FROM assistant_messages WHERE id=? AND session_id=? AND visibility!=?').get(req.aroundMessageId, req.sessionId, 'removed') as { seq: number } | undefined
      if (!anchor) throw new Error('message_not_found')
      filters.push('m.seq BETWEEN ? AND ?'); params.push(anchor.seq - window, anchor.seq + window)
    }
    let join = '', order = req.sort === 'oldest' ? 'm.ts ASC' : 'm.ts DESC'
    if (req.query?.trim()) { join = 'JOIN session_messages_fts f ON f.message_id=m.id'; filters.push('session_messages_fts MATCH ?'); params.push(compileSearch(req.query)); if (!req.sort) order = 'bm25(session_messages_fts), m.ts DESC' }
    let rows = this.db.prepare(`SELECT m.* FROM assistant_messages m ${join} WHERE ${filters.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...params, req.sessionId ? window * 2 + 1 : limit * 6)
    if (req.sessionId && !req.aroundMessageId && !req.query) {
      const head = this.db.prepare(`SELECT m.* FROM assistant_messages m WHERE ${filters.join(' AND ')} ORDER BY m.seq ASC LIMIT ?`).all(...params, window)
      const tail = this.db.prepare(`SELECT m.* FROM assistant_messages m WHERE ${filters.join(' AND ')} ORDER BY m.seq DESC LIMIT ?`).all(...params, window)
      rows = [...new Map([...head,...tail].map((row: any) => [row.id,row])).values()]
    }
    const groups = new Map<string, IndexedMessage[]>()
    for (const row of rows) {
      const message = this.message(row)
      if (!groups.has(message.sessionId) && groups.size >= limit) { result.incomplete = true; continue }
      const list = groups.get(message.sessionId) || []
      if (list.length < window * 2 + 1) list.push(message)
      groups.set(message.sessionId, list)
    }
    if (!req.query && !req.sessionId) {
      for (const row of this.db.prepare("SELECT data FROM assistant_sessions ORDER BY json_extract(data,'$.createdAt') DESC LIMIT ?").all(limit)) {
        const session = decode<IndexedSession>(row)
        if (!groups.has(session.id) && !req.excludeSessionIds?.includes(session.id) && groups.size < limit && after === undefined && before === undefined && !req.roles) groups.set(session.id, [])
      }
    }
    const seen = new Set<string>()
    let remaining = 20000
    for (const [id, messages] of groups) {
      const session = decode<IndexedSession>(this.db.prepare('SELECT data FROM assistant_sessions WHERE id=?').get(id))
      const lineage = session.lineageRoot || id
      if (!req.sessionId && seen.has(lineage)) continue
      seen.add(lineage)
      messages.sort((a,b) => a.seq - b.seq)
      const bounded: IndexedMessage[] = []
      for (const message of messages) {
        if (remaining <= 0) { result.incomplete = true; break }
        if (message.content.length > remaining) result.incomplete = true
        message.content = message.content.slice(0,remaining)
        remaining -= message.content.length
        bounded.push(message)
      }
      const min = messages[0]?.seq ?? 0, max = messages.at(-1)?.seq ?? 0
      const count = (operator: string, seq: number) => (this.db.prepare(`SELECT COUNT(*) n FROM assistant_messages WHERE session_id=? AND visibility!='removed' AND seq ${operator} ?`).get(id, seq) as { n: number }).n
      result.sessions.push({ sessionId: id, title: session.title, agentId: session.agentId, link: `uniagent-session:${id}`, messages: bounded, messagesBefore: count('<', min), messagesAfter: count('>', max) })
    }
    return result
  }
  generation(): number { return (this.db.prepare('SELECT generation FROM personal_assistant').get() as { generation: number }).generation }
  invalidate(): void {
    this.db.prepare('UPDATE personal_assistant SET generation=generation+1').run()
    for (const job of this.jobs()) if (['queued','running'].includes(job.state)) this.setReviewState(job.id, 'stale', job.attempt)
    this.db.prepare('DELETE FROM assistant_review_stages').run()
  }
  invalidateAndForgetPast(): void {
    this.db.transaction(() => {
      this.invalidate()
      this.db.prepare('INSERT INTO assistant_review_cursors(session_id,seq) SELECT session_id,MAX(seq) FROM assistant_messages WHERE true GROUP BY session_id ON CONFLICT(session_id) DO UPDATE SET seq=MAX(seq,excluded.seq)').run()
    })()
  }
  jobs(): ReviewJob[] { return this.db.prepare('SELECT data FROM assistant_review_jobs ORDER BY rowid').all().map(row => decode<ReviewJob>(row)) }
  job(id: string): ReviewJob | undefined { const row = this.db.prepare('SELECT data FROM assistant_review_jobs WHERE id=?').get(id); return row ? decode<ReviewJob>(row) : undefined }
  enqueue(input: Pick<ReviewJob, 'sessionId' | 'turnKey' | 'throughSeq' | 'agentId' | 'model'>): ReviewJob {
    const existing = this.db.prepare('SELECT data FROM assistant_review_jobs WHERE session_id=? AND turn_key=?').get(input.sessionId, input.turnKey)
    if (existing) return decode<ReviewJob>(existing)
    const docs = this.documents()
    const job: ReviewJob = { ...input, id: randomUUID(), generation: this.generation(), userRevision: docs.find(d => d.type === 'user')!.revision, memoryRevision: docs.find(d => d.type === 'memory')!.revision, state: 'queued', attempt: 0, createdAt: Date.now() }
    this.db.prepare('INSERT INTO assistant_review_jobs(id,session_id,turn_key,data) VALUES (?,?,?,?)').run(job.id, job.sessionId, job.turnKey, JSON.stringify(job))
    return job
  }
  setReviewState(id: string, state: ReviewJob['state'], attempt: number, reason?: string): void {
    const job = this.job(id)
    if (!job) throw new Error('review_not_found')
    if (['queued','running'].includes(state) && !this.reviewValid(job)) { state = 'stale'; reason = '复盘上下文已更新' }
    this.db.prepare('UPDATE assistant_review_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...job, state, attempt, reason }), id)
    if (state !== 'running') this.db.prepare('DELETE FROM assistant_review_stages WHERE job_id=?').run(id)
  }
  private reviewValid(job: ReviewJob): boolean {
    const assistant = this.assistant(), docs = this.documents()
    return ['queued','running'].includes(job.state) && assistant.enabled && assistant.autoReviewEnabled && job.generation === this.generation() &&
      docs.find(d => d.type === 'user')!.revision === job.userRevision && docs.find(d => d.type === 'memory')!.revision === job.memoryRevision
  }
  commitReview(id: string): boolean {
    return this.db.transaction(() => {
      const job = this.job(id)
      if (!job) return false
      if (job.state !== 'running' || !this.reviewValid(job)) { this.setReviewState(id, 'stale', job.attempt); return false }
      const stage = this.db.prepare('SELECT data FROM assistant_review_stages WHERE job_id=?').get(id)
      if (stage) this.writeChanges(decode<AssistantDocument[]>(stage), { writer: 'auto_review', sessionId: job.sessionId, jobId: id })
      this.db.prepare('INSERT INTO assistant_review_cursors(session_id,seq) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET seq=MAX(seq,excluded.seq)').run(job.sessionId, job.throughSeq)
      this.setReviewState(id, 'complete', job.attempt)
      return true
    })()
  }
  reviewTranscript(id: string): IndexedMessage[] {
    const job = this.job(id)
    if (!job || !this.reviewValid(job)) throw new Error('stale_review')
    const cursor = (this.db.prepare('SELECT seq FROM assistant_review_cursors WHERE session_id=?').get(job.sessionId) as { seq: number } | undefined)?.seq || 0
    const rows = this.db.prepare("SELECT * FROM assistant_messages WHERE session_id=? AND seq>? AND seq<=? AND visibility!='removed' AND role IN ('user','assistant') ORDER BY seq DESC LIMIT 40").all(job.sessionId, cursor, job.throughSeq)
    let budget = 32000
    return rows.map(row => this.message(row)).filter(m => { if (budget <= 0) return false; m.content = m.content.slice(0, budget); budget -= m.content.length; return true }).reverse()
  }
  close(): void { this.db.close() }
}
