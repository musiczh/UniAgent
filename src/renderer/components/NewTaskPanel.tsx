import { AssistantPicker } from './AssistantPicker'
import { resolveAgentModel, resolveAgentPermission, resolveModelEffort, resolveModelThinking, supportsModelImages } from '@shared/agentChoices'
import type { AssistantDetail } from '@shared/assistant'
import type { TeamDefinition, TeamCreateProjectInput } from '@shared/teamTypes'
import type { Requirement } from '@shared/requirementTypes'
import { RequirementPicker } from './RequirementPicker'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentDef,
  AgentPref,
  Attachment,
  HandoffPreset,
  ModelDef,
  PermissionMode,
  PickedFile,
  PrefsData,
  Project,
  ProjectGitInfo,
  ReasoningEffort,
  Session,
  SessionConfig,
  WorkspaceSelection
} from '@shared/types'
import { DEFAULT_ENABLED_AGENT_IDS } from '@shared/types'
import type {
  ComposerCommand,
  NativeReviewDraft,
  NativeThreadAction,
  NativeTurnSelectionRequest
} from '@shared/nativeCapabilities'
import {
  buildNativeCapabilityScope,
  useSlashField,
  useAttachments,
  useDismissableDetails,
  retainNativeCandidateIds,
  useNativeCapabilities
} from '../hooks'
import { SlashMenu } from './SlashMenu'
import { ComposerCapabilityChips, replaceComposerCommand } from './SkillChips'
import { NativeActionMenu } from './NativeActionMenu'
import { ReviewStartDialog } from './ReviewStartDialog'
import {
  buildComposerDelivery,
  buildNativeGoalLimits,
  NativeGoalOptions,
  type ComposerDelivery,
  type ComposerDraftSeed
} from './Composer'
import { AgentIcon } from './AgentIcon'
import { AttachmentImagePreview, AttachmentThumbnail } from './AttachmentThumbnail'
import { AgentBetaBadge } from './AgentBetaBadge'
import { SendIcon, UiIcon } from './Icons'
import { LoadBadge } from './ModelPicker'
import { SubmenuPopover } from './SubmenuPopover'
import { ProjectPicker } from './ProjectPicker'
import { MarkdownEditor } from './MarkdownEditor'
import type { ComposerPasteEvent, MarkdownInputHandle } from '../markdownInput'
import { useRequirements } from '../useRequirements'

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: 'Ultra'
}

export function resolveQuickCreateAgent<T extends { id: string }>(
  installed: T[],
  requestedAgentId?: string,
  lastAgentId?: string
): T | undefined {
  if (requestedAgentId) return installed.find((item) => item.id === requestedAgentId)
  return installed.find((item) => item.id === lastAgentId) || installed[0]
}

export function resolveRequirementProjectId(
  requirementId: string | undefined,
  requirements: Pick<Requirement, 'id' | 'projectId'>[],
  projects: Pick<Project, 'id'>[]
): string | undefined {
  const projectId = requirements.find((requirement) => requirement.id === requirementId)?.projectId
  return projects.some((project) => project.id === projectId) ? projectId : undefined
}

export function NewTaskPanel({
  agents,
  teams = [], teamUnavailableReasons = {}, onCreateTeam, onManageTeams,
  enabledAgentIds = [...DEFAULT_ENABLED_AGENT_IDS],
  requirementsEnabled = false,
  loading = false,
  loadError,
  onCreate,
  onCreateNativeAction,
  onCommitCreatedSession,
  promptPrefill,
  onOpenAssistantSettings,
  onOpenSettings,
  onRedetect,
  quickCreateSeed
}: {
  agents: AgentDef[]
  teams?: TeamDefinition[]
  teamUnavailableReasons?: Record<string, string>
  onCreateTeam?: (input: TeamCreateProjectInput) => Promise<void>
  onManageTeams?: () => void
  enabledAgentIds?: string[]
  /** 需求总开关关闭时不显示需求选择，提交时忽略已选/seed 的需求绑定。 */
  requirementsEnabled?: boolean
  loading?: boolean
  loadError?: string | null
  onCreate: (
    config: SessionConfig,
    prompt: string,
    attachments?: Attachment[],
    selection?: NativeTurnSelectionRequest,
    activatePlan?: boolean
  ) => Promise<Session>
  onCreateNativeAction?: (
    config: SessionConfig,
    action: NativeThreadAction
  ) => Promise<Session>
  onCommitCreatedSession: (session: Session, seed: ComposerDraftSeed | null) => void
  promptPrefill?: { text: string } | null
  onOpenSettings?: () => void
  onOpenAssistantSettings?: () => void
  onRedetect?: () => void
  quickCreateSeed?: (Partial<Pick<SessionConfig, 'agentId' | 'projectId' | 'requirementId'>> & { teamId?: string }) | null
}): JSX.Element {
  const available = agents.filter((a) => a.lifecycle?.availability === 'available')
  const enabledAgentIdSet = new Set(enabledAgentIds)
  const installed = available.filter((a) => enabledAgentIdSet.has(a.id))
  const [executor, setExecutor] = useState<'agent' | 'team'>(() => quickCreateSeed?.teamId || localStorage.getItem('uniagent.mode') === 'team' ? 'team' : 'agent')
  const [teamId, setTeamId] = useState(quickCreateSeed?.teamId || localStorage.getItem('ua.lastTeamId') || '')
  const team = teams.find(t => t.id === teamId)
  const teamLeader = team?.members.find(m => m.id === team.leaderMemberId)?.role
  const leaderAgent = agents.find(a => a.id === teamLeader?.agentId)
  const isTeam = executor === 'team'
  useEffect(() => { if (quickCreateSeed) setUseAssistant(false); if (quickCreateSeed?.teamId) { setExecutor('team'); setTeamId(quickCreateSeed.teamId) } else if (quickCreateSeed?.agentId) setExecutor('agent') }, [quickCreateSeed])
  const [agentId, setAgentId] = useState<string>('')
  const [useAssistant, setUseAssistant] = useState(false)
  const [assistant, setAssistant] = useState<AssistantDetail>()
  const [selectingAssistant, setSelectingAssistant] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => void window.uniagent.getPersonalAssistant().then(value => { if (active) setAssistant(value) }).catch(() => {})
    refresh()
    const stop = window.uniagent.onAssistantChanged(refresh)
    return () => { active = false; stop() }
  }, [])
  const [model, setModel] = useState<string>('')
  const [kimiThinking, setKimiThinking] = useState('')
  const [zcodeThinking, setZcodeThinking] = useState('')
  const [effort, setEffort] = useState<ReasoningEffort | ''>('')
  const [perm, setPerm] = useState<PermissionMode | undefined>()
  const [fastMode, setFastMode] = useState<boolean>(false)
  const [maxMode, setMaxMode] = useState<boolean>(false)
  // 需求补：the HOME composer mirrors the in-session status bar. The Agent menu's
  // 模型 / 推理强度 rows are entry rows: clicking one opens a second-level list to
  // its RIGHT (side-by-side), top-aligned, WITHOUT closing the main popover.
  // Re-clicking collapses it; the other row swaps the side list. Reset on close.
  const [activeSub, setActiveSub] = useState<'model' | 'effort' | 'agent' | 'team' | null>(null)
  const { requirements, loading: requirementsLoading } = useRequirements()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('default')
  const [workspaceChoice, setWorkspaceChoice] = useState<WorkspaceSelection & { projectId: string }>({ projectId: '', mode: 'local', baseRef: 'HEAD' })
  const [projectGitState, setProjectGitState] = useState<{ projectId: string; info: ProjectGitInfo }>()
  const gitProbeRef = useRef(0)
  const [requirementId, setRequirementId] = useState<string | undefined>(quickCreateSeed?.requirementId)
  // 需求开关关闭时提交不带需求绑定（忽略已选与 quickCreateSeed 的 requirementId）。
  const effectiveRequirementId = requirementsEnabled ? requirementId : undefined
  const [prompt, setPrompt] = useState<string>('')
  const [command, setCommand] = useState<ComposerCommand | null>(null)
  const [goalMaxRounds, setGoalMaxRounds] = useState('')
  const [goalTokenBudget, setGoalTokenBudget] = useState('')
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false)
  const [presets, setPresets] = useState<HandoffPreset[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const submittingRef = useRef(false)
  const agent = installed.find((a) => a.id === agentId)
  const selectedProject = projects.find((project) => project.id === projectId) || projects.find((project) => project.isDefault)
  const workspaceMode = workspaceChoice.projectId === selectedProject?.id ? workspaceChoice.mode : 'local'
  const workspaceBaseRef = workspaceChoice.projectId === selectedProject?.id ? workspaceChoice.baseRef || 'HEAD' : 'HEAD'
  const workspaceRequest = useMemo<WorkspaceSelection | undefined>(() => workspaceMode === 'worktree'
    ? { mode: 'worktree', baseRef: workspaceBaseRef, requestId: crypto.randomUUID() }
    : undefined, [workspaceMode, workspaceBaseRef, selectedProject?.id, requirementId, agentId, isTeam, teamId])
  const projectGitInfo = projectGitState && projectGitState.projectId === selectedProject?.id ? projectGitState.info : undefined
  const preparedWorktree = workspaceRequest && projectGitInfo?.pendingWorktree?.creationRequestId === workspaceRequest.requestId ? projectGitInfo?.pendingWorktree : undefined
  const workdir = preparedWorktree?.state === 'ready' ? preparedWorktree.workdir : selectedProject?.primaryDirectory || window.uniagent.homeDir || ''

  async function refreshProjectGitInfo(): Promise<void> {
    if (!selectedProject) return
    const generation = ++gitProbeRef.current
    try {
      const info = await window.uniagent.getProjectGitInfo(selectedProject.id, workspaceRequest?.requestId)
      if (generation === gitProbeRef.current) setProjectGitState({ projectId: selectedProject.id, info })
    } catch (error) {
      if (generation === gitProbeRef.current) setProjectGitState({ projectId: selectedProject.id, info: { branches: [], canCreateWorktree: false, unavailableReason: errorMessage(error) } })
    }
  }

  useEffect(() => {
    setWorkspaceChoice({ projectId: selectedProject?.id || '', mode: 'local', baseRef: 'HEAD' })
  }, [selectedProject?.id, selectedProject?.primaryDirectory])

  useEffect(() => {
    void refreshProjectGitInfo()
    return () => { gitProbeRef.current += 1 }
  }, [selectedProject?.id, selectedProject?.primaryDirectory, workspaceRequest?.requestId])
  // Persisted last-choice prefs (Doc5 T2); null until loaded.
  const prefsRef = useRef<PrefsData | null>(null)
  const handledPromptPrefillRef = useRef<{ text: string } | null>(null)
  const handledQuickCreateSeedRef = useRef<typeof quickCreateSeed>(null)
  const skipRestoreAgentRef = useRef<string | null>(null)
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const lastContractAgentRef = useRef<AgentDef | undefined>()
  const taRef = useRef<MarkdownInputHandle>(null)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  useDismissableDetails(composerBoxRef)
  // 需求5: the initial task box supports image/file attachments too.
  const {
    attachments,
    setAttachments,
    addPickedFiles,
    pasteImage,
    removeAttachment,
    previews
  } = useAttachments()
  const attachmentsRef = useRef(attachments)
  const previewsRef = useRef(previews)
  attachmentsRef.current = attachments
  previewsRef.current = previews
  const setupInfo: Record<string, { install: string; login: string; docs: string }> = {
    zcode: { install: '按官方说明准备 ZCode 运行时', login: '设置 → Agent → ZCode：填写 API Key 并检测配置', docs: 'https://github.com/zai-org/ZCode' },
    codex: { install: 'npm install -g @openai/codex', login: 'codex login', docs: 'https://developers.openai.com/codex/cli' },
    traex: { install: '按 TraeX 官方文档安装 traecli', login: 'traecli login', docs: 'https://www.trae.ai/trae-cli' },
    claude: { install: 'npm install -g @anthropic-ai/claude-code', login: 'claude auth login', docs: 'https://docs.anthropic.com/en/docs/claude-code' },
    kimi: { install: 'npm install -g @moonshot-ai/kimi-code', login: 'kimi login', docs: 'https://code.kimi.com' },
    deepseek: { install: '在设置 → Agent → DeepSeek Harness 安装', login: '在 DeepSeek Harness 设置中保存 API Key', docs: 'https://github.com/deepseek-ai/deepseek-harness' },
    grok: { install: '按 Grok CLI 官方说明安装 grok', login: 'grok login', docs: 'https://grok.com' }
  }
  const { snapshot: capabilities, ready: capabilitiesReady } = useNativeCapabilities(agentId, workdir)
  const {
    slashOpen,
    slashHits,
    activeIndex,
    setActiveIndex,
    selectedIds,
    setSelectedIds,
    pick,
    removeCandidate,
    closeSlash,
    onKeyDownSlash,
    onSelectionChange
  } = useSlashField(taRef, capabilities.candidates)
  const selectedCandidates = useMemo(
    () => selectedIds.flatMap((id) => {
      const candidate = capabilities.candidates.find((item) => item.id === id)
      return candidate ? [candidate] : []
    }),
    [capabilities.candidates, selectedIds]
  )
  const promptRef = useRef(prompt)
  const selectedIdsRef = useRef(selectedIds)
  const commandRef = useRef(command)
  const agentIdRef = useRef(agentId)
  const workdirRef = useRef(workdir)
  promptRef.current = prompt
  selectedIdsRef.current = selectedIds
  commandRef.current = command
  agentIdRef.current = agentId
  workdirRef.current = workdir

  const nativeScope = buildNativeCapabilityScope(agentId, workdir)
  const previousNativeScopeRef = useRef(nativeScope)
  useEffect(() => {
    if (previousNativeScopeRef.current === nativeScope) return
    previousNativeScopeRef.current = nativeScope
    setCommand(null)
    setSelectedIds([])
  }, [nativeScope, setSelectedIds])

  useEffect(() => {
    if (!capabilitiesReady) return
    setSelectedIds((current) => retainNativeCandidateIds(current, capabilities.candidates))
  }, [capabilities.candidates, capabilitiesReady, setSelectedIds])

  function restoreAgentChoices(
    nextAgent: AgentDef,
    preset?: HandoffPreset,
    preserveCurrent = false
  ): void {
    if (submittingRef.current) return
    const pref = prefsRef.current?.lastByAgent?.[nextAgent.id]
    const nextModelDef = resolveAgentModel(nextAgent,
      preset?.model,
      preserveCurrent ? model : undefined,
      pref?.defaultModel
    )
    const nextModel = nextModelDef?.id || ''
    const modes = permissionModesForNewTask(nextAgent)
    const nextEffort = nextAgent.capabilities.reasoningEffort ? resolveModelEffort(nextModelDef,
      preset?.effort,
      preserveCurrent ? effort || undefined : undefined,
      pref?.defaultEffort
    ) || '' : ''
    const nextPermission = [
      preset?.permissionMode,
      preserveCurrent ? perm : undefined,
      pref?.permissionMode
    ].find((value) => !!value && modes.some((item) => item.id === value))

    setModel(nextModel)
    setEffort(nextEffort)
    if (nextAgent.adapter === 'zcode') setZcodeThinking(resolveModelThinking(nextModelDef, preserveCurrent ? zcodeThinking : undefined, pref?.defaultThinking, pref?.defaultEffort) || '')
    if (nextAgent.adapter === 'kimi') setKimiThinking(resolveModelThinking(nextModelDef, preserveCurrent ? kimiThinking : undefined, pref?.defaultThinking, pref?.defaultEffort) || '')
    setPerm(nextPermission || modes[0]?.id)
    if (!preserveCurrent) {
      setFastMode(nextAgent.adapter === 'codex' ? !!pref?.fastMode : false)
      setMaxMode((nextAgent.adapter === 'traex' || nextAgent.adapter === 'mcode') && !!nextModelDef?.supportsMax ? !!pref?.maxMode : false)
    }
  }

  function applyPreset(preset: HandoffPreset): void {
    guardNewTaskConfigurationMutation(submittingRef.current, () => {
      const nextAgent =
        (preset.agentId ? installed.find((item) => item.id === preset.agentId) : undefined) ||
        installed.find((item) => item.id === agentId) ||
        installed[0]
      if (!nextAgent) return
      setPrompt(preset.prompt)
      const switchingAgent = nextAgent.id !== agentId
      if (switchingAgent) {
        skipRestoreAgentRef.current = nextAgent.id
        selectAgent(nextAgent.id)
      }
      restoreAgentChoices(nextAgent, preset, !switchingAgent)
      requestAnimationFrame(() => taRef.current?.focus())
    })
  }

  useEffect(() => {
    const claim = claimNewTaskOneShotInput(
      promptPrefill,
      handledPromptPrefillRef.current,
      submittingRef.current
    )
    handledPromptPrefillRef.current = claim.claimed
    if (!promptPrefill || !claim.shouldApply) return
    setPrompt(promptPrefill.text)
  }, [promptPrefill])

  // Load persisted prefs once, then pick the last-used agent (Doc5 T2).
  useEffect(() => {
    let cancelled = false
    window.uniagent.getPrefs().then((p) => {
      if (cancelled) return
      prefsRef.current = p
      setPrefsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadProjects = (): void => { void window.uniagent.listProjects().then((next) => {
      if (cancelled) return
      setProjects(next)
      setProjectId((current) => next.some((project) => project.id === current)
        ? current
        : next.find((project) => project.isDefault)?.id || 'default')
    }) }
    loadProjects()
    window.addEventListener('uniagent-projects-changed', loadProjects)
    return () => {
      cancelled = true
      window.removeEventListener('uniagent-projects-changed', loadProjects)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadPresets = (): void => { void window.uniagent.listPresets().then((next) => {
      if (!cancelled) setPresets(next)
    }) }
    loadPresets()
    window.addEventListener('uniagent-presets-changed', loadPresets)
    return () => {
      cancelled = true
      window.removeEventListener('uniagent-presets-changed', loadPresets)
    }
  }, [])

  // A fresh object represents a fresh quick-create request, including when this
  // panel was already open.
  useEffect(() => {
    if (!prefsLoaded || !projects.length || (quickCreateSeed?.requirementId && requirementsLoading)) return
    const claim = claimNewTaskOneShotInput(
      quickCreateSeed,
      handledQuickCreateSeedRef.current,
      submittingRef.current
    )
    handledQuickCreateSeedRef.current = claim.claimed
    if (!quickCreateSeed || !claim.shouldApply) return
    setRequirementId(quickCreateSeed?.requirementId)
    const requestedAgentId = quickCreateSeed?.agentId
    const nextAgent = resolveQuickCreateAgent(
      installed,
      requestedAgentId,
      agentId || prefsRef.current?.lastAgentId
    )
    skipRestoreAgentRef.current = null
    setProjectId(
      quickCreateSeed.projectId && projects.some((project) => project.id === quickCreateSeed.projectId)
        ? quickCreateSeed.projectId
        : resolveRequirementProjectId(quickCreateSeed.requirementId, requirements, projects) || projects.find((project) => project.isDefault)?.id || 'default'
    )
    setSelectedIds([])
    setCommand(null)
    if (!nextAgent) {
      setAgentId('')
      setSubmitError(
        requestedAgentId
          ? `指定 Agent 当前不可用：${requestedAgentId}`
          : '当前没有可用的 Agent'
      )
      return
    }
    setAgentId(nextAgent.id)
    restoreAgentChoices(nextAgent, undefined, nextAgent.id === agentId)
    setSubmitError('')
  }, [agents, prefsLoaded, projects, quickCreateSeed, requirements, requirementsLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Default agent selection: last-used (if installed) → first installed. Waits
  // for prefs so the very first render restores the user's real last agent.
  useEffect(() => {
    if (!prefsLoaded) return
    if (agentId && installed.some((item) => item.id === agentId)) return
    if (!installed.length) {
      if (agentId) setAgentId('')
      return
    }
    const last = prefsRef.current?.lastAgentId
    const requestedAgentId = quickCreateSeed?.agentId
    const nextAgent = resolveQuickCreateAgent(installed, requestedAgentId, last)
    setAgentId(nextAgent?.id || '')
  }, [installed, agentId, prefsLoaded, quickCreateSeed])

  const selectAgent = (nextAgentId: string): boolean => {
    if (!installed.some((item) => item.id === nextAgentId)) return false
    if (submittingRef.current) return false
    setUseAssistant(false)
    setExecutor('agent'); localStorage.setItem('uniagent.mode', 'session')
    if (nextAgentId === agentId) return true
    return guardNewTaskConfigurationMutation(submittingRef.current, () => {
      setAgentId(nextAgentId)
    })
  }
  const permissionModes = permissionModesForNewTask(agent)
  // Optional capability fields preserve the legacy providers' existing support.
  // Protocol-native providers set these explicitly at handshake.
  const canAttachImages = supportsAttachment(isTeam ? leaderAgent : agent, 'imageAttachments') && (isTeam || supportsModelImages(agent, model))
  const canAttachFiles = supportsAttachment(isTeam ? leaderAgent : agent, 'fileAttachments')
  const attachmentCapabilitiesRef = useRef({ images: canAttachImages, files: canAttachFiles })
  attachmentCapabilitiesRef.current = { images: canAttachImages, files: canAttachFiles }
  const supportedAttachmentEntries = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) =>
      attachment.kind === 'image' ? canAttachImages : canAttachFiles
    )
  const supportedAttachments = supportedAttachmentEntries.map(({ attachment }) => attachment)
  // 图片详情: index within the bar's image list; null = lightbox closed.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const imagePreviewEntries = supportedAttachmentEntries
    .filter(({ attachment }) => attachment.kind === 'image')
    .map(({ attachment }) => ({ attachment, src: previews[attachment.path] }))

  // Keep draft attachments on executor changes. Unsupported files are explicit,
  // removable, and block submission rather than silently disappearing.
  const incompatibleAttachments = attachments.filter(a => a.kind === 'image' ? !canAttachImages : !canAttachFiles)

  // The currently-selected model definition (drives the effort options).
  const modelDef: ModelDef | undefined = useMemo(
    () => agent?.models.find((m) => m.id === model),
    [agent, model]
  )

  // When the agent changes, restore its valid defaults. A pending task template
  // wins once, after which the Settings defaults apply.
  useEffect(() => {
    if (!agent) return
    if (skipRestoreAgentRef.current === agent.id) {
      skipRestoreAgentRef.current = null
      return
    }
    restoreAgentChoices(agent)
  }, [agentId, prefsLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // A live ACP handshake can replace models/modes without changing agentId.
  // Preserve an in-progress valid choice, but immediately discard values the
  // newly negotiated contract no longer offers. The agent-switch effect above
  // remains responsible for restoring per-agent preferences.
  useEffect(() => {
    const previous = lastContractAgentRef.current
    lastContractAgentRef.current = agent
    if (!agent || !previous || previous.id !== agent.id || submittingRef.current) return
    setModel((current) =>
      current && agent.models.some((entry) => entry.id === current)
        ? current
        : resolveAgentModel(agent, prefsRef.current?.lastByAgent[agent.id]?.defaultModel)?.id || ''
    )
    const modes = permissionModesForNewTask(agent)
    setPerm((current) => modes.some((entry) => entry.id === current) ? current : modes[0]?.id)
  }, [agent])

  // When the model changes, constrain the effort to what THAT model supports.
  useEffect(() => {
    if (submittingRef.current) return
    if (!modelDef || modelDef.efforts.length === 0) {
      setEffort('')
      return
    }
    setEffort(cur => resolveModelEffort(modelDef, cur, prefsRef.current?.lastByAgent[agentId]?.defaultEffort) || '')
  }, [model, modelDef])

  // A remembered Max choice must never leak onto a model without a Max variant.
  useEffect(() => {
    if (submittingRef.current) return
    if ((agent?.adapter !== 'traex' && agent?.adapter !== 'mcode') || !modelDef?.supportsMax) setMaxMode(false)
  }, [agent?.adapter, modelDef])

  async function addSupportedFiles(): Promise<void> {
    if (!canAttachImages && !canAttachFiles) return
    const files = await window.uniagent.pickFiles()
    const capabilities = attachmentCapabilitiesRef.current
    const picked = files
      .filter((attachment) =>
        attachment.kind === 'image' ? capabilities.images : capabilities.files
      )
    addPickedFiles(picked)
  }

  async function changeAssistant(enabled: boolean): Promise<void> {
    if (submittingRef.current) return
    if (enabled) {
      if (!assistant?.assistant.enabled) return
      const target = installed.find(a => a.id === assistant.assistant.defaultAgentId)
      if (!target) { setSubmitError('个人助手默认 Agent 当前不可用，请到设置重新选择'); return }
      if (assistant.assistant.defaultModel && !target.models.some(m => m.id === assistant.assistant.defaultModel)) { setSubmitError('个人助手默认模型已不可用，请到设置重新选择'); return }
      if (assistant.assistant.defaultPermissionMode && !target.capabilities.permissionModes.some(mode => mode.id === assistant.assistant.defaultPermissionMode)) { setSubmitError('个人助手默认权限已不可用，请到设置重新选择'); return }
      submittingRef.current = true; setSelectingAssistant(true)
      try {
        const project = await window.uniagent.getAssistantWorkspace()
        setProjects(current => current.some(item => item.id === project.id) ? current.map(item => item.id === project.id ? project : item) : [...current, project])
        setProjectId(project.id); setRequirementId('')
        setWorkspaceChoice({ projectId: project.id, mode: 'local', baseRef: 'HEAD' })
        skipRestoreAgentRef.current = target.id
        setAgentId(target.id)
        const pref = prefsRef.current?.lastByAgent[target.id]
        const selected = resolveAgentModel(target, assistant.assistant.defaultModel, pref?.defaultModel)
        setModel(selected?.id || '')
        setEffort(target.capabilities.reasoningEffort ? resolveModelEffort(selected, pref?.defaultEffort) || '' : '')
        setKimiThinking(target.adapter === 'kimi' ? resolveModelThinking(selected, pref?.defaultThinking, pref?.defaultEffort) || '' : '')
        setZcodeThinking(target.adapter === 'zcode' ? resolveModelThinking(selected, pref?.defaultThinking, pref?.defaultEffort) || '' : '')
        setPerm(resolveAgentPermission(target, assistant.assistant.defaultPermissionMode, 'ask'))
        setExecutor('agent'); localStorage.setItem('uniagent.mode', 'session')
        setUseAssistant(true); setSubmitError('')
      } catch (error) { setSubmitError(errorMessage(error)) }
      finally { submittingRef.current = false; setSelectingAssistant(false) }
      return
    }
    setUseAssistant(enabled)
  }

  function handlePaste(e: ComposerPasteEvent): void {
    if (!canAttachImages) return
    // A capability/executor change while paste resolves must not erase existing drafts.
    void pasteImage(e)
  }

  function resolveSubmissionConfig(): { config: SessionConfig; pref: AgentPref } | null {
    if (!agent || !selectedProject || agent.incompatible) return null
    if (workspaceMode === 'worktree' && !projectGitInfo?.canCreateWorktree) return null

    // Agent/model effects run after render, so a quick switch + submit can still
    // observe the previous agent's state. Resolve every outgoing choice against
    // the agent selected for this submission instead of trusting that state.
    const defaults = prefsRef.current?.lastByAgent[agent.id]
    const chosenModelDef = resolveAgentModel(agent, model, defaults?.defaultModel)
    const chosenModel = chosenModelDef?.id
    const chosenEffort = agent.capabilities.reasoningEffort ? resolveModelEffort(chosenModelDef, effort, defaults?.defaultEffort) : undefined
    const chosenThinking = resolveModelThinking(chosenModelDef, agent.adapter === 'zcode' ? zcodeThinking : kimiThinking, defaults?.defaultThinking, defaults?.defaultEffort)
    const chosenPerm = resolveNewTaskPermission(agent, perm)
    if (!chosenPerm) return null
    const useFast = agent.adapter === 'codex' && fastMode
    const useMax = (agent.adapter === 'traex' || agent.adapter === 'mcode') && !!chosenModelDef?.supportsMax && maxMode
    const pref: AgentPref = {
      model: chosenModel,
      effort: chosenEffort,
      ...(agent.adapter === 'zcode' ? { zcodeThinking: chosenThinking } : {}),
      // Explicit undefined clears any stale pre-negotiation permission preference
      // when PrefsStore merges this object with the previous choice.
      permissionMode: chosenPerm,
      fastMode: useFast,
      maxMode: useMax
    }
    return {
      config: {
        agentId,
        ...(useAssistant && !isTeam ? { useAssistant: true } : {}),
        model: chosenModel,
        modelSource: chosenModelDef?.modelSource,
        effort: agent.adapter === 'zcode' ? undefined : chosenEffort,
        ...(agent.adapter === 'kimi' ? { kimiThinking: chosenThinking } : {}),
        ...(agent.adapter === 'zcode' && chosenModelDef?.zcodeSelection ? { zcodeModelSelection: { ...chosenModelDef.zcodeSelection,
          options: { ...chosenModelDef.zcodeSelection.options, reasoningLevel: chosenThinking } } } : {}),
        projectId: selectedProject.id,
        ...(workspaceRequest ? { workspaceSelection: workspaceRequest } : {}),
        requirementId: effectiveRequirementId,
        workdir,
        additionalDirectories: [...selectedProject.additionalDirectories],
        permissionMode: chosenPerm,
        fastMode: useFast,
        maxMode: useMax
      },
      pref
    }
  }

  function persistSubmissionPref(pref: AgentPref): void {
    if (!agent) return
    void window.uniagent.setPrefs(agent.id, pref).then((next) => {
      prefsRef.current = next
    })
  }

  async function submit(): Promise<void> {
    if (submittingRef.current) return
    if (workspaceMode === 'worktree' && !projectGitInfo?.canCreateWorktree) { setSubmitError(projectGitInfo?.unavailableReason || '请等待分支加载完成'); return }
    if (incompatibleAttachments.length) { setSubmitError('当前执行方不支持部分附件，请移除附件或切换执行方'); return }
    if (isTeam) {
      if (!team || team.status !== 'active' || teamUnavailableReasons[team.id] || !selectedProject || !onCreateTeam) { setSubmitError('请选择已启用的专家团'); return }
      if (command || selectedIds.length) { setSubmitError('专家团不支持单 Agent 原生命令或能力选择；请先移除，正文与附件会保留'); return }
      if (!prompt.trim()) return
      submittingRef.current = true; setSubmitting(true); setSubmitError('')
      try { await onCreateTeam({ teamId: team.id, spaceId: selectedProject.id, requirementId: effectiveRequirementId, prompt, attachments, ...(workspaceRequest ? { workspaceSelection: workspaceRequest } : {}) }) }
      catch (e) { setSubmitError(errorMessage(e)); if (workspaceRequest) await refreshProjectGitInfo() }
      finally { submittingRef.current = false; setSubmitting(false) }
      return
    }
    const resolved = resolveSubmissionConfig()
    if (!resolved) return
    const outgoingAttachments = attachments.filter((attachment) =>
      attachment.kind === 'image' ? canAttachImages : canAttachFiles
    )
    const delivery = buildComposerDelivery(command, prompt, outgoingAttachments, selectedIds)
    if (!delivery) return
    if (delivery.kind === 'goal') {
      try { Object.assign(delivery.action, buildNativeGoalLimits(agent?.adapter, { maxRounds: goalMaxRounds, tokenBudget: goalTokenBudget })) }
      catch (error) { setSubmitError(errorMessage(error)); return }
    }
    persistSubmissionPref(resolved.pref)
    const submittedDraft = snapshotNewTaskDraft({
      agentId,
      workdir,
      text: prompt,
      command,
      candidateIds: selectedIds,
      attachments,
      previews
    })
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError('')
    try {
      if (!onCreateNativeAction && delivery.kind === 'goal') throw new Error('当前无法创建 Goal')
      await completeNewTaskCreation({
        create: () => dispatchNewTaskDelivery(
          resolved.config,
          delivery,
          {
            create: onCreate,
            createNativeAction: onCreateNativeAction || (async () => {
              throw new Error('当前无法创建 Goal')
            })
          }
        ),
        kind: delivery.kind,
        submitted: submittedDraft,
        current: currentNewTaskDraft,
        commit: onCommitCreatedSession
      })
    } catch (error: unknown) {
      setSubmitError(errorMessage(error))
      if (workspaceRequest) await refreshProjectGitInfo()
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  async function startReview(draft: NativeReviewDraft): Promise<void> {
    if (submittingRef.current) return
    const resolved = resolveSubmissionConfig()
    if (!resolved || !onCreateNativeAction) return
    persistSubmissionPref(resolved.pref)
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError('')
    const submittedDraft = currentNewTaskDraft()
    try {
      await completeNewTaskCreation({
        create: () => onCreateNativeAction(resolved.config, { type: 'review.start', draft }),
        kind: 'review',
        submitted: submittedDraft,
        current: currentNewTaskDraft,
        commit: onCommitCreatedSession
      })
    } catch (error: unknown) {
      setSubmitError(errorMessage(error))
      if (workspaceRequest) await refreshProjectGitInfo()
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  function currentNewTaskDraft(): NewTaskDraftSnapshot {
    return snapshotNewTaskDraft({
      agentId: agentIdRef.current,
      workdir: workdirRef.current,
      text: promptRef.current,
      command: commandRef.current,
      candidateIds: selectedIdsRef.current,
      attachments: attachmentsRef.current,
      previews: previewsRef.current
    })
  }

  if (loadError) {
    return (
      <div className="new-task startup-loading" role="alert">
        <h1>暂时无法新建任务</h1>
        <p>{loadError}</p>
        <span>已保存的会话不会被覆盖。</span>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="new-task startup-loading" role="status" aria-live="polite">
        <div className="startup-loading-mark">
          <span className="loading-spinner" aria-hidden />
        </div>
        <h1>UniAgent 已启动</h1>
        <p>正在加载会话并检查本机 Agent…</p>
        <span>界面已就绪，完成后即可新建任务</span>
      </div>
    )
  }

  if (available.length === 0) {
    const incompatible = agents.filter((a) => a.incompatible)
    return (
      <div className="new-task first-setup">
        <div className="first-setup-hero">
          <span className="first-setup-badge" aria-hidden>
            <UiIcon name="plug" size={26} />
          </span>
          <h1>还没有检测到可用的 Coding Agent</h1>
          <p>安装并登录任意一个 Agent CLI 即可开始。如果你确定已经安装，点「重新检测」刷新一次即可。</p>
          <div className="first-setup-hero-actions">
            <button className="first-setup-redetect" onClick={onRedetect} disabled={loading}>
              {loading ? <span className="loading-spinner" aria-hidden /> : <UiIcon name="refresh" size={15} />}
              重新检测
            </button>
            <button className="first-setup-open-settings" onClick={onOpenSettings}>
              <UiIcon name="settings" size={15} /> 打开设置
            </button>
          </div>
        </div>
        {incompatible.length > 0 && (
          <div className="first-setup-incompatible">
            {incompatible.map((item) => (
              <p key={item.id}>
                <strong>{item.name}</strong> 已安装但不兼容
                {item.unavailableReason ? `：${item.unavailableReason}` : '。'}
              </p>
            ))}
          </div>
        )}
        <div className="first-setup-cards">
          {agents.map((item) => {
            const info = setupInfo[item.id] || setupInfo[item.adapter]
            const isZCode = item.adapter === 'zcode'
            const status = item.lifecycle?.availability === 'needs-auth'
              ? { text: '已安装 · 待登录', cls: 'auth' }
              : item.installed
                ? { text: '健康检查未通过', cls: 'warn' }
                : { text: '未安装', cls: 'off' }
            return (
              <div className="first-setup-card" key={item.id}>
                <div className="first-setup-card-head">
                  <AgentIcon agentId={item.id} adapter={item.adapter} size={20} />
                  <strong>{item.name}</strong>
                  <span className={`first-setup-pill ${status.cls}`}>{status.text}</span>
                </div>
                <div className="first-setup-step">
                  <span className="first-setup-step-label">安装：</span>
                  <div className="first-setup-cmd">
                    <code>{info?.install}</code>
                    <button onClick={() => navigator.clipboard.writeText(info?.install || '')}>
                      <UiIcon name="copy" size={12} /> {isZCode ? '复制安装说明' : '复制安装命令'}
                    </button>
                  </div>
                </div>
                <div className="first-setup-step">
                  <span className="first-setup-step-label">{isZCode ? '配置：' : '登录：'}</span>
                  <div className="first-setup-cmd">
                    <code>{info?.login}</code>
                    <button onClick={() => navigator.clipboard.writeText(info?.login || '')}>
                      <UiIcon name="copy" size={12} /> {isZCode ? '复制配置说明' : '复制登录命令'}
                    </button>
                  </div>
                </div>
                <button className="first-setup-docs" onClick={() => window.uniagent.openExternal(info?.docs)}>
                  官方说明 <UiIcon name="external-link" size={12} />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const kimi = agent?.adapter === 'kimi'
  const nativeThinking = kimi || agent?.adapter === 'zcode'
  const efforts = nativeThinking ? modelDef?.thinkingOptions || [] : modelDef?.efforts || []
  const thinking = agent?.adapter === 'zcode' ? zcodeThinking : kimiThinking
  const selectedThinking = resolveModelThinking(modelDef, thinking, prefsRef.current?.lastByAgent[agentId]?.defaultThinking, prefsRef.current?.lastByAgent[agentId]?.defaultEffort)
  const effortLabel = (value: string): string => kimi ? value : EFFORT_LABEL[value as ReasoningEffort] || value
  const selectedEffort = nativeThinking ? selectedThinking : resolveModelEffort(modelDef, effort, prefsRef.current?.lastByAgent[agentId]?.defaultEffort)
  const effortDisabled = (!nativeThinking && !agent?.capabilities.reasoningEffort) || efforts.length === 0
  const modelLabel = modelDef?.label || '无可用模型'
  // 需求补9 — mirror the in-session status bar: fast toggle only for codex models
  // advertising the priority tier; max toggle only for traex models with a Max
  // variant.
  const showFast =
    agent?.adapter === 'codex' &&
    (modelDef ? !!modelDef.supportsFast : agent.models.some((m) => m.supportsFast))
  const showMax = (agent?.adapter === 'traex' || agent?.adapter === 'mcode') && !!modelDef?.supportsMax
  // MiniMax Code calls the large context window "1M" instead of "Max".
  const mcodeMax = agent?.adapter === 'mcode'

  return (
    <div className="new-task">
      <div className="drag-region" />
      <h1 className="hero">一个 App，驱动所有 Coding Agent</h1>
      <div className="composer-box big" ref={composerBoxRef}>
        <ComposerCapabilityChips
          command={command}
          candidates={selectedCandidates}
          onRemoveCommand={() => setCommand(null)}
          onRemoveCandidate={removeCandidate}
        />
        {supportedAttachments.length > 0 && (
          <div className="attach-bar">
            {supportedAttachmentEntries.map(({ attachment: a, index }) => (
              a.kind === 'image' ? (
                <AttachmentThumbnail
                  key={`${a.path}-${index}`}
                  name={a.name}
                  src={previews[a.path]}
                  onOpen={() => {
                    const position = imagePreviewEntries.findIndex((entry) => entry.attachment.path === a.path)
                    if (position >= 0) setPreviewIndex(position)
                  }}
                  onRemove={() => { if (!submittingRef.current) removeAttachment(index) }}
                />
              ) : (
                <span key={`${a.path}-${index}`} className="attach-chip attach-file" title={a.path}>
                  <UiIcon name="paperclip" size={12} /> {a.name}
                  <button className="attach-x" aria-label={`移除 ${a.name}`} onClick={() => { if (!submittingRef.current) removeAttachment(index) }}>
                    <UiIcon name="close" size={12} />
                  </button>
                </span>
              )
            ))}
          </div>
        )}
        {previewIndex !== null && (
          <AttachmentImagePreview
            entries={imagePreviewEntries}
            index={previewIndex}
            onIndexChange={setPreviewIndex}
            onClose={() => setPreviewIndex(null)}
          />
        )}
        <div className="composer-main">
          {command === 'goal' && ['deepseek', 'grok', 'kimi', 'mcode'].includes(agent?.adapter || '') && <NativeGoalOptions provider={agent?.adapter} value={agent?.adapter === 'grok' ? goalTokenBudget : goalMaxRounds} disabled={submitting} onChange={agent?.adapter === 'grok' ? setGoalTokenBudget : setGoalMaxRounds} />}
          {slashOpen && !isTeam && (
            <SlashMenu
              hits={slashHits}
              totalCount={capabilities.candidates.length}
              onPick={pick}
              onClose={closeSlash}
              activeIndex={activeIndex}
              setActiveIndex={setActiveIndex}
            />
          )}
          <MarkdownEditor
            ref={taRef}
            className="prompt-input"
            placeholder={
              isTeam ? '描述任务，让专家团一起完成…（⌘⏎ 发送）' : canAttachImages
                ? '描述你想让 Agent 完成的任务…（/ 唤起 Skill·MCP，⌘⏎ 发送，可粘贴图片）'
                : '描述你想让 Agent 完成的任务…（/ 唤起 Skill·MCP，⌘⏎ 发送）'
            }
            disabled={submitting && (isTeam || workspaceMode === 'worktree')}
            value={prompt}
            onChange={setPrompt}
            onPaste={handlePaste}
            onSelectionChange={onSelectionChange}
            onKeyDown={(e) => {
              if (e.isComposing) return
              if (!isTeam && onKeyDownSlash(e)) return
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            minHeight={90}
            autoFocus
          />
        </div>
        <div className="config-bar">
          <details className="sb-menu sb-add" name="new-task-menu">
            <summary className="sb-add-btn" title="功能、模板与附件" aria-label="功能、模板与附件"><UiIcon name="plus" size={18} /></summary>
            <div className="sb-menu-pop">
              {(canAttachImages || canAttachFiles) && (
                <button type="button" className="sb-menu-item" onClick={(e) => {
                  e.currentTarget.closest('details')?.removeAttribute('open')
                  void addSupportedFiles()
                }}><UiIcon name="paperclip" size={14} /> 添加附件</button>
              )}
              <NativeActionMenu
                actions={capabilities.actions}
                disabled={isTeam || !agent || !!agent.incompatible}
                reviewDisabled={isTeam || submitting || !agent || !!agent.incompatible}
                onSelectCommand={(next) => {
                  setCommand((current) => replaceComposerCommand(current, next))
                  setReviewDialogOpen(false)
                  composerBoxRef.current?.querySelector('.sb-add')?.removeAttribute('open')
                  requestAnimationFrame(() => taRef.current?.focus())
                }}
                onOpenReview={() => {
                  setReviewDialogOpen(true)
                  composerBoxRef.current?.querySelector('.sb-add')?.removeAttribute('open')
                }}
              />
              {presets.length > 0 && (
                <label className="cfg sb-menu-field">
                  <span>任务模板</span>
                  <select aria-label="任务模板" value="" disabled={isTeam || !prefsLoaded || submitting} onChange={(e) => {
                    const preset = presets.find((item) => item.id === e.target.value)
                    if (preset) applyPreset(preset)
                    e.currentTarget.closest('details')?.removeAttribute('open')
                  }}>
                    <option value="">选择模板</option>
                    {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                  </select>
                </label>
              )}
              {!canAttachImages && !canAttachFiles && presets.length === 0 &&
                !capabilities.actions.goal && !capabilities.actions.review && !capabilities.actions.plan && (
                <span className="sb-menu-empty">暂无可添加内容</span>
              )}
            </div>
          </details>
          <ProjectPicker
            projects={projects}
            projectId={selectedProject?.id || projectId}
            disabled={submitting}
            workspaceSelection={{ mode: workspaceMode, baseRef: workspaceBaseRef }}
            gitInfo={projectGitInfo}
            onWorkspaceChange={(mode, baseRef) => guardNewTaskConfigurationMutation(submittingRef.current, () => setWorkspaceChoice({ projectId: selectedProject?.id || projectId, mode, baseRef }))}
            onSelect={(project) => guardNewTaskConfigurationMutation(submittingRef.current, () => setProjectId(project.id))}
            onProjectsChange={setProjects}
          />

          {requirementsEnabled && <RequirementPicker value={requirementId} disabled={submitting} onChange={id => guardNewTaskConfigurationMutation(submittingRef.current, () => {
            setRequirementId(id)
            const boundProjectId = resolveRequirementProjectId(id, requirements, projects)
            if (boundProjectId) setProjectId(boundProjectId)
          })} />}

          {!isTeam && permissionModes.length > 0 && (
            <label className="cfg">
              <span>权限</span>
              <select
                value={perm || ''}
                disabled={submitting}
                onChange={(e) => guardNewTaskConfigurationMutation(
                  submittingRef.current,
                  () => setPerm(e.target.value as PermissionMode)
                )}
                title={permissionModes.find((p) => p.id === perm)?.hint}
              >
                {permissionModes.map((p) => <option key={p.id} value={p.id} title={p.hint}>{p.label}</option>)}
              </select>
            </label>
          )}

          <details
            className="sb-menu sb-agent"
            name="new-task-menu"
            data-agent-id={agentId}
            data-agent-name={agent?.name || ''}
            data-model={model}
            data-model-label={modelLabel}
            data-effort={effort}
            data-config-locked={submitting || undefined}
            onToggle={(e) => {
              if (!(e.currentTarget as HTMLDetailsElement).open) setActiveSub(null)
            }}
          >
            <summary
              className="sb-effort-btn nt-mode-trigger"
              aria-label="选择执行方" title={submitting ? '创建中，运行配置已锁定' : '执行方、模型与推理设置'}
              aria-disabled={submitting}
              onClick={(event) => { if (submittingRef.current) event.preventDefault() }}
            >
              {isTeam ? <><UiIcon name="users" size={14} /><span className="sb-effort-model">{team?.name || '选择专家团'}</span><span className="sb-effort-lvl">专家团</span></> : <>{showFast && fastMode && <span className="sb-flash" aria-hidden><UiIcon name="zap" size={13} /></span>}
              <span className="sb-effort-ico" aria-hidden>{useAssistant ? <UiIcon name="identity" size={14} /> : <AgentIcon agentId={agentId} adapter={agent?.adapter} size={14} />}</span>
              {useAssistant ? <span className="sb-effort-model">个人助手</span> : agent?.capabilities.modelSelect ? (
                <span className="sb-effort-model">{modelLabel}</span>
              ) : (
                <span className="sb-effort-model">{agent?.name || '选择 Agent'}</span>
              )}
              {typeof modelDef?.loadPercent === 'number' && <LoadBadge percent={modelDef.loadPercent} />}
              {(nativeThinking || agent?.capabilities.reasoningEffort) && selectedEffort && (
                <span className="sb-effort-lvl">{effortLabel(selectedEffort)}</span>
              )}
              {showMax && maxMode && <span className="sb-maxtag" aria-hidden>Max</span>}</>}
            </summary>
            <div className="sb-menu-pop nt-mode-menu">
              <div className="sb-menu-label">执行方</div>
              <div className="sb-sub-wrap">
                <button type="button" className={'sb-menu-item sb-sub-entry ' + (activeSub === 'team' ? 'is-sub-open' : '')} disabled={submitting} aria-expanded={activeSub === 'team'} onClick={() => setActiveSub(s => s === 'team' ? null : 'team')}><UiIcon name="users" size={14} /><span className="sb-entry-body">专家团<small>由 Leader 统一与你沟通</small></span><UiIcon name="chevron-right" size={13} /></button>
                {activeSub === 'team' && <SubmenuPopover><div className="sb-menu-label">专家团</div>{teams.filter(t => t.status !== 'archived').map(t => <button key={t.id} type="button" className={'sb-menu-item sb-sub-opt ' + (isTeam && t.id === teamId ? 'is-sel' : '')} disabled={submitting || t.status !== 'active' || !!teamUnavailableReasons[t.id]} title={teamUnavailableReasons[t.id]} onClick={() => { if (submittingRef.current) return; setTeamId(t.id); setExecutor('team'); setUseAssistant(false); setSubmitError(''); localStorage.setItem('uniagent.mode', 'team'); localStorage.setItem('ua.lastTeamId', t.id) }}><span className="sb-sub-radio" /><span className="sb-entry-body">{t.name}<small>{teamUnavailableReasons[t.id] || (t.status === 'draft' ? '草稿 · 请先启用' : (t.members.find(m => m.id === t.leaderMemberId)?.role.name || '') + ' · Leader · ' + t.members.length + ' 人')}</small></span></button>)}{!teams.some(t => t.status === 'active') && <div className="sb-menu-label">暂无已启用的专家团</div>}<div className="sb-menu-sep" /><button type="button" className="sb-menu-item" onClick={onManageTeams}><UiIcon name="settings" size={14} />管理专家团</button></SubmenuPopover>}
              </div>
              {/* Agent picker — home-only entry row (in-session locks the agent). */}
              <div className="sb-sub-wrap">
                <button
                  type="button"
                  className={`sb-menu-item sb-sub-entry ${activeSub === 'agent' ? 'is-sub-open' : ''}`}
                  disabled={submitting}
                  aria-expanded={activeSub === 'agent'}
                  onClick={() => setActiveSub((s) => (s === 'agent' ? null : 'agent'))}
                >
                  <span className="cfg-agent-icon"><AgentIcon agentId={agentId} adapter={agent?.adapter} size={14} /></span>
                  <span className="sb-entry-body">
                    Agent
                    <small>{useAssistant && !isTeam ? '个人助手 · ' : ''}{agent?.name || '选择 Agent'}</small>
                  </span>
                  <UiIcon name="chevron-right" size={13} className="sb-entry-chev" />
                </button>
                {activeSub === 'agent' && (
                  <SubmenuPopover>
                    <div className="sb-menu-label sb-sub-title">Agent</div>
                    <AssistantPicker enabled={useAssistant && !isTeam} available={!!assistant?.assistant.enabled} disabled={submitting || selectingAssistant} onChange={enabled => void changeAssistant(enabled)} onManage={() => (onOpenAssistantSettings || onOpenSettings)?.()}>
                    {!installed.length && <span className="sb-menu-empty">没有已启用的 Agent</span>}
                    {installed.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={!isTeam && !useAssistant && item.id === agentId}
                        className={`sb-menu-item sb-sub-opt ${!isTeam && !useAssistant && item.id === agentId ? 'is-sel' : ''}`}
                        disabled={submitting || selectingAssistant}
                        onClick={() => selectAgent(item.id)}
                      >
                        <span className="sb-sub-radio" aria-hidden />
                        <span className="sb-entry-body">
                          <span className="sb-agent-name">
                            <AgentIcon agentId={item.id} adapter={item.adapter} size={14} />
                            <span className="sb-agent-name-label">{item.name}</span>
                            <AgentBetaBadge agentId={item.id} />
                          </span>
                        </span>
                        <UiIcon name="check" size={13} className="sb-sub-check" />
                      </button>
                    ))}
                    </AssistantPicker>
                  </SubmenuPopover>
                )}
              </div>
              {!isTeam && agent?.capabilities.modelSelect && (
                <div className="sb-sub-wrap">
                  <button
                    type="button"
                    className={`sb-menu-item sb-sub-entry ${activeSub === 'model' ? 'is-sub-open' : ''}`}
                    disabled={submitting || !agent.models.length}
                    aria-expanded={activeSub === 'model'}
                    onClick={() => setActiveSub((s) => (s === 'model' ? null : 'model'))}
                  >
                    <UiIcon name="model" size={14} />
                    <span className="sb-entry-body">
                      模型
                      <small>{modelLabel}</small>
                    </span>
                    <UiIcon name="chevron-right" size={13} className="sb-entry-chev" />
                  </button>
                  {activeSub === 'model' && (
                    <SubmenuPopover wide>
                      <div className="sb-menu-label sb-sub-title">模型</div>
                      {agent.models.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          role="option"
                          aria-selected={m.id === model}
                          className={`sb-menu-item sb-sub-opt ${m.id === model ? 'is-sel' : ''}`}
                          disabled={submitting}
                          onClick={() => guardNewTaskConfigurationMutation(
                            submittingRef.current,
                            () => setModel(m.id)
                          )}
                        >
                          <span className="sb-sub-radio" aria-hidden />
                          <span className="sb-entry-body">{m.label}</span>
                          <LoadBadge percent={m.loadPercent} />
                          <UiIcon name="check" size={13} className="sb-sub-check" />
                        </button>
                      ))}
                    </SubmenuPopover>
                  )}
                </div>
              )}
              {!isTeam && (nativeThinking || agent?.capabilities.reasoningEffort) && efforts.length > 0 && (
                <div className="sb-sub-wrap">
                  <button
                    type="button"
                    className={`sb-menu-item sb-sub-entry ${activeSub === 'effort' ? 'is-sub-open' : ''}`}
                    disabled={submitting || effortDisabled}
                    aria-expanded={activeSub === 'effort'}
                    onClick={() => setActiveSub((s) => (s === 'effort' ? null : 'effort'))}
                  >
                    <UiIcon name="sliders" size={14} />
                    <span className="sb-entry-body">
                      {kimi ? 'Thinking' : '推理强度'}
                      <small>{selectedEffort ? effortLabel(selectedEffort) : ''}</small>
                    </span>
                    <UiIcon name="chevron-right" size={13} className="sb-entry-chev" />
                  </button>
                  {activeSub === 'effort' && (
                    <SubmenuPopover>
                      <div className="sb-menu-label sb-sub-title">{kimi ? 'Thinking' : '推理强度'}</div>
                      {efforts.map((ef) => (
                        <button
                          key={ef}
                          type="button"
                          role="option"
                          aria-selected={selectedEffort === ef}
                          className={`sb-menu-item sb-sub-opt ${selectedEffort === ef ? 'is-sel' : ''}`}
                          disabled={submitting}
                          onClick={() => guardNewTaskConfigurationMutation(
                            submittingRef.current,
                            () => agent?.adapter === 'zcode' ? setZcodeThinking(ef) : kimi ? setKimiThinking(ef) : setEffort(ef as ReasoningEffort)
                          )}
                        >
                          <span className="sb-sub-radio" aria-hidden />
                          <span className="sb-entry-body">{effortLabel(ef)}</span>
                          <UiIcon name="check" size={13} className="sb-sub-check" />
                        </button>
                      ))}
                    </SubmenuPopover>
                  )}
                </div>
              )}
              {!isTeam && (showFast || showMax) && (
                <>
                  <div className="sb-menu-sep" role="separator" />
                  {showFast && (
                    <button
                      type="button"
                      className={`sb-menu-item sb-switch-row ${fastMode ? 'is-on' : ''}`}
                      role="switch"
                      aria-checked={fastMode}
                      disabled={submitting}
                      onClick={() => guardNewTaskConfigurationMutation(
                        submittingRef.current,
                        () => setFastMode((value) => !value)
                      )}
                    >
                      <UiIcon name="zap" size={14} />
                      <span className="sb-entry-body">
                        快速模式
                        <small>更快返回、成本更高</small>
                      </span>
                      <span className={`sb-switch ${fastMode ? 'on' : ''}`} aria-hidden />
                    </button>
                  )}
                  {showMax && (
                    <button
                      type="button"
                      className={`sb-menu-item sb-switch-row ${maxMode ? 'is-on' : ''}`}
                      role="switch"
                      aria-checked={maxMode}
                      disabled={submitting}
                      onClick={() => guardNewTaskConfigurationMutation(
                        submittingRef.current,
                        () => setMaxMode((value) => !value)
                      )}
                      title={mcodeMax
                        ? `MiniMax Code 上下文窗口 ${formatTokens(modelDef?.maxContextWindow)}（新建会话时生效）`
                        : `TraeX Max 模式（上下文 ${formatTokens(modelDef?.maxContextWindow)}）`}
                    >
                      <UiIcon name="diff" size={14} />
                      <span className="sb-entry-body">
                        {mcodeMax ? '1M 上下文' : 'Max 上下文'}
                        <small>{mcodeMax ? `上下文窗口 ${formatTokens(modelDef?.maxContextWindow)}，额度消耗更高` : '使用最大上下文窗口'}</small>
                      </span>
                      <span className={`sb-switch ${maxMode ? 'on' : ''}`} aria-hidden />
                    </button>
                  )}
                </>
              )}
            </div>
          </details>

          <span className="sb-spacer" />
          <button
            className="btn-send new-task-send-btn"
            aria-label={submitting ? '创建中' : '开始'}
            title={submitting ? '创建中…' : '开始（⌘⏎）'}
            disabled={
              (command
                ? !prompt.trim()
                : !prompt.trim() && supportedAttachments.length === 0) ||
              !workdir ||
              submitting ||
              selectingAssistant ||
              (workspaceMode === 'worktree' && !projectGitInfo?.canCreateWorktree) ||
              (isTeam ? !team || team.status !== 'active' || !!teamUnavailableReasons[team.id] || !prompt.trim() : !agent || agent.incompatible || permissionModes.length === 0)
            }
            onClick={submit}
          >
            {submitting ? <span className="loading-spinner" aria-hidden /> : <SendIcon />}
          </button>
        </div>
        <ReviewStartDialog
          open={reviewDialogOpen}
          submitting={submitting}
          onClose={() => setReviewDialogOpen(false)}
          onSubmit={startReview}
        />
        {!!incompatibleAttachments.length && <div className="attachment-warning" role="alert">当前执行方不支持以下附件，请移除或切换执行方：{incompatibleAttachments.map(a => <button key={a.path} type="button" disabled={submitting} onClick={() => removeAttachment(attachments.indexOf(a))}>移除 {a.name}</button>)}</div>}
        {submitError && (
          <span className="attachment-warning" role="alert">
            创建任务失败：{submitError}
          </span>
        )}
      </div>
      <p className="hint">
        {isTeam ? 'Leader：' + (teamLeader?.name || '待选择') + ' · 成员按各自角色配置执行 · 开始后执行方锁定' : agent?.adapter === 'zcode'
          ? '会话开始后执行方将被锁定 · 模型、思考深度、权限与 Plan 可在轮次间调整。'
          : '会话开始后执行方将被锁定（模型、推理深度、权限可在轮次间调整）。'}
      </p>
    </div>
  )
}

function formatTokens(n?: number): string {
  if (!n) return '未知'
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  try {
    const message = JSON.stringify(error)
    return message && message !== '{}' ? message : '未知错误'
  } catch {
    return '未知错误'
  }
}

function attachmentTitle(images: boolean, files: boolean): string {
  if (images && files) return '添加图片 / 文件附件'
  if (images) return '添加图片附件'
  return '添加文件附件'
}

function supportsAttachment(
  agent: AgentDef | undefined,
  capability: 'imageAttachments' | 'fileAttachments'
): boolean {
  if (!agent) return false
  const advertised = agent.capabilities[capability]
  return (agent.capabilities.protocol === 'acp' || agent.capabilities.protocol === 'web') ? advertised === true : advertised !== false
}

export async function dispatchNewTaskDelivery(
  config: SessionConfig,
  delivery: ComposerDelivery,
  handlers: {
    create: (
      config: SessionConfig,
      prompt: string,
      attachments?: Attachment[],
      selection?: NativeTurnSelectionRequest,
      activatePlan?: boolean
    ) => Promise<Session>
    createNativeAction: (
      config: SessionConfig,
      action: NativeThreadAction
    ) => Promise<Session>
  }
): Promise<Session> {
  if (delivery.kind === 'goal') {
    return handlers.createNativeAction(config, delivery.action)
  }
  return handlers.create(
    config,
    delivery.prompt,
    delivery.attachments,
    delivery.selection,
    delivery.activatePlan
  )
}

export type NewTaskDraftSnapshot = {
  agentId: string
  workdir: string
  text: string
  command: ComposerCommand | null
  candidateIds: string[]
  attachments: PickedFile[]
}

export function guardNewTaskConfigurationMutation(
  submitting: boolean,
  mutate: () => void
): boolean {
  if (submitting) return false
  mutate()
  return true
}

export function claimNewTaskOneShotInput<T>(
  input: T | null | undefined,
  claimed: T | null,
  blocked: boolean
): { claimed: T | null; shouldApply: boolean } {
  if (!input || input === claimed) return { claimed, shouldApply: false }
  return { claimed: input, shouldApply: !blocked }
}

export function snapshotNewTaskDraft({
  agentId,
  workdir,
  text,
  command,
  candidateIds,
  attachments,
  previews
}: {
  agentId: string
  workdir: string
  text: string
  command: ComposerCommand | null
  candidateIds: readonly string[]
  attachments: readonly Attachment[]
  previews: Record<string, string>
}): NewTaskDraftSnapshot {
  return {
    agentId,
    workdir,
    text,
    command,
    candidateIds: [...candidateIds],
    attachments: attachments.map((attachment) => {
      const previewDataUrl = previews[attachment.path] || (attachment as PickedFile).previewDataUrl
      return { ...attachment, ...(previewDataUrl ? { previewDataUrl } : {}) }
    })
  }
}

export function buildCreatedComposerDraftSeed(
  session: Session,
  kind: ComposerDelivery['kind'] | 'review',
  submitted: NewTaskDraftSnapshot,
  current: NewTaskDraftSnapshot
): ComposerDraftSeed | null {
  const changed = !sameNewTaskDraft(submitted, current)
  if (kind === 'turn' && !changed) return null
  if (kind === 'goal' && !changed) {
    if (current.candidateIds.length === 0 && current.attachments.length === 0) return null
    return toComposerDraftSeed(session.id, { ...current, text: '', command: null })
  }
  return toComposerDraftSeed(session.id, current)
}

export async function completeNewTaskCreation({
  create,
  kind,
  submitted,
  current,
  commit
}: {
  create: () => Promise<Session>
  kind: ComposerDelivery['kind'] | 'review'
  submitted: NewTaskDraftSnapshot
  current: () => NewTaskDraftSnapshot
  commit: (session: Session, seed: ComposerDraftSeed | null) => void
}): Promise<void> {
  const session = await create()
  commit(session, buildCreatedComposerDraftSeed(session, kind, submitted, current()))
}

function toComposerDraftSeed(
  sessionId: string,
  draft: NewTaskDraftSnapshot
): ComposerDraftSeed {
  return {
    sessionId,
    agentId: draft.agentId,
    workdir: draft.workdir,
    text: draft.text,
    command: draft.command,
    candidateIds: [...draft.candidateIds],
    attachments: draft.attachments.map((attachment) => ({ ...attachment }))
  }
}

function sameNewTaskDraft(left: NewTaskDraftSnapshot, right: NewTaskDraftSnapshot): boolean {
  return (
    left.agentId === right.agentId &&
    left.workdir === right.workdir &&
    left.text === right.text &&
    left.command === right.command &&
    sameStrings(left.candidateIds, right.candidateIds) &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every((attachment, index) => {
      const other = right.attachments[index]
      return (
        attachment.kind === other?.kind &&
        attachment.path === other.path &&
        attachment.name === other.name &&
        attachment.mime === other.mime &&
        attachment.previewDataUrl === other.previewDataUrl
      )
    })
  )
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/** New-task permissions must come from the selected agent's advertised inventory. */
export function permissionModesForNewTask(
  agent: AgentDef | undefined
): AgentDef['capabilities']['permissionModes'] {
  const modes = agent?.capabilities.permissionModes
  return Array.isArray(modes) ? modes : []
}

/** Resolve a valid advertised choice without manufacturing a fallback mode. */
export function resolveNewTaskPermission(
  agent: AgentDef | undefined,
  requested: PermissionMode | undefined
): PermissionMode | undefined {
  const modes = permissionModesForNewTask(agent)
  return requested && modes.some((mode) => mode.id === requested)
    ? requested
    : modes[0]?.id
}
