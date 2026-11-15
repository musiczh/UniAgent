import { createHash } from 'node:crypto'
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
function source(id: string, kind: string, text: string, at: number, title: string): RouterSource {
  const clean = stripAssistantContext(text)
  return { ref: kind + ':' + id + ':' + createHash('sha256').update(clean).digest('hex').slice(0, 24), title, text: clean, at }
}
const businessInput = (row: UAEvent) => ['user_message', 'goal_message'].includes(row.type) && !row.payload.automaticRecovery && !row.payload.recoveryIntermediate
export class RouterContextService {
  private tasks = new Map<string, { key: string; value: Promise<RouterObject> }>()
  private activity = new Map<string, number>()
  private referenced = new Set<string>()
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
      const events = this.referenced.has(session.id) || hint >= this.now() - 72 * 3600000 ? await this.sources.events(session.id) : []
      const tail = events.slice(-200), original = seed?.primaryIntent || session.taskRegistration?.inputText || String(events.find(businessInput)?.payload.text || '')
      const input = tail.findLast(businessInput), reply = tail.findLast(row => row.type === 'agent_message' && row.payload.kind !== 'thinking' && row.payload.text),
        turn = tail.findLast(row => row.type === 'turn_completed' && !row.payload.recoveryIntermediate)
      const sources: RouterSource[] = []
      if (original) sources.push(source(session.id, 'input', original, session.createdAt, '原始目标'))
      if (input && String(input.payload.text || '') !== original) sources.push(source(session.id, 'input', String(input.payload.text || ''), input.ts, '最近有效输入'))
      if (reply) sources.push(source(session.id, 'reply', String(reply.payload.text), turn?.ts || reply.ts, '最近回答与进展'))
      sources.push(source(session.id, 'state', JSON.stringify({ status: session.status, lifecycle: session.taskState?.phase || (session.archived ? 'archived' : 'active') }), session.taskState?.updatedAt || session.createdAt, '当前状态'))
      const lastBusinessUpdatedAt = Math.max(session.createdAt, accepted, input?.ts || 0, turn?.ts || 0, session.taskState?.updatedAt || 0, this.activity.get(session.id) || 0)
      return { id: session.id, kind: 'task' as const, title: taskDisplayTitle(session), summary: stripAssistantContext(String(input?.payload.text || original || session.title)),
        version: routerTargetVersion(session), projectId: owner || session.config.projectId, requirementId: session.config.requirementId, nativeSessionId: session.nativeSessionId, agentId: session.config.agentId,
        archived: session.archived, readOnly: session.readOnly || !!session.teamBinding || !!session.config.assistantSnapshot, busy: isSessionBusy(session.status),
        execution: { agentId: session.config.agentId, model: session.config.model, effort: session.config.effort, modelSource: session.config.modelSource,
          permissionMode: session.config.permissionMode, workdir: session.config.workdir, worktree: session.config.worktree },
        lastBusinessUpdatedAt, sources, recentChanges: sources.filter(row => row.title !== '原始目标').sort((a, b) => b.at - a.at).slice(0, 3)
          .map(row => ({ at: row.at, text: row.title + '：' + row.text, sourceRefs: [row.ref] })) }
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
      const sources = input.documents.map(doc => source(row.id, 'document', doc.content, doc.updatedAt || row.createdAt, doc.title))
      if (snapshot.status === 'ready' && snapshot.view) sources.unshift(source(row.id, 'routing', JSON.stringify({ features: snapshot.view.features, exclusions: snapshot.view.exclusions, conflicts: snapshot.view.conflicts, coverage: snapshot.view.coverage }), snapshot.view.generatedAt, '路由事实：功能归属、实施与验收分开；完整内容按此 ref 分页读取'))
      const changes = tasks.filter(task => task.requirementId === row.id).flatMap(task => task.recentChanges || []).sort((a, b) => b.at - a.at).slice(0, 3)
      const description = snapshot.status === 'ready' && snapshot.view ? routingDescription(snapshot.view) : ''
      return { id: row.id, kind: 'requirement', title: row.name, projectId: row.projectId, archived: row.status === 'archived',
        version: row.updatedAt + ':' + input.revision + ':' + (snapshot.view?.generatedAt || 0), routing: snapshot,
        summary: description || input.documents.filter(doc => ['core','spec','decision'].includes(doc.kind)).map(doc => doc.content).join('\n'), sources,
        lastBusinessUpdatedAt: Math.max(row.createdAt, ...input.documents.map(doc => doc.updatedAt), ...changes.map(change => change.at)), recentChanges: changes }
    }
    const [core, state] = await Promise.all([this.document(row.id, 'core'), this.document(row.id, 'state')])
    const documents = [core.document, state.document].filter(row => !!row)
    const sources = documents.map(doc => source(row.id, 'document', doc.content, doc.updatedAt || row.createdAt, doc.id === 'core' ? '目标与范围' : '当前进展'))
    const changes = tasks.filter(task => task.requirementId === row.id).flatMap(task => task.recentChanges || []).sort((a, b) => b.at - a.at).slice(0, 3)
    return { id: row.id, kind: 'requirement', title: row.name, summary: core.document?.content || row.name,
      version: row.updatedAt + ':' + core.revision + ':' + state.revision, projectId: row.projectId, archived: row.status === 'archived', sources,
      lastBusinessUpdatedAt: Math.max(row.createdAt, ...documents.map(doc => doc.updatedAt), ...changes.map(change => change.at)),
      recentChanges: [...changes, ...sources.filter(row => row.title === '当前进展').map(row => ({ at: row.at, text: row.text, sourceRefs: [row.ref] }))].sort((a, b) => b.at - a.at).slice(0, 3) }
  }
  async reference(id: string): Promise<RouterObject | undefined> {
    const session = this.sources.sessions().find(row => row.id === id && isTaskTitleEligible(row))
    if (!session) return undefined
    this.referenced.add(id); this.tasks.delete(id)
    const requirement = (await this.sources.requirements()).find(row => row.id === session.config.requirementId)
    return this.task(session, requirement?.projectId)
  }
  async objects(): Promise<RouterObject[]> {
    const spaces = this.sources.projects(), requirements = await this.sources.requirements(), owners = new Map(requirements.map(row => [row.id, row.projectId]))
    const sessions = this.sources.sessions().filter(isTaskTitleEligible), tasks: RouterObject[] = []
    // Bound history hydration; newly available metadata never waits for a model call.
    for (let index = 0; index < sessions.length; index += 4) tasks.push(...await Promise.all(sessions.slice(index, index + 4).map(session => this.task(session, owners.get(session.config.requirementId || '')))))
    const rows = await Promise.all(requirements.map(row => this.requirement(row, tasks)))
    return [...spaces.map(project => {
      const children = rows.filter(row => row.projectId === project.id), text = project.name + '；项目目录：' + project.primaryDirectory +
        (children.length ? '；需求：' + children.map(row => row.title + '：' + row.summary.slice(0, 160)).join('；') : '；当前尚无需求描述。')
      const ref = source(project.id, 'space', text, project.updatedAt, '空间用途与业务范围')
      return { id: project.id, kind: 'space' as const, title: project.name, summary: text, projectId: project.id, version: String(project.updatedAt),
        sources: [ref], lastBusinessUpdatedAt: Math.max(project.updatedAt, ...children.map(row => row.lastBusinessUpdatedAt || 0)),
        recentChanges: children.flatMap(row => row.recentChanges || []).sort((a, b) => b.at - a.at).slice(0, 3) }
    }), ...rows, ...tasks]
  }
}
