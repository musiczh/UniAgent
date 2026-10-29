/** Requirements are global; their first conversation can bind a preferred project. */
export type RequirementStatus = 'active' | 'done' | 'archived'
export interface Requirement {
  id: string
  name: string
  projectId?: string
  dir: string
  docPath: string
  status: RequirementStatus
  createdAt: number
  updatedAt: number
}
export interface RequirementInput { name: string }
export interface RequirementPatch { name?: string; status?: RequirementStatus }
export type RequirementDocumentKind = 'core' | 'state' | 'spec' | 'decision' | 'knowledge' | 'source' | 'artifact' | 'proposal'
export type RequirementDocumentStatus = 'active' | 'draft' | 'superseded' | 'archived'
export interface RequirementSource {
  kind: 'user' | 'tool' | 'agent' | 'reference'
  sessionId?: string
  seq?: number
  quote?: string
  uri?: string
  observedVersion?: string
}
export interface RequirementDocument {
  id: string
  kind: RequirementDocumentKind
  title: string
  summary: string
  content: string
  status: RequirementDocumentStatus
  triggers: string[]
  projectIds: string[]
  dependencies: string[]
  sources: RequirementSource[]
  freshness: 'verified' | 'needs-review'
  supersedes?: string
  updatedAt: number
}
export interface RequirementDocumentInput extends Partial<Omit<RequirementDocument, 'updatedAt'>> {
  id: string
  kind: RequirementDocumentKind
  title: string
  content: string
}
export interface RequirementContextRequest {
  action: 'bootstrap' | 'check' | 'read' | 'commit' | 'propose' | 'pending' | 'acknowledge' | 'migrate'
  expectedRevision?: string
  operationId?: string
  documents?: RequirementDocumentInput[]
  documentId?: string
  query?: string
  offset?: number
  limit?: number
  sessionId?: string
  throughSeq?: number
  migrationRevision?: string
}
export const REQUIREMENT_IPC = {
  list: 'requirements:list', create: 'requirements:create', update: 'requirements:update',
  openDir: 'requirements:openDir', changed: 'requirements:changed'
} as const
