import './assistant.css'
import { resolveAgentModel, resolveModelEffort, resolveModelThinking, supportsModelImages, withLastAgentChoices } from '@shared/agentChoices'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentDef,
  Attachment,
  BubbleComment,
  HandoffPreset,
  ModelDef,
  PermissionMode,
  QueueItem,
  ReasoningEffort,
  SessionConfig,
  SessionStatus,
  PickedFile,
  TurnBubbleInput
} from '@shared/types'
import { isSessionBusy, type SessionActivityStatus } from '@shared/sessionStatus'
import { RESPONSE_ANNOTATION_INSTRUCTION, RESPONSE_COMMENT_INSTRUCTION } from '@shared/promptContext'
import type {
  ComposerCommand,
  NativeCapabilitySnapshot,
  NativeReviewDraft,
  NativeThreadAction,
  NativeTurnSelectionRequest
} from '@shared/nativeCapabilities'
import {
  useAgentPreferences,
  useSlashField,
  useAttachments,
  useDismissableDetails,
  retainNativeCandidateIds,
  getCachedAttachmentPreview
} from '../hooks'
import { ContextMeter } from './ContextMeter'
import { SlashMenu } from './SlashMenu'
import { ComposerCapabilityChips, replaceComposerCommand } from './SkillChips'
import { NativeActionMenu } from './NativeActionMenu'
import { ReviewStartDialog } from './ReviewStartDialog'
import { PlanModeBadge } from './PlanModeBadge'
import { LoadBadge, ModelMenuOption } from './ModelPicker'
import { AgentIcon } from './AgentIcon'
import { AttachmentImagePreview, AttachmentThumbnail } from './AttachmentThumbnail'
import { SendIcon, StopIcon, UiIcon, Chevron } from './Icons'
import { SubmenuPopover } from './SubmenuPopover'
import { TeamSessionContext } from './TeamSessionExtras'
import { MarkdownEditor } from './MarkdownEditor'
import { QuickReplyComposerContext } from './QuickReplyComposerContext'
import type { ComposerPasteEvent, MarkdownInputHandle } from '../markdownInput'
import type { Annotation } from '../textAnnotations'
import { QueuedSendCard, QueuedSendStack, cancelSendOrigin, captureSendOrigin } from '../conversationMotion'

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: 'Ultra'
}
// ponytail: process-local drafts; persist only if they must survive an App restart.
const draftBySession = new Map<string, { draft: ComposerDraftSeed; owner: symbol }>()

export interface ComposerPrefill { text: string; nonce: number; sessionId?: string; append?: boolean }

export function Composer({
  sessionId,
  status,
  agent,
  config,
  onSend,
  onForceSend,
  onInterrupt,
  onUpdateConfig,
  onSetCollaborationMode,
  onRunNativeAction,
  queue,
  onDequeue,
  onPromoteQueue,
  onEditQueueItem,
  onQueueEditingChange,
  capabilities,
  capabilitiesReady,
  draftSeed,
  onConsumeDraftSeed,
  contextUsed,
  contextUsedPercentage,
  contextWindow,
  onCompact,
  canCompact,
  compacting,
  providerSwitchCompacting = false,
  preparingModel = false,
  disabledReason,
  inputPlaceholder,
  disabled,
  sessionExternallyOccupied,
  toolSessionReadOnly,
  onEnableToolSession,
  refreshingNativeSession,
  onRefreshNativeSession,
  prefill,
  pendingComments,
  onEditPendingComment,
  onRemovePendingComment,
  runtimeStatus,
  interruptsTeam,
  allowRoleConfig
}: {
  sessionId?: string
  status: SessionActivityStatus
  runtimeStatus?: SessionStatus
  agent?: AgentDef
  config: SessionConfig
  onSend: (prompt: string, attachments?: Attachment[], selection?: NativeTurnSelectionRequest, activatePlan?: boolean, bubble?: TurnBubbleInput) => void | Promise<void>
  onForceSend: (prompt: string, attachments?: Attachment[], selection?: NativeTurnSelectionRequest, bubble?: TurnBubbleInput) => void | Promise<void>
  onInterrupt: () => void
  onUpdateConfig: (patch: Partial<SessionConfig>) => void
  onSetCollaborationMode: (mode: 'default' | 'plan') => void | Promise<void>
  onRunNativeAction: (action: NativeThreadAction) => void | Promise<void>
  queue: QueueItem[]
  onDequeue: (id: string) => void | Promise<void>
  onPromoteQueue: (id: string) => void | Promise<void>
  onEditQueueItem: (id: string, prompt: string, attachments?: Attachment[], selection?: NativeTurnSelectionRequest) => void | Promise<void>
  onQueueEditingChange?: (itemId: string | null) => void
  capabilities: NativeCapabilitySnapshot
  capabilitiesReady: boolean
  draftSeed?: ComposerDraftSeed | null
  onConsumeDraftSeed?: (seed: ComposerDraftSeed) => void
  contextUsed: number
  contextUsedPercentage?: number
  contextWindow?: number
  onCompact: () => Promise<void>
  canCompact: boolean
  compacting: boolean
  providerSwitchCompacting?: boolean
  preparingModel?: boolean
  disabledReason?: string
  inputPlaceholder?: string
  disabled?: boolean
  sessionExternallyOccupied?: boolean
  toolSessionReadOnly?: boolean
  onEnableToolSession?: () => Promise<void>
  refreshingNativeSession?: boolean
  onRefreshNativeSession?: () => void | Promise<void>
  /** 回退替换输入，合并指令追加；只预填并聚焦，不自动发送。 */
  prefill?: ComposerPrefill
  /**
   * 选中即评论 →「评论」— confirmed annotations pinned to the composer's 待评论托盘
   * (引用 + 可选评论). They persist per session (localStorage) and ride along with
   * the next send as structured comment cards, WITHOUT injecting text into the
   * textarea. `onRemovePendingComment` drops one before sending.
   */
  pendingComments?: Annotation[]
  onEditPendingComment?: (id: string) => void
  onRemovePendingComment?: (id: string) => void
  interruptsTeam?: boolean
  allowRoleConfig?: boolean
}): JSX.Element {
  const teamSession = useContext(TeamSessionContext)
  const quickReply = useContext(QuickReplyComposerContext)
  const teamName = teamSession?.project.team.name
  const draftOwnerRef = useRef(Symbol('composer-draft'))
  const cachedDraftRef = useRef(sessionId ? draftBySession.get(sessionId)?.draft : undefined)
  const [draftRestored, setDraftRestored] = useState(!cachedDraftRef.current)
  const [text, setText] = useState(() => cachedDraftRef.current?.text || '')
  const [sendError, setSendError] = useState<string | undefined>()
  const [sending, setSending] = useState(false)
  const [enablingToolSession, setEnablingToolSession] = useState(false)
  const [enableToolSessionError, setEnableToolSessionError] = useState<string>()
  const [command, setCommand] = useState<ComposerCommand | null>(() => cachedDraftRef.current?.command || null)
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [presets, setPresets] = useState<HandoffPreset[]>([])
  const [goalMaxRounds, setGoalMaxRounds] = useState('')
  const [goalTokenBudget, setGoalTokenBudget] = useState('')
  // 需求补9 — the Agent menu's 模型 / 推理强度 rows are entry rows: clicking one
  // opens a second-level list to its RIGHT (side-by-side), top-aligned to that
  // row, WITHOUT closing the main popover. Re-clicking the same row collapses it;
  // clicking the other row swaps the side list. Reset whenever the menu closes.
  const [activeSub, setActiveSub] = useState<'model' | 'effort' | 'qoder-context' | null>(null)
  // 需求（队列二次编辑）— when set, the composer is rewriting this pending queue
  // item in place: its text/images are loaded back into the same input, and the
  // primary action swaps to a single 保存 button. While editing, this item (and
  // everything behind it) is frozen from dispatch. Cleared on cancel or save.
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  // Releasing the dispatch freeze on unmount: switching sessions unmounts this
  // composer (keyed by session id), so an in-flight edit must not strand the
  // backend queue lock. Refs keep the latest values without re-running cleanup.
  const editingQueueIdRef = useRef<string | null>(null)
  const onQueueEditingChangeRef = useRef(onQueueEditingChange)
  editingQueueIdRef.current = editingQueueId
  onQueueEditingChangeRef.current = onQueueEditingChange
  useEffect(() => () => {
    if (editingQueueIdRef.current) onQueueEditingChangeRef.current?.(null)
  }, [])
  const sendingRef = useRef(false)
  const {
    attachments,
    setAttachments,
    addPickedFiles,
    replacePickedFiles,
    pasteImage,
    removeAttachment,
    clearAttachments,
    previews
  } = useAttachments()
  const taRef = useRef<MarkdownInputHandle>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  useDismissableDetails(composerRef)
  const busy = isSessionBusy(status)
  const preparing = compacting || preparingModel
  // 跨来源模型切换期间直接屏蔽输入：不再显示压缩横幅，输入框与发送均锁定，草稿保留。
  const switchBusy = preparingModel || providerSwitchCompacting
  const queueBusy = isSessionBusy(runtimeStatus ?? status) || compacting
  const providerDisabled = !!disabled || !!toolSessionReadOnly || !!sessionExternallyOccupied || !agent || agent.installed === false || !!agent.incompatible
  const canSteer = agent?.capabilities.steer === true
  // Missing optional flags retain legacy providers' attachment behavior; ACP
  // agents advertise the two kinds independently.
  const canAttachImages = supportsAttachment(agent, 'imageAttachments') && supportsModelImages(agent, config.model)
  const canAttachFiles = supportsAttachment(agent, 'fileAttachments')
  const attachmentCapabilitiesRef = useRef({ images: canAttachImages, files: canAttachFiles })
  attachmentCapabilitiesRef.current = { images: canAttachImages, files: canAttachFiles }
  const supportedAttachmentEntries = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) =>
      attachment.kind === 'image' ? canAttachImages : canAttachFiles
    )
  const supportedAttachments = supportedAttachmentEntries.map(({ attachment }) => attachment)
  // 图片详情: index within the bar's image list; null = lightbox closed. Kept as
  // the list index so ←/→ can page across every attached image.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const imagePreviewEntries = supportedAttachmentEntries
    .filter(({ attachment }) => attachment.kind === 'image')
    .map(({ attachment }) => ({ attachment, src: previews[attachment.path] }))
  // Whether there's anything worth sending (drives the busy-state candidate UI).
  // 选中即评论 — pending comments alone are enough to send (with a default
  // instruction), so they count as content too.
  const hasContent =
    text.trim().length > 0 ||
    supportedAttachments.length > 0 ||
    (pendingComments?.length ?? 0) > 0

  useEffect(() => {
    let cancelled = false
    const loadPresets = (): void => { void window.uniagent.listPresets().then((next) => {
      if (!cancelled) setPresets(next)
    }) }
    loadPresets()
    window.addEventListener('uniagent-presets-changed', loadPresets)
    return () => { cancelled = true; window.removeEventListener('uniagent-presets-changed', loadPresets) }
  }, [])

  // nonce 防止普通重渲染覆盖草稿；sessionId 限制合并指令的目标任务。
  const prefillNonceRef = useRef<number | undefined>(prefill?.nonce)
  useEffect(() => {
    if (!prefill || prefill.nonce === prefillNonceRef.current) return
    prefillNonceRef.current = prefill.nonce
    if (prefill.sessionId && prefill.sessionId !== sessionId) return
    if (prefill.append && (providerDisabled || switchBusy)) return
    setText(current => {
      if (!prefill.append) return prefill.text
      if (current.includes(prefill.text)) return current
      return current.trim() ? current + '\n\n' + prefill.text : prefill.text
    })
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus('end')
    })
  }, [prefill, sessionId, providerDisabled, switchBusy])

  const quickReplyKeyRef = useRef('')
  useEffect(() => {
    if (!quickReply?.selection || quickReply.sessionId !== sessionId) return
    const key = `${quickReply.sessionId}:${quickReply.selection.nonce}`
    if (quickReplyKeyRef.current === key) return
    quickReplyKeyRef.current = key
    quickReply.onConsumed?.(quickReply.selection.nonce)
    if (providerDisabled || switchBusy) return
    const reply = quickReply.selection.text
    setText(current => current.trim() ? current + '\n' + reply : reply)
    requestAnimationFrame(() => taRef.current?.focus('end'))
  }, [quickReply, sessionId, providerDisabled, switchBusy])

  // 选中即评论 — the 待评论托盘 defaults to COLLAPSED (a single `💬 N 条待评论`
  // summary row); clicking it expands the per-comment card list. A new comment
  // keeps the current fold state — it only bumps the count.
  const [commentTrayOpen, setCommentTrayOpen] = useState(false)
  const trayComments = pendingComments || []

  // Drop stale attachments after switching sessions/providers or after a live
  // ACP capability update narrows the supported kinds.
  useEffect(() => {
    setAttachments((current) => {
      const next = current.filter((attachment) =>
        attachment.kind === 'image' ? canAttachImages : canAttachFiles
      )
      return next.length === current.length ? current : next
    })
  }, [canAttachFiles, canAttachImages, setAttachments])

  const slashCandidates = useMemo(() => config.assistantSnapshot ? [
    { id: 'assistant:new', kind: 'command' as const, name: 'new', command: '/new', description: '新对话 · 保留旧会话' },
    { id: 'assistant:clear', kind: 'command' as const, name: 'clear', command: '/clear', description: '清空当前对话 · 保留长期记忆' },
    ...capabilities.candidates.filter(c => c.kind !== 'command' || !['/new','/clear'].includes(c.command))
  ] : capabilities.candidates, [config.assistantSnapshot, capabilities.candidates])
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
  } = useSlashField(taRef, slashCandidates)
  const selectedCandidates = useMemo(
    () => selectedIds.flatMap((id) => {
      const candidate = capabilities.candidates.find((item) => item.id === id)
      return candidate ? [candidate] : []
    }),
    [capabilities.candidates, selectedIds]
  )
  const capabilityScope = `${capabilities.agentId}::${capabilities.workdir}`
  const previousCapabilityScopeRef = useRef(capabilityScope)

  useLayoutEffect(() => {
    const draft = cachedDraftRef.current
    if (!draft || draftRestored) return
    setSelectedIds([...draft.candidateIds])
    replacePickedFiles(filterComposerSeedAttachments(draft.attachments, canAttachImages, canAttachFiles))
    setDraftRestored(true)
  }, [canAttachFiles, canAttachImages, draftRestored, replacePickedFiles, setSelectedIds])

  useLayoutEffect(() => {
    if (!sessionId || !draftRestored) return
    const draft: ComposerDraftSeed = {
      sessionId,
      agentId: config.agentId,
      workdir: config.workdir,
      text,
      command,
      candidateIds: [...selectedIds],
      attachments: attachments.map((attachment) => ({
        ...attachment,
        ...(previews[attachment.path] ? { previewDataUrl: previews[attachment.path] } : {})
      }))
    }
    if (text || command || selectedIds.length || attachments.length) {
      draftBySession.set(sessionId, { draft, owner: draftOwnerRef.current })
    } else if (draftBySession.get(sessionId)?.owner === draftOwnerRef.current) {
      draftBySession.delete(sessionId)
    }
  }, [attachments, command, config.agentId, config.workdir, draftRestored, previews, selectedIds, sessionId, text])

  useEffect(() => {
    if (previousCapabilityScopeRef.current === capabilityScope) return
    previousCapabilityScopeRef.current = capabilityScope
    setCommand(null)
    setSelectedIds([])
  }, [capabilityScope, setSelectedIds])

  useEffect(() => {
    if (!capabilitiesReady || capabilities.errors.length > 0) return
    setSelectedIds((current) => retainNativeCandidateIds(current, capabilities.candidates))
  }, [capabilities.candidates, capabilities.errors.length, capabilitiesReady, setSelectedIds])

  const appliedDraftSeedKeyRef = useRef<string | null>(null)
  const reconciledDraftSeedKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!draftSeed || !shouldHydrateComposerDraftSeed(
      draftSeed,
      appliedDraftSeedKeyRef.current,
      sessionId,
      config
    )) return
    appliedDraftSeedKeyRef.current = composerDraftSeedKey(draftSeed)
    setText(draftSeed.text)
    setCommand(draftSeed.command)
    setSelectedIds([...draftSeed.candidateIds])
    replacePickedFiles(filterComposerSeedAttachments(
      draftSeed.attachments,
      canAttachImages,
      canAttachFiles
    ))
  }, [
    canAttachFiles,
    canAttachImages,
    config,
    draftSeed,
    replacePickedFiles,
    sessionId,
    setSelectedIds
  ])

  useEffect(() => {
    if (!draftSeed || !shouldReconcileComposerDraftSeed(
      draftSeed,
      appliedDraftSeedKeyRef.current,
      reconciledDraftSeedKeyRef.current,
      sessionId,
      config,
      capabilities,
      capabilitiesReady
    )) return
    reconciledDraftSeedKeyRef.current = composerDraftSeedKey(draftSeed)
    setSelectedIds((current) => retainNativeCandidateIds(current, capabilities.candidates))
    onConsumeDraftSeed?.(draftSeed)
  }, [
    capabilities,
    capabilitiesReady,
    config,
    draftSeed,
    onConsumeDraftSeed,
    sessionId,
    setSelectedIds
  ])

  const draftRef = useRef<ComposerDraftSnapshot>(
    snapshotComposerDraft({ sessionId, text: '', attachments: [], candidateIds: [], command: null, generation: 0 })
  )

  const liveDraft = snapshotComposerDraft({
    sessionId,
    text,
    attachments,
    candidateIds: selectedIds,
    command,
    generation: draftRef.current.generation
  })
  if (!sameComposerDraftState(draftRef.current, liveDraft)) {
    draftRef.current = { ...liveDraft, generation: draftRef.current.generation + 1 }
  }

  function reset(): void {
    if (sessionId && draftBySession.get(sessionId)?.owner === draftOwnerRef.current) {
      draftBySession.delete(sessionId)
    }
    taRef.current?.clear()
    setText('')
    clearAttachments()
    setSelectedIds([])
    setCommand(null)
  }

  async function send(force = false): Promise<void> {
    const outgoingAttachments = attachments.filter((attachment) =>
      attachment.kind === 'image' ? canAttachImages : canAttachFiles
    )
    const delivery = buildComposerDelivery(command, text, outgoingAttachments, selectedIds, trayComments, agent?.adapter)
    if (!delivery || providerDisabled || switchBusy ||
        (compacting && (force || command !== null)) || (force && !canSteer)) return
    if (delivery.kind === 'goal' && (busy || force)) return
    if (sendingRef.current) return
    if (delivery.kind === 'goal') {
      try { Object.assign(delivery.action, buildNativeGoalLimits(agent?.adapter, { maxRounds: goalMaxRounds, tokenBudget: goalTokenBudget })) }
      catch (error) { setSendError(error instanceof Error ? error.message : String(error)); return }
    }
    // While busy, a normal send enqueues (orchestrator decides); force steers.
    const clientTurnKey = captureSendOrigin(composerRef.current?.querySelector<HTMLElement>('.composer-box') || composerRef.current,
      delivery.kind === 'goal' ? `session:${sessionId}` : undefined)
    setSendError(undefined)
    const draftAtSend = draftRef.current
    const attachmentsAtSend = attachments.map((attachment) => ({
      ...attachment,
      ...(previews[attachment.path] ? { previewDataUrl: previews[attachment.path] } : {})
    }))
    let clearedDraft: ComposerDraftSnapshot | undefined
    if (delivery.kind === 'goal' && shouldResetGoalDraft(draftRef.current, draftAtSend)) {
      clearedDraft = snapshotComposerDraft({
        sessionId,
        text: '',
        attachments,
        candidateIds: selectedIds,
        command: null,
        generation: draftAtSend.generation + 1
      })
      draftRef.current = clearedDraft
      const cached = sessionId ? draftBySession.get(sessionId) : undefined
      if (sessionId && cached?.owner === draftOwnerRef.current) {
        const draft = { ...cached.draft, text: '', command: null }
        if (draft.candidateIds.length || draft.attachments.length) {
          draftBySession.set(sessionId, { draft, owner: draftOwnerRef.current })
        } else {
          draftBySession.delete(sessionId)
        }
      }
      taRef.current?.clear()
      setText('')
      setCommand(null)
    } else if (delivery.kind === 'turn' && shouldResetComposerDraft(draftRef.current, draftAtSend)) {
      clearedDraft = snapshotComposerDraft({
        sessionId,
        text: '',
        attachments: [],
        candidateIds: [],
        command: null,
        generation: draftAtSend.generation + 1
      })
      draftRef.current = clearedDraft
      reset()
    }
    sendingRef.current = true
    setSending(true)
    try {
      const error = await submitComposerDraft(
        () => dispatchComposerDelivery(delivery, force, {
          runNativeAction: onRunNativeAction,
          send: onSend,
          forceSend: onForceSend
        }, clientTurnKey),
        () => {
          if (delivery.kind !== 'goal' && !clearedDraft && shouldResetComposerDraft(draftRef.current, draftAtSend)) {
            reset()
          }
        }
      )
      if (error && clearedDraft && shouldResetComposerDraft(draftRef.current, clearedDraft)) {
        const cached = sessionId ? draftBySession.get(sessionId) : undefined
        if (cached && cached.owner !== draftOwnerRef.current) return
        draftRef.current = { ...draftAtSend, generation: clearedDraft.generation + 1 }
        if (sessionId) {
          draftBySession.set(sessionId, {
            draft: {
              sessionId,
              agentId: config.agentId,
              workdir: config.workdir,
              text: draftAtSend.text,
              command: draftAtSend.command,
              candidateIds: [...draftAtSend.candidateIds],
              attachments: attachmentsAtSend
            },
            owner: draftOwnerRef.current
          })
        }
        setText(draftAtSend.text)
        replacePickedFiles(attachmentsAtSend)
        setSelectedIds([...draftAtSend.candidateIds])
        setCommand(draftAtSend.command)
      }
      setSendError(error)
      if (error) cancelSendOrigin(clientTurnKey)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  // 需求（队列二次编辑）— pull a still-pending queue item into the composer: load
  // its text + images back into the same input, remember which item is being
  // edited, and focus. The queue row keeps showing the (unchanged) item until the
  // user saves or sends.
  function beginEditQueueItem(item: QueueItem): void {
    if (providerDisabled) return
    setCommand(null)
    setSelectedIds([])
    setText(item.prompt)
    replacePickedFiles((item.attachments || []).map((attachment) => ({
      ...attachment,
      ...(getCachedAttachmentPreview(attachment.path)
        ? { previewDataUrl: getCachedAttachmentPreview(attachment.path) }
        : {})
    })))
    setEditingQueueId(item.id)
    onQueueEditingChange?.(item.id)
    setSendError(undefined)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus('end')
    })
  }

  function cancelEditQueueItem(): void {
    setEditingQueueId(null)
    onQueueEditingChange?.(null)
    reset()
  }

  async function dequeueQueueItem(id: string): Promise<void> {
    const error = await dequeueComposerQueueItem(
      id,
      () => editingQueueIdRef.current,
      onDequeue,
      cancelEditQueueItem
    )
    setSendError(error)
  }

  // 需求（队列二次编辑）— save the edited draft back into its queue slot. It stays
  // queued (and, together with everything behind it, blocked from dispatch until
  // now) and resumes its normal FIFO turn once saved.
  async function commitQueueEdit(): Promise<void> {
    if (!editingQueueId || sendingRef.current) return
    const id = editingQueueId
    const prompt = text.trim()
    const outgoing = attachments.filter((attachment) =>
      attachment.kind === 'image' ? canAttachImages : canAttachFiles
    )
    if (!prompt && outgoing.length === 0) return
    sendingRef.current = true
    setSending(true)
    setSendError(undefined)
    try {
      await onEditQueueItem(id, prompt, outgoing.length ? outgoing : undefined, { candidateIds: [] })
      setEditingQueueId(null)
      onQueueEditingChange?.(null)
      reset()
    } catch (error: unknown) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  async function startReview(draft: NativeReviewDraft): Promise<void> {
    if (busy || providerDisabled || reviewSubmitting) return
    setReviewSubmitting(true)
    setSendError(undefined)
    try {
      await onRunNativeAction({ type: 'review.start', draft })
      setReviewDialogOpen(false)
    } catch (error: unknown) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewSubmitting(false)
    }
  }

  async function addSupportedFiles(): Promise<void> {
    if (providerDisabled || (!canAttachImages && !canAttachFiles)) return
    const files = await window.uniagent.pickFiles()
    const capabilities = attachmentCapabilitiesRef.current
    const picked = files
      .filter((attachment) =>
        attachment.kind === 'image' ? capabilities.images : capabilities.files
      )
    addPickedFiles(picked)
  }

  function handlePaste(e: ComposerPasteEvent): void {
    if (providerDisabled || !canAttachImages) return
    void pasteImage(e).then(() => {
      const capabilities = attachmentCapabilitiesRef.current
      setAttachments((current) =>
        current.filter((attachment) =>
          attachment.kind === 'image' ? capabilities.images : capabilities.files
        )
      )
    })
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return
    // Slash palette navigation takes priority when open.
    if (onKeyDownSlash(e)) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      // 需求（队列二次编辑）— while rewriting a queued item, ⌘⏎ saves it back into
      // the queue rather than starting a new send.
      if (editingQueueId) {
        void commitQueueEdit()
        return
      }
      // 需求2.1: ⌘⏎ always sends; while a turn runs it DEFAULTS to the queue
      // (force-insert is an explicit per-item choice when a live app-server is
      // available), so the keyboard shortcut itself never steers.
      void send(false)
    } else if (e.key === 'Escape' && busy) {
      onInterrupt()
    }
  }

  const prefs = useAgentPreferences()
  const pref = withLastAgentChoices(prefs?.lastByAgent[agent?.id || ''])
  const canConfigure = !busy && !preparing && !!agent && !providerDisabled
  const canSelectModel = canConfigure || (agent?.adapter === 'claude' && !preparing && !providerDisabled)
  const modelDef: ModelDef | undefined = resolveAgentModel(agent, config.model, pref?.defaultModel)
  const modelLabel = modelDef?.label || config.model || '无可用模型'
  const kimi = agent?.adapter === 'kimi'
  const zcode = agent?.adapter === 'zcode'
  const nativeThinking = kimi || zcode
  const efforts = nativeThinking ? modelDef?.thinkingOptions || [] : modelDef?.efforts || []
  const selectedEffort = nativeThinking
    ? resolveModelThinking(modelDef, kimi ? config.kimiThinking : config.zcodeModelSelection?.options?.reasoningLevel, pref?.defaultThinking, pref?.defaultEffort)
    : resolveModelEffort(modelDef, config.effort, pref?.defaultEffort)
  const effortLabel = (value: string): string => kimi ? value : EFFORT_LABEL[value as ReasoningEffort] || value
  // 需求9 — the 快速模式 toggle only makes sense for codex models that advertise
  // the priority tier. Show it when the agent is codex and either the selected
  // model supports Fast, or (no explicit model) any of its models do.
  const showFast =
    agent?.adapter === 'codex' &&
    (modelDef ? !!modelDef.supportsFast : agent.models.some((m) => m.supportsFast))
  const showMax = (agent?.adapter === 'traex' || agent?.adapter === 'mcode') && !!modelDef?.supportsMax
  // MiniMax Code stores the context window in its own runtime configuration and
  // calls the large window "1M" instead of "Max".
  const mcodeMax = agent?.adapter === 'mcode'
  const canForceInsert = canSteer
  const pendingQueue = queue.filter(isPendingQueueItem)
  const roleSnapshot = config.roleSnapshot
  const roleLocked = !!roleSnapshot && !allowRoleConfig
  const composerLocked = !!toolSessionReadOnly || !!sessionExternallyOccupied
  async function enableToolSession(): Promise<void> {
    if (enablingToolSession || !onEnableToolSession) return
    setEnablingToolSession(true)
    setEnableToolSessionError(undefined)
    try {
      await onEnableToolSession()
    } catch (error) {
      setEnableToolSessionError(error instanceof Error ? error.message : String(error))
    } finally {
      setEnablingToolSession(false)
    }
  }

  return (
    <>
      {/* Codex-style: queued messages are a standalone stack ABOVE the input
          card, not inside its border. */}
      <QueuedSendStack queue={queue}>
      {pendingQueue.length > 0 && (<>
          <div className="queue-head">
            <span className="queue-title">等待队列 · {pendingQueue.length}</span>
            <span className="queue-hint">
              {editingQueueId
                ? `任务 ${pendingQueue.findIndex((q) => q.id === editingQueueId) + 1} 正在编辑`
                : compacting && canForceInsert
                  ? '压缩完成后可直接发送 · 本轮结束后按顺序自动发送'
                  : '本轮结束后按顺序自动发送'}
            </span>
          </div>
          {pendingQueue.map((q, i) => {
            const imageCount = (q.attachments || []).filter((a) => a.kind === 'image').length
            const fileCount = (q.attachments || []).filter((a) => a.kind === 'file').length
            const optimistic = q.id.startsWith('optimistic-queue-')
            const isEditing = editingQueueId === q.id
            return (
            <QueuedSendCard
              key={q.clientTurnKey || q.id}
              sendKey={q.clientTurnKey}
              data-queue-send-key={q.clientTurnKey || q.id}
              className={`queue-card${optimistic ? ' is-entering' : ''}${isEditing ? ' is-editing' : ''}`}
              title={q.prompt}
            >
              <span className="queue-idx">{i + 1}</span>
              <span className="queue-text">{q.deliveryUncertain ? '提交结果待确认 · 查看历史后删除，或编辑重发：' : ''}{(q.displayText || q.prompt).slice(0, 80) || '(图片)'}</span>
              {imageCount > 0 && (
                <span className="queue-imgcount" title={`${imageCount} 张图片`}>
                  <UiIcon name="image" size={14} /> 图片 × {imageCount}
                </span>
              )}
              {fileCount > 0 && (
                <span className="queue-imgcount" title={`${fileCount} 个文件`}>
                  <UiIcon name="paperclip" size={14} /> 文件 × {fileCount}
                </span>
              )}
              {!optimistic && !composerLocked && <div className="queue-card-acts">
                {canSteer && !config.managedPurpose && (
                  <button
                    className="queue-act queue-steer"
                    onClick={async event => {
                      if (compacting || switchBusy) return
                      setSendError(undefined)
                      const key = captureSendOrigin(event.currentTarget.closest<HTMLElement>('.queue-card'), q.clientTurnKey || q.id)
                      try { await onPromoteQueue(q.id) }
                      catch (error) { cancelSendOrigin(key); setSendError(error instanceof Error ? error.message : String(error)) }
                    }}
                    disabled={compacting || switchBusy}
                    title={compacting ? '上下文正在压缩，完成后可直接发送' : switchBusy ? '正在切换模型，请等待准备完成' : '直接发送'}
                    aria-label="直接发送"
                  >
                    <UiIcon name="arrow-up" size={16} />
                  </button>
                )}
                {!config.managedPurpose && <button
                  className={`queue-act queue-edit${isEditing ? ' is-editing' : ''}`}
                  onClick={() => (isEditing ? cancelEditQueueItem() : beginEditQueueItem(q))}
                  title={isEditing ? '取消编辑' : '编辑'}
                  aria-label={isEditing ? '取消编辑' : '编辑等待消息'}
                >
                  <UiIcon name="edit" size={16} />
                </button>}
                <button
                  className="queue-act queue-del"
                  onClick={() => { cancelSendOrigin(q.clientTurnKey || q.id); void dequeueQueueItem(q.id) }}
                  title="删除"
                  aria-label="删除等待消息"
                >
                  <UiIcon name="close" size={16} />
                </button>
              </div>}
            </QueuedSendCard>
            )
          })}
      </>)}
      </QueuedSendStack>
    <div
      className={`composer-wrap${composerLocked ? ' is-session-occupied' : ''}${toolSessionReadOnly ? ' is-tool-session' : ''}${editingQueueId ? ' is-editing-queue' : ''}`}
      ref={composerRef}
    >
      <div className="composer-controls" ref={(element) => { if (element) element.inert = composerLocked }} aria-hidden={composerLocked || undefined}>
      {/* 需求（队列二次编辑）— editing banner: shows which queued task is being
          rewritten in place and offers a quick cancel. */}
      {editingQueueId && (
        <div className="edit-queue-banner">
          <UiIcon name="edit" size={13} />
          <span>正在编辑等待任务 {pendingQueue.findIndex((q) => q.id === editingQueueId) + 1}</span>
          <button
            type="button"
            className="edit-queue-cancel"
            onClick={cancelEditQueueItem}
            title="取消编辑"
            aria-label="取消编辑"
          >
            <UiIcon name="close" size={13} /> 取消编辑
          </button>
        </div>
      )}
      {/* 选中即评论 — 待评论托盘: default collapsed (a single 💬 N 条待评论 summary
          row); click to expand the per-comment card list. Pinned ABOVE the input
          (like the attach bar); rides along with the next send. */}
      {trayComments.length > 0 && (
        <div className={`cmt-tray${commentTrayOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="cmt-tray-summary"
            onClick={() => setCommentTrayOpen((v) => !v)}
            aria-expanded={commentTrayOpen}
          >
            <UiIcon name="message-square" size={13} />
            <b>{trayComments.length}</b> 条待评论
            <span className="cmt-tray-hint">发送时一并带上</span>
            <Chevron open={commentTrayOpen} />
          </button>
          {commentTrayOpen && (
            <div className="cmt-tray-list">
              {trayComments.map((c, i) => (
                <div className="cmt-tray-item" key={c.id}>
                  <span className="cmt-tray-idx">{i + 1}</span>
                  <div className="cmt-tray-body">
                    {c.filePath && <div className="cmt-tray-file" title={c.filePath}>{c.filePath.split('/').pop()}</div>}
                    <div className="cmt-tray-quote">{c.quote}</div>
                    {c.comment && <div className="cmt-tray-note">{c.comment}</div>}
                  </div>
                  {(onEditPendingComment || onRemovePendingComment) && (
                    <div className="cmt-tray-actions">
                      {onEditPendingComment && (
                        <button
                          type="button"
                          className="cmt-tray-edit"
                          title="编辑该评论"
                          aria-label="编辑该评论"
                          onClick={() => onEditPendingComment(c.id)}
                        >
                          <UiIcon name="edit" size={13} />
                        </button>
                      )}
                      {onRemovePendingComment && (
                        <button
                          type="button"
                          className="cmt-tray-del"
                          title="删除该评论"
                          aria-label="删除该评论"
                          onClick={() => onRemovePendingComment(c.id)}
                        >
                          <UiIcon name="close" size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
                onRemove={() => removeAttachment(index)}
              />
            ) : (
              <span key={`${a.path}-${index}`} className="attach-chip attach-file" title={a.path}>
                <UiIcon name="paperclip" size={12} /> {a.name}
                <button className="attach-x" aria-label={`移除 ${a.name}`} onClick={() => removeAttachment(index)}>
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

      <ComposerCapabilityChips
        command={command}
        candidates={selectedCandidates}
        onRemoveCommand={() => setCommand(null)}
        onRemoveCandidate={removeCandidate}
      />

      {sendError?.includes('native_action_in_progress') ? (
        <div className="composer-preparing" role="status">会话正在准备，请稍候再发送。你的草稿已保留。</div>
      ) : sendError && (
        <div className="composer-send-error" role="alert">
          {sendError}
        </div>
      )}

      {/* Codex-style: queued messages live ABOVE the composer as standalone
          cards, not crammed inside the input row (rendered before this card). */}
      <div className="composer">
        <div className="composer-main">
          {command === 'goal' && ['deepseek', 'grok', 'kimi', 'mcode', 'qoder'].includes(agent?.adapter || '') && <NativeGoalOptions provider={agent?.adapter} value={agent?.adapter === 'grok' || agent?.adapter === 'mcode' || agent?.adapter === 'qoder' ? goalTokenBudget : goalMaxRounds} disabled={providerDisabled || busy || sending} onChange={agent?.adapter === 'grok' || agent?.adapter === 'mcode' || agent?.adapter === 'qoder' ? setGoalTokenBudget : setGoalMaxRounds} />}
          {command === 'goal' && agent?.adapter === 'qoder' && <div className="native-goal-options candidate-hint"><label>最多回合 <input className="native-goal-rounds-input" type="number" min="1" step="1" aria-label="Qoder Goal 最多回合" value={goalMaxRounds} disabled={providerDisabled || busy || sending} onChange={event => setGoalMaxRounds(event.target.value)} /></label><span>由 Qoder 原生限制轮次</span></div>}
          {slashOpen && (
            <SlashMenu
              hits={slashHits}
              totalCount={capabilities.candidates.length}
              onPick={pick}
              onClose={closeSlash}
              activeIndex={activeIndex}
              setActiveIndex={setActiveIndex}
            />
          )}
          {/* 需求2: while a turn runs, typed text (and images) are queued by
              default; the force-insert choice is shown per item for a live
              app-server. Pinned to the input's top edge (normal flow) so it
              never covers typed text or the attachment thumbnails above. */}
          {queueBusy && hasContent && !sending && !editingQueueId && (
            <div className="candidate-hint">
              待发送：按 <b>⌘⏎</b> 加入等待队列
              {compacting && canForceInsert
                ? ' · 压缩完成后可在队列里点「直接发送」'
                : canForceInsert
                  ? ' · 需要立即打断可在队列里点「直接发送」'
                  : ' · 本轮结束后按顺序自动发送'}
            </div>
          )}
          <MarkdownEditor
            ref={taRef}
            className="composer-input"
            placeholder={inputPlaceholder || (
              queueBusy
                ? compacting
                  ? canForceInsert
                    ? '上下文压缩中…输入后按 ⌘⏎ 加入等待队列，压缩完成后可直接发送'
                    : '上下文压缩中…输入后按 ⌘⏎ 加入等待队列，本轮结束自动发送'
                  : canForceInsert
                  ? '运行中…输入后按 ⌘⏎ 加入等待队列，本轮结束自动发送（可在队列里选择直接发送）'
                  : '运行中…输入后按 ⌘⏎ 加入等待队列，本轮结束自动发送'
                : canAttachImages
                  ? '继续对话…（/ 唤起 Skill·MCP，⌘⏎ 发送，⇧⏎ 换行，可粘贴图片）'
                  : '继续对话…（/ 唤起 Skill·MCP，⌘⏎ 发送，⇧⏎ 换行）'
            )}
            value={text}
            disabled={providerDisabled || switchBusy}
            onChange={setText}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            onSelectionChange={onSelectionChange}
          />
        </div>
      </div>

      {/* Compact status bar: low-frequency controls live behind + / Agent menus. */}
      <div className="status-bar">
        {config.assistantSnapshot && <span className="assistant-chip active"><UiIcon name="identity" size={14} />个人助手</span>}
        <details className="sb-menu sb-add">
          <summary className="sb-add-btn" title="功能、模板与附件" aria-label="功能、模板与附件"><UiIcon name="plus" size={18} /></summary>
          <div className="sb-menu-pop">
            {(canAttachImages || canAttachFiles) && (
                <button
                  type="button"
                  className="sb-menu-item"
                  disabled={providerDisabled}
                  title={attachmentTitle(canAttachImages, canAttachFiles)}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open')
                    void addSupportedFiles()
                  }}
                >
                  <UiIcon name="paperclip" size={14} /> 添加附件
                </button>
            )}
            {<NativeActionMenu
              actions={capabilities.actions}
              disabled={busy || providerDisabled}
              onSelectCommand={(next) => {
                setCommand((current) => replaceComposerCommand(current, next))
                setReviewDialogOpen(false)
                composerRef.current?.querySelector('.sb-add')?.removeAttribute('open')
                requestAnimationFrame(() => taRef.current?.focus())
              }}
              onOpenReview={() => {
                setReviewDialogOpen(true)
                composerRef.current?.querySelector('.sb-add')?.removeAttribute('open')
              }}
            />}
            {presets.length > 0 && (
                <div className="sb-menu-group">
                  <div className="sb-menu-label">任务模板</div>
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="sb-menu-item"
                      disabled={providerDisabled}
                      onClick={(e) => {
                        e.currentTarget.closest('details')?.removeAttribute('open')
                        setText(preset.prompt)
                        requestAnimationFrame(() => taRef.current?.focus())
                      }}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
            )}
            {!canAttachImages && !canAttachFiles && presets.length === 0 &&
              !capabilities.actions.goal && !capabilities.actions.review && !capabilities.actions.plan && (
              <span className="sb-menu-empty">暂无可添加内容</span>
            )}
          </div>
        </details>
        {<>
        {!config.managedPurpose && (agent?.capabilities.permissionModes.length ?? 0) > 0 && (
          <label className="sb-cfg">
            <select
              value={config.permissionMode || ''}
              disabled={!canConfigure || roleLocked}
              onChange={(e) => onUpdateConfig({ permissionMode: e.target.value as PermissionMode })}
              title={roleLocked ? `角色 ${roleSnapshot?.name} 已锁定权限模式` : agent?.capabilities.permissionModes.find(mode => mode.id === config.permissionMode)?.hint || '权限模式'}
            >
              {agent!.capabilities.permissionModes.map((p) => (
                <option key={p.id} value={p.id} title={p.hint}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {teamName ? (
          <span className="composer-role-pill" title={`专家团 ${teamName}`}>
            专家团 · {teamName}
          </span>
        ) : roleSnapshot && (
          <span className="composer-role-pill" title={`角色 ${roleSnapshot.name}`}>
            角色 · {roleSnapshot.name}
          </span>
        )}
        {!teamName && <PlanModeBadge
          mode={config.collaborationMode || 'default'}
          onExit={() => onSetCollaborationMode('default')}
        />}
        {!teamName && agent && (roleLocked || config.managedPurpose==='router' ? (
          <span className="sb-effort-btn is-locked" title={config.managedPurpose==='router'?'Router 运行配置在 superAgent配置中修改':`角色 ${roleSnapshot?.name} 已锁定运行画像`}>
            {showFast && config.fastMode && <span className="sb-flash" aria-hidden><UiIcon name="zap" size={13} /></span>}
            <span className="sb-effort-ico" aria-hidden><AgentIcon agentId={agent.id} adapter={agent.adapter} size={14} /></span>
            {agent.capabilities.modelSelect && <span className="sb-effort-model">{modelLabel}</span>}
            {typeof modelDef?.loadPercent === 'number' && <LoadBadge percent={modelDef.loadPercent} />}
            {(nativeThinking || agent.capabilities.reasoningEffort) && selectedEffort && (
              <span className="sb-effort-lvl">{effortLabel(selectedEffort)}</span>
            )}
            {showMax && config.maxMode && <span className="sb-maxtag" aria-hidden>{mcodeMax ? '1M' : 'Max'}</span>}
          </span>
        ) : (
          <details
            className="sb-menu sb-agent"
            onToggle={(e) => { if (!(e.currentTarget as HTMLDetailsElement).open) setActiveSub(null) }}
          >
            <summary className="sb-effort-btn" title="Agent、模型与运行档位">
              {showFast && config.fastMode && <span className="sb-flash" aria-hidden><UiIcon name="zap" size={13} /></span>}
              <span className="sb-effort-ico" aria-hidden><AgentIcon agentId={agent.id} adapter={agent.adapter} size={14} /></span>
              {agent.capabilities.modelSelect && (
                <span className="sb-effort-model">{modelLabel}</span>
              )}
              {typeof modelDef?.loadPercent === 'number' && <LoadBadge percent={modelDef.loadPercent} />}
              {agent.adapter === 'nika' && config.nikaPinnedModel && <UiIcon name="lock" size={12} />}
              {(nativeThinking || agent.capabilities.reasoningEffort) && selectedEffort && (
                <span className="sb-effort-lvl">{effortLabel(selectedEffort)}</span>
              )}
              {showMax && config.maxMode && <span className="sb-maxtag" aria-hidden>{mcodeMax ? '1M' : 'Max'}</span>}
            </summary>
            <div className="sb-menu-pop">
              <div className="sb-menu-label">运行体</div>
              {agent.capabilities.modelSelect && (
                <div className="sb-sub-wrap">
                  <button
                    type="button"
                    className={`sb-menu-item sb-sub-entry ${activeSub === 'model' ? 'is-sub-open' : ''}`}
                    disabled={!canSelectModel}
                    title={busy && agent.adapter === 'claude' ? '下一轮生效，当前回复继续使用原模型' : undefined}
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
                      {agent.models.map((m) => <ModelMenuOption key={m.id} model={m} selected={m.id === modelDef?.id}
                          disabled={!canSelectModel} pinnedModel={config.nikaPinnedModel}
                          onSelect={(e) => {
                            e.currentTarget.closest('details')?.removeAttribute('open')
                            setActiveSub(null)
                            onUpdateConfig({ model: m.id, modelSource: m.modelSource,
                              ...(agent.adapter === 'nika' ? { nikaPinnedModel: config.nikaPinnedModel === m.id ? config.nikaPinnedModel : null } : {}),
                              ...(agent.adapter === 'qoder' ? { qoderContextWindow: m.qoderContextWindows?.includes(config.qoderContextWindow || 0) ? config.qoderContextWindow : undefined, qoderThinkingDisabled: m.qoderThinkingDisabled ? config.qoderThinkingDisabled : undefined } : {}),
                              effort: !nativeThinking && agent.capabilities.reasoningEffort ? resolveModelEffort(m, config.effort, pref?.defaultEffort) : undefined,
                              ...(kimi ? { kimiThinking: resolveModelThinking(m, config.kimiThinking, pref?.defaultThinking, pref?.defaultEffort) } : {}),
                              ...(zcode ? { zcodeModelSelection: m.zcodeSelection && { ...m.zcodeSelection, options: { ...m.zcodeSelection.options, reasoningLevel: resolveModelThinking(m, config.zcodeModelSelection?.options?.reasoningLevel, pref?.defaultThinking, pref?.defaultEffort) } } } : {}) })
                          }}
                          onTogglePin={agent.adapter === 'nika' ? () => onUpdateConfig({ model: m.id,
                            nikaPinnedModel: config.nikaPinnedModel === m.id ? null : m.id,
                            effort: resolveModelEffort(m, config.effort, pref?.defaultEffort) }) : undefined}
                        />)}
                    </SubmenuPopover>
                  )}
                </div>
              )}
              {(nativeThinking || agent.capabilities.reasoningEffort) && efforts.length > 0 && (
                <div className="sb-sub-wrap">
                  <button
                    type="button"
                    className={`sb-menu-item sb-sub-entry ${activeSub === 'effort' ? 'is-sub-open' : ''}`}
                    disabled={!canSelectModel}
                    title={busy && agent.adapter === 'claude' ? '下一轮生效，当前回复继续使用原档位' : undefined}
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
                          disabled={!canSelectModel}
                          onClick={() => onUpdateConfig(kimi ? { kimiThinking: ef } : zcode ? { effort: undefined, zcodeModelSelection: { ...modelDef!.zcodeSelection!, options: { reasoningLevel: ef } } } : { effort: ef as ReasoningEffort, ...(agent.adapter === 'qoder' ? { qoderThinkingDisabled: false } : {}) })}
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
              {agent.adapter === 'qoder' && !!modelDef?.qoderContextWindows?.length && <div className="sb-sub-wrap">
                <button type="button" className="sb-menu-item sb-sub-entry" disabled={!canConfigure} aria-expanded={activeSub === 'qoder-context'} onClick={() => setActiveSub(value => value === 'qoder-context' ? null : 'qoder-context')}><UiIcon name="sliders" size={14} /><span className="sb-entry-body">上下文窗口<small>{(config.qoderContextWindow || modelDef.contextWindow)?.toLocaleString()}</small></span><UiIcon name="chevron-right" size={13} /></button>
                {activeSub === 'qoder-context' && <SubmenuPopover>{modelDef.qoderContextWindows.map(window => <button key={window} type="button" role="option" aria-selected={(config.qoderContextWindow || modelDef.contextWindow) === window} className={`sb-menu-item sb-sub-opt ${(config.qoderContextWindow || modelDef.contextWindow) === window ? 'is-sel' : ''}`} disabled={!canConfigure} onClick={() => onUpdateConfig({ qoderContextWindow: window })}><span className="sb-sub-radio" /><span className="sb-entry-body">{window.toLocaleString()} Token</span></button>)}</SubmenuPopover>}
              </div>}
              {agent.adapter === 'qoder' && modelDef?.qoderThinkingDisabled && <button type="button" className="sb-menu-item sb-switch-row" role="switch" aria-checked={config.qoderThinkingDisabled === true} disabled={!canConfigure} onClick={() => onUpdateConfig({ qoderThinkingDisabled: !config.qoderThinkingDisabled })}><UiIcon name="sliders" size={14} /><span className="sb-entry-body">关闭思考</span></button>}
              {(showFast || showMax) && (
                <>
                  <div className="sb-menu-sep" role="separator" />
                  {showFast && (
                    <button
                      type="button"
                      className={`sb-menu-item sb-switch-row ${config.fastMode ? 'is-on' : ''}`}
                      role="switch"
                      aria-checked={config.fastMode}
                      disabled={!canConfigure}
                      onClick={() => onUpdateConfig({ fastMode: !config.fastMode })}
                    >
                      <UiIcon name="zap" size={14} />
                      <span className="sb-entry-body">
                        快速模式
                        <small>更快返回、成本更高</small>
                      </span>
                      <span className={`sb-switch ${config.fastMode ? 'on' : ''}`} aria-hidden />
                    </button>
                  )}
                  {showMax && (
                    <button
                      type="button"
                      className={`sb-menu-item sb-switch-row ${config.maxMode ? 'is-on' : ''}`}
                      role="switch"
                      aria-checked={config.maxMode}
                      disabled={!canConfigure}
                      onClick={() => onUpdateConfig({ maxMode: !config.maxMode })}
                      title={mcodeMax
                        ? `MiniMax Code 上下文窗口 ${formatTokens(modelDef?.maxContextWindow)}（切换后会重启该会话的 MiniMax Code 进程）`
                        : `TraeX Max 模式（上下文 ${formatTokens(modelDef?.maxContextWindow)}）`}
                    >
                      <UiIcon name="diff" size={14} />
                      <span className="sb-entry-body">
                        {mcodeMax ? '1M 上下文' : 'Max 上下文'}
                        <small>{mcodeMax ? `上下文窗口 ${formatTokens(modelDef?.maxContextWindow)}，额度消耗更高` : '使用最大上下文窗口'}</small>
                      </span>
                      <span className={`sb-switch ${config.maxMode ? 'on' : ''}`} aria-hidden />
                    </button>
                  )}
                </>
              )}
            </div>
          </details>
        ))}
        </>}
        <div className="sb-spacer" />
        <div className="sb-primary-actions">
          {<ContextMeter
            used={contextUsed}
            usedPercentage={contextUsedPercentage}
            window={contextWindow}
            onCompact={onCompact}
            canCompact={canCompact}
            compacting={compacting}
            disabledReason={disabledReason}
          />}
          {editingQueueId ? (
            <button
              className="btn-send composer-send-btn"
              aria-label="保存"
              title="保存（⌘⏎）"
              onClick={() => void commitQueueEdit()}
              disabled={
                (!text.trim() && supportedAttachments.length === 0) || providerDisabled || sending
              }
            >
              <UiIcon name="check" size={16} />
            </button>
          ) : busy && !hasContent ? (
            <button
              className="btn-interrupt composer-stop-btn"
              aria-label={interruptsTeam ? '中止全部 Agent' : '中止'}
              title={interruptsTeam ? '中止全部 Agent (Esc)' : '中止 (Esc)'}
              onClick={onInterrupt}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              className="btn-send composer-send-btn"
              aria-label={queueBusy ? '加入等待队列' : '发送'}
              title={queueBusy ? '加入等待队列（⌘⏎）' : '发送（⌘⏎）'}
              onClick={() => void send(false)}
              disabled={
                (command
                  ? !text.trim()
                  : !text.trim() && supportedAttachments.length === 0 && trayComments.length === 0) ||
                providerDisabled ||
                switchBusy ||
                (compacting && command !== null) ||
                sending ||
                (busy && command !== null)
              }
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
      </div>
      {toolSessionReadOnly ? (
        <div className="composer-session-occupied" role="region" aria-label="工具会话只读提示">
          <div className="composer-session-occupied-content">
            <span className="composer-session-occupied-badge">工具创建 · 只读</span>
            <strong>这是由工具创建的会话</strong>
            <span>是否启用为普通会话？启用后可继续对话，并移回所属分组。</span>
            <button type="button" disabled={enablingToolSession} onClick={() => void enableToolSession()}>
              {enablingToolSession ? '启用中…' : '启用会话'}
            </button>
            {enableToolSessionError && <span role="alert">{enableToolSessionError}</span>}
          </div>
        </div>
      ) : sessionExternallyOccupied && (
        <div className="composer-session-occupied" role="status" aria-live="polite">
          <div className="composer-session-occupied-content">
            <span className="composer-session-occupied-badge">检测到外部运行</span>
            <strong>当前 Session 正在被其他 Agent 使用</strong>
            <span>为避免同时写入造成会话冲突，已暂时禁止修改。</span>
            <button
              type="button"
              disabled={refreshingNativeSession}
              onClick={() => void onRefreshNativeSession?.()}
            >
              {refreshingNativeSession ? '刷新中…' : '刷新会话'}
            </button>
          </div>
        </div>
      )}
      <ReviewStartDialog
        open={reviewDialogOpen}
        submitting={reviewSubmitting}
        onClose={() => setReviewDialogOpen(false)}
        onSubmit={startReview}
      />
    </div>
    </>
  )
}

function formatTokens(n?: number): string {
  if (!n) return '未知'
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`
}

/** Clear a composer draft only after main has accepted the delivery request. */
export async function submitComposerDraft(
  deliver: () => void | Promise<void>,
  accepted: () => void
): Promise<string | undefined> {
  try {
    await deliver()
    accepted()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export type ComposerDraftSnapshot = {
  sessionId?: string
  text: string
  attachments: string[]
  candidateIds: string[]
  command: ComposerCommand | null
  generation: number
}

export type ComposerDraftSeed = {
  sessionId: string
  agentId: string
  workdir: string
  text: string
  command: ComposerCommand | null
  candidateIds: string[]
  attachments: PickedFile[]
}

export function composerDraftSeedKey(seed: ComposerDraftSeed): string {
  return `${seed.sessionId}::${seed.agentId}::${seed.workdir}`
}

export function shouldHydrateComposerDraftSeed(
  seed: ComposerDraftSeed,
  appliedKey: string | null,
  sessionId: string | undefined,
  config: Pick<SessionConfig, 'agentId' | 'workdir'>
): boolean {
  return (
    sessionId === seed.sessionId &&
    config.agentId === seed.agentId &&
    config.workdir === seed.workdir &&
    appliedKey !== composerDraftSeedKey(seed)
  )
}

export function shouldReconcileComposerDraftSeed(
  seed: ComposerDraftSeed,
  appliedKey: string | null,
  reconciledKey: string | null,
  sessionId: string | undefined,
  config: Pick<SessionConfig, 'agentId' | 'workdir'>,
  capabilities: NativeCapabilitySnapshot,
  capabilitiesReady: boolean
): boolean {
  const key = composerDraftSeedKey(seed)
  return (
    capabilitiesReady &&
    capabilities.errors.length === 0 &&
    sessionId === seed.sessionId &&
    config.agentId === seed.agentId &&
    config.workdir === seed.workdir &&
    capabilities.agentId === seed.agentId &&
    capabilities.workdir === seed.workdir &&
    appliedKey === key &&
    reconciledKey !== key
  )
}

export function filterComposerSeedAttachments(
  attachments: readonly PickedFile[],
  canAttachImages: boolean,
  canAttachFiles: boolean
): PickedFile[] {
  return attachments.filter((attachment) =>
    attachment.kind === 'image' ? canAttachImages : canAttachFiles
  )
}

export function snapshotComposerDraft({
  sessionId,
  text,
  attachments,
  candidateIds,
  command,
  generation
}: {
  sessionId?: string
  text: string
  attachments: readonly Attachment[]
  candidateIds: readonly string[]
  command: ComposerCommand | null
  generation: number
}): ComposerDraftSnapshot {
  return {
    sessionId,
    text,
    attachments: attachments.map(snapshotAttachment),
    candidateIds: [...candidateIds],
    command,
    generation
  }
}

export function shouldResetComposerDraft(
  current: ComposerDraftSnapshot,
  accepted: ComposerDraftSnapshot
): boolean {
  return current.generation === accepted.generation && sameComposerDraftState(current, accepted)
}

/** Goal clears only its accepted text/command; candidates and attachments stay. */
export function shouldResetGoalDraft(
  current: ComposerDraftSnapshot,
  accepted: ComposerDraftSnapshot
): boolean {
  return shouldResetComposerDraft(current, accepted)
}

function sameComposerDraftState(
  a: Pick<ComposerDraftSnapshot, 'sessionId' | 'text' | 'attachments' | 'candidateIds' | 'command'>,
  b: Pick<ComposerDraftSnapshot, 'sessionId' | 'text' | 'attachments' | 'candidateIds' | 'command'>
): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.text === b.text &&
    sameStringList(a.attachments, b.attachments) &&
    sameStringList(a.candidateIds, b.candidateIds) &&
    a.command === b.command
  )
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function snapshotAttachment(attachment: Attachment): string {
  return `${attachment.kind}:${attachment.path}:${attachment.name}`
}

export type ComposerDelivery =
  | { kind: 'goal'; action: Extract<NativeThreadAction, { type: 'goal.set' }> }
  | {
      kind: 'turn'
      prompt: string
      attachments?: Attachment[]
      selection: NativeTurnSelectionRequest
      activatePlan: boolean
      /** 选中即评论 — structured comment cards for the sent bubble (+ persisted). */
      comments?: BubbleComment[]
      /** 选中即评论 — the instruction shown as the bubble's main text. */
      displayText?: string
    }

export function buildNativeGoalRoundLimit(value: string): { maxRounds?: number } {
  const trimmed = value.trim()
  if (!trimmed) return {}
  const maxRounds = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new Error('最多回合必须是正整数')
  return { maxRounds }
}

export function buildNativeGoalLimits(provider: AgentDef['adapter'] | undefined, values: { maxRounds?: string; tokenBudget?: string }): { maxRounds?: number; tokenBudget?: number } {
  if (provider === 'deepseek') return buildNativeGoalRoundLimit(values.maxRounds || '')
  if (provider !== 'grok' && provider !== 'mcode' && provider !== 'qoder') return {}
  const trimmed = (values.tokenBudget || '').trim()
  const rounds = provider === 'qoder' && values.maxRounds?.trim() ? buildNativeGoalRoundLimit(values.maxRounds) : {}
  if (!trimmed) return rounds
  const tokenBudget = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(tokenBudget) || tokenBudget < 1) throw new Error('Token 预算必须是正整数')
  return { ...rounds, tokenBudget }
}

export function NativeGoalOptions({ provider = 'deepseek', value, disabled, onChange }: { provider?: AgentDef['adapter']; value: string; disabled: boolean; onChange: (value: string) => void }): JSX.Element {
  if (provider === 'kimi') return <div className="native-goal-options candidate-hint"><span>原生 Goal · 预算不可设置</span></div>
  const grok = provider === 'grok' || provider === 'mcode' || provider === 'qoder'
  const label = grok ? 'Token 预算' : '最多回合'
  return <div className="native-goal-options candidate-hint">
    <label>{label} <input className="native-goal-rounds-input" type="number" min="1" step="1" placeholder={provider === 'qoder' ? '留空不设置' : '官方默认'} aria-label={`${provider === 'qoder' ? 'Qoder' : provider === 'mcode' ? 'MiniMax Code' : grok ? 'Grok' : 'DeepSeek'} Goal ${label}`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>
    <span>{grok ? provider === 'qoder' ? '未提供可核验 Token 时停止预算任务；留空使用原生轮次限制' : '原生 Goal · 留空使用默认预算' : '由 DeepSeek Harness 自动继续'}</span>
  </div>
}

// 选中即评论 — the fallback shown in the user bubble when the composer is empty.
// Codex leaves `## My request:` empty on the wire in this case.
export const DEFAULT_COMMENT_INSTRUCTION = '解决一下这些注释'

export function buildComposerDelivery(
  command: ComposerCommand | null,
  text: string,
  attachments: readonly Attachment[],
  candidateIds: readonly string[],
  comments: readonly (BubbleComment & { filePath?: string })[] = [],
  provider: AgentDef['adapter'] | undefined = 'codex'
): ComposerDelivery | null {
  const prompt = text.trim()
  if (command === 'goal') {
    return prompt ? { kind: 'goal', action: { type: 'goal.set', objective: prompt } } : null
  }
  if (command === 'plan' && !prompt) return null
  // 选中即评论 — mirror Codex's response-annotations wire format while keeping
  // the existing structured cards and concise display text in the user bubble.
  if (!prompt && attachments.length === 0 && comments.length === 0) return null
  if (comments.length > 0) {
    const bubbleComments = comments.map(({ quote, comment, filePath }) => ({
      quote: filePath ? `文件：${filePath}\n${quote}` : quote,
      comment,
    }))
    const codexAnnotations = provider === 'codex' || provider === 'traex'
    const items = bubbleComments.map(({ quote, comment }) => {
      const normalizedComment = comment.trim()
      return codexAnnotations
        ? { text: quote.trim(), ...(normalizedComment ? { annotation: normalizedComment } : {}) }
        : { quote: quote.trim(), ...(normalizedComment ? { comment: normalizedComment } : {}) }
    })
    const wire = codexAnnotations
      ? `\n# Response annotations:\n${RESPONSE_ANNOTATION_INSTRUCTION}\n<response-annotations>\n${JSON.stringify(items)}\n</response-annotations>\n\n## My request:\n${prompt}\n`
      : `\n# Response comments:\n${RESPONSE_COMMENT_INSTRUCTION}\n<response-comments>\n${JSON.stringify(items)}\n</response-comments>\n\n## My request:\n${prompt}\n`
    return {
      kind: 'turn',
      prompt: wire,
      attachments: attachments.length ? [...attachments] : undefined,
      selection: { candidateIds: [...candidateIds] },
      activatePlan: command === 'plan',
      comments: bubbleComments,
      displayText: prompt || DEFAULT_COMMENT_INSTRUCTION
    }
  }
  return {
    kind: 'turn',
    prompt,
    attachments: attachments.length ? [...attachments] : undefined,
    selection: { candidateIds: [...candidateIds] },
    activatePlan: command === 'plan'
  }
}

export async function dispatchComposerDelivery(
  delivery: ComposerDelivery,
  force: boolean,
  handlers: {
    runNativeAction: (action: NativeThreadAction) => void | Promise<void>
    send: (
      prompt: string,
      attachments?: Attachment[],
      selection?: NativeTurnSelectionRequest,
      activatePlan?: boolean,
      bubble?: TurnBubbleInput
    ) => void | Promise<void>
    forceSend: (
      prompt: string,
      attachments?: Attachment[],
      selection?: NativeTurnSelectionRequest,
      bubble?: TurnBubbleInput
    ) => void | Promise<void>
  },
  clientTurnKey?: string
): Promise<void> {
  if (delivery.kind === 'goal') {
    await handlers.runNativeAction(delivery.action)
    return
  }
  const bubble: TurnBubbleInput | undefined = delivery.comments?.length || clientTurnKey
    ? { ...(delivery.comments?.length ? { comments: delivery.comments, displayText: delivery.displayText } : {}), ...(clientTurnKey ? { clientTurnKey } : {}) }
    : undefined
  if (force) {
    await handlers.forceSend(delivery.prompt, delivery.attachments, delivery.selection, bubble)
    return
  }
  await handlers.send(
    delivery.prompt,
    delivery.attachments,
    delivery.selection,
    delivery.activatePlan,
    bubble
  )
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

function isPendingQueueItem(item: QueueItem): boolean {
  return ((item as QueueItem & { state?: string }).state ?? 'pending') === 'pending'
}

export async function dequeueComposerQueueItem(
  id: string,
  getEditingQueueId: () => string | null,
  dequeue: (id: string) => void | Promise<void>,
  cancelEdit: () => void
): Promise<string | undefined> {
  try {
    await dequeue(id)
    if (getEditingQueueId() === id) cancelEdit()
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}
