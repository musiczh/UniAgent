import { QODER_IPC } from '../shared/qoder'
import { CLAUDE_SOURCE_IPC, MODEL_CREDENTIAL_IPC, type ModelSourceClient, type ReusableCredential, type CredentialSelection } from '../shared/claudeSources'
import { FORK_IPC, type ForkRequest, type ForkPreflight, type ForkJob } from '../shared/sessionFork'
import { ASSISTANT_IPC, type AssistantDetail, type AssistantInput, type DocumentEdit, type AssistantDocumentType, type DocumentRevision, type AssistantDocument } from '../shared/assistant'
import type { AssistantConversationSelection } from '../shared/assistantConversation'
import { REQUIREMENT_IPC, type Requirement, type RequirementInput, type RequirementPatch } from '../shared/requirementTypes'
import { contextBridge, ipcRenderer } from 'electron'
import { COMMENT_IPC, type CommentSelection, type CommentModel, type CommentThread } from '../shared/comments'
import type { NativeCapabilityChange } from '../shared/nativeCapabilities'
import { WEIXIN_IPC, type AssistantWeixinState } from '../shared/weixin'
import { FRAME_HEALTH_PROBE, FRAME_HEALTH_REPLY } from '../shared/frameHealth'
import { createFrameProbe } from './frameHealth'
import { ZCODE_IPC, type ZCodeInstallationSnapshot, type ZCodeConfigurationInput, type ZCodeConfigurationSnapshot, type ZCodeEventsSnapshot, type ZCodeQuotaSnapshot, type ZCodeRuntimeConfig, type ZCodeRuntimeSnapshot } from '../shared/zcode'
import { CODEX_SOURCE_IPC, type CodexSourceInput, type CodexSourceModelQueryInput, type CodexSourcesSnapshot } from '../shared/codexSources'
import { MODEL_SOURCE_IPC, type ModelSourceSave, type ModelSourceInput, type ModelSourcesSnapshot } from '../shared/modelSources'
import type { AgentQuotaSnapshot } from '../shared/agentQuota'
import { LOCAL_MODEL_IPC, type LocalModelsSnapshot } from '../shared/localModels'
import { TEAM_IPC, type TeamCatalog, type TeamCreateProjectInput, type TeamDefinition, type TeamDefinitionInput, type TeamProject, type TeamArtifact } from '../shared/teamTypes'
import { TASK_IPC, type TaskDecision, type TaskDecisionAnswer } from '../shared/taskDecisions'
import { WORKTREE_ARCHIVE_IPC, type WorktreeArchiveAction, type WorktreeArchiveReview } from '../shared/worktreeArchive'
import type { TaskDecisionInput, TaskLifecycleSnapshot } from '../shared/taskLifecycle'
import type { TaskBoardQuery, TaskBoardSnapshot } from '../shared/taskBoard'
import type { TaskTitleResult } from '../shared/taskTitle'
import { ROUTER_IPC, type RouterConfig, type RouterInput, type RouterRequest, type RouterResolution, type RouterSnapshot } from '../shared/router'
import { PROJECT_MEMORY_IPC, PROJECT_MEMORY_CHANGED, type ProjectMemoryRequest, type ProjectMemoryPage } from '../shared/projectMemory'
import { ROUTER_REVIEW_IPC, type RouterFeedbackInput, type RouterReviewDetail, type RouterReviewQuery, type RouterReviewPage, type RouterReviewTarget, type RouterReviewDeletionItem, type RouterReviewDeletionPlan, type RouterReviewDeleteResult } from '../shared/routerReview'
import type { TaskTitleGenerationConfig } from '../shared/types'
import { SESSION_WORKTREE_STATUS_IPC, type SessionWorktreeStatus } from '../shared/sessionWorktreeStatus'
import { TASK_GENERATION_IPC, type TaskGenerationConversation } from '../shared/taskGeneration'
import {
  IPC,
  type AgentDef,
  type AgentContractUpdate,
  type AgentRole,
  type AgentRoleCatalogEntry,
  type AgentLifecycleProgress,
  type AppSettings,
  type AppSettingsPatch,
  type AppUpdateState,
  type Attachment,
  type AutomationDetail,
  type AutomationEditPatch,
  type AutomationTask,
  type NativeAutomationInput,
  type DiagnosticEntry,
  type FileBrowserListResult,
  type FilePreviewOptions,
  type FilePreviewResult,
  type HandoffPreset,
  type HistoryForkPoint,
  type HistoryPreviewProgress,
  type FeishuStatus,
  type FeishuGroupChat,
  type LifecycleMetrics,
  type KabooProfileResult,
  type KabooUsageQuery,
  type CodexRateLimits,
  type GrokQuota,
  type PrefsData,
  type Project,
  type ProjectGitInfo,
  type ProjectWorktree,
  type SessionDeletionPreview,
  type ProjectInput,
  type PickedFile,
  type AgentPref,
  type QueueItem,
  type QueueWaitQualityQuery,
  type QueueWaitQualityReport,
  type ReviewChangeSet,
  type ReviewFilePair,
  type ReviewFilePairReq,
  type ReviewScope,
  type RewindPreview,
  type RewindResult,
  type TurnArtifactSummary,
  type Session,
  type SessionStatus,
  type SessionConfig,
  type SessionImportMode,
  type NativeSessionRefreshResult,
  type SessionSummary,
  type SessionRuntimeState,
  type SessionUpdatedPush,
  type SideChatState,
  type SideChatStatus,
  type TurnBubbleInput,
  type UAEvent
} from '../shared/types'
import type { AgentsStrategy, CapabilityInventoryManageRequest, CapabilityInventoryManageResult, CapabilityAgentId, CapabilityExecuteRequest, CapabilityInventoryDetail, CapabilityInventoryResult, CapabilityInventorySyncPreparation, CapabilityInventorySyncRequest, CapabilityJobSnapshot, CapabilityMarkdownPreview, CapabilityPlanRequest, CapabilityPluginActionRequest, CapabilityPluginActionResult, CapabilityScanRequest, CapabilityScanResult, CapabilitySyncJob, CapabilitySyncPlan } from '../shared/capabilitySync'
import type { SessionInfo } from '../shared/sessionInfo'
import type {
  CollaborationModeId,
  NativeCapabilityRequest,
  NativeCapabilitySnapshot,
  NativeThreadAction,
  NativeTurnSelectionRequest
} from '../shared/nativeCapabilities'

if (process.isMainFrame) {
  const frames = createFrameProbe(window, document, message => ipcRenderer.send(FRAME_HEALTH_REPLY, message))
  const probe = (_event: Electron.IpcRendererEvent, id: unknown): void => frames.probe(id)
  ipcRenderer.on(FRAME_HEALTH_PROBE, probe)
  window.addEventListener('pagehide', () => {
    ipcRenderer.removeListener(FRAME_HEALTH_PROBE, probe)
    frames.dispose()
  }, { once: true })
}

const CAPABILITY_SYNC_JOB_SNAPSHOT_CHANNEL = 'capabilitySync:getJobSnapshot'
const rawInvoke = ipcRenderer.invoke.bind(ipcRenderer)
const MAIN_REPORTED_CHANNELS = new Set<string>([
  IPC.listAgentHistory, IPC.importSession, IPC.previewHistory, IPC.getSessionForkPoints, IPC.exportNativeSession,
  IPC.forkSameSession, IPC.forkCrossSession
])

function ipcErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message, stack: error.cause.stack }
        : error.cause
    }
  }
  return { value: String(error) }
}

function ipcArgumentShape(value: unknown): unknown {
  if (value === null) return 'null'
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (typeof value === 'object') return {
    type: 'object',
    keys: Object.keys(value as Record<string, unknown>).slice(0, 30)
  }
  return { type: typeof value, ...(typeof value === 'string' ? { length: value.length } : {}) }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await rawInvoke(channel, ...args)
  } catch (error) {
    if (!MAIN_REPORTED_CHANNELS.has(channel)) {
      void rawInvoke(IPC.reportDiagnostic, {
        source: channel,
        code: 'ipc_rejected',
        message: error instanceof Error ? error.message : String(error),
        sample: {
          channel,
          arguments: args.map(ipcArgumentShape),
          error: ipcErrorDetails(error)
        }
      }).catch(() => {})
    }
    throw error
  }
}

const api = {
  createTeamRole: (role: AgentRole, saveGlobal: boolean, requestId: string): Promise<AgentRole> => invoke(TEAM_IPC.createRole, role, saveGlobal, requestId),
  teamCatalog: (): Promise<TeamCatalog> => invoke(TEAM_IPC.catalog),
  saveTeam: (input: TeamDefinitionInput): Promise<TeamDefinition> => invoke(TEAM_IPC.save, input),
  deleteTeam: (id: string, revision: number): Promise<void> => invoke(TEAM_IPC.delete, id, revision),
  createTeamProject: (input: TeamCreateProjectInput): Promise<TeamProject> => invoke(TEAM_IPC.createProject, input),
  sendTeamMessage: (id: string, prompt: string, attachments?: Attachment[]): Promise<void> => invoke(TEAM_IPC.send, id, prompt, attachments),
  stopTeamProject: (id: string): Promise<void> => invoke(TEAM_IPC.stop, id),
  resumeTeamProject: (id: string): Promise<void> => invoke(TEAM_IPC.resume, id),
  archiveTeamProject: (id: string): Promise<void> => invoke(TEAM_IPC.archive, id),
  renameTeamProject: (id: string, name: string): Promise<void> => invoke(TEAM_IPC.rename, id, name),
  teamMemberSession: (id: string, memberId: string): Promise<string> => invoke(TEAM_IPC.session, id, memberId),
  respondTeamInteraction: (id: string, interactionId: string, revision: number, answer: unknown): Promise<void> => invoke(TEAM_IPC.respond, id, interactionId, revision, answer),
  teamArtifact: (id: string, artifactId: string): Promise<TeamArtifact> => invoke(TEAM_IPC.artifact, id, artifactId),
  onTeamChanged: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on(TEAM_IPC.changed, listener)
    return () => { ipcRenderer.removeListener(TEAM_IPC.changed, listener) }
  },
  /** Home directory — used as the default working directory in the UI. */
  homeDir: process.env.HOME || process.env.USERPROFILE || '',
  htmlPreviewUrl: process.argv.find(arg => arg.startsWith('--ua-html-preview-url='))?.slice('--ua-html-preview-url='.length),
  getKimiSetup: (): Promise<import('../shared/kimiOnboarding').KimiSetupSnapshot> => invoke('kimi:setup'),
  getAgentSetup: (id: import('../shared/agentSetup').CliSetupId): Promise<import('../shared/agentSetup').CliSetupSnapshot> => invoke('agent-setup:get', id),
  installAgent: (id: import('../shared/agentSetup').CliSetupId): Promise<import('../shared/agentSetup').CliSetupSnapshot> => invoke('agent-setup:install', id),
  signInAgent: (id: import('../shared/agentSetup').CliSetupId, input: import('../shared/agentSetup').CliSetupInput): Promise<import('../shared/agentSetup').CliSetupSnapshot> => invoke('agent-setup:login', id, input),
  cancelAgentSetup: (id: import('../shared/agentSetup').CliSetupId): Promise<void> => invoke('agent-setup:cancel', id),
  reopenAgentSignIn: (id: import('../shared/agentSetup').CliSetupId): Promise<void> => invoke('agent-setup:reopen', id),
  onAgentSetupChanged: (callback: (value: { id: import('../shared/agentSetup').CliSetupId; snapshot: import('../shared/agentSetup').CliSetupSnapshot }) => void): (() => void) => {
    const listener = (_event: unknown, value: Parameters<typeof callback>[0]) => callback(value)
    ipcRenderer.on('agent-setup:changed', listener)
    return () => ipcRenderer.removeListener('agent-setup:changed', listener)
  },
  checkKimiSetup: (): Promise<import('../shared/kimiOnboarding').KimiSetupSnapshot> => invoke('kimi:check'),
  installKimi: (): Promise<import('../shared/kimiOnboarding').KimiSetupSnapshot> => invoke('kimi:install'),
  signInKimi: (input?: { region?: 'cn' | 'global'; apiKey?: string }): Promise<import('../shared/kimiOnboarding').KimiSetupSnapshot> => invoke('kimi:sign-in', input),
  reopenKimiSignIn: (): Promise<void> => invoke('kimi:reopen'),
  cancelKimiSetup: (): Promise<void> => invoke('kimi:cancel-setup'),
  onKimiSetupChanged: (callback: (snapshot: import('../shared/kimiOnboarding').KimiSetupSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: import('../shared/kimiOnboarding').KimiSetupSnapshot) => callback(snapshot)
    ipcRenderer.on('kimi:setup-changed', listener)
    return () => ipcRenderer.removeListener('kimi:setup-changed', listener)
  },
  getDeepSeekConnection: (): Promise<import('../shared/deepseek').DeepSeekConnectionSnapshot> => invoke('deepseek:get'),
  saveDeepSeekConnection: (input: import('../shared/deepseek').DeepSeekConnectionInput): Promise<import('../shared/deepseek').DeepSeekConnectionSnapshot> => invoke('deepseek:save', input),
  checkDeepSeekConnection: (input: import('../shared/deepseek').DeepSeekConnectionInput): Promise<import('../shared/deepseek').DeepSeekConnectionSnapshot> => invoke('deepseek:check', input),
  installDeepSeek: (): Promise<import('../shared/deepseek').DeepSeekConnectionSnapshot> => invoke('deepseek:install'),
  cancelDeepSeekInstall: (): Promise<void> => invoke('deepseek:cancel-install'),
  signInDeepSeek: (): Promise<import('../shared/deepseek').DeepSeekConnectionSnapshot> => invoke('deepseek:sign-in'),
  cancelDeepSeekSignIn: (): Promise<void> => invoke('deepseek:cancel-sign-in'),
  reopenDeepSeekSignIn: (): Promise<void> => invoke('deepseek:reopen'),
  signOutDeepSeek: (): Promise<import('../shared/deepseek').DeepSeekConnectionSnapshot> => invoke('deepseek:sign-out'),
  onDeepSeekChanged: (callback: (snapshot: import('../shared/deepseek').DeepSeekConnectionSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: import('../shared/deepseek').DeepSeekConnectionSnapshot) => callback(snapshot)
    ipcRenderer.on('deepseek:changed', listener)
    return () => ipcRenderer.removeListener('deepseek:changed', listener)
  },
  getMCodeConnection: (): Promise<import('../shared/mcode').MCodeConnectionSnapshot> => invoke('mcode:get'),
  checkMCodeConnection: (input: import('../shared/mcode').MCodeConnectionInput): Promise<import('../shared/mcode').MCodeConnectionSnapshot> => invoke('mcode:check', input),
  installMCode: (): Promise<import('../shared/mcode').MCodeConnectionSnapshot> => invoke('mcode:install'),
  
  signInMCode: (region: 'cn' | 'global'): Promise<import('../shared/mcode').MCodeConnectionSnapshot> => invoke('mcode:sign-in', region),
  cancelMCodeOperation: (): Promise<void> => invoke('mcode:cancel'),
  reopenMCodeSignIn: (): Promise<void> => invoke('mcode:reopen'),
  listAgents: (): Promise<AgentDef[]> => invoke(IPC.listAgents),
  detectAgents: (): Promise<AgentDef[]> => invoke(IPC.detectAgents),
  detectAgent: (agentId: string): Promise<AgentDef> => invoke(IPC.detectAgent, agentId),
  getLifecycleSnapshot: (): Promise<AgentDef[]> => invoke(IPC.getLifecycleSnapshot),
  checkAgentUpdate: (agentId: string): Promise<AgentDef> => invoke(IPC.checkAgentUpdate, agentId),
  updateAgent: (agentId: string): Promise<AgentDef> => invoke(IPC.updateAgent, agentId),
  initializationFinished: (targetAgentId: string): Promise<{ agents: AgentDef[]; success: boolean }> =>
    invoke(IPC.initializationFinished, targetAgentId),
  getPersonalAssistant: (): Promise<AssistantDetail> => invoke(ASSISTANT_IPC.detail),
  onUniAgentManagementChanged: (cb: (resource: string) => void): (() => void) => {
    const listener = (_event: unknown,resource: unknown) => { if (typeof resource === 'string') cb(resource) }
    ipcRenderer.on(ASSISTANT_IPC.manageChanged,listener)
    return () => ipcRenderer.removeListener(ASSISTANT_IPC.manageChanged,listener)
  },
  getAssistantWorkspace: (): Promise<Project> => invoke(ASSISTANT_IPC.workspace),
  openAssistantAppConversation: (): Promise<Session> => invoke(ASSISTANT_IPC.openAppConversation),
  getAssistantFeishu: (): Promise<import('../shared/assistant').AssistantFeishuState> => invoke(ASSISTANT_IPC.feishu),
  getAssistantWeixin: (): Promise<AssistantWeixinState> => invoke(WEIXIN_IPC.state),
  loginAssistantWeixin: (): Promise<AssistantWeixinState> => invoke(WEIXIN_IPC.login),
  verifyAssistantWeixin: (code: string): Promise<AssistantWeixinState> => invoke(WEIXIN_IPC.verify, code),
  disconnectAssistantWeixin: (): Promise<AssistantWeixinState> => invoke(WEIXIN_IPC.disconnect),
  onAssistantWeixinChanged: (cb: () => void): (() => void) => {
    ipcRenderer.on(WEIXIN_IPC.changed, cb)
    return () => ipcRenderer.removeListener(WEIXIN_IPC.changed, cb)
  },
  getAssistantPrivateSessions: (): Promise<string[]> => invoke(ASSISTANT_IPC.privateSessions),
  onAssistantPrivateSessionsChanged: (cb: () => void): (() => void) => {
    ipcRenderer.on(ASSISTANT_IPC.privateSessionsChanged, cb)
    return () => ipcRenderer.removeListener(ASSISTANT_IPC.privateSessionsChanged, cb)
  },
  bindAssistantFeishu: (input: import('../shared/assistant').AssistantFeishuInput | null): Promise<import('../shared/assistant').AssistantFeishuState> => invoke(ASSISTANT_IPC.bindFeishu, input),
  installAssistantFeishu: (): Promise<import('../shared/assistant').AssistantFeishuState> => invoke(ASSISTANT_IPC.installFeishu),
  cancelAssistantFeishuInstall: (): Promise<import('../shared/assistant').AssistantFeishuState> => invoke(ASSISTANT_IPC.cancelFeishuInstall),
  onAssistantFeishuChanged: (cb: () => void): (() => void) => {
    ipcRenderer.on(ASSISTANT_IPC.feishuChanged, cb)
    return () => ipcRenderer.removeListener(ASSISTANT_IPC.feishuChanged, cb)
  },
  savePersonalAssistant: (input: AssistantInput, edits: DocumentEdit[]): Promise<AssistantDetail> => invoke(ASSISTANT_IPC.save, input, edits),
  assistantVersions: (type: AssistantDocumentType): Promise<DocumentRevision[]> => invoke(ASSISTANT_IPC.versions, type),
  rollbackAssistantDocument: (type: AssistantDocumentType, revision: number, expectedRevision: number): Promise<AssistantDocument> => invoke(ASSISTANT_IPC.rollback, type, revision, expectedRevision),
  assistantCommand: (sessionId: string, command: 'new' | 'clear', requestId: string, selection?: AssistantConversationSelection): Promise<Session> => invoke(ASSISTANT_IPC.command, sessionId, command, requestId, selection),
  onAssistantChanged: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on(ASSISTANT_IPC.changed, listener)
    return () => ipcRenderer.removeListener(ASSISTANT_IPC.changed, listener)
  },
  getRouterSnapshot: (): Promise<RouterSnapshot> => invoke(ROUTER_IPC.snapshot),
  getRouterDraftImages: (): Promise<PickedFile[]> => invoke(ROUTER_IPC.draftImages, 'read'),
  saveRouterDraftImages: (images: PickedFile[], append = false): Promise<void> => invoke(ROUTER_IPC.draftImages, append ? 'append' : 'save', images),
  clearRouterDraftImages: (images: Attachment[]): Promise<void> => invoke(ROUTER_IPC.draftImages, 'submitted', images),
  listRouterReviews: (query?: RouterReviewQuery): Promise<RouterReviewPage> => invoke(ROUTER_REVIEW_IPC.list, query),
  getRouterReviewDeletion: (ids?: string[]): Promise<RouterReviewDeletionPlan> => invoke(ROUTER_REVIEW_IPC.deletion, ids),
  deleteRouterReviews: (items: RouterReviewDeletionItem[]): Promise<RouterReviewDeleteResult> => invoke(ROUTER_REVIEW_IPC.delete, items),
  getRouterReview: (id: string, attemptId?: string, includeTrace = false): Promise<RouterReviewDetail> => invoke(ROUTER_REVIEW_IPC.detail, id, attemptId, includeTrace),
  saveRouterFeedback: (input: RouterFeedbackInput): Promise<RouterReviewDetail> => invoke(ROUTER_REVIEW_IPC.save, input),
  getRouterReviewTargets: (): Promise<RouterReviewTarget[]> => invoke(ROUTER_REVIEW_IPC.targets),
  dismissRouterFeedback: (id: string, attemptId: string): Promise<void> => invoke(ROUTER_REVIEW_IPC.dismiss, id, attemptId),
  copyRouterReviewPrompt: (id?: string): Promise<{ directory: string; count: number }> => invoke(ROUTER_REVIEW_IPC.copy, id),
  saveRouterConfig: (config: RouterConfig, version: number): Promise<RouterSnapshot> => invoke(ROUTER_IPC.saveConfig, config, version),
  openRouter: (): Promise<Session | undefined> => invoke(ROUTER_IPC.open),
  newRouterSession: (sessionId: string): Promise<Session> => invoke(ROUTER_IPC.newSession,sessionId),
  submitRouterInput: (input: RouterInput): Promise<RouterRequest> => invoke(ROUTER_IPC.submit,input),
  resolveRouterInput: (input: RouterResolution): Promise<RouterRequest> => invoke(ROUTER_IPC.resolve,input),
  cancelRouterInput: (id: string,version:number): Promise<RouterRequest> => invoke(ROUTER_IPC.cancel,id,version),
  interruptRouter: (): Promise<void> => invoke(ROUTER_IPC.interrupt),
  projectMemory: (projectId: string, input: ProjectMemoryRequest): Promise<ProjectMemoryPage> => invoke(PROJECT_MEMORY_IPC,projectId,input),
  onProjectMemoryChanged: (callback:()=>void): (()=>void) => {
    const listener=()=>callback();ipcRenderer.on(PROJECT_MEMORY_CHANGED,listener)
    return ()=>ipcRenderer.removeListener(PROJECT_MEMORY_CHANGED,listener)
  },
  onRouterChanged: (callback:()=>void): (()=>void) => {
    const listener=()=>callback();ipcRenderer.on(ROUTER_IPC.changed,listener);return()=>ipcRenderer.removeListener(ROUTER_IPC.changed,listener)
  },
  createSession: (
    config: SessionConfig,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    activatePlan?: boolean
  ): Promise<Session> => invoke(IPC.createSession, config, prompt, attachments, selection, activatePlan),
  sendMessage: (
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    activatePlan?: boolean,
    bubble?: TurnBubbleInput
  ): Promise<void> => invoke(IPC.sendMessage, sessionId, prompt, attachments, selection, activatePlan, bubble),
  setCollaborationMode: (sessionId: string, mode: CollaborationModeId): Promise<void> =>
    invoke(IPC.setCollaborationMode, sessionId, mode),
  forceSend: (
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    bubble?: TurnBubbleInput
  ): Promise<void> => invoke(IPC.forceSend, sessionId, prompt, attachments, selection, bubble),
  dequeue: (sessionId: string, itemId: string): Promise<void> =>
    invoke(IPC.dequeue, sessionId, itemId),
  promoteQueueItem: (sessionId: string, itemId: string): Promise<void> =>
    invoke(IPC.promoteQueueItem, sessionId, itemId),
  editQueueItem: (
    sessionId: string,
    itemId: string,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    bubble?: TurnBubbleInput
  ): Promise<void> =>
    invoke(IPC.editQueueItem, sessionId, itemId, prompt, attachments, selection, bubble),
  setQueueEditing: (sessionId: string, itemId: string | null): Promise<void> =>
    invoke(IPC.setQueueEditing, sessionId, itemId),
  interrupt: (sessionId: string): Promise<void> => invoke(IPC.interrupt, sessionId),
  listSessions: (): Promise<Session[]> => invoke(IPC.listSessions),
  testTaskTitleGeneration: (input: { requestId: string; config: TaskTitleGenerationConfig; prompt: string }): Promise<TaskTitleResult> => invoke(IPC.testTaskTitleGeneration, input),
  cancelTaskTitleGenerationTest: (requestId: string): Promise<void> => invoke(IPC.cancelTaskTitleGenerationTest, requestId),
  listQueues: (): Promise<Record<string, QueueItem[]>> => invoke(IPC.listQueues),
  getEvents: (sessionId: string): Promise<UAEvent[]> =>
    invoke(IPC.getEvents, sessionId),
  getSessionForkPoints: (sessionId: string): Promise<HistoryForkPoint[]> =>
    invoke(IPC.getSessionForkPoints, sessionId),
  getSessionRuntimeState: (sessionId: string, includeEvents = true): Promise<SessionRuntimeState> =>
    invoke(IPC.getSessionRuntimeState, sessionId, includeEvents),
  getSessionInfo: (sessionId: string): Promise<SessionInfo> => invoke(IPC.getSessionInfo, sessionId),
  revealSessionInfoFile: (sessionId: string, fieldId: string): Promise<void> =>
    invoke(IPC.revealSessionInfoFile, sessionId, fieldId),
  refreshNativeSession: (sessionId: string): Promise<NativeSessionRefreshResult> =>
    invoke(IPC.refreshNativeSession, sessionId),
  enableToolSession: (sessionId: string): Promise<Session> =>
    invoke(IPC.enableToolSession, sessionId),
  // G2-4: archive / unarchive / permanently delete a session.
  getWorktreeArchiveReviews: (): Promise<WorktreeArchiveReview[]> => invoke(WORKTREE_ARCHIVE_IPC.list),
  actWorktreeArchive: (input: WorktreeArchiveAction): Promise<void> => invoke(WORKTREE_ARCHIVE_IPC.act, input),
  onWorktreeArchiveReviews: (callback: (reviews: WorktreeArchiveReview[]) => void): (() => void) => {
    const listener = (_event: unknown, reviews: WorktreeArchiveReview[]) => callback(reviews)
    ipcRenderer.on(WORKTREE_ARCHIVE_IPC.changed, listener)
    return () => ipcRenderer.removeListener(WORKTREE_ARCHIVE_IPC.changed, listener)
  },
  archiveSession: (sessionId: string): Promise<Session | undefined> =>
    invoke(IPC.archiveSession, sessionId),
  unarchiveSession: (sessionId: string): Promise<Session | undefined> =>
    invoke(IPC.unarchiveSession, sessionId),
  previewSessionDeletion: (sessionId: string, requestId?: string): Promise<SessionDeletionPreview> => invoke(IPC.previewSessionDeletion, sessionId, requestId),
  cancelSessionDeletionPreview: (requestId: string): Promise<void> => invoke(IPC.cancelSessionDeletionPreview, requestId),
  onSessionDeletionChecking: (cb: (value: { requestId: string; title: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: { requestId: string; title: string }) => cb(value)
    ipcRenderer.on(IPC.sessionDeletionChecking, handler)
    return () => ipcRenderer.removeListener(IPC.sessionDeletionChecking, handler)
  },
  deleteSession: (sessionId: string, confirmationId?: string): Promise<void> =>
    invoke(IPC.deleteSession, sessionId, confirmationId),
  // 需求4: rename + pin/unpin a session.
  renameSession: (sessionId: string, title: string): Promise<Session | undefined> =>
    invoke(IPC.renameSession, sessionId, title),
  pinSession: (sessionId: string, pinned: boolean): Promise<Session | undefined> =>
    invoke(IPC.pinSession, sessionId, pinned),
  updateSessionConfig: (
    sessionId: string,
    patch: Partial<SessionConfig>
  ): Promise<Session | undefined> =>
    invoke(IPC.updateSessionConfig, sessionId, patch),
  respondRequest: (sessionId: string, requestId: string, answer: unknown): Promise<void> =>
    invoke(IPC.respondRequest, sessionId, requestId, answer),
  getTaskDecisions: (sessionId: string): Promise<TaskDecision[]> => invoke(TASK_IPC.decisions, sessionId),
  resolveTaskDecision: (sessionId: string, input: TaskDecisionAnswer): Promise<void> => invoke(TASK_IPC.resolve, sessionId, input),
  getTaskState: (sessionId: string): Promise<TaskLifecycleSnapshot> => invoke(TASK_IPC.state, sessionId),
  decideTask: (sessionId: string, input: TaskDecisionInput): Promise<TaskLifecycleSnapshot> => invoke(TASK_IPC.decide, sessionId, input),
  getTaskBoard: (query?: TaskBoardQuery): Promise<TaskBoardSnapshot> => invoke(TASK_IPC.board, query),
  onTaskBoardChanged: (cb: () => void): (() => void) => {
    ipcRenderer.on(TASK_IPC.changed, cb)
    return () => ipcRenderer.removeListener(TASK_IPC.changed, cb)
  },

  // Doc2: history
  listAgentHistory: (agentId: string): Promise<SessionSummary[]> =>
    invoke(IPC.listAgentHistory, agentId),
  importSession: (
    agentId: string,
    nativeId: string,
    mode: SessionImportMode = 'snapshot',
    historyCwd?: string,
    historyTitle?: string
  ): Promise<Session | undefined> =>
    invoke(IPC.importSession, agentId, nativeId, mode, historyCwd, historyTitle),
  // 修复#2 — read-only preview of a native session (events only, no Session).
  previewHistory: (
    agentId: string,
    nativeId: string,
    cwd?: string,
    requestId?: string
  ): Promise<{ events: UAEvent[]; cwd?: string; model?: string; forkPoints?: HistoryForkPoint[] }> =>
    invoke(IPC.previewHistory, agentId, nativeId, cwd, requestId),
  onHistoryPreviewProgress: (cb: (progress: HistoryPreviewProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: HistoryPreviewProgress): void => cb(progress)
    ipcRenderer.on(IPC.previewHistoryProgress, handler)
    return () => ipcRenderer.removeListener(IPC.previewHistoryProgress, handler)
  },
  // Doc2: cross-agent resume — transplant a native session into targetAgent's
  // on-disk history, returning the imported UniAgent session.
  exportNativeSession: (
    sourceAgentId: string,
    nativeId: string,
    targetAgentId: string
  ): Promise<Session | undefined> =>
    invoke(IPC.exportNativeSession, sourceAgentId, nativeId, targetAgentId),
  // 需求5（外部会话导入并发治理）— fork a read-only snapshot into a writable
  // branch. 原Agent分叉 = same-agent lossless byte-copy; 换Agent分叉 = rebuild into
  // another agent (potentially lossy). Both mint a fresh native id.
  forkSameSession: (
    agentId: string,
    nativeId: string,
    cwd?: string,
    point?: HistoryForkPoint,
    compatibilityMode?: boolean
  ): Promise<Session | undefined> =>
    invoke(IPC.forkSameSession, agentId, nativeId, cwd, point, compatibilityMode),
  forkCrossSession: (
    sourceAgentId: string,
    nativeId: string,
    targetAgentId: string,
    point?: HistoryForkPoint
  ): Promise<Session | undefined> =>
    invoke(IPC.forkCrossSession, sourceAgentId, nativeId, targetAgentId, point),
  preflightFork: (request: ForkRequest): Promise<ForkPreflight> => invoke(FORK_IPC.preflight, request),
  startFork: (planId: string): Promise<ForkJob> => invoke(FORK_IPC.start, planId),
  getForkJob: (id: string): Promise<ForkJob | undefined> => invoke(FORK_IPC.get, id),
  listForkJobs: (): Promise<ForkJob[]> => invoke(FORK_IPC.list),
  cancelForkJob: (id: string): Promise<ForkJob> => invoke(FORK_IPC.cancel, id),
  retryForkJob: (id: string, allowMissing = false, targetModel?: string): Promise<ForkJob> => invoke(FORK_IPC.retry, id, allowMissing, targetModel),
  revealForkArchive: (id: string): Promise<void> => invoke(FORK_IPC.reveal, id),

  // Doc10: fetch before/after contents for the side-by-side review panel.
  reviewGetFilePair: (req: ReviewFilePairReq): Promise<ReviewFilePair> =>
    invoke(IPC.reviewGetFilePair, req),
  // Doc(变更文件列表改 git-diff 驱动): the workdir's live git change set.
  // 需求一 — an optional `turn` scope returns that turn's frozen artifact
  // instead of the live workspace diff.
  reviewGetChangeSet: (sessionId: string, scope?: ReviewScope): Promise<ReviewChangeSet> =>
    invoke(IPC.reviewGetChangeSet, sessionId, scope),
  // 需求一 — one turn's frozen change summary for the change card.
  getTurnArtifactSummary: (sessionId: string, turnId: string): Promise<TurnArtifactSummary | null> =>
    invoke(IPC.getTurnArtifactSummary, sessionId, turnId),
  // 需求三（会话节点回退）— read-only preflight; the confirm dialog + loading
  // rely on it, and the executor re-checks everything before mutating.
  previewSessionRewind: (sessionId: string, beforeTurnId: string): Promise<RewindPreview> =>
    invoke(IPC.previewSessionRewind, sessionId, beforeTurnId),
  rewindSession: (sessionId: string, beforeTurnId: string): Promise<RewindResult> =>
    invoke(IPC.rewindSession, sessionId, beforeTurnId),
  fsListDir: (sessionId: string, path: string, root?: string): Promise<FileBrowserListResult> =>
    invoke(IPC.fsListDir, sessionId, path, root),
  fsReadFile: (sessionId: string, path: string, options?: FilePreviewOptions, root?: string): Promise<FilePreviewResult> =>
    invoke(IPC.fsReadFile, sessionId, path, options, root),
  fsReadAttachmentImage: (sessionId: string, path: string): Promise<string | null> =>
    invoke(IPC.fsReadAttachmentImage, sessionId, path),
  fsReadNativeImage: (sessionId: string, selector: { eventSeq: number; blockIndex: number; toolResult?: boolean; childSessionId?: string }): Promise<string | null> =>
    invoke(IPC.fsReadNativeImage, sessionId, selector),
  fsReveal: (sessionId: string, path: string, root?: string): Promise<void> =>
    invoke(IPC.fsReveal, sessionId, path, root),
  fsOpenHtml: (sessionId: string, path: string, root?: string): Promise<void> =>
    invoke(IPC.fsOpenHtml, sessionId, path, root),
  getNativeCapabilities: (request: NativeCapabilityRequest): Promise<NativeCapabilitySnapshot> =>
    invoke(IPC.getNativeCapabilities, request),
  createNativeActionSession: (config: SessionConfig, action: NativeThreadAction): Promise<Session> =>
    invoke(IPC.createNativeActionSession, config, action),
  runNativeAction: (sessionId: string, action: NativeThreadAction): Promise<void> =>
    invoke(IPC.runNativeAction, sessionId, action),
  onNativeCapabilitiesChanged: (cb: (change: NativeCapabilityChange) => void): (() => void) => {
    const h = (_e: unknown, change: NativeCapabilityChange): void => cb(change)
    ipcRenderer.on(IPC.nativeCapabilitiesChanged, h)
    return () => ipcRenderer.removeListener(IPC.nativeCapabilitiesChanged, h)
  },
  capabilitySyncScan: (request: CapabilityScanRequest): Promise<CapabilityScanResult> => invoke(IPC.capabilitySyncScan, request),
  capabilitySyncPlan: (request: CapabilityPlanRequest): Promise<CapabilitySyncPlan> => invoke(IPC.capabilitySyncPlan, request),
  capabilitySyncExecute: (request: CapabilityExecuteRequest): Promise<CapabilitySyncJob> => invoke(IPC.capabilitySyncExecute, request),
  capabilitySyncGetJob: (jobId: string): Promise<CapabilitySyncJob | undefined> => invoke(IPC.capabilitySyncGetJob, { jobId }),
  capabilitySyncGetJobSnapshot: (): Promise<CapabilityJobSnapshot> => invoke(CAPABILITY_SYNC_JOB_SNAPSHOT_CHANNEL),
  capabilitySyncCancel: (jobId: string): Promise<CapabilitySyncJob | undefined> => invoke(IPC.capabilitySyncCancel, { jobId }),
  capabilitySyncRollback: (transactionId: string): Promise<CapabilitySyncJob> => invoke(IPC.capabilitySyncRollback, { transactionId }),
  capabilitySyncPreview: (scanId: string, itemId: 'global-instructions:agents', strategy: AgentsStrategy): Promise<CapabilityMarkdownPreview> => invoke(IPC.capabilitySyncPreview, { scanId, itemId, strategy }),
  onCapabilitySyncProgress: (cb: (job: CapabilitySyncJob) => void): (() => void) => { const h = (_e: unknown, job: CapabilitySyncJob): void => cb(job); ipcRenderer.on(IPC.capabilitySyncProgress, h); return () => ipcRenderer.removeListener(IPC.capabilitySyncProgress, h) },
  capabilityInventoryList: (): Promise<CapabilityInventoryResult> => invoke(IPC.capabilityInventoryList),
  capabilityInventoryDetail: (id: string, loadMcpTools = false): Promise<CapabilityInventoryDetail> => invoke(IPC.capabilityInventoryDetail, { id, ...(loadMcpTools ? { loadMcpTools: true } : {}) }),
  capabilityInventoryManage: (request: CapabilityInventoryManageRequest): Promise<CapabilityInventoryManageResult> => invoke(IPC.capabilityInventoryManage, request),
  capabilityInventoryPrepareSync: (request: CapabilityInventorySyncRequest): Promise<CapabilityInventorySyncPreparation> => invoke(IPC.capabilityInventoryPrepareSync, request),
  capabilityMutationPlanRemove: (target: 'codex' | 'traex' | 'qoder', selections: string[]): Promise<CapabilitySyncPlan> => invoke(IPC.capabilityMutationPlanRemove, { target, selections }),
  capabilityPluginAction: (request: CapabilityPluginActionRequest): Promise<CapabilityPluginActionResult> => invoke(IPC.capabilityPluginAction, request),
  capabilitySkillLinkRemove: (id: string, agentId: CapabilityAgentId, expectedFingerprint?: string): Promise<{ agentId?: CapabilityAgentId; name: string; affectedAgents?: CapabilityAgentId[] }> => invoke(IPC.capabilitySkillLinkRemove, { id, agentId, ...(expectedFingerprint ? { expectedFingerprint } : {}) }),
  onCapabilityInventoryChanged: (cb: () => void): (() => void) => { const h = (): void => cb(); ipcRenderer.on(IPC.capabilityInventoryChanged, h); return () => ipcRenderer.removeListener(IPC.capabilityInventoryChanged, h) },

  // Doc11: handoff presets.
  listPresets: (): Promise<HandoffPreset[]> => invoke(IPC.listPresets),
  savePreset: (preset: HandoffPreset): Promise<HandoffPreset[]> =>
    invoke(IPC.savePreset, preset),
  deletePreset: (id: string): Promise<HandoffPreset[]> =>
    invoke(IPC.deletePreset, id),
  // MCP-callable Agent roles (stored independently from task presets).
  listRoles: (): Promise<AgentRoleCatalogEntry[]> => invoke(IPC.listRoles),
  saveRole: (role: AgentRole): Promise<AgentRoleCatalogEntry[]> =>
    invoke(IPC.saveRole, role),
  deleteRole: (id: string): Promise<AgentRoleCatalogEntry[]> =>
    invoke(IPC.deleteRole, id),
  listRequirements: (): Promise<Requirement[]> => invoke(REQUIREMENT_IPC.list),
  readRequirementOverview: (id: string, documentId?: string, query?: import('../shared/requirementTypes').RequirementOverviewQuery): Promise<import('../shared/requirementTypes').RequirementOverview> => invoke(REQUIREMENT_IPC.overview, id, documentId, query),
  requirementCuration: (id: string, action?: 'read' | 'retry' | 'retryFailed' | 'pause' | 'organize'): Promise<import('../shared/requirementTypes').RequirementCurationState> => invoke(REQUIREMENT_IPC.curation, id, action),
  requirementCurationConversation: (id: string): Promise<import('../shared/requirementTypes').RequirementCurationConversation> => invoke(REQUIREMENT_IPC.curationConversation, id),
  requirementStorage: (id: string, token?: string): Promise<import('../shared/requirementTypes').RequirementStoragePreview> => invoke(REQUIREMENT_IPC.storage, id, token),
  createRequirement: (input: RequirementInput): Promise<Requirement> => invoke(REQUIREMENT_IPC.create, input),
  updateRequirement: (id: string, patch: RequirementPatch): Promise<Requirement> => invoke(REQUIREMENT_IPC.update, id, patch),
  openRequirementDir: (id: string): Promise<void> => invoke(REQUIREMENT_IPC.openDir, id),
  onRequirementsChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on(REQUIREMENT_IPC.changed, handler)
    return () => ipcRenderer.removeListener(REQUIREMENT_IPC.changed, handler)
  },
  listProjects: (): Promise<Project[]> => invoke(IPC.listProjects),
  getProjectGitInfo: (projectId: string, requestId?: string): Promise<ProjectGitInfo> => invoke(IPC.getProjectGitInfo, projectId, requestId),
  listProjectWorktrees: (projectId: string): Promise<ProjectWorktree[]> => invoke(IPC.listProjectWorktrees, projectId),
  getSessionWorktreeStatus: (sessionId: string, refresh?: boolean): Promise<SessionWorktreeStatus | null> => invoke(SESSION_WORKTREE_STATUS_IPC, sessionId, refresh),
  getTaskGenerationConversation: (taskId: string): Promise<TaskGenerationConversation> => invoke(TASK_GENERATION_IPC.read, taskId),
  onTaskGenerationChanged: (cb: (event: { taskId: string }) => void): (() => void) => {
    const handler = (_event: unknown, value: { taskId: string }): void => cb(value)
    ipcRenderer.on(TASK_GENERATION_IPC.changed, handler)
    return () => { ipcRenderer.removeListener(TASK_GENERATION_IPC.changed, handler) }
  },
  removeProjectWorktree: (projectId: string, path: string): Promise<ProjectWorktree[]> => invoke(IPC.removeProjectWorktree, projectId, path),
  openProjectWorktree: (projectId: string, path: string): Promise<void> => invoke(IPC.openProjectWorktree, projectId, path),
  retryWorktreeTask: (sessionId: string): Promise<void> => invoke(IPC.retryWorktreeTask, sessionId),
  createProject: (input: ProjectInput): Promise<Project> => invoke(IPC.createProject, input),
  updateProject: (id: string, input: ProjectInput): Promise<Project> => invoke(IPC.updateProject, id, input),
  deleteProject: (id: string): Promise<Project[]> => invoke(IPC.deleteProject, id),
  // Doc11: self-test the injected handoff MCP server (verification harness).
  handoffSelfTest: (): Promise<{
    serverPath: string
    inboxDir: string
    resultsDir: string
    catalogPath: string
    tools: string[]
    taskSchema: string[]
    injectedFor: string[]
    ok: boolean
    error?: string
  }> => invoke(IPC.handoffSelfTest),

  compactSession: (sessionId: string): Promise<void> =>
    invoke(IPC.compactSession, sessionId),
  // 需求2: fetch a sub-agent's own rollout events for the detail panel.
  getSubAgentItems: (sessionId: string, agentThreadId: string): Promise<any[]> =>
    invoke(IPC.subagentItems, sessionId, agentThreadId),
  cancelSubAgent: (sessionId: string, agentThreadId: string): Promise<void> =>
    invoke(IPC.subagentCancel, sessionId, agentThreadId),
  // 需求2（侧边对话 /side）: ephemeral side-branch chat off the main rollout.
  sideCanOpen: (sessionId: string): Promise<boolean> => invoke(IPC.sideCanOpen, sessionId),
  sendSideMessage: (
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    activatePlan?: boolean,
    bubble?: TurnBubbleInput
  ): Promise<void> => invoke(IPC.sideSend, sessionId, prompt, attachments, selection, activatePlan, bubble),
  forceSendSideMessage: (
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    bubble?: TurnBubbleInput
  ): Promise<void> => invoke(IPC.sideForceSend, sessionId, prompt, attachments, selection, bubble),
  getSideState: (sessionId: string): Promise<SideChatState> => invoke(IPC.sideGetState, sessionId),
  updateSideConfig: (sessionId: string, patch: Partial<SessionConfig>): Promise<SideChatState> =>
    invoke(IPC.sideUpdateConfig, sessionId, patch),
  setSideCollaborationMode: (sessionId: string, mode: CollaborationModeId): Promise<SideChatState> =>
    invoke(IPC.sideSetCollaborationMode, sessionId, mode),
  runSideNativeAction: (sessionId: string, action: NativeThreadAction): Promise<void> =>
    invoke(IPC.sideRunNativeAction, sessionId, action),
  compactSideChat: (sessionId: string): Promise<void> => invoke(IPC.sideCompact, sessionId),
  respondSideRequest: (sessionId: string, requestId: string, answer: unknown): Promise<void> =>
    invoke(IPC.sideRespond, sessionId, requestId, answer),
  dequeueSideMessage: (sessionId: string, itemId: string): Promise<void> =>
    invoke(IPC.sideDequeue, sessionId, itemId),
  promoteSideMessage: (sessionId: string, itemId: string): Promise<void> =>
    invoke(IPC.sidePromoteQueue, sessionId, itemId),
  editSideMessage: (
    sessionId: string,
    itemId: string,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest
  ): Promise<void> => invoke(IPC.sideEditQueue, sessionId, itemId, prompt, attachments, selection),
  setSideQueueEditing: (sessionId: string, itemId: string | null): Promise<void> =>
    invoke(IPC.sideSetQueueEditing, sessionId, itemId),
  interruptSide: (sessionId: string): Promise<void> => invoke(IPC.sideInterrupt, sessionId),
  getSideEvents: (sessionId: string): Promise<UAEvent[]> => invoke(IPC.sideGetEvents, sessionId),
  getSideStatus: (sessionId: string): Promise<SideChatStatus> => invoke(IPC.sideGetStatus, sessionId),
  closeSideChat: (sessionId: string): Promise<void> => invoke(IPC.sideClose, sessionId),
  promoteSideToSession: (sessionId: string): Promise<Session> => invoke(IPC.sidePromote, sessionId),
  // 选中即评论 / 详情: ephemeral detail-branch chat explaining a text selection.
  listComments: (id: string): Promise<CommentThread[]> => invoke(COMMENT_IPC.list, id),
  createComment: (id: string, selection: CommentSelection): Promise<CommentThread> => invoke(COMMENT_IPC.create, id, selection),
  sendComment: (owner: string, id: string, text: string, model?: CommentModel, clientTurnKey?: string): Promise<void> => invoke(COMMENT_IPC.send, owner, id, text, model, clientTurnKey),
  stopComment: (owner: string, id: string): Promise<void> => invoke(COMMENT_IPC.stop, owner, id),
  deleteComment: (owner: string, id: string): Promise<void> => invoke(COMMENT_IPC.remove, owner, id),
  respondComment: (owner: string, id: string, request: string, answer: unknown): Promise<void> => invoke(COMMENT_IPC.respond, owner, id, request, answer),
  onCommentChanged: (cb: (thread: CommentThread) => void): (() => void) => {
    const handler = (_e: unknown, thread: CommentThread): void => cb(thread)
    ipcRenderer.on(COMMENT_IPC.changed, handler)
    return () => ipcRenderer.removeListener(COMMENT_IPC.changed, handler)
  },
  onCommentRemoved: (cb: (reference: { sessionId: string; id: string }) => void): (() => void) => {
    const handler = (_e: unknown, reference: { sessionId: string; id: string }): void => cb(reference)
    ipcRenderer.on(COMMENT_IPC.removed, handler)
    return () => ipcRenderer.removeListener(COMMENT_IPC.removed, handler)
  },
  getDetailWindow: (): Promise<{ sessionId: string; quote: string; selectedMessageText: string; nonce: number; theme?: AppSettings['theme'] }> => invoke('detailWindow:action', 'initial'),
  onDetailPromoted: (cb: (result: { sessionId: string; kind: 'side' | 'session'; session?: Session }) => void): (() => void) => {
    const handler = (_e: unknown, result: Parameters<typeof cb>[0]): void => cb(result)
    ipcRenderer.on('detailWindow:promoted', handler)
    return () => ipcRenderer.removeListener('detailWindow:promoted', handler)
  },
  explainDetailSelection: (sessionId: string, context: import('../shared/detailQuickChat').DetailExplanationContext): Promise<void> =>
    invoke(IPC.detailExplain, sessionId, context),
  sendDetailMessage: (sessionId: string, prompt: string, attachments?: Attachment[], bubble?: TurnBubbleInput): Promise<void> =>
    invoke(IPC.detailSend, sessionId, prompt, attachments, bubble),
  interruptDetail: (sessionId: string): Promise<void> => invoke(IPC.detailInterrupt, sessionId),
  getDetailEvents: (sessionId: string): Promise<UAEvent[]> => invoke(IPC.detailGetEvents, sessionId),
  getDetailStatus: (sessionId: string): Promise<'idle' | 'running'> => invoke(IPC.detailGetStatus, sessionId),
  closeDetail: (sessionId: string): Promise<void> => invoke(IPC.detailClose, sessionId),
  promoteDetailToSide: (sessionId: string): Promise<boolean> => invoke(IPC.detailPromote, sessionId),
  promoteDetailToSession: (sessionId: string): Promise<Session> => invoke(IPC.detailPromoteSession, sessionId),
  e2eEnabled: (): Promise<boolean> => invoke(IPC.e2eEnabled),
  e2eInjectEvents: (events: UAEvent[]): Promise<boolean> => invoke(IPC.e2eInjectEvents, events),
  e2eLifecycleFixture: (mode: 'mixed' | 'zero' | 'same-version' = 'mixed'): Promise<AgentDef[]> => invoke(IPC.e2eLifecycleFixture, mode),
  e2eLastTokenUsageQuery: (): Promise<KabooUsageQuery | null> => invoke(IPC.e2eLastTokenUsageQuery),
  e2eTokenUsageRequestCount: (): Promise<number> => invoke(IPC.e2eTokenUsageRequestCount),
  e2eLifecycleUpdateGuard: (): Promise<string> => invoke(IPC.e2eLifecycleUpdateGuard),
  // 需求3 验证：回读主进程记录的最近一次 respondRequest 入参。
  e2eLastResponse: (): Promise<{ sessionId: string; requestId: string; answer: unknown } | null> =>
    invoke(IPC.e2eLastResponse),
  // Fix#4 验证：把 sessionId 标记为「等待其它 agent 交接」（或传 null info 清除），
  // 主进程复用真实 sessionUpdated 推送。
  e2eSetWaitingForHandoff: (
    sessionId: string,
    info: {
      handoffId: string
      awaitedSessionId: string
      agentId: string
      agentName: string
      label: string
    } | null
  ): Promise<boolean> => invoke(IPC.e2eSetWaitingForHandoff, sessionId, info),

  // Doc4 需求4: automations
  listAutomations: (): Promise<AutomationTask[]> => invoke(IPC.listAutomations),
  createAutomation: (input: NativeAutomationInput): Promise<AutomationDetail> => invoke(IPC.createAutomation, input),
  retryAutomation: (task: AutomationDetail): Promise<AutomationDetail> => invoke(IPC.retryAutomation, task),
  onAutomationsChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on(IPC.automationsChanged, handler)
    return () => ipcRenderer.removeListener(IPC.automationsChanged, handler)
  },
  setAutomationStatus: (target: string | AutomationTask, status: 'active' | 'paused'): Promise<boolean> =>
    invoke(IPC.setAutomationStatus, target, status),
  // 需求1（详情/编辑/删除）: lazy detail load, edit, delete for a task row.
  getAutomationDetail: (task: AutomationTask): Promise<AutomationDetail | null> =>
    invoke(IPC.getAutomationDetail, task),
  updateAutomation: (task: AutomationTask, patch: AutomationEditPatch): Promise<boolean> =>
    invoke(IPC.updateAutomation, task, patch),
  deleteAutomation: (task: AutomationTask): Promise<boolean> =>
    invoke(IPC.deleteAutomation, task),

  // Doc5 T2: per-agent last-choice preferences
  listQoderByok: () => ipcRenderer.invoke(QODER_IPC.byokList),
  saveQoderByok: (input: import('../shared/qoder').QoderByokInput) => ipcRenderer.invoke(QODER_IPC.byokSave, input),
  deleteQoderByok: (source: Pick<import('../shared/qoder').QoderByokSource, 'id' | 'kind'>) => ipcRenderer.invoke(QODER_IPC.byokDelete, source),
  getPrefs: (): Promise<PrefsData> => invoke(IPC.getPrefs),
  setPrefs: (agentId: string, pref: AgentPref): Promise<PrefsData> =>
    invoke(IPC.setPrefs, agentId, pref),
  onPrefsChanged: (callback: (prefs: PrefsData) => void): (() => void) => {
    const listener = (_event: unknown, prefs: PrefsData): void => callback(prefs)
    ipcRenderer.on(IPC.prefsChanged, listener)
    return () => { ipcRenderer.removeListener(IPC.prefsChanged, listener) }
  },
  getAppSettings: (): Promise<AppSettings> => invoke(IPC.getAppSettings),
  getRecoveryErrors: (): Promise<import('../shared/sessionRecovery').RecoveryErrorType[]> => invoke(IPC.getRecoveryErrors),
  cancelRecovery: (sessionId: string): Promise<boolean> => invoke(IPC.cancelRecovery, sessionId),
  getLocalModels: (): Promise<LocalModelsSnapshot> => invoke(LOCAL_MODEL_IPC.get),
  downloadLocalModel: (modelId: string): Promise<LocalModelsSnapshot> => invoke(LOCAL_MODEL_IPC.download, modelId),
  deployLocalModel: (modelId: string): Promise<LocalModelsSnapshot> => invoke(LOCAL_MODEL_IPC.deploy, modelId),
  stopLocalModel: (): Promise<LocalModelsSnapshot> => invoke(LOCAL_MODEL_IPC.stop),
  removeLocalModel: (input: { modelId: string; confirmed: true }): Promise<LocalModelsSnapshot> => invoke(LOCAL_MODEL_IPC.remove, input),
  onLocalModelsChanged: (callback: (snapshot: LocalModelsSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: LocalModelsSnapshot): void => callback(snapshot)
    ipcRenderer.on(LOCAL_MODEL_IPC.changed, listener)
    return () => { ipcRenderer.removeListener(LOCAL_MODEL_IPC.changed, listener) }
  },
  getCodexSources: (): Promise<CodexSourcesSnapshot> => invoke(CODEX_SOURCE_IPC.get),
  getModelSources: (): Promise<ModelSourcesSnapshot> => invoke(MODEL_SOURCE_IPC.get),
  saveModelSourceQuota: (input: import('../shared/modelSourceQuota').ModelSourceQuotaSave): Promise<ModelSourcesSnapshot> => invoke(MODEL_SOURCE_IPC.saveQuota, input),
  refreshModelSourceQuotas: (sourceId?: string, force = false): Promise<ModelSourcesSnapshot> => invoke(MODEL_SOURCE_IPC.quota, sourceId, force),
  discoverModelSourceImports: (): Promise<{ candidates: import('../shared/modelSources').ModelSourceImport[]; errors: string[] }> => invoke(MODEL_SOURCE_IPC.import),
  connectEnterpriseModelSource: (): Promise<ModelSourceInput> => invoke(MODEL_SOURCE_IPC.login),
  saveModelSource: (input: ModelSourceSave): Promise<ModelSourcesSnapshot> => invoke(MODEL_SOURCE_IPC.save, input),
  applyModelSources: (sourceId?: string): Promise<ModelSourcesSnapshot> => invoke(MODEL_SOURCE_IPC.apply, sourceId),
  queryModelSource: (input: ModelSourceInput, endpointId: string): Promise<ModelSourceInput['models']> => invoke(MODEL_SOURCE_IPC.query, input, endpointId),
  testModelSource: (input: ModelSourceInput, endpointId: string, modelId: string): Promise<import('../shared/modelSources').SourceConnectionTest> => invoke(MODEL_SOURCE_IPC.test, input, endpointId, modelId),
  revealModelSourceCredential: (sourceId: string, endpointId: string, expectedConnection: string): Promise<string> => invoke(MODEL_SOURCE_IPC.reveal, sourceId, endpointId, expectedConnection),
  onModelSourcesChanged: (callback: (snapshot: ModelSourcesSnapshot) => void): (() => void) => { const listener = (_event: unknown, value: ModelSourcesSnapshot) => callback(value); ipcRenderer.on(MODEL_SOURCE_IPC.changed, listener); return () => ipcRenderer.removeListener(MODEL_SOURCE_IPC.changed, listener) },
  getClaudeSources: (): Promise<CodexSourcesSnapshot> => invoke(CLAUDE_SOURCE_IPC.get),
  saveClaudeSource: (input: CodexSourceInput): Promise<CodexSourcesSnapshot> => invoke(CLAUDE_SOURCE_IPC.save, input),
  queryClaudeSourceModels: (input: CodexSourceModelQueryInput): Promise<string[]> => invoke(CLAUDE_SOURCE_IPC.queryModels, input),
  testClaudeSource: (input: CodexSourceInput): Promise<string> => invoke(CLAUDE_SOURCE_IPC.test, input),
  listModelCredentials: (client: ModelSourceClient): Promise<ReusableCredential[]> => invoke(MODEL_CREDENTIAL_IPC.list, client),
  importModelCredential: (client: ModelSourceClient, selection: CredentialSelection): Promise<CodexSourcesSnapshot> => invoke(MODEL_CREDENTIAL_IPC.import, client, selection),
  onClaudeSourcesChanged: (callback: (snapshot: CodexSourcesSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: CodexSourcesSnapshot): void => callback(snapshot)
    ipcRenderer.on(CLAUDE_SOURCE_IPC.changed, listener)
    return () => ipcRenderer.removeListener(CLAUDE_SOURCE_IPC.changed, listener)
  },
  refreshCodexSourceQuotas: (): Promise<CodexSourcesSnapshot> => invoke(CODEX_SOURCE_IPC.refreshQuota),
  queryCodexSourceModels: (input: CodexSourceModelQueryInput): Promise<string[]> => invoke(CODEX_SOURCE_IPC.queryModels, input),
  saveCodexSource: (input: CodexSourceInput): Promise<CodexSourcesSnapshot> => invoke(CODEX_SOURCE_IPC.save, input),
  setCodexSourcesEnabled: (enabled: boolean): Promise<CodexSourcesSnapshot> => invoke(CODEX_SOURCE_IPC.enabled, enabled),
  restartCodexSources: (): Promise<CodexSourcesSnapshot> => invoke(CODEX_SOURCE_IPC.restart),
  migrateCodexSources: (): Promise<CodexSourcesSnapshot> => invoke(CODEX_SOURCE_IPC.migrate),
  onCodexSourcesChanged: (callback: (snapshot: CodexSourcesSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: CodexSourcesSnapshot): void => callback(snapshot)
    ipcRenderer.on(CODEX_SOURCE_IPC.changed, listener)
    return () => { ipcRenderer.removeListener(CODEX_SOURCE_IPC.changed, listener) }
  },
  setAppSettings: (patch: AppSettingsPatch): Promise<AppSettings> => invoke(IPC.setAppSettings, patch),
  checkAppUpdate: (force = false): Promise<AppUpdateState> => invoke(IPC.checkAppUpdate, force),
  getAppVersion: (): Promise<string> => invoke(IPC.getAppVersion),
  getTokenUsage: (query: KabooUsageQuery): Promise<KabooProfileResult> =>
    invoke(IPC.getTokenUsage, query),
  refreshTokenUsage: (query?: KabooUsageQuery): Promise<void> => invoke(IPC.refreshTokenUsage, query),
  getNativeTokenUsage: (query: KabooUsageQuery): Promise<KabooProfileResult> =>
    invoke(IPC.getNativeTokenUsage, query),
  refreshNativeTokenUsage: (): Promise<void> => invoke(IPC.refreshNativeTokenUsage),
  logTokenUsage: (event: string, data?: unknown): Promise<void> =>
    invoke(IPC.logTokenUsage, { event, data }),
  getCodexRateLimits: (force = false): Promise<CodexRateLimits | null> => invoke(IPC.getCodexRateLimits, force),
  onCodexRateLimits: (cb: (limits: CodexRateLimits) => void): (() => void) => {
    const h = (_e: unknown, limits: CodexRateLimits): void => cb(limits)
    ipcRenderer.on(IPC.codexRateLimitsChanged, h)
    return () => ipcRenderer.removeListener(IPC.codexRateLimitsChanged, h)
  },
  getClaudeRateLimits: (): Promise<CodexRateLimits | null> => invoke(IPC.getClaudeRateLimits),
  onClaudeRateLimits: (cb: (limits: CodexRateLimits) => void): (() => void) => {
    const h = (_e: unknown, limits: CodexRateLimits): void => cb(limits)
    ipcRenderer.on(IPC.claudeRateLimitsChanged, h)
    return () => ipcRenderer.removeListener(IPC.claudeRateLimitsChanged, h)
  },
  getGrokQuota: (force = false): Promise<GrokQuota | null> => invoke(IPC.getGrokQuota, force),
  getAgentQuota: (agentId: string, force = false, providerId?: string): Promise<AgentQuotaSnapshot | null> => invoke(IPC.getAgentQuota, agentId, force, providerId),
  getZCodeQuota: (force = false, providerId?: string): Promise<ZCodeQuotaSnapshot | null> => invoke(ZCODE_IPC.quota, force, providerId),
  getLifecycleMetrics: (): Promise<LifecycleMetrics> => invoke(IPC.getLifecycleMetrics),

  // 需求4（飞书 Bot 远程驱动）: one-click install wizard + status/stop. Progress
  // (install phases, verification URL, connection badge) streams via
  // onFeishuInstallProgress.
  feishuInstall: (): Promise<FeishuStatus> => invoke(IPC.feishuInstall),
  feishuBind: (input: import('../shared/assistant').AssistantFeishuInput): Promise<FeishuStatus> => invoke(IPC.feishuBind, input),
  feishuCancelInstall: (): Promise<FeishuStatus> => invoke(IPC.feishuCancelInstall),
  feishuStatus: (): Promise<FeishuStatus> => invoke(IPC.feishuStatus),
  feishuStop: (): Promise<FeishuStatus> => invoke(IPC.feishuStop),
  feishuScanGroups: (): Promise<FeishuGroupChat[]> => invoke(IPC.feishuScanGroups),
  feishuBeginNotificationBinding: (input: import('../shared/types').FeishuNotificationBinding): Promise<FeishuStatus> => invoke(IPC.feishuBeginNotificationBinding, input),
  feishuCancelNotificationBinding: (): Promise<FeishuStatus> => invoke(IPC.feishuCancelNotificationBinding),
  feishuUnbindNotificationTarget: (): Promise<FeishuStatus> => invoke(IPC.feishuUnbindNotificationTarget),
  onFeishuInstallProgress: (cb: (status: FeishuStatus) => void): (() => void) => {
    const h = (_e: unknown, status: FeishuStatus): void => cb(status)
    ipcRenderer.on(IPC.feishuInstallProgress, h)
    return () => ipcRenderer.removeListener(IPC.feishuInstallProgress, h)
  },

  // 跨 Agent 迁移诊断: list / clear collected reports; copyReport also returns the
  // rendered markdown (already placed on the clipboard by main).
  listDiagnostics: (): Promise<DiagnosticEntry[]> => invoke(IPC.listDiagnostics),
  getQueueWaitQuality: (query?: QueueWaitQualityQuery): Promise<QueueWaitQualityReport> => invoke(IPC.getQueueWaitQuality, query),
  copyQueueWaitQuality: (query?: QueueWaitQualityQuery): Promise<void> => invoke(IPC.copyQueueWaitQuality, query),
  openQueueWaitQualityLogs: (): Promise<void> => invoke(IPC.openQueueWaitQualityLogs),
  clearDiagnostics: (): Promise<void> => invoke(IPC.clearDiagnostics),
  removeDiagnostics: (ids: string[]): Promise<void> => invoke(IPC.removeDiagnostics, ids),
  copyDiagnosticsReport: (ids?: string[]): Promise<string> => invoke(IPC.copyDiagnosticsReport, ids),
  startupState: (): Promise<{ ready: boolean; error?: string }> => invoke(IPC.startupState),
  restartApp: (): Promise<void> => rawInvoke(IPC.restartApp),
  onStartupFailed: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on(IPC.startupFailed, h)
    return () => ipcRenderer.removeListener(IPC.startupFailed, h)
  },
  reportDiagnostic: (issue: { source: string; code: string; message: string; stack?: string; sample?: unknown; level?: 'warn' | 'error' }): Promise<void> =>
    rawInvoke(IPC.reportDiagnostic, issue),

  pickDirectory: (): Promise<string | null> => invoke(IPC.pickDirectory),
  // 计时胶囊重构 — summary dock pinned: window min-width grows by the dock width.
  setSummaryDockWidth: (extraWidth: number): Promise<void> =>
    invoke(IPC.setSummaryDockWidth, extraWidth),
  pickFiles: (): Promise<PickedFile[]> => invoke(IPC.pickFiles),
  saveClipboardImage: (dataUrl?: string): Promise<Attachment | null> =>
    invoke(IPC.saveClipboardImage, dataUrl),
  // 图片详情右键「复制图片」: main writes the image onto the OS clipboard and
  // reports whether it landed, so the menu can confirm instead of guessing.
  copyImageToClipboard: (dataUrl: string): Promise<boolean> =>
    invoke(IPC.copyImageToClipboard, dataUrl),
  openExternal: (url: string): Promise<void> => invoke(IPC.openExternal, url),

  onEvent: (cb: (ev: UAEvent) => void): (() => void) => {
    const h = (_e: unknown, value: UAEvent | UAEvent[]): void => {
      for (const event of Array.isArray(value) ? value : [value]) cb(event)
    }
    ipcRenderer.on(IPC.event, h)
    return () => ipcRenderer.removeListener(IPC.event, h)
  },
  getZCodeRuntime: (): Promise<ZCodeRuntimeSnapshot> => invoke(ZCODE_IPC.runtimeSnapshot),
  getZCodeInstallation: (): Promise<ZCodeInstallationSnapshot> => invoke(ZCODE_IPC.installation),
  installZCode: (): Promise<ZCodeInstallationSnapshot> => invoke(ZCODE_IPC.install),
  cancelZCodeInstall: (): Promise<void> => invoke(ZCODE_IPC.cancelInstall),
  selectZCodeRuntime: (): Promise<ZCodeInstallationSnapshot | null> => invoke(ZCODE_IPC.selectRuntime),
  getZCodeConfiguration: (): Promise<ZCodeConfigurationSnapshot> => invoke(ZCODE_IPC.configuration),
  checkZCodeConfiguration: (input: ZCodeConfigurationInput): Promise<ZCodeConfigurationSnapshot> => invoke(ZCODE_IPC.checkConfiguration, input),
  saveZCodeRuntime: (config: ZCodeRuntimeConfig): Promise<ZCodeRuntimeSnapshot> => invoke(ZCODE_IPC.saveRuntime, config),
  pickZCodeRuntimeFile: (kind: 'file' | 'directory' = 'file'): Promise<string | null> => invoke(ZCODE_IPC.pickRuntimeFile, kind),
  loadZCodeEarlier: (sessionId: string, beforeRowId?: number): Promise<{ hasMore: boolean }> => invoke(ZCODE_IPC.loadEarlier, sessionId, beforeRowId),
  onZCodeEventsReset: (cb: (snapshot: ZCodeEventsSnapshot) => void): (() => void) => {
    const handler = (_event: unknown, snapshot: ZCodeEventsSnapshot) => cb(snapshot)
    ipcRenderer.on(ZCODE_IPC.eventsReset, handler)
    return () => ipcRenderer.removeListener(ZCODE_IPC.eventsReset, handler)
  },
  onLifecycleProgress: (cb: (progress: AgentLifecycleProgress) => void): (() => void) => {
    const h = (_e: unknown, progress: AgentLifecycleProgress): void => cb(progress)
    ipcRenderer.on(IPC.lifecycleProgress, h)
    return () => ipcRenderer.removeListener(IPC.lifecycleProgress, h)
  },
  onStatusChange: (cb: (s: { sessionId: string; status: SessionStatus; updatedAt?: number }) => void): (() => void) => {
    const h = (_e: unknown, s: { sessionId: string; status: SessionStatus; updatedAt?: number }): void => cb(s)
    ipcRenderer.on(IPC.statusChange, h)
    return () => ipcRenderer.removeListener(IPC.statusChange, h)
  },
  onQueueChange: (
    cb: (q: { sessionId: string; queue: QueueItem[] }) => void
  ): (() => void) => {
    const h = (_e: unknown, q: { sessionId: string; queue: QueueItem[] }): void => cb(q)
    ipcRenderer.on(IPC.queueChange, h)
    return () => ipcRenderer.removeListener(IPC.queueChange, h)
  },
  // 需求2（侧边对话）: live pushes for the ephemeral side branch.
  onSideEvent: (cb: (p: { sessionId: string; event: UAEvent }) => void): (() => void) => {
    const h = (_e: unknown, p: { sessionId: string; event: UAEvent }): void => cb(p)
    ipcRenderer.on(IPC.sideEvent, h)
    return () => ipcRenderer.removeListener(IPC.sideEvent, h)
  },
  onSideStatus: (cb: (p: { sessionId: string; status: SideChatStatus }) => void): (() => void) => {
    const h = (_e: unknown, p: { sessionId: string; status: SideChatStatus }): void => cb(p)
    ipcRenderer.on(IPC.sideStatus, h)
    return () => ipcRenderer.removeListener(IPC.sideStatus, h)
  },
  onSideState: (cb: (p: { sessionId: string; state: SideChatState }) => void): (() => void) => {
    const h = (_e: unknown, p: { sessionId: string; state: SideChatState }): void => cb(p)
    ipcRenderer.on(IPC.sideState, h)
    return () => ipcRenderer.removeListener(IPC.sideState, h)
  },
  // 选中即评论 / 详情: live pushes for the ephemeral detail branch.
  onDetailEvent: (cb: (p: { sessionId: string; event: UAEvent }) => void): (() => void) => {
    const h = (_e: unknown, p: { sessionId: string; event: UAEvent }): void => cb(p)
    ipcRenderer.on(IPC.detailEvent, h)
    return () => ipcRenderer.removeListener(IPC.detailEvent, h)
  },
  onDetailStatus: (cb: (p: { sessionId: string; status: 'idle' | 'running' }) => void): (() => void) => {
    const h = (_e: unknown, p: { sessionId: string; status: 'idle' | 'running' }): void => cb(p)
    ipcRenderer.on(IPC.detailStatus, h)
    return () => ipcRenderer.removeListener(IPC.detailStatus, h)
  },
  onSessionUpdated: (cb: (update: SessionUpdatedPush) => void): (() => void) => {
    const h = (_e: unknown, update: SessionUpdatedPush): void => cb(update)
    ipcRenderer.on(IPC.sessionUpdated, h)
    return () => ipcRenderer.removeListener(IPC.sessionUpdated, h)
  },
  // 跨 Agent 迁移诊断: live push when a new unhandled-data diagnostic is recorded.
  onDiagnostic: (cb: (entry: DiagnosticEntry) => void): (() => void) => {
    const h = (_e: unknown, entry: DiagnosticEntry): void => cb(entry)
    ipcRenderer.on(IPC.diagnostic, h)
    return () => ipcRenderer.removeListener(IPC.diagnostic, h)
  },
  // Doc11: live push when an agent 交接 a follow-up task (a session created in
  // main via the create_uniagent_task MCP tool) so the sidebar shows it live.
  onSessionCreated: (cb: (session: Session) => void): (() => void) => {
    const h = (_e: unknown, session: Session): void => cb(session)
    ipcRenderer.on(IPC.sessionCreated, h)
    return () => ipcRenderer.removeListener(IPC.sessionCreated, h)
  },
  onAgentUpdate: (cb: (update: AgentContractUpdate) => void): (() => void) => {
    const h = (_e: unknown, update: AgentContractUpdate): void => cb(update)
    ipcRenderer.on(IPC.agentUpdate, h)
    return () => ipcRenderer.removeListener(IPC.agentUpdate, h)
  },
  onAppUpdateAvailable: (cb: (state: AppUpdateState) => void): (() => void) => {
    const h = (_e: unknown, state: AppUpdateState): void => cb(state)
    ipcRenderer.on(IPC.appUpdateAvailable, h)
    return () => ipcRenderer.removeListener(IPC.appUpdateAvailable, h)
  },
  onAppNotificationOpenSession: (cb: (sessionId: string) => void): (() => void) => {
    const h = (_e: unknown, sessionId: string): void => cb(sessionId)
    ipcRenderer.on(IPC.appNotificationOpenSession, h)
    return () => ipcRenderer.removeListener(IPC.appNotificationOpenSession, h)
  },
  setBadgeVisibleSession: (sessionId: string | null): Promise<void> => invoke(IPC.sessionBadgeVisible, sessionId),
  getSessionAttention: (legacy: import('../shared/sessionAttention').LegacySessionAttention): Promise<import('../shared/sessionAttention').SessionAttentionSnapshot> => invoke(IPC.sessionAttentionGet, legacy),
  onSessionAttentionChanged: (cb: (snapshot: import('../shared/sessionAttention').SessionAttentionSnapshot) => void): (() => void) => {
    const h = (_e: unknown, snapshot: import('../shared/sessionAttention').SessionAttentionSnapshot): void => cb(snapshot)
    ipcRenderer.on(IPC.sessionAttentionChanged, h)
    return () => ipcRenderer.removeListener(IPC.sessionAttentionChanged, h)
  }
}

// The detached reader can only operate its bound explanation branch.
const detailApi = {
  homeDir: api.homeDir,
  getDetailWindow: api.getDetailWindow,
  onUniAgentManagementChanged: api.onUniAgentManagementChanged,
  onDetailEvent: api.onDetailEvent, onDetailStatus: api.onDetailStatus,
  explainDetailSelection: () => invoke('detailWindow:action', 'explain'),
  sendDetailMessage: (_id: string, text: string, _attachments?: Attachment[], bubble?: TurnBubbleInput) => invoke('detailWindow:action', 'send', text, bubble?.clientTurnKey),
  interruptDetail: () => invoke('detailWindow:action', 'interrupt'),
  getDetailEvents: () => invoke('detailWindow:action', 'events'),
  getDetailStatus: () => invoke('detailWindow:action', 'status'),
  closeDetail: () => invoke('detailWindow:action', 'close'),
  promoteDetailToSide: () => invoke('detailWindow:action', 'promote'),
  promoteDetailToSession: () => invoke('detailWindow:action', 'promoteSession'),
  getTurnArtifactSummary: async () => null,
  fsReadFile: (_id: string, path: string, options?: FilePreviewOptions, root?: string) => invoke('detailWindow:action', 'readFile', { path, options, root }),
  fsListDir: async () => { throw new Error('请在主窗口查看本地文件') },
  openExternal: api.openExternal
}
contextBridge.exposeInMainWorld('uniagent', process.argv.includes('--ua-detail-window') ? detailApi : api)

export type UniAgentAPI = typeof api
