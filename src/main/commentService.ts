import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { agentForSession, type AgentDef, type Session, type SessionConfig, type UAEvent } from '../shared/types'
import { withAgentDefaults, resolveAgentPermission, resolveModelEffort, resolveModelThinking } from '../shared/agentChoices'
import { COMMENT_QUESTION_MAX_CHARS, commentAnchor, commentPrompt, findCommentSource, interruptCommentEvents, type CommentModel, type CommentSelection, type CommentThread } from '../shared/comments'
import { CommentStore, type StoredComment } from './commentStore'
import type { CommentRuntime, CommentRuntimeCallbacks } from './commentRuntime'

export interface CommentDependencies {
  store: CommentStore
  session(id: string): Session | undefined
  events(id: string): Promise<UAEvent[]>
  agent(id: string): AgentDef | undefined
  readFile(session: Session, path: string): Promise<string>
  ready(id: string): Promise<void>
  runtime(config: SessionConfig, callbacks: CommentRuntimeCallbacks, id: string): CommentRuntime
}

export class CommentService extends EventEmitter {
  private owners = new Map<string, Promise<StoredComment[]>>()
  private runtimes = new Map<string, CommentRuntime>()
  private generations = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private busy = new Set<string>()
  private closing = new Set<Promise<void>>()
  private active = new Map<string, StoredComment>()
  private closed = false
  constructor(private deps: CommentDependencies) { super() }
  hasActiveWork(): boolean { return this.active.size > 0 }
  activities(): Array<{ id: string; title: string; status: string; revision: string }> {
    return [...this.active.values()].map(row => ({ id: `comment:${row.id}`, title: `侧边评论：${row.anchor.quote.slice(0, 40)}`, status: row.status, revision: String(row.updatedAt) }))
  }
  private owner(id: string): Session {
    const session = this.deps.session(id)
    if (!session) throw new Error('当前会话不可用')
    return session
  }
  private rows(id: string): Promise<StoredComment[]> {
    this.owner(id)
    let rows = this.owners.get(id)
    if (!rows) {
      rows = this.deps.store.load(id).catch(error => { this.owners.delete(id); throw error })
      this.owners.set(id, rows)
    }
    return rows
  }
  private public(row: StoredComment): CommentThread {
    const { context, sourceContent, parentConfig, ...thread } = row
    return thread
  }
  async list(id: string): Promise<CommentThread[]> { return (await this.rows(id)).map(row => this.public(row)) }
  private async row(owner: string, id: string): Promise<StoredComment> {
    const row = (await this.rows(owner)).find(row => row.id === id)
    if (!row) throw new Error('评论不存在或不属于当前会话')
    return row
  }
  private publish(row: StoredComment): void {
    row.updatedAt = Date.now()
    this.emit('changed', this.public(row))
  }
  private async save(owner: string): Promise<void> { await this.deps.store.save(owner, await this.rows(owner)) }
  private dispose(id: string): void {
    const runtime = this.runtimes.get(id)
    this.runtimes.delete(id)
    if (!runtime) return
    const closing = Promise.resolve(runtime.dispose()).catch(() => {})
    this.closing.add(closing)
    void closing.finally(() => this.closing.delete(closing))
  }
  private schedule(row: StoredComment): void {
    if (this.timers.has(row.id)) return
    const generation = this.generations.get(row.id)
    this.timers.set(row.id, setTimeout(() => {
      this.timers.delete(row.id)
      this.publish(row)
      void this.save(row.sessionId).catch(error => { if (this.generations.get(row.id) === generation) { row.error = `评论保存失败：${String(error)}`; this.publish(row) } })
    }, 300))
  }
  async create(id: string, selection: CommentSelection): Promise<CommentThread> {
    const parent = this.owner(id)
    if (parent.readOnly || parent.archived) throw new Error('当前会话仅供阅读')
    const baseAgent = this.deps.agent(parent.config.agentId)
    const agent = baseAgent && agentForSession(baseAgent, parent)
    const config = withAgentDefaults(agent, { ...parent.config })
    config.permissionMode ||= resolveAgentPermission(agent)
    const context = structuredClone(await this.deps.events(id))
    let source = selection.selectedMessageText
    let messageId: string | undefined
    let turnId: string | undefined
    let sourceSeq = selection.seq
    if (selection.filePath) {
      if (!/\.(md|mdx|markdown)$/i.test(selection.filePath)) throw new Error('仅支持 Markdown 文件评论')
      source = await this.deps.readFile(parent, selection.filePath)
      // Offsets use rendered Markdown text; retain the verified file as context.
    } else {
      const event = findCommentSource(context, selection)
      if (!event || typeof event.payload.text !== 'string') throw new Error('原回复已不存在，请重新选择')
      source = event.payload.text
      messageId = event.payload.id
      turnId = event.payload.turnId
      sourceSeq = event.seq
    }
    const anchor = commentAnchor({ ...selection, seq: sourceSeq }, messageId, turnId)
    if (selection.sourceText !== undefined && selection.sourceText !== source) throw new Error('原文已变化，请重新选择')
    const row: StoredComment = { id: randomUUID(), sessionId: id, createdAt: Date.now(), updatedAt: Date.now(), anchor,
      config, parentConfig: structuredClone(config), context, sourceContent: source, events: [], status: 'draft' }
    const rows = await this.rows(id)
    rows.push(row)
    try { await this.save(id) } catch (error) { rows.splice(rows.indexOf(row), 1); throw error }
    this.publish(row)
    return this.public(row)
  }
  private config(row: StoredComment, model: CommentModel): SessionConfig {
    const session = this.owner(row.sessionId)
    const parent = session.config
    if (model.agentId !== parent.agentId) throw new Error('评论只能使用主会话当前 Agent 的模型')
    const baseAgent = this.deps.agent(model.agentId)
    const agent = baseAgent && agentForSession(baseAgent, session)
    const permission = resolveAgentPermission(agent, parent.permissionMode)
    if (!agent) throw new Error('所选 Agent 不可用')
    if (permission && !agent.capabilities.permissionModes.some(mode => mode.id === permission))
      throw new Error('当前 Agent 无法继承主会话的权限模式，请刷新 Agent 状态后重试')
    const selected = agent.models.find(item => item.id === model.model)
    if (model.model && !selected && !(model.agentId === row.config.agentId && model.model === row.config.model) && model.model !== parent.model)
      throw new Error('所选模型不可用，请重新选择')
    return withAgentDefaults(agent, { agentId: agent.id, workdir: parent.workdir,
      additionalDirectories: parent.additionalDirectories, permissionMode: permission,
      model: model.model, modelSource: selected?.modelSource || (model.agentId === row.config.agentId && model.model === row.config.model
        ? row.config.modelSource : model.model === parent.model ? parent.modelSource : undefined),
      zcodeModelSelection: selected?.zcodeSelection,
      effort: resolveModelEffort(selected, row.config.effort), kimiThinking: resolveModelThinking(selected, row.config.kimiThinking) })
  }
  async send(owner: string, id: string, question: string, model?: CommentModel, clientTurnKey?: string): Promise<void> {
    if (this.closed) throw new Error('应用正在关闭')
    const row = await this.row(owner, id)
    if (typeof question !== 'string' || !question.trim()) throw new Error('请填写问题')
    if (question.trim().length > COMMENT_QUESTION_MAX_CHARS) throw new Error('评论问题过长，请缩短后重试')
    if (this.owner(owner).readOnly || this.owner(owner).archived) throw new Error('当前会话仅供阅读')
    const parentConfig = this.owner(owner).config
    const choice = model || { agentId: parentConfig.agentId, model: row.config.agentId === parentConfig.agentId ? row.config.model : parentConfig.model }
    if (choice.agentId !== parentConfig.agentId) throw new Error('评论只能使用主会话当前 Agent 的模型')
    if (this.busy.has(id) || ['running', 'awaiting-approval'].includes(row.status)) throw new Error('评论正在回答中')
    this.busy.add(id)
    this.active.set(id, row)
    const operation = (this.generations.get(id) || 0) + 1
    // A reused runtime keeps its callback generation; only a new runtime needs a new one.
    const previousGeneration = this.generations.get(id)
    let generation = previousGeneration
    const notStopped = (): boolean => !this.closed && this.generations.get(id) === generation
    const history = row.events.slice()
    const seq = Math.max(0, ...row.events.map(event => event.seq)) + 1
    row.events.push({ sessionId: owner, seq, ts: Date.now(), type: 'user_message', payload: { text: question.trim(), id: randomUUID(), ...(clientTurnKey ? { clientTurnKey } : {}) } })
    row.status = 'running'; row.error = undefined
    try {
      await this.save(owner)
      if (!notStopped()) return
      this.publish(row)
      await this.deps.ready(choice.agentId)
      if (!notStopped()) return
      const config = this.config(row, choice)
      const changedModel = config.agentId !== row.config.agentId || config.model !== row.config.model ||
        config.permissionMode !== row.config.permissionMode || config.workdir !== row.config.workdir ||
        JSON.stringify(config.additionalDirectories) !== JSON.stringify(row.config.additionalDirectories)
      if (changedModel) this.dispose(id)
      row.config = config
      const fresh = !this.runtimes.has(id)
      if (fresh) { generation = operation; this.generations.set(id, generation) }
      const prompt = commentPrompt(row.sourceContent, row.anchor, question.trim(), fresh ? history : undefined, fresh ? row.context : undefined)
      await this.save(owner)
      if (!notStopped()) return
      this.publish(row)
      if (fresh) {
        const runtimeGeneration = generation
        const valid = (): boolean => this.generations.get(id) === runtimeGeneration
        const eventKeys = new Map<string, number>()
        const runtime = this.deps.runtime(config, {
          event: event => {
            if (!valid() || event.type === 'user_message') return
            const key = `${event.type}:${event.payload.id ?? event.seq}`
            let targetSeq = eventKeys.get(key)
            if (targetSeq === undefined) { targetSeq = Math.max(0, ...row.events.map(item => item.seq)) + 1; eventKeys.set(key, targetSeq) }
            const next = { ...structuredClone(event), sessionId: owner, seq: targetSeq }
            const existing = row.events.findIndex(item => item.seq === targetSeq)
            if (existing < 0) row.events.push(next); else row.events[existing] = next
            if (event.type === 'error') row.error = String(event.payload.message || '回答失败')
            this.schedule(row)
          },
          status: status => {
            if (!valid()) return
            row.status = ['running', 'queued', 'cancelling'].includes(status) ? 'running' : status === 'awaiting-approval' ? 'awaiting-approval'
              : status === 'cancelled' || status === 'interrupted' ? 'interrupted' : row.error || status === 'error' ? 'error' : 'idle'
            if (!['running', 'awaiting-approval'].includes(row.status)) this.active.delete(id)
            if (row.status === 'error') { this.generations.set(id, (runtimeGeneration || 0) + 1); this.dispose(id) }
            this.publish(row); this.schedule(row)
          }
        }, id)
        this.runtimes.set(id, runtime)
      }
      await this.runtimes.get(id)!.send(prompt)
    } catch (error) { if (!notStopped()) return; this.generations.set(id, (generation || 0) + 1); this.dispose(id); row.status = 'error'; row.error = error instanceof Error ? error.message : String(error); this.publish(row); this.schedule(row); throw error }
    finally { this.busy.delete(id); if (!['running', 'awaiting-approval'].includes(row.status)) this.active.delete(id) }
  }
  async stop(owner: string, id: string): Promise<void> {
    const row = await this.row(owner, id)
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    this.active.delete(id)
    this.runtimes.get(id)?.stop(); this.dispose(id)
    row.status = 'interrupted'; row.events = interruptCommentEvents(row.events); this.publish(row); await this.save(owner)
  }
  async remove(owner: string, id: string): Promise<void> {
    const row = await this.row(owner, id)
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    this.active.delete(id)
    this.runtimes.get(id)?.stop(); this.dispose(id)
    row.status = 'interrupted'; row.events = interruptCommentEvents(row.events)
    const timer = this.timers.get(id)
    if (timer) { clearTimeout(timer); this.timers.delete(id) }
    const rows = await this.rows(owner)
    const position = rows.indexOf(row)
    if (position < 0) return
    rows.splice(position, 1)
    try { await this.save(owner) }
    catch (error) { rows.splice(position, 0, row); this.publish(row); throw error }
    this.emit('removed', { sessionId: owner, id })
  }
  async respond(owner: string, id: string, request: string, answer: unknown): Promise<void> {
    const row = await this.row(owner, id)
    const parent = this.owner(owner)
    if (parent.readOnly || parent.archived || this.scopeChanged(row, parent)) throw new Error('主会话权限已变化，请重新提问')
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('当前评论没有待处理请求')
    await runtime.respond(request, answer)
  }
  private scopeChanged(row: StoredComment, parent: Session): boolean {
    const baseAgent = this.deps.agent(parent.config.agentId)
    const permission = resolveAgentPermission(baseAgent && agentForSession(baseAgent, parent), parent.config.permissionMode)
    return parent.config.agentId !== row.config.agentId || permission !== row.config.permissionMode || parent.config.workdir !== row.config.workdir ||
      JSON.stringify(parent.config.additionalDirectories) !== JSON.stringify(row.config.additionalDirectories)
  }
  async syncPermissions(parent: Session): Promise<void> {
    const rows = this.owners.get(parent.id)
    if (!rows) return
    for (const row of await rows) {
      if ((this.busy.has(row.id) || ['running', 'awaiting-approval'].includes(row.status)) &&
          (parent.readOnly || parent.archived || this.scopeChanged(row, parent))) await this.stop(parent.id, row.id)
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.active.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const id of this.runtimes.keys()) { this.generations.set(id, -1); this.dispose(id) }
    await Promise.allSettled([...this.closing])
    await Promise.allSettled([...this.owners.keys()].map(id => this.save(id)))
    await this.deps.store.close()
  }
}
