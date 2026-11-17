/** A requirement owns a primary space; its sessions may execute in other spaces. */
export type RequirementStatus = 'active' | 'done' | 'archived'
export interface Requirement {
  id: string
  name: string
  projectId?: string
  ownershipVersion?: 1
  dir: string
  docPath: string
  status: RequirementStatus
  createdAt: number
  updatedAt: number
}
export interface RequirementInput { name: string; projectId?: string }
export interface RequirementPatch { name?: string; status?: RequirementStatus; projectId?: string }
export type RequirementDocumentKind = 'core' | 'state' | 'spec' | 'decision' | 'knowledge' | 'source' | 'artifact' | 'proposal'
export type RequirementDocumentStatus = 'active' | 'draft' | 'superseded' | 'archived'
export type RequirementMemoryBasis = 'user' | 'tool' | 'agent' | 'suggestion'
export interface RequirementMemory {
  type: 'intent' | 'decision' | 'change' | 'experience' | 'finding' | 'question' | 'material'
  topic: string
  basis: RequirementMemoryBasis
  evidenceScope?: string
  occurredAt?: number
}
export interface RequirementSource {
  kind: 'user' | 'tool' | 'agent' | 'reference'
  sessionId?: string
  seq?: number
  eventId?: string
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
  codeLinks?: Array<import('./projectMemory').ProjectCodeLink & { projectId?: string; reason: string }>
  skillLinks?: Array<{ name: string; path?: string; reason: string }>
  freshness: 'verified' | 'needs-review'
  supersedes?: string
  memory?: RequirementMemory
  updatedAt: number
}
export interface RequirementDocumentInput extends Partial<Omit<RequirementDocument, 'updatedAt'>> {
  id: string
  kind: RequirementDocumentKind
  title: string
  content: string
}
export interface RequirementContextRequest {
  action: 'bootstrap' | 'check' | 'read' | 'commit' | 'propose' | 'pending' | 'acknowledge' | 'migrate' | 'sync_task'
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
  task?: RequirementTaskSummary
}
export interface RequirementTaskSummary {
  title: string
  summary: string
  work: string[]
  results: string[]
  verification: string[]
  remaining: string[]
  sources?: RequirementSource[]
}
export interface RequirementTaskDigest extends RequirementTaskSummary {
  documentIds?: string[]
  sessionId: string
  updatedAt: number
  throughSeq: number
  origin: 'agent' | 'background'
  coverage: 'submitted' | 'partial'
  labels?: string[]
}
export interface RequirementCurationJob { id: string; sessionId: string; kind: 'task' | 'reading'; queuedAt: number }
export interface RequirementCurationFailure extends RequirementCurationJob { title: string; error: string; failedAt: number }
export interface RequirementStoragePreview { files: number; bytes: number; token: string; revision: string; archive?: string }
export interface RequirementCurationState {
  sessionId: string
  nativeThreadId?: string
  agentId?: string
  runtimeSignature?: string
  status: 'idle' | 'queued' | 'running' | 'failed' | 'unconfigured' | 'paused'
  queue: RequirementCurationJob[]
  failures?: RequirementCurationFailure[]
  current?: RequirementCurationJob
  model?: string
  lastError?: string
  updatedAt: number
  history: Array<{ id: string; at: number; title: string; detail: string; status: 'completed' | 'failed' | 'running' }>
}
export interface RequirementCurationConversation {
  requirementId: string
  sessionId: string
  nativeThreadId?: string
  model?: string
  status: RequirementCurationState['status']
  events: import('./types').UAEvent[]
}
export interface RequirementReadingReference { documentId: string; quote: string }
export interface RequirementRoutingRef extends RequirementReadingReference { documentHash: string }
export interface RequirementRoutingFeature {
  name: string; aliases: string[]; responsibility: string; ownershipRefs: RequirementRoutingRef[]
  implementation: { status: 'unknown' | 'planned' | 'design' | 'implementing' | 'delivered'; refs: RequirementRoutingRef[] }
  acceptance: { status: 'unknown' | 'pending' | 'accepted'; refs: RequirementRoutingRef[] }
}
export interface RequirementRoutingFact { text: string; refs: RequirementRoutingRef[] }
export interface RequirementRoutingFragment {
  documentId: string; documentHash: string; offset: number; length: number
  features: RequirementRoutingFeature[]; exclusions: RequirementRoutingFact[]; conflicts: RequirementRoutingFact[]
}
export interface RequirementRoutingView {
  schemaVersion: 1; generatorVersion: 1; requirementId: string; sourceRevision: string; generatedAt: number
  features: RequirementRoutingFeature[]; exclusions: RequirementRoutingFact[]; conflicts: RequirementRoutingFact[]
  coverage: { complete: boolean; pendingDocumentIds: string[] }
  fragments: RequirementRoutingFragment[]
}
export interface RequirementRoutingSnapshot {
  status: 'ready' | 'stale' | 'missing' | 'failed'; sourceRevision: string; view?: RequirementRoutingView; error?: string
}
export interface RequirementRoutingSources {
  revision: string
  documents: Array<RequirementReadableDocument & { contentHash: string }>
  references?: Array<Pick<RequirementReadableDocument, 'id' | 'title' | 'kind' | 'status' | 'freshness'> & { uris: string[] }>
}
export interface RequirementReadingItem { text: string; refs: RequirementReadingReference[]; basis?: RequirementMemoryBasis }
export interface RequirementReadingSection extends RequirementReadingItem {
  title: string
  progress?: RequirementReadingItem
  next?: RequirementReadingItem & { kind: 'confirmed' | 'suggested' }
  image?: { documentId: string; uri: string; caption: string }
}
export interface RequirementReading {
  version: 1 | 2 | 3
  sourceRevision: string
  taskRevision?: string
  updatedAt: number
  goal?: RequirementReadingItem
  scope?: RequirementReadingItem
  current?: RequirementReadingItem
  constraints: RequirementReadingItem[]
  stages: Array<{ title: string; detail: string; status: 'planned' | 'design' | 'implementing' | 'delivered' | 'accepted'; refs: RequirementReadingReference[] }>
  issues: RequirementReadingItem[]
  next: Array<RequirementReadingItem & { kind: 'confirmed' | 'suggested' }>
  changes?: Array<RequirementReadingItem & { title: string }>
  topics?: Array<RequirementReadingItem & { title: string; detail: string }>
  description?: RequirementReadingItem
  requirements?: RequirementReadingSection[]
  coverage?: { complete: boolean; pendingDocumentIds: string[] }
}
export interface RequirementOverviewQuery { offset?: number; limit?: number; query?: string; category?: string; materials?: 'all' | 'user' | 'agent'; refresh?: boolean; includeHistory?: boolean }
export interface RequirementMaterial {
  documentId: string
  title: string
  summary: string
  origin: 'user' | 'agent'
  uri: string
  format: string
  updatedAt: number
}
export type RequirementReadableDocument = Pick<RequirementDocument, 'id' | 'kind' | 'title' | 'content' | 'status' | 'freshness' | 'summary' | 'sources' | 'dependencies' | 'updatedAt' | 'supersedes' | 'memory'>
export interface RequirementNavigation {
  code: Array<NonNullable<RequirementDocument['codeLinks']>[number] & { documentId: string; basis: RequirementMemoryBasis; freshness: RequirementDocument['freshness']; availability: 'available' | 'unavailable' | 'unknown' }>
  skills: Array<NonNullable<RequirementDocument['skillLinks']>[number] & { documentId: string; basis: RequirementMemoryBasis; freshness: RequirementDocument['freshness']; availability: 'available' | 'unavailable' | 'unknown' }>
  more: boolean
}
export interface RequirementOverview {
  revision: string
  dir?: string
  name?: string
  status?: RequirementStatus
  reading?: RequirementReading
  readingStatus?: 'ready' | 'stale' | 'missing' | 'failed'
  readingError?: string
  sync?: { status: string; pendingCount: number; reason?: string }
  core?: RequirementReadableDocument
  state?: RequirementReadableDocument
  documents: Array<Omit<RequirementReadableDocument, 'content'>>
  associations?: RequirementNavigation
  materials?: RequirementMaterial[]
  document?: RequirementReadableDocument
  total?: number
  nextOffset?: number | null
  totalLength?: number
  tasks?: RequirementTaskDigest[]
  curation?: RequirementCurationState
}

export const REQUIREMENT_IPC = {
  curationConversation: 'requirements:curation-conversation',
  curation: 'requirements:curation',
  storage: 'requirements:storage',
  overview: 'requirements:overview',
  list: 'requirements:list', create: 'requirements:create', update: 'requirements:update',
  openDir: 'requirements:openDir', changed: 'requirements:changed'
} as const
