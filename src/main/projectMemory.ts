import { createHash } from 'node:crypto'
import type { Project, Session, UAEvent } from '../shared/types'
import type { GlobalMemoryItem } from '../shared/router'
import { validProjectCodePath, type ProjectMemoryEntry, type ProjectMemoryPage, type ProjectMemoryRequest, type ProjectMemoryMetadata } from '../shared/projectMemory'
import type { RouterStore } from './router/store'
import { sourceEventId } from './requirementStore'
import { redactRequirementText } from './requirementSpace'
import { stripAssistantContext } from './assistant/context'

interface Dependencies {
  project(id: string): Project | undefined
  session(id: string): Session | undefined
  events(id: string): Promise<UAEvent[]>
  changed(): void
}
const sourceText = (event: UAEvent) => stripAssistantContext(String(event.payload.displayText || event.payload.text || event.payload.output || ''))
const title = (item: GlobalMemoryItem) => item.project?.title || item.content.split('\n')[0].slice(0, 80)
const categories = ['all', 'architecture', 'rule', 'experience', 'pending']
const readOnly = (session: Session) => session.readOnly || session.teamBinding || ['plan','read-only'].includes(session.config.permissionMode || '')

/** Project reads and writes share the existing worker store; no Router execution is required. */
export class ProjectMemoryService {
  constructor(private store: Pick<RouterStore, 'memories' | 'memoryItem' | 'memoryHistory' | 'memoryReferences' | 'writeMemory'>, private deps: Dependencies) {}

  async forSession(sessionId: string, raw: ProjectMemoryRequest): Promise<ProjectMemoryPage> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_project_memory_request')
    const session = this.deps.session(sessionId), projectId = session?.config.projectId
    if (!session || !projectId || session.config.managedPurpose) throw new Error('project_memory_scope_expired')
    if (raw.projectId !== undefined && raw.projectId !== projectId) throw new Error('project_memory_scope_conflict')
    if (!['read', 'propose', 'commit'].includes(raw.action) || readOnly(session) && raw.action !== 'read') throw new Error('project_memory_read_only')
    const current = () => {
      const latest = this.deps.session(sessionId)
      if (latest !== session || latest.config.projectId !== projectId || latest.config.managedPurpose || raw.action !== 'read' && readOnly(latest)) throw new Error('project_memory_scope_expired')
    }
    const result = await this.request(projectId, raw, sessionId, current)
    current()
    return result
  }

  private async verified(project: Project, row: GlobalMemoryItem): Promise<boolean> {
    const source = row.source
    if (source.sessionId === undefined || source.seq === undefined) return false
    const event = (await this.deps.events(source.sessionId)).find(event => event.seq === source.seq && (row.project ? sourceEventId(event) === source.version : createHash('sha256').update(String(event.payload.text || '')).digest('hex') === source.version))
    if (!event) return false
    if (!row.project?.references?.length) return true
    const current = await this.store.memoryReferences(project, row.project.modules)
    return current.every((ref, index) => !!ref.version && ref.version === row.project!.references![index]?.version)
  }

  private async entry(project: Project, row: GlobalMemoryItem): Promise<ProjectMemoryEntry> {
    return { ...row, title:title(row), freshness: await this.verified(project, row).catch(() => false) ? 'verified' : 'needs-review' }
  }
  async isCurrent(row: GlobalMemoryItem): Promise<boolean> {
    const project = row.scope.kind === 'space' && this.deps.project(row.scope.projectId)
    return !!project && await this.verified(project,row).catch(() => false)
  }

  async request(projectId: string, raw: ProjectMemoryRequest, sessionId?: string, current: () => void = () => {}): Promise<ProjectMemoryPage> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['action','projectId','id','query','category','offset','limit','includeHistory','expectedRevision','title','content','type','modules','source'].includes(key))) throw new Error('invalid_project_memory_request')
    const project = this.deps.project(projectId)
    if (!project || raw.projectId !== undefined && raw.projectId !== projectId) throw new Error('project_memory_project_unavailable')
    if (!['read','propose','commit','confirm','revoke'].includes(raw.action)) throw new Error('invalid_project_memory_action')
    const offset = raw.offset ?? 0, limit = raw.limit ?? 30, category = raw.category ?? 'all'
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !categories.includes(category) || raw.query !== undefined && (typeof raw.query !== 'string' || raw.query.length > 500)) throw new Error('invalid_project_memory_query')
    if (raw.id !== undefined && (typeof raw.id !== 'string' || !raw.id || raw.id.length > 150)) throw new Error('invalid_project_memory_id')
    if (raw.includeHistory !== undefined && typeof raw.includeHistory !== 'boolean' || raw.expectedRevision !== undefined && (!Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 0)) throw new Error('invalid_project_memory_revision')
    let previous = raw.id ? await this.store.memoryItem(raw.id) : undefined
    if (raw.id && (!previous || previous.scope.kind !== 'space' || previous.scope.projectId !== projectId)) throw new Error('project_memory_not_found')
    if (raw.action === 'confirm' || raw.action === 'revoke') {
      if (!previous || raw.expectedRevision === undefined) throw new Error('project_memory_revision_required')
      if (raw.action === 'confirm' && previous.status === 'revoked') throw new Error('project_memory_revoked')
      if (raw.action === 'confirm' && !await this.verified(project, previous)) throw new Error('project_memory_source_changed')
      current()
      await this.store.writeMemory({ ...previous, status: raw.action === 'confirm' ? 'active' : 'revoked' }, raw.expectedRevision)
      this.deps.changed()
    } else if (raw.action === 'propose' || raw.action === 'commit') {
      if (!sessionId) throw new Error('project_memory_session_required')
      if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 120 || typeof raw.content !== 'string' || !raw.content.trim() || raw.content.length > 2000 || !['architecture','rule','experience'].includes(raw.type || '')) throw new Error('invalid_project_memory_content')
      if (redactRequirementText(JSON.stringify(raw)) !== JSON.stringify(raw)) throw new Error('project_memory_credentials_rejected')
      const modules = raw.modules ?? []
      if (!Array.isArray(modules) || modules.length > 30 || modules.some(module => !module || Object.keys(module).some(key => !['path','title','directory'].includes(key)) || !validProjectCodePath(module.path) || module.title !== undefined && (typeof module.title !== 'string' || module.title.length > 120) || module.directory !== undefined && (typeof module.directory !== 'string' || module.directory.length > 1000))) throw new Error('invalid_project_memory_modules')
      const events = await this.deps.events(sessionId)
      const source = raw.source
      if (source !== undefined && (!source || typeof source !== 'object' || Object.keys(source).some(key => !['seq','kind','quote'].includes(key)) || !['user','tool','agent'].includes(source.kind))) throw new Error('invalid_project_memory_source')
      const event = source ? events.find(row => row.seq === source.seq) : events.findLast(row => row.type === 'agent_message') || events.findLast(row => row.type === 'user_message' && !row.payload.automaticRecovery && row.payload.source !== 'mcp')
      if (!event || source && (!Number.isInteger(source.seq) || typeof source.quote !== 'string' || !source.quote.trim() || source.quote.length > 2000 || !sourceText(event).includes(source.quote))) throw new Error('project_memory_source_unavailable')
      const basis = source?.kind || (event.type === 'agent_message' ? 'agent' : 'user')
      const expected = basis === 'tool' ? event.type === 'command_exec' : basis === 'agent' ? event.type === 'agent_message' : ['user_message','goal_message'].includes(event.type) && !event.payload.automaticRecovery && event.payload.source !== 'mcp'
      if (!expected) throw new Error('project_memory_source_kind_mismatch')
      if (raw.action === 'commit' && (!source || basis === 'agent' || raw.type === 'rule' && basis !== 'user')) throw new Error('project_memory_verified_source_required')
      const references = await this.store.memoryReferences(project, modules)
      if (raw.action === 'commit' && references.some(ref => !ref.version)) throw new Error('project_memory_code_unavailable')
      const metadata: ProjectMemoryMetadata = { title: raw.title.trim(), type: raw.type!, modules, basis, quote: source?.quote || stripAssistantContext(sourceText(event)).slice(0, 2000), references }
      const version = sourceEventId(event), content = raw.content.trim(), status = raw.action === 'commit' ? 'active' : 'candidate'
      const id = raw.id || 'pm_' + createHash('sha256').update(JSON.stringify([projectId,content,metadata,version])).digest('hex')
      previous ||= await this.store.memoryItem(id)
      if (previous && (previous.scope.kind !== 'space' || previous.scope.projectId !== projectId || previous.status === 'revoked')) throw new Error('project_memory_scope_conflict')
      if (previous?.status === 'active' && status === 'candidate') throw new Error('project_memory_active_demotion')
      if (previous && raw.id && raw.expectedRevision === undefined) throw new Error('project_memory_revision_required')
      current()
      if (!previous || previous.content !== content || previous.status !== status || JSON.stringify(previous.project) !== JSON.stringify(metadata) || previous.source.version !== version) {
        await this.store.writeMemory({ id, content, scope: { kind: 'space', projectId }, status, revision: 0, source: { sessionId, seq: event.seq, version }, project: metadata, updatedAt: Date.now() }, raw.expectedRevision ?? previous?.revision ?? 0)
        this.deps.changed()
      } else if (raw.expectedRevision !== undefined && raw.expectedRevision !== previous.revision) throw new Error('memory_revision_conflict')
    }
    if (raw.action === 'read' && previous) {
      const history = raw.includeHistory ? await this.store.memoryHistory(previous.id,offset,limit+1) : undefined
      return { items: [], document: await this.entry(project, previous), history: history?.slice(0,limit), ...(history ? { historyNextOffset: history.length > limit ? offset+limit : null } : {}), total: 1, nextOffset: null }
    }
    const query = (raw.query || '').trim().toLocaleLowerCase()
    const rows = (await this.store.memories({ kind: 'space', projectId }, true)).filter(row => row.scope.kind === 'space' && row.scope.projectId === projectId &&
      (category === 'pending' ? row.status === 'candidate' : row.status === 'active' && (category === 'all' || row.project?.type === category)) &&
      (!query || [title(row),row.content,...(row.project?.modules.map(module => module.title || module.path) || [])].some(text => text.toLocaleLowerCase().includes(query))))
      .sort((a,b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const items = await Promise.all(rows.slice(offset, offset + limit).map(row => this.entry(project, row)))
    return { items: items.map(({ content: _content, ...item }) => item), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null }
  }
}
