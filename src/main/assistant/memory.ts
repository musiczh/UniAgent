import { ASSISTANT_LIMITS, type AssistantDocument, type MemoryOperation, type MemoryRequest } from '../../shared/assistant'

export function checkContent(type: keyof typeof ASSISTANT_LIMITS, text: unknown, automatic = false): asserts text is string {
  if (typeof text !== 'string') throw new Error('invalid_document_content')
  if ([...text].length > ASSISTANT_LIMITS[type]) throw new Error('memory_budget_exceeded')
  if (automatic && /(?:-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})|(?:api[_ -]?key|password|secret)\s*[:=]\s*[^\s]{12,}|<\/?(?:system|developer|uniagent_assistant_memory)>)/i.test(text)) {
    throw new Error('unsafe_memory_content')
  }
}
export function applyMemoryOperations(documents: AssistantDocument[], request: MemoryRequest): AssistantDocument[] {
  if (!request || typeof request !== 'object') throw new Error('invalid_memory_request')
  const operations = request.action === 'batch' ? request.operations : request.action === 'read' ? [] : [request]
  if (!Array.isArray(operations) || operations.length > 20) throw new Error('invalid_memory_operations')
  if (request.action === 'batch' && Object.keys(request).some(k => !['action','operations'].includes(k))) throw new Error('invalid_memory_request')
  const next = structuredClone(documents)
  const original = new Map(documents.map(d => [d.type, d]))
  for (const op of operations as MemoryOperation[]) {
    if (!op || !['user', 'memory'].includes(op.document) || !['add', 'replace', 'remove'].includes(op.action)) throw new Error('invalid_memory_operation')
    const fields = op.action === 'add' ? ['action','document','content','expectedRevision'] : op.action === 'replace' ? ['action','document','oldText','newText','expectedRevision'] : ['action','document','oldText','expectedRevision']
    if (Object.keys(op).some(k => !fields.includes(k))) throw new Error('invalid_memory_fields')
    const document = next.find(d => d.type === op.document)!
    if (!Number.isSafeInteger(op.expectedRevision) || original.get(op.document)?.revision !== op.expectedRevision) throw new Error('revision_conflict')
    if (op.action === 'add') {
      if (typeof op.content !== 'string' || !op.content.trim()) throw new Error('invalid_memory_content')
      const entry = op.content.trim()
      const normal = (s: string) => s.normalize('NFKC').trim()
      if (!document.content.split('\n').some(line => normal(line.replace(/^\s*[-*]\s*/, '')) === normal(entry.replace(/^[-*]\s*/, '')))) {
        document.content = [document.content.trim(), entry].filter(Boolean).join('\n')
      }
    } else {
      if (typeof op.oldText !== 'string' || !op.oldText) throw new Error('invalid_memory_old_text')
      const first = document.content.indexOf(op.oldText)
      if (first < 0) throw new Error('memory_text_not_found')
      if (document.content.indexOf(op.oldText, first + 1) >= 0) throw new Error('memory_text_ambiguous')
      if (op.action === 'replace' && typeof op.newText !== 'string') throw new Error('invalid_memory_new_text')
      document.content = document.content.replace(op.oldText, op.action === 'replace' ? op.newText : '').trim()
    }
    checkContent(op.document, document.content, true)
  }
  return next
}
