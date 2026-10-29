import { APP_NAME, isDistributionAgent } from '../shared/distribution.ts'
import { ClaudeSourceService } from './claudeSourceService'
import { configureClaudeSourceRuntime, closeClaudeSourceRuntimes } from './claudeSourceRuntime'
import { CLAUDE_SOURCE_IPC, MODEL_CREDENTIAL_IPC, type ModelSourceClient, type CredentialSelection } from '../shared/claudeSources'
import { ModelCredentials } from './modelCredentials'
import { testClaudeConnection } from './claudeSourceProbe'
import { PersonalAssistantService } from './assistant/service'
import { WeixinBridge } from './assistant/weixinBridge'
import { WeixinApi } from './assistant/weixinApi'
import { WeixinStore } from './assistant/weixinStore'
import { WEIXIN_IPC, acceptsFeishuAssistant } from '../shared/weixin'
import { UniAgentManagement } from './assistant/manage'
import { AppRestartService, RESTART_ARG, type RestartActivity } from './appRestart'
import { inspectRestartTarget } from './appRestartTarget'
import { relaunchApp } from './appRelaunch'
import { MANAGE_CONFIRMATION_PREFIX } from '../shared/uniagentManage'
import { ManagementDocuments } from './assistant/manageDocuments'
import { agentInitializationPrompt } from '../shared/agentInitialization'
import { withAgentDefaults } from '../shared/agentChoices'
import { ASSISTANT_IPC, type AssistantInput, type DocumentEdit, type AssistantDocumentType } from '../shared/assistant'
import { teamInteractionForUser } from '../shared/teamQuestions'
import { RequirementStore } from './requirementStore'
import { RequirementDistiller } from './requirementDistiller'
import { extractRequirementText, requirementExtractionUnsupported } from './requirementExtractionRuntime'
import { configureRequirementRuntime, isRequirementsEnabled, requirementCaller, setRequirementsEnabled } from './requirementRuntime'
import { REQUIREMENT_IPC, type RequirementInput, type RequirementPatch } from '../shared/requirementTypes'
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Notification, powerSaveBlocker } from 'electron'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Orchestrator } from './orchestrator'
import { CommentService } from './commentService'
import { CommentStore } from './commentStore'
import { createCommentRuntime } from './commentRuntime'
import { COMMENT_IPC } from '../shared/comments'
import { DetailWindow } from './detailWindow'
import { closeACPConnections, prepareACPConnections } from './acp/acpProcessLifecycle'
import { UIEventBatcher } from './uiEventBatcher'
import { ZCODE_IPC, type ZCodeEventsSnapshot } from '../shared/zcode'
import { getZCodeRuntimeSnapshot, saveZCodeRuntimeConfig, validateZCodeRuntimeConfig, detectZCodeRuntime } from './zcode/runtime'
import { listAgentHistory, loadSessionEvents } from './history'
import { historyForkPoints } from './historyFork'
import { createHistoryPreviewProgress } from './historyPreviewProgress'
import type { HistoryForkPoint, HistoryLoadProgress } from '../shared/types'
import { listAutomations, setAutomationStatus, getAutomationDetail, updateAutomation, deleteAutomation } from './scanners'
import { NativeAutomations } from './nativeAutomations'
import { hydratePathFromLoginShell } from './env'
import { reconcilePricing } from './pricing'
import { PrefsStore } from './prefsStore'
import { AppSettingsStore } from './appSettingsStore'
import { CodexSourceService } from './codexSourceService'
import { cancelDeepSeekInstall, cancelDeepSeekSignIn, checkDeepSeekConnection, closeDeepSeekHost, configureDeepSeekOnboarding, deepseekSnapshot, installDeepSeek, isDeepSeekMaintenance, readDeepSeekConnection, readDeepSeekReusableConnection, reopenDeepSeekSignIn, saveDeepSeekConnection, signInDeepSeek, signOutDeepSeek } from './deepseekService'
import { DEEPSEEK_IPC, type DeepSeekConnectionInput } from '../shared/deepseek'
import { cancelMCodeOperation, checkMCodeConnection, installMCode, mcodeSnapshot, reopenMCodeSignIn, signInMCode } from './mcodeService'

import { MCODE_IPC, type MCodeConnectionInput } from '../shared/mcode'
import { CliAgentSetup } from './cliAgentSetup'
import { isCliSetupId, type CliSetupId, type CliSetupInput } from '../shared/agentSetup'
import { CodexModelSources } from './codexModelSources'
import { CODEX_SOURCE_IPC, type CodexSourceInput, type CodexSourceModelQueryInput } from '../shared/codexSources'
import { configureClaudeModelsProvider, configureCodexModelsProvider } from './agents'
import { CodexConfigMutationQueue } from './codexConfigMutationQueue'

import { LOCAL_MODEL_IPC, type LocalModelsSnapshot } from '../shared/localModels'
import { configureCodexAppServerArgsProvider } from './appServerAdapter'
import { DEFAULT_PROJECT_ID, ProjectStore } from './projectStore'
import { WorktreeService, parseWorkspaceSelection, sessionUsesWorktree, assertWorktreeNotRemoving } from './worktreeService'
import { SessionStore } from './sessionStore'
import { setFrameHealthReporter } from './windowFrameHealth'
import { AgentLifecycleService } from './agentLifecycleService'
import { IdleAgentUpdater } from './idleAgentUpdater'
import { PresetStore } from './presetStore'
import { RoleStore, prepareAgentRoleInput } from './roleStore'
import { TeamService, type TeamInitialTurn } from './teamService'
import { TEAM_IPC, type TeamCreateProjectInput, type TeamDefinitionInput, type TeamProject } from '../shared/teamTypes'
import { teamRowSessionIds } from '../shared/teamAttention'
import { FeishuThreadStore } from './feishuThreadStore'
import { FeishuBridge, FeishuSendValidationError, fetchFeishuBotName } from './feishuBridge'
import { FeishuInstaller, type FeishuInstallProgress } from './feishuInstaller'
import {
  ensureHandoffServer,
  watchHandoffInbox,
  watchFeishuSendInbox,
  watchTeamInbox,
  watchRequirementInbox,
  handoffSelfTest,
  writeHandoffCatalog,
  writeHandoffResult,
  handoffTaskStore,
  writeFeishuSendResult,
  validateHandoffTaskRequest,
  type FeishuSendReq,
  type HandoffInboxReq,
  type HandoffStopReq
} from './handoff'
import { buildAgentRoleCatalog, resolveAgentRoleInvocation } from './agentRoles'
import { diagnostics, runtimeDiagnosticSample } from './diagnostics'
import { parseQueueWaitQualityQuery } from './queueWaitQuality'
import { CapabilitySyncService } from './capability-sync/service'
import { closeKimiLoginAttempts } from './kimiAuth'
import { kimiOnboarding } from './kimiInstallation'
import { acquireKimiWebService, closeKimiWebServices } from './kimiWebService'
import { listAgentToolInventories, getAgentToolDetail, removeAgentToolSkill, manageAgentToolInventory, type AgentToolInventoryOptions } from './agentToolInventory'

import { executePluginAction } from './capability-sync/plugins'
import { listDeepSeekSessions } from './grokACPRunner.ts'
import { deepseekRuntimeEnv } from './deepseekService.ts'
import { NativeCapabilityService, resolveNativeCapabilityAgent } from './nativeCapabilityService'
import {
  isUuid,
  parseCapabilityExecuteRequest,
  parseCapabilityInventorySyncRequest,
  parseCapabilityPluginActionRequest,
  parseCapabilityPlanRequest,
  parseCapabilityPreviewRequest,
  parseCapabilityScanRequest,
  type CapabilityRollbackCandidate,
  type CapabilityAgentId,
  type CapabilityInventorySyncPreparation,
  type CapabilityScanResult,
  type CapabilitySyncJob,
  type CapabilitySyncPlan
} from '../shared/capabilitySync'
import { installExternalNavigation, isTrustedExternalUrl } from './externalNavigation'
import { checkAppUpdate, type AppUpdateContext } from './appUpdater'
import { RELEASE_REPOSITORY_PAGE } from './releaseSource'
import { isRecordedSessionImagePath, listDir as listFileBrowserDir, pickedFile, readFileForPreview, resolveHtmlWithinRoot, resolveWithinRoot } from './fileBrowser'

import { validateTokenUsageQuery as validateKabooQuery } from '../shared/tokenUsageQuery.ts'
import { getNativeTokenUsage, refreshNativeTokenUsage } from './nativeTokenUsage'
import { logTokenUsage } from './tokenUsageLog'
import { getCodexRateLimits, refreshCodexRateLimits, rememberCodexRateLimits } from './codexRateLimits'
import { getClaudeRateLimits, rememberClaudeRateLimits } from './claudeRateLimits'
import { GrokQuotaService } from './grokQuota'
import { prepareGrokAttachments } from './grokImages'
import { AgentQuotaService } from './agentQuotaService'
import { ZCodeQuotaService } from './zcode/quota'
import { ZCodeConfigurationService } from './zcode/configuration'
import { ZCodeInstallationService } from './zcode/installation'
import { ZCodeSetupTrace, type ZCodeSetupReporter } from './zcode/diagnostics'
import { updateZCodeRuntime } from './zcode/updater'
import {
  IPC,
  DEFAULT_ENABLED_AGENT_IDS,
  agentForSession,
  isToolSession,
  type AgentDef,
  type AgentContractUpdate,
  type AgentPref,
  type PrefsData,
  type AppSettings,
  type AppSettingsPatch,
  type AppUpdateState,
  type Attachment,
  type AutomationDetail,
  type AutomationEditPatch,
  type AutomationTask,
  type NativeAutomationInput,
  type AgentRole,
  type BubbleComment,
  type CodexRateLimits,
  type TurnBubbleInput,
  type HandoffPreset,
  type FeishuStatus,
  type FileBrowserListResult,
  type FilePreviewResult,
  type FilePreviewOptions,
  type KabooProfileResult,
  type KabooUsageQuery,
  type Project,
  type ProjectInput,
  type ReviewFilePairReq,
  type ReviewScope,
  type ReviewChangeSet,
  type RewindPreview,
  type RewindResult,
  type TurnArtifactSummary,
  type SessionSummary,
  type SessionConfig,
  type Session,
  type SessionImportMode,
  type SideChatState,
  type UAEvent
} from '../shared/types'
import type {
  CollaborationModeId,
  NativeCapabilityRequest,
  NativeThreadAction,
  NativeTurnSelectionRequest,
  ResolvedNativeTurnContext
} from '../shared/nativeCapabilities'
import { parseNativeThreadAction } from '../shared/nativeCapabilities'
import type { DetailExplanationContext } from '../shared/detailQuickChat'
import { appNotificationBody, SessionAttentionBadge, shouldShowAppNotification } from './appNotifications'
import { resolveUserDataHome } from './userData'
import { AgentUpdateStatusChecker } from './agentUpdateStatusChecker'
import { readonlyGrokInventoryRunner, getGrokInventoryDetail } from './grokInventory'
import { createAppWindow, takeStartupWindow, resolveHtmlPreviewUrl, resolveUiPath, startupTimings } from './startupWindow'
import { PerformanceMonitor } from './performanceMonitor'
import { copyClipboardImage } from './clipboardImage'

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let agents: AgentDef[] = []
let performanceMonitor: PerformanceMonitor | undefined
let e2eLifecycleAgents: AgentDef[] | null = null
let e2eLastTokenUsageQuery: KabooUsageQuery | null = null
let e2eTokenUsageRequestCount = 0
// 需求3 验证：主进程记录最近一次 respondRequest 入参（仅 e2e 下写入）。
let e2eLastResponse: { sessionId: string; requestId: string; answer: unknown } | null = null

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function recordRuntime(
  source: string,
  code: string,
  error: unknown,
  level: 'warn' | 'error' = 'error',
  sessionId?: string,
  agentId = 'app',
  context?: Record<string, unknown>
): void {
  diagnostics.record({
    category: 'app_runtime', level, source, code, agentId, sessionId,
    message: errorText(error),
    sample: runtimeDiagnosticSample(error, { appVersion: app.getVersion(), ...context })
  })
}

process.on('uncaughtExceptionMonitor', (error) => {
  recordRuntime('main-process', 'uncaught_exception', error)
})
process.on('unhandledRejection', (reason) => {
  recordRuntime('main-process', 'unhandled_rejection', reason)
})

async function sessionImport<T>(
  source: string,
  agentId: string,
  nativeId: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    diagnostics.record({
      category: 'session_import', level: 'error', source, agentId, sessionId: nativeId,
      code: 'session_import_failed', message: errorText(error),
      sample: error instanceof Error ? error.stack : undefined
    })
    throw error
  }
}
const projects = new ProjectStore()
const worktrees = new WorktreeService()
const pendingWorktreeCreations = new Map<string, { scope: string; promise: Promise<Session> }>()
const worktreeTasks = new Map<string, Promise<void>>()
const worktreeProjectChanges = new Set<string>()
const codexConfigMutations = new CodexConfigMutationQueue()
const codexSources = new CodexSourceService()
const claudeSources = new ClaudeSourceService()
const modelCredentials = new ModelCredentials({ codex: () => codexSources.reusableSources(), claude: () => claudeSources.reusableSources(), deepseek: readDeepSeekReusableConnection })
configureClaudeModelsProvider(models => claudeSources.mergeModels(models))
configureClaudeSourceRuntime(config => claudeSources.connection(config))
claudeSources.on('changed', snapshot => mainWindow?.webContents.send(CLAUDE_SOURCE_IPC.changed, snapshot))
kimiOnboarding.onChanged = snapshot => mainWindow?.webContents.send('kimi:setup-changed', snapshot)
configureDeepSeekOnboarding({
  openBrowser: url => shell.openExternal(url),
  metadata: () => ({ version: app.getVersion(), locale: app.getLocale(), timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }),
  changed: () => mainWindow?.webContents.send(DEEPSEEK_IPC.changed, deepseekSnapshot()),
  authenticated: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show(); mainWindow.focus()
  }
})
const grokQuota = new GrokQuotaService()
const zcodeQuota = new ZCodeQuotaService()
const agentQuota = new AgentQuotaService(grokQuota, zcodeQuota)
const reportZCodeSetup: ZCodeSetupReporter = entry => {
  diagnostics.record({ ...entry, sample: { ...(entry.sample as object), appVersion: app.getVersion() } })
}
const zcodeConfiguration = new ZCodeConfigurationService(undefined, reportZCodeSetup)
const zcodeInstallation = new ZCodeInstallationService(undefined, reportZCodeSetup)
const codexModelSources = new CodexModelSources(codexSources)
configureCodexModelsProvider(models => codexModelSources.mergeModels(models))
configureCodexAppServerArgsProvider(config => codexModelSources.runtimeArgs(config))
codexSources.on('changed', snapshot => mainWindow?.webContents.send(CODEX_SOURCE_IPC.changed, snapshot))

const requirements = new RequirementStore(undefined, () => mainWindow?.webContents.send(REQUIREMENT_IPC.changed))
const prefs = new PrefsStore(undefined, (id) => agents.find((agent) => agent.id === id))
let agentPrefs: PrefsData | undefined
const getAgentPref = (agentId: string): AgentPref | undefined => (agentPrefs ||= prefs.get()).lastByAgent[agentId]
const resolveSessionConfig = (config: SessionConfig, validate = false): SessionConfig => {
  const agent = agents.find(agent => agent.id === config.agentId)
  const normalized = claudeSources.normalize(codexModelSources.normalize(withAgentDefaults(agent, config, getAgentPref(config.agentId))))
  if (validate) {
    codexModelSources.assertReady(normalized)
    claudeSources.assertReady(normalized)
    if (normalized.agentId === 'codex' && normalized.modelSource && normalized.modelSource.kind !== 'native' &&
        !agents.find(agent => agent.id === 'codex')?.capabilities.streaming) {
      throw new Error('补充模型需要支持 app-server 的 Codex，不能回退到未隔离的 exec 启动方式')
    }
  }
  return requirements.resolveSessionConfig(projects.resolveSessionConfig(normalized, validate), validate)
}
let stopRequirementInbox: (() => void) | undefined
const sessionStore = new SessionStore(undefined, (config) => resolveSessionConfig(config))
const assertAgentRunReady = (agentId: string): void => {
  if (cliAgentSetup.busy(agentId)) throw new Error('该 Agent 正在安装、登录或检测，请完成后再启动任务')
  if (agentId === 'zcode' && (zcodeConfiguration.isBusy() || zcodeInstallation.isBusy())) throw new Error('ZCode 正在安装或检测配置，请完成后再启动任务')
  if (agentId === 'kimi' && kimiOnboarding.busy) throw new Error('Kimi 正在安装、登录或检测，请完成后再启动任务')
  if (agentId === 'deepseek' && (isDeepSeekMaintenance() || agentLifecycle.isUpdating(agentId))) throw new Error('DeepSeek 正在安装、更新或配置登录，请完成后再启动任务')
}
const orchestrator = new Orchestrator(
  (id) => agents.find((a) => a.id === id),
  sessionStore,
  undefined,
  undefined,
  (config, validateDirectories) => resolveSessionConfig(config, validateDirectories),
  assertAgentRunReady,
  getAgentPref
)
const comments = new CommentService({
  store: new CommentStore(join(sessionStore.directory(), 'comments')),
  session: id => orchestrator.getSessionById(id), events: id => orchestrator.getEvents(id),
  agent: id => agents.find(agent => agent.id === id), ready: id => awaitAgentReady(id),
  readFile: async (session, path) => {
    // Like FileBrowser, explicitly opened external files use their own parent root.
    const root = isAbsolute(path) ? dirname(path) : session.config.workdir
    const result = await readFileForPreview(root, isAbsolute(path) ? relative(root, path) : path, { force: true })
    if (result.ok && result.text !== undefined && !result.truncated) return result.text
    throw new Error(result.error || '无法读取完整原文件，请重新打开后划线')
  },
  runtime: (config, callbacks, id) => {
    const normalized = claudeSources.normalize(codexModelSources.normalize(config))
    codexModelSources.assertReady(normalized)
    claudeSources.assertReady(normalized)
    return createCommentRuntime(normalized, callbacks, join(sessionStore.directory(), 'comments', 'runtime', id),
      id => agents.find(agent => agent.id === id), getAgentPref, assertAgentRunReady)
  }
})
comments.on('changed', thread => mainWindow?.webContents.send(COMMENT_IPC.changed, thread))
const detailWindow = new DetailWindow({ owner: orchestrator, main: () => mainWindow, ui: resolveUiPath, ready: awaitSessionAgentReady,
  readFile: async (id, path, options, root) => {
    const workdir = orchestrator.getSessionById(id)?.config.workdir
    return readFileForPreview(typeof root === 'string' && isAbsolute(root) ? root : workdir, path, options)
  }
})

const personalAssistant = new PersonalAssistantService(orchestrator, id => agents.find(a => a.id === id),
  () => mainWindow?.webContents.send(ASSISTANT_IPC.changed), error => recordRuntime('personal-assistant', 'assistant_service_error', error),
  workdir => projects.ensureProjectForDirectory(workdir), () => personalAssistantDefaultConfig())
requirements.configureContext({
  events: id => orchestrator.getEvents(id),
  requirementId: id => orchestrator.getSessionById(id)?.config.requirementId,
  workdir: id => orchestrator.getSessionById(id)?.config.workdir,
  isTeam: id => !!orchestrator.getSessionById(id)?.teamBinding,
  isDelegated: id => !!orchestrator.getSessionById(id)?.handoffId
})
let requirementRecoveryPending = true
const readRequirementContext = (sessionId: string, request: import('../shared/requirementTypes').RequirementContextRequest) => {
  const caller = orchestrator.getSessionById(sessionId)
  if (!caller?.config.requirementId || !isRequirementsEnabled()) return Promise.reject(new Error('本会话未绑定可用需求'))
  return requirements.context(caller.config.requirementId, caller.id, request, {
    readOnly: caller.readOnly || ['plan', 'read-only'].includes(caller.config.permissionMode || ''),
    projectId: caller.config.projectId
  }).then(value => {
    if (value.sync) {
      value.sync.recovering = requirementRecoveryPending
      if (requirementRecoveryPending) value.sync.status = 'pending'
    }
    if (request.action === 'bootstrap' && value.formatVersion === 2) for (const pending of value.sync.pending) {
      if (pending.sessionId !== caller.id) requirementDistiller.schedule(caller.config.requirementId!, pending.sessionId, true)
    }
    return value
  })
}
configureRequirementRuntime(id => orchestrator.getSessionById(id), readRequirementContext)
const requirementDistiller = new RequirementDistiller(requirements, {
  session: id => orchestrator.getSessionById(id),
  unsupported: session => requirementExtractionUnsupported(agents.find(agent => agent.id === session.config.agentId)),
  extract: (session, prompt, signal) => extractRequirementText(agents.find(agent => agent.id === session.config.agentId)!, session.config, prompt, signal),
  report: (id, message) => orchestrator.reportRequirementSyncError(id, message)
})

function validateNativeAutomation(input: NativeAutomationInput): NativeAutomationInput {
  if (!input || !['name', 'prompt', 'schedule', 'agentId', 'projectId', 'permissionMode'].every(key =>
    typeof input[key as keyof NativeAutomationInput] === 'string' && String(input[key as keyof NativeAutomationInput]).trim())) {
    throw new Error('请填写任务名称、指令、执行计划、Agent、空间和权限')
  }
  const agent = agents.find(item => item.id === input.agentId)
  if (!agent || agent.lifecycle?.availability !== 'available' || agentLifecycle.isUpdating(agent.id)) {
    throw new Error('所选 Agent 当前不可用，请等待就绪或重新选择')
  }
  if (!projects.list().some(project => project.id === input.projectId)) throw new Error('所选空间已不存在，请重新选择')
  if (!agent.capabilities.permissionModes.some(mode => mode.id === input.permissionMode)) throw new Error('所选 Agent 不支持该权限模式')
  if (input.model && (!agent.capabilities.modelSelect || !agent.models.some(model => model.id === input.model))) throw new Error('所选模型已不可用，请重新选择')
  const model = agent.models.find(model => model.id === (input.model || agent.defaultModel))
  if (input.reasoningEffort && !model?.efforts.includes(input.reasoningEffort)) throw new Error('所选模型不支持该推理强度')
  resolveSessionConfig({ agentId: input.agentId, projectId: input.projectId, workdir: '', model: input.model }, true)
  return { ...input, name: input.name.trim(), prompt: input.prompt.trim() }
}

async function nativeAutomationError(sessionId: string): Promise<string | undefined> {
  const events = await orchestrator.getEvents(sessionId)
  return [...events].reverse().find(event => event.type === 'error')?.payload?.message
}

const nativeAutomations = new NativeAutomations({
  run: async (task, isCurrent) => {
    await awaitAgentReady(task.agentId)
    if (!isCurrent()) return null
    const input = validateNativeAutomation(task as NativeAutomationInput)
    const config = resolveSessionConfig({
      agentId: input.agentId, projectId: input.projectId, workdir: '',
      model: input.model || undefined, effort: input.reasoningEffort, permissionMode: input.permissionMode
    }, true)
    return orchestrator.createSession(config, input.prompt)
  },
  getSession: id => orchestrator.getSessionById(id),
  getError: nativeAutomationError,
  changed: () => mainWindow?.webContents.send(IPC.automationsChanged),
  onError: error => recordRuntime('automations', 'native_schedule_failed', error)
})
/**
 * 需求一/二/三 — typed surface for the scope-aware review + rewind methods the
 * orchestrator gains in a parallel change. Casting once here lets this IPC shell
 * compile and register handlers regardless of merge ordering; at runtime the real
 * orchestrator methods are invoked. Keep this in sync with orchestrator's public
 * signatures (they mirror the shared-types shapes).
 */
interface RewindCapableOrchestrator {
  reviewGetChangeSet(sessionId: string, scope?: ReviewScope): Promise<ReviewChangeSet>
  getTurnArtifactSummary(sessionId: string, turnId: string): Promise<TurnArtifactSummary | null>
  previewSessionRewind(sessionId: string, beforeTurnId: string): Promise<RewindPreview>
  rewindSession(sessionId: string, beforeTurnId: string): Promise<RewindResult>
}
const rewindOrchestrator = orchestrator as unknown as RewindCapableOrchestrator
const appSettings = new AppSettingsStore()
setRequirementsEnabled(appSettings.get().requirementsEnabled === true)
let sleepBlockerId: number | undefined
const legacyFeishuWorkdir = appSettings.get().feishu?.defaultWorkdir
if (legacyFeishuWorkdir) {
  appSettings.set({ feishu: { defaultProjectId: projects.ensureProjectForDirectory(legacyFeishuWorkdir).id } })
}
const agentLifecycle = new AgentLifecycleService({
  beforeZCodeRuntimeSwitch: () => orchestrator.prepareZCodeRuntimeUpdate(),
  zcodeUpdate: (revision, beforeSwitch, onProgress) => {
    if (zcodeConfiguration.isBusy() || zcodeInstallation.isBusy()) return Promise.reject(new Error('ZCode 正在安装或检测配置，请稍后更新'))
    return updateZCodeRuntime(revision, beforeSwitch, onProgress)
  }
})
const cliAgentSetup = new CliAgentSetup({ inspect: refreshDetectedAgent, openBrowser: url => shell.openExternal(url) })
cliAgentSetup.onChanged = (id, snapshot) => mainWindow?.webContents.send('agent-setup:changed', { id, snapshot })
const presets = new PresetStore()
const roles = new RoleStore()
const teams = new TeamService(orchestrator, projects, () => agents, undefined, (config, validate) => {
  const resolved = resolveSessionConfig(config, validate)
  if (validate && requirements.get(resolved.requirementId)?.status === 'archived') throw new Error('所属需求已归档')
  return resolved
})
async function createWorkspaceSession(
  input: SessionConfig,
  title: string,
  create: (config: SessionConfig, reservedSessionId?: string) => Session | Promise<Session>,
  task?: Session['worktreeTask']
): Promise<Session> {
  if (input.worktree !== undefined) throw new Error('工作树绑定只能由主进程创建')
  const selection = parseWorkspaceSelection(input.workspaceSelection)
  const { workspaceSelection: _selection, ...plainConfig } = input
  const config = resolveSessionConfig(plainConfig, true)
  // 建会话绑定校验：功能关闭时不接受需求绑定，避免重开开关后悄悄激活。
  if (config.requirementId && !isRequirementsEnabled()) throw new Error('需求功能已停用')
  await awaitAgentReady(config.agentId)
  if (selection?.mode !== 'worktree') return create(config)
  if (config.initializationTargetAgentId) throw new Error('初始化任务不能创建工作树')
  if (agentLifecycle.isUpdating(config.agentId)) throw new Error('agent_update_in_progress')
  if (requirements.get(config.requirementId)?.status === 'archived') throw new Error('所选需求已归档，请重新选择')
  await awaitSessionHydration()
  const project = projects.get(config.projectId)
  if (!project) throw new Error('空间不存在')
  const key = selection.requestId!
  const scope = JSON.stringify([project.id, config.agentId, config.requirementId, selection.baseRef])
  const pending = pendingWorktreeCreations.get(key)
  if (pending) {
    if (pending.scope !== scope) throw new Error('创建请求的空间或基准已变化，请重新选择工作方式')
    return pending.promise
  }
  const promise = (async (): Promise<Session> => {
    let session = orchestrator.listSessions().find(item => !item.teamBinding && item.config.worktree?.creationRequestId === key)
    if (session && (session.config.projectId !== project.id || session.config.agentId !== config.agentId || session.config.requirementId !== config.requirementId || session.config.worktree?.baseRef !== selection.baseRef)) {
      throw new Error('工作树创建请求与草稿不一致，请重新选择工作方式')
    }
    if (session && session.status !== 'draft') return session
    if (!session) {
      const worktree = await worktrees.allocate(project, selection)
      session = orchestrator.reserveWorktreeSession({ ...config, worktree }, title, task)
    }
    if (task) {
      if (!session.worktreeTask) orchestrator.updateWorktreeTask(session.id, task)
      void runWorktreeTask(session.id)
      return structuredClone(session)
    }
    try {
      if (session.config.worktree!.state !== 'ready') {
        const creating = { ...session.config.worktree!, state: 'creating' as const }
        delete creating.lastError
        orchestrator.updateWorktreeCreation(session.id, creating)
        orchestrator.updateWorktreeCreation(session.id, await worktrees.create(creating))
      }
      orchestrator.updateWorktreeCreation(session.id, session.config.worktree!, config)
      const runtimeConfig = resolveSessionConfig(session.config, true)
      return await create(runtimeConfig, session.id)
    } catch (error) {
      if (session.status === 'draft' && session.config.worktree?.state !== 'ready') {
        try { orchestrator.updateWorktreeCreation(session.id, { ...session.config.worktree!, state: 'failed', lastError: error instanceof Error ? error.message : String(error) }) }
        catch { /* Retain the durable creating record for the next retry. */ }
      }
      throw error
    }
  })()
  pendingWorktreeCreations.set(key, { scope, promise })
  try { return await promise }
  finally { pendingWorktreeCreations.delete(key) }
}

async function prepareWorktreeDraft(sessionId: string): Promise<void> {
  const session = orchestrator.getSessionById(sessionId)
  const tree = session?.config.worktree
  if (session?.worktreeTask && worktreeTasks.has(sessionId)) throw new Error('正在创建工作树，请稍后再发送')
  if (session?.worktreeTask && tree?.state !== 'ready') throw new Error('请先在对话中重试创建工作树')
  if (!session || session.status !== 'draft' || !tree || tree.state === 'ready') return
  const { worktree: _tree, ...config } = session.config
  await createWorkspaceSession({ ...config, workspaceSelection: { mode: 'worktree', baseRef: tree.baseRef, requestId: tree.creationRequestId } }, session.title,
    (_runtime, reservedId) => {
      const reserved = reservedId && orchestrator.getSessionById(reservedId)
      if (!reserved || reserved.id !== sessionId) throw new Error('工作树草稿已变化')
      return reserved
    })
}

function runWorktreeTask(sessionId: string): Promise<void> {
  const pending = worktreeTasks.get(sessionId)
  if (pending) return pending
  const operation = (async () => {
    const session = orchestrator.getSessionById(sessionId)
    if (!session?.worktreeTask || !session.config.worktree || session.status !== 'draft') throw new Error('待创建任务已变化，请刷新会话')
    const task = structuredClone(session.worktreeTask)
    try {
      orchestrator.updateWorktreeTask(sessionId, task)
      await awaitAgentReady(session.config.agentId)
      if (session.config.worktree.state !== 'ready') {
        const tree = { ...session.config.worktree, state: 'creating' as const }
        delete tree.lastError
        orchestrator.updateWorktreeCreation(sessionId, tree)
        const ready = await worktrees.create(tree)
        if (orchestrator.getSessionById(sessionId) !== session) return
        orchestrator.updateWorktreeCreation(sessionId, ready)
      }
      if (session.archived) throw new Error('会话已归档，请恢复后重试')
      const config = resolveSessionConfig(session.config, true)
      if (task.kind === 'native') await orchestrator.createNativeActionSession(config, task.action, undefined, sessionId)
      else {
        const nativeContext = await resolveNativeTurnSelection(config.agentId, config.workdir, task.selection).catch(() => {
          throw new Error('请在下方重新选择技能或插件后发送，正文与附件已保留')
        })
        orchestrator.createSession(config, task.prompt, task.attachments, undefined, nativeContext, task.activatePlan ? 'plan' : undefined, undefined, sessionId)
      }
      orchestrator.updateWorktreeTask(sessionId)
    } catch (error) {
      if (orchestrator.getSessionById(sessionId) !== session) return
      const message = error instanceof Error ? error.message : String(error)
      if (session.config.worktree.state !== 'ready') orchestrator.updateWorktreeCreation(sessionId, { ...session.config.worktree, state: 'failed', lastError: message })
      // Once input has been accepted, never offer a second submission of it.
      const accepted = !!session.submittedUserMessages?.length || session.status !== 'draft'
      orchestrator.updateWorktreeTask(sessionId, accepted ? undefined : task, accepted ? undefined : message)
      if (accepted) orchestrator.appendSystemNotice(sessionId, message)
    }
  })().catch(error => {
    recordRuntime('worktree', 'worktree_task_failed', error instanceof Error ? error.message : String(error))
  }).finally(() => { worktreeTasks.delete(sessionId) })
  worktreeTasks.set(sessionId, operation)
  return operation
}

let idleAgentUpdatesReady = false
const idleAgentUpdater = new IdleAgentUpdater({
  lifecycle: agentLifecycle,
  settings: () => appSettings.get(),
  isBusy: () => isQuitting || zcodeInstallation.isBusy() || zcodeConfiguration.isBusy() || orchestrator.hasActiveAgentSessions() || comments.hasActiveWork() || teams.hasActiveWork(),
  onUpdated: (next) => {
    if (isQuitting) return
    agents = next
    publishHandoffCatalog()
    mainWindow?.webContents.send(IPC.lifecycleProgress, { agentId: '*', phase: 'completed', message: '闲时更新检查完成' })
  }
})
// 后台更新状态检查：只查版本，不安装更新；结果用于外部列表的三态展示。
const agentUpdateStatusChecker = new AgentUpdateStatusChecker({
  file: join(resolveUserDataHome(), 'agent-update-status.json'),
  lifecycle: agentLifecycle,
  onUpdated: (next) => {
    if (isQuitting) return
    agents = next
    publishHandoffCatalog()
    mainWindow?.webContents.send(IPC.lifecycleProgress, { agentId: '*', phase: 'completed', message: 'Agent 更新状态已刷新' })
  }
})
for (const event of ['statusChange', 'queueChange', 'sideStatus', 'sideState', 'detailStatus', 'sessionUpdated']) {
  orchestrator.on(event, () => idleAgentUpdater.markActivity())
}
teams.on('changed', () => { if (teams.hasActiveWork()) idleAgentUpdater.markActivity() })
comments.on('changed', () => idleAgentUpdater.markActivity())
teams.on('changed', () => mainWindow?.webContents.send(TEAM_IPC.changed))
teams.on('errorNotice', (message: string) => recordRuntime('team', 'team_operation_failed', message))
orchestrator.on('nativeCleanupWarning', ({agentId,message}: {agentId:string;message:string}) => recordRuntime(agentId,'native_cleanup_unconfirmed',message,'warn'))

function projectRoles(): AgentRole[] {
  const current = roles.list()
  let changed = false
  const migrated = current.map((role) => {
    if (!role.projectId && !role.workdir) return role
    const validProject = role.projectId ? projects.get(role.projectId) : undefined
    if (validProject && !role.workdir) return role
    const projectId = validProject?.id || (role.workdir
      ? projects.ensureProjectForDirectory(role.workdir).id
      : DEFAULT_PROJECT_ID)
    const { workdir: _legacyWorkdir, ...rest } = role
    changed = changed || role.projectId !== projectId || !!role.workdir
    return { ...rest, projectId }
  })
  if (changed) for (const role of migrated) roles.save(role)
  return migrated
}
const e2eEnabled = app.commandLine.hasSwitch('ua-e2e') && app.commandLine.hasSwitch('remote-debugging-port')
// Only the fully isolated packaged automation acceptance may mutate local fixtures.
const e2eLocalAutomationPassthrough =
  e2eEnabled && process.env.UA_E2E_AUTOMATION_PASSTHROUGH === '1'
let e2eAutomationListReadyAt = 0
const e2eHistoryCalls = new Map<string, number>()
// 需求4（飞书 Bot 远程驱动）— the main-process bridge (WSClient in / Client out)
// and its persistent session↔话题 map. It stays dormant until settings.feishu is
// enabled with credentials; index.ts wires it into the orchestrator event fan-out
// below and starts/stops it from settings changes + one-click install.
const feishuThreads = new FeishuThreadStore()
const feishuBridge = new FeishuBridge({
  orchestrator,
  teams,
  threadStore: feishuThreads,
  acceptsSession: session => acceptsFeishuAssistant(session.config) && !assistantFeishuThreads.bySession(session.id) &&
    (!!feishuThreads.bySession(session.id) || !session.config.assistantSnapshot || !appSettings.get().assistantFeishu?.enabled),
  assistantCommand: (id, command, requestId) => personalAssistant.commands.execute(id, command, requestId),
  getAgents: () => agents,
  getSettings: () => appSettings.get().feishu,
  saveNotificationTarget: target => {
    appSettings.set({ feishu: { notifyChatId: target?.chatId || '', notifyChatType: target?.kind, notifyChatName: target?.name || '' } })
  },
  getAgentPref,
  getProjects: () => projects.list(),
  getRequirements: () => requirements.list(),
  resolveProjectConfig: (config) => {
    const resolved = resolveSessionConfig(config, true)
    if (resolved.requirementId && !isRequirementsEnabled()) throw new Error('需求功能已停用')
    if (requirements.get(resolved.requirementId)?.status === 'archived') throw new Error('所选需求已归档，请先恢复需求或重新选择')
    return resolved
  },
  createTeamProject,
  onStatus: (status) => {
    mainWindow?.webContents.send(IPC.feishuInstallProgress, sessionFeishuStatus())
    if (status.phase === 'failed' && status.message) recordRuntime('feishu', 'feishu_failed', status.message)
  },
  onError: (message, context) => {
    const code = typeof context?.code === 'string' ? context.code : 'feishu_operation_failed'
    const sessionId = typeof context?.sessionId === 'string' ? context.sessionId : undefined
    recordRuntime('feishu', code, message, 'error', sessionId, 'app', context)
  },
  onLog: (sessionId, kind, data) => {
    orchestrator.logSession(sessionId || 'feishu-connection', kind, data)
  },
  // 需求4(同步) — a session started from Feishu shows up in the sidebar live, same
  // push the handoff path uses, so 飞书话题 ↔ UniAgent session stays bidirectional.
  onSessionCreated: (session) => { mainWindow?.webContents.send(IPC.sessionCreated, session) },
  onSessionUpdated: session => mainWindow?.webContents.send(IPC.sessionUpdated, { session })
})
async function personalAssistantDefaultConfig(): Promise<SessionConfig> {
  const { assistant } = await personalAssistant.store.detail()
  await awaitAgentReady(assistant.defaultAgentId)
  const agent = agents.find(a => a.id === assistant.defaultAgentId)
  if (!agent) throw new Error('个人助手默认 Agent 当前不可用，请到设置重新选择')
  if (assistant.defaultModel && !agent.models.some(model => model.id === assistant.defaultModel)) throw new Error('个人助手默认模型已不可用，请到设置重新选择')
  if (assistant.defaultPermissionMode && !agent.capabilities.permissionModes.some(mode => mode.id === assistant.defaultPermissionMode)) throw new Error('个人助手默认权限已不可用，请到设置重新选择')
  return personalAssistant.prepareConfig({ useAssistant: true, agentId: agent.id, model: assistant.defaultModel,
    permissionMode: assistant.defaultPermissionMode || agent.capabilities.permissionModes.find(mode => mode.id === 'ask')?.id || agent.capabilities.permissionModes[0]?.id || 'read-only', workdir: '' })
}
const assistantFeishuThreads = new FeishuThreadStore(join(resolveUserDataHome(), 'assistants', 'feishu'),
  () => mainWindow?.webContents.send(ASSISTANT_IPC.privateSessionsChanged))
const assistantFeishuBridge = new FeishuBridge({
  orchestrator,
  threadStore: assistantFeishuThreads,
  getAgents: () => agents,
  getSettings: () => appSettings.get().assistantFeishu,
  getAgentPref,
  acceptsSession: session => acceptsFeishuAssistant(session.config) && !!session.config.assistantSnapshot && !session.teamBinding && !session.handoffId && !feishuThreads.bySession(session.id),
  assistantCommand: (id, command, requestId) => personalAssistant.commands.execute(id, command, requestId),
  createAssistantSession: async (prompt, attachments, bind, assertCurrent) => {
    const config = await personalAssistantDefaultConfig()
    return createWorkspaceSession(config, prompt, runtime => {
      assertCurrent()
      const session = orchestrator.createSession(runtime, prompt, attachments, undefined, undefined, undefined, { source: 'feishu' })
      bind(session)
      mainWindow?.webContents.send(IPC.sessionCreated, session)
      return session
    })
  },
  onSessionCreated: session => mainWindow?.webContents.send(IPC.sessionCreated, session),
  onSessionUpdated: session => mainWindow?.webContents.send(IPC.sessionUpdated, { session }),
  onStatus: () => mainWindow?.webContents.send(ASSISTANT_IPC.feishuChanged),
  onError: message => recordRuntime('personal-assistant', 'assistant_feishu_error', message),
  onLog: (sessionId, kind, data) => orchestrator.logSession(sessionId || 'assistant-feishu', kind, data)
})
const assistantWeixinBridge = new WeixinBridge({
  store: new WeixinStore(join(resolveUserDataHome(), 'assistants', 'weixin.json')),
  api: new WeixinApi(), orchestrator,
  attachmentsDirectory: join(resolveUserDataHome(), 'assistants', 'weixin-attachments'),
  createSession: async (prompt, attachments, bind, assertCurrent) => {
    const config = await personalAssistantDefaultConfig()
    return createWorkspaceSession({ ...config, assistantChannel: 'weixin' }, '个人助手 · 微信', async runtime => {
      assertCurrent()
      const session = orchestrator.createAssistantDraft(runtime)
      await bind(session)
      assertCurrent()
      mainWindow?.webContents.send(IPC.sessionCreated, session)
      await orchestrator.forceSend(session.id, prompt, attachments, undefined, { source: 'weixin' }, false)
      return session
    })
  },
  command: async (id, command, requestId) => {
    const session = await personalAssistant.commands.execute(id, command, requestId)
    mainWindow?.webContents.send(IPC.sessionCreated, session)
    return session
  },
  onState: () => {
    mainWindow?.webContents.send(WEIXIN_IPC.changed)
    mainWindow?.webContents.send(ASSISTANT_IPC.privateSessionsChanged)
  },
  onError: message => recordRuntime('personal-assistant', 'assistant_weixin_error', message)
})
let assistantFeishuInstaller: FeishuInstaller | undefined
let assistantFeishuInstallFlight: Promise<void> | undefined
let assistantFeishuInstallProgress: FeishuInstallProgress | undefined
let assistantFeishuManualBinding = false
let sessionFeishuInstaller: FeishuInstaller | undefined
let sessionFeishuInstallFlight: Promise<void> | undefined
let sessionFeishuInstallProgress: FeishuInstallProgress | undefined
let sessionFeishuManualBinding = false
function sessionFeishuStatus(): FeishuStatus {
  const base = feishuBridge.getStatus(), progress = sessionFeishuInstallProgress
  return { ...base, ...progress, appId: progress?.appId || base.appId,
    configuring: !!sessionFeishuInstaller || sessionFeishuManualBinding }
}
function assistantFeishuState(): import('../shared/assistant').AssistantFeishuState {
  const base = assistantFeishuBridge.getStatus(), progress = assistantFeishuInstallProgress
  return { configured: !!appSettings.get().assistantFeishu?.appId, configuring: !!assistantFeishuInstaller || assistantFeishuManualBinding,
    status: progress ? { ...base,...progress, appId: progress.appId || base.appId } : base }
}
async function saveFeishuCredentials(key: 'feishu' | 'assistantFeishu', input: import('../shared/assistant').AssistantFeishuInput, signal?: AbortSignal): Promise<void> {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['appId','appSecret'].includes(key)) ||
    typeof input.appId !== 'string' || !/^cli_[a-zA-Z0-9]+$/.test(input.appId.trim()) || input.appId.length > 200 ||
    input.appSecret !== undefined && (typeof input.appSecret !== 'string' || input.appSecret.length > 2000)) throw new Error('请填写有效的 App ID 和 App Secret')
  const appId = input.appId.trim(), appSecret = input.appSecret?.trim()
  if (!appSecret) throw new Error('请输入机器人的 App Secret')
  const botName = await fetchFeishuBotName(appId, appSecret, signal)
  signal?.throwIfAborted()
  if (isQuitting) throw new Error('应用正在退出')
  appSettings.set({ [key]: { enabled: true, appId, appSecret, botName } })
  const saved = appSettings.get()[key]
  if (saved?.appId !== appId || saved.appSecret !== appSecret) throw new Error('机器人配置未能保存，请重试')
}
teams.on('changed', () => feishuBridge.handleTeamChanged())

const capabilitySync = new CapabilitySyncService(
  process.env.UNIAGENT_CAPABILITY_HOME || undefined,
  process.env.UNIAGENT_CAPABILITY_DATA || undefined,
  undefined,
  (['codex', 'traex'] as const).filter(id => isDistributionAgent(id))
)
const nativeCapabilityService = new NativeCapabilityService(undefined, { discoverZCode: (workdir, sessionId) => orchestrator.discoverZCodeCapabilities(workdir, sessionId) })
const managementDocuments = new ManagementDocuments({ requirements: () => requirements.list(), sessions: () => orchestrator.managedSessions(),
  teams: () => teams.catalog().projects, capabilities: () => listManagedInventories() })
function restartActivities(excludeSessionId: string): RestartActivity[] {
  const activity: RestartActivity[] = orchestrator.managedSessions().filter(session => session.id !== excludeSessionId &&
    (orchestrator.hasActiveSessionWork(session.id) || orchestrator.pendingSessionRequests(session.id).length > 0))
    .map(session => ({ id: session.id, title: session.title, status: session.status, revision: orchestrator.restartWorkRevision(session.id) }))
  activity.push(...comments.activities())
  for (const project of teams.catalog().projects) {
    if (!project.archivedAt && ['running','waiting_members','waiting_user','stopping'].includes(project.status)) {
      activity.push({ id: project.id, title: project.name, status: project.status, revision: String(project.runId) })
    }
  }
  if (teams.hasActiveWork() && !activity.length) activity.push({ id: 'team-dispatch', title: '专家团调度', status: 'running', revision: 'active' })
  return activity
}
let appRestartRecovery: Promise<void> | undefined
const appRestart = new AppRestartService(join(resolveUserDataHome(), 'app-restart', 'requests.json'), {
  inspectTarget: async bundle => {
    if (!app.isPackaged || e2eEnabled) throw new Error('请在正式打包的 App 中发起重启')
    await personalAssistant.snapshot()
    return inspectRestartTarget(bundle)
  },
  caller: sessionId => {
    const session = orchestrator.getSessionById(sessionId)
    const events = orchestrator.loadedSessionEvents(sessionId)
    const completed = events.findLast(event => event.type === 'turn_completed')
    return {
      available: !!session?.config.assistantSnapshot && !session.archived && !session.readOnly && !session.teamBinding && !session.handoffId,
      busy: orchestrator.hasActiveSessionWork(sessionId) || orchestrator.pendingSessionRequests(sessionId).some(event => !String(event.payload.requestId).startsWith(MANAGE_CONFIRMATION_PREFIX)),
      lastSeq: events.at(-1)?.seq || 0,
      completed: completed ? { seq: completed.seq, success: completed.state === 'success' } : undefined
    }
  },
  activities: restartActivities,
  ask: (...args) => orchestrator.requestManagementChoice(...args),
  dismiss: (sessionId, requestId) => orchestrator.dismissManagementConfirmation(sessionId, requestId),
  replyDelivered: (sessionId, seq) => {
    const session = orchestrator.getSessionById(sessionId)
    // Only a bound enabled channel needs a delivery acknowledgement. An App-only
    // conversation has no remote reply to drain before quitting.
    if (assistantFeishuThreads.bySession(sessionId) && appSettings.get().assistantFeishu?.enabled) return assistantFeishuBridge.isTurnReplyDelivered(sessionId, seq)
    if (feishuThreads.bySession(sessionId) && appSettings.get().feishu?.enabled) return feishuBridge.isTurnReplyDelivered(sessionId, seq)
    return session?.config.assistantChannel !== 'weixin'
  },
  flush: async () => { await personalAssistant.snapshot(); await orchestrator.flushSessionLogs() },
  relaunch: (target, id) => {
    if (isQuitting) throw new Error('应用正在退出')
    relaunchApp({ execPath: target.executable, args: [RESTART_ARG + id] })
  },
  resume: async job => {
    await awaitSessionAgentReady(job.sessionId)
    await personalAssistant.snapshot()
    const deadline = Date.now() + 30000
    const bridge = assistantFeishuThreads.bySession(job.sessionId) && appSettings.get().assistantFeishu?.enabled ? assistantFeishuBridge
      : feishuThreads.bySession(job.sessionId) && appSettings.get().feishu?.enabled ? feishuBridge : undefined
    while (bridge && !bridge.getStatus().connected && Date.now() < deadline && !isQuitting) await new Promise(resolve => setTimeout(resolve, 250))
    if (isQuitting) throw new Error('恢复期间应用退出')
    const session = orchestrator.getSessionById(job.sessionId)
    if (!session?.config.assistantSnapshot || session.archived || session.readOnly || session.teamBinding || session.handoffId) throw new Error('恢复期间原助手会话已变化')
    const text = `自动重启后的继续请求（编号：${job.id}）。这是用户已通过宿主确认的重启续聊任务。当前程序版本 ${app.getVersion()}，进程 ${process.pid}，飞书连接：${bridge ? bridge.getStatus().connected ? '已连接' : '尚未连接' : '未绑定'}。\n请继续原会话任务：\n${job.prompt}\n\n这是 App 自动提交的续聊，不是新的飞书入站消息；不要伪造飞书上下文或调用 send_to_feishu。不要重复安排本次重启。`
    await orchestrator.sendMessage(job.sessionId, text, undefined, undefined, false, { source: 'app' }, false)
    if (!orchestrator.loadedSessionEvents(job.sessionId).some(event => event.type === 'user_message' && String(event.payload.text).includes(job.id))) throw new Error('未确认续聊消息已接受，请核对原会话；不会自动重发')
  },
  notice: (sessionId, text) => { if (orchestrator.getSessionById(sessionId)) orchestrator.appendSystemNotice(sessionId, text, 'app_restart') }
})
const uniagentManagement = new UniAgentManagement({
  appRestart,
  orchestrator, teams, agents: () => agents, roles: () => buildAgentRoleCatalog(projectRoles(),agents),
  saveRole: saveUniAgentRole, deleteRole: deleteUniAgentRole,
  appSettings: () => appSettings.get(), patchSettings: patchAppSettings,
  assistant: () => personalAssistant.store.detail(), saveAssistant: (input,edits,expectedConfig) => personalAssistant.save(input,edits,expectedConfig),
  documents: (operation,params) => managementDocuments.call(operation,params),
  prepareTaskUpdate: sessionId => awaitSessionAgentReady(sessionId),
  answerTask: (sessionId,requestId,answer) => respondUniAgentRequest(sessionId,requestId,answer,'mcp'),
  startTeam: input => createTeamProject(input),
  configuration: async section => {
    if (section === 'projects') return projects.list()
    if (section === 'requirements') return requirements.list()
    if (section === 'presets') return presets.list()
    if (section === 'models') return { claude: claudeSources.snapshot(), codex: codexSources.snapshot(),  deepseek: deepseekSnapshot() }
    if (section === 'capabilities') return listManagedInventories()
    if (section === 'automations') return [...nativeAutomations.list(),...await listAutomations()]
    if (section !== 'all') throw new Error('unknown_configuration_section')
    return { app: appSettings.get(), assistant: await personalAssistant.store.detail(), projects: projects.list(), requirements: requirements.list(), presets: presets.list(),
      agents: agents.map(agent => ({ id: agent.id, name: agent.name, lifecycle: agent.lifecycle, models: agent.models.length, capabilities: agent.capabilities })),
      roles: projectRoles().map(role => ({ id: role.id, name: role.name, agentId: role.agentId, model: role.model, permissionMode: role.permissionMode })),
      teams: teams.catalog().teams.map(team => ({ id: team.id, name: team.name, status: team.status, revision: team.revision, members: team.members.length })),
      automations: [...nativeAutomations.list(),...await listAutomations()] }
  },
  createTask: async (supplied,prompt,roleId,caller) => {
    if (roleId && supplied) throw new Error('roleId 与 config 不能同时提供')
    if (supplied && Object.keys(supplied).some(key => !['agentId','model','projectId','requirementId','permissionMode','effort','workdir','workspaceSelection','fastMode','maxMode','kimiThinking','zcodeModelSelection','collaborationMode'].includes(key))) throw new Error('invalid_task_configuration')
    const config = roleId ? resolveAgentRoleInvocation({ roleId, roles: projectRoles(), agents,
      callerSessionProjectId: caller.config.projectId, callerSessionWorkdir: caller.config.workdir }).config
      : { agentId: caller.config.agentId, projectId: caller.config.projectId, permissionMode: 'ask' as const, workdir: '', ...supplied }
    return createWorkspaceSession(config,prompt,runtime => {
      if (requirements.get(runtime.requirementId)?.status === 'archived') throw new Error('所选需求已归档')
      const session = orchestrator.createSession(runtime,prompt,undefined,undefined,undefined,undefined,{ source: 'mcp' })
      mainWindow?.webContents.send(IPC.sessionCreated,session); return session
    })
  },
  initializeAgent: async (targetId,caller) => {
    const target = agents.find(agent => agent.id === targetId)
    if (!target) throw new Error('unknown_agent')
    const executor = [agents.find(agent => agent.id === caller.config.agentId),...agents].find(agent => agent && agent.id !== targetId && agent.lifecycle?.availability === 'available' && agent.capabilities.permissionModes.some(mode => mode.id === 'ask'))
    if (!executor) throw new Error('没有可执行初始化的 Agent，请在设置页使用现有接入流程')
    const prompt = agentInitializationPrompt(targetId,target.name)
    return createWorkspaceSession({ agentId: executor.id, permissionMode: 'ask', projectId: DEFAULT_PROJECT_ID, workdir: '', initializationTargetAgentId: targetId },prompt,runtime => {
      const jobId = appSettings.beginInitialization(targetId)
      try {
        const session = orchestrator.createSession({ ...runtime,initializationJobId: jobId },prompt)
        appSettings.attachInitialization(jobId,session.id); mainWindow?.webContents.send(IPC.sessionCreated,session)
        return session
      } catch (error) { appSettings.settleInitialization(jobId,false); throw error }
    })
  },
  detectAgents: async () => { const next = await refreshDetectedAgents('助手已重新检测 Agent'); restartConfiguredFeishuBridges(); return next },
  updateAgent: async id => { if (cliAgentSetup.busy(id) || id === 'kimi' && kimiOnboarding.busy) throw new Error('请先完成或取消该 Agent 的安装与登录'); await awaitAgentReady(id); await agentLifecycle.updateOne(id,agentId => orchestrator.hasActiveAgentSessions(agentId)); agents = agentLifecycle.snapshot(); publishHandoffCatalog(); return agents.find(agent => agent.id === id)! },
  changed: resource => mainWindow?.webContents.send(ASSISTANT_IPC.manageChanged,resource)
})
personalAssistant.configureManagement(async (scope,request) => { await awaitSessionHydration(); await appRestartRecovery; return uniagentManagement.call(scope,request) })

let capabilityRecoveryFlight: Promise<void> | null = null
let startupSessionHydration: Promise<void> | null = null
let startupHandoffReady: Promise<void> | null = null
let startupCoreReady: Promise<AgentDef[]> | null = null
let startupProtocolSettled: Promise<AgentDef[]> | null = null
async function startFeishuBridgeWhenReady(bridge = feishuBridge): Promise<void> {
  try {
    if (startupCoreReady) await startupCoreReady
    if (!agents.some((agent) => agent.lifecycle?.availability === 'available')) {
      throw new Error('没有可接收飞书消息的 Agent')
    }
    await bridge.start()
  } catch (error) {
    bridge.setPhase('failed', error instanceof Error ? error.message : String(error))
    throw error
  }
}
function restartConfiguredFeishuBridges(): void {
  if (appSettings.get().feishu?.enabled) void startFeishuBridgeWhenReady().catch(() => {})
  if (appSettings.get().assistantFeishu?.enabled) void startFeishuBridgeWhenReady(assistantFeishuBridge).catch(() => {})
}
const CAPABILITY_SYNC_JOB_SNAPSHOT_CHANNEL = 'capabilitySync:getJobSnapshot'
const APP_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const APP_UPDATE_CACHE_DIR = join(resolveUserDataHome(), 'app-update-cache.git')
let appUpdateTimer: ReturnType<typeof setInterval> | null = null

function appUpdateContext(): AppUpdateContext {
  return {
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    isE2E: e2eEnabled,
    cacheDir: APP_UPDATE_CACHE_DIR
  }
}

async function runAppUpdateCheck(force = false): Promise<AppUpdateState> {
  if (e2eEnabled) {
    return {
      currentVersion: app.getVersion(),
      hasUpdate: false,
      releaseUrl: RELEASE_REPOSITORY_PAGE,
      checkedAt: Date.now(),
      error: 'no_release'
    }
  }
  return checkAppUpdate(appUpdateContext(), { force, onFailure: error => {
    recordRuntime('app-update', error.code, error.code, 'warn', undefined, 'app', error.diagnostic)
  } })
}

function e2eKabooProfile(value: unknown): KabooProfileResult {
  const query = validateKabooQuery(value)
  if (!query) return { unavailable: true, reason: 'invalid-response' }
  e2eLastTokenUsageQuery = query
  e2eTokenUsageRequestCount += 1

  const periodBase = { day: 10_000, week: 20_000, month: 100_000, year: 300_000, all: 500_000 }[query.period]
  const anchor = query.start ? Number(query.start.replaceAll('-', '')) % 10_000 : 0
  const tokens = periodBase + anchor
  const trendDates: string[] = []
  if (query.period === 'all') {
    trendDates.push('2024-01-15', '2025-06-15', '2026-08-15')
  } else if (query.start && query.end) {
    const cursor = new Date(`${query.start}T00:00:00Z`)
    const end = new Date(`${query.end}T00:00:00Z`)
    while (cursor <= end) {
      trendDates.push(cursor.toISOString().slice(0, 10))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }
  const stats = {
    tokens, cost: tokens / 100_000, sessions: 8, hours: 3.5, codeLines: 640,
    inputTokens: Math.floor(tokens * 0.58), outputTokens: Math.floor(tokens * 0.25),
    cachedTokens: Math.floor(tokens * 0.13), reasoningTokens: Math.floor(tokens * 0.04)
  }
  const extraTools = Array.from({ length: 10 }, (_, index) => ({
    source: `fixture-tool-${String(index + 3).padStart(2, '0')}`,
    tokens: Math.max(1, Math.floor(tokens / (index + 4))),
    cost: 0.1,
    sessions: 1
  }))
  const extraModels = Array.from({ length: 11 }, (_, index) => ({
    model: `fixture-model-${String(index + 2).padStart(2, '0')}`,
    family: 'fixture',
    tokens: Math.max(1, Math.floor(tokens / (index + 3))),
    cost: 0.1
  }))
  const extraSkills = Array.from({ length: 11 }, (_, index) => ({
    skill: `fixture-skill-${String(index + 2).padStart(2, '0')}`,
    tokens: Math.max(1, Math.floor(tokens / (index + 5))),
    cost: 0.1,
    sessions: 1,
    invocations: index + 1
  }))
  const extraProjects = Array.from({ length: 11 }, (_, index) => ({
    project: `fixture-project-${String(index + 2).padStart(2, '0')}`,
    tokens: Math.max(1, Math.floor(tokens / (index + 3))),
    cost: 0.1,
    sessions: 1,
    models: 1
  }))
  return {
    range: query.period, reportedAt: query.now, stats,
    prevStats: { ...stats, tokens: Math.max(0, tokens - 10_000) },
    heatmap: Array.from({ length: 7 }, (_, day) =>
      Array.from({ length: 24 }, (_, hour) => periodBase + day * 24 + hour)),
    dailyTrend: trendDates.map((date, index) => ({
      date, tokens: periodBase + anchor + index + 1, cost: 0, inputTokens: 0,
      outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, hours: 0,
      sessions: 0, messages: 0
    })),
    toolBreakdown: [
      { source: 'codex', tokens: Math.floor(tokens * 2 / 3), cost: 0.8, sessions: 5 },
      { source: 'traex', tokens: Math.ceil(tokens / 3), cost: 0.45, sessions: 3 },
      ...extraTools
    ],
    modelBreakdown: [{ model: 'gpt-5', family: 'gpt', tokens, cost: stats.cost }, ...extraModels],
    skillBreakdown: [{ skill: 'browser', tokens: Math.floor(tokens / 4), cost: 0.3, sessions: 2, invocations: 4 }, ...extraSkills],
    projectBreakdown: [{ project: 'UniAgent', tokens, cost: stats.cost, sessions: 8, models: 1 }, ...extraProjects],
    mcpBreakdown: [{ name: 'filesystem', count: 3 }]
  }
}

function configureAppUpdateChecks(runNow: boolean): void {
  if (appUpdateTimer) clearInterval(appUpdateTimer)
  appUpdateTimer = null
  if (e2eEnabled || !app.isPackaged || !appSettings.get().autoCheckUpdate) return
  const check = async (): Promise<void> => {
    const state = await runAppUpdateCheck()
    if (state.hasUpdate) mainWindow?.webContents.send(IPC.appUpdateAvailable, state)
  }
  if (runNow) void check()
  appUpdateTimer = setInterval(() => { void check() }, APP_UPDATE_INTERVAL_MS)
  appUpdateTimer.unref?.()
}

function configureIdleAgentUpdates(): void {
  if (!e2eEnabled && !isQuitting && idleAgentUpdatesReady && appSettings.get().autoUpdateAgentsWhenIdle) idleAgentUpdater.start()
  else idleAgentUpdater.stop()
}

function configurePreventSleep(enabled: boolean): void {
  if (enabled && !isQuitting) {
    if (sleepBlockerId === undefined) sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (sleepBlockerId !== undefined) {
    powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = undefined
  }
}

async function awaitSessionHydration(): Promise<void> {
  const hydration = startupSessionHydration
  if (hydration) await hydration
}

function projectHasActiveSession(projectId: string): boolean {
  return orchestrator.listSessions().some((session) =>
    session.config.projectId === projectId &&
    ['running', 'queued', 'awaiting-approval', 'cancelling'].includes(session.status)
  )
}

async function awaitAgentReady(agentId: string): Promise<void> {
  await awaitSessionHydration()
  if (startupHandoffReady) await startupHandoffReady
  // Grok is probed over ACP, so it settles on the protocol barrier instead.
  const isProtocolAgent = agentId === 'grok' || agentId === 'kimi' || agentId === 'deepseek' || agentId === 'mcode' || agentId === 'zcode' || agentId === 'nika'
  const readiness = isProtocolAgent ? startupProtocolSettled : startupCoreReady
  if (readiness) await readiness
  if (isProtocolAgent && !agents.some((agent) => agent.id === agentId)) {
    // A supplemental full detection can supersede the startup generation while
    // its ACP phase is still pending. Join that detection before treating the
    // provider as absent, so resumed sessions cannot race a core-only snapshot.
    await agentLifecycle.detectAll()
    agents = agentLifecycle.snapshot()
    if (!agents.some((agent) => agent.id === agentId)) throw new Error('agent_not_available')
  }
}

async function awaitSessionAgentReady(sessionId: string): Promise<void> {
  await awaitSessionHydration()
  const session = orchestrator.listSessions().find((item) => item.id === sessionId)
  if (session) await awaitAgentReady(session.config.agentId)
}

async function awaitAgentsReady(agentIds: readonly string[]): Promise<void> {
  await Promise.all([...new Set(agentIds)].map((agentId) => awaitAgentReady(agentId)))
}

async function createTeamProject(
  input: TeamCreateProjectInput,
  beforeStart?: (project: TeamProject) => void,
  initialTurn?: TeamInitialTurn,
  background = false
): Promise<TeamProject> {
  const definition = teams.store.team(input.teamId)
  if (input.requirementId && !isRequirementsEnabled()) throw new Error('需求功能已停用')
  await awaitAgentsReady(definition.members.map(m => m.role.agentId))
  return teams.create(input, beforeStart, initialTurn, background)
}

async function respondUniAgentRequest(sessionId: string, requestId: string, answer: unknown, source?: 'mcp'): Promise<void> {
  await awaitSessionHydration()
  if (!requestId.startsWith('plan-confirmation:') && orchestrator.getSessionById(sessionId)?.teamBinding) {
    const { p, leader } = teams.binding(sessionId)
    if (!leader) throw new Error('team_member_read_only')
    const match = /^team:(.+):(\d+)$/.exec(requestId)
    const interaction = match ? p.interactions.find(i => i.id === match[1]) : p.interactions.find(i => i.sessionId === sessionId && i.requestId === requestId && i.state === 'pending')
    if (!interaction || !teamInteractionForUser(interaction, p.team.leaderMemberId)) throw new Error('interaction_expired')
    await teams.respond(p.id,interaction.id,match ? Number(match[2]) : interaction.revision,answer,false,source)
    await orchestrator.flushSessionLogs()
    return
  }
  const result = await orchestrator.respondToRequest(sessionId,requestId,answer,source ? { source } : undefined)
  if (!result?.handled) throw new Error('请求已失效或未被 Agent 接受')
}

const CAPABILITY_SYNC_PUBLIC_ERRORS = new Set([
  'untrusted_ipc_sender',
  'invalid_capability_scan_request',
  'invalid_capability_plan_request',
  'invalid_capability_execute_request',
  'invalid_capability_inventory_sync_request',
  'invalid_capability_plugin_action',
  'invalid_job_id',
  'invalid_cancel_request',
  'invalid_transaction_id',
  'invalid_preview_request',
  'invalid_journal',
  'scan_not_found',
  'plan_not_found',
  'plan_blocked',
  'confirmation_required',
  'stale_plan',
  'target_changed_since_commit',
  'sync_in_progress',
  'preview_not_supported',
  'agents_source_empty',
  'agents_merge_conflict',
  'transaction_not_rollbackable',
  'atomic_fs_unavailable',
  'recovery_required',
  'invalid_selection',
  'plugin_target_incompatible',
  'plugin_install_failed',
  'plugin_uninstall_failed',
  'invalid_capability_inventory_manage_request',
  'capability_inventory_stale',
  'capability_inventory_read_only',
  'capability_inventory_already_exists',
  'capability_inventory_invalid_config',
  'capability_inventory_unsafe_path',
  'capability_inventory_action_unsupported',
  'capability_inventory_unavailable',
  'capability_inventory_manage_failed'
])
const CAPABILITY_SYNC_PUBLIC_JOB_STAGES = new Set([
  'validating_revisions', 'revision_changed', 'source_revision_changed', 'target_revision_changed', 'cancelled_before_write', 'cancellation_requested',
  'transaction_setup_failed', 'backing_up', 'staging', 'committing', 'static_validation',
  'native_validation_pending', 'no_target_change', 'rolling_back', 'rollback_completed',
  'recovery_required', 'unexpected_failure'
])
const CAPABILITY_SYNC_PUBLIC_JOB_ERRORS = new Set([
  'cancelled', 'stale_plan', 'backup_failed', 'stage_failed', 'stage_validation_failed',
  'commit_failed', 'verification_failed', 'startup_recovery', 'rollback_failed', 'atomic_fs_unavailable', 'internal_error'
])
const CAPABILITY_SYNC_PUBLIC_JOB_STATES = new Set([
  'idle', 'scanning', 'scanned', 'planning', 'ready', 'blocked', 'backing_up', 'staging',
  'committing', 'verifying', 'completed', 'failed_no_change', 'rolling_back', 'rolled_back',
  'rollback_failed', 'cancelled'
])

function isTrustedCapabilitySyncRenderer(
  sender: Electron.WebContents,
  frame: Electron.WebFrameMain | null
): boolean {
  const window = mainWindow
  if (!window || window.isDestroyed() || sender !== window.webContents ||
      !frame || frame !== window.webContents.mainFrame) return false
  try {
    const actual = new URL(frame.url)
    const expected = process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL)
      : pathToFileURL(resolveUiPath('renderer/index.html'))
    // Dev-server routes and query/hash state may change, but their complete
    // scheme/host/port origin must match. file: has an opaque "null" origin,
    // so packaged builds additionally pin the host and exact entry pathname.
    if (actual.origin !== expected.origin || actual.protocol !== expected.protocol ||
        (expected.protocol === 'file:' &&
          (actual.host !== expected.host || actual.pathname !== expected.pathname))) return false
    return true
  } catch {
    return false
  }
}

function assertTrustedCapabilitySyncIpc(event: Electron.IpcMainInvokeEvent): void {
  if (!isTrustedCapabilitySyncRenderer(event.sender, event.senderFrame)) {
    throw new Error('untrusted_ipc_sender')
  }
}

function publicCapabilitySyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const code = message.split(':', 1)[0]
  return CAPABILITY_SYNC_PUBLIC_ERRORS.has(code) ? code : 'capability_sync_failed'
}

async function capabilitySyncIpc<T>(
  event: Electron.IpcMainInvokeEvent,
  action: () => T | Promise<T>
): Promise<T> {
  try {
    assertTrustedCapabilitySyncIpc(event)
    // The window is intentionally shown before crash recovery finishes. Keep
    // every capability mutation behind the original recovery barrier even
    // though the rest of the UI is already usable.
    if (capabilityRecoveryFlight) await capabilityRecoveryFlight
    return await action()
  } catch (error) {
    // Never serialize native filesystem errors (which can contain absolute
    // paths) or arbitrary service messages across this privilege boundary.
    throw new Error(publicCapabilitySyncError(error))
  }
}

function strictCapabilitySyncDto(
  value: unknown,
  keys: readonly string[],
  errorCode: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(errorCode)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(errorCode)
  const dto = value as Record<string, unknown>
  const actualKeys = Object.keys(dto)
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) {
    throw new Error(errorCode)
  }
  return dto
}

function parseNativeCapabilityRequest(value: unknown): NativeCapabilityRequest & { force: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_native_capability_request')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid_native_capability_request')
  const dto = value as Record<string, unknown>
  if (Object.keys(dto).some((key) =>
    key !== 'agentId' && key !== 'workdir' && key !== 'sessionId' && key !== 'force'
  )) {
    throw new Error('invalid_native_capability_request')
  }
  if (typeof dto.agentId !== 'string' || !dto.agentId.trim() ||
      typeof dto.workdir !== 'string' || !dto.workdir.trim() ||
      (dto.sessionId !== undefined && (typeof dto.sessionId !== 'string' || !dto.sessionId.trim())) ||
      (dto.force !== undefined && typeof dto.force !== 'boolean')) {
    throw new Error('invalid_native_capability_request')
  }
  return {
    agentId: dto.agentId,
    workdir: dto.workdir,
    ...(typeof dto.sessionId === 'string' ? { sessionId: dto.sessionId } : {}),
    force: dto.force === true
  }
}

function parseNativeTurnSelectionRequest(value: unknown): NativeTurnSelectionRequest | undefined {
  if (value === undefined) return undefined
  const dto = strictCapabilitySyncDto(value, ['candidateIds'], 'invalid_native_turn_selection')
  if (
    !Array.isArray(dto.candidateIds) ||
    dto.candidateIds.some((candidateId) => typeof candidateId !== 'string' || !candidateId.trim())
  ) {
    throw new Error('invalid_native_turn_selection')
  }
  return { candidateIds: [...dto.candidateIds] as string[] }
}

async function resolveNativeTurnSelection(
  agentId: string,
  workdir: string,
  selection: NativeTurnSelectionRequest | undefined,
  sessionId?: string
): Promise<ResolvedNativeTurnContext | undefined> {
  if (!selection) return undefined
  const agent = agents.find((item) => item.id === agentId)
  if (!agent) throw new Error(`未找到 Agent: ${agentId}`)
  return nativeCapabilityService.resolveSelection(agent, workdir, selection, sessionId)
}

// 选中即评论 — normalize the renderer-supplied bubble decorations so only the
// quote/comment cards + instruction text reach the orchestrator (no untrusted
// extra fields ride along into the persisted transcript).
function sanitizeTurnBubble(bubble: unknown): TurnBubbleInput | undefined {
  if (!bubble || typeof bubble !== 'object') return undefined
  const dto = bubble as { comments?: unknown; displayText?: unknown }
  const comments = Array.isArray(dto.comments)
    ? dto.comments
        .filter((item): item is BubbleComment =>
          !!item && typeof item === 'object' &&
          typeof (item as BubbleComment).quote === 'string' &&
          typeof (item as BubbleComment).comment === 'string')
        .map((item) => ({ quote: String(item.quote), comment: String(item.comment) }))
    : []
  const displayText = typeof dto.displayText === 'string' && dto.displayText ? dto.displayText : undefined
  if (!comments.length && displayText === undefined) return undefined
  return {
    ...(comments.length ? { comments } : {}),
    ...(displayText === undefined ? {} : { displayText })
  }
}

function parseCapabilityJobRequest(value: unknown): { jobId: string } {
  const dto = strictCapabilitySyncDto(value, ['jobId'], 'invalid_job_id')
  if (!isUuid(dto.jobId)) throw new Error('invalid_job_id')
  return { jobId: dto.jobId }
}

function parseCapabilityCancelRequest(value: unknown): { jobId: string } {
  const dto = strictCapabilitySyncDto(value, ['jobId'], 'invalid_cancel_request')
  if (!isUuid(dto.jobId)) throw new Error('invalid_cancel_request')
  return { jobId: dto.jobId }
}

function parseCapabilityRollbackRequest(value: unknown): { transactionId: string } {
  const dto = strictCapabilitySyncDto(value, ['transactionId'], 'invalid_transaction_id')
  if (!isUuid(dto.transactionId)) throw new Error('invalid_transaction_id')
  return { transactionId: dto.transactionId }
}

function parseCapabilityPreviewDto(value: unknown): ReturnType<typeof parseCapabilityPreviewRequest> {
  const dto = strictCapabilitySyncDto(
    value, ['scanId', 'itemId', 'strategy'], 'invalid_preview_request'
  )
  return parseCapabilityPreviewRequest(dto.scanId, dto.itemId, dto.strategy)
}

function publicCapabilitySyncJob(job: CapabilitySyncJob | undefined): CapabilitySyncJob | undefined {
  const counter = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
  if (!job || !isUuid(job.id) || !isUuid(job.planId) ||
      (job.operation != null && !['sync', 'remove-selected'].includes(job.operation)) ||
      (job.transactionId != null && !isUuid(job.transactionId)) ||
      !CAPABILITY_SYNC_PUBLIC_JOB_STATES.has(job.state) ||
      !Number.isSafeInteger(job.updatedAt) || job.updatedAt < 0 ||
      (job.progress != null && (!counter(job.progress.completed) || !counter(job.progress.total) ||
        job.progress.completed > job.progress.total)) ||
      (job.result != null && Object.values(job.result).some((value) => !counter(value)))) return undefined
  return {
    id: job.id,
    planId: job.planId,
    ...(job.operation ? { operation: job.operation } : {}),
    ...(job.transactionId ? { transactionId: job.transactionId } : {}),
    state: job.state,
    ...(job.stage && CAPABILITY_SYNC_PUBLIC_JOB_STAGES.has(job.stage) ? { stage: job.stage } : {}),
    ...(job.progress ? { progress: { completed: job.progress.completed, total: job.progress.total } } : {}),
    ...(job.errorCode && CAPABILITY_SYNC_PUBLIC_JOB_ERRORS.has(job.errorCode) ? { errorCode: job.errorCode } : {}),
    ...(job.result ? { result: {
      verified: job.result.verified,
      noop: job.result.noop,
      skipped: job.result.skipped,
      manualRequired: job.result.manualRequired,
      failed: job.result.failed,
      rolledBack: job.result.rolledBack,
      residualDifferences: job.result.residualDifferences
    } } : {}),
    updatedAt: job.updatedAt
  }
}

function publicCapabilityRollbackCandidate(
  job: CapabilitySyncJob | undefined
): CapabilityRollbackCandidate | undefined {
  // Project through the existing job whitelist first. Never spread a journal
  // record (or even the untrusted persisted job) directly across IPC.
  const safe = publicCapabilitySyncJob(job)
  if (!safe || safe.state !== 'completed' || !safe.transactionId) return undefined
  return { ...safe, state: 'completed', transactionId: safe.transactionId }
}

function publicCapabilityScan(result: CapabilityScanResult): CapabilityScanResult {
  return {
    id: result.id,
    source: result.source,
    target: result.target,
    sourceRevision: result.sourceRevision,
    targetRevision: result.targetRevision,
    scannedAt: result.scannedAt,
    sourceAvailable: result.sourceAvailable,
    targetAvailable: result.targetAvailable,
    executionSupported: result.executionSupported,
    ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
    items: result.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      status: item.status,
      compatible: item.compatible,
      selectable: item.selectable,
      cloneSafe: item.cloneSafe,
      defaultSelected: item.defaultSelected,
      ...(item.issueCode ? { issueCode: item.issueCode } : {})
    }))
  }
}

function publicCapabilityPlan(plan: CapabilitySyncPlan): CapabilitySyncPlan {
  return {
    id: plan.id,
    scanId: plan.scanId,
    source: plan.source,
    target: plan.target,
    sourceRevision: plan.sourceRevision,
    targetRevision: plan.targetRevision,
    mode: plan.mode,
    operations: plan.operations.map((operation) => ({
      itemId: operation.itemId,
      kind: operation.kind,
      name: operation.name,
      action: operation.action,
      destructive: operation.destructive,
      verification: operation.verification,
      ...(operation.issueCode ? { issueCode: operation.issueCode } : {})
    })),
    destructiveCount: plan.destructiveCount,
    requiresConfirmation: plan.requiresConfirmation,
    blockedReasons: [...plan.blockedReasons],
    ...(plan.agentsStrategy ? { agentsStrategy: plan.agentsStrategy } : {})
  }
}

/**
 * P5 — republish the MCP handoff catalog (agents + presets + roles) to disk so the
 * query tools always enumerate current options. Called after detection and
 * whenever a preset or role is saved/removed.
 */
function publishHandoffCatalog(): void {
  writeHandoffCatalog(agents, presets.list(), buildAgentRoleCatalog(projectRoles(), agents), projects.list())
}

function saveUniAgentRole(role: AgentRole) {
  const prepared = prepareAgentRoleInput(role)
  if (prepared.projectId && !projects.get(prepared.projectId)) throw new Error('role_project_unavailable')
  const candidate = projectRoles().filter(entry => entry.id !== prepared.id).concat(prepared)
  const rejected = buildAgentRoleCatalog(candidate,agents).find(entry => entry.role.id === prepared.id)
  if (rejected && !rejected.executable) throw new Error(rejected.unavailableReason || 'role_unavailable')
  const saved = roles.save(prepared); publishHandoffCatalog(); return buildAgentRoleCatalog(saved,agents)
}
function deleteUniAgentRole(id: string) { const saved = roles.remove(id); publishHandoffCatalog(); return buildAgentRoleCatalog(saved,agents) }
function patchAppSettings(patch: AppSettingsPatch) {
  const next = appSettings.set(patch)
  if ('feishu' in patch) { if (next.feishu?.enabled) void startFeishuBridgeWhenReady().catch(() => {}); else void feishuBridge.stop() }
  if ('assistantFeishu' in patch) { if (next.assistantFeishu?.enabled) void startFeishuBridgeWhenReady(assistantFeishuBridge).catch(() => {}); else void assistantFeishuBridge.stop() }
  if ('autoCheckUpdate' in patch) configureAppUpdateChecks(false)
  if ('autoUpdateAgentsWhenIdle' in patch) configureIdleAgentUpdates()
  if ('preventSleep' in patch) configurePreventSleep(next.preventSleep ?? false)
  if ('requirementsEnabled' in patch) setRequirementsEnabled(next.requirementsEnabled === true)
  return next
}
async function listManagedInventories() {
  return listAgentToolInventories(agentToolInventoryOptions())
}

function agentToolInventoryOptions(): AgentToolInventoryOptions {
  const fixtureHome = process.env.UNIAGENT_CAPABILITY_HOME
  const home = fixtureHome || homedir()
  return { home, agents: agents.filter(agent => agent.builtin),
    deepseekHome: fixtureHome ? join(home, '.uniagent-public/deepseek/home') : join(resolveUserDataHome(), 'deepseek/home'),
    ...(fixtureHome ? { env: { HOME: home, KIMI_CODE_HOME: join(home, '.kimi-code'), GROK_HOME: join(home, '.grok'),
      MINIMAX_DATA_DIR: join(home, '.minimax') } } : {}),
    kimiPluginRemove: async id => {
      const agent = agents.find(agent => agent.adapter === 'kimi')
      if (!agent) throw new Error('capability_inventory_unavailable')
      const lease = await acquireKimiWebService({ bin: agent.bin, cwd: home,
        ...(fixtureHome ? { env: { HOME: home, KIMI_CODE_HOME: join(home, '.kimi-code') } } : {}) })
      try { await lease.transport.request('POST', `/api/v1/plugins/${encodeURIComponent(id)}:remove`) }
      finally { await lease.release() }
    },
    zcodePlugins: () => orchestrator.listZCodeToolPlugins(home),
    zcodePluginRemove: id => orchestrator.uninstallZCodeToolPlugin(home, id),
    nativeSkills: {
      
      zcode: async () => {
        const snapshot = await orchestrator.discoverZCodeCapabilities(home)
        return { skills: snapshot.candidates.filter(candidate => candidate.kind === 'skill')
          .map(candidate => ({ name: candidate.name, path: candidate.path })), errors: snapshot.errors,
          mcps: snapshot.candidates.filter(candidate => candidate.kind === 'mcp').map(candidate => candidate.name),
          commands: snapshot.candidates.filter(candidate => candidate.kind === 'command').map(candidate => candidate.name) }
      }
    } }
}

function grokInventoryOptions() {
  const home = process.env.UNIAGENT_CAPABILITY_HOME
  return {cwd:home || homedir(),runner:readonlyGrokInventoryRunner,...(home ? {env:{HOME:home,GROK_HOME:join(home,'.grok')}} : {})}
}

async function refreshDetectedAgents(message = 'Codex 模型配置已更新'): Promise<AgentDef[]> {
  agents = await agentLifecycle.detectAll(true)
  await awaitSessionHydration()
  orchestrator.reconcileAgentConfigs()
  void reconcilePricing(agents.flatMap(agent => agent.models.map(model => model.id)))
  publishHandoffCatalog()
  mainWindow?.webContents.send(IPC.lifecycleProgress, { agentId: 'codex', phase: 'completed', message })
  return agents
}

async function refreshDetectedAgent(agentId: string): Promise<AgentDef> {
  const detected = await agentLifecycle.detectOne(agentId)
  agents = agentLifecycle.snapshot().filter(agent => agent.lifecycle?.detectionStatus !== 'detecting' || agent.lifecycle.availability === 'available')
  await awaitSessionHydration()
  orchestrator.reconcileAgentConfigs()
  publishHandoffCatalog()
  if (detected.lifecycle?.availability === 'available') orchestrator.resumePendingQueues(new Set([agentId]))
  restartConfiguredFeishuBridges()
  return detected
}




const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' https: http: file: data: blob:; style-src 'unsafe-inline' https: http: file:; img-src https: http: file: data: blob:; font-src https: http: file: data:; media-src https: http: file: data: blob:; connect-src https: http:; frame-src https: http: data: blob:; object-src 'none'"
const htmlPreviewCspSessions = new WeakSet<Electron.Session>()

function installHtmlPreviewCsp(session: Electron.Session, previewUrl: string): void {
  if (htmlPreviewCspSessions.has(session)) return
  htmlPreviewCspSessions.add(session)
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.url !== previewUrl) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    const responseHeaders = { ...details.responseHeaders }
    for (const name of Object.keys(responseHeaders)) {
      if (name.toLowerCase() === 'content-security-policy') delete responseHeaders[name]
    }
    responseHeaders['Content-Security-Policy'] = [HTML_PREVIEW_CSP]
    callback({ responseHeaders })
  })
}

function createWindow(onLoaded?: () => void): void {
  const previewUrl = resolveHtmlPreviewUrl()
  const window = takeStartupWindow() || createAppWindow()
  mainWindow = window
  window.on('focus', () => sessionBadge.readVisibleSession())
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => sessionBadge.handleNavigation(isMainFrame, isInPlace))
  let windowClosing = false
  window.on('close', () => { windowClosing = true })
  installHtmlPreviewCsp(window.webContents.session, previewUrl)
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(resolveUiPath('renderer/index.html'))
  }
  if (onLoaded) window.webContents.once('did-finish-load', onLoaded)

  // All links leave the app: deny child windows and in-place navigation, and
  // hand only trusted web protocols to the user's default system browser.
  installExternalNavigation(window.webContents, (url) => shell.openExternal(url))

  window.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url)
    recordRuntime('renderer', 'page_load_failed', desc, 'error')
  })
  window.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    if (level >= 2) {
      recordRuntime(
        'renderer-console',
        level >= 3 ? 'console_error' : 'console_warning',
        message,
        level >= 3 ? 'error' : 'warn',
        undefined,
        'app',
        { line, sourceId }
      )
    }
  })
  window.webContents.on('render-process-gone', (_e, details) => {
    sessionBadge.setVisibleSession(null)
    console.error('[render-process-gone]', details)
    if (details.reason === 'clean-exit' || isQuitting || windowClosing) return
    performanceMonitor?.record('renderer_gone', { reason: details.reason, exitCode: details.exitCode })
    recordRuntime(
      'renderer',
      'render_process_gone',
      details.reason,
      'error',
      undefined,
      'app',
      { reason: details.reason, exitCode: details.exitCode }
    )
    // macOS jetsam can kill the renderer under memory pressure. The main
    // process (and the orchestrator's live sessions) survive, so reload the
    // window to recover the UI instead of leaving a dead page. Session state
    // is persisted and re-hydrated on load.
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
      }, 300)
    }
  })
  window.on('unresponsive', () => performanceMonitor?.record('renderer_unresponsive', {}))
  window.on('responsive', () => performanceMonitor?.record('renderer_responsive', {}))

  window.on('closed', () => {
    if (mainWindow === window) {
      detailWindow.close()
      mainWindow = null
      sessionBadge.setVisibleSession(null)
    }
  })

  // Self-capture for headless render verification (bypasses OS screen-recording perms).
  if (process.env.UA_CAPTURE) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (window.isDestroyed()) return
          const img = await window.webContents.capturePage()
          const fs = await import('node:fs')
          fs.writeFileSync(process.env.UA_CAPTURE!, img.toPNG())
          console.log('[UA_CAPTURE] wrote', process.env.UA_CAPTURE)
        } catch (e) {
          console.error('[UA_CAPTURE] failed', e)
        }
      }, 1500)
    })
  }
}

function showAppNotification(sessionId: string, body: string): void {
  const session = orchestrator.getSessionById(sessionId)
  const notification = new Notification({ title: session?.title || APP_NAME, body })
  notification.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      mainWindow?.once('ready-to-show', () => mainWindow?.webContents.send(IPC.appNotificationOpenSession, sessionId))
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send(IPC.appNotificationOpenSession, sessionId)
  })
  notification.show()
}

const failedNotificationSessions = new Set<string>()
const sessionBadge = new SessionAttentionBadge(
  text => { if (process.platform === 'darwin') app.dock?.setBadge(text) },
  () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && mainWindow.isVisible() && !mainWindow.isMinimized()
)

// A team's member sessions never render as their own sidebar row: the Leader
// session row represents the whole team. Attention on a member must therefore be
// recorded, read and cleared through that row; otherwise a member failure inside
// an open team leaves a Dock badge with no session the user can read.
let teamRowIds = new Map<string, string>()
function refreshTeamRowIds(): void {
  // Shallow view: indexing must not clone whole team projects on every change.
  teamRowIds = teamRowSessionIds(teams.store.projectList())
}
teams.on('changed', refreshTeamRowIds)
refreshTeamRowIds()

function badgeOwner(session: Session | undefined): Session | undefined {
  if (!session) return undefined
  const leaderId = teamRowIds.get(session.id)
  if (!leaderId || leaderId === session.id) return session
  return orchestrator.getSessionById(leaderId) || session
}

function badgeOwnerId(sessionId: string): string {
  return badgeOwner(orchestrator.getSessionById(sessionId))?.id || sessionId
}

function forgetBadgeSession(sessionId: string): void {
  sessionBadge.removeSession(sessionId)
  const ownerId = badgeOwnerId(sessionId)
  if (ownerId !== sessionId) sessionBadge.removeSession(ownerId)
}

// Fan-out orchestrator events to the renderer.
handoffTaskStore.on('end', (event: import('../shared/types').UAEvent) => {
  void orchestrator.recordHandoffEnd(event).catch(error => recordRuntime('handoff', 'handoff_end_event_failed', error))
})
orchestrator.on('eventsReset', (snapshot: ZCodeEventsSnapshot) => {
  mainWindow?.webContents.send(ZCODE_IPC.eventsReset, snapshot)
})
orchestrator.on('sessionCreated', (session: Session) => {
  if (session.teamBinding) mainWindow?.webContents.send(IPC.sessionCreated, session)
  const id = session.handoffId
  if (!id || !handoffTaskStore.isActive(id)) return
  // Bind before createSession emits its first user/output/status event.
  handoffWaits.set(session.id, id)
  handoffSessions.set(id, session.id)
  writeHandoffResult(id, { status: session.status, text: '', sessionId: session.id, ...handoffTargetMetadata(session) })
})
orchestrator.on('sessionArchived', (sessionId: string) => forgetBadgeSession(sessionId))
orchestrator.on('sessionDeleted', (sessionId: string) => {
  forgetBadgeSession(sessionId)
  handoffTaskStore.removeSession(sessionId)
  handoffWaits.delete(sessionId)
  for (const [taskId, targetId] of handoffSessions) {
    if (targetId === sessionId) handoffSessions.delete(taskId)
  }
})
const uiEvents = new UIEventBatcher(events => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(IPC.event, events)
})
orchestrator.on('event', (ev) => {
  performanceMonitor?.event()
  const owner = orchestrator.getSessionById(ev.sessionId)
  sessionBadge.handleEvent(ev, badgeOwner(owner))
  const requirementId = owner?.config.requirementId
  if (requirementId && isRequirementsEnabled()) {
    const teamEvent = !!owner?.teamBinding && ev.type === 'system_notice' && ev.payload.kind === 'team_event'
    const sync = ev.type === 'user_message' || ev.type === 'goal_message' || teamEvent
      ? requirements.recordInput(requirementId, ev, owner?.teamBinding || ev.payload.source === 'mcp' ? 'team' : 'user', owner?.config.projectId)
      : ev.type === 'file_change' || ev.type === 'diff_update'
        ? requirements.invalidateKnowledge(requirementId, owner?.config.projectId)
      : ev.type === 'turn_completed'
        ? requirements.finishTurn(requirementId, ev)
        : undefined
    void sync?.then(() => {
      if (ev.type === 'turn_completed') requirementDistiller.schedule(requirementId, ev.sessionId)
    }).catch(error => {
      recordRuntime('agent', 'requirement_sync_failed', error, 'warn', ev.sessionId)
      orchestrator.reportRequirementSyncError(ev.sessionId, '需求上下文同步失败：' + (error instanceof Error ? error.message : String(error)))
    })
  }
  const taskId = handoffWaits.get(ev.sessionId)
  if (taskId) handoffTaskStore.recordEvent(taskId, ev)
  uiEvents.push(ev)
  const eventAgentId = orchestrator.getSessionById(ev.sessionId)?.config.agentId || 'app'
  if (ev.type === 'error') {
    recordRuntime(
      'agent', 'agent_run_error', ev.payload?.message || 'Agent 运行失败',
      'error', ev.sessionId, eventAgentId,
      { eventType: ev.type, state: ev.state, provider: ev.payload }
    )
  } else if (ev.type === 'system_notice' && ev.payload?.kind === 'warning') {
    recordRuntime('agent', 'agent_run_warning', ev.payload?.text || 'Agent 运行警告', 'warn', ev.sessionId, eventAgentId)
  }
  const body = appNotificationBody(ev, failedNotificationSessions)
  const mode = appSettings.get().notificationMode ?? 'unfocused'
  if (body && Notification.isSupported() && shouldShowAppNotification(mode, mainWindow?.isFocused() === true)) {
    showAppNotification(ev.sessionId, body)
  }
  // 需求4 — mirror terminal events / approvals into the bound Feishu 话题 (the
  // bridge itself no-ops unless connected + past the lock-screen门禁).
  feishuBridge.handleEvent(ev)
  assistantFeishuBridge.handleEvent(ev)
  assistantWeixinBridge.handleEvent(ev)
  if (ev.type === 'turn_completed' && ev.state === 'success') {
    appSettings.updateMetrics((metrics) => {
      if (metrics.firstSuccessfulTaskMs == null) metrics.firstSuccessfulTaskMs = Date.now() - metrics.firstLaunchAt
    })
  }
})
orchestrator.on('codexRateLimits', (snapshot: CodexRateLimits) => {
  const merged = rememberCodexRateLimits(snapshot)
  agentQuota.remember('codex', merged)
  mainWindow?.webContents.send(IPC.codexRateLimitsChanged, merged)
})
orchestrator.on('claudeRateLimits', (snapshot: CodexRateLimits) => {
  agentQuota.remember('claude', snapshot)
  mainWindow?.webContents.send(IPC.claudeRateLimitsChanged, rememberClaudeRateLimits(snapshot))
})
orchestrator.on('statusChange', (s) => {
  const badgeSession = orchestrator.getSessionById(s.sessionId)
  sessionBadge.handleStatus(badgeSession, s.status, badgeOwner(badgeSession))
  try {
    if (s.status === 'error') {
      void nativeAutomationError(s.sessionId).then(message => {
        nativeAutomations.handleStatus(s.sessionId, s.status, message)
      }).catch(error => recordRuntime('automations', 'native_result_write_failed', error))
    } else nativeAutomations.handleStatus(s.sessionId, s.status)
  } catch (error) {
    recordRuntime('automations', 'native_result_write_failed', error)
  }
  mainWindow?.webContents.send(IPC.statusChange, s)
  const terminal = ['idle', 'completed', 'error', 'cancelled', 'interrupted', 'archived'].includes(s.status)
  const stopRequests = handoffStops.get(s.sessionId)
  const stoppedByMcp = terminal && !!stopRequests?.length
  const handoffId = handoffWaits.get(s.sessionId)
  if (handoffId) {
    // 任务状态查询 — mirror the current status AND the latest agent reply so far so
    // get_uniagent_task returns a useful latestReply while the task is still
    // running (not only at terminal). Live rows are also the wait=true heartbeat.
    writeHandoffResult(handoffId, {
      status: stoppedByMcp ? 'interrupted' : s.status,
      text: handoffTaskStore.latestReply(handoffId) ?? orchestrator.latestAgentMessageText(s.sessionId),
      sessionId: s.sessionId,
      ...handoffTargetMetadata(orchestrator.getSessionById(s.sessionId)),
      ...(stoppedByMcp ? { stoppedBy: 'stop_uniagent_task' as const } : {})
    })
    if (terminal) {
      handoffWaits.delete(s.sessionId)
      const done = orchestrator.getSessionById(s.sessionId)
      if (done?.handoffWaiting) {
        done.handoffWaiting = false
        mainWindow?.webContents.send(IPC.sessionUpdated, { session: done, hasLiveStreamer: false })
      }
      // Fix#4 — clear the caller session's「等待 <agent> 的 <task>」status line now
      // that the awaited handoff has finished.
      const callerId = handoffCallers.get(handoffId)
      if (callerId) {
        handoffCallers.delete(handoffId)
        const caller = orchestrator.getSessionById(callerId)
        if (caller?.waitingForHandoff) {
          caller.waitingForHandoff = undefined
          mainWindow?.webContents.send(IPC.sessionUpdated, { session: caller, hasLiveStreamer: false })
        }
      }
    }
  }
  if (stoppedByMcp && stopRequests) {
    const text = '已停止当前回合并清空待发队列；Session 未删除、未归档，可继续对话或重新交办。'
    for (const request of stopRequests) {
      writeHandoffResult(request.id, {
        status: 'interrupted',
        text,
        sessionId: s.sessionId,
        taskId: request.taskId,
        stoppedBy: 'stop_uniagent_task'
      })
    }
    handoffStops.delete(s.sessionId)
  }
  if (terminal) {
    const session = orchestrator.listSessions().find((item) => item.id === s.sessionId)
    const persisted = appSettings.pendingInitialization(s.sessionId)
    const job = persisted || (session?.config.initializationJobId && session.config.initializationTargetAgentId
      ? { id: session.config.initializationJobId, targetAgentId: session.config.initializationTargetAgentId } : undefined)
    if (job) void agentLifecycle.detectAll(true).then((next) => {
      agents = next
      publishHandoffCatalog()
      appSettings.settleInitialization(job.id, next.find((agent) => agent.id === job.targetAgentId)?.lifecycle?.availability === 'available')
      restartConfiguredFeishuBridges()
    })
  }
})
orchestrator.on('queueChange', (q) => {
  mainWindow?.webContents.send(IPC.queueChange, q)
})
// 需求2（侧边对话）— fan-out the ephemeral side branch's events / status.
orchestrator.on('sideEvent', (p: { sessionId: string; event: unknown }) => {
  sessionBadge.handleEvent(p.event as UAEvent, badgeOwner(orchestrator.getSessionById(p.sessionId)), 'side')
  mainWindow?.webContents.send(IPC.sideEvent, p)
  feishuBridge.handleSideEvent(p.event as UAEvent)
  assistantFeishuBridge.handleSideEvent(p.event as UAEvent)
  const event = p.event as UAEvent
  const agentId = orchestrator.getSessionById(p.sessionId)?.config.agentId || 'app'
  if (event?.type === 'error') {
    recordRuntime(
      'side-agent', 'side_run_error', event.payload?.message || '侧边对话运行失败',
      'error', p.sessionId, agentId,
      { eventType: event.type, state: event.state, provider: event.payload }
    )
  } else if (event?.type === 'system_notice' && event.payload?.kind === 'warning') {
    recordRuntime('side-agent', 'side_run_warning', event.payload?.text || '侧边对话运行警告', 'warn', p.sessionId, agentId)
  }
})
orchestrator.on('sideStatus', (p: { sessionId: string; status: string }) => {
  mainWindow?.webContents.send(IPC.sideStatus, p)
})
orchestrator.on('sideState', (p: { sessionId: string; state: SideChatState }) => {
  mainWindow?.webContents.send(IPC.sideState, p)
})
// 选中即评论 / 详情 — fan-out the ephemeral detail branch's events / status.
orchestrator.on('detailEvent', (p: { sessionId: string; event: unknown }) => {
  detailWindow.forward(IPC.detailEvent, p)
  mainWindow?.webContents.send(IPC.detailEvent, p)
  const event = p.event as UAEvent
  const agentId = orchestrator.getSessionById(p.sessionId)?.config.agentId || 'app'
  if (event?.type === 'error') {
    recordRuntime(
      'detail-agent', 'detail_run_error', event.payload?.message || '详情解释运行失败',
      'error', p.sessionId, agentId,
      { eventType: event.type, state: event.state, provider: event.payload }
    )
  } else if (event?.type === 'system_notice' && event.payload?.kind === 'warning') {
    recordRuntime('detail-agent', 'detail_run_warning', event.payload?.text || '详情解释运行警告', 'warn', p.sessionId, agentId)
  }
})
orchestrator.on('detailStatus', (p: { sessionId: string; status: string }) => {
  detailWindow.forward(IPC.detailStatus, p)
  mainWindow?.webContents.send(IPC.detailStatus, p)
})
orchestrator.on('sessionUpdated', (update) => {
  void comments.syncPermissions(update.session).catch(error => recordRuntime('comments', 'permission_sync_failed', error))
  if (update.session.archived || isToolSession(update.session)) forgetBadgeSession(update.session.id)
  mainWindow?.webContents.send(IPC.sessionUpdated, update)
  feishuBridge.handleSessionUpdated(update.session)
  assistantFeishuBridge.handleSessionUpdated(update.session)
})
orchestrator.on('nativeCapabilitiesChanged', (change: { agentId: string; workdir: string; sessionId?: string }) => {
  nativeCapabilityService.invalidate(change.agentId, change.workdir)
  const window = mainWindow
  if (window && isTrustedCapabilitySyncRenderer(window.webContents, window.webContents.mainFrame)) {
    window.webContents.send(IPC.nativeCapabilitiesChanged, change)
  }
})
orchestrator.on('nativeMcpStatusChanged', (change: {
  agentId: string
  workdir: string
  name: string
  status: import('../shared/nativeCapabilities').McpStartupStatus
  statusMessage?: string
}) => {
  const changed = nativeCapabilityService.applyMcpStatus(
    change.agentId,
    change.workdir,
    change.name,
    change.status,
    change.statusMessage
  )
  const window = mainWindow
  if (changed && window && isTrustedCapabilitySyncRenderer(window.webContents, window.webContents.mainFrame)) {
    window.webContents.send(IPC.nativeCapabilitiesChanged, {
      agentId: change.agentId,
      workdir: change.workdir,
      mcpStatus: { name: change.name, status: change.status, statusMessage: change.statusMessage }
    })
  }
})
orchestrator.on('agentUpdate', (update: AgentContractUpdate) => {
  mainWindow?.webContents.send(IPC.agentUpdate, update)
})
// 跨 Agent 迁移诊断: push each newly recorded (or bumped) diagnostic so the
// sidebar entry can badge it live without a poll.
diagnostics.on('diagnostic', (entry) => {
  mainWindow?.webContents.send(IPC.diagnostic, entry)
})
capabilitySync.on('progress', (job: CapabilitySyncJob) => {
  const safe = publicCapabilitySyncJob(job)
  if (safe && (safe.state === 'failed_no_change' || safe.state === 'rollback_failed')) {
    recordRuntime('capability-sync', safe.errorCode || safe.state, safe.stage || safe.errorCode || safe.state)
  }
  const window = mainWindow
  if (safe && window && isTrustedCapabilitySyncRenderer(window.webContents, window.webContents.mainFrame)) {
    window.webContents.send(IPC.capabilitySyncProgress, safe)
    if (safe.state === 'completed' || safe.state === 'rolled_back' || safe.state === 'rollback_failed') window.webContents.send(IPC.capabilityInventoryChanged)
  }
})
agentLifecycle.on('progress', (progress) => {
  agents = agentLifecycle.snapshot().filter(agent => agent.lifecycle?.detectionStatus !== 'detecting' || agent.lifecycle.availability === 'available')
  mainWindow?.webContents.send(IPC.lifecycleProgress, progress)
  if (progress.phase === 'failed') {
    recordRuntime('agent-lifecycle', 'agent_lifecycle_failed', progress.message, 'error', undefined, progress.agentId)
    appSettings.updateMetrics((metrics) => { metrics.updateFailures[progress.message] = (metrics.updateFailures[progress.message] || 0) + 1 })
  }
})

function registerIpc(): void {
  detailWindow.register()
  ipcMain.handle(IPC.sessionBadgeVisible, (event, sessionId: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    let visible: string | null = null
    if (sessionId !== null) {
      const session = typeof sessionId === 'string' ? orchestrator.getSessionById(sessionId) : undefined
      if (!session) throw new Error('invalid_session_id')
      visible = badgeOwner(session)?.id ?? session.id
    }
    sessionBadge.setVisibleSession(visible)
  })
  ipcMain.handle(IPC.startupState, async (event) => {
    assertTrustedCapabilitySyncIpc(event)
    try {
      await Promise.all([startupSessionHydration, startupCoreReady, startupProtocolSettled, capabilityRecoveryFlight])
      if (!startupTimings.uiReadyMs) {
        startupTimings.uiReadyMs = Math.round(process.uptime() * 1000)
        performanceMonitor?.record('startup-ui', startupTimings)
      }
      return { ready: true }
    } catch {
      return { ready: false, error: '初始化未完成，请重新启动 UniAgent。' }
    }
  })
  // User mutations share one guard; MCP execution calls the orchestrator directly.
  const handleUserSessionMutation = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, async (event, sessionId: unknown, ...args: unknown[]) => {
      assertTrustedCapabilitySyncIpc(event)
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('invalid_session_id')
      await awaitSessionHydration()
      orchestrator.assertUserSessionEnabled(sessionId)
      return listener(event, sessionId, ...args)
    })
  }
  const teamHandle = (channel: string, action: (...args: any[]) => unknown) => ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    return action(...args)
  })
  teamHandle(TEAM_IPC.catalog, () => teams.catalog())
  teamHandle(TEAM_IPC.save, (input: TeamDefinitionInput) => teams.saveTeam(input))
  teamHandle(TEAM_IPC.delete, (id: string, revision: number) => teams.deleteTeam(id, revision))
  const teamRoleReceipts = new Map<string, { input: string; role: AgentRole }>()
  teamHandle(TEAM_IPC.createRole, (role: AgentRole, saveGlobal: boolean, requestId: string) => {
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId) || typeof saveGlobal !== 'boolean') throw new Error('invalid_role_request')
    const input = JSON.stringify([role, saveGlobal])
    const prior = teamRoleReceipts.get(requestId)
    if (prior) { if (prior.input !== input) throw new Error('request_id_conflict'); return prior.role }
    const prepared = prepareAgentRoleInput({ ...role, id: '' })
    const entry = buildAgentRoleCatalog([prepared], agents)[0]
    if (!entry?.executable) throw new Error(entry?.unavailableReason || 'role_unavailable')
    if (saveGlobal) { roles.save(prepared); publishHandoffCatalog() }
    teamRoleReceipts.set(requestId, { input, role: prepared })
    if (teamRoleReceipts.size > 1000) teamRoleReceipts.delete(teamRoleReceipts.keys().next().value!)
    return prepared
  })
  teamHandle(TEAM_IPC.createProject, async (input: TeamCreateProjectInput) => {
    return createTeamProject(input, undefined, undefined, true)
  })
  teamHandle(TEAM_IPC.send, (id: string, prompt: string, attachments?: Attachment[]) => teams.send(id, prompt, attachments))
  teamHandle(TEAM_IPC.stop, (id: string) => teams.stop(id))
  teamHandle(TEAM_IPC.resume, (id: string) => {
    const project = teams.catalog().projects.find(item => item.id === id)
    const leader = project && orchestrator.getSessionById(project.memberSessions[project.team.leaderMemberId])
    if (leader?.worktreeTask) return teams.prepareWorktreeProject(id)
    if (project?.worktree && !Object.values(project.memberSessions).some(sid => orchestrator.getSessionById(sid))) {
      return teams.create({ teamId: project.teamId, spaceId: project.spaceId, requirementId: project.requirementId, prompt: project.goal,
        workspaceSelection: { mode: 'worktree', baseRef: project.worktree.baseRef, requestId: project.worktree.creationRequestId } })
    }
    return teams.resume(id)
  })
  teamHandle(TEAM_IPC.archive, (id: string) => teams.archive(id))
  teamHandle(TEAM_IPC.rename, (id: string, name: string) => teams.rename(id, name))
  teamHandle(TEAM_IPC.session, (id: string, memberId: string) => teams.memberSession(id, memberId))
  teamHandle(TEAM_IPC.respond, (id: string, interactionId: string, revision: number, answer: unknown) => teams.respond(id, interactionId, revision, answer))
  teamHandle(TEAM_IPC.artifact, (id: string, artifactId: string) => teams.artifact(id, artifactId))
  ipcMain.handle(IPC.e2eEnabled, () => e2eEnabled)
  ipcMain.handle(IPC.e2eInjectEvents, (event, injected: UAEvent[]) => {
    if (!e2eEnabled || !Array.isArray(injected)) return false
    for (const item of injected) event.sender.send(IPC.event, item)
    return true
  })
  ipcMain.handle(IPC.listAgents, () => e2eLifecycleAgents || (agentLifecycle.snapshot().length ? agentLifecycle.snapshot() : agents))
  ipcMain.handle('kimi:setup', () => kimiOnboarding.snapshot())
  ipcMain.handle('agent-setup:get', (_event, id: CliSetupId) => cliAgentSetup.snapshot(id))
  ipcMain.handle('agent-setup:install', (_event, id: CliSetupId) => {
    if (!isCliSetupId(id) || orchestrator.hasActiveAgentSessions(id) || agentLifecycle.isUpdating(id)) throw new Error('请先结束该 Agent 的任务或更新')
    return cliAgentSetup.install(id)
  })
  ipcMain.handle('agent-setup:login', (_event, id: CliSetupId, input: CliSetupInput) => {
    if (!isCliSetupId(id) || orchestrator.hasActiveAgentSessions(id) || agentLifecycle.isUpdating(id)) throw new Error('请先结束该 Agent 的任务或更新')
    return cliAgentSetup.signIn(id, input)
  })
  ipcMain.handle('agent-setup:cancel', (_event, id: CliSetupId) => cliAgentSetup.cancel(id))
  
  ipcMain.handle('agent-setup:reopen', (_event, id: CliSetupId) => cliAgentSetup.reopen(id))
  ipcMain.handle('kimi:cancel-setup', () => kimiOnboarding.cancel())
  for (const [channel, action] of [['kimi:check', 'check'], ['kimi:install', 'install'], ['kimi:sign-in', 'signIn']] as const) {
    ipcMain.handle(channel, async (_event, input?: { region?: 'cn' | 'global'; apiKey?: string }) => {
      if (action !== 'check' && (orchestrator.hasActiveAgentSessions('kimi') || agentLifecycle.isUpdating('kimi'))) throw new Error('Kimi 有任务正在运行，请结束后再安装或登录。')
      const snapshot = await (action === 'signIn' ? kimiOnboarding.signIn(input) : kimiOnboarding[action]())
      await refreshDetectedAgent('kimi')
      return snapshot
    })
  }
  ipcMain.handle('kimi:reopen', () => kimiOnboarding.reopen(url => shell.openExternal(url)))
  ipcMain.handle(DEEPSEEK_IPC.get, () => readDeepSeekConnection())
  ipcMain.handle(DEEPSEEK_IPC.check, async (_event, input: DeepSeekConnectionInput) => {
    if (orchestrator.hasActiveAgentSessions('deepseek')) throw new Error('DeepSeek 有任务正在运行，请结束后再更换连接')
    const snapshot = await checkDeepSeekConnection(input)
    await refreshDetectedAgent('deepseek')
    return snapshot
  })
  ipcMain.handle(DEEPSEEK_IPC.save, async (_event, input: DeepSeekConnectionInput) => {
    if (orchestrator.hasActiveAgentSessions('deepseek')) throw new Error('DeepSeek 有任务正在运行，请结束后再更换连接')
    const snapshot = saveDeepSeekConnection(input)
    await refreshDetectedAgent('deepseek')
    return snapshot
  })
  ipcMain.handle(DEEPSEEK_IPC.install, async () => {
    if (orchestrator.hasActiveAgentSessions('deepseek')) throw new Error('DeepSeek 有任务正在运行，请结束后再安装或更新')
    await installDeepSeek()
    const agent = await refreshDetectedAgent('deepseek')
    if (agent?.incompatible) throw new Error(agent.unavailableReason || 'DeepSeek 安装后验证失败，请重试')
    return readDeepSeekConnection()
  })
  ipcMain.handle(DEEPSEEK_IPC.cancelInstall, () => cancelDeepSeekInstall())
  ipcMain.handle(DEEPSEEK_IPC.signIn, async () => {
    if (orchestrator.hasActiveAgentSessions('deepseek')) throw new Error('DeepSeek 有任务正在运行，请结束后再更换登录')
    const snapshot = await signInDeepSeek()
    await refreshDetectedAgent('deepseek')
    return snapshot
  })
  ipcMain.handle(DEEPSEEK_IPC.cancelSignIn, () => cancelDeepSeekSignIn())
  ipcMain.handle(DEEPSEEK_IPC.reopen, () => reopenDeepSeekSignIn())
  ipcMain.handle(DEEPSEEK_IPC.signOut, async () => {
    if (orchestrator.hasActiveAgentSessions('deepseek')) throw new Error('DeepSeek 有任务正在运行，请结束后再退出登录')
    const snapshot = await signOutDeepSeek()
    await refreshDetectedAgent('deepseek')
    return snapshot
  })
  ipcMain.handle(MCODE_IPC.get, () => mcodeSnapshot())
  ipcMain.handle(MCODE_IPC.check, async (_event, input: MCodeConnectionInput) => {
    if (orchestrator.hasActiveAgentSessions('mcode')) throw new Error('MiniMax Code 有任务正在运行，请结束后再修改连接')
    const snapshot = await checkMCodeConnection(input)
    await refreshDetectedAgent('mcode')
    return snapshot
  })
  ipcMain.handle(MCODE_IPC.signIn, async (_event, region: 'cn' | 'global') => {
    if (orchestrator.hasActiveAgentSessions('mcode')) throw new Error('MiniMax Code 有任务正在运行，请结束后再登录')
    const snapshot = await signInMCode(region, url => shell.openExternal(url))
    await refreshDetectedAgent('mcode')
    return snapshot
  })
  ipcMain.handle(MCODE_IPC.cancel, () => cancelMCodeOperation())
  ipcMain.handle(MCODE_IPC.reopen, () => reopenMCodeSignIn())
  ipcMain.handle(MCODE_IPC.install, async () => {
    const snapshot = await installMCode()
    await refreshDetectedAgent('mcode')
    return snapshot
  })

  ipcMain.handle(IPC.detectAgents, async () => {
    // This IPC is an explicit user/test re-detection and intentionally retains
    // the complete contract. Renderer bootstrap uses getLifecycleSnapshot(),
    // which only waits for the fast core phase.
    await refreshDetectedAgents('Agent 重新检测完成')
    const available = new Set(agents.filter((agent) =>
      agent.lifecycle?.availability === 'available'
    ).map((agent) => agent.id))
    orchestrator.resumePendingQueues(available)
    // A successful explicit full detection repairs either failed startup
    // barrier and supersedes its older generation. The queue tails above are
    // installed before callers are released through these resolved barriers.
    startupCoreReady = Promise.resolve(agents)
    startupProtocolSettled = Promise.resolve(agents)
    restartConfiguredFeishuBridges()
    return agents
  })
  ipcMain.handle(IPC.getLifecycleSnapshot, async () => {
    if (e2eLifecycleAgents) return e2eLifecycleAgents
    const core = startupCoreReady
    if (core) await core
    return agentLifecycle.snapshot()
  })
  ipcMain.handle(IPC.detectAgent, async (_event, agentId: string) => {
    if (typeof agentId !== 'string') throw new Error('invalid_agent_id')
    return refreshDetectedAgent(agentId)
  })
  ipcMain.handle(IPC.e2eLifecycleFixture, (_event, mode: 'mixed' | 'zero' | 'same-version' = 'mixed') => {
    if (!e2eEnabled) throw new Error('e2e_disabled')
    const base = agents.length ? agents : agentLifecycle.snapshot()
    e2eLifecycleAgents = base.map((agent) => {
      const availability = mode === 'zero'
        ? (agent.id === 'traex' ? 'needs-auth' : 'not-installed')
        : (agent.id === 'codex' || agent.id === 'claude' || mode === 'same-version' && agent.id === 'traex')
          ? 'available'
          : agent.id === 'traex' ? 'needs-auth' : 'not-installed'
      return {
        ...agent,
        installed: availability !== 'not-installed',
        lifecycle: {
          availability,
          auth: availability === 'available' ? 'authenticated' : availability === 'needs-auth' ? 'required' : 'unknown',
          health: availability === 'available' ? 'healthy' : 'unknown',
          selfUpdateSupported: agent.id === 'claude' && availability === 'available' ? true : undefined,
          updateStatus: agent.id === 'codex' && mode !== 'zero' ? 'available' : mode === 'same-version' && agent.id === 'traex' ? 'current' : 'idle',
          currentVersion: agent.id === 'codex' ? '1.0.0' : agent.id === 'traex' && mode === 'same-version' ? '0.201.6-alpha.4' : undefined,
          availableVersion: agent.id === 'codex' ? '1.1.0' : agent.id === 'traex' && mode === 'same-version' ? '0.201.6-alpha.4' : undefined,
          checkedAt: Date.now()
        }
      } satisfies AgentDef
    })
    return e2eLifecycleAgents
  })
  ipcMain.handle(IPC.e2eLifecycleUpdateGuard, async () => {
    if (!e2eEnabled) throw new Error('e2e_disabled')
    try { await agentLifecycle.updateOne('codex', () => true); return 'unexpected_update' }
    catch (error) { return error instanceof Error ? error.message : 'unknown' }
  })
  ipcMain.handle(IPC.e2eLastResponse, () => (e2eEnabled ? e2eLastResponse : null))
  ipcMain.handle(IPC.e2eLastTokenUsageQuery, () => (e2eEnabled ? e2eLastTokenUsageQuery : null))
  ipcMain.handle(IPC.e2eTokenUsageRequestCount, () => (e2eEnabled ? e2eTokenUsageRequestCount : 0))
  // Fix#4 — flag/clear a session's waitingForHandoff and push the real
  // sessionUpdated so the「等待 X 的 Y」status line + jump can be CDP-verified.
  ipcMain.handle(IPC.e2eSetWaitingForHandoff, (_event, sessionId: string, info) => {
    if (!e2eEnabled) throw new Error('e2e_disabled')
    const session = orchestrator.getSessionById(sessionId)
    if (!session) return false
    session.waitingForHandoff = info || undefined
    mainWindow?.webContents.send(IPC.sessionUpdated, { session, hasLiveStreamer: false })
    return true
  })
  ipcMain.handle(IPC.checkAgentUpdate, async (_event, agentId: string) => {
    if (typeof agentId !== 'string') throw new Error('invalid_agent_id')
    await awaitAgentReady(agentId)
    const result = await agentLifecycle.checkUpdate(agentId)
    agents = agentLifecycle.snapshot()
    publishHandoffCatalog()
    return result
  })
  ipcMain.handle(IPC.updateAgent, async (_event, agentId: string) => {
    if (typeof agentId !== 'string') throw new Error('invalid_agent_id')
    if (cliAgentSetup.busy(agentId) || agentId === 'kimi' && kimiOnboarding.busy) throw new Error('请先完成或取消该 Agent 的安装与登录')
    await awaitAgentReady(agentId)
    try {
      return await agentLifecycle.updateOne(agentId, (id) => orchestrator.hasActiveAgentSessions(id))
    } finally {
      agents = agentLifecycle.snapshot()
      publishHandoffCatalog()
    }
  })
  ipcMain.handle(IPC.initializationFinished, async (_event, targetAgentId: string) => {
    if (typeof targetAgentId !== 'string') throw new Error('invalid_agent_id')
    agents = await agentLifecycle.detectAll(true)
    publishHandoffCatalog()
    restartConfiguredFeishuBridges()
    const target = agents.find((agent) => agent.id === targetAgentId)
    return { agents, success: target?.lifecycle?.availability === 'available' }
  })
  ipcMain.handle(IPC.capabilitySyncScan, (event, value: unknown) =>
    capabilitySyncIpc(event, async () => publicCapabilityScan(await capabilitySync.scan(parseCapabilityScanRequest(value))))
  )
  ipcMain.handle(IPC.getNativeCapabilities, async (event, value: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    const request = parseNativeCapabilityRequest(value)
    await awaitAgentReady(request.agentId)
    const agent = agents.find((item) => item.id === request.agentId)
    if (!agent) throw new Error(`未找到 Agent: ${request.agentId}`)
    return nativeCapabilityService.discover(
      resolveNativeCapabilityAgent(agent, request, (sessionId) => orchestrator.getSessionById(sessionId)),
      request.workdir,
      request.force,
      [],
      request.sessionId
    )
  })
  ipcMain.handle(
    IPC.createNativeActionSession,
    async (event, config: SessionConfig, value: unknown) => {
      assertTrustedCapabilitySyncIpc(event)
      if (
        !config || typeof config !== 'object' ||
        typeof config.agentId !== 'string' || !config.agentId.trim() ||
        typeof config.workdir !== 'string' || !config.workdir.trim()
      ) {
        throw new Error('invalid_native_action_config')
      }
      const action: NativeThreadAction = parseNativeThreadAction(value)
      if (action.type !== 'goal.set' && action.type !== 'review.start') throw new Error('新会话只支持设置 Goal 或启动 Review')
      await awaitAgentReady(config.agentId)
      if (agentLifecycle.isUpdating(config.agentId)) throw new Error('agent_update_in_progress')
      return createWorkspaceSession(await personalAssistant.prepareConfig(config), action.type === 'goal.set' ? action.objective : 'Review', (runtime, reservedId) =>
        orchestrator.createNativeActionSession(runtime, action, undefined, reservedId), { kind: 'native', action })
    }
  )
  handleUserSessionMutation(
    IPC.runNativeAction,
    async (event, sessionId: unknown, value: unknown) => {
      assertTrustedCapabilitySyncIpc(event)
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new Error('invalid_native_action_session')
      }
      const action = parseNativeThreadAction(value)
      await awaitSessionAgentReady(sessionId)
      await prepareWorktreeDraft(sessionId)
      const session = orchestrator.getSessionById(sessionId)
      if (session && agentLifecycle.isUpdating(session.config.agentId)) {
        throw new Error('agent_update_in_progress')
      }
      return orchestrator.runNativeAction(sessionId, action)
    }
  )
  ipcMain.handle(IPC.capabilitySyncPlan, (event, value: unknown) =>
    capabilitySyncIpc(event, () => publicCapabilityPlan(capabilitySync.plan(parseCapabilityPlanRequest(value))))
  )
  ipcMain.handle(IPC.capabilitySyncExecute, (event, value: unknown) =>
    capabilitySyncIpc(event, () => publicCapabilitySyncJob(capabilitySync.execute(parseCapabilityExecuteRequest(value))))
  )
  ipcMain.handle(IPC.capabilityInventoryList, (event) =>
    capabilitySyncIpc(event, () => listManagedInventories())
  )
  ipcMain.handle(IPC.capabilityInventoryDetail, (event, value: unknown) =>
    capabilitySyncIpc(event, async () => {
      const input = value as { id?: unknown }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'id') || typeof input.id !== 'string' || input.id.length === 0 || input.id.length > 512) throw new Error('invalid_selection')
      if (input.id.startsWith('grok:')) {
        const grok = agents.find(agent => agent.adapter === 'grok')
        if (!grok) throw new Error('capability_inventory_unavailable')
        if (!input.id.startsWith('grok:files:')) return getGrokInventoryDetail(grok.bin,input.id,grokInventoryOptions())
      }
      return getAgentToolDetail(input.id, agentToolInventoryOptions())
    })
  )
  ipcMain.handle(IPC.capabilityInventoryManage, (event, value: unknown) =>
    capabilitySyncIpc(event, async () => {
      const result = await manageAgentToolInventory(value, agentToolInventoryOptions())
      mainWindow?.webContents.send(IPC.capabilityInventoryChanged)
      return result
    })
  )
  ipcMain.handle(IPC.capabilityInventoryPrepareSync, (event, value: unknown) =>
    capabilitySyncIpc(event, async (): Promise<CapabilityInventorySyncPreparation> => {
      const prepared = await capabilitySync.prepareInventorySelection(parseCapabilityInventorySyncRequest(value))
      return { scan: publicCapabilityScan(prepared.scan), selections: [...prepared.selections] }
    })
  )
  ipcMain.handle(IPC.capabilityMutationPlanRemove, (event, value: unknown) =>
    capabilitySyncIpc(event, () => {
      const input = value as { target?: unknown; selections?: unknown }
      if (!input || !['codex', 'traex'].includes(String(input.target)) || !Array.isArray(input.selections) ||
          input.selections.length > 1000 || input.selections.some((id) => typeof id !== 'string')) throw new Error('invalid_selection')
      return capabilitySync.planRemoval(input.target as 'codex' | 'traex', input.selections as string[]).then(publicCapabilityPlan)
    })
  )
  ipcMain.handle(IPC.capabilityPluginAction, (event, value: unknown) =>
    capabilitySyncIpc(event, async () => {
      const request = parseCapabilityPluginActionRequest(value)
      if (!isDistributionAgent(request.id.split(':')[0]) || request.targetAgentId && !isDistributionAgent(request.targetAgentId)) throw new Error('capability_provider_unavailable')
      if (/^(?:kimi|grok):/.test(request.id)) throw new Error('invalid_capability_inventory_manage_request')
      const result = await executePluginAction(process.env.UNIAGENT_CAPABILITY_HOME || homedir(), request)
      mainWindow?.webContents.send(IPC.capabilityInventoryChanged)
      return result
    })
  )
  ipcMain.handle(IPC.capabilitySkillLinkRemove, (event, value: unknown) =>
    capabilitySyncIpc(event, async () => {
      const input = value as { id?: unknown; agentId?: unknown; expectedFingerprint?: unknown }
      if (!input || Object.keys(input).some((key) => !['id', 'agentId', 'expectedFingerprint'].includes(key)) || typeof input.id !== 'string' || input.id.length === 0 || input.id.length > 512 ||
          !agents.some(agent => agent.builtin && agent.id === input.agentId) || input.expectedFingerprint !== undefined &&
          (typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint))) throw new Error('invalid_selection')
      await removeAgentToolSkill(input.id, input.agentId as CapabilityAgentId, input.expectedFingerprint as string | undefined, agentToolInventoryOptions())
      mainWindow?.webContents.send(IPC.capabilityInventoryChanged)
      return { agentId: input.agentId, name: '' }
    })
  )
  ipcMain.handle(IPC.capabilitySyncGetJob, (event, value: unknown) =>
    capabilitySyncIpc(event, () => publicCapabilitySyncJob(capabilitySync.getJob(parseCapabilityJobRequest(value).jobId)))
  )
  ipcMain.handle(CAPABILITY_SYNC_JOB_SNAPSHOT_CHANNEL, (event) =>
    capabilitySyncIpc(event, () => {
      const snapshot = capabilitySync.getJobSnapshot()
      return {
        active: publicCapabilitySyncJob(snapshot.active),
        latest: publicCapabilitySyncJob(snapshot.latest),
        rollbackCandidate: publicCapabilityRollbackCandidate(snapshot.rollbackCandidate)
      }
    })
  )
  ipcMain.handle(IPC.capabilitySyncCancel, (event, value: unknown) =>
    capabilitySyncIpc(event, () => publicCapabilitySyncJob(capabilitySync.cancel(parseCapabilityCancelRequest(value).jobId)))
  )
  ipcMain.handle(IPC.capabilitySyncRollback, (event, value: unknown) =>
    capabilitySyncIpc(event, async () => publicCapabilitySyncJob(await capabilitySync.rollback(parseCapabilityRollbackRequest(value).transactionId)))
  )
  ipcMain.handle(IPC.capabilitySyncPreview, (event, value: unknown) =>
    capabilitySyncIpc(event, async () => {
      const request = parseCapabilityPreviewDto(value)
      const preview = await capabilitySync.getMarkdownPreview(request.scanId, request.itemId, request.strategy)
      return {
        itemId: 'global-instructions:agents' as const,
        lineCount: preview.lineCount,
        headingCount: preview.headingCount,
        byteCount: preview.byteCount
      }
    })
  )

  ipcMain.handle(ASSISTANT_IPC.detail, async event => { assertTrustedCapabilitySyncIpc(event); return personalAssistant.store.detail() })
  ipcMain.handle(ASSISTANT_IPC.workspace, async event => { assertTrustedCapabilitySyncIpc(event); return personalAssistant.workspace() })
  ipcMain.handle(ASSISTANT_IPC.feishu, event => { assertTrustedCapabilitySyncIpc(event); return assistantFeishuState() })
  ipcMain.handle(WEIXIN_IPC.state, event => { assertTrustedCapabilitySyncIpc(event); return assistantWeixinBridge.getState() })
  ipcMain.handle(WEIXIN_IPC.login, async event => { assertTrustedCapabilitySyncIpc(event); await awaitSessionHydration(); return assistantWeixinBridge.login() })
  ipcMain.handle(WEIXIN_IPC.verify, (event, code: string) => { assertTrustedCapabilitySyncIpc(event); return assistantWeixinBridge.verify(code) })
  ipcMain.handle(WEIXIN_IPC.disconnect, event => { assertTrustedCapabilitySyncIpc(event); return assistantWeixinBridge.disconnect() })
  ipcMain.handle(ASSISTANT_IPC.privateSessions, async event => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    return [...assistantFeishuBridge.getAssistantPrivateSessions().map(link => link.sessionId),
      ...(assistantWeixinBridge.getState().sessionId ? [assistantWeixinBridge.getState().sessionId!] : [])]
  })
  ipcMain.handle(ASSISTANT_IPC.installFeishu, async event => {
    assertTrustedCapabilitySyncIpc(event)
    if (isQuitting) throw new Error('应用正在退出')
    if (assistantFeishuInstaller || assistantFeishuManualBinding || appSettings.get().assistantFeishu?.appId) return assistantFeishuState()
    const installer = new FeishuInstaller({
      onProgress: progress => {
        if (assistantFeishuInstaller !== installer) return
        assistantFeishuInstallProgress = progress
        mainWindow?.webContents.send(ASSISTANT_IPC.feishuChanged)
      },
      persist: (appId,appSecret,signal) => saveFeishuCredentials('assistantFeishu', { appId,appSecret }, signal),
      startBridge: () => startFeishuBridgeWhenReady(assistantFeishuBridge)
    })
    assistantFeishuInstaller = installer
    const flight = installer.installFromBrowser()
    assistantFeishuInstallFlight = flight
    try { await flight }
    catch (error) {
      const message = error instanceof Error ? error.message : '配置失败，请重试'
      assistantFeishuBridge.setPhase(message === '已取消配置' ? 'idle' : 'failed', message === '已取消配置' ? undefined : message)
      throw error
    }
    finally {
      if (assistantFeishuInstaller === installer) {
        assistantFeishuInstaller = undefined; assistantFeishuInstallFlight = undefined; assistantFeishuInstallProgress = undefined
        mainWindow?.webContents.send(ASSISTANT_IPC.feishuChanged)
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
    return assistantFeishuState()
  })
  ipcMain.handle(ASSISTANT_IPC.cancelFeishuInstall, async event => {
    assertTrustedCapabilitySyncIpc(event)
    if (assistantFeishuInstallProgress?.phase === 'awaiting-login') return assistantFeishuState()
    assistantFeishuInstaller?.cancel()
    await assistantFeishuInstallFlight?.catch(() => {})
    return assistantFeishuState()
  })
  ipcMain.handle(ASSISTANT_IPC.bindFeishu, async (event, input: import('../shared/assistant').AssistantFeishuInput | null) => {
    assertTrustedCapabilitySyncIpc(event)
    if (assistantFeishuInstaller || assistantFeishuManualBinding) throw new Error('请先完成或取消机器人配置')
    if (input === null) {
      await assistantFeishuBridge.stop()
      appSettings.set({ assistantFeishu: null })
      if (appSettings.get().assistantFeishu) throw new Error('解绑未能保存，请重试')
      assistantFeishuBridge.setPhase('idle')
    } else {
      if (appSettings.get().assistantFeishu?.appId) throw new Error('请先断开当前机器人再重新配置')
      assistantFeishuManualBinding = true
      assistantFeishuInstallProgress = { phase: 'awaiting-login', message: '正在验证机器人并连接…' }
      mainWindow?.webContents.send(ASSISTANT_IPC.feishuChanged)
      try {
        await saveFeishuCredentials('assistantFeishu', input)
        await startFeishuBridgeWhenReady(assistantFeishuBridge)
      } finally {
        assistantFeishuManualBinding = false
        assistantFeishuInstallProgress = undefined
        mainWindow?.webContents.send(ASSISTANT_IPC.feishuChanged)
      }
    }
    mainWindow?.webContents.send(ASSISTANT_IPC.feishuChanged)
    return assistantFeishuState()
  })
  ipcMain.handle(ASSISTANT_IPC.save, async (event, input: AssistantInput, edits: DocumentEdit[]) => { assertTrustedCapabilitySyncIpc(event); return personalAssistant.save(input, edits) })
  ipcMain.handle(ASSISTANT_IPC.versions, async (event, type: AssistantDocumentType) => { assertTrustedCapabilitySyncIpc(event); return personalAssistant.store.versions(type) })
  ipcMain.handle(ASSISTANT_IPC.rollback, async (event, type: AssistantDocumentType, revision: number, expectedRevision: number) => {
    assertTrustedCapabilitySyncIpc(event)
    await personalAssistant.invalidate()
    const value = await personalAssistant.store.rollback(type, revision, expectedRevision)
    mainWindow?.webContents.send(ASSISTANT_IPC.changed)
    return value
  })
  handleUserSessionMutation(ASSISTANT_IPC.command, async (event, sessionId: string, command: 'new' | 'clear', requestId: string) => {
    assertTrustedCapabilitySyncIpc(event)
    return assistantWeixinBridge.owns(sessionId)
      ? assistantWeixinBridge.executeCommandFromApp(sessionId, command, requestId)
      : assistantFeishuBridge.executeAssistantCommandFromApp(sessionId, command, requestId)
  })

  ipcMain.handle(
    IPC.createSession,
    async (
      event,
      config: SessionConfig,
      prompt: string,
      attachments?: Attachment[],
      value?: unknown,
      activatePlan?: boolean
    ) => {
      assertTrustedCapabilitySyncIpc(event)
      const assistantConfig = await personalAssistant.prepareConfig(config)
      const effectiveConfig = activatePlan === true
        ? { ...assistantConfig, collaborationMode: 'plan' as const }
        : assistantConfig
      const selection = parseNativeTurnSelectionRequest(value)
      return createWorkspaceSession(effectiveConfig, prompt, async (runtimeConfig, reservedSessionId) => {
        if (agentLifecycle.isUpdating(runtimeConfig.agentId)) throw new Error('agent_update_in_progress')
        if (runtimeConfig.initializationTargetAgentId && (runtimeConfig.permissionMode !== 'ask' || runtimeConfig.initializationTargetAgentId === runtimeConfig.agentId)) {
          throw new Error('invalid_initialization_config')
        }
        const jobId = runtimeConfig.initializationTargetAgentId ? appSettings.beginInitialization(runtimeConfig.initializationTargetAgentId) : undefined
        try {
          const nativeContext = await resolveNativeTurnSelection(runtimeConfig.agentId, runtimeConfig.workdir, selection).catch(error => {
            if (runtimeConfig.worktree && selection?.candidateIds.length) throw new Error('工作树已创建，请在新目录重新选择技能或插件后发送')
            throw error
          })
          if (requirements.get(runtimeConfig.requirementId)?.status === 'archived') {
            throw new Error('所选需求已归档，请先恢复需求或重新选择')
          }
          if (runtimeConfig.requirementId && !isRequirementsEnabled()) {
            throw new Error('需求功能已停用')
          }
          // Persist jobId in SessionConfig before Orchestrator dispatches the first turn.
          // A very fast terminal event can therefore settle the durable job even if
          // attachInitialization has not written its secondary session index yet.
          const session = orchestrator.createSession(
            jobId ? { ...runtimeConfig, initializationJobId: jobId } : runtimeConfig,
            prompt,
            attachments,
            undefined,
            nativeContext,
            activatePlan === true ? 'plan' : undefined,
            undefined,
            reservedSessionId
          )
          if (jobId) appSettings.attachInitialization(jobId, session.id)
          return session
        } catch (error) {
          if (jobId) appSettings.settleInitialization(jobId, false)
          throw error
        }
      }, { kind: 'message', prompt, attachments, selection, activatePlan: activatePlan === true })
    }
  )

  handleUserSessionMutation(
    IPC.sendMessage,
    async (_e, sessionId: string, prompt: string, attachments?: Attachment[], value?: unknown, activatePlan?: boolean, bubble?: TurnBubbleInput) => {
      await awaitSessionAgentReady(sessionId)
      await prepareWorktreeDraft(sessionId)
      const session = orchestrator.listSessions().find((item) => item.id === sessionId)
      if (session && agentLifecycle.isUpdating(session.config.agentId)) throw new Error('agent_update_in_progress')
      const selection = parseNativeTurnSelectionRequest(value)
      const nativeContext = session
        ? await resolveNativeTurnSelection(session.config.agentId, session.config.workdir, selection, session.id)
        : undefined
      return orchestrator.sendMessage(sessionId, prompt, attachments, nativeContext, activatePlan === true, sanitizeTurnBubble(bubble))
    }
  )

  handleUserSessionMutation(
    IPC.setCollaborationMode,
    async (event, sessionId: string, mode: CollaborationModeId) => {
      assertTrustedCapabilitySyncIpc(event)
      if (
        typeof sessionId !== 'string' || !sessionId ||
        (mode !== 'default' && mode !== 'plan')
      ) throw new Error('invalid_collaboration_mode')
      await awaitSessionAgentReady(sessionId)
      return orchestrator.setCollaborationMode(sessionId, mode)
    }
  )

  handleUserSessionMutation(
    IPC.forceSend,
    async (_e, sessionId: string, prompt: string, attachments?: Attachment[], value?: unknown, bubble?: TurnBubbleInput) => {
      await awaitSessionAgentReady(sessionId)
      await prepareWorktreeDraft(sessionId)
      const session = orchestrator.listSessions().find((item) => item.id === sessionId)
      const selection = parseNativeTurnSelectionRequest(value)
      const nativeContext = session
        ? await resolveNativeTurnSelection(session.config.agentId, session.config.workdir, selection, session.id)
        : undefined
      return orchestrator.forceSend(sessionId, prompt, attachments, nativeContext, sanitizeTurnBubble(bubble))
    }
  )

  handleUserSessionMutation(IPC.dequeue, async (_e, sessionId: string, itemId: string) => {
    await awaitSessionHydration()
    orchestrator.dequeue(sessionId, itemId)
  })

  handleUserSessionMutation(IPC.promoteQueueItem, async (_e, sessionId: string, itemId: string) => {
    await awaitSessionHydration()
    orchestrator.promoteQueueItem(sessionId, itemId)
  })

  handleUserSessionMutation(
    IPC.editQueueItem,
    async (_e, sessionId: string, itemId: string, prompt: string, attachments?: Attachment[], value?: unknown, bubble?: TurnBubbleInput) => {
      await awaitSessionHydration()
      const session = orchestrator.listSessions().find((item) => item.id === sessionId)
      const selection = parseNativeTurnSelectionRequest(value)
      const nativeContext = session
        ? await resolveNativeTurnSelection(session.config.agentId, session.config.workdir, selection, session.id)
        : undefined
      const ownedAttachments = session?.config.agentId === 'grok' ? await prepareGrokAttachments(attachments) : attachments
      orchestrator.editQueueItem(sessionId, itemId, prompt, ownedAttachments, nativeContext, sanitizeTurnBubble(bubble))
    }
  )

  handleUserSessionMutation(IPC.setQueueEditing, async (_e, sessionId: string, itemId: string | null) => {
    await awaitSessionHydration()
    orchestrator.setQueueEditing(sessionId, typeof itemId === 'string' ? itemId : null)
  })

  handleUserSessionMutation(IPC.interrupt, async (_e, sessionId: string) => {
    await awaitSessionHydration()
    if (orchestrator.getSessionById(sessionId)?.teamBinding) { const { p } = teams.binding(sessionId); teams.stop(p.id) }
    else orchestrator.interrupt(sessionId)
  })

  ipcMain.handle(IPC.listSessions, async () => {
    await awaitSessionHydration()
    return orchestrator.listSessions()
  })
  ipcMain.handle(REQUIREMENT_IPC.list, event => {
    assertTrustedCapabilitySyncIpc(event)
    // 关闭时返回空列表（不抛错）：useRequirements 无条件调用，抛错会点亮错误横幅。
    return isRequirementsEnabled() ? requirements.list() : []
  })
  ipcMain.handle(REQUIREMENT_IPC.create, (event, input: RequirementInput) => {
    assertTrustedCapabilitySyncIpc(event)
    if (!isRequirementsEnabled()) throw new Error('需求功能已停用')
    return requirements.create(input)
  })
  ipcMain.handle(REQUIREMENT_IPC.update, async (event, id: string, patch: RequirementPatch) => {
    assertTrustedCapabilitySyncIpc(event)
    if (!isRequirementsEnabled()) throw new Error('需求功能已停用')
    await awaitSessionHydration()
    if (!patch || typeof patch !== 'object') throw new Error('需求更新无效')
    const assertRenameIdle = (): void => {
      if (orchestrator.listSessions().some(s => s.config.requirementId === id && ['running', 'queued', 'awaiting-approval', 'cancelling'].includes(s.status))) {
        throw new Error('需求仍有运行中或排队中的会话，请结束后再改名')
      }
    }
    if (patch.name !== undefined) assertRenameIdle()
    return requirements.update(id, patch, assertRenameIdle)
  })
  ipcMain.handle(REQUIREMENT_IPC.openDir, async (event, id: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (!isRequirementsEnabled()) throw new Error('需求功能已停用')
    const r = requirements.get(id)
    if (!r) throw new Error('需求不存在')
    const error = await shell.openPath(r.dir)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.listProjects, (event) => { assertTrustedCapabilitySyncIpc(event); return projects.list() })
  ipcMain.handle(IPC.getProjectGitInfo, async (event, projectId: string, requestId?: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof projectId !== 'string' || (requestId !== undefined && !isUuid(requestId))) throw new Error('无效的空间查询')
    const project = projects.get(projectId)
    if (!project) throw new Error('空间不存在')
    const info = await worktrees.inspect(project)
    if (requestId) {
      const tree = orchestrator.listSessions().find(session => session.config.projectId === projectId && session.config.worktree?.creationRequestId === requestId)?.config.worktree ||
        teams.catalog().projects.find(team => team.spaceId === projectId && team.worktree?.creationRequestId === requestId)?.worktree
      if (tree) info.pendingWorktree = { ...tree }
    }
    return info
  })
  const listWorktrees = async (projectId: string) => {
    const project = projects.get(projectId)
    if (!project) throw new Error('空间不存在')
    const sessions = orchestrator.managedSessions()
    const teamProjects = teams.catalog().projects
    const saved = [...sessions.map(session => session.config.worktree), ...teamProjects.map(team => team.worktree)]
      .filter((tree): tree is NonNullable<typeof tree> => !!tree && tree.projectId === projectId)
    const rows = await worktrees.list(project, saved)
    for (const row of rows) {
      const associated = sessions.filter(session => sessionUsesWorktree(row.path, session.config))
      row.sessions = associated.map(session => ({ id: session.id, title: session.title }))
      if (associated.some(session => orchestrator.worktreeSessionBusy(session)) || teams.worktreeBusy(row.path)) {
        row.state = 'busy'; row.removalBlockedReason = '工作树仍有运行或待执行任务'
      }
      if (projects.list().some(space => space.id !== projectId && sessionUsesWorktree(row.path, { workdir: space.primaryDirectory }))) {
        row.removalBlockedReason = '该目录也是其他空间的主目录，不能删除'
      }
    }
    return rows
  }
  ipcMain.handle(IPC.listProjectWorktrees, async (event, projectId: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof projectId !== 'string') throw new Error('无效的空间查询')
    await awaitSessionHydration()
    return listWorktrees(projectId)
  })
  ipcMain.handle(IPC.openProjectWorktree, async (event, projectId: string, path: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof projectId !== 'string' || typeof path !== 'string') throw new Error('无效的工作树')
    const row = (await listWorktrees(projectId)).find(tree => tree.path === path)
    if (!row || ['missing', 'failed', 'creating'].includes(row.state)) throw new Error('工作树目录不可用')
    const error = await shell.openPath(row.path)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.removeProjectWorktree, async (event, projectId: string, path: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof projectId !== 'string' || typeof path !== 'string' || !isAbsolute(path)) throw new Error('无效的工作树')
    await awaitSessionHydration()
    if (worktreeProjectChanges.has(projectId)) throw new Error('空间正在清理工作树，请稍后再操作')
    const release = worktrees.lockRemoval(path)
    const lockedProjects = new Set([projectId])
    worktreeProjectChanges.add(projectId)
    try {
      const row = (await listWorktrees(projectId)).find(tree => tree.path === path)
      if (!row) throw new Error('工作树已不存在，请刷新列表')
      if (row.removalBlockedReason) throw new Error(row.removalBlockedReason)
      const associated = orchestrator.managedSessions().filter(session => sessionUsesWorktree(path, session.config))
      for (const session of associated) if (session.config.projectId) {
        if (session.config.projectId !== projectId && worktreeProjectChanges.has(session.config.projectId)) throw new Error('关联空间正在清理工作树，请稍后再操作')
        lockedProjects.add(session.config.projectId)
        worktreeProjectChanges.add(session.config.projectId)
      }
      await orchestrator.assertWorktreeSessionsIdle(associated)
      const replacements = new Map(associated.map(session => {
        const { worktree: _worktree, ...config } = session.config
        return [session.id, resolveSessionConfig(config, true)]
      }))
      if (teams.worktreeBusy(path) || associated.some(session => orchestrator.worktreeSessionBusy(session))) throw new Error('工作树仍有运行任务')
      await orchestrator.returnWorktreeSessions(associated, session => replacements.get(session.id)!, '原工作树已解除关联，当前使用原空间主目录。', async () => {
        const restoreTeams = teams.returnWorktree(path)
        try { await worktrees.remove(projects.get(projectId)!, path) }
        catch (error) { restoreTeams(); throw error }
      })
      return listWorktrees(projectId)
    } finally { release(); for (const id of lockedProjects) worktreeProjectChanges.delete(id) }
  })
  ipcMain.handle(IPC.retryWorktreeTask, async (event, sessionId: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof sessionId !== 'string') throw new Error('无效的会话')
    await awaitSessionHydration()
    orchestrator.assertUserSessionEnabled(sessionId)
    const session = orchestrator.getSessionById(sessionId)
    if (!session?.config.worktree) throw new Error('没有待创建的工作树任务')
    if (session.teamBinding) { void teams.prepareWorktreeProject(session.teamBinding.teamProjectId); return }
    if (!session.worktreeTask) return prepareWorktreeDraft(sessionId)
    void runWorktreeTask(sessionId)
  })
  ipcMain.handle(IPC.createProject, (event, input: ProjectInput): Project => {
    assertTrustedCapabilitySyncIpc(event)
    assertWorktreeNotRemoving({ workdir: input.primaryDirectory })
    const project = projects.create(input)
    publishHandoffCatalog()
    return project
  })
  ipcMain.handle(IPC.updateProject, async (event, id: string, input: ProjectInput): Promise<Project> => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    if (worktreeProjectChanges.has(id)) throw new Error('空间正在清理工作树，请稍后编辑')
    assertWorktreeNotRemoving({ workdir: input.primaryDirectory })
    const current = projects.get(id)
    if (!current) throw new Error('project_not_found')
    const directoriesChanged = current.primaryDirectory !== input.primaryDirectory ||
      JSON.stringify(current.additionalDirectories) !== JSON.stringify(input.additionalDirectories)
    if (current.primaryDirectory !== input.primaryDirectory &&
        (orchestrator.listSessions().some(session => session.config.projectId === id && session.config.worktree) || teams.catalog().projects.some(team => team.spaceId === id && team.worktree))) {
      throw new Error('空间仍有工作树会话，请先处理相关会话再修改主目录')
    }
    if (directoriesChanged && teams.catalog().projects.some(p => p.spaceId === id && !p.archivedAt)) throw new Error('space_has_team_projects')
    if (directoriesChanged && projectHasActiveSession(id)) throw new Error('project_has_active_sessions')
    const updated = projects.update(id, input)
    const runtime = projects.resolveSessionConfig({ agentId: '', projectId: id, workdir: '' })
    orchestrator.reassignProject(id, runtime)
    publishHandoffCatalog()
    return updated
  })
  ipcMain.handle(IPC.deleteProject, async (event, id: string): Promise<Project[]> => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    if (worktreeProjectChanges.has(id)) throw new Error('空间正在清理工作树，请稍后删除')
    if (id === DEFAULT_PROJECT_ID) throw new Error('default_project_cannot_delete')
    if (teams.catalog().projects.some(p => p.spaceId === id && !p.archivedAt)) throw new Error('space_has_team_projects')
    if (!projects.get(id)) throw new Error('project_not_found')
    if (orchestrator.listSessions().some(session => session.config.projectId === id && session.config.worktree) || teams.catalog().projects.some(team => team.spaceId === id && team.worktree)) {
      throw new Error('空间仍有工作树会话，不能删除')
    }
    if (projectHasActiveSession(id)) throw new Error('project_has_active_sessions')
    const fallback = projects.resolveSessionConfig({ agentId: '', projectId: DEFAULT_PROJECT_ID, workdir: '' })
    orchestrator.reassignProject(id, fallback)
    const settings = appSettings.get()
    if (settings.feishu?.defaultProjectId === id) {
      appSettings.set({ feishu: { defaultProjectId: DEFAULT_PROJECT_ID } })
    }
    for (const role of projectRoles()) {
      if (role.projectId === id) roles.save({ ...role, projectId: DEFAULT_PROJECT_ID })
    }
    await requirements.clearProjectBindings(id)
    projects.delete(id)
    publishHandoffCatalog()
    return projects.list()
  })
  ipcMain.handle(IPC.listQueues, async () => {
    await awaitSessionHydration()
    return orchestrator.listQueues()
  })

  ipcMain.handle(IPC.getEvents, async (_e, sessionId: string) => {
    await awaitSessionAgentReady(sessionId)
    const events = await orchestrator.getEvents(sessionId)
    personalAssistant.indexEvents(sessionId, events)
    return events
  })
  ipcMain.handle(ZCODE_IPC.runtimeSnapshot, () => getZCodeRuntimeSnapshot())
  ipcMain.handle(ZCODE_IPC.installation, () => zcodeInstallation.snapshot())
  ipcMain.handle(ZCODE_IPC.cancelInstall, () => zcodeInstallation.cancel())
  ipcMain.handle(ZCODE_IPC.selectRuntime, async () => {
    const checkBusy = () => {
      if (zcodeInstallation.isBusy() || zcodeConfiguration.isBusy() || agentLifecycle.isUpdating('zcode') || orchestrator.hasActiveAgentSessions('zcode')) throw new Error('请先结束 ZCode 任务、安装、更新或配置检测')
    }
    checkBusy()
    const picked = await dialog.showOpenDialog({ title: '选择完整 ZCode CLI 程序', properties: ['openFile'] })
    if (picked.canceled || !picked.filePaths[0]) return null
    checkBusy()
    const result = await zcodeInstallation.select(picked.filePaths[0], async () => {
      if (zcodeConfiguration.isBusy() || agentLifecycle.isUpdating('zcode')) throw new Error('ZCode 配置已变化，请稍后重试')
      await orchestrator.prepareZCodeRuntimeUpdate()
    })
    await refreshDetectedAgent('zcode')
    return result
  })
  ipcMain.handle(ZCODE_IPC.install, async () => {
    await awaitAgentReady('zcode')
    if (zcodeConfiguration.isBusy() || agentLifecycle.isUpdating('zcode') || orchestrator.hasActiveAgentSessions('zcode')) {
      const trace = new ZCodeSetupTrace('installation', reportZCodeSetup)
      trace.stage(zcodeConfiguration.isBusy() ? 'configuration_busy' : agentLifecycle.isUpdating('zcode') ? 'update_busy' : 'active_session')
      trace.fail('busy')
      throw new Error('请先结束 ZCode 任务、更新或配置检测，再安装')
    }
    const result = await zcodeInstallation.install(async () => {
      if (zcodeConfiguration.isBusy() || agentLifecycle.isUpdating('zcode')) throw new Error('ZCode 配置或更新正在进行，请稍后重试')
      await orchestrator.prepareZCodeRuntimeUpdate()
    })
    if (result.phase === 'completed') await refreshDetectedAgent('zcode')
    return result
  })
  ipcMain.handle(ZCODE_IPC.configuration, () => zcodeConfiguration.snapshot())
  ipcMain.handle(ZCODE_IPC.checkConfiguration, async (_event, input: unknown) => {
    await awaitAgentReady('zcode')
    if (zcodeInstallation.isBusy() || agentLifecycle.isUpdating('zcode') || orchestrator.hasActiveAgentSessions('zcode')) {
      const trace = new ZCodeSetupTrace('configuration', reportZCodeSetup)
      trace.stage(zcodeInstallation.isBusy() ? 'installation_busy' : agentLifecycle.isUpdating('zcode') ? 'update_busy' : 'active_session')
      trace.fail('busy')
      return { ...await zcodeConfiguration.snapshot(), phase: 'failed',
        message: zcodeInstallation.isBusy() ? 'ZCode 正在安装，请完成后再检测配置' : agentLifecycle.isUpdating('zcode') ? 'ZCode 正在更新，请完成更新后再检测配置' : '请先结束 ZCode 任务，再检测或更换配置' }
    }
    const result = await zcodeConfiguration.check(input, async () => {
      if (agentLifecycle.isUpdating('zcode')) throw new Error('ZCode 正在更新，请稍后重试')
      await orchestrator.prepareZCodeRuntimeUpdate()
    })
    if (result.phase === 'ready') await refreshDetectedAgent('zcode')
    return result
  })
  ipcMain.handle(ZCODE_IPC.saveRuntime, async (_event, input: unknown) => {
    if (zcodeInstallation.isBusy()) throw new Error('ZCode 正在安装，请稍后更换运行时')
    if (zcodeConfiguration.isBusy()) throw new Error('ZCode 正在检测配置，请稍后更换运行时')
    if (agentLifecycle.isUpdating('zcode')) throw new Error('agent_update_in_progress')
    const config = await validateZCodeRuntimeConfig(input)
    await detectZCodeRuntime(config)
    await orchestrator.resetZCodeRuntime()
    const result = await saveZCodeRuntimeConfig(config)
    agents = await agentLifecycle.detectAll(true)
    orchestrator.resumePendingQueues()
    return result
  })
  ipcMain.handle(ZCODE_IPC.pickRuntimeFile, async (_event, kind: 'file' | 'directory' = 'file') => {
    if (kind !== 'file' && kind !== 'directory') throw new Error('invalid_zcode_picker_kind')
    const result = await dialog.showOpenDialog({ properties: [kind === 'directory' ? 'openDirectory' : 'openFile'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle(ZCODE_IPC.loadEarlier, async (_event, sessionId: string, beforeRowId?: number) => {
    if (typeof sessionId !== 'string' || beforeRowId !== undefined && (!Number.isSafeInteger(beforeRowId) || beforeRowId < 1)) throw new Error('invalid_zcode_history_request')
    await awaitSessionAgentReady(sessionId)
    return orchestrator.loadZCodeEarlier(sessionId, beforeRowId)
  })
  ipcMain.handle(IPC.getSessionForkPoints, async (_e, sessionId: string) => {
    await awaitSessionAgentReady(sessionId)
    const session = orchestrator.getSessionById(sessionId)
    if (!session?.nativeSessionId) return []
    const agent = agents.find((entry) => entry.id === session.config.agentId)
    return historyForkPoints(agent, session.nativeSessionId, await orchestrator.getEvents(sessionId))
  })
  ipcMain.handle(IPC.getSessionRuntimeState, async (_e, sessionId: string, includeEvents = true) => {
    await awaitSessionAgentReady(sessionId)
    return orchestrator.getSessionRuntimeState(sessionId, includeEvents !== false)
  })
  ipcMain.handle(IPC.refreshNativeSession, async (_e, sessionId: string) => {
    await awaitSessionAgentReady(sessionId)
    return orchestrator.refreshNativeSession(sessionId)
  })

  ipcMain.handle(IPC.enableToolSession, async (event, sessionId: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('invalid_session_id')
    await awaitSessionHydration()
    return orchestrator.enableToolSession(sessionId)
  })

  // G2-4: archive / unarchive / permanently delete a session.
  handleUserSessionMutation(IPC.archiveSession, async (_e, sessionId: string) => {
    await awaitSessionHydration()
    if (orchestrator.getSessionById(sessionId)?.teamBinding) { const binding = teams.binding(sessionId); if (!binding.leader) throw new Error('team_member_read_only'); teams.archive(binding.p.id); return orchestrator.getSessionById(sessionId) }
    return orchestrator.setArchived(sessionId, true)
  })
  handleUserSessionMutation(IPC.unarchiveSession, async (_e, sessionId: string) => {
    await awaitSessionHydration()
    if (orchestrator.getSessionById(sessionId)?.teamBinding) { const binding = teams.binding(sessionId); if (!binding.leader) throw new Error('team_member_read_only'); teams.archive(binding.p.id, false); return orchestrator.getSessionById(sessionId) }
    return orchestrator.setArchived(sessionId, false)
  })
  ipcMain.handle(IPC.deleteSession, async (event, sessionId: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('invalid_session_id')
    await awaitSessionHydration()
    const team = teams.catalog().projects.find(p => Object.values(p.memberSessions).includes(sessionId))
    if (team) { if (team.memberSessions[team.team.leaderMemberId] !== sessionId) throw new Error('team_member_read_only'); teams.deleteProject(team.id); return }
    orchestrator.assertUserSessionEnabled(sessionId)
    await orchestrator.deleteSession(sessionId)
  })

  // 需求4: rename + pin/unpin a session.
  handleUserSessionMutation(IPC.renameSession, async (_e, sessionId: string, title: string) => {
    await awaitSessionHydration()
    if (orchestrator.getSessionById(sessionId)?.teamBinding) { const binding = teams.binding(sessionId); if (!binding.leader) throw new Error('team_member_read_only'); teams.rename(binding.p.id, title); return orchestrator.getSessionById(sessionId) }
    return orchestrator.renameSession(sessionId, title)
  })
  handleUserSessionMutation(IPC.pinSession, async (_e, sessionId: string, pinned: boolean) => {
    await awaitSessionHydration()
    return orchestrator.setPinned(sessionId, pinned)
  })

  handleUserSessionMutation(
    IPC.updateSessionConfig,
    async (_e, sessionId: string, patch: Partial<SessionConfig>) => {
      await awaitSessionAgentReady(sessionId)
      return orchestrator.updateSessionConfig(sessionId, patch)
    }
  )

  handleUserSessionMutation(IPC.respondRequest, async (_e, sessionId: string, requestId: string, answer: unknown) => {
    // 需求3 验证：contextBridge 把 window.uniagent 冻结，渲染层无法劫持 respondRequest
    // 来断言回复形状；e2e 下在主进程侧记录最近一次入参，供测试脚本回读。
    if (e2eEnabled) e2eLastResponse = { sessionId, requestId, answer }
    return respondUniAgentRequest(sessionId,requestId,answer)
  })

  // Doc2: history listing + import/resume.
  ipcMain.handle(IPC.listAgentHistory, async (_e, agentId: string) => {
    return sessionImport('session-list', agentId, 'history-list', async () => {
      await awaitAgentReady(agentId)
      if (e2eLocalAutomationPassthrough && agentId === 'codex') {
        const call = (e2eHistoryCalls.get(agentId) ?? 0) + 1
        e2eHistoryCalls.set(agentId, call)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, call === 1 ? 100 : 250))
        return [{
          id: `e2e-history-${agentId}`,
          title: 'E2E history codex cached',
          cwd: '/tmp/e2e-history',
          updatedAt: 1_700_000_000_000 + call,
          agentId
        }] satisfies SessionSummary[]
      }
      const agent = agents.find((entry) => entry.id === agentId)
      if (agent?.adapter === 'deepseek') return listDeepSeekSessions(agent.bin, undefined, deepseekRuntimeEnv())
      return listAgentHistory(agentId, agent?.bin)
    })
  })
  ipcMain.handle(IPC.importSession, async (
    _e,
    agentId: string,
    nativeId: string,
    mode: SessionImportMode = 'snapshot',
    historyCwd?: string,
    historyTitle?: string
  ) => {
    return sessionImport('session-import', agentId, nativeId, async () => {
      await awaitAgentReady(agentId)
      return orchestrator.importSession(agentId, nativeId, mode, historyCwd, historyTitle)
    })
  })
  // 修复#2 — read-only PREVIEW of a native session: replay its normalized events
  // for a viewer WITHOUT minting an orchestrator Session (so a snapshot never
  // pollutes the sidebar / session list). Returns just the events + cwd/model.
  const warmedHistoryAgents = new Set<string>()
  ipcMain.handle(IPC.previewHistory, async (event, agentId: string, nativeId: string, historyCwd?: string, requestId?: string) => {
    const estimate = createHistoryPreviewProgress(agentId, !warmedHistoryAgents.has(agentId))
    const publish = (progress: HistoryLoadProgress & { percent: number }): void => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.previewHistoryProgress, { ...progress, requestId })
    }
    const onProgress = typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128
      ? (progress: HistoryLoadProgress): void => publish(estimate.update(progress))
      : undefined
    const timer = onProgress ? setInterval(() => publish(estimate.value()), 100) : undefined
    return sessionImport('session-preview', agentId, nativeId, async () => {
      try {
        onProgress?.({ phase: 'preparing' })
        await awaitAgentReady(agentId)
        const agent = agents.find((entry) => entry.id === agentId)
        const { events, cwd, model } = await loadSessionEvents(agentId, nativeId, agent?.bin, historyCwd, onProgress)
        onProgress?.({ phase: 'fork-points' })
        const forkPoints = await historyForkPoints(agent, nativeId, events)
        warmedHistoryAgents.add(agentId)
        onProgress?.({ phase: 'rendering' })
        return { events, cwd, model, forkPoints }
      } finally {
        clearInterval(timer)
      }
    })
  })
  // Doc2: cross-agent resume — transplant a native session into another agent's
  // on-disk history, then import + open it under that agent.
  ipcMain.handle(
    IPC.exportNativeSession,
    async (_e, sourceAgentId: string, nativeId: string, targetAgentId: string) => {
      return sessionImport('session-cross-import', sourceAgentId, nativeId, async () => {
        await awaitAgentsReady([sourceAgentId, targetAgentId])
        return orchestrator.exportNativeSession(sourceAgentId, nativeId, targetAgentId)
      })
    }
  )
  // 需求5（外部会话导入并发治理）— fork a read-only imported snapshot into a
  // writable branch, either under the same agent (lossless byte-copy) or into
  // another agent (normalized rebuild, potentially lossy).
  ipcMain.handle(IPC.forkSameSession, async (
    _e,
    agentId: string,
    nativeId: string,
    cwd?: string,
    point?: HistoryForkPoint,
    compatibilityMode?: boolean
  ) => {
    return sessionImport('session-fork', agentId, nativeId, async () => {
      await awaitAgentReady(agentId)
      return orchestrator.forkSameSession(agentId, nativeId, cwd, point, compatibilityMode === true)
    })
  })
  ipcMain.handle(
    IPC.forkCrossSession,
    async (_e, sourceAgentId: string, nativeId: string, targetAgentId: string, point?: HistoryForkPoint) => {
      return sessionImport('session-cross-fork', sourceAgentId, nativeId, async () => {
        await awaitAgentsReady([sourceAgentId, targetAgentId])
        return orchestrator.forkCrossSession(sourceAgentId, nativeId, targetAgentId, point)
      })
    }
  )

  // Doc10: reconstruct before/after file contents for the side-by-side review.
  ipcMain.handle(IPC.reviewGetFilePair, async (event, req: ReviewFilePairReq) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    return orchestrator.reviewGetFilePair(req)
  })

  // Doc11: handoff presets (reusable task templates).
  ipcMain.handle(IPC.listPresets, () => presets.list())
  ipcMain.handle(IPC.savePreset, (_e, preset: HandoffPreset) => {
    const saved = presets.save(preset)
    publishHandoffCatalog() // P5: keep the MCP catalog's preset list current.
    return saved
  })
  ipcMain.handle(IPC.deletePreset, (_e, id: string) => {
    const res = presets.remove(id)
    publishHandoffCatalog()
    return res
  })
  ipcMain.handle(IPC.listRoles, () => buildAgentRoleCatalog(projectRoles(), agents))
  ipcMain.handle(IPC.saveRole, (_e, role: AgentRole) => saveUniAgentRole(role))
  ipcMain.handle(IPC.deleteRole, (_e, id: string) => deleteUniAgentRole(id))
  // Doc11: self-test the injected handoff MCP server (used by the CDP harness to
  // prove the create_uniagent_task tool is a working MCP server without a live
  // agent). Reports the server path, inbox dir, advertised tools and adapters.
  ipcMain.handle(IPC.handoffSelfTest, () => handoffSelfTest())

  handleUserSessionMutation(IPC.compactSession, async (event, sessionId: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('invalid_session_id')
    await awaitSessionAgentReady(sessionId)
    return orchestrator.compactSession(sessionId)
  })

  // Doc5: fetch a sub-agent thread's items for the detail panel (lazy-loaded).
  ipcMain.handle(IPC.subagentItems, async (_e, sessionId: string, agentThreadId: string) => {
    await awaitSessionAgentReady(sessionId)
    return orchestrator.getSubAgentItems(sessionId, agentThreadId)
  })
  handleUserSessionMutation(IPC.subagentCancel, async (_e, sessionId: string, agentThreadId: string) => {
    await awaitSessionAgentReady(sessionId)
    return orchestrator.cancelSubAgent(sessionId, agentThreadId)
  })

  // 需求2（侧边对话 /side）— ephemeral side-branch chat off the main rollout.
  ipcMain.handle(IPC.sideCanOpen, async (_e, sessionId: string) => {
    if (e2eEnabled) return true
    return orchestrator.canOpenSideChat(sessionId)
  })
  handleUserSessionMutation(IPC.sideSend, async (
    _e,
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    value?: unknown,
    activatePlan?: boolean,
    bubble?: TurnBubbleInput
  ) => {
    await awaitSessionAgentReady(sessionId)
    const state = orchestrator.getSideState(sessionId)
    const selection = parseNativeTurnSelectionRequest(value)
    const nativeContext = await resolveNativeTurnSelection(state.config.agentId, state.config.workdir, selection)
    return orchestrator.sendSideMessage(sessionId, prompt, attachments, nativeContext, activatePlan === true, sanitizeTurnBubble(bubble))
  })
  handleUserSessionMutation(IPC.sideForceSend, async (
    _e,
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    value?: unknown,
    bubble?: TurnBubbleInput
  ) => {
    await awaitSessionAgentReady(sessionId)
    const state = orchestrator.getSideState(sessionId)
    const selection = parseNativeTurnSelectionRequest(value)
    const nativeContext = await resolveNativeTurnSelection(state.config.agentId, state.config.workdir, selection)
    return orchestrator.forceSendSideMessage(sessionId, prompt, attachments, nativeContext, sanitizeTurnBubble(bubble))
  })
  ipcMain.handle(IPC.sideGetState, async (_e, sessionId: string) => {
    return orchestrator.getSideState(sessionId)
  })
  handleUserSessionMutation(IPC.sideUpdateConfig, async (_e, sessionId: string, patch: Partial<SessionConfig>) => {
    return orchestrator.updateSideConfig(sessionId, patch)
  })
  handleUserSessionMutation(IPC.sideSetCollaborationMode, async (_e, sessionId: string, mode: CollaborationModeId) => {
    return orchestrator.setSideCollaborationMode(sessionId, mode)
  })
  handleUserSessionMutation(IPC.sideRunNativeAction, async (_e, sessionId: string, value: unknown) => {
    await awaitSessionAgentReady(sessionId)
    return orchestrator.runSideNativeAction(sessionId, parseNativeThreadAction(value))
  })
  handleUserSessionMutation(IPC.sideCompact, async (_e, sessionId: string) => {
    await awaitSessionAgentReady(sessionId)
    return orchestrator.compactSideChat(sessionId)
  })
  handleUserSessionMutation(IPC.sideRespond, async (_e, sessionId: string, requestId: string, answer: unknown) => {
    const result = await orchestrator.respondSideRequest(sessionId, requestId, answer)
    if (!result.handled) throw new Error('侧边提问已失效或未被 Agent 接受')
  })
  handleUserSessionMutation(IPC.sideDequeue, async (_e, sessionId: string, itemId: string) => {
    return orchestrator.dequeueSideMessage(sessionId, itemId)
  })
  handleUserSessionMutation(IPC.sidePromoteQueue, async (_e, sessionId: string, itemId: string) => {
    return orchestrator.promoteSideMessage(sessionId, itemId)
  })
  handleUserSessionMutation(
    IPC.sideEditQueue,
    async (_e, sessionId: string, itemId: string, prompt: string, attachments?: Attachment[], value?: unknown) => {
      const session = orchestrator.listSessions().find((item) => item.id === sessionId)
      const selection = parseNativeTurnSelectionRequest(value)
      const nativeContext = session
        ? await resolveNativeTurnSelection(session.config.agentId, session.config.workdir, selection)
        : undefined
      const ownedAttachments = session?.config.agentId === 'grok' ? await prepareGrokAttachments(attachments) : attachments
      orchestrator.editSideMessage(sessionId, itemId, prompt, ownedAttachments, nativeContext)
    }
  )
  handleUserSessionMutation(IPC.sideSetQueueEditing, async (_e, sessionId: string, itemId: string | null) => {
    orchestrator.setSideQueueEditing(sessionId, typeof itemId === 'string' ? itemId : null)
  })
  handleUserSessionMutation(IPC.sideInterrupt, async (_e, sessionId: string) => {
    return orchestrator.interruptSide(sessionId)
  })
  ipcMain.handle(IPC.sideGetEvents, async (_e, sessionId: string) => {
    return orchestrator.getSideEvents(sessionId)
  })
  ipcMain.handle(IPC.sideGetStatus, async (_e, sessionId: string) => {
    return orchestrator.getSideStatus(sessionId)
  })
  handleUserSessionMutation(IPC.sideClose, async (_e, sessionId: string) => {
    return orchestrator.closeSideChat(sessionId)
  })
  handleUserSessionMutation(IPC.sidePromote, async (_e, sessionId: string) => {
    await awaitSessionAgentReady(sessionId)
    return orchestrator.promoteSideToSession(sessionId)
  })

  handleUserSessionMutation(COMMENT_IPC.list, (_e, id) => comments.list(id))
  handleUserSessionMutation(COMMENT_IPC.create, (_e, id, selection) => comments.create(id, selection))
  handleUserSessionMutation(COMMENT_IPC.send, (_e, owner, id, text, model) => comments.send(owner, id, text, model))
  handleUserSessionMutation(COMMENT_IPC.stop, (_e, owner, id) => comments.stop(owner, id))
  handleUserSessionMutation(COMMENT_IPC.respond, (_e, owner, id, request, answer) => comments.respond(owner, id, request, answer))

  // 选中即评论 / 详情 — ephemeral detail-branch chat explaining a text selection.
  handleUserSessionMutation(IPC.detailExplain, async (_e, sessionId: string, context: DetailExplanationContext) => {
    return detailWindow.open(sessionId, context)
  })
  handleUserSessionMutation(IPC.detailSend, async (_e, sessionId: string, prompt: string, attachments?: Attachment[]) => {
    await awaitSessionAgentReady(sessionId)
    return orchestrator.sendDetailMessage(sessionId, prompt, attachments)
  })
  handleUserSessionMutation(IPC.detailInterrupt, async (_e, sessionId: string) => {
    return orchestrator.interruptDetail(sessionId)
  })
  ipcMain.handle(IPC.detailGetEvents, async (_e, sessionId: string) => {
    return orchestrator.getDetailEvents(sessionId)
  })
  ipcMain.handle(IPC.detailGetStatus, async (_e, sessionId: string) => {
    return orchestrator.getDetailStatus(sessionId)
  })
  handleUserSessionMutation(IPC.detailClose, async (_e, sessionId: string) => {
    detailWindow.close(sessionId)
    return orchestrator.closeDetail(sessionId)
  })
  handleUserSessionMutation(IPC.detailPromote, async (_e, sessionId: string) => {
    return orchestrator.promoteDetailToSide(sessionId)
  })
  handleUserSessionMutation(IPC.detailPromoteSession, async (event, sessionId: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('invalid_session_id')
    await awaitSessionAgentReady(sessionId)
    return orchestrator.promoteDetailToSession(sessionId)
  })

  // Doc(变更文件列表改 git-diff 驱动): the workdir's live git change set.
  // 需求一 — an optional `turn` scope returns that turn's frozen artifact instead
  // of the live workspace diff, so pre-existing dirty files never leak into a
  // turn's card/review. Scope-aware orchestrator methods land in the same change
  // set; `rewindOrchestrator` is a typed surface so this shell compiles regardless
  // of ordering (see its declaration).
  ipcMain.handle(IPC.reviewGetChangeSet, async (event, sessionId: string, scope?: ReviewScope) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    return rewindOrchestrator.reviewGetChangeSet(sessionId, scope)
  })

  // 需求一 — one turn's frozen change summary (native turn id → files/lines) for
  // the change card; null when the turn has no artifact (old history / no files).
  ipcMain.handle(IPC.getTurnArtifactSummary, async (event, sessionId: string, turnId: string) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    return rewindOrchestrator.getTurnArtifactSummary(sessionId, turnId)
  })

  // 需求三（会话节点回退）— read-only preflight for the confirm dialog + loading.
  ipcMain.handle(IPC.previewSessionRewind, async (event, sessionId: string, beforeTurnId: string) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionAgentReady(sessionId)
    return rewindOrchestrator.previewSessionRewind(sessionId, beforeTurnId)
  })

  // 需求三 — execute the transactional rewind (reverse-apply files + native fork).
  // Re-validates everything internally; the shell never trusts a stale preview.
  handleUserSessionMutation(IPC.rewindSession, async (event, sessionId: string, beforeTurnId: string) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionAgentReady(sessionId)
    return rewindOrchestrator.rewindSession(sessionId, beforeTurnId)
  })

  // An explicitly opened external file may supply its parent as the browser
  // root. Relative paths remain confined to that root by the existing guard.
  // 工具能力 → 在文件浏览器中打开：the Skill folder has no session workdir, so an
  // absolute requested root is honored on its own; the path guard still confines
  // navigation to it. (The renderer is already a trusted IPC peer.)
  const fileBrowserRoot = (workdir: string | undefined, requested?: string): string | undefined =>
    typeof requested === 'string' && isAbsolute(requested) ? requested : !workdir ? undefined : requested === undefined ? workdir : undefined
  ipcMain.handle(IPC.fsListDir, async (event, sessionId: string, path: string, requestedRoot?: string) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    const workdir = orchestrator.listSessions().find((session) => session.id === sessionId)?.config.workdir
    if (e2eEnabled && process.env.UA_E2E_FILE_BROWSER_PASSTHROUGH !== '1' && workdir && !requestedRoot && path === '') {
      return {
        ok: true, root: workdir, dirPath: '',
        entries: [
          { name: 'e2e-folder', path: 'e2e-folder', kind: 'dir', isSymlink: false },
          { name: 'e2e-preview.ts', path: 'e2e-preview.ts', kind: 'file', size: 47, ext: 'ts', isSymlink: false },
          { name: 'e2e-preview.png', path: 'e2e-preview.png', kind: 'file', size: 68, ext: 'png', isSymlink: false },
          { name: 'e2e-large.txt', path: 'e2e-large.txt', kind: 'file', size: 2_000_000, ext: 'txt', isSymlink: false }
        ]
      } satisfies FileBrowserListResult
    }
    return listFileBrowserDir(fileBrowserRoot(workdir, requestedRoot), path)
  })
  ipcMain.handle(
    IPC.fsReadFile,
    async (event, sessionId: string, path: string, options?: FilePreviewOptions, requestedRoot?: string) => {
      assertTrustedCapabilitySyncIpc(event)
      await awaitSessionHydration()
      const workdir = orchestrator.listSessions().find((session) => session.id === sessionId)?.config.workdir
      if (e2eEnabled && process.env.UA_E2E_FILE_BROWSER_PASSTHROUGH !== '1' && workdir && !requestedRoot) {
        if (path === 'e2e-preview.ts') return {
          ok: true, path, kind: 'text', size: 47, language: 'typescript',
          text: 'export const e2eFileBrowser = true\n// fixture\n'
        } satisfies FilePreviewResult
        if (path === 'e2e-preview.png') return {
          ok: true, path, kind: 'image', size: 68,
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLzGQAAAABJRU5ErkJggg=='
        } satisfies FilePreviewResult
        if (path === 'e2e-large.txt') {
          return options?.force
            ? { ok: true, path, kind: 'text', size: 2_000_000, language: 'plaintext', text: 'bounded fixture', tooLarge: true, truncated: true, lineLimit: 1_000 }
            : { ok: true, path, kind: 'text', size: 2_000_000, language: 'plaintext', tooLarge: true } satisfies FilePreviewResult
        }
      }
      return readFileForPreview(fileBrowserRoot(workdir, requestedRoot), path, options)
    }
  )
  ipcMain.handle(IPC.fsReadAttachmentImage, async (event, sessionId: string, path: string) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof sessionId !== 'string' || typeof path !== 'string' || !isAbsolute(path)) return null
    await awaitSessionHydration()
    const recorded = isRecordedSessionImagePath(await orchestrator.getEvents(sessionId), path)
    if (!recorded) return null
    const image = await pickedFile(path, { force: true })
    return image.kind === 'image' ? image.previewDataUrl || null : null
  })
  ipcMain.handle(IPC.fsReadNativeImage, async (event, sessionId: string, selector: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof sessionId !== 'string' || !selector || typeof selector !== 'object' || Array.isArray(selector)) return null
    const value = selector as Record<string, unknown>
    if (Object.keys(value).some(key => !['eventSeq', 'blockIndex', 'toolResult', 'childSessionId'].includes(key)) ||
        !Number.isSafeInteger(value.eventSeq) || Number(value.eventSeq) < 0 ||
        !Number.isSafeInteger(value.blockIndex) || Number(value.blockIndex) < 0 ||
        value.toolResult !== undefined && typeof value.toolResult !== 'boolean' ||
        value.childSessionId !== undefined && (typeof value.childSessionId !== 'string' || !value.childSessionId.trim() ||
          value.childSessionId.trim() !== value.childSessionId || /[\u0000-\u001f\u007f]/.test(value.childSessionId))) return null
    await awaitSessionHydration()
    return orchestrator.readNativeImage(sessionId, { eventSeq: Number(value.eventSeq), blockIndex: Number(value.blockIndex),
      ...(value.toolResult === true ? { toolResult: true } : {}),
      ...(typeof value.childSessionId === 'string' ? { childSessionId: value.childSessionId } : {}) })
  })
  ipcMain.handle(IPC.fsReveal, async (event, sessionId: string, path: string, requestedRoot?: string) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    const workdir = orchestrator.listSessions().find((session) => session.id === sessionId)?.config.workdir
    const target = await resolveWithinRoot(fileBrowserRoot(workdir, requestedRoot), path)
    if (!target) return
    // Packaged CDP acceptance records the already path-guarded target instead
    // of opening Finder. The opt-in is e2e-only and keeps normal behavior intact.
    if (e2eEnabled && process.env.UA_E2E_FS_REVEAL_LOG) {
      await writeFile(
        process.env.UA_E2E_FS_REVEAL_LOG,
        `${JSON.stringify({ sessionId, path, target })}\n`,
        { flag: 'a', mode: 0o600 }
      )
      return
    }
    shell.showItemInFolder(target)
  })
  ipcMain.handle(IPC.fsOpenHtml, async (event, sessionId: string, path: string, requestedRoot?: string) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitSessionHydration()
    const workdir = orchestrator.listSessions().find((session) => session.id === sessionId)?.config.workdir
    const target = await resolveHtmlWithinRoot(fileBrowserRoot(workdir, requestedRoot), path)
    if (!target) throw new Error('只能打开当前目录中的 HTML 文件')
    await shell.openExternal(pathToFileURL(target).href)
  })

  // Doc4 需求4: scheduled/automation tasks (local, on-disk scanners only).
  ipcMain.handle(IPC.listAutomations, async (event) => {
    assertTrustedCapabilitySyncIpc(event)
    if (e2eLocalAutomationPassthrough) {
      if (!e2eAutomationListReadyAt) e2eAutomationListReadyAt = Date.now() + 1_200
      const remaining = e2eAutomationListReadyAt - Date.now()
      if (remaining > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining))
    }
    await awaitSessionHydration()
    return [...nativeAutomations.list(), ...await listAutomations()]
  })
  ipcMain.handle(IPC.createAutomation, async (event, input: NativeAutomationInput) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitAgentReady(input?.agentId)
    return nativeAutomations.create(validateNativeAutomation(input))
  })
  ipcMain.handle(
    IPC.setAutomationStatus,
    async (event, target: string | AutomationTask, status: 'active' | 'paused') => {
      assertTrustedCapabilitySyncIpc(event)
      await awaitSessionHydration()
      if (typeof target === 'object' && target?.source === 'uniagent') return nativeAutomations.setStatus(target.id, status)
      return typeof target === 'string' ? setAutomationStatus(target, status) : false
    }
  )

  // 需求1（详情/编辑/删除）— lazy detail load, edit, delete. Local tasks go through
  // the on-disk scanner (path-guarded).
  ipcMain.handle(
    IPC.getAutomationDetail,
    async (event, task: AutomationTask): Promise<AutomationDetail | null> => {
      assertTrustedCapabilitySyncIpc(event)
      await awaitSessionHydration()
      if (task?.source === 'uniagent') return nativeAutomations.get(task.id)
      if (e2eEnabled && !e2eLocalAutomationPassthrough) {
        // Echo the list row back with deterministic detail fields for assertions.
        return {
          ...task,
          reasoningEffort: 'high',
          executionEnvironment: 'local',
          cwds: ['/Users/bytedance/project/cc'],
          createdAt: '1783916401864',
          updatedAt: '1784098076103',
          weekdayOnly: /1-5|MO,TU,WE,TH,FR|仅工作日/.test(task.schedule || '')
        }
      }
      if (!task.path) return null
      return getAutomationDetail(task.path)
    }
  )

  ipcMain.handle(
    IPC.updateAutomation,
    async (event, task: AutomationTask, patch: AutomationEditPatch): Promise<boolean> => {
      assertTrustedCapabilitySyncIpc(event)
      await awaitSessionHydration()
      if (task?.source === 'uniagent') {
        const previous = nativeAutomations.get(task.id)
        if (!previous) return false
        await awaitAgentReady(patch.agentId || previous.agentId)
        const current = nativeAutomations.get(task.id)
        if (!current) return false
        validateNativeAutomation({ ...current, ...patch } as NativeAutomationInput)
        return nativeAutomations.update(task.id, patch)
      }
      if (e2eEnabled && !e2eLocalAutomationPassthrough) return true
      if (!task.path) return false
      return updateAutomation(task.path, patch)
    }
  )

  ipcMain.handle(
    IPC.deleteAutomation,
    async (event, task: AutomationTask): Promise<boolean> => {
      assertTrustedCapabilitySyncIpc(event)
      await awaitSessionHydration()
      if (task?.source === 'uniagent') return nativeAutomations.delete(task.id)
      if (e2eEnabled && !e2eLocalAutomationPassthrough) return true
      // Only local tasks (backed by an on-disk automation dir) can be removed.
      if (!task.path) return false
      return deleteAutomation(task.path)
    }
  )

  // Doc5 T2: per-agent last-choice preferences.
  ipcMain.handle(IPC.getPrefs, async (event) => {
    assertTrustedCapabilitySyncIpc(event)
    if (startupCoreReady) await startupCoreReady
    return agentPrefs = prefs.get()
  })
  ipcMain.handle(IPC.setPrefs, async (event, agentId: string, pref: AgentPref) => {
    assertTrustedCapabilitySyncIpc(event)
    await awaitAgentReady(agentId)
    const next = agentPrefs = prefs.set(agentId, pref)
    mainWindow?.webContents.send(IPC.prefsChanged, next)
    return next
  })
  ipcMain.handle(IPC.getAppSettings, (event) => { assertTrustedCapabilitySyncIpc(event); return appSettings.get() })
  
  ipcMain.handle(CODEX_SOURCE_IPC.get, async event => {
    assertTrustedCapabilitySyncIpc(event)
    await startupCoreReady?.catch(() => {})
    return codexSources.refreshQuotas()
  })
  ipcMain.handle(CLAUDE_SOURCE_IPC.get, async event => {
    assertTrustedCapabilitySyncIpc(event)
    await claudeSources.start()
    return claudeSources.snapshot()
  })
  ipcMain.handle(MODEL_CREDENTIAL_IPC.list, async (event, client: ModelSourceClient) => {
    assertTrustedCapabilitySyncIpc(event)
    await startupCoreReady?.catch(() => {})
    return modelCredentials.list(client)
  })
  ipcMain.handle(MODEL_CREDENTIAL_IPC.import, async (event, client: ModelSourceClient, selection: CredentialSelection) => {
    assertTrustedCapabilitySyncIpc(event)
    await startupCoreReady?.catch(() => {})
    return codexConfigMutations.run(async () => {
      const input = await modelCredentials.resolve(client, selection)
      const service = client === 'claude' ? claudeSources : codexSources
      if (service.snapshot().sources.some(source => source.id === input.id && source.hasKey)) throw new Error('此厂商已有配置，请通过重新导入预览并保存')
      const snapshot = await service.save(input)
      await refreshDetectedAgents('模型配置已更新')
      return snapshot
    })
  })
  ipcMain.handle(CLAUDE_SOURCE_IPC.save, async (event, input: CodexSourceInput) => {
    assertTrustedCapabilitySyncIpc(event)
    await startupCoreReady?.catch(() => {})
    return codexConfigMutations.run(async () => {
      const snapshot = await claudeSources.save(await modelCredentials.input('claude', input))
      await refreshDetectedAgents('Claude 模型配置已更新')
      return snapshot
    })
  })
  ipcMain.handle(CLAUDE_SOURCE_IPC.queryModels, async (event, input: CodexSourceModelQueryInput) => {
    assertTrustedCapabilitySyncIpc(event)
    const resolved = await modelCredentials.input('claude', { ...input, enabled: true, models: ['model-query'] })
    return claudeSources.queryModels(resolved)
  })
  ipcMain.handle(CLAUDE_SOURCE_IPC.test, async (event, input: CodexSourceInput) => {
    assertTrustedCapabilitySyncIpc(event)
    return testClaudeConnection(await claudeSources.draftConnection(await modelCredentials.input('claude', input)))
  })
  ipcMain.handle(CODEX_SOURCE_IPC.refreshQuota, async event => {
    assertTrustedCapabilitySyncIpc(event)
    await startupCoreReady?.catch(() => {})
    return codexSources.refreshQuotas(true)
  })
  ipcMain.handle(CODEX_SOURCE_IPC.queryModels, async (event, value: CodexSourceModelQueryInput) => {
    assertTrustedCapabilitySyncIpc(event)
    await startupCoreReady?.catch(() => {})
    return codexSources.queryModels(await modelCredentials.input('codex', { ...value, enabled: true, models: ['model-query'] }))
  })
  for (const [channel, operation] of [
    [CODEX_SOURCE_IPC.save, (value: CodexSourceInput) => codexSources.save(value)],
    [CODEX_SOURCE_IPC.enabled, (value: boolean) => codexSources.setEnabled(value)],
    [CODEX_SOURCE_IPC.restart, () => codexSources.restart()],
    [CODEX_SOURCE_IPC.migrate, () => codexSources.migrate()]
  ] as const) {
    ipcMain.handle(channel, async (event, value) => {
      assertTrustedCapabilitySyncIpc(event)
      await startupCoreReady?.catch(() => {})
      return codexConfigMutations.run(async () => {
        const resolved = channel === CODEX_SOURCE_IPC.save ? await modelCredentials.input('codex', value) : value
        const snapshot = await (operation as (input: unknown) => ReturnType<CodexSourceService['save']>)(resolved)
        try {
          await refreshDetectedAgents('Codex 来源配置已更新')
        } catch { return { ...snapshot, message: '配置已应用，模型列表刷新失败，请重新检测 Codex' } }
        return snapshot
      })
    })
  }
  ipcMain.handle(IPC.setAppSettings, (event, patch: AppSettingsPatch) => {
    assertTrustedCapabilitySyncIpc(event)
    return patchAppSettings(patch)
  })
  ipcMain.handle(IPC.getAppVersion, (event) => {
    assertTrustedCapabilitySyncIpc(event)
    return app.getVersion()
  })
  ipcMain.handle(IPC.checkAppUpdate, (event, force: boolean) => {
    assertTrustedCapabilitySyncIpc(event)
    return runAppUpdateCheck(force === true)
  })
  
  ipcMain.handle(IPC.getNativeTokenUsage, async (event, query: KabooUsageQuery): Promise<KabooProfileResult> => {
    assertTrustedCapabilitySyncIpc(event)
    // Native usage reads real on-disk agent history; the e2e harness isolates HOME
    // so this simply returns an empty profile there rather than a fixture.
    const started = Date.now()
    const result = await getNativeTokenUsage(query)
    logTokenUsage('native', 'ipc', {
      query,
      durationMs: Date.now() - started,
      ...('unavailable' in result
        ? { unavailable: result.reason }
        : {
            stats: result.stats,
            tools: result.toolBreakdown,
            ...(query?.period === 'day' ? { hourlyTrend: result.hourlyTrend, dailyTrend: result.dailyTrend } : {})
          })
    })
    return result
  })
  ipcMain.handle(IPC.logTokenUsage, (event, entry: { event?: unknown; data?: unknown } | undefined) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof entry?.event === 'string' && entry.event.length <= 120) {
      logTokenUsage('renderer', entry.event, entry.data)
    }
  })
  ipcMain.handle(IPC.refreshNativeTokenUsage, (event) => {
    assertTrustedCapabilitySyncIpc(event)
    refreshNativeTokenUsage()
  })
  ipcMain.handle(IPC.getCodexRateLimits, async (event, force: unknown = false) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof force !== 'boolean') throw new Error('invalid_codex_quota_request')
    if (!force) return getCodexRateLimits()
    await startupCoreReady?.catch(() => {})
    if (isQuitting) return null
    const codex = agents.find(agent => agent.id === 'codex' && agent.installed !== false)
    if (!codex) return null
    const snapshot = await refreshCodexRateLimits(codex.bin)
    mainWindow?.webContents.send(IPC.codexRateLimitsChanged, snapshot)
    return snapshot
  })
  ipcMain.handle(IPC.getClaudeRateLimits, (event) => {
    assertTrustedCapabilitySyncIpc(event)
    return getClaudeRateLimits()
  })
  ipcMain.handle(IPC.getGrokQuota, async (event, force: unknown = false) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof force !== 'boolean') throw new Error('invalid_grok_quota_request')
    // Account billing uses Grok's official extension independently of chat capabilities.
    await startupProtocolSettled?.catch(() => {})
    if (isQuitting) return null
    const grok = agents.find(agent => agent.adapter === 'grok' && agent.installed !== false)
    return grokQuota.get(grok?.bin, force)
  })
  ipcMain.handle(IPC.getAgentQuota, async (event, agentId: unknown, force: unknown = false, providerId: unknown = undefined) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof agentId !== 'string' || !agentId || agentId.length > 512 || typeof force !== 'boolean' || providerId !== undefined && (typeof providerId !== 'string' || !providerId || providerId.length > 512)) throw new Error('invalid_agent_quota_request')
    await startupProtocolSettled?.catch(() => {})
    if (isQuitting) return null
    const enabled: readonly string[] = appSettings.get().enabledAgentIds ?? DEFAULT_ENABLED_AGENT_IDS
    const agent = agents.find(agent => agent.id === agentId && agent.installed !== false && agent.lifecycle?.availability === 'available' && enabled.includes(agent.id))
    return agent ? agentQuota.get(agent, force, providerId as string | undefined) : null
  })
  ipcMain.handle(ZCODE_IPC.quota, async (event, force: unknown = false, providerId: unknown = undefined) => {
    assertTrustedCapabilitySyncIpc(event)
    if (typeof force !== 'boolean' || providerId !== undefined && (typeof providerId !== 'string' || !providerId || providerId.length > 512)) throw new Error('invalid_zcode_quota_request')
    await startupProtocolSettled?.catch(() => {})
    if (isQuitting || !agents.some(agent => agent.adapter === 'zcode' && agent.installed !== false)) return null
    return zcodeQuota.get(providerId as string | undefined, force)
  })
  ipcMain.handle(IPC.getLifecycleMetrics, () => appSettings.metrics())

  ipcMain.handle(IPC.feishuInstall, async event => {
    assertTrustedCapabilitySyncIpc(event)
    if (isQuitting) throw new Error('应用正在退出')
    if (sessionFeishuInstaller || sessionFeishuManualBinding || appSettings.get().feishu?.appId) return sessionFeishuStatus()
    const installer = new FeishuInstaller({
      onProgress: progress => {
        if (sessionFeishuInstaller !== installer) return
        sessionFeishuInstallProgress = progress
        mainWindow?.webContents.send(IPC.feishuInstallProgress, sessionFeishuStatus())
      },
      persist: (appId,appSecret,signal) => saveFeishuCredentials('feishu', { appId,appSecret }, signal),
      startBridge: startFeishuBridgeWhenReady
    })
    sessionFeishuInstaller = installer
    const flight = installer.installFromBrowser()
    sessionFeishuInstallFlight = flight
    try {
      await flight
    } catch (error) {
      const message = error instanceof Error ? error.message : '配置失败，请重试'
      feishuBridge.setPhase(message === '已取消配置' ? 'idle' : 'failed', message === '已取消配置' ? undefined : message)
      throw error
    } finally {
      if (sessionFeishuInstaller === installer) {
        sessionFeishuInstaller = undefined; sessionFeishuInstallFlight = undefined; sessionFeishuInstallProgress = undefined
        mainWindow?.webContents.send(IPC.feishuInstallProgress, sessionFeishuStatus())
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
    return sessionFeishuStatus()
  })
  ipcMain.handle(IPC.feishuCancelInstall, async event => {
    assertTrustedCapabilitySyncIpc(event)
    if (sessionFeishuInstallProgress?.phase === 'awaiting-login') return sessionFeishuStatus()
    sessionFeishuInstaller?.cancel()
    await sessionFeishuInstallFlight?.catch(() => {})
    return sessionFeishuStatus()
  })
  ipcMain.handle(IPC.feishuBind, async (event, input: import('../shared/assistant').AssistantFeishuInput) => {
    assertTrustedCapabilitySyncIpc(event)
    if (sessionFeishuInstaller || sessionFeishuManualBinding) throw new Error('请先完成或取消机器人配置')
    if (appSettings.get().feishu?.appId) throw new Error('请先断开当前机器人再重新配置')
    sessionFeishuManualBinding = true
    sessionFeishuInstallProgress = { phase: 'awaiting-login', message: '正在验证机器人并连接…' }
    mainWindow?.webContents.send(IPC.feishuInstallProgress, sessionFeishuStatus())
    try {
      await saveFeishuCredentials('feishu', input)
      await startFeishuBridgeWhenReady()
    } finally {
      sessionFeishuManualBinding = false
      sessionFeishuInstallProgress = undefined
      mainWindow?.webContents.send(IPC.feishuInstallProgress, sessionFeishuStatus())
    }
    return sessionFeishuStatus()
  })
  ipcMain.handle(IPC.feishuStatus, event => {
    assertTrustedCapabilitySyncIpc(event)
    return sessionFeishuStatus()
  })
  ipcMain.handle(IPC.feishuStop, async event => {
    assertTrustedCapabilitySyncIpc(event)
    if (sessionFeishuInstaller || sessionFeishuManualBinding) throw new Error('请先完成或取消机器人配置')
    appSettings.set({ feishu: { enabled: false, appId: '', appSecret: '', botName: '' } })
    if (appSettings.get().feishu?.appId) throw new Error('断开未能保存，请重试')
    await feishuBridge.stop()
    feishuBridge.setPhase('idle')
    return sessionFeishuStatus()
  })
  ipcMain.handle(IPC.feishuScanGroups, () => feishuBridge.scanGroups())
  ipcMain.handle(IPC.feishuBeginNotificationBinding, (event, input: import('../shared/types').FeishuNotificationBinding) => {
    assertTrustedCapabilitySyncIpc(event)
    return feishuBridge.beginNotificationBinding(input)
  })
  ipcMain.handle(IPC.feishuCancelNotificationBinding, event => {
    assertTrustedCapabilitySyncIpc(event)
    return feishuBridge.cancelNotificationBinding()
  })
  ipcMain.handle(IPC.feishuUnbindNotificationTarget, event => {
    assertTrustedCapabilitySyncIpc(event)
    return feishuBridge.unbindNotificationTarget()
  })

  ipcMain.handle(IPC.listDiagnostics, (event) => {
    assertTrustedCapabilitySyncIpc(event)
    return diagnostics.list()
  })
  ipcMain.handle(IPC.getQueueWaitQuality, (event, query: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    return orchestrator.getQueueWaitQuality(parseQueueWaitQualityQuery(query))
  })
  ipcMain.handle(IPC.copyQueueWaitQuality, (event, query: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    const report = orchestrator.getQueueWaitQuality(parseQueueWaitQualityQuery(query))
    clipboard.writeText(JSON.stringify({
      metric: '每段首次预估与实际剩余等待比较；errorMs = 预估 - 实际，取消及缺失结果不计误差。时间单位为毫秒。',
      ...report
    }, null, 2))
  })
  ipcMain.handle(IPC.openQueueWaitQualityLogs, async (event) => {
    assertTrustedCapabilitySyncIpc(event)
    const directory = dirname(orchestrator.getQueueWaitQuality().logPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.clearDiagnostics, (event) => {
    assertTrustedCapabilitySyncIpc(event)
    diagnostics.clear()
  })
  ipcMain.handle(IPC.removeDiagnostics, (event, ids: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== 'string' || id.length > 100)) {
      throw new Error('invalid_diagnostic_ids')
    }
    diagnostics.remove(ids)
  })
  ipcMain.handle(IPC.copyDiagnosticsReport, (event, ids?: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== 'string' || id.length > 100))) {
      throw new Error('invalid_diagnostic_ids')
    }
    const report = diagnostics.formatReport(ids as string[] | undefined)
    clipboard.writeText(report)
    return report
  })
  ipcMain.handle(IPC.reportDiagnostic, (event, input: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    if (!input || typeof input !== 'object' || Array.isArray(input)) return
    const issue = input as Record<string, unknown>
    if (typeof issue.source !== 'string' || typeof issue.code !== 'string' || typeof issue.message !== 'string') return
    if (issue.source === 'renderer-performance' && ['renderer_long_tasks', 'renderer_performance_snapshot'].includes(issue.code)) {
      performanceMonitor?.rendererSample(issue.sample, issue.code === 'renderer_long_tasks')
      return
    }
    diagnostics.record({
      category: 'app_runtime',
      level: issue.level === 'warn' ? 'warn' : 'error',
      source: issue.source.slice(0, 80),
      code: issue.code.slice(0, 80),
      agentId: 'app',
      message: issue.message.slice(0, 2000),
      sample: runtimeDiagnosticSample(
        issue.sample !== undefined
          ? issue.sample
          : typeof issue.stack === 'string' ? issue.stack.slice(0, 20_000) : issue.message,
        { appVersion: app.getVersion(), rendererSource: issue.source.slice(0, 80) }
      )
    })
  })

  ipcMain.handle(IPC.pickDirectory, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // 计时胶囊重构 — while the summary dock is pinned it takes real layout width,
  // so the window's minimum width grows by the dock width (clamped 0–480). When
  // the current window is narrower than the new minimum, grow it once.
  ipcMain.handle(IPC.setSummaryDockWidth, (_event, extra: unknown) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const add = typeof extra === 'number' && Number.isFinite(extra)
      ? Math.min(480, Math.max(0, Math.round(extra)))
      : 0
    const minWidth = 1024 + add
    win.setMinimumSize(minWidth, 640)
    if (add > 0) {
      const [width, height] = win.getSize()
      if (width < minWidth) win.setSize(minWidth, height)
    }
  })

  // Doc4 需求3: attach files (multi-select) from disk.
  ipcMain.handle(IPC.pickFiles, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : Promise.all(res.filePaths.map((path) => pickedFile(path)))
  })

  // Doc4 需求3: persist a clipboard image so it can be attached. It lives under
  // userData (not tmpdir) so a queued image survives an App restart — the queue's
  // durable FIFO now carries images, and OS temp cleanup must not orphan them.
  ipcMain.handle(IPC.saveClipboardImage, async (event, dataUrl?: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    if (dataUrl !== undefined && (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/'))) return null
    let img: Electron.NativeImage
    try {
      img = dataUrl ? nativeImage.createFromDataURL(dataUrl) : clipboard.readImage()
    } catch {
      return null
    }
    if (img.isEmpty()) return null
    const dir = join(resolveUserDataHome(), 'clipboard-images')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `clip-${Date.now()}.png`)
    await writeFile(path, img.toPNG())
    return { path, name: path.split('/').pop() || 'clipboard.png', kind: 'image', mime: 'image/png' }
  })

  // 图片详情: copy the image the user is looking at onto the OS clipboard so it
  // can be pasted elsewhere. The renderer only ever hands over the data URL it is
  // already showing, so no filesystem access is involved. Returns success so the
  // menu can confirm the copy.
  ipcMain.handle(IPC.copyImageToClipboard, (event, dataUrl: unknown) => {
    assertTrustedCapabilitySyncIpc(event)
    return copyClipboardImage(dataUrl, { decode: value => nativeImage.createFromDataURL(value), write: image => clipboard.writeImage(image) }, sample => {
      performanceMonitor?.record('clipboard_image_copy', sample)
      if (sample.outcome !== 'copied') recordRuntime('clipboard', 'image_copy_failed',
        `图片复制失败（${sample.outcome}）`, 'warn', undefined, 'app', sample)
    })
  })

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (!isTrustedExternalUrl(url)) throw new Error('不支持打开此链接协议')
    return shell.openExternal(url)
  })
}

/**
 * Doc11 — materialize a handoff request (dropped into the inbox by the
 * create_uniagent_task MCP tool) into a real UniAgent session. Resolves a
 * referenced preset (by id or name) for its agent/model/effort/permission/prompt
 * defaults, then falls back to the request's own fields, then to sensible
 * defaults (the request's target agent must exist / be installed). The prompt is
 * the request's prompt prefixed with the preset's template when both are present.
 */
// sessionId → handoff id for wait=true requests. Live state is refreshed so the
// MCP server can distinguish a healthy long task from a stale/crashed process.
const handoffWaits = new Map<string, string>()
// 追问 — taskId → materialized session id, so a followup create_uniagent_task
// (followupTaskId set) can resolve the original task's session and continue it.
const handoffSessions = new Map<string, string>()
// Fix#4 — handoff id → caller session id, for wait=true handoffs whose caller
// session we flagged with `waitingForHandoff`. Consumed at terminal state to
// clear the caller's "等待中" status line.
const handoffCallers = new Map<string, string>()
// session id → MCP stop requests waiting for the provider to acknowledge the
// hard interrupt. Their cards are emitted only after a real terminal status.
const handoffStops = new Map<string, { id: string; taskId: string }[]>()
setInterval(() => {
  for (const [sessionId, handoffId] of handoffWaits) {
    const session = orchestrator.getSessionById(sessionId)
    if (!session) continue
    // Keep the latest reply in the heartbeat too so a get_uniagent_task poll
    // between statusChange events still sees the current最新回复 (not empty).
    writeHandoffResult(handoffId, {
      status: session.status,
      text: handoffTaskStore.latestReply(handoffId) ?? orchestrator.latestAgentMessageText(sessionId),
      sessionId,
      ...handoffTargetMetadata(session)
    })
  }
}, 30_000).unref()

/** Fix#4 — first non-empty line of a prompt, trimmed to a badge-friendly length. */
function firstLine(text: string): string {
  const line = (text || '').split('\n').map((s) => s.trim()).find(Boolean) || '任务'
  return line.length > 40 ? line.slice(0, 39) + '…' : line
}

function handoffTargetMetadata(session?: Session): Pick<import('./handoff').HandoffResult, 'targetAgent'> {
  if (!session) return {}
  const base = agents.find((candidate) => candidate.id === session.config.agentId)
  if (!base) return {}
  const effective = agentForSession(base, session)
  const capabilities = effective.capabilities
  return {
    targetAgent: {
      id: effective.id,
      name: effective.name,
      adapter: effective.adapter,
      protocol: capabilities.protocol,
      capabilities: {
        steer: capabilities.steer === true,
        followup: capabilities.followup === true,
        sessionFork: capabilities.sessionFork === true,
        sessionForkAtTurn: capabilities.sessionForkAtTurn === true,
        crossAgentFork: capabilities.crossAgentFork === true,
        sideChat: capabilities.sideChat === true,
        structuredSubagents: capabilities.structuredSubagents === true,
        formElicitation: capabilities.formElicitation === true,
        freeTextElicitation: capabilities.freeTextElicitation === true,
        nativeGoal: capabilities.nativeGoal === true,
        nativeReview: capabilities.nativeReview === true,
        structuredUsage: capabilities.structuredUsage === true,
        capabilityInventory: capabilities.capabilityInventory === true,
        additionalDirectoriesNew: capabilities.additionalDirectoriesNew === true,
        additionalDirectoriesResume: capabilities.additionalDirectoriesResume === true
      }
    }
  }
}

function materializeHandoffStop(req: HandoffStopReq): void {
  const fail = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    writeHandoffResult(req.id, { status: 'error', text: message, sessionId: req.targetSessionId, taskId: req.taskId })
    recordRuntime('handoff', 'handoff_stop_failed', error)
  }
  try {
    if (!req.id || !req.taskId || !req.targetSessionId) throw new Error('invalid_stop_request')
    const targetSessionId = handoffSessions.get(req.taskId) || req.targetSessionId
    const target = orchestrator.getSessionById(targetSessionId)
    if (!target) throw new Error(`stop_task_not_found: ${req.taskId}`)
    if (!['running', 'queued', 'awaiting-approval'].includes(target.status)) {
      throw new Error(`stop_task_not_running: ${req.taskId} (status=${target.status})`)
    }
    const requests = handoffStops.get(target.id) || []
    requests.push({ id: req.id, taskId: req.taskId })
    handoffStops.set(target.id, requests)
    writeHandoffResult(req.id, {
      status: 'stopping',
      text: '',
      sessionId: target.id,
      taskId: req.taskId
    })
    orchestrator.interrupt(target.id)
  } catch (error) {
    const pending = handoffStops.get(req.targetSessionId)
    if (pending) {
      const next = pending.filter((request) => request.id !== req.id)
      if (next.length) handoffStops.set(req.targetSessionId, next)
      else handoffStops.delete(req.targetSessionId)
    }
    fail(error)
  }
}

function materializeHandoff(req: HandoffInboxReq): void {
  if (orchestrator.getSessionById(req.callerSessionId || '')?.teamBinding || orchestrator.getSessionById(req.targetSessionId || '')?.teamBinding) {
    if (req.id) writeHandoffResult(req.id, { status: 'error', text: 'team_session_requires_team_tools', sessionId: req.targetSessionId || '' })
    return
  }
  if (req.action === 'stop') {
    materializeHandoffStop(req)
    return
  }
  const waiting = req.wait === true && !!req.id
  // 需求(任务状态查询) — every handoff with an id gets its status/最新回复 mirrored to
  // the results file so get_uniagent_task can be polled even for fire-and-forget
  // (wait=false) tasks. `waiting` still gates the caller-blocking behaviors below.
  const tracked = !!req.id
  const failMaterialize = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error)
    if (tracked && req.id) {
      writeHandoffResult(req.id, { status: 'error', text: message, sessionId: req.targetSessionId || '' })
      for (const [sessionId, taskId] of handoffWaits) {
        if (taskId === req.id) handoffWaits.delete(sessionId)
      }
    }
    throw error instanceof Error ? error : new Error(message)
  }

  try {
    validateHandoffTaskRequest(req)
    if (req.id && !req.force && !handoffTaskStore.begin(req.id, req.followupTaskId, req.targetSessionId, req.callerSessionId)) return

    // 追问 — continue an existing task's session with prompt as a follow-up turn
    // instead of creating a new session. Ignores all config fields.
    if (req.followupTaskId) {
      if (!req.id) throw new Error('followup_request_id_missing')
      const targetSessionId = handoffSessions.get(req.followupTaskId) || req.targetSessionId
      const target = targetSessionId ? orchestrator.getSessionById(targetSessionId) : undefined
      if (!target) throw new Error(`followup_task_not_found: ${req.followupTaskId}`)
      if (req.force) {
        if (target.status !== 'running') {
          throw new Error(`force_send_requires_running_task: ${req.followupTaskId} (status=${target.status})`)
        }
        void orchestrator.forceSendStrict(target.id, req.prompt).then(() => {
          writeHandoffResult(req.id!, {
            status: 'delivered',
            text: '',
            sessionId: target.id,
            taskId: req.followupTaskId,
            ...handoffTargetMetadata(target),
            delivery: 'force-delivered'
          })
        }).catch((error) => {
          writeHandoffResult(req.id!, {
            status: 'error',
            text: error instanceof Error ? error.message : String(error),
            sessionId: target.id,
            taskId: req.followupTaskId,
            ...handoffTargetMetadata(target)
          })
          recordRuntime('handoff', 'handoff_force_send_failed', error)
        })
        return
      }
      const finished = ['idle', 'completed', 'error', 'cancelled', 'interrupted'].includes(target.status)
      if (!finished || handoffWaits.has(target.id)) {
        throw new Error(`followup_task_not_finished: ${req.followupTaskId} (status=${target.status})`)
      }
      const agent = agents.find((a) => a.id === target.config.agentId)
      handoffWaits.set(target.id, req.id)
      handoffSessions.set(req.id, target.id)
      writeHandoffResult(req.id, { status: 'queued', text: '', sessionId: target.id, ...handoffTargetMetadata(target) })
      if (waiting && req.id && req.callerSessionId) {
        const caller = orchestrator.getSessionById(req.callerSessionId)
        if (caller) {
          handoffCallers.set(req.id, caller.id)
          caller.waitingForHandoff = {
            handoffId: req.id,
            awaitedSessionId: target.id,
            agentId: target.config.agentId,
            agentName: agent?.name || target.config.agentId,
            label: firstLine(req.prompt)
          }
          mainWindow?.webContents.send(IPC.sessionUpdated, { session: caller, hasLiveStreamer: false })
        }
      }
      mainWindow?.webContents.send(IPC.sessionUpdated, { session: target, hasLiveStreamer: false })
      void orchestrator.sendMessage(target.id, req.prompt, undefined, undefined, false, { source: 'mcp' }, false).then(() => {
        writeHandoffResult(req.id!, {
          status: target.status,
          text: handoffTaskStore.latestReply(req.id!) ?? orchestrator.latestAgentMessageText(target.id),
          sessionId: target.id,
          ...handoffTargetMetadata(target),
          delivery: 'delivered'
        })
      }).catch((error) => {
        if (req.id && handoffWaits.get(target.id) === req.id) handoffWaits.delete(target.id)
        if (req.id) {
          const callerId = handoffCallers.get(req.id)
          handoffCallers.delete(req.id)
          const caller = callerId ? orchestrator.getSessionById(callerId) : undefined
          if (caller?.waitingForHandoff?.handoffId === req.id) {
            caller.waitingForHandoff = undefined
            mainWindow?.webContents.send(IPC.sessionUpdated, { session: caller, hasLiveStreamer: false })
          }
          writeHandoffResult(req.id, {
            status: 'error',
            text: error instanceof Error ? error.message : String(error),
            sessionId: target.id,
            ...handoffTargetMetadata(target)
          })
        }
        recordRuntime('handoff', 'handoff_followup_failed', error)
      })
      return
    }

    const preset = req.preset
      ? presets.list().find((p) => p.id === req.preset || p.name === req.preset)
      : undefined

    if (req.role) {
      const callerSession = req.callerSessionId
        ? orchestrator.getSessionById(req.callerSessionId)
        : undefined
      const { agent, config } = resolveAgentRoleInvocation({
        roleId: req.role,
        roles: projectRoles(),
        agents,
        callerSessionProjectId: callerSession?.config.projectId,
        callerSessionWorkdir: callerSession?.config.workdir,
        callerWorkdir: req.callerWorkdir
      })
      const session = orchestrator.createSession({ ...config, requirementId: callerSession?.config.requirementId }, req.prompt, undefined, {
        handoffId: req.id,
        handoffWaiting: waiting
      })
      if (tracked && req.id) {
        handoffSessions.set(req.id, session.id)
        writeHandoffResult(req.id, {
          status: session.status,
          text: handoffTaskStore.latestReply(req.id) ?? orchestrator.latestAgentMessageText(session.id),
          sessionId: session.id,
          ...handoffTargetMetadata(session),
          delivery: 'started'
        })
      }
      if (waiting && req.id && req.callerSessionId) {
        const caller = orchestrator.getSessionById(req.callerSessionId)
        if (caller) {
          handoffCallers.set(req.id, caller.id)
          caller.waitingForHandoff = {
            handoffId: req.id,
            awaitedSessionId: session.id,
            agentId: agent.id,
            agentName: agent.name,
            label: firstLine(req.prompt)
          }
          mainWindow?.webContents.send(IPC.sessionUpdated, { session: caller, hasLiveStreamer: false })
        }
      }
      mainWindow?.webContents.send(IPC.sessionCreated, session)
      return
    }

    // Resolve the target agent: explicit req.agent → preset.agentId → first
    // installed agent. Reject explicitly if nothing is installed.
    const wantId = req.agent || preset?.agentId
    const installed = agents.filter((a) => a.lifecycle?.availability === 'available')
    const agent = wantId
      ? installed.find((a) => a.id === wantId || a.adapter === wantId)
      : installed[0]
    if (!agent) throw new Error(wantId ? `agent_unavailable: ${wantId}` : 'no_available_agent')

    // Prompt = preset template (if any) + the request's prompt.
    const parts = [preset?.prompt?.trim(), req.prompt.trim()].filter(Boolean)
    const prompt = parts.join('\n\n')

    const modes = agent.capabilities.permissionModes
    const wantPerm = req.permission || preset?.permissionMode
    const permissionMode =
      wantPerm && modes.some((m) => m.id === wantPerm) ? wantPerm : modes[0]?.id || 'read-only'

    const model = agent.capabilities.modelSelect
      ? req.model || preset?.model || agent.defaultModel || agent.models[0]?.id
      : undefined
    const depth = req.effort || preset?.effort
    const chosenModel = agent.models.find(candidate => candidate.id === model)
    if (agent.adapter === 'zcode' && (!chosenModel?.zcodeSelection || depth && !chosenModel.thinkingOptions?.includes(depth))) throw new Error('ZCode 模型或思考深度已不可用')
    const config: SessionConfig = {
      agentId: agent.id,
      model,
      effort: agent.adapter === 'zcode' ? undefined : depth as SessionConfig['effort'],
      ...(agent.adapter === 'zcode' && chosenModel?.zcodeSelection ? { zcodeModelSelection: { ...chosenModel.zcodeSelection,
        ...(depth ? { options: { reasoningLevel: depth } } : {}) } } : {}),
      ...(req.projectId ? { projectId: req.projectId } : {}),
      workdir: req.workdir || '',
      permissionMode
    }
    // 需求5 — a wait=true handoff blocks its caller until this session ends. Mark
    // the session so the sidebar shows a clickable「等待中」badge, and record the
    // handoff id so the terminal statusChange writes the result回传 file.
    const session = orchestrator.createSession(resolveSessionConfig({ ...config, requirementId: req.callerSessionId ? orchestrator.getSessionById(req.callerSessionId)?.config.requirementId : undefined }, true), prompt, undefined, {
      handoffId: req.id,
      handoffWaiting: waiting
    })
    if (tracked && req.id) {
      handoffSessions.set(req.id, session.id)
      writeHandoffResult(req.id, {
        status: session.status,
        text: handoffTaskStore.latestReply(req.id) ?? orchestrator.latestAgentMessageText(session.id),
        sessionId: session.id,
        ...handoffTargetMetadata(session),
        delivery: 'started'
      })
    }
    // Fix#4 — attribute a wait=true handoff back to its issuing (caller) session so
    // its turn shows「等待 <agent> 的 <task>」(instead of a generic「思考中」) and can
    // click through to this new session. Record the link so the terminal
    // statusChange can clear it.
    if (waiting && req.id && req.callerSessionId) {
      const caller = orchestrator.getSessionById(req.callerSessionId)
      if (caller) {
        handoffCallers.set(req.id, caller.id)
        caller.waitingForHandoff = {
          handoffId: req.id,
          awaitedSessionId: session.id,
          agentId: agent.id,
          agentName: agent.name,
          label: firstLine(req.prompt)
        }
        mainWindow?.webContents.send(IPC.sessionUpdated, { session: caller, hasLiveStreamer: false })
      }
    }
    // Surface the newly-created handoff session in the sidebar immediately (the
    // renderer prepends it and can switch to it).
    mainWindow?.webContents.send(IPC.sessionCreated, session)
  } catch (error) {
    recordRuntime('handoff', 'handoff_materialize_failed', error)
    failMaterialize(error)
  }
}

function sendMcpPayloadToFeishu(req: FeishuSendReq): void {
  const fail = (error: unknown): void => {
    if (!(error instanceof FeishuSendValidationError)) {
      recordRuntime('feishu', 'outbound_message_failed', error)
    }
    if (typeof req?.id !== 'string') return
    writeFeishuSendResult(req.id, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  if (!req || typeof req !== 'object' ||
      typeof req.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(req.id) ||
      typeof req.ts !== 'number' || !Number.isFinite(req.ts) || req.ts <= 0 ||
      typeof req.callerSessionId !== 'string' || !req.callerSessionId ||
      (req.text !== undefined && typeof req.text !== 'string') ||
      !Array.isArray(req.paths) || req.paths.length > 10 ||
      req.paths.some((path) => typeof path !== 'string' || !path.trim()) ||
      (!(req.text?.trim()) && req.paths.length === 0)) {
    fail(new FeishuSendValidationError('无效的飞书发送请求'))
    return
  }
  if (req.channel !== undefined && req.channel !== 'weixin' && req.channel !== 'feishu') { fail(new FeishuSendValidationError('无效的消息渠道')); return }
  const bridge = req.channel === 'weixin' ? assistantWeixinBridge : assistantFeishuThreads.bySession(req.callerSessionId) ? assistantFeishuBridge : feishuBridge
  void bridge.sendToSession(req.callerSessionId, req.text, req.paths, req.ts).then(
    (sent) => writeFeishuSendResult(req.id, { ok: true, sent }),
    fail
  )
}

app.whenReady().then(() => {
  startupTimings.backendLoadedMs = Math.round(process.uptime() * 1000)
  performanceMonitor = new PerformanceMonitor(sessionStore.directory(), () => ({ ...orchestrator.performanceStats(), ...uiEvents.stats() }))
  setFrameHealthReporter((kind, data) => performanceMonitor?.record(kind, data))
  registerIpc()
  // Render the app shell immediately. Slow login-shell startup, crash recovery,
  // and deep CLI/ACP probes continue in the background with visible progress.
  let resolveRendererReady: (() => void) | null = null
  let rendererReadySettled = false
  const rendererReady = new Promise<void>((resolve) => {
    resolveRendererReady = () => {
      if (rendererReadySettled) return
      rendererReadySettled = true
      resolve()
    }
  })
  const showStartupProgress = (): void => {
    startupTimings.rendererLoadedMs = Math.round(process.uptime() * 1000)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.lifecycleProgress, {
        agentId: '*',
        phase: 'detecting',
        message: '正在初始化 Agent，已保存的会话仍可浏览…'
      })
    }
    resolveRendererReady?.()
  }
  createWindow(showStartupProgress)
  const acpRecovery = prepareACPConnections(join(resolveUserDataHome(), 'acp-processes'), rendererReady)
  void acpRecovery.catch(error => recordRuntime('acp', 'startup_recovery_failed', error, 'warn'))
  void rendererReady.then(() => configurePreventSleep(appSettings.get().preventSleep ?? false))
  const recovery = rendererReady.then(() => capabilitySync.recover())
  capabilityRecoveryFlight = recovery
  // Defer synchronous disk setup until the renderer has produced its first
  // document. IPC readers join this promise, so they never observe partial
  // persisted-session state.
  startupSessionHydration = rendererReady.then(() => new Promise<void>((resolve, reject) => {
    setImmediate(async () => {
      try {
        await orchestrator.loadPersisted()
        startupTimings.sessionsHydratedMs = Math.round(process.uptime() * 1000)
        await teams.recover()
        startupTimings.teamsRecoveredMs = Math.round(process.uptime() * 1000)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  }))
  void startupSessionHydration.then(async () => {
    if (!isRequirementsEnabled()) return
    for (const session of orchestrator.listSessions()) {
      const id = session.config.requirementId
      if (!id) continue
      try { if (await requirements.recoverSession(id, session.id)) requirementDistiller.schedule(id, session.id) }
      catch (error) {
        recordRuntime('agent', 'requirement_recovery_failed', error, 'warn', session.id)
        await requirements.setBackgroundStatus(id, { status: 'failed', reason: '来源恢复未完成，现有快照可能尚未包含最近输入' }).catch(() => {})
      }
    }
  }).finally(() => { requirementRecoveryPending = false }).catch(() => {})
  // Make the handoff endpoint available early; its inbox is drained only after
  // Agent discovery, when queued tasks can be routed safely. Keep this failure
  // isolated so it cannot prevent session hydration or Agent detection.
  startupHandoffReady = rendererReady.then(() => new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      try {
        ensureHandoffServer()
        stopRequirementInbox = watchRequirementInbox(async req => {
          await awaitSessionHydration()
          const caller = requirementCaller(req.sessionId, req.token)
          return readRequirementContext(caller.id, req.args)
        })
        handoffTaskStore.recover()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  }))
  // PATH hydration must precede every CLI spawn. Once it is ready, launch the
  // core and ACP provider probes together but publish them through independent
  // barriers so the slower ACP handshake cannot hold the rest of the app.
  const detectionFlights = rendererReady.then(async () => {
    await hydratePathFromLoginShell()
    await claudeSources.start()
    const detection = agentLifecycle.detectStartup()
    // Supplemental probes have no place in the native readiness barrier.
    void Promise.allSettled([ codexSources.start()]).then(async () => {
      await detection.core
      await refreshDetectedAgent('codex')
    }).catch(error => recordRuntime('local-models', 'startup_reconciliation_failed', error, 'warn'))
    return detection
  })
  const coreDetection = detectionFlights.then((flight) => flight.core)
  const protocolDetection = Promise.all([detectionFlights.then((flight) => flight.protocol), acpRecovery]).then(([snapshot]) => snapshot)

  startupCoreReady = Promise.all([startupSessionHydration, coreDetection])
    .then(([, detected]) => {
      agents = (agentLifecycle.snapshot().length ? agentLifecycle.snapshot() : detected)
        .filter(agent => agent.lifecycle?.detectionStatus !== 'detecting' || agent.lifecycle.availability === 'available')
      orchestrator.migrateLegacyPlanSessions()
      orchestrator.reconcileAgentConfigs()
      void personalAssistant.enforceAgentSupport(agents)
        .then(detached => { for (const id of detached) assistantFeishuThreads.remove(id) })
        .catch(error => recordRuntime('personal-assistant', 'assistant_agent_support_failed', error, 'warn'))
      const readyCoreIds = new Set(agents.filter((agent) =>
        agent.id !== 'grok' && agent.id !== 'kimi' && agent.id !== 'deepseek' && agent.id !== 'mcode' && agent.id !== 'nika' && agent.lifecycle?.availability === 'available'
      ).map((agent) => agent.id))
      // Register recovered FIFO tails before releasing core IPC callers.
      orchestrator.resumePendingQueues(readyCoreIds)
      for (const job of appSettings.pendingInitializations()) {
        if (job.targetAgentId === 'grok' || job.targetAgentId === 'kimi' || job.targetAgentId === 'deepseek' || job.targetAgentId === 'mcode' || job.targetAgentId === 'nika') continue
        const session = job.sessionId ? orchestrator.listSessions().find((item) => item.id === job.sessionId) : undefined
        if (!session || ['idle', 'error', 'cancelled', 'archived'].includes(session.status)) {
          appSettings.settleInitialization(job.id, agents.find((agent) => agent.id === job.targetAgentId)?.lifecycle?.availability === 'available')
        }
      }
      void reconcilePricing(agents.flatMap((agent) => agent.models.map((model) => model.id)))
      publishHandoffCatalog()
      mainWindow?.webContents.send(IPC.lifecycleProgress, {
        agentId: '*',
        phase: 'detecting',
        message: '基础 Agent 已就绪，ACP Agent 正在后台检查…'
      })
      return agents
    })
  void startupCoreReady.catch(() => {
    mainWindow?.webContents.send(IPC.lifecycleProgress, {
      agentId: '*',
      phase: 'failed',
      message: '基础 Agent 初始化未完成，可在设置中重新检测'
    })
  })

  // ACP probe failures settle this barrier instead of rejecting it: core
  // sessions remain usable, while protocol-provider operations fail normally as
  // agent_not_available and its durable queue stays untouched. Hydration
  // failures still reject so no persisted session mutation can race recovery.
  const protocolResult = protocolDetection.then(
    (snapshot) => ({ snapshot, error: null as unknown }),
    (error: unknown) => ({ snapshot: agentLifecycle.snapshot(), error })
  )
  void Promise.all([startupSessionHydration, coreDetection, protocolResult])
    .then(() => { if (!isQuitting) nativeAutomations.start() })
    .catch(error => recordRuntime('automations', 'native_scheduler_start_failed', error))
  startupProtocolSettled = Promise.all([startupSessionHydration, protocolResult])
    .then(([, result]) => {
      agents = agentLifecycle.snapshot().length ? agentLifecycle.snapshot() : result.snapshot
      const readyProtocolIds = new Set(agents.filter((agent) =>
        (agent.id === 'grok' || agent.id === 'kimi' || agent.id === 'deepseek' || agent.id === 'mcode' || agent.id === 'nika') && agent.lifecycle?.availability === 'available'
      ).map((agent) => agent.id))
      orchestrator.resumePendingQueues(readyProtocolIds)
      for (const job of appSettings.pendingInitializations()) {
        if (job.targetAgentId !== 'grok' && job.targetAgentId !== 'kimi' && job.targetAgentId !== 'deepseek' && job.targetAgentId !== 'mcode' && job.targetAgentId !== 'nika') continue
        const session = job.sessionId ? orchestrator.listSessions().find((item) => item.id === job.sessionId) : undefined
        if (!session || ['idle', 'error', 'cancelled', 'archived'].includes(session.status)) {
          appSettings.settleInitialization(job.id, readyProtocolIds.has(job.targetAgentId))
        }
      }
      void reconcilePricing(agents.flatMap((agent) => agent.models.map((model) => model.id)))
      publishHandoffCatalog()
      mainWindow?.webContents.send(IPC.lifecycleProgress, result.error ? {
        agentId: '*',
        phase: 'failed',
        message: 'ACP Agent 后台检查失败；其他 Agent 可正常使用，可在设置中重试'
      } : {
        agentId: '*',
        phase: 'completed',
        message: 'ACP Agent 初始化完成'
      })
      return agents
    })

  void Promise.all([startupCoreReady, startupProtocolSettled, capabilityRecoveryFlight]).then(() => {
    startupTimings.initializedMs = Math.round(process.uptime() * 1000)
    performanceMonitor?.record('startup', startupTimings)
  }).catch(() => { /* background failures have their own lifecycle and recovery feedback */ })

  // App release checks are deliberately outside the startup critical path.
  void startupProtocolSettled.then(() => orchestrator.recoverGrokForks()).catch(error => recordRuntime('grok','fork_recovery_failed',error,'warn'))
  void startupProtocolSettled.then(() => configureAppUpdateChecks(true)).catch(() => {})

  // Handoff inbox files are removed as they are consumed. Wait until ACP agents
  // have settled so an explicitly-targeted request is never misrouted to
  // a core fallback while the background probe is merely pending.
  void Promise.all([startupHandoffReady, startupSessionHydration, startupProtocolSettled])
    .then(() => {
      watchHandoffInbox(materializeHandoff)
      watchFeishuSendInbox(sendMcpPayloadToFeishu)
      watchTeamInbox((req, signal) => teams.handleTool(req.token, req.tool, req.args, signal))
    })
    .catch(() => { /* handoff setup is optional; core startup remains usable */ })

  // Auto-update performs a forced full re-detection. Start it only after the
  // startup protocol generation settles so the two cache commits cannot race.
  void startupProtocolSettled.then(() => {
    idleAgentUpdatesReady = true
    configureIdleAgentUpdates()
  }).catch(() => { /* idle updates wait for startup readiness */ })
  void startupProtocolSettled.then(async () => {
    if (e2eEnabled || !appSettings.get().autoUpdateAgentsOnLaunch) return
    const checked = await agentLifecycle.checkAllUpdates()
    const ids = checked.filter((agent) =>
      agent.lifecycle?.availability === 'available' &&
      agent.lifecycle.updateStatus === 'available' &&
      agent.lifecycle.selfUpdateSupported !== false
    ).map((agent) => agent.id)
    if (!ids.length) return
    void agentLifecycle.updateAll(ids, (id) => orchestrator.hasActiveAgentSessions(id)).then((next) => {
      agents = next
      publishHandoffCatalog()
      const failures = agentLifecycle.lastBatchFailures()
      mainWindow?.webContents.send(IPC.lifecycleProgress, { agentId: '*', phase: failures.length ? 'failed' : 'completed', message: failures.length ? `启动更新完成，${failures.length} 项失败，可重试或跳过` : '启动更新完成' })
    }).catch(() => {
      mainWindow?.webContents.send(IPC.lifecycleProgress, { agentId: '*', phase: 'failed', message: '启动更新失败，可稍后重试' })
    })
  }).catch(() => { /* session hydration failure is already surfaced above */ })
  // 后台刷新 Agent 更新状态：外部列表只暴露「可用 / 异常 / 可更新」，更新结论
  // 必须在后台保持真实，不能依赖用户手动点「重新探测」。按间隔节流，避免每次
  // 启动都访问各家注册表；检查本身静默，不阻塞启动，也不打断任何界面。
  void startupProtocolSettled.then(() => {
    if (e2eEnabled) return
    void agentUpdateStatusChecker.run().catch(() => { /* 后台检查失败不影响其它功能 */ })
  }).catch(() => { /* startup readiness failure is already surfaced above */ })
  void recovery.catch(() => {
    mainWindow?.webContents.send(IPC.lifecycleProgress, {
      agentId: '*', phase: 'failed', message: '能力恢复失败；同步功能暂不可用'
    })
  })

  // 需求4 — bring the Feishu long connection up (if configured) once sessions are
  // hydrated and core Agents are available, so restored session↔话题 maps resolve
  // and a new private message always has an Agent to accept it.
  // e2e runs skip it so the harness never opens a real WS.
  void startupCoreReady?.then(async () => {
    if (e2eEnabled) return
    await Promise.allSettled([
      appSettings.get().feishu?.enabled ? startFeishuBridgeWhenReady() : Promise.resolve(),
      appSettings.get().assistantFeishu?.enabled ? startFeishuBridgeWhenReady(assistantFeishuBridge) : Promise.resolve(),
      assistantWeixinBridge.restore()
    ])
  }).catch(() => { /* bridge is optional; core startup remains usable */ })

  // Recovery is background work after hydration; it never delays window creation
  // or the first useful frame. A native restart argument can consume one intent.
  appRestartRecovery = startupCoreReady.then(async () => {
    if (e2eEnabled) return
    await appRestart.recover(process.argv.find(arg => arg.startsWith(RESTART_ARG))?.slice(RESTART_ARG.length), process.execPath)
    appRestart.start()
  }).catch(error => recordRuntime('app', 'restart_recovery_failed', error))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(rendererReadySettled ? undefined : showStartupProgress)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Tear down every runner before exit.
let appQuitPending = false
let appQuitReady = false
app.on('before-quit', (event) => {
  if (appQuitReady) return
  if (appQuitPending) { event.preventDefault(); return }
  event.preventDefault()
  appQuitPending = true
  requirementDistiller.dispose()
  isQuitting = true
  detailWindow.close()
  const restartClosing = Promise.allSettled([appRestart.close(), comments.close()])
  const acpClosing = closeACPConnections().catch(error => recordRuntime('acp', 'shutdown_failed', error, 'warn'))
  configurePreventSleep(false)
  assistantFeishuInstaller?.cancel()
  sessionFeishuInstaller?.cancel()
  nativeAutomations.stop()
  idleAgentUpdater.stop()
  teams.close()
  if (appUpdateTimer) clearInterval(appUpdateTimer)
  stopRequirementInbox?.()
  handoffTaskStore.close()
  handoffWaits.clear()
  
  orchestrator.disposeAll()
  uiEvents.flush()
  feishuBridge.dispose()
  assistantFeishuBridge.dispose()
  const weixinClosing = assistantWeixinBridge.close()
  // Electron does not await before-quit promises. Restore Codex configuration
  // and clean up only the helpers owned by this application before exiting.
  void Promise.allSettled([restartClosing, acpClosing, weixinClosing, cliAgentSetup.close(), cancelMCodeOperation(),  zcodeInstallation.cancel(), assistantFeishuInstallFlight?.catch(() => {}), sessionFeishuInstallFlight?.catch(() => {}), uniagentManagement.close(), personalAssistant.close(), kimiOnboarding.close(), closeKimiLoginAttempts(), closeKimiWebServices(), closeDeepSeekHost(), codexSources.close(), closeClaudeSourceRuntimes(), grokQuota.close(), agentQuota.close(), orchestrator.closeZCodeRuntime(), orchestrator.closeSessionLogs(), performanceMonitor?.close()]).finally(() => { appQuitReady = true; app.quit() })
})
