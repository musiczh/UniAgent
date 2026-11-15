import type { RequirementDocument } from '../shared/requirementTypes'

type MemoryDocument = Omit<RequirementDocument, 'content'> & { content?: string; contentHash?: string }
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
let queryCache: { query: string; input: string; terms: string[] } | undefined

/** Visibility records what was said or observed; it never activates a draft rule. */
export function isSharedMemory(doc: Pick<RequirementDocument, 'status' | 'memory' | 'sources'>): boolean {
  return !!doc.memory && !['archived', 'superseded'].includes(doc.status) && doc.memory.basis !== 'suggestion' &&
    doc.sources.some(source => source.kind !== 'reference')
}

export function requirementRelevance(doc: Pick<RequirementDocument, 'id' | 'title' | 'summary'> & Partial<Pick<RequirementDocument, 'triggers' | 'memory'>>, query: string): number {
  if (queryCache?.query !== query) {
    const input = query.normalize('NFC').toLocaleLowerCase().slice(0, 4000)
    queryCache = { query, input, terms: [...new Set([...segmenter.segment(input)].filter(part => part.isWordLike && part.segment.length > 1).map(part => part.segment))] }
  }
  const { input, terms } = queryCache
  if (!input.trim()) return 0
  const fields = [doc.id, doc.title, doc.summary, ...(doc.triggers || []), doc.memory?.topic || ''].map(value => value.toLocaleLowerCase())
  return fields.reduce((score, field, index) => score + (field && input.includes(field) ? 12 : 0) + terms.filter(term => field.includes(term)).length * (index === 2 ? 1 : 3), 0)
}

export function requirementMemories(documents: MemoryDocument[], query = '', projectId?: string) {
  const visible = documents.filter(doc => !['core', 'state'].includes(doc.id) &&
    (!projectId || !doc.projectIds.length || doc.projectIds.includes(projectId)) && (doc.status === 'active' || isSharedMemory(doc)))
  const ranked = visible.map(doc => ({ doc, score: requirementRelevance(doc, query) }))
    .sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt || a.doc.id.localeCompare(b.doc.id))
  const important = ranked.filter(({ doc, score }) => score > 0 && doc.status === 'active' && ['spec', 'decision'].includes(doc.kind)).map(({ doc }) => doc)
  const essentialDocuments = important.slice(0, 2), essentialIds = new Set(essentialDocuments.map(doc => doc.id))
  const relevant = ranked.filter(({ doc, score }) => score > 0 && !essentialIds.has(doc.id))
  const brief = (doc: MemoryDocument) => ({
    id: doc.id, title: doc.title, text: doc.summary || doc.title, type: doc.memory?.type || doc.kind,
    basis: doc.status === 'active' && !doc.memory ? 'effective' : doc.memory?.basis,
    status: doc.status, evidenceScope: doc.memory?.evidenceScope, occurredAt: doc.memory?.occurredAt,
    recordedAt: doc.updatedAt, sources: doc.sources.slice(0, 2).map(({ kind, sessionId, seq, uri }) => ({ kind, sessionId, seq, uri })),
    read: { documentId: doc.id }
  })
  return { essentials: essentialDocuments.map(brief), moreEssentials: important.length > essentialDocuments.length,
    items: relevant.slice(0, 3).map(({ doc }) => brief(doc)), total: visible.length, more: relevant.length > 3,
    guide: '按 documentId 读取正文；draft 报告不代表有效规格、验证或验收。未匹配信息可按主题查询。' }
}

export function requirementChanges(current: Record<string, MemoryDocument>, previous?: Record<string, MemoryDocument>) {
  const ids = Object.keys(current), old = previous || {}
  const added = ids.filter(id => !old[id])
  const updated = ids.filter(id => old[id] && JSON.stringify(current[id]) !== JSON.stringify(old[id]))
  const invalidated = [...new Set([...updated.filter(id => ['superseded', 'archived'].includes(current[id].status)), ...Object.keys(old).filter(id => !current[id])])]
  return { added: added.slice(0, 30), updated: updated.filter(id => !invalidated.includes(id)).slice(0, 30), invalidated: invalidated.slice(0, 30),
    replacements: ids.filter(id => current[id].supersedes && (added.includes(id) || updated.includes(id))).slice(0, 30).map(id => ({ id, supersedes: current[id].supersedes })),
    complete: !!previous && Math.max(added.length, updated.length, invalidated.length) <= 30 }
}
