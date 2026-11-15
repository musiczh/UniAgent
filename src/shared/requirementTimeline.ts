import type { RequirementReadableDocument } from './requirementTypes'

export function requirementDecisionTime(doc: Pick<RequirementReadableDocument, 'memory' | 'updatedAt'>): number | undefined {
  const occurredAt = doc.memory?.occurredAt
  if (occurredAt !== undefined && occurredAt >= 0 && Number.isFinite(new Date(occurredAt).getTime())) return occurredAt
  return doc.updatedAt > 0 && Number.isFinite(new Date(doc.updatedAt).getTime()) ? doc.updatedAt : undefined
}
