import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rm, realpath, stat, lstat, rmdir, rename, link } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import type { SessionConfig, UAEvent } from '../shared/types'
import type { Requirement, RequirementContextRequest, RequirementInput, RequirementPatch } from '../shared/requirementTypes'
import { atomicWrite } from './projectStore'
import { atomicWriteFile } from './sessionStore'
import { resolveUserDataHome } from './userData'
import { REQUIREMENT_GUIDE } from './requirementGuide'
import { readRequirementRouting, requirementRoutingSources, saveRequirementRouting, safeRead } from './requirementSpace'
import { isRequirementsEnabled } from './requirementRuntime'
import { stripAssistantContext } from './assistant/context'
import { readCuration, writeCuration, readTaskDigests, writeTaskDigest, validateTaskSummary } from './requirementCurationStore'
import { maintainRequirement } from './requirementMaintenance'
import { isSharedMemory, requirementRelevance } from './requirementMemory'
import { requirementOwnerByUsage } from '../shared/requirementOwnership'
import { initializeRequirement, publishRequirement, requirementContext, requirementSnapshot, requirementSync, requirementWrite, saveRequirementSync, readRequirementOverview, readingSources, readRequirementReading, saveRequirementReading, readingFailure, RequirementValidationError, type RequirementValidationIssue, type RequirementAccess } from './requirementSpace'

const statusLabels = { active: '进行中', done: '已完成', archived: '已归档' }
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
export const sourceEventId = (event: UAEvent): string => digest(JSON.stringify([event.sessionId, event.type,
  stripAssistantContext(String(event.payload.displayText || event.payload.text || event.payload.output || ''))]))
const safeName = (name: unknown): string => {
  if (typeof name !== 'string' || !name.trim()) throw new Error('请填写需求名称')
  const clean = name.normalize('NFC').trim().split(String.fromCharCode(92)).join('-').split('/').join('-').replace(/[\x00-\x1f<>:"|?*]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 70)
  if (!clean || clean === '.uniagent') throw new Error('需求名称无效')
  return clean
}

/** Managed writes: per-requirement queue, cross-process lock, revision check, atomic rename. */
export class RequirementStore {
  private readonly index: string
  private readonly root: string
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly renaming = new Set<string>()
  constructor(private readonly home = resolveUserDataHome(join(homedir(), '.uniagent-public')), private readonly changed: () => void = () => {}) {
    this.index = join(home, 'requirements.json')
    this.root = join(home, 'requirements')
    this.ensureBootstrap()
  }
  ensureBootstrap(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    mkdirSync(join(this.home, 'requirement-locks'), { recursive: true, mode: 0o700 })
    if (!existsSync(this.index)) atomicWrite(this.index, '[]')
    const guide = join(this.home, 'requirement-guide.md')
    if (!existsSync(guide) || readFileSync(guide, 'utf8') !== REQUIREMENT_GUIDE) atomicWrite(guide, REQUIREMENT_GUIDE)
    this.list() // Never silently discard a corrupt index.
  }
  list(): Requirement[] {
    return this.parseIndex(readFileSync(this.index, 'utf8'))
  }
  async listAsync(): Promise<Requirement[]> { return this.parseIndex(await readFile(this.index,'utf8')) }
  private parseIndex(content: string): Requirement[] {
    const rows: unknown = JSON.parse(content)
    if (!Array.isArray(rows)) throw new Error('需求索引损坏，请恢复 requirements.json')
    return rows.map((row: Requirement) => {
      if (!row || typeof row.id !== 'string' || !/^[\da-f-]{36}$/i.test(row.id) || typeof row.name !== 'string' ||
        (row.projectId !== undefined && (typeof row.projectId !== 'string' || !row.projectId)) ||
        (row.ownershipVersion !== undefined && row.ownershipVersion !== 1) ||
        !Object.hasOwn(statusLabels, row.status) || typeof row.dir !== 'string' || dirname(resolve(row.dir)) !== resolve(this.root) ||
        row.docPath !== join(row.dir, 'context.md')) throw new Error('需求索引中存在无效记录')
      return { ...row }
    })
  }
  get(id?: string): Requirement | undefined { return id ? this.list().find(r => r.id === id) : undefined }
  async readOverview(id: string, documentId?: string, query?: import('../shared/requirementTypes').RequirementOverviewQuery) {
    const r = this.require(id), overview = await readRequirementOverview(r, documentId, query)
    if (!documentId) {
      const curation = await readCuration(r)
      overview.curation = curation
      overview.tasks = Object.values(await readTaskDigests(r)).sort((a,b) => b.updatedAt-a.updatedAt).slice(0, 12)
      if (curation.updatedAt) overview.sync = { status: curation.current || curation.queue.length || curation.failures?.length ? 'pending' : 'synced', pendingCount: curation.queue.length + (curation.failures?.length || 0), reason: curation.lastError || (curation.failures?.length ? `${curation.failures.length} 项整理失败，已收集待处理` : undefined) }
    }
    return overview
  }
  readCuration(id: string) { return readCuration(this.require(id)) }
  async readCurationConversation(id: string): Promise<import('../shared/requirementTypes').RequirementCurationConversation> {
    const requirement = this.require(id), state = await readCuration(requirement)
    const recorded = await safeRead(requirement.dir, '.uniagent/curation-runtime/conversation.json').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (recorded !== undefined && !Array.isArray(recorded)) throw new Error('整理会话记录损坏，未重置')
    const events: UAEvent[] = recorded || (state.nativeThreadId
      ? await (await import('./history')).loadManagedCodexSessionEvents(join(requirement.dir, '.uniagent', 'curation-runtime', 'codex'), state.nativeThreadId)
      : [])
    return { requirementId: id, sessionId: state.sessionId, nativeThreadId: state.nativeThreadId, model: state.model, status: state.status,
      events: events.map(event => ({ ...event, sessionId: state.sessionId })) }
  }
  saveCurationConversation(id: string, events: import('../shared/types').UAEvent[]) {
    return this.serial(id, async () => { await requirementWrite(this.require(id).dir, '.uniagent/curation-runtime/conversation.json', JSON.stringify(events)) })
  }
  editCuration(id: string, edit: (state: import('../shared/requirementTypes').RequirementCurationState) => void) {
    return this.serial(id, async () => { const r = this.require(id), state = await readCuration(r); edit(state); await writeCuration(r, state); this.changed(); return state })
  }
  taskDigests(id: string) { return readTaskDigests(this.require(id)) }
  organizeExisting(id: string) {
    return this.serial(id, async () => {
      const r = this.require(id), snapshot = await requirementSnapshot(r)
      if (!snapshot) throw new Error('请先迁移旧格式需求')
      const prior = await readTaskDigests(r), groups = new Map<string, Array<(typeof snapshot.documents)[string]>>()
      for (const doc of Object.values(snapshot.documents)) {
        if (!isSharedMemory(doc) || !doc.summary || doc.summary.length > 400 || ['source','artifact'].includes(doc.kind)) continue
        for (const sessionId of new Set(doc.sources.map(source => source.sessionId).filter((value): value is string => !!value))) {
          const list = groups.get(sessionId) || []; list.push(doc); groups.set(sessionId, list)
        }
      }
      let imported = 0
      for (const [sessionId, docs] of groups) {
        if (prior[sessionId]) continue
        const sorted = docs.sort((a,b) => b.updatedAt-a.updatedAt)
        const intent = sorted.find(doc => doc.memory?.basis === 'user') || sorted[0]
        const chosen = [intent, ...sorted.filter(doc => doc.id !== intent.id)].slice(0,6)
        const basis = { user:'用户陈述', tool:'工具观察', agent:'Agent 报告', suggestion:'建议' }
        const digest: import('../shared/requirementTypes').RequirementTaskDigest = { sessionId, title:intent.title.slice(0,160), summary:intent.summary,
          work:[], results:chosen.map(doc => `${basis[doc.memory!.basis]}：${doc.summary}`), verification:['历史摘录尚未复核，不能据此认定当前实现或用户验收。'], remaining:[],
          sources:chosen.flatMap(doc => doc.sources).filter(source => source.kind !== 'reference').slice(0,12), documentIds:chosen.map(doc => doc.id),
          updatedAt:Math.max(...chosen.map(doc => doc.updatedAt)), throughSeq:-1, origin:'background', coverage:'partial', labels:[...new Set(chosen.map(doc => doc.memory!.topic))].slice(0,5) }
        validateTaskSummary(digest); prior[sessionId] = digest
        imported++
      }
      if (imported) await requirementWrite(r.dir,'.uniagent/task-digests.json',JSON.stringify(prior))
      const manifest = JSON.parse(await readFile(join(r.dir,'.uniagent/manifest.json'),'utf8'))
      if (!manifest.checkpoints) await publishRequirement(r, snapshot.documents, snapshot.operations)
      this.changed()
      return { imported, total:Object.keys(await readTaskDigests(r)).length }
    })
  }
  maintainStorage(id: string, token?: string) {
    return this.serial(id, async () => {
      const r = this.require(id), snapshot = await requirementSnapshot(r)
      if (!snapshot) throw new Error('请先迁移旧格式需求')
      if (!token) return maintainRequirement(r, snapshot, 'preview')
      const preview = await maintainRequirement(r, snapshot, 'archive', token)
      if (!preview.files) return preview
      await publishRequirement(r, snapshot.documents, snapshot.operations)
      // The packed current snapshot is durable and readable before any old file is removed.
      await requirementSnapshot(r)
      await maintainRequirement(r, snapshot, 'cleanup', token)
      this.changed()
      return preview
    })
  }
  saveTaskDigest(id: string, value: import('../shared/requirementTypes').RequirementTaskDigest) {
    return this.serial(id, async () => { await writeTaskDigest(this.require(id), value); this.changed() })
  }
  async taskEvidence(id: string, sessionId: string) {
    if (this.contextAccess.requirementId?.(sessionId) !== id || !this.contextAccess.events) throw new Error('原会话资料不可用')
    const events = await this.contextAccess.events(sessionId)
    const completed = events.findLast(event => event.type === 'turn_completed')?.seq ?? -1
    return events.filter(event => event.seq <= completed && ['user_message', 'goal_message', 'agent_message'].includes(event.type))
      .slice(-4).map(event => ({ sessionId, seq: event.seq, eventId: sourceEventId(event), kind: (['user_message','goal_message'].includes(event.type) && !this.contextAccess.isTeam?.(sessionId) && !this.contextAccess.isDelegated?.(sessionId) && event.payload.source !== 'mcp' ? 'user' : 'agent') as 'user' | 'agent', text: stripAssistantContext(String(event.payload.displayText || event.payload.text || '')).slice(0, 4000),
        images: (Array.isArray(event.payload.attachments) ? event.payload.attachments : []).filter((attachment: import('../shared/types').Attachment) => attachment.kind === 'image') }))
  }
  async latestTaskInput(id: string, sessionId: string) {
    if (this.contextAccess.requirementId?.(sessionId) !== id || !this.contextAccess.events) throw new Error('原会话资料不可用')
    return (await this.contextAccess.events(sessionId)).findLast(event => ['user_message', 'goal_message'].includes(event.type))?.seq ?? -1
  }
  readingSources(id: string) { return readingSources(this.require(id)) }
  readReading(id: string) { return readRequirementReading(this.require(id)) }
  readRouting(id: string) { return readRequirementRouting(this.require(id)) }
  routingSources(id: string) { return requirementRoutingSources(this.require(id)) }
  saveRouting(id: string, view: import('../shared/requirementTypes').RequirementRoutingView) { return this.serial(id, async () => { await saveRequirementRouting(this.require(id), view); this.changed() }) }
  saveReading(id: string, reading: import('../shared/requirementTypes').RequirementReading) { return this.serial(id, async () => { await saveRequirementReading(this.require(id), reading); this.changed() }) }
  readingFailure(id: string, revision: string, message: string) { return this.serial(id, async () => { await readingFailure(this.require(id), revision, message); this.changed() }) }
  private require(id: string): Requirement {
    const r = this.get(id)
    if (!r) throw new Error('需求不存在')
    if (!existsSync(r.dir) || !lstatSync(r.dir).isDirectory() || lstatSync(r.dir).isSymbolicLink()) throw new Error('需求目录不可用')
    for (const path of [r.docPath, join(r.dir, 'sources'), join(r.dir, '.uniagent')]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('需求目录包含无效的文档或资料链接')
    }
    return r
  }
  resolveSessionConfig(config: SessionConfig, validate = false): SessionConfig {
    const next = { ...config }
    delete next.requirementDir; delete next.requirementDocPath; delete next.requirementName
    if (!config.requirementId) return next
    // 功能关闭时保留 requirementId（数据不动）但不解析路径；
    // 路径清洗（上方 delete）必须保留，否则关闭开关反而放开了伪造路径注入。
    if (!isRequirementsEnabled()) return next
    if (validate && this.renaming.has(config.requirementId)) throw new Error('需求目录正在改名，请稍后重试')
    const r = this.get(config.requirementId)
    if (!r) { if (validate) throw new Error('所属需求不存在'); return next }
    if (validate) this.require(r.id)
    return { ...next, requirementDir: r.dir, requirementDocPath: r.docPath, requirementName: r.name }
  }
  migrateProjectBindings(sessions: Pick<import('../shared/types').Session, 'id' | 'config'>[], projectIds: ReadonlySet<string>): Promise<void> {
    return this.serial('index', async () => {
      const original = await readFile(this.index, 'utf8')
      const rows = this.parseIndex(original)
      if (!rows.some(row => row.ownershipVersion !== 1)) return
      const backup = 'requirements-before-ownership-v1.json'
      if (!existsSync(join(this.home, backup))) await requirementWrite(this.home, backup, original)
      const byRequirement = new Map<string, typeof sessions>()
      for (const session of sessions) {
        const id = session.config.requirementId
        if (!id) continue
        const group = byRequirement.get(id)
        if (group) group.push(session)
        else byRequirement.set(id, [session])
      }
      const next = rows.map(row => row.ownershipVersion === 1 ? row : {
        ...row, projectId: requirementOwnerByUsage(row, byRequirement.get(row.id) || [], projectIds), ownershipVersion: 1 as const
      })
      await requirementWrite(this.home, 'requirements.json', JSON.stringify(next, null, 2))
      this.changed()
    })
  }
  create(input: RequirementInput): Promise<Requirement> {
    return this.serial('index', async () => {
      const rows = this.list()
      const seed = safeName(input?.name)
      let name = seed, n = 2
      while (existsSync(join(this.root, name)) || rows.some(r => r.name.toLocaleLowerCase() === name.toLocaleLowerCase())) name = seed + ' ' + n++
      const dir = join(this.root, name)
      if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !input.projectId)) throw new Error('请选择有效空间')
      const r: Requirement = { id: randomUUID(), name, dir, docPath: join(dir, 'context.md'), status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
        ...(input.projectId ? { projectId: input.projectId, ownershipVersion: 1 as const } : {}) }
      mkdirSync(dir, { mode: 0o700 })
      try {
        await initializeRequirement(r)
        atomicWrite(this.index, JSON.stringify([...rows, r], null, 2))
      } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
      this.changed()
      return r
    })
  }
  async createForOperation(operationId: string, input: RequirementInput): Promise<Requirement> {
    if (!/^[a-f0-9-]{36}$/i.test(operationId)) throw new Error('invalid_requirement_operation')
    if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !input.projectId)) throw new Error('请选择有效空间')
    return this.serial('index',async()=>{
      const rows=await this.listAsync(), directory=join(this.home,'requirement-operations'), path=join(directory,operationId+'.json')
      await mkdir(directory,{recursive:true,mode:0o700})
      const fingerprint=digest(JSON.stringify({name:safeName(input.name),projectId:input.projectId}))
      let intent: {fingerprint:string; requirement:Requirement} | undefined
      try {intent=JSON.parse(await readFile(path,'utf8'))} catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      if(intent&&intent.fingerprint!==fingerprint)throw new Error('requirement_operation_conflict')
      if(!intent){
        if(rows.some(row=>row.id===operationId))throw new Error('requirement_operation_conflict')
        const name=safeName(input.name), dir=join(this.root,name+'-'+operationId.slice(0,8)), now=Date.now()
        if(rows.some(row=>row.dir===dir)||existsSync(dir))throw new Error('requirement_directory_conflict')
        intent={fingerprint,requirement:{id:operationId,name,dir,docPath:join(dir,'context.md'),status:'active',createdAt:now,updatedAt:now,
          ...(input.projectId?{projectId:input.projectId,ownershipVersion:1 as const}:{})}}
        await atomicWriteFile(path,JSON.stringify(intent))
      }
      const existing=rows.find(row=>row.id===intent!.requirement.id)
      if(existing)return existing
      const r=intent.requirement
      if(dirname(resolve(r.dir))!==resolve(this.root)||r.id!==operationId)throw new Error('invalid_requirement_operation')
      try { if (!(await lstat(r.dir)).isDirectory()) throw new Error('requirement_directory_conflict') }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await mkdir(r.dir,{recursive:true,mode:0o700})
      await initializeRequirement(r)
      await atomicWriteFile(this.index,JSON.stringify([...rows,r],null,2))
      this.changed();return r
    })
  }
  async update(id: string, patch: RequirementPatch, beforeRename?: () => void): Promise<Requirement> {
    if (this.renaming.has(id)) throw new Error('需求正在改名，请稍后重试')
    if (patch.name !== undefined) this.renaming.add(id)
    try { return await this.serial(id, () => this.serial('index', async () => {
      const old = this.require(id)
      if (patch.projectId !== undefined && (typeof patch.projectId !== 'string' || !patch.projectId)) throw new Error('请选择有效空间')
      if (patch.name === undefined && patch.status === undefined && patch.projectId !== undefined) {
        const next: Requirement = { ...old, projectId: patch.projectId, ownershipVersion: 1, updatedAt: Date.now() }
        await requirementWrite(this.home, 'requirements.json', JSON.stringify(this.list().map(r => r.id === id ? next : r), null, 2))
        this.changed()
        return next
      }
      const name = patch.name === undefined ? old.name : safeName(patch.name)
      const status = patch.status ?? old.status
      if (!Object.hasOwn(statusLabels, status)) throw new Error('需求状态无效')
      const rows = this.list()
      const dir = name === old.name ? old.dir : join(this.root, name)
      if (dir !== old.dir && (existsSync(dir) || rows.some(r => r.id !== id && r.name.toLocaleLowerCase() === name.toLocaleLowerCase()))) throw new Error('已存在同名需求')
      const next: Requirement = { ...old, name, status, dir, docPath: join(dir, 'context.md'), updatedAt: Date.now(),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId, ownershipVersion: 1 as const } : {}) }
      if (patch.name !== undefined && this.renaming.has(id)) beforeRename?.()
      const original = await readFile(old.docPath, 'utf8')
      const snapshot = await requirementSnapshot(old)
      if (dir !== old.dir) { beforeRename?.(); renameSync(old.dir, dir) }
      try {
        if (snapshot) await publishRequirement(next, { ...snapshot.documents, core: { ...snapshot.documents.core, title: name } }, snapshot.operations)
        atomicWrite(this.index, JSON.stringify(rows.map(r => r.id === id ? next : r), null, 2))
      } catch (error) {
        if (dir !== old.dir) renameSync(dir, old.dir)
        atomicWrite(old.docPath, original)
        throw error
      }
      this.changed()
      return next
    })) } finally { if (patch.name !== undefined) this.renaming.delete(id) }
  }
  clearProjectBindings(projectId: string): Promise<void> {
    return this.serial('index', () => {
      let changed = false
      const rows = this.list().map(r => {
        if (r.projectId !== projectId) return r
        const { projectId: _projectId, ...next } = r
        changed = true
        return { ...next, updatedAt: Date.now() }
      })
      if (changed) {
        atomicWrite(this.index, JSON.stringify(rows, null, 2))
        this.changed()
      }
    })
  }
  private contextAccess: { events?: (sessionId: string) => Promise<UAEvent[]>; requirementId?: (sessionId: string) => string | undefined; isTeam?: (sessionId: string) => boolean; isDelegated?: (sessionId: string) => boolean; workdir?: (sessionId: string) => string | undefined } = {}
  private pendingReads = new Map<string, { throughSeq: number; offset: number }>()
  configureContext(access: typeof this.contextAccess): void { this.contextAccess = access }
  async recoverSession(id: string, sessionId: string): Promise<boolean> {
    if (!this.contextAccess.events || this.contextAccess.requirementId?.(sessionId) !== id) throw new Error('原会话资料不可用')
    const events = await this.contextAccess.events(sessionId)
    if (this.contextAccess.requirementId?.(sessionId) !== id) return false
    const input = events.findLast(event => ['user_message', 'goal_message'].includes(event.type) || event.type === 'system_notice' && event.payload.kind === 'team_event')
    if (!input) return false
    const origin = this.contextAccess.isTeam?.(sessionId) || input.payload.source === 'mcp' || this.contextAccess.isDelegated?.(sessionId) && !input.payload.source ? 'team' : 'user'
    await this.recordInput(id, input, origin)
    const end = events.findLast(event => event.type === 'turn_completed' && event.seq > input.seq)
    if (end) await this.finishTurn(id, end)
    return true
  }
  invalidateKnowledge(id: string, projectId?: string): Promise<void> {
    return this.serial(id, async () => {
      const r = this.require(id), snapshot = await requirementSnapshot(r)
      if (!snapshot) return
      let changed = false
      for (const doc of Object.values(snapshot.documents)) if (doc.kind === 'knowledge' && doc.status === 'active' && doc.freshness === 'verified' && (!projectId || !doc.projectIds.length || doc.projectIds.includes(projectId))) { doc.freshness = 'needs-review'; changed = true }
      if (changed) { await publishRequirement(r, snapshot.documents, snapshot.operations); this.changed() }
    })
  }
  setBackgroundStatus(id: string, background: { status: 'pending' | 'unsupported' | 'failed' | 'synced'; reason?: string }): Promise<void> {
    return this.serial(id, async () => {
      const r = this.require(id), sync = await requirementSync(r)
      if (JSON.stringify(sync.background) === JSON.stringify(background)) return
      sync.background = background
      await saveRequirementSync(r, sync)
    })
  }

  context(id: string, sessionId: string, request: RequirementContextRequest, access: RequirementAccess = {}): Promise<any> {
    return this.serial(id, async () => {
      const r = this.require(id)
      if (request.action === 'sync_task') {
        if (access.readOnly || access.background) throw new Error('当前会话不能提交任务摘要')
        if (this.contextAccess.requirementId?.(sessionId) !== id) throw new Error('任务不属于当前需求')
        validateTaskSummary(request.task!)
        const sources = request.task!.sources || []
        for (const source of sources) {
          if (source.kind === 'reference') throw new Error('任务摘要引用事件作为依据，资料链接通过 artifact/source 登记')
          await this.verifySource(id, source)
        }
        const current = (await readTaskDigests(r))[sessionId]
        const { title, summary, work, results, verification, remaining } = request.task!
        const fingerprint = JSON.stringify({ title, summary, work, results, verification, remaining, sources })
        if (current && JSON.stringify({ title: current.title, summary: current.summary, work: current.work, results: current.results, verification: current.verification, remaining: current.remaining, sources: current.sources }) === fingerprint) return { ok: true, unchanged: true, sessionId }
        const events = await this.contextAccess.events?.(sessionId) || []
        const throughSeq = events.at(-1)?.seq ?? -1
        await writeTaskDigest(r, { ...request.task!, sources, sessionId, throughSeq, updatedAt: Date.now(), origin: 'agent', coverage: 'submitted' })
        this.changed()
        return { ok: true, sessionId, saved: true, organization: 'pending' }
      }
      if (request.action === 'read' && (request.documentId === 'tasks' || request.documentId?.startsWith('task:'))) {
        const tasks = await readTaskDigests(r)
        if (request.documentId.startsWith('task:')) {
          const task = tasks[request.documentId.slice(5)]
          if (!task) throw new Error('任务摘要不存在')
          return { task: { ...task, sources: task.sources?.map(({kind,sessionId,seq,eventId})=>({kind,sessionId,seq,eventId})) }, guide: '任务成果为 Agent 报告，background 表示有限片段补提取；不能据此认定验收。需要原文时按来源 sessionId 和 seq 按需回查。' }
        }
        const query = request.query?.trim().toLowerCase(), offset = request.offset ?? 0, limit = request.limit ?? 10
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('任务索引分页无效')
        const all = Object.values(tasks).filter(task => !query || [task.title, task.summary, ...task.work, ...(task.labels || [])].join(' ').toLowerCase().includes(query)).sort((a,b)=>b.updatedAt-a.updatedAt)
        return { tasks: all.slice(offset,offset+limit).map(({sessionId,title,summary,origin}) => ({sessionId,title,summary,origin,read:{documentId:'task:'+sessionId}})), total:all.length, nextOffset:offset+limit<all.length?offset+limit:null }
      }
      if (request.action === 'read' && request.sessionId) {
        if (this.contextAccess.requirementId?.(request.sessionId) !== id || !this.contextAccess.events) throw new Error('原会话不属于当前需求或已不可用')
        const limit=request.limit??4000, offset=request.offset??0, after=request.throughSeq??-1
        if (!Number.isInteger(limit)||limit<1||limit>16000||!Number.isInteger(offset)||offset<0||!Number.isInteger(after)||after< -1) throw new Error('原会话分页无效')
        const events=(await this.contextAccess.events(request.sessionId)).filter(event=>event.seq>(request.throughSeq??-1)&&['user_message','goal_message','agent_message','command_exec'].includes(event.type))
        const event=events[0]
        if(!event)return {sessionId:request.sessionId,events:[],next:null}
        const text=stripAssistantContext(String(event.payload.displayText||event.payload.text||event.payload.output||''))
        if(offset>text.length) throw new Error('原会话分页无效')
        return {sessionId:request.sessionId,events:[{seq:event.seq,type:event.type,eventId:sourceEventId(event),text:text.slice(offset,offset+limit)}],next:offset+limit<text.length?{throughSeq:request.throughSeq??-1,offset:offset+limit}:events.length>1?{throughSeq:event.seq,offset:0}:null}
      }
      if (request.action === 'pending') {
        const sourceId = request.sessionId || sessionId
        if (sourceId !== sessionId && !access.background) throw new Error('不能读取其他会话原文；共享信息请读取需求专题')
        if (this.contextAccess.requirementId?.(sourceId) !== id || !this.contextAccess.events) throw new Error('原会话资料不可用，未确认已整理')
        const cursor = (await requirementSync(r)).sessions[sourceId]
        const after = request.throughSeq ?? cursor?.processedSeq ?? -1
        const offset = request.offset ?? cursor?.processedOffset ?? 0
        if (!Number.isInteger(after) || after < -1 || !Number.isInteger(offset) || offset < 0) throw new Error('requirement_invalid_cursor')
        const key = id + ':' + sourceId + (access.background ? ':background' : ''), receipt = this.pendingReads.get(key)
        const atProcessed = after === (cursor?.processedSeq ?? -1) && offset === (cursor?.processedOffset ?? 0)
        if (!atProcessed && (!receipt || after !== receipt.throughSeq || offset !== receipt.offset)) throw new Error('不能跳过待整理增量，请从当前游标按 next 连续读取')
        const remember = (throughSeq: number, readOffset: number) => {
          this.pendingReads.set(key, { throughSeq, offset: readOffset })
        }
        const events = (await this.contextAccess.events(sourceId)).filter(ev => ev.seq > after && ev.seq <= (cursor?.throughSeq ?? -1) && (['user_message', 'goal_message'].includes(ev.type) || ev.seq <= (cursor?.completedSeq ?? -1) && ['agent_message', 'command_exec'].includes(ev.type)))
        const event = events[0]
        if (!event) { remember(cursor?.throughSeq ?? after, 0); return { sessionId: sourceId, events: [], throughSeq: cursor?.throughSeq ?? after, next: null } }
        const origin = this.contextAccess.isTeam?.(sourceId) || event.payload.source === 'mcp' || this.contextAccess.isDelegated?.(sourceId) && !event.payload.source ? 'team' : cursor?.origin || 'user'
        const text = String((origin === 'team' ? event.payload.text : event.payload.displayText) || event.payload.text || event.payload.output || '')
        if (offset > text.length) throw new Error('requirement_invalid_pagination')
        const more = offset + 16000 < text.length
        remember(more ? after : events.length > 1 ? event.seq : cursor?.throughSeq ?? event.seq, more ? offset + 16000 : 0)
        return { sessionId: sourceId, events: [{ seq: event.seq, eventId: sourceEventId(event), ts: event.ts, type: event.type, text: text.slice(offset, offset + 16000), origin, offset, totalLength: text.length }],
          throughSeq: more ? after : events.length > 1 ? event.seq : cursor?.throughSeq ?? event.seq, next: more ? { throughSeq: after, offset: offset + 16000 } : events.length > 1 ? { throughSeq: event.seq, offset: 0 } : null }
      }
      const result = await requirementContext(r, sessionId, request, { ...access, readThrough: this.pendingReads.get(id + ':' + sessionId + (access.background ? ':background' : '')), referenceVersion: async uri => {
        if (/^https?:\/\//.test(uri)) return undefined
        const roots = [r.dir, this.contextAccess.workdir?.(sessionId)].filter((p): p is string => !!p)
        let path: string
        try { path = await realpath(resolve(r.dir, uri)) } catch {
          return roots.some(root => { const rel = relative(resolve(root), resolve(r.dir, uri)); return !rel || rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) }) ? 'missing' : undefined
        }
        let allowed = false
        for (const root of roots) {
          const actual = await realpath(root).catch(() => undefined)
          if (!actual) continue
          const rel = relative(actual, path)
          if (!rel || rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) { allowed = true; break }
        }
        if (!allowed) {
          return undefined
        }
        const info = await stat(path)
        if (!info.isFile()) return undefined
        return info.size <= 2_000_000 ? 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex') : 'stat:' + info.size + ':' + info.mtimeMs
      }, verifySource: source => this.verifySource(id, source) })
      if (['commit', 'propose', 'migrate'].includes(request.action) && !result.unchanged && !result.duplicate) this.changed()
      if (request.action === 'bootstrap' && request.query?.trim()) {
        const query = request.query.toLowerCase()
        result.tasks = Object.values(await readTaskDigests(r)).map(task => ({task,score:requirementRelevance({id:task.sessionId,title:task.title,summary:task.summary,triggers:task.labels},query)})).filter(item => item.score>0)
          .sort((a,b)=>b.score-a.score||b.task.updatedAt-a.task.updatedAt).slice(0, 2).map(({task}) => ({ sessionId: task.sessionId, title: task.title, summary: task.summary, read: { documentId: 'task:' + task.sessionId } }))
      }
      return result
    })
  }
  private async verifySource(id: string, source: import('../shared/requirementTypes').RequirementSource): Promise<'user' | 'tool' | 'reference'> {
        const issues: RequirementValidationIssue[] = []
        const add = (path: string, code: string, message: string, hint: string): void => { issues.push({ path, code, message, hint }) }
        if (typeof source.sessionId !== 'string' || !source.sessionId || this.contextAccess.requirementId?.(source.sessionId) !== id) add('sessionId', 'source_session_invalid', 'requirement_invalid_source_proof：来源会话未关联当前需求', '使用 pending 返回的真实 sessionId；跨会话引用也须属于同一需求。')
        if (!Number.isInteger(source.seq) || source.seq! < 0) add('seq', 'source_seq_invalid', 'requirement_invalid_source_proof：来源序号必须是非负整数', '使用 pending 返回的真实 seq，不使用数组下标或猜测序号。')
        if (typeof source.quote !== 'string' || !source.quote.trim() || source.quote.length > 2000) add('quote', 'source_quote_invalid', 'requirement_invalid_source_proof：引用为空、类型错误或超过 2000 字', '逐字摘录同一事件中的非空连续文本，最多 2000 字。')
        if (!this.contextAccess.events) add('', 'source_verification_unavailable', '需求来源不可验证，请先保存为候选', '使用可读取历史的关联会话；无法验证时 propose 独立候选。')
        if (issues.length) throw new RequirementValidationError(issues)
        if (source.eventId !== undefined && !/^[a-f0-9]{64}$/.test(source.eventId)) add('eventId', 'source_event_id_invalid', '来源稳定标识无效', '使用 pending 或已保存来源返回的 eventId，不自行生成。')
        if (issues.length) throw new RequirementValidationError(issues)
        const matches = (await this.contextAccess.events!(source.sessionId!)).filter(ev => source.eventId ? sourceEventId(ev) === source.eventId : ev.seq === source.seq)
        const event = matches.length === 1 ? matches[0] : undefined
        if (!event) { add('seq', 'source_event_not_found', '来源事件不存在，无法核对原文', '重新 pending 并完成分页，核对 sessionId 与 seq 后重试。'); throw new RequirementValidationError(issues) }
        const preferred = this.contextAccess.isTeam?.(source.sessionId!) || event.payload.source === 'mcp' ? 'text' : 'displayText'
        const field = event.payload[preferred] ? preferred : event.payload.text ? 'text' : event.payload.output ? 'output' : preferred
        const text = String(event.payload[field] || '')
        if (!text.includes(source.quote!)) add('quote', 'source_quote_mismatch', '来源原文与引用不符', `本事件核对 payload.${field}；重新读取并逐字摘录连续文本，不改写、拼接或使用其它事件的内容。`)
        if (source.kind === 'user' && (this.contextAccess.isTeam?.(source.sessionId!) || event.payload.source === 'mcp' || this.contextAccess.isDelegated?.(source.sessionId!) && !event.payload.source || !['user_message', 'goal_message'].includes(event.type))) add('kind', 'source_kind_mismatch', '团队派单或 Agent 输出不是用户确认', `该事件类型为 ${event.type}；user 只引用普通会话的真实 user_message/goal_message，建议保存为 proposal。`)
        if (source.kind === 'tool' && event.type !== 'command_exec') add('kind', 'source_kind_mismatch', '技术事实必须引用实际工具证据', `该事件类型为 ${event.type}；tool 需要引用真实 command_exec 事件，不能将其它输出改标为工具证据。`)
        if (source.kind === 'agent' && !['agent_message', 'user_message', 'goal_message', 'system_notice'].includes(event.type)) add('kind', 'source_kind_mismatch', 'requirement_invalid_source_proof：事件类型不支持 agent 来源', 'agent 仅用于 Agent 消息或讨论参考；command_exec 应按真实类型使用 tool。')
        if (issues.length) throw new RequirementValidationError(issues)
        source.eventId = sourceEventId(event)
        return source.kind === 'agent' ? 'reference' : source.kind
  }
  recordInput(id: string, event: UAEvent, origin: 'user' | 'team' = 'user', projectId?: string): Promise<void> {
    return this.serial(id, async () => {
      let r = this.require(id)
      if (projectId && !r.projectId) r = await this.serial('index', async () => {
        const current = this.require(id)
        if (current.projectId) return current
        const next = { ...current, projectId, updatedAt: Date.now() }
        await requirementWrite(this.home, 'requirements.json', JSON.stringify(this.list().map(item => item.id === id ? next : item), null, 2))
        this.changed()
        return next
      })
      if (!await requirementSnapshot(r)) return
      const sync = await requirementSync(r)
      const old = sync.sessions[event.sessionId]
      if (old && old.throughSeq >= event.seq) return
      sync.sessions[event.sessionId] = { throughSeq: event.seq, completedSeq: old?.completedSeq ?? -1, processedSeq: old?.processedSeq ?? -1, processedOffset: old?.processedOffset ?? 0, origin, status: 'pending' }
      await saveRequirementSync(r, sync)
    })
  }
  finishTurn(id: string, event: UAEvent): Promise<void> {
    return this.serial(id, async () => {
      const r = this.require(id)
      if (!await requirementSnapshot(r)) return
      const sync = await requirementSync(r), cursor = sync.sessions[event.sessionId]
      if (!cursor || event.seq <= cursor.throughSeq) return
      cursor.throughSeq = event.seq
      cursor.completedSeq = event.seq
      cursor.status = event.state === 'success' ? 'pending' : 'interrupted'
      await saveRequirementSync(r, sync)
    })
  }
  private serial<T>(id: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(id) || Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      const lock = join(this.home, 'requirement-locks', digest(id) + '.lock')
      const started = Date.now()
      while (true) {
        try {
          await mkdir(lock)
          try { await requirementWrite(lock, 'owner', String(process.pid)) }
          catch (error) { await rm(lock, { recursive: true, force: true }); throw error }
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const ownerPath = join(lock, 'owner')
          const readOwner = () => readFile(ownerPath, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return undefined
            throw error
          })
          const identity = await lstat(lock).catch(error => { if (error.code !== 'ENOENT') throw error })
          if (!identity) continue
          const owner = await readOwner(), pid = Number(owner)
          const validPid = Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff
          let abandoned = !validPid && Date.now() - identity.mtimeMs > 30_000
          if (validPid) {
            try { process.kill(pid, 0) } catch (e) {
              abandoned = (e as NodeJS.ErrnoException).code === 'ESRCH'
            }
          }
          if (abandoned) {
            const recovery = lock + '.recovery', savedOwner = join(recovery, 'owner')
            let claimed = false, restorePending = false
            const restoreOwner = async () => {
              if (!restorePending) return
              try { await link(savedOwner, ownerPath) } catch (error) {
                if (!['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) throw error
              }
              restorePending = false
            }
            try {
              await mkdir(recovery); claimed = true
              const current = await lstat(lock)
              if (current.dev !== identity.dev || current.ino !== identity.ino || current.mtimeMs !== identity.mtimeMs || await readOwner() !== owner) continue
              if (owner !== undefined) {
                await rename(ownerPath, savedOwner); restorePending = true
                if (await readFile(savedOwner, 'utf8') !== owner) { await restoreOwner(); continue }
              }
              const remaining = await lstat(lock)
              if (remaining.dev !== identity.dev || remaining.ino !== identity.ino) { await restoreOwner(); continue }
              // Atomic empty-directory removal preserves an owner published during recovery.
              await rmdir(lock); restorePending = false
              continue
            } catch (reason) {
              await restoreOwner()
              if (!['EEXIST', 'ENOENT', 'ENOTEMPTY'].includes((reason as NodeJS.ErrnoException).code || '')) throw reason
            } finally { if (claimed && !restorePending) await rm(recovery, { recursive: true, force: true }) }
          }
          if (Date.now() - started > 30_000) throw new Error('需求文档写入等待超时，请稍后重试')
          await new Promise(resolve => setTimeout(resolve, 80))
        }
      }
      try { return await operation() } finally { await rm(lock, { recursive: true, force: true }) }
    })
    this.queues.set(id, next)
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id) }).catch(() => {})
    return next
  }
}
