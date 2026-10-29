import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rm, realpath, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import type { SessionConfig, UAEvent } from '../shared/types'
import type { Requirement, RequirementContextRequest, RequirementInput, RequirementPatch } from '../shared/requirementTypes'
import { atomicWrite } from './projectStore'
import { resolveUserDataHome } from './userData'
import { REQUIREMENT_GUIDE } from './requirementGuide'
import { isRequirementsEnabled } from './requirementRuntime'
import { initializeRequirement, publishRequirement, requirementContext, requirementSnapshot, requirementSync, requirementWrite, saveRequirementSync, type RequirementAccess } from './requirementSpace'

const statusLabels = { active: '进行中', done: '已完成', archived: '已归档' }
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
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
    const rows: unknown = JSON.parse(readFileSync(this.index, 'utf8'))
    if (!Array.isArray(rows)) throw new Error('需求索引损坏，请恢复 requirements.json')
    return rows.map((row: Requirement) => {
      if (!row || typeof row.id !== 'string' || !/^[\da-f-]{36}$/i.test(row.id) || typeof row.name !== 'string' ||
        (row.projectId !== undefined && (typeof row.projectId !== 'string' || !row.projectId)) ||
        !Object.hasOwn(statusLabels, row.status) || typeof row.dir !== 'string' || dirname(resolve(row.dir)) !== resolve(this.root) ||
        row.docPath !== join(row.dir, 'context.md')) throw new Error('需求索引中存在无效记录')
      return { ...row }
    })
  }
  get(id?: string): Requirement | undefined { return id ? this.list().find(r => r.id === id) : undefined }
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
    // 功能关闭时保留 requirementId（数据不动）但不解析路径、不并入 additionalDirectories；
    // 路径清洗（上方 delete）必须保留，否则关闭开关反而放开了伪造路径注入。
    if (!isRequirementsEnabled()) return next
    if (validate && this.renaming.has(config.requirementId)) throw new Error('需求目录正在改名，请稍后重试')
    const r = this.get(config.requirementId)
    if (!r) { if (validate) throw new Error('所属需求不存在'); return next }
    if (validate) this.require(r.id)
    return { ...next, requirementDir: r.dir, requirementDocPath: r.docPath, requirementName: r.name,
      additionalDirectories: [...new Set([...(config.additionalDirectories || []), r.dir])] }
  }
  create(input: RequirementInput): Promise<Requirement> {
    return this.serial('index', async () => {
      const rows = this.list()
      const seed = safeName(input?.name)
      let name = seed, n = 2
      while (existsSync(join(this.root, name)) || rows.some(r => r.name.toLocaleLowerCase() === name.toLocaleLowerCase())) name = seed + ' ' + n++
      const dir = join(this.root, name)
      const r: Requirement = { id: randomUUID(), name, dir, docPath: join(dir, 'context.md'), status: 'active', createdAt: Date.now(), updatedAt: Date.now() }
      mkdirSync(dir, { mode: 0o700 })
      try {
        await initializeRequirement(r)
        atomicWrite(this.index, JSON.stringify([...rows, r], null, 2))
      } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
      this.changed()
      return r
    })
  }
  async update(id: string, patch: RequirementPatch, beforeRename?: () => void): Promise<Requirement> {
    if (this.renaming.has(id)) throw new Error('需求正在改名，请稍后重试')
    if (patch.name !== undefined) this.renaming.add(id)
    try { return await this.serial(id, () => this.serial('index', async () => {
      const old = this.require(id)
      const name = patch.name === undefined ? old.name : safeName(patch.name)
      const status = patch.status ?? old.status
      if (!Object.hasOwn(statusLabels, status)) throw new Error('需求状态无效')
      const rows = this.list()
      const dir = name === old.name ? old.dir : join(this.root, name)
      if (dir !== old.dir && (existsSync(dir) || rows.some(r => r.id !== id && r.name.toLocaleLowerCase() === name.toLocaleLowerCase()))) throw new Error('已存在同名需求')
      const next: Requirement = { ...old, name, status, dir, docPath: join(dir, 'context.md'), updatedAt: Date.now() }
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
      if (request.action === 'pending') {
        const sourceId = request.sessionId || sessionId
        if (sourceId !== sessionId && !access.background) throw new Error('不能读取其他会话原文；共享信息请读取需求专题')
        if (this.contextAccess.requirementId?.(sourceId) !== id || !this.contextAccess.events) throw new Error('原会话资料不可用，未确认已整理')
        const cursor = (await requirementSync(r)).sessions[sourceId]
        const after = request.throughSeq ?? cursor?.processedSeq ?? -1
        const offset = request.offset ?? cursor?.processedOffset ?? 0
        if (!Number.isInteger(after) || after < -1 || !Number.isInteger(offset) || offset < 0) throw new Error('requirement_invalid_cursor')
        const key = id + ':' + sourceId, receipt = this.pendingReads.get(key)
        const atProcessed = after === (cursor?.processedSeq ?? -1) && offset === (cursor?.processedOffset ?? 0)
        if (!atProcessed && (!receipt || after !== receipt.throughSeq || offset !== receipt.offset)) throw new Error('不能跳过待整理增量，请从当前游标按 next 连续读取')
        const remember = (throughSeq: number, readOffset: number) => {
          if (!receipt || throughSeq > receipt.throughSeq || throughSeq === receipt.throughSeq && readOffset > receipt.offset) this.pendingReads.set(key, { throughSeq, offset: readOffset })
        }
        const events = (await this.contextAccess.events(sourceId)).filter(ev => ev.seq > after && ev.seq <= (cursor?.throughSeq ?? -1) && (['user_message', 'goal_message'].includes(ev.type) || ev.seq <= (cursor?.completedSeq ?? -1) && ['agent_message', 'command_exec'].includes(ev.type)))
        const event = events[0]
        if (!event) { remember(cursor?.throughSeq ?? after, 0); return { sessionId: sourceId, events: [], throughSeq: cursor?.throughSeq ?? after, next: null } }
        const origin = this.contextAccess.isTeam?.(sourceId) || event.payload.source === 'mcp' || this.contextAccess.isDelegated?.(sourceId) && !event.payload.source ? 'team' : cursor?.origin || 'user'
        const text = String((origin === 'team' ? event.payload.text : event.payload.displayText) || event.payload.text || event.payload.output || '')
        if (offset > text.length) throw new Error('requirement_invalid_pagination')
        const more = offset + 16000 < text.length
        remember(more ? after : events.length > 1 ? event.seq : cursor?.throughSeq ?? event.seq, more ? offset + 16000 : 0)
        return { sessionId: sourceId, events: [{ seq: event.seq, type: event.type, text: text.slice(offset, offset + 16000), origin, offset, totalLength: text.length }],
          throughSeq: more ? after : events.length > 1 ? event.seq : cursor?.throughSeq ?? event.seq, next: more ? { throughSeq: after, offset: offset + 16000 } : events.length > 1 ? { throughSeq: event.seq, offset: 0 } : null }
      }
      const result = await requirementContext(r, sessionId, request, { ...access, readThrough: this.pendingReads.get(id + ':' + sessionId), referenceVersion: async uri => {
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
      }, verifySource: async source => {
        if (!source.sessionId || this.contextAccess.requirementId?.(source.sessionId) !== id || !this.contextAccess.events || !Number.isInteger(source.seq) || typeof source.quote !== 'string' || !source.quote.trim() || source.quote.length > 2000) throw new Error('requirement_invalid_source_proof')
        const event = (await this.contextAccess.events(source.sessionId)).find(ev => ev.seq === source.seq)
        const text = event && String((this.contextAccess.isTeam?.(source.sessionId) || event.payload.source === 'mcp' ? event.payload.text : event.payload.displayText) || event.payload.text || event.payload.output || '')
        if (!event || !text?.includes(source.quote)) throw new Error('来源原文与引用不符')
        if (source.kind === 'user' && (this.contextAccess.isTeam?.(source.sessionId) || event.payload.source === 'mcp' || this.contextAccess.isDelegated?.(source.sessionId) && !event.payload.source || !['user_message', 'goal_message'].includes(event.type))) throw new Error('团队派单或 Agent 输出不是用户确认')
        if (source.kind === 'tool' && event.type !== 'command_exec') throw new Error('技术事实必须引用实际工具证据')
        if (source.kind === 'agent' && !['agent_message', 'user_message', 'goal_message', 'system_notice'].includes(event.type)) throw new Error('requirement_invalid_source_proof')
        return source.kind === 'agent' ? 'reference' : source.kind
      } })
      if (['commit', 'propose', 'migrate'].includes(request.action) && !result.unchanged && !result.duplicate) this.changed()
      return result
    })
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
          const pid = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => ''))
          if (pid > 0) {
            try { process.kill(pid, 0) } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
                // Serialize stale-owner cleanup and recheck: never delete a successor's lock.
                const recovery = lock + '.recovery'
                let claimed = false
                try {
                  await mkdir(recovery); claimed = true
                  const owner = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => ''))
                  if (owner === pid) await rm(lock, { recursive: true, force: true })
                } catch (reason) {
                  if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
                } finally { if (claimed) await rm(recovery, { recursive: true, force: true }) }
              }
            }
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
