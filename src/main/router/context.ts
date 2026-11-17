import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project, Session, TaskTitleSeed, UAEvent } from '../../shared/types'
import type { Requirement, RequirementOverview } from '../../shared/requirementTypes'
import type { RouterObject, RouterSource } from '../../shared/router'
import { stripAssistantContext } from '../assistant/context'
import { routerTargetVersion } from './target'
import { isTaskTitleEligible, taskDisplayTitle } from '../../shared/taskTitle'
import { isSessionBusy } from '../../shared/sessionStatus'
import { routingDescription } from '../requirementRouting'

interface ContextSources {
  projects: () => Project[]
  requirements: () => Promise<Requirement[]>
  overview: (id: string, document: 'core' | 'state', offset?: number) => Promise<RequirementOverview>
  sessions: () => Session[]
  events: (id: string) => Promise<UAEvent[]>
  seed: (session: Session) => TaskTitleSeed | undefined
  routing?: (id: string) => ReturnType<import('../requirementStore').RequirementStore['readRouting']>
}
function source(id: string, kind: string, text: string, at: number, title: string, metadata: Partial<Pick<RouterSource, 'kind' | 'role' | 'uri' | 'truncated'>> = {}): RouterSource {
  const clean = stripAssistantContext(text)
  return { ref: kind + ':' + id + ':' + createHash('sha256').update(clean).digest('hex').slice(0, 24), title, text: clean, at, ...metadata }
}
const businessInput = (row: UAEvent) => ['user_message', 'goal_message'].includes(row.type) && !row.payload.automaticRecovery && !row.payload.recoveryIntermediate
export class RouterContextService {
  private tasks = new Map<string, { key: string; value: Promise<RouterObject> }>()
  private activity = new Map<string, number>()
  private detailed = new Set<string>()
  constructor(private sources: ContextSources, private now = () => Date.now()) {}
  observe(event: UAEvent): void {
    if (event.payload.automaticRecovery || event.payload.recoveryIntermediate) return
    if (businessInput(event) || event.type === 'turn_completed' || event.type === 'error') {
      this.activity.set(event.sessionId, Math.max(event.ts, this.activity.get(event.sessionId) || 0))
      this.tasks.delete(event.sessionId)
    }
  }
  private task(session: Session, owner?: string): Promise<RouterObject> {
    const seed = this.sources.seed(session), accepted = session.submittedUserMessages?.findLast(row => !row.automaticRecovery)?.acceptedAt || 0
    const key = JSON.stringify([routerTargetVersion(session), session.updatedAt, session.taskMetadata?.version, accepted, this.activity.get(session.id), owner])
    const cached = this.tasks.get(session.id)
    if (cached?.key === key) return cached.value
    const value = (async () => {
      const hint = Math.max(accepted, session.createdAt, session.updatedAt || 0, session.taskState?.updatedAt || 0, this.activity.get(session.id) || 0)
      const events = this.detailed.has(session.id) || hint >= this.now() - 72 * 3600000 ? await this.sources.events(session.id) : []
      const original = session.taskRegistration?.inputText || String(events.find(businessInput)?.payload.text || '') || seed?.primaryIntent || ''
      const input = events.findLast(businessInput), reply = events.findLast(row => row.type === 'agent_message' && row.payload.kind !== 'thinking' && row.payload.text),
        turn = events.findLast(row => row.type === 'turn_completed' && !row.payload.recoveryIntermediate)
      const sources: RouterSource[] = []
      const metadata = session.taskMetadata, currentInputId = seed?.inputId
      const description = metadata?.description?.trim() ? source(session.id, 'description', metadata.description, metadata.generatedAt || session.createdAt, '任务描述（Agent 摘要）', { kind: 'agent_summary', role: 'current_description' }) : undefined
      const descriptionSource = description ? { ref: description.ref, inputId: metadata?.generatedInputId, currentInputId,
        freshness: metadata?.generationState === 'ready' && (!currentInputId || metadata.generatedInputId === currentInputId) ? 'ready' as const : 'stale' as const } : undefined
      if (description) sources.push(description)
      if (input) sources.push(source(session.id, 'current-input', String(input.payload.text || ''), input.ts, '最新有效用户输入', { kind: 'user_input', role: 'current_input' }))
      if (reply) sources.push(source(session.id, 'reply', String(reply.payload.text), reply.ts, '近期成果与进展（Agent 回答）', { kind: 'agent_output', role: 'recent_output' }))
      sources.push(source(session.id, 'state', JSON.stringify({ status: session.status, lifecycle: session.taskState?.phase || (session.archived ? 'archived' : 'active'), taskState: session.taskState }), session.taskState?.updatedAt || session.createdAt, '当前状态', { kind: 'system_state', role: 'status' }))
      if (original) sources.push(source(session.id, 'input', original, session.createdAt, '原始目标', { kind: 'user_input', role: 'original_goal' }))
      const lastBusinessUpdatedAt = Math.max(session.createdAt, accepted, input?.ts || 0, turn?.ts || 0, session.taskState?.updatedAt || 0, this.activity.get(session.id) || 0)
      return { id: session.id, kind: 'task' as const, title: taskDisplayTitle(session), summary: stripAssistantContext(String(input?.payload.text || original || session.title)),
        version: routerTargetVersion(session), projectId: owner || session.config.projectId, requirementId: session.config.requirementId, nativeSessionId: session.nativeSessionId, agentId: session.config.agentId,
        archived: session.archived, readOnly: session.readOnly || !!session.teamBinding || !!session.config.assistantSnapshot, busy: isSessionBusy(session.status),
        execution: { agentId: session.config.agentId, model: session.config.model, effort: session.config.effort, modelSource: session.config.modelSource,
          permissionMode: session.config.permissionMode, workdir: session.config.workdir, worktree: session.config.worktree },
        lastBusinessUpdatedAt, sources, descriptionSource, recentChanges: sources.filter(row => row.title !== '原始目标' && row.ref !== description?.ref).sort((a, b) => b.at - a.at).slice(0, 3)
          .map(row => ({ at: row.at, text: row.title + '：' + row.text, sourceRefs: [row.ref], origin: { kind: 'task' as const, objectId: session.id }, sourceKind: row.kind })) }
    })()
    this.tasks.set(session.id, { key, value })
    void value.catch(() => { if (this.tasks.get(session.id)?.value === value) this.tasks.delete(session.id) })
    return value
  }
  private async document(id: string, document: 'core' | 'state'): Promise<RequirementOverview> {
    const first = await this.sources.overview(id, document).catch(error => {
      if (document === 'state' && error instanceof Error && error.message === '需求文档不存在') return { revision: 'missing', documents: [] } as RequirementOverview
      throw error
    }), parts = [first.document?.content || '']
    let offset = first.nextOffset
    while (typeof offset === 'number') {
      const next = await this.sources.overview(id, document, offset)
      if (next.revision !== first.revision || next.document?.id !== first.document?.id) throw new Error('object_revision_changed')
      if (typeof next.nextOffset === 'number' && next.nextOffset <= offset) throw new Error('invalid_reading_cursor')
      parts.push(next.document?.content || ''); offset = next.nextOffset
    }
    return { ...first, document: first.document && { ...first.document, content: parts.join('') }, nextOffset: null }
  }
  private async requirement(row: Requirement, tasks: RouterObject[]): Promise<RouterObject> {
    if (this.sources.routing) {
      const { snapshot, sources: input } = await this.sources.routing(row.id)
      const documents = [...input.documents].sort((a, b) => Number(b.kind === 'core') - Number(a.kind === 'core'))
      const sources = documents.map(doc => source(row.id, 'document', doc.content, doc.updatedAt || row.createdAt, doc.title, { kind: 'document' }))
      const description = snapshot.status === 'ready' && snapshot.view ? routingDescription(snapshot.view) : ''
      if (snapshot.status === 'ready' && snapshot.view) sources.splice(documents[0]?.kind === 'core' ? 1 : 0, 0,
        source(row.id, 'routing-scope', description, snapshot.view.generatedAt, '需求功能范围与边界（原文派生）', { kind: 'derived' }),
        source(row.id, 'routing', JSON.stringify({ features: snapshot.view.features, exclusions: snapshot.view.exclusions, conflicts: snapshot.view.conflicts, coverage: snapshot.view.coverage }), snapshot.view.generatedAt, '路由事实：功能归属、实施与验收分开；完整内容按此 ref 分页读取', { kind: 'derived' }))
      const references = (input.references || []).map(reference => source(row.id, 'reference', JSON.stringify({ ...reference,
        notice: '仅为需求资料目录的关联线索；目标原文未读，draft 不作为有效要求、授权或验收。' }), row.createdAt, `资料入口（${reference.status}，原文未读）：${reference.title}`, { kind: 'reference' }))
      sources.splice((documents[0]?.kind === 'core' ? 1 : 0) + (snapshot.status === 'ready' && snapshot.view ? 2 : 0), 0, ...references)
      const changes = tasks.filter(task => task.requirementId === row.id).flatMap(task => task.recentChanges || []).sort((a, b) => b.at - a.at).slice(0, 3)
      return { id: row.id, kind: 'requirement', title: row.name, projectId: row.projectId, archived: row.status === 'archived',
        version: row.updatedAt + ':' + input.revision + ':' + (snapshot.view?.generatedAt || 0) + ':' + createHash('sha256').update(JSON.stringify(input.references || [])).digest('hex').slice(0, 24), routing: snapshot,
        summary: documents.find(doc => doc.kind === 'core')?.content || description || documents.filter(doc => ['spec','decision'].includes(doc.kind)).map(doc => doc.content).join('\n'), sources,
        lastBusinessUpdatedAt: Math.max(row.createdAt, ...input.documents.map(doc => doc.updatedAt), ...changes.map(change => change.at)), recentChanges: changes }
    }
    const [core, state] = await Promise.all([this.document(row.id, 'core'), this.document(row.id, 'state')])
    const documents = [core.document, state.document].filter(row => !!row)
    const sources = documents.map(doc => source(row.id, 'document', doc.content, doc.updatedAt || row.createdAt, doc.id === 'core' ? '目标与范围' : '当前进展', { kind: 'document' }))
    const changes = tasks.filter(task => task.requirementId === row.id).flatMap(task => task.recentChanges || []).sort((a, b) => b.at - a.at).slice(0, 3)
    return { id: row.id, kind: 'requirement', title: row.name, summary: core.document?.content || row.name,
      version: row.updatedAt + ':' + core.revision + ':' + state.revision, projectId: row.projectId, archived: row.status === 'archived', sources,
      lastBusinessUpdatedAt: Math.max(row.createdAt, ...documents.map(doc => doc.updatedAt), ...changes.map(change => change.at)),
      recentChanges: [...changes, ...sources.filter(source => source.title === '当前进展').map(source => ({ at: source.at, text: source.text, sourceRefs: [source.ref],
        origin: { kind: 'requirement' as const, objectId: row.id }, sourceKind: source.kind }))].sort((a, b) => b.at - a.at).slice(0, 3) }
  }
  async detail(id: string): Promise<RouterObject | undefined> {
    const session = this.sources.sessions().find(row => row.id === id && isTaskTitleEligible(row))
    if (!session) return undefined
    if (!this.detailed.has(id)) { this.detailed.add(id); this.tasks.delete(id) }
    const requirement = (await this.sources.requirements()).find(row => row.id === session.config.requirementId)
    return this.task(session, requirement?.projectId)
  }
  private async project(project: Project, children: RouterObject[]): Promise<RouterObject> {
    const identity = JSON.stringify({ name: project.name, directory: project.primaryDirectory, additionalDirectories: project.additionalDirectories,
      requirements: children.map(row => ({ id: row.id, title: row.title })), notice: '需求目录仅为已知范围线索，不代表项目全部业务边界。' })
    const sources = [source(project.id, 'space', identity, project.updatedAt, '项目身份与已知需求目录', { kind: 'system_state' })]
    const path = join(project.primaryDirectory, 'README.md')
    try {
      const file = await open(path, 'r')
      try {
        const info = await file.stat(), buffer = Buffer.alloc(32000)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        sources.unshift(source(project.id, 'document', buffer.subarray(0, bytesRead).toString('utf8'), info.mtimeMs, '项目 README',
          { kind: 'document', uri: path, truncated: info.size > bytesRead }))
      } finally { await file.close() }
    } catch {
      sources.push(source(project.id, 'reference', JSON.stringify({ uri: path, notice: '项目定义未读取，不能仅凭某个局部需求推断完整项目范围；必要时按实际目录补读项目资料。' }), project.updatedAt, '项目资料入口（未读）', { kind: 'reference', uri: path }))
    }
    return { id: project.id, kind: 'space', title: project.name, summary: sources[0].text, projectId: project.id, version: String(project.updatedAt), sources,
      lastBusinessUpdatedAt: Math.max(project.updatedAt, ...children.map(row => row.lastBusinessUpdatedAt || 0)),
      recentChanges: children.flatMap(row => row.recentChanges || []).sort((a, b) => b.at - a.at).slice(0, 3) }
  }
  async objects(): Promise<RouterObject[]> {
    const spaces = this.sources.projects(), requirements = await this.sources.requirements(), owners = new Map(requirements.map(row => [row.id, row.projectId]))
    const sessions = this.sources.sessions().filter(isTaskTitleEligible), tasks: RouterObject[] = []
    // Bound history hydration; newly available metadata never waits for a model call.
    for (let index = 0; index < sessions.length; index += 4) tasks.push(...await Promise.all(sessions.slice(index, index + 4).map(session => this.task(session, owners.get(session.config.requirementId || '')))))
    const rows = await Promise.all(requirements.map(row => this.requirement(row, tasks)))
    return [...await Promise.all(spaces.map(project => this.project(project, rows.filter(row => row.projectId === project.id)))), ...rows, ...tasks]
  }
}
