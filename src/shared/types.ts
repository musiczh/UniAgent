// Shared types between main and renderer.
import { isDistributionAgent } from './distribution.ts'

import type {
  CollaborationModeId,
  ComposerCommand,
  GoalState,
  NativeCapabilitySnapshot,
  NativeThreadAction,
  NativeTurnSelectionRequest,
  ResolvedNativeTurnContext
} from './nativeCapabilities.ts'
import type { ZCodeEventCursor, ZCodeModelSelection, ZCodeSessionState } from './zcode'
import type { SettingsCategory } from './settingsNavigation'
import type { NikaBinding, NikaSnapshot } from './nika'
export type {
  CollaborationModeId,
  NativeReviewDraft,
  NativeThreadAction,
  NativeTurnSelectionRequest,
  ResolvedNativeTurnContext
} from './nativeCapabilities.ts'

/**
 * Reasoning effort levels, matching the real vocabulary used by codex / traecli
 * (`model_reasoning_effort`) and claude (`--effort`). Not every model supports
 * every level — `ModelDef.efforts` lists the ones a given model accepts.
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export const ALL_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export type CodexModelSourceKind = 'native' | 'third-party' | 'local'

export interface CodexModelSourceRef {
  kind: CodexModelSourceKind
  /** Stable source/provider identity. Native Codex does not need one. */
  sourceId?: string
}

/**
 * Unified *logical* permission-mode id — a stable internal contract shared by
 * every adapter. Each agent exposes only the subset it supports and gives each
 * its own display name (see agents.ts), because the underlying CLIs disagree on
 * both vocabulary and granularity:
 *   - codex : read-only / on-request / --approve-for-me / workspace-write /
 *             danger-full-access (Plan is a separate CollaborationMode)
 *   - traex : read-only / default / auto / bypass_permissions (Plan is a
 *             separate CollaborationMode)
 *   - claude: plan / manual / acceptEdits / auto / dontAsk / bypassPermissions
 *   - kimi: manual / yolo / auto (unattended); historical full-access stays yolo
 *   - zcode: build / edit / guarded / yolo (Plan is a separate CollaborationMode)
 * The mapping from a logical id → real flags lives in adapter.ts (one-shot) and
 * appServerAdapter.ts (streaming). The old three values remain valid ids so
 * `plan` remains in the union for Claude and historical data migration only.
 */
export const PERMISSION_MODE_IDS = [
  'plan', 'read-only', 'ask', 'approve-for-me', 'auto-edit', 'full-access',
  'unattended', 'deny-unapproved', 'guarded'
] as const
export type PermissionModeId = typeof PERMISSION_MODE_IDS[number]

/**
 * Back-compat alias. `PermissionMode` used to be the 3-value union; it is now a
 * widened alias of `PermissionModeId` so old code + persisted prefs keep working.
 */
export type PermissionMode = PermissionModeId

/**
 * A per-agent permission-mode descriptor. `id` is the stable logical contract;
 * `label`/`hint` are the agent-derived display name + tooltip (e.g. codex shows
 * `ask` as “请求批准”, claude has no pure read-only so omits it entirely).
 */
export interface PermissionModeDef {
  id: PermissionModeId
  /** Agent-derived display name shown in the selector (e.g. “计划模式”). */
  label: string
  /** Tooltip describing what the mode does for this agent. */
  hint: string
}

/**
 * Session lifecycle status machine (Doc4 需求6). Centrally driven by the
 * orchestrator; adapters map their exit codes / interrupt receipts / errors
 * into these. The renderer keys Composer + action-button availability off it.
 *
 *  - draft        — created but first turn not yet dispatched (transient).
 *  - idle         — no active turn; accepts new messages.
 *  - running      — a turn is in flight.
 *  - queued       — a turn is running AND messages are waiting in the FIFO queue.
 *  - awaiting-approval — a server→client request (question / approval) is pending.
 *  - cancelling   — an interrupt was sent, waiting for the CLI to acknowledge.
 *  - cancelled    — the user cancelled and the CLI confirmed.
 *  - interrupted  — a turn ended early (SIGINT / abort) without a clean result.
 *  - error        — the CLI exited non-zero or a protocol error occurred.
 *  - completed    — a Goal turn finished cleanly; terminal but reusable.
 *  - archived     — session closed / disposed.
 */
export type SessionStatus =
  | 'draft'
  | 'running'
  | 'queued'
  | 'awaiting-approval'
  | 'cancelling'
  | 'cancelled'
  | 'interrupted'
  | 'error'
  | 'completed'
  | 'idle'
  | 'archived'

/** A selectable model with its real per-model reasoning-effort support. */
export interface ModelDef {
  /** Selection key; supplemental Codex keys are decoded before protocol calls. */
  id: string
  /** Human-facing label (may differ from id, e.g. codex display_name). */
  label: string
  /** Reasoning efforts this model accepts. Empty means no effort control. */
  efforts: ReasoningEffort[]
  /** Provider-native thinking levels (Kimi), not coerced into common efforts. */
  imageInput?: boolean
  thinkingOptions?: string[]
  defaultThinking?: string
  /** Effort the CLI defaults to for this model, if any. */
  defaultEffort?: ReasoningEffort
  /**
   * Context window size in tokens (Doc1 需求3). Read from the CLI model cache
   * (`context_window`); undefined when unknown so the UI can degrade gracefully.
   */
  contextWindow?: number
  /** TraeX Max variant context window; absent when the model has no Max variant. */
  maxContextWindow?: number
  /** Whether TraeX advertises a distinct Max backend variant for this model. */
  supportsMax?: boolean
  /**
   * Server-side load percentage (Doc1 — TraeX model load badge). Read from the
   * model cache's `business_metadata.load.load_percent` (snake_case, can exceed
   * 100 under overload). undefined when the field is absent so the badge hides.
   */
  loadPercent?: number
  /**
   * 需求9 — whether this model supports Codex "Fast"/priority service tier. Read
   * from the codex model cache (`service_tiers` carrying a `priority` id, or
   * `additional_speed_tiers` containing `fast`). When true the composer offers a
   * 快速 toggle that sends `serviceTier: 'priority'`; models without it hide it.
   */
  supportsFast?: boolean
  /** Routing identity used by Codex sessions; omitted for non-Codex agents. */
  modelSource?: CodexModelSourceRef
  zcodeSelection?: ZCodeModelSelection
  zcodeThoughtLevels?: string[]
  zcodeProviderLabel?: string
}

/** A built-in or custom agent definition. */
export interface AgentDef {
  id: string
  name: string
  /** Executable name resolved on PATH, or absolute path. */
  bin: string
  /** Which built-in adapter drives this agent. */
  adapter: 'codex' | 'traex' | 'claude' | 'grok' | 'kimi' | 'deepseek' | 'mcode' | 'zcode' | 'nika' | 'generic'
  icon: string
  builtin: boolean
  /** Capability manifest — UI collapses config accordingly. */
  capabilities: {
    modelSelect: boolean
    /** Whether prompts may carry image/file attachments. Defaults to true. */
    attachments?: boolean
    /** Whether any of this agent's models expose reasoning effort control. */
    reasoningEffort: boolean
    /**
     * Per-agent permission-mode descriptors (id + display name + hint). Derived
     * at detect time from the agent's real capabilities (see agents.ts); the
     * selector renders these directly, and the first entry is the default.
     */
    permissionModes: PermissionModeDef[]
    /**
     * Whether this agent streams token-level output via its `app-server`
     * (JSON-RPC) backend. When true the orchestrator drives it through
     * AppServerRunner (real streaming); when false/absent it falls back to the
     * one-shot `exec --json` path. Detected at probe time (see agents.ts).
     */
    streaming?: boolean
    /**
     * Whether the agent can inject a session-level system prompt at thread/process
     * startup (CLI flag or protocol field) instead of wrapping every user message.
     * The personal assistant may only be carried by agents with this capability.
     */
    startupSystemPrompt?: boolean
    /** Protocol-backed attachment gates; omitted keeps legacy adapters unchanged. */
    imageAttachments?: boolean
    fileAttachments?: boolean
    /** Native session operations the provider advertised during its handshake. */
    sessionList?: boolean
    sessionLoad?: boolean
    sessionResume?: boolean
    /** Provider can interrupt an already-running turn with a new prompt. */
    steer?: boolean
    /** Provider can accept a normal prompt after the current task completes. */
    followup?: boolean
    /** Whole-session fork; independent from point/cross-agent fork support. */
    sessionFork?: boolean
    sessionForkAtTurn?: boolean
    crossAgentFork?: boolean
    sideChat?: boolean
    /** Provider emits child-agent lifecycle and child transcript events. */
    structuredSubagents?: boolean
    /** Provider can request a bounded structured form from the user. */
    formElicitation?: boolean
    /** Provider form can accept arbitrary free-text / Other answers. */
    freeTextElicitation?: boolean
    nativeGoal?: boolean
    nativeReview?: boolean
    structuredUsage?: boolean
    capabilityInventory?: boolean
    additionalDirectoriesNew?: boolean
    additionalDirectoriesResume?: boolean
    /** Slash commands advertised by the live protocol session. */
    commands?: string[]
    /** Collaboration modes advertised by the live protocol session. */
    collaborationModes?: CollaborationModeId[]
    /** `acp` for protocol-native providers such as Grok. */
    protocol?: 'acp' | 'web' | 'app-server' | 'stream-json' | 'exec' | 'zcode-protocol'
  }
  /** Real, per-model list (populated from the CLI's model cache at detect time). */
  models: ModelDef[]
  defaultModel?: string
  /** Whether the underlying CLI was detected on this machine. */
  installed?: boolean
  nika?: NikaSnapshot
  /** MiniMax Code 账号区域，决定额度控制台的站点域名。 */
  mcode?: { region: 'cn' | 'global' }
  version?: string
  lifecycle?: AgentLifecycleState
  /** Installed but unable to satisfy the production protocol contract. */
  incompatible?: boolean
  /** Installed protocol provider whose authenticated session probe was rejected. */
  authenticationRequired?: boolean
  unavailableReason?: string
}

export type AgentAvailability = 'not-installed' | 'needs-auth' | 'unhealthy' | 'available'
export type AgentUpdateStatus = 'idle' | 'checking' | 'available' | 'current' | 'updating' | 'failed'

export interface AgentLifecycleState {
  availability: AgentAvailability
  detectionStatus?: 'detecting' | 'failed'
  detectionPhase?: 'preparing' | 'recovering'
  /** Detection failures survive independent update checks until a successful re-probe. */
  detectionError?: string
  lastReadyAt?: number
  auth: 'unknown' | 'authenticated' | 'required' | 'error'
  health: 'unknown' | 'healthy' | 'unhealthy'
  /** Whether UniAgent can update this Agent's installed runtime. */
  selfUpdateSupported?: boolean
  currentVersion?: string
  availableVersion?: string
  currentRevision?: string
  availableRevision?: string
  updateStatus: AgentUpdateStatus
  message?: string
  checkedAt: number
}

export interface AgentLifecycleProgress {
  agentId: string
  phase: 'detecting' | 'checking-update' | 'updating' | 'verifying' | 'completed' | 'failed'
  message: string
  currentVersion?: string
  availableVersion?: string
}

/** UI color theme preference. `system` follows the OS appearance. */
export type ThemePreference = 'system' | 'dark' | 'light'
export type NotificationMode = 'unfocused' | 'always' | 'off'

/** Agent choices exposed by default in the new-task composer. */
export const DEFAULT_ENABLED_AGENT_IDS = (['codex', 'traex'] as const).filter(id => isDistributionAgent(id))

export interface AppSettings {
  schemaVersion: 1
  autoUpdateAgentsOnLaunch: boolean
  /** Update enabled Agent CLIs after five minutes without pending or active work; default false. */
  autoUpdateAgentsWhenIdle?: boolean
  /** Agent ids available in the new-task composer; absent legacy data uses the default list. */
  enabledAgentIds?: string[]
  /** Check the Bits version manifest on launch and once per day. */
  autoCheckUpdate: boolean
  /** UI color theme (default `system`). */
  theme?: ThemePreference
  /** macOS desktop notifications: while unfocused (default), always, or never. */
  notificationMode?: NotificationMode
  /** Prevent automatic system sleep while the app runs; allow the display to sleep. Default false. */
  preventSleep?: boolean
  /**
   * When opening the file browser or code review, cover the whole window
   * (hiding the left session sidebar) by default. Toggle-able from the header;
   * default false keeps the sidebar visible.
   */
  coverSidebar?: boolean
  /** Up to five settings shortcuts in the main sidebar; an empty list hides all. */
  sidebarShortcuts?: SettingsCategory[]
  /**
   * 需求功能总开关，默认关闭。关闭后隐藏需求入口并停用需求运行时（不注入指令、
   * 不同步 context.md）；已有需求数据与会话关联完整保留。
   */
  requirementsEnabled?: boolean
  /**
   * 需求4（飞书 Bot 远程驱动）— optional Feishu long-connection bot config. Absent
   * until the user enables it (one-click install or manual App ID/Secret). The
   * App Secret is persisted 0600 with the rest of app-settings.json (static
   * storage risk, never logged in plaintext).
   */
  feishu?: FeishuSettings
  assistantFeishu?: FeishuSettings
}

/**
 * 需求4 — the shape accepted by `settings:set`. `feishu` is a shallow patch (so
 * the renderer can toggle one field without re-sending the App Secret); passing
 * `feishu: null` clears the block.
 */
export interface AppSettingsPatch {
  autoUpdateAgentsOnLaunch?: boolean
  autoUpdateAgentsWhenIdle?: boolean
  enabledAgentIds?: string[]
  autoCheckUpdate?: boolean
  theme?: ThemePreference
  notificationMode?: NotificationMode
  preventSleep?: boolean
  coverSidebar?: boolean
  sidebarShortcuts?: SettingsCategory[]
  requirementsEnabled?: boolean
  feishu?: Partial<FeishuSettings> | null
  assistantFeishu?: Partial<FeishuSettings> | null
}

export type AppUpdateError =
  | 'auth_required'
  | 'git_unavailable'
  | 'network'
  | 'invalid_manifest'
  | 'no_asset'
  | 'no_release'

/** Safe, renderer-facing result of a Bits version-manifest check. */
export interface AppUpdateState {
  currentVersion: string
  latestVersion?: string
  hasUpdate: boolean
  downloadUrl?: string
  releaseUrl: string
  checkedAt: number
  error?: AppUpdateError
}

/** 需求4 — Feishu bot + default-session config persisted in app-settings.json. */
export interface FeishuSettings {
  /** Master switch: when true, the main process starts the WSClient bridge. */
  enabled: boolean
  /** Feishu self-built app credentials. */
  appId: string
  /** Persisted 0600 with the settings file; static storage risk, never logged. */
  appSecret: string
  /** Display name returned by Feishu's bot info API. */
  botName?: string
  /** true ⇒ only push while locked, display-asleep, or past an enabled idle threshold. */
  notifyOnlyWhenLocked: boolean
  /** Idle seconds that count as away from keyboard. Defaults to 300; 0 disables. */
  idleThresholdSec: number
  /** Defaults used when a private-chat message spins up a brand-new session. */
  defaultAgentId?: string
  defaultModel?: string
  defaultEffort?: ReasoningEffort
  defaultPermissionMode?: PermissionMode
  /** Project used when a Feishu message starts a new topic. */
  defaultProjectId?: string
  /** @deprecated Read-only migration source for settings written before projects. */
  defaultWorkdir?: string
  /** Explicit notification destination. Existing values without a type are group bindings. */
  notifyChatId?: string
  notifyChatType?: 'private' | 'group'
  /** Display name of the destination, echoed read-only in settings. */
  notifyChatName?: string
}

export interface FeishuNotificationTarget {
  kind: 'private' | 'group'
  chatId: string
  name?: string
}

export interface FeishuNotificationBinding {
  kind: 'private' | 'group'
  chatId?: string
  name?: string
  error?: string
}

/** 需求 — one group the bot is a member of, surfaced by `feishu:scanGroups`. */
export interface FeishuGroupChat {
  chatId: string
  name: string
}

/**
 * 需求4 — session ↔ Feishu 话题(thread) mapping, persisted to
 * `~/.uniagent/feishu-threads.json`. One session binds one thread; every later
 * push replies into the same thread. `lastPushedSeq` is the水位 used to dedupe
 * (only terminal events past the水位 are pushed).
 */
export interface FeishuThreadLink {
  sessionId: string
  /** The private or group chat id. */
  chatId: string
  /** The thread root or first private message id; empty for an App-only private binding. */
  rootMessageId: string
  /** False for an assistant private chat; absent preserves legacy thread replies. */
  replyInThread?: boolean
  /** Bot that owns the title root; null for non-title/user roots, absent for legacy links. */
  rootAppId?: string | null
  /** Bot connection that owns this mapping; independent of the root's sender. */
  botAppId?: string
  /** Last title confirmed on the root message, used to avoid redundant edits. */
  rootTitle?: string
  /** Stop editing this root after Feishu's edit count/time limit is reached. */
  rootTitleSyncBlocked?: boolean
  rootTitleRetryAt?: number
  /** Feishu thread_id, back-filled after the first reply_in_thread. */
  threadId?: string
  /** High-water mark of already-pushed event seq (dedupe). */
  lastPushedSeq: number
  /** The approval/question request id currently awaiting an answer in the thread. */
  pendingRequestId?: string
  /**
   * Who is driving this session. A `'feishu'` session (started by, or taken over
   * from, a Feishu message) always gets its reply pushed back — otherwise a plain
   * chat while at the keyboard silently drops every answer. `'app'` sessions honor
   * the lock-screen门禁. Absent ⇒ treated as `'app'` (backward compatible).
   */
  driver?: 'feishu' | 'app'
}

/** 需求4 — live status of the Feishu bridge + one-click install wizard. */
export type FeishuInstallPhase =
  | 'idle'
  | 'installing'
  | 'awaiting-scan'
  | 'awaiting-login'
  | 'connected'
  | 'failed'

export interface FeishuStatus {
  /** Whether the bound bot should connect (independent of live connection). */
  enabled: boolean
  /** true once the WSClient reports ready. */
  connected: boolean
  /** Current install-wizard phase (drives the settings badge + retry entry). */
  phase: FeishuInstallPhase
  /** App id currently configured (echoed read-only after install). */
  appId?: string
  botName?: string
  configuring?: boolean
  notificationTarget?: FeishuNotificationTarget
  notificationBinding?: FeishuNotificationBinding
  /** A verification URL the user must open (during awaiting-scan/login). */
  verificationUrl?: string
  /** Human-readable message / last error (never contains the secret). */
  message?: string
}

export interface LifecycleMetrics {
  schemaVersion: 1
  firstLaunchAt: number
  firstSuccessfulTaskMs?: number
  initializationAttempts: number
  initializationSuccesses: number
  updateFailures: Record<string, number>
}

/** Unified Agent Event — every adapter normalizes native output into this. */
export type UAEType =
  | 'user_message'
  /** A Goal submission rendered as a marked user message and sent as a model prompt. */
  | 'goal_message'
  | 'agent_message'
  | 'reasoning'
  | 'command_exec'
  | 'file_change'
  | 'tool_call'
  /** TraeX hook lifecycle entry, merged by payload.id from started to completed. */
  | 'hook'
  /** Provider background task notification, merged by payload.id. */
  | 'background_task'
  | 'approval_request'
  | 'diff_update'
  | 'context_compaction'
  /**
   * Codex 跨来源模型切换的进度卡片。一次切换全程共用一个稳定的 payload.id，
   * 以 running → success/failed 快照重复发射，渲染端按 id 合并原地更新；
   * 切换期间 codex 的 resume 模型不一致原始警告折叠进 payload.hints。
   */
  | 'model_switch'
  | 'error'
  | 'system_notice'
  | 'raw_output'
  | 'turn_started'
  | 'turn_completed'
  /**
   * Doc1 — TraeX server-side queue status for the current turn. Emitted from the
   * adapter's `queue/status` notification and merged under a fixed id
   * `queue-<turnId>` so the growing state (queued → waiting → ready) renders as
   * one banner. Only TraeX emits this; codex/claude degrade (never emitted).
   */
  | 'queue_status'
  /**
   * Doc4 — normalized multi-step plan / todo list for the current turn. codex/
   * traex push `turn/plan/updated`; codex one-shot exec emits an `update_plan`
   * tool call; claude emits a `TodoWrite` tool call. All three normalize to a
   * `{ id:'plan-<turnId>', steps: PlanStep[], explanation? }` payload merged under
   * the fixed id so repeated updates replace in place (like queue_status).
   */
  | 'plan_update'
  /**
   * Doc5 — sub-agent (multi-agent collaboration) snapshot. codex/traex push
   * `collabAgentToolCall` / `subAgentActivity` ThreadItems when a parent agent
   * spawns / messages / waits on child agents. Each carries a snapshot of every
   * child agent's live status; we emit one `subagent` event per update.
   */
  | 'subagent'

export type UAEState = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'

/**
 * `payload` is an open bag, but a few keys carry cross-cutting meaning:
 *  - `id`    — item/tool/command id. The renderer merges events that share the
 *              same `(type, id)`, so streaming adapters can re-emit a growing
 *              snapshot under one id (agent_message / reasoning / command_exec).
 *  - `text`  — the *accumulated* snapshot so far (not just the latest delta),
 *              so a naive last-write-wins merge always renders the full text.
 *  - `delta` — optional latest chunk, for consumers that prefer to append.
 */
export interface UAEvent {
  sessionId: string
  seq: number
  ts: number
  type: UAEType
  state?: UAEState
  payload: Record<string, any>
}

/** An attachment (image / file) sent alongside a prompt (Doc4 需求3). */
export interface Attachment {
  /** 'image' renders as a thumbnail; 'file' as a chip. */
  kind: 'image' | 'file'
  /** Absolute path on disk (image pasted from clipboard is written to a temp file). */
  path: string
  /** Display name. */
  name: string
  /** MIME type when known. */
  mime?: string
}

/** File-dialog result; previewDataUrl is renderer-only and never sent to an agent. */
export interface PickedFile extends Attachment {
  previewDataUrl?: string
}

/**
 * 选中即评论 — a confirmed annotation that rode along with a user turn. `quote`
 * is the selected agent text; `comment` is the user's note (may be empty). Kept
 * on the user turn so the sent bubble can re-render its comment cards, and
 * persisted in SessionStore so it survives an App restart.
 */
export interface BubbleComment {
  quote: string
  comment: string
}

/**
 * 选中即评论 — the bubble decorations a renderer sends alongside a turn: the
 * quote+comment cards and the instruction shown as the bubble's main text (the
 * wire prompt itself embeds the quotes). Persisted so the bubble survives an
 * App restart.
 */
export interface TurnBubbleInput {
  comments?: BubbleComment[]
  displayText?: string
}

/**
 * Small, bounded UI snapshot for a submitted user turn. Native provider
 * histories do not consistently retain attachments, MCP selections, or slash
 * commands, so SessionStore keeps these decorations alongside session metadata.
 */
export interface SubmittedUserMessage {
  /** Assistant-only original input, separate from the native memory context. */
  assistantText?: string
  assistantMessageId?: string
  type: 'user_message' | 'goal_message'
  /** Recorded while another task is active; renderer keeps it in that work timeline. */
  appendedToTurn?: true
  /** Trusted delivery source, recorded by the main process for this message only. */
  source?: 'feishu' | 'weixin' | 'app' | 'mcp'
  /** Zero-based position among all user/goal messages in the native transcript. */
  userOrdinal: number
  /** SHA-256 of the visible text; avoids duplicating prompts in sessions.json. */
  textHash: string
  acceptedAt: number
  command?: ComposerCommand
  attachments?: Attachment[]
  nativeContext?: ResolvedNativeTurnContext
  /** 选中即评论 — the quote+comment cards shown under this sent bubble. */
  comments?: BubbleComment[]
  /** 选中即评论 — the instruction shown as the bubble's main text (wire prompt embeds quotes). */
  displayText?: string
}

/**
 * Normalized per-turn token usage (Doc5 T1). Every adapter converts its native
 * usage shape into this so the renderer + cost math have one contract. Numbers
 * are *this turn's* totals (for streaming: end−start of the thread's `total`),
 * never a single model call's `last`.
 */
export interface TurnUsage {
  /** Native cancellation may return partial counters; never price these as final usage. */
  usageIsIncomplete?: boolean
  reasoningTokens?: number
  totalTokens?: number
  modelCalls?: number
  modelUsage?: Record<string, Partial<TurnUsage>>
  cacheCreationInputTokens?: number
  /** This turn's total input tokens (includes the cached-hit subset). */
  inputTokens: number
  /** This turn's total output tokens. */
  outputTokens: number
  /** This turn's cache-hit input tokens (a subset of inputTokens). */
  cachedInputTokens: number
  /** Current model context window, when known (streaming: modelContextWindow). */
  contextWindow?: number
  /** Model id used for pricing lookup. */
  modelId?: string
  /** Computed cost in USD; null/undefined when the model isn't priceable. */
  cost?: number | null
  /**
   * Context occupancy tokens (Doc5 T1 §4.1): the input of the LAST model call
   * (`last.inputTokens`), which reflects "how full the window is" — bounded,
   * unlike the per-turn `inputTokens` sum. Feeds the ContextMeter bar.
   */
  contextTokens?: number
  /**
   * G2-1: whole-session cumulative usage up to and including this turn. The
   * per-turn card shows only this turn's input/output; expanding it reveals
   * both this turn's full breakdown AND these session totals.
   */
  sessionInputTokens?: number
  sessionOutputTokens?: number
  sessionCachedInputTokens?: number
  sessionCost?: number | null
}

/**
 * One Codex rate-limit window (from codex app-server `token_count.rate_limits`).
 * `windowMinutes` maps the label (300=5 小时 / 10080=每周); `usedPercent` drives
 * remaining = 100 − usedPercent; `resetsAt` is a unix epoch **seconds** stamp.
 */
export interface CodexRateWindow {
  usedPercent: number
  windowMinutes: number
  resetsAt: number
}

/**
 * Latest Codex account quota snapshot. Rate limits are account-global (not per
 * session). Historical rollouts supply the initial snapshot; manual refresh
 * queries the authenticated app-server. Either window may be null (e.g. prolite
 * plans expose only the weekly `primary`).
 */
export interface CodexRateLimits {
  primary?: CodexRateWindow | null
  secondary?: CodexRateWindow | null
  planType?: string | null
  /** When this snapshot was captured (ms), for the settings "自动更新" hint. */
  capturedAt: number
}

/** Account allowance read through Grok's authenticated ACP billing extension. */
export interface GrokQuota {
  status: 'ready' | 'needs-auth' | 'unsupported' | 'error'
  capturedAt: number
  planType?: string
  window?: { label: string; usedPercent: number; resetsAt?: number }
  message?: string
}

/** A structured Skill or MCP entry discovered from an Agent's local inventory. */
export interface SkillRef {
  kind: 'skill' | 'mcp'
  name: string
  path?: string
  description?: string
}

export interface WorkspaceSelection {
  mode: 'local' | 'worktree'
  baseRef?: string
  requestId?: string
}

export interface SessionWorktree {
  id: string
  projectId: string
  sourcePrimaryDirectory: string
  repositoryRoot: string
  gitCommonDirectory: string
  checkoutRoot: string
  workdir: string
  baseRef: string
  baseCommit: string
  creationRequestId: string
  state: 'creating' | 'ready' | 'failed'
  lastError?: string
}

export interface ProjectGitInfo {
  currentBranch?: string
  branches: Array<{ ref: string; name: string }>
  canCreateWorktree: boolean
  unavailableReason?: string
  pendingWorktree?: SessionWorktree
}

export interface ProjectWorktree {
  path: string
  branch?: string
  commit?: string
  source: 'primary' | 'managed' | 'external'
  state: 'ready' | 'dirty' | 'locked' | 'missing' | 'creating' | 'failed' | 'busy'
  removalBlockedReason?: string
  sessions: Array<{ id: string; title: string }>
}

export type WorktreeTask =
  | { kind: 'message'; prompt: string; attachments?: Attachment[]; selection?: NativeTurnSelectionRequest; activatePlan?: boolean }
  | { kind: 'native'; action: NativeThreadAction }

export interface SessionConfig {
  nikaBinding?: NikaBinding
  /** Creation request only; the host supplies the immutable snapshot. */
  useAssistant?: boolean
  assistantSnapshot?: import('./assistant').PersonalAssistantSnapshot
  /** Main-process channel ownership; excludes this session from Feishu auto-binding. */
  assistantChannel?: 'weixin'
  agentId: string
  zcodeModelSelection?: ZCodeModelSelection
  /** Kimi's native thinking selection, separate from the common effort enum. */
  kimiThinking?: string
  /** Internal owner of a persistent Kimi role home shared by native forks. */
  kimiRuntimeOwnerId?: string
  /** Canonical native storage root; a resumed ID must not move to another home. */
  kimiDataHome?: string
  model?: string
  /** Persisted separately from the model ID so equal IDs cannot change provider. */
  modelSource?: CodexModelSourceRef
  /** Reasoning effort; undefined = let the model/CLI use its default. */
  effort?: ReasoningEffort
  collaborationMode?: CollaborationModeId
  /** Stable project identity. Missing only while legacy data is being migrated. */
  projectId?: string
  /** Creation-only selection; main strips it before persisting runtime config. */
  workspaceSelection?: WorkspaceSelection
  /** Main-owned checkout snapshot, retained when project paths are re-resolved. */
  worktree?: SessionWorktree
  workspaceNotice?: string
  /** Global requirement identity, independent of project. Paths are resolved by main. */
  requirementId?: string
  requirementDir?: string
  requirementDocPath?: string
  requirementName?: string
  /** Main-process-resolved primary directory. Never independently selected by UI. */
  workdir: string
  /** Main-process-resolved project roots beyond `workdir`. */
  additionalDirectories?: string[]
  /**
   * Omitted until a protocol-native session has advertised or confirmed a
   * permission mode. Legacy adapters are normalized to a concrete advertised
   * mode at the orchestrator boundary before they are allowed to run.
   */
  permissionMode?: PermissionMode
  /** One-shot lifecycle initialization target, registered by main at creation. */
  initializationTargetAgentId?: string
  initializationJobId?: string
  /**
   * 需求9 — Codex 快速模式. When true, codex turns are started with
   * `serviceTier: 'priority'` (the "Fast" tier). Only meaningful for codex
   * models whose cache advertises the priority tier; ignored by other adapters.
   */
  fastMode?: boolean
  /** TraeX Max backend variant. Only valid for models whose supportsMax is true. */
  maxMode?: boolean
  /** Immutable execution profile captured when an MCP role creates the session. */
  roleSnapshot?: AgentRoleSnapshot
}

/** Whether prompts for this agent may carry image/file attachments. */
export function agentSupportsAttachments(agent?: Pick<AgentDef, 'capabilities'>): boolean {
  return agent?.capabilities.attachments !== false
}

/**
 * Native-history conversion has writers only for these three built-ins, so they
 * are the only valid targets of a cross-agent transplant.
 */
export function isCrossForkTargetAgent(
  agent?: Pick<AgentDef, 'id' | 'adapter'>
): boolean {
  return !!agent && (
    (agent.id === 'codex' && agent.adapter === 'codex') ||
    (agent.id === 'traex' && agent.adapter === 'traex') ||
    (agent.id === 'claude' && agent.adapter === 'claude')
  )
}

/** Explicit read boundary for normalized cross-Agent history export. */
export function isCrossForkSourceAgent(
  agent?: Pick<AgentDef, 'id' | 'adapter'>
): boolean {
  return !!agent && isCrossForkTargetAgent(agent)
}


/**
 * Options negotiated for one concrete protocol session. Model and mode
 * inventories may vary between simultaneous sessions of the same provider, so
 * they must not be read solely from the process-wide AgentDef.
 */
export interface SessionAgentContract {
  grokNative?: GrokNativeContract
  models: ModelDef[]
  currentModelId?: string
  permissionModes: PermissionModeDef[]
  currentPermissionMode?: PermissionMode
  imageAttachments: boolean
  fileAttachments: boolean
  sessionList: boolean
  sessionLoad: boolean
  sessionResume: boolean
  steer?: boolean
  followup?: boolean
  sessionFork: boolean
  sessionForkAtTurn?: boolean
  crossAgentFork?: boolean
  sideChat?: boolean
  structuredSubagents?: boolean
  formElicitation?: boolean
  freeTextElicitation?: boolean
  nativeGoal?: boolean
  nativeReview?: boolean
  structuredUsage?: boolean
  capabilityInventory?: boolean
  additionalDirectoriesNew?: boolean
  additionalDirectoriesResume?: boolean
  commands: string[]
  collaborationModes?: CollaborationModeId[]
}

export type GrokNativeCapability = 'goal' | 'steer' | 'subagents' | 'questions' | 'images' | 'usage' | 'fork' | 'inventory'
export type GrokCapabilityStatus = 'unknown' | 'probing' | 'verified' | 'unsupported' | 'temporarily_unavailable' | 'degraded'
export interface GrokNativeContract {
  version: string
  confirmed: boolean
  capabilities: Record<GrokNativeCapability, { status: GrokCapabilityStatus; reason?: string }>
}

export interface AgentContractUpdate {
  sessionId: string
  agentId: string
  config: SessionConfig
  contract: SessionAgentContract
}

/** Origin of a session — created inside UniAgent, or imported from CLI history. */
export type SessionOrigin = 'created' | 'imported'
export type SessionImportMode = 'snapshot' | 'direct'

export interface HistoryLoadProgress {
  phase: 'preparing' | 'locating' | 'reading' | 'reading-parent' | 'rollbacks' |
    'scanning' | 'parsing' | 'subagents' | 'fork-points' | 'replaying' | 'rendering' | 'complete'
  completed?: number
  total?: number
}

export interface HistoryPreviewProgress extends HistoryLoadProgress {
  requestId: string
  percent: number
}

export interface HistoryForkPoint {
  eventSeq: number
  kind: 'after-turn' | 'message'
  nativeId: string
}

export interface ClaudeForkOrigin {
  sessionId: string
  messageId: string
}

export interface Session {
  worktreeTask?: WorktreeTask
  worktreeTaskError?: string
  previousSessionId?: string
  assistantEndReason?: 'new' | 'clear'
  id: string
  /** Managed team seat: ordinary session mutation routes must respect this binding. */
  teamBinding?: { teamProjectId: string; memberId: string }
  title: string
  config: SessionConfig
  status: SessionStatus
  createdAt: number
  /** Last activity time (Doc5 T3) — used to keep the freshest of any dupes. */
  updatedAt?: number
  nativeSessionId?: string
  zcodeState?: ZCodeSessionState
  zcodeStateInvalid?: true
  /** The CLI materializes this native branch on its first submitted prompt. */
  pendingClaudeFork?: ClaudeForkOrigin
  /** Last provider-confirmed Goal snapshot; reconciled on every native thread connection. */
  goal?: GoalState
  /** Session-scoped protocol options, populated after a live ACP handshake. */
  agentContract?: SessionAgentContract
  /** 'created' by UniAgent, or 'imported' from a CLI's native history (Doc2). */
  origin?: SessionOrigin
  /** G2-4: archived sessions are hidden from the main list and live in the
   * archive drawer, from where they can be restored or permanently deleted. */
  archived?: boolean
  /**
   * 需求4: pinned sessions sort to the top of the list and show a pin marker.
   * Finalized titles flip `titleLocked` so later provider updates or an imported /
   * replayed session's first-message heuristic cannot overwrite the first title.
   */
  pinned?: boolean
  /** True after the first automatic title or a manual rename, so auto-title stops. */
  titleLocked?: boolean
  /**
   * Crash-safe message outbox. Items stay here until their owning provider turn
   * reaches a terminal result. A recovered `dispatching`/`steering` item is
   * replayed by legacy providers (at-least-once). Kimi marks uncertain delivery
   * for explicit user review/edit rather than automatically replaying it.
   */
  pendingQueue?: DurableQueueItem[]
  /** Recent submitted turns used to restore message chips and images on restart. */
  submittedUserMessages?: SubmittedUserMessage[]
  /**
   * Whether an imported native CLI session is a read-only snapshot. Legacy
   * snapshots remain read-only and use the 分叉 bar; a direct native-Agent import
   * stores `importMode:'direct'` plus `false` so UniAgent can resume the original id.
   */
  readOnly?: boolean
  /** Explicit provenance for a native session imported without fork lineage. */
  importMode?: SessionImportMode
  /**
   * 需求5 — branch lineage. Set only on a session minted by a fork: it points at the
   * source (agentId + native id) the fork branched from. `mode` distinguishes a
   * lossless same-agent byte-copy fork ('same') from normalized rebuilds within
   * the same Agent ('compatible') or across Agents ('cross').
   */
  forkedFrom?: { agentId: string; nativeId: string; mode: 'same' | 'cross' | 'compatible' }
  /**
   * Doc5 — live snapshot of child (sub-)agents spawned during collaboration,
   * upserted by agentThreadId as `subagent` events arrive. Empty/absent for
   * ordinary single-agent sessions.
   */
  subagents?: UASubAgent[]
  /**
   * 需求5 — the create_uniagent_task handoff id that materialized this session
   * (present only for sessions born from a handoff request). Lets the result be
   * routed back to the blocking MCP caller and lets the UI badge the relationship.
   */
  handoffId?: string
  /** User explicitly enabled this MCP session (or continued it in older releases). */
  handoffUserContinued?: boolean
  /**
   * 需求5 — true while an external agent is blocking (wait=true) on this
   * session's result. Set when a wait=true handoff materializes the session,
   * cleared once it reaches a terminal state. Drives the clickable「等待中」badge.
   */
  handoffWaiting?: boolean
  /**
   * Fix#4 — set on the CALLER session while its turn is blocked (wait=true) on an
   * outbound create_uniagent_task handoff to another agent. Drives a dedicated
   * "等待 <agent> 的 <task>" status line (instead of the generic "思考中"), and
   * clicking it jumps to `awaitedSessionId`. Cleared when the handoff finishes.
   * Deliberately NOT persisted (process-local, like handoffWaiting).
   */
  waitingForHandoff?: {
    handoffId: string
    awaitedSessionId: string
    agentId: string
    agentName: string
    label: string
  }
}

/** Process-local push; the correction seq is intentionally not persisted in SessionStore. */
export interface SessionUpdatedPush {
  session: Session
  backendConfigCorrectionSeq?: number
  /** Process-local only: true while this Electron process owns a live app-server runner. */
  hasLiveStreamer?: boolean
}

/** Process-local native Session ownership observed without loading/resuming it. */
export interface NativeSessionOccupancy {
  state: 'available' | 'occupied' | 'unsupported'
  checkedAt: number
  /** File revision observed before probing holders; also available without lsof. */
  historyVersion?: string
}

export interface SessionRuntimeState {
  events: UAEvent[]
  zcodeEvents?: ZCodeEventCursor
  backendConfigCorrectionSeq?: number
  /** False after app restart/archive until a new turn establishes the runner. */
  hasLiveStreamer: boolean
  /** Never persisted: a fresh read-only cross-process ownership check. */
  nativeSessionOccupancy: NativeSessionOccupancy
  nativeCapabilities?: NativeCapabilitySnapshot
  goal?: GoalState
}

export interface NativeSessionRefreshResult {
  session: Session
  runtime: SessionRuntimeState
}

/** Overlay a session's negotiated options without contaminating sibling sessions. */
export function agentForSession(agent: AgentDef, session?: Session | null): AgentDef {
  const contract = session?.agentContract
  if (!contract) return agent
  return {
    ...agent,
    models: contract.models,
    defaultModel: contract.currentModelId,
    capabilities: {
      ...agent.capabilities,
      ...(agent.adapter === 'zcode' ? { modelSelect: contract.models.length > 0, reasoningEffort: contract.models.some(model => (model.thinkingOptions?.length ?? 0) > 0) } : {}),
      permissionModes: contract.permissionModes,
      imageAttachments: contract.imageAttachments,
      fileAttachments: contract.fileAttachments,
      sessionList: contract.sessionList,
      sessionLoad: contract.sessionLoad,
      sessionResume: contract.sessionResume,
      steer: contract.steer ?? agent.capabilities.steer,
      followup: contract.followup ?? agent.capabilities.followup,
      sessionFork: contract.sessionFork,
      sessionForkAtTurn: contract.sessionForkAtTurn ?? agent.capabilities.sessionForkAtTurn,
      crossAgentFork: contract.crossAgentFork ?? agent.capabilities.crossAgentFork,
      sideChat: contract.sideChat ?? agent.capabilities.sideChat,
      structuredSubagents: contract.structuredSubagents ?? agent.capabilities.structuredSubagents,
      formElicitation: contract.formElicitation ?? agent.capabilities.formElicitation,
      freeTextElicitation: contract.freeTextElicitation ?? agent.capabilities.freeTextElicitation,
      nativeGoal: contract.nativeGoal ?? agent.capabilities.nativeGoal,
      nativeReview: contract.nativeReview ?? agent.capabilities.nativeReview,
      structuredUsage: contract.structuredUsage ?? agent.capabilities.structuredUsage,
      capabilityInventory: contract.capabilityInventory ?? agent.capabilities.capabilityInventory,
      additionalDirectoriesNew: contract.additionalDirectoriesNew ?? agent.capabilities.additionalDirectoriesNew,
      additionalDirectoriesResume: contract.additionalDirectoriesResume ?? agent.capabilities.additionalDirectoriesResume,
      commands: contract.commands,
      collaborationModes: contract.collaborationModes
    }
  }
}

/**
 * Strict steer gate shared by renderer-facing IPC and MCP/team callers. An
 * omitted capability is intentionally treated as unsupported: only a provider
 * that explicitly advertises steer may receive an in-flight prompt.
 */
export function assertAgentSupportsSteer(agent?: Pick<AgentDef, 'name' | 'adapter' | 'capabilities'>): void {
  if (agent?.capabilities.steer === true) return
  const name = agent?.name || '目标 Agent'
  const protocol = agent?.capabilities.protocol === 'acp' ? ' (ACP)' : ''
  throw new Error(`unsupported_target_capability: ${name}${protocol} does not support steer`)
}

/** MCP sessions stay user-read-only until explicitly enabled. */
export function isToolSession(session: Pick<Session, 'handoffId' | 'handoffUserContinued'> | null | undefined): boolean {
  return !!session?.handoffId && session.handoffUserContinued !== true
}

/**
 * Session identity key for de-dup (Doc5 T3). A session is uniquely identified by
 * (agentId, nativeSessionId) once the native id is known; before that the local
 * id stands in, so drafts never collide and fold into their identity the moment
 * a nativeSessionId lands. Pure + dependency-free so both main and renderer use it.
 */
export function sessionDedupKey(s: Pick<Session, 'id' | 'nativeSessionId' | 'config'>): string {
  return s.nativeSessionId ? `${s.config.agentId}:${s.nativeSessionId}` : s.id
}

/**
 * 需求3: derive a clean session title from a prompt / first user message. The
 * Historical prompts may prepend skill/MCP mentions (`@name`, `@mcp:name`) and
 * separate them from the body with a newline. A naive
 * `slice(0, 40)` therefore captures the mention markup ("@capcode …") instead
 * of the user's actual first line — the bug behind restored/imported sessions
 * showing "@capcode"-style titles. This strips any leading run of mentions and
 * blank lines, then takes the first meaningful line, capped for the sidebar.
 */
export function deriveSessionTitle(raw: string | undefined, max = 40): string {
  const text = (raw || '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  let i = 0
  // Normalize one line's markup for titling: drop leading @mentions, and unwrap
  // markdown links `[label](target)` → label. The latter is what a `/skill`
  // pick expands to (e.g. "[$capcode-tracker](/…/SKILL.md) 开发…"), so without
  // this the title became the raw path-laden link text (P2 title bug).
  const clean = (line: string): string =>
    line
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(^|\s)@[\w:./-]+/g, '')
      .replace(/^[$¥\s]+/, '')
      .trim()
  // Skip leading lines that are ONLY mention tokens (@name / @mcp:name) or blank.
  while (i < lines.length) {
    const line = lines[i].trim()
    if (line === '') {
      i++
      continue
    }
    const stripped = clean(line)
    if (stripped === '') {
      i++
      continue
    }
    // First line with real content beyond mentions — use its non-mention part.
    return stripped.slice(0, max)
  }
  // Fell through (all mentions / empty) — fall back to the raw text sans markup.
  const flat = clean(text.replace(/\s+/g, ' '))
  return flat.slice(0, max)
}

/** A single item in a session's message queue (Doc4 需求2). */
export interface QueueItem {
  /** Side queue delivery reservation, persisted as uncertain after restart. */
  state?: QueueDeliveryState
  /** Provider receipt is unknown; never auto-replay. Explicit edit clears it. */
  deliveryUncertain?: boolean
  id: string
  prompt: string
  /** Retained until this individual message is dispatched; not inherited by later turns. */
  source?: 'feishu' | 'weixin' | 'app' | 'mcp'
  attachments?: Attachment[]
  nativeContext?: ResolvedNativeTurnContext
  /** 选中即评论 — bubble display text (instruction) when the wire prompt embeds quotes. */
  displayText?: string
  /** 选中即评论 — structured comment cards to re-render under the sent bubble. */
  comments?: BubbleComment[]
}

export type SideChatStatus = 'idle' | 'running' | 'queued' | 'awaiting-approval' | 'cancelling'

/** Runtime state for the side branch; its transcript/config are restored from the local cache. */
export interface SideChatState {
  config: SessionConfig
  status: SideChatStatus
  queue: QueueItem[]
  hasLiveStreamer: boolean
}

export type QueueDeliveryState = 'pending' | 'dispatching' | 'steering'

export interface DurableQueueItem extends QueueItem {
  acceptedAt: number
  state: QueueDeliveryState
  attempts: number
}

/**
 * Doc1 — TraeX server-side queue status snapshot for the current turn. Mirrors
 * the CLI's `queue/status` notification. `state` walks queued → waiting → ready;
 * `position` is the 0-based slot in the server queue (null when unknown), and
 * `message` is an optional server-provided hint. Carried on a `queue_status`
 * event under id `queue-<turnId>`.
 */
export interface QueueStatus {
  state: 'queued' | 'waiting' | 'ready'
  threadId?: string
  turnId?: string
  /** 0-based position in the server queue; null/undefined when unknown. */
  position?: number | null
  message?: string | null
  /** Stable wall-clock start of the currently active wait. */
  startedAt?: number
  /** Total completed wait time accumulated in this turn. */
  waitedMs?: number
  /** True only when ready means compute was acquired, not cancellation or disconnect. */
  acquired?: boolean
  endReason?: 'cancelled' | 'failed' | 'disconnected' | 'unknown'
  /** Historical estimate of the remaining wait at `estimatedAt`. */
  estimatedRemainingMs?: number
  estimatedAt?: number
}

export interface QueueWaitPrediction {
  estimatedAt: number
  estimatedRemainingMs: number
  position: number
}

export interface QueueWaitEvaluation {
  phaseId: string
  id: string
  model: string
  algorithmVersion: string
  startedAt: number
  endedAt: number
  outcome: 'acquired' | 'cancelled' | 'failed' | 'disconnected' | 'unknown' | 'replaced'
  /** Null when timestamps cannot establish a valid duration. */
  actualWaitMs: number | null
  firstPrediction?: QueueWaitPrediction
  actualRemainingMs: number | null
  errorMs: number | null
  predictionCount: number
}

export interface QueueWaitQualityQuery {
  model?: string
  algorithmVersion?: string
}

export interface QueueWaitQualityReport {
  generatedAt: number
  since: number
  currentAlgorithmVersion: string
  query: QueueWaitQualityQuery
  models: string[]
  algorithmVersions: string[]
  successfulCount: number
  evaluatedCount: number
  interruptedCount: number
  invalidCount: number
  unfinishedCount: number
  meanAbsoluteErrorMs: number | null
  p90AbsoluteErrorMs: number | null
  meanErrorMs: number | null
  coverage: number | null
  recent: QueueWaitEvaluation[]
  logPath: string
  logRetentionDays: number
  storageError?: string
}

/**
 * Doc10 — one file's before/after contents for the Android-Studio-style
 * side-by-side review. `before`/`after` are full UTF-8 text; `degraded` marks a
 * pair we couldn't fully reconstruct (e.g. reverse-applying the diff failed), so
 * the panel falls back to the raw unified diff. `binary`/`tooLarge` short-circuit
 * rendering with a notice instead of dumping bytes.
 */
export interface ReviewFilePair {
  path: string
  /** 'add' | 'delete' | 'modify' — drives which side renders empty. */
  kind: 'add' | 'delete' | 'modify'
  before: string
  after: string
  degraded?: boolean
  binary?: boolean
  tooLarge?: boolean
}

/**
 * ReviewPanel change source. `turn` is a frozen Agent-turn artifact; the Git
 * scopes compare the working tree, index, one commit, or the local branch to its
 * configured upstream. `workspace` remains the default for compatibility.
 */
export type ReviewScope =
  | { kind: 'workspace' }
  | { kind: 'turn'; turnId: string }
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'commit'; sha: string }
  | { kind: 'branch' }

export interface ReviewFilePairReq {
  sessionId: string
  path: string
  /** Original path for a rename; used to read the before side from HEAD/artifact. */
  oldPath?: string
  /** The unified-diff hunk text for this file (used to reconstruct `before`). */
  unifiedDiff: string
  kind: 'add' | 'delete' | 'modify'
  /** 需求二 — when set to a turn scope, read before/after from that turn's
   *  artifact snapshot (full file) instead of reconstructing from hunks. */
  scope?: ReviewScope
}

/**
 * 需求一/二/三 — public mirror of the main-process turn-artifact summary
 * (src/main/turnArtifacts.ts). Kept structurally identical so it crosses the IPC
 * boundary without a second translation layer. Snapshot/state strings drive the
 * change card, the "完整" availability, and the rewind preflight.
 */
export type SnapshotState = 'full' | 'patch-only' | 'binary' | 'too-large' | 'missing'
export type ArtifactState = 'ready' | 'patch-only' | 'incomplete'
export type TurnFileKind = 'add' | 'delete' | 'modify' | 'rename'

export interface TurnArtifactFileSummary {
  path: string
  oldPath?: string
  kind: TurnFileKind
  added: number
  removed: number
  reversible: boolean
  snapshotState: SnapshotState
}

export interface TurnArtifactSummary {
  sessionId: string
  nativeThreadId: string
  nativeTurnId: string
  startSeq: number
  endSeq: number
  startedAt: number
  completedAt: number
  state: ArtifactState
  files: TurnArtifactFileSummary[]
}

/**
 * 需求三（会话节点回退）— read-only preflight the renderer shows in the confirm
 * dialog + loading. Turn numbers are 1-based UI turns; `removeTurnIds` are the
 * native ids (target..newest). `allowed:false` carries a `reason` to display.
 */
export interface RewindPreview {
  allowed: boolean
  reason?: string
  keepThroughTurn?: number
  removeFromTurn?: number
  removeThroughTurn?: number
  removeTurnIds: string[]
  files: Array<{ path: string; kind: string; reversible?: boolean }>
}

/**
 * 需求三 — result of executing a rewind. On success the renderer truncates the
 * removed turns and prefills the target turn's user text into the composer
 * (`prefillText`), never auto-sending; `restored` lists the files rolled back.
 */
export type RewindResult =
  | { ok: true; prefillText: string; restored?: string[]; runtime: SessionRuntimeState; warning?: string }
  | { ok: false; error: string }

/**
 * Doc(变更文件列表改 git-diff 驱动) — one entry in the working-directory change set,
 * mirroring an Android-Studio Changes row. Tracked changes (git diff HEAD) go in
 * the "Changes" group; untracked files (git ls-files --others) go in "Unversioned
 * Files". `unifiedDiff` feeds `review:getFilePair`; untracked files carry '' and
 * are reconstructed as a pure add (empty before + on-disk after).
 */
export interface ReviewChangeItem {
  path: string
  /** Original path when renamed. */
  oldPath?: string
  kind: 'add' | 'delete' | 'modify' | 'rename'
  /** false → Unversioned Files group; true → Changes group. */
  tracked: boolean
  added: number
  removed: number
  unifiedDiff: string
}

/**
 * Doc(变更文件列表改 git-diff 驱动) — the whole change set for a session's workdir.
 * `isGitRepo:false` tells the panel to fall back to the aggregated-diff list.
 */
export interface ReviewChangeSet {
  isGitRepo: boolean
  /** git repository root (for a breadcrumb), when resolved. */
  root?: string
  /** 改动2 — current branch name (for the summary card 环境信息), when resolved. */
  branch?: string
  /** Current branch's configured remote-tracking ref, e.g. origin/main. */
  upstream?: string
  /** Commits on the current branch that are not in upstream, newest first. */
  commits?: Array<{ sha: string; title: string }>
  items: ReviewChangeItem[]
}

/** Relative, workdir-confined entry used by the session file browser. */
export interface FileBrowserEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  size?: number
  ext?: string
  isSymlink: boolean
}

export interface FileBrowserListResult {
  ok: boolean
  root: string
  dirPath: string
  entries: FileBrowserEntry[]
  error?: string
}

export interface FilePreviewOptions {
  force?: boolean
  maxLines?: number
}

export interface FilePreviewResult {
  ok: boolean
  path: string
  kind: 'text' | 'image' | 'binary'
  size: number
  text?: string
  /** Canonical directory URL used to resolve relative assets in HTML previews. */
  htmlBaseUrl?: string
  /** Canonical file URL for opening the original HTML document in the file browser. */
  htmlUrl?: string
  language?: string
  dataUrl?: string
  tooLarge?: boolean
  truncated?: boolean
  lineLimit?: number
  error?: string
}

export type KabooPeriod = 'day' | 'week' | 'month' | 'year' | 'all'
/** @deprecated Prefer KabooPeriod; kept as a source-compatible alias. */
export type KabooRange = KabooPeriod

export interface KabooUsageQuery {
  period: KabooPeriod
  /** Inclusive local calendar dates. Omitted only for `all`. */
  start?: string
  end?: string
  /** ISO instant used by Kaboo to clamp the current, still-open period. */
  now: string
  /** IANA time zone used to interpret the local calendar dates. */
  timeZone: string
}

export interface KabooDailyTrend {
  date: string
  tokens: number
  cost: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheCreationTokens: number
  hours: number
  sessions: number
  messages: number
  topModel?: string
}

export interface KabooStats {
  tokens: number
  cost: number
  sessions: number
  hours: number
  codeLines: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
}

/** Per-day hourly buckets for the native day view (24 local-hour slots). */
export interface KabooHourlyTrend {
  date: string
  /** Index 0 covers 00:00–01:00 in the query's time zone. */
  tokens: number[]
}

export interface KabooProfile {
  range: KabooPeriod
  reportedAt: string
  stats: KabooStats
  prevStats?: KabooStats
  heatmap: number[][]
  dailyTrend: KabooDailyTrend[]
  /** Native-only: the selected day's own hourly usage, absent for Kaboo. */
  hourlyTrend?: KabooHourlyTrend
  toolBreakdown: Array<{ source: string; tokens: number; cost: number; sessions: number }>
  modelBreakdown: Array<{ model: string; family: string; tokens: number; cost: number }>
  skillBreakdown: Array<{ skill: string; tokens: number; cost: number; sessions: number; invocations: number }>
  projectBreakdown: Array<{ project: string; tokens: number; cost: number; sessions: number; models: number }>
  mcpBreakdown: Array<{ name: string; count: number }>
}

export type KabooUnavailableReason =
  | 'cli-unavailable'
  | 'unauthenticated'
  | 'timeout'
  | 'network'
  | 'service'
  // The current natural period starts after the server's clock (caller TZ ahead
  // of the server), so Kaboo rejects it — the panel pages back one period.
  | 'future-range'
  | 'invalid-response'

export type KabooProfileResult = KabooProfile | { unavailable: true; reason: KabooUnavailableReason }

/**
 * Doc11 — a reusable handoff task template. Presets pre-fill the create-task form
 * (and the `create_uniagent_task` MCP tool) so a common follow-up ("code review
 * this diff", "write tests") is one click. Stored in ~/.uniagent/presets.json.
 */
export interface HandoffPreset {
  id: string
  name: string
  agentId?: string
  model?: string
  effort?: ReasoningEffort
  permissionMode?: PermissionMode
  /** Prompt template; may contain plain text the caller edits before sending. */
  prompt: string
}

/** Provider-native tool restriction attached to an Agent role. */
export interface AgentToolPolicy {
  mode: 'allow-only' | 'deny-only'
  tools: string[]
}

/**
 * A reusable execution profile exposed through the UniAgent handoff MCP. Roles
 * are independent from prompt presets: callers provide only a stable role id
 * and the task prompt, and cannot override these fields.
 */
export interface AgentRole {
  id: string
  name: string
  agentId: string
  model?: string
  effort?: ReasoningEffort
  kimiThinking?: string
  zcodeThinking?: string
  permissionMode: PermissionMode
  /** Omitted means inherit the caller session/MCP process project. */
  projectId?: string
  /** @deprecated Read-only migration source for roles written before projects. */
  workdir?: string
  /** Empty/omitted means no additional session-level instructions. */
  instructions?: string
  /** Omitted = all Skills, [] = none, non-empty = exact allowlist. */
  skills?: string[]
  /** Omitted = inherit the provider's default tools. */
  toolPolicy?: AgentToolPolicy
}

/** Full role value copied into a Session at creation time. */
export type AgentRoleSnapshot = AgentRole

/** A reusable workspace containing one primary and zero or more extra roots. */
export interface Project {
  id: string
  name: string
  primaryDirectory: string
  additionalDirectories: string[]
  createdAt: number
  updatedAt: number
  isDefault?: boolean
}

export interface ProjectInput {
  name: string
  primaryDirectory: string
  additionalDirectories: string[]
}

/** Role plus its current runtime capability evaluation. */
export interface AgentRoleCatalogEntry {
  role: AgentRole
  executable: boolean
  unavailableReason?: string
}

/** A history session summary listed in the resume panel (Doc2 需求). */
export interface SessionSummary {
  id: string
  title: string
  /** Original first user line from the native rollout, retained for history search. */
  firstUserMessage?: string
  cwd?: string
  updatedAt: number
  agentId: string
}

/**
 * Doc4 — one step of a normalized plan / todo list. `text` is the step content
 * (codex `step` / claude `content`); `status` is the归一 lifecycle. `activeForm`
 * is claude's present-tense phrasing for an in-progress step, shown preferentially
 * when present.
 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'
export interface PlanStep {
  text: string
  status: PlanStepStatus
  activeForm?: string
}

/**
 * Doc5 — a single sub-agent's live snapshot (multi-agent collaboration). Built by
 * merging `collabAgentToolCall.agentsStates` (per child status + message) with
 * `subAgentActivity` lifecycle events. `agentThreadId` keys it for dedup + detail
 * lazy-loading via `thread/items/list`.
 */
export interface UASubAgent {
  /** The child agent's thread id — the stable identity + detail-fetch key. */
  agentThreadId: string
  /** Native task identity for a verified child within its parent session. */
  nativeTaskId?: string
  /** Display name / path of the child agent (from agentPath or a derived label). */
  name?: string
  /** The parent thread that spawned it. */
  parentThreadId?: string
  /** Normalized collaboration status. */
  status: 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound'
  /** Stable collaboration item id for the dispatch that owns this snapshot. */
  dispatchId?: string
  /** Monotonic per-thread dispatch generation; only an explicit dispatch advances it. */
  generation?: number
  /** The collaboration tool that last touched it (spawn/send/wait/…). */
  tool?: string
  /** Latest status message from the child. */
  message?: string
  /** When we first saw it (ms epoch), for the "已处理 N 秒" timer. */
  startedAt?: number
  /**
   * 修复#6 — when the child reached a terminal state (ms epoch). Lets the detail
   * header show total 用时 (time consumption) for a finished child instead of a
   * live-only counter. Absent while still running.
   */
  endedAt?: number
  /**
   * 子agent隔离 — the task the parent dispatched to this child (from
   * collabAgentToolCall.prompt). Surfaced in the sidebar as "输入任务" so the user
   * sees what each child was asked to do — never rendered in the main chat.
   */
  prompt?: string
  /**
   * 子agent隔离 — the child's own cumulative token usage, shown ONLY in the
   * sidebar detail (the main chat's token card is the main agent's alone).
   */
  tokens?: { inputTokens: number; outputTokens: number; totalTokens: number; cost?: number }
}

/** A scheduled/automation task listed in the automations panel (Doc4 需求4). */
export interface AutomationTask {
  id: string
  source?: 'uniagent'
  agentId: string
  name: string
  prompt?: string
  schedule?: string
  status: 'active' | 'paused' | 'unknown'
  model?: string
  /** Absolute path of the backing config file (for enable/pause writes). */
  path?: string
  /**
   * Whether this task can be toggled. Local tasks are editable when they carry
   * a path + known status.
   */
  editable?: boolean
  nextRunAt?: number
}

/**
 * 需求1（定时任务详情/编辑/删除）— the full detail of one automation task,
 * loaded lazily when a row is opened. Extends the list-row {@link AutomationTask}
 * with the extra fields parsed from the backing automation.toml: reasoning
 * effort, execution environment, working dirs, timestamps, and the last-run
 * diagnostics. Everything beyond {@link AutomationTask} is optional so a
 * partial/legacy config still renders.
 */
export interface AutomationDetail extends AutomationTask {
  projectId?: string
  permissionMode?: PermissionMode
  lastRunAt?: number
  lastSessionId?: string
  /** Reasoning effort for the scheduled turn (codex/traex local tasks). */
  reasoningEffort?: ReasoningEffort
  /** Sandbox / execution environment string as written in the config. */
  executionEnvironment?: string
  /** Working directories the task runs against. */
  cwds?: string[]
  /** ISO / epoch creation + update timestamps, when the backing store records them. */
  createdAt?: string
  updatedAt?: string
  /**
   * Whether this task only fires on weekdays (Mon–Fri). Derived from the rrule
   * `BYDAY=MO,TU,WE,TH,FR` shape for local tasks.
   */
  weekdayOnly?: boolean
  /** IANA timezone the schedule is evaluated in, when known. */
  timezone?: string
  /** Outcome of the most recent run, when the backing store records it. */
  lastRunStatus?: 'success' | 'error' | 'running' | 'awaiting-approval' | 'unknown'
  /** Error text from the most recent failed run. */
  lastRunError?: string
  /** Originating handoff-preset / template id, when the task was created from one. */
  templateId?: string
  /** Raw form/template value blob (opaque JSON string) if the config carried one. */
  formValue?: string
}

/**
 * 需求1 — the mutable subset of an automation, applied by `automations:update`.
 * Every field is optional; only the provided keys are written back (line-replace
 * for the local toml).
 */
export interface AutomationEditPatch {
  agentId?: string
  projectId?: string
  permissionMode?: PermissionMode
  name?: string
  prompt?: string
  /** New schedule expression (rrule). */
  schedule?: string
  weekdayOnly?: boolean
  model?: string
  reasoningEffort?: ReasoningEffort
}

export interface NativeAutomationInput {
  name: string
  prompt: string
  schedule: string
  agentId: string
  projectId: string
  permissionMode: PermissionMode
  model?: string
  reasoningEffort?: ReasoningEffort
}

/**
 * A cross-agent migration diagnostic (跨 Agent 迁移诊断). Recorded whenever the
 * history parser / native-session translator hits data it doesn't yet handle —
 * an unknown record type, an unrecognized payload/item type, a schema field it
 * can't map, or a thrown error mid-parse. These would otherwise silently degrade
 * a session's cross-agent transplant (missing history, dropped tool calls). We
 * collect them into a log the user can open and hand back verbatim so the exact
 * unhandled shape can be fixed.
 */
export interface DiagnosticEntry {
  id: string
  /** When it was recorded (ms epoch). */
  ts: number
  /** Severity — 'warn' = handled-but-lossy / unknown shape; 'error' = parse threw. */
  level: 'warn' | 'error'
  /** Which diagnostics view owns the entry. */
  category: 'session_import' | 'app_runtime'
  /** Short subsystem name shown in the log list. */
  source: string
  /** Source agent whose session we were reading (codex / traex / claude). */
  agentId: string
  /** Native session id being parsed, when known. */
  sessionId?: string
  /** Short machine-facing code, e.g. 'unknown_record_type' / 'unknown_payload_type'. */
  code: string
  /** Human-readable problem description (what was unhandled + likely impact). */
  message: string
  /** The offending field / type name, e.g. record type 'compacted'. */
  field?: string
  /** A trimmed raw JSON sample of the unhandled data, for reproduction. */
  sample?: string
  /** How many times this same (code, field, agent) was seen — deduped. */
  count: number
}

/** Per-agent last-choice UI preference (Doc5 T2). */
export interface AgentPref {
  model?: string
  effort?: ReasoningEffort
  zcodeThinking?: string
  /** Explicit defaults configured in Settings; preferred over last-used values. */
  defaultModel?: string
  defaultEffort?: ReasoningEffort
  defaultThinking?: string
  permissionMode?: PermissionMode
  /** Codex／TraeX collaboration state, persisted independently from permissions. */
  collaborationMode?: CollaborationModeId
  /** 需求9 — remember the Codex 快速模式 toggle across New Task launches. */
  fastMode?: boolean
  /** Remember the TraeX Max toggle across new-task launches. */
  maxMode?: boolean
}

/** Persisted preferences bag (Doc5 T2). */
export interface PrefsData {
  lastByAgent: Record<string, AgentPref>
  lastAgentId?: string
}

/** IPC channel names. */
export const IPC = {
  startupState: 'app:startupState',
  startupFailed: 'app:startupFailed',
  restartApp: 'app:restart',
  listAgents: 'agents:list',
  detectAgents: 'agents:detect',
  detectAgent: 'agents:detectOne',
  checkAgentUpdate: 'agents:checkUpdate',
  updateAgent: 'agents:update',
  getLifecycleSnapshot: 'agents:lifecycleSnapshot',
  lifecycleProgress: 'agents:lifecycleProgress',
  initializationFinished: 'agents:initializationFinished',
  createSession: 'session:create',
  sendMessage: 'session:send',
  setCollaborationMode: 'session:setCollaborationMode',
  interrupt: 'session:interrupt',
  listSessions: 'session:list',
  /** Pull-based queue snapshot for renderer startup/reload hydration. */
  listQueues: 'session:queues',
  getEvents: 'session:events',
  getSessionRuntimeState: 'session:runtimeState',
  refreshNativeSession: 'session:refreshNative',
  enableToolSession: 'session:enableTool',
  // G2-4: archive / unarchive / permanently delete a session.
  archiveSession: 'session:archive',
  unarchiveSession: 'session:unarchive',
  deleteSession: 'session:delete',
  // 需求4: rename + pin/unpin a session (manual title locks auto-titling).
  renameSession: 'session:rename',
  pinSession: 'session:pin',
  pickDirectory: 'dialog:pickDir',
  /** 计时胶囊重构 — grow/shrink the window's minimum width while the summary
   * dock occupies layout space (renderer passes the dock width, 0 when closed). */
  setSummaryDockWidth: 'window:setSummaryDockWidth',
  pickFiles: 'dialog:pickFiles',
  saveClipboardImage: 'clipboard:saveImage',
  // 图片详情右键「复制图片」: put the previewed image itself on the OS clipboard
  // (dataUrl or an image file path) so it can be pasted into other apps.
  copyImageToClipboard: 'clipboard:copyImage',
  openExternal: 'shell:openExternal',
  // Doc1 需求3: adjust model/effort/permission between turns.
  updateSessionConfig: 'session:updateConfig',
  // Doc2: session persistence + resume from native history.
  listAgentHistory: 'history:list',
  importSession: 'history:import',
  // 修复#2（只读快照不进侧栏）— fetch a native session's normalized events for a
  // READ-ONLY viewer WITHOUT creating an orchestrator Session. From the preview
  // the user can fork, directly import the native session, or go back.
  previewHistory: 'history:preview',
  previewHistoryProgress: 'history:preview-progress',
  getSessionForkPoints: 'history:sessionForkPoints',
  // Doc2: transplant a native session into ANOTHER agent's on-disk history so
  // it can be resumed there (cross-agent resume).
  exportNativeSession: 'history:exportNative',
  // 需求5（外部会话导入并发治理）— 原Agent分叉 creates an isolated lossless copy;
  // direct import reuses the original native id; 换Agent分叉 normalizes the history
  // into another agent and is labeled potentially lossy.
  forkSameSession: 'history:forkSame',
  forkCrossSession: 'history:forkCross',
  // Doc10: fetch before/after file contents for the side-by-side review panel.
  reviewGetFilePair: 'review:getFilePair',
  // Doc(变更文件列表改 git-diff 驱动): fetch the workdir's live git change set.
  reviewGetChangeSet: 'review:getChangeSet',
  // 需求一 — one turn's frozen change summary (native turn id → files/lines).
  getTurnArtifactSummary: 'review:getTurnArtifact',
  // 需求三（会话节点回退）— read-only preflight + the transactional rewind.
  previewSessionRewind: 'rewind:preview',
  rewindSession: 'rewind:apply',
  // Session-scoped, workdir-confined file browser.
  fsListDir: 'fs:listDir',
  fsReadFile: 'fs:readFile',
  fsReadAttachmentImage: 'fs:readAttachmentImage',
  fsReadNativeImage: 'fs:readNativeImage',
  fsReveal: 'fs:reveal',
  fsOpenHtml: 'fs:openHtml',
  // Doc11: handoff presets (reusable task templates) + create a task from one.
  listPresets: 'presets:list',
  savePreset: 'presets:save',
  deletePreset: 'presets:delete',
  // MCP-callable Agent roles (independent from task presets).
  listRoles: 'roles:list',
  saveRole: 'roles:save',
  deleteRole: 'roles:delete',
  listProjects: 'projects:list',
  getProjectGitInfo: 'projects:gitInfo',
  listProjectWorktrees: 'projects:worktrees',
  removeProjectWorktree: 'projects:removeWorktree',
  openProjectWorktree: 'projects:openWorktree',
  retryWorktreeTask: 'session:retryWorktree',
  createProject: 'projects:create',
  updateProject: 'projects:update',
  deleteProject: 'projects:delete',
  // Doc11: self-test the injected handoff MCP server (verification harness).
  handoffSelfTest: 'handoff:selfTest',
  // Doc3: respond to server→client questions / approvals.
  respondRequest: 'session:respond',
  // Provider-native, process-local capability discovery. Candidate paths never
  // round-trip from the renderer; selection is resolved against a fresh snapshot.
  getNativeCapabilities: 'nativeCapabilities:get',
  nativeCapabilitiesChanged: 'nativeCapabilities:changed',
  createNativeActionSession: 'nativeAction:createSession',
  runNativeAction: 'nativeAction:run',
  // Narrow manual context compaction for a live Codex / TraeX app-server session.
  compactSession: 'session:compact',
  // Doc5: fetch a sub-agent thread's items for the detail panel (lazy-loaded).
  subagentItems: 'subagent:items',
  subagentCancel: 'subagent:cancel',
  // 需求2（侧边对话 /side）: ephemeral side-branch chat driven off the main rollout.
  sideCanOpen: 'side:canOpen',
  sideSend: 'side:send',
  sideForceSend: 'side:forceSend',
  sideGetState: 'side:getState',
  sideUpdateConfig: 'side:updateConfig',
  sideSetCollaborationMode: 'side:setCollaborationMode',
  sideRunNativeAction: 'side:runNativeAction',
  sideCompact: 'side:compact',
  sideRespond: 'side:respond',
  sideDequeue: 'side:dequeue',
  sidePromoteQueue: 'side:promoteQueue',
  sideEditQueue: 'side:editQueue',
  sideSetQueueEditing: 'side:setQueueEditing',
  sideInterrupt: 'side:interrupt',
  sideGetEvents: 'side:getEvents',
  sideGetStatus: 'side:getStatus',
  sideClose: 'side:close',
  sidePromote: 'side:promoteToSession',
  // 选中即评论 / 详情 — a SECOND ephemeral fork channel, independent of side chat,
  // that powers the floating "详情" popover explaining a text selection.
  detailExplain: 'detail:explain',
  detailSend: 'detail:send',
  detailInterrupt: 'detail:interrupt',
  detailGetEvents: 'detail:getEvents',
  detailGetStatus: 'detail:getStatus',
  detailClose: 'detail:close',
  detailPromote: 'detail:promoteToSide',
  detailPromoteSession: 'detail:promoteToSession',
  e2eEnabled: 'e2e:enabled',
  e2eInjectEvents: 'e2e:injectEvents',
  e2eLifecycleFixture: 'e2e:lifecycleFixture',
  e2eLastTokenUsageQuery: 'e2e:lastTokenUsageQuery',
  e2eTokenUsageRequestCount: 'e2e:tokenUsageRequestCount',
  e2eLifecycleUpdateGuard: 'e2e:lifecycleUpdateGuard',
  // 需求3 验证：捕获最近一次 respondRequest 的入参（e2e 下 window.uniagent 被冻结，
  // 无法在渲染层劫持，改由主进程记录后回读）。
  e2eLastResponse: 'e2e:lastResponse',
  // Fix#4 验证：在 e2e 下把某会话标记/清除 waitingForHandoff（等待其他 agent 交接），
  // 复用真实的 sessionUpdated 推送链路，驱动「等待 X 的 Y」状态行的渲染与跳转校验。
  e2eSetWaitingForHandoff: 'e2e:setWaitingForHandoff',
  // Doc4 需求2: force-send (steer) into the running turn.
  forceSend: 'session:forceSend',
  dequeue: 'session:dequeue',
  // 需求2.2: promote a queued item to a force-insert (steer) immediately.
  promoteQueueItem: 'session:promoteQueue',
  // 需求（队列二次编辑）: replace a still-pending queued item's prompt/attachments.
  editQueueItem: 'session:editQueue',
  // 需求（队列二次编辑）: freeze/unfreeze the FIFO queue while an item is edited.
  setQueueEditing: 'session:setQueueEditing',
  // Doc4 需求4: scheduled/automation tasks.
  listAutomations: 'automations:list',
  createAutomation: 'automations:create',
  automationsChanged: 'automations:changed',
  setAutomationStatus: 'automations:setStatus',
  // 需求1（定时任务详情/编辑/删除）: lazy detail load + edit + delete.
  getAutomationDetail: 'automations:getDetail',
  updateAutomation: 'automations:update',
  deleteAutomation: 'automations:delete',
  // Doc5 T2: per-agent last-choice preferences.
  getPrefs: 'prefs:get',
  setPrefs: 'prefs:set',
  prefsChanged: 'prefs:changed',
  getAppSettings: 'settings:get',
  setAppSettings: 'settings:set',
  // App release checks are read-only; downloads open in the system browser.
  checkAppUpdate: 'appUpdate:check',
  appUpdateAvailable: 'appUpdate:available',
  appNotificationOpenSession: 'appNotification:openSession',
  sessionBadgeVisible: 'sessionBadge:visible',
  getAppVersion: 'app:getVersion',
  // Kaboo is the primary Token-usage source; no response is persisted locally.
  getTokenUsage: 'tokenUsage:get',
  refreshTokenUsage: 'tokenUsage:refresh',
  // UniAgent-native Token usage: scans each agent's on-disk history (本机全量),
  // returns the SAME KabooProfile shape so the panel toggles source with no new UI.
  getNativeTokenUsage: 'nativeTokenUsage:get',
  refreshNativeTokenUsage: 'nativeTokenUsage:refresh',
  // Renderer-side Token-panel trace (cache hits, query/date, returned profile).
  logTokenUsage: 'tokenUsage:log',
  // Codex 用量额度: latest account rate-limit snapshot (weekly / 5h windows) read
  // from the newest on-disk Codex rollout. Read-only; backs the settings detail.
  getCodexRateLimits: 'codexRateLimits:get',
  codexRateLimitsChanged: 'codexRateLimits:changed',
  // Claude Code 用量额度: in-memory snapshot from the CLI's live rate_limit_event.
  getClaudeRateLimits: 'claudeRateLimits:get',
  claudeRateLimitsChanged: 'claudeRateLimits:changed',
  getGrokQuota: 'grokQuota:get',
  getAgentQuota: 'agentQuota:get',
  // 需求4（飞书 Bot 远程驱动）: one-click install wizard (streamed progress) +
  // live status query, plus a main→renderer push for install/connection updates.
  feishuInstall: 'feishu:install',
  feishuBind: 'feishu:bind',
  feishuCancelInstall: 'feishu:cancelInstall',
  feishuStatus: 'feishu:status',
  feishuStop: 'feishu:stop',
  feishuScanGroups: 'feishu:scanGroups',
  feishuBeginNotificationBinding: 'feishu:beginNotificationBinding',
  feishuCancelNotificationBinding: 'feishu:cancelNotificationBinding',
  feishuUnbindNotificationTarget: 'feishu:unbindNotificationTarget',
  feishuInstallProgress: 'feishu:installProgress',
  getLifecycleMetrics: 'metrics:lifecycle',
  // 跨 Agent 迁移诊断: list / clear collected unhandled-data reports, and copy
  // the full report to the clipboard so the user can paste it back for fixing.
  listDiagnostics: 'diag:list',
  getQueueWaitQuality: 'diag:queueWaitQuality',
  copyQueueWaitQuality: 'diag:copyQueueWaitQuality',
  openQueueWaitQualityLogs: 'diag:openQueueWaitQualityLogs',
  clearDiagnostics: 'diag:clear',
  removeDiagnostics: 'diag:remove',
  copyDiagnosticsReport: 'diag:copyReport',
  reportDiagnostic: 'diag:report',
  // main -> renderer push
  event: 'session:event',
  statusChange: 'session:statusChange',
  queueChange: 'session:queueChange',
  // 需求2（侧边对话）: main -> renderer pushes for the ephemeral side branch.
  sideEvent: 'side:event',
  sideStatus: 'side:status',
  sideState: 'side:state',
  detailEvent: 'detail:event',
  detailStatus: 'detail:status',
  // main -> renderer push: authoritative config changed asynchronously.
  sessionUpdated: 'session:updated',
  // main -> renderer push: a session was created outside the renderer (Doc11 —
  // an agent 交接 a follow-up task via the create_uniagent_task MCP tool).
  sessionCreated: 'session:created',
  // main -> renderer push: a new migration diagnostic was recorded.
  diagnostic: 'diag:new',
  capabilitySyncScan: 'capabilitySync:scan',
  capabilitySyncPlan: 'capabilitySync:plan',
  capabilitySyncExecute: 'capabilitySync:execute',
  capabilitySyncGetJob: 'capabilitySync:getJob',
  capabilitySyncCancel: 'capabilitySync:cancel',
  capabilitySyncRollback: 'capabilitySync:rollback',
  capabilitySyncPreview: 'capabilitySync:getMarkdownPreview',
  capabilitySyncProgress: 'capabilitySync:progress',
  capabilityInventoryList: 'capabilityInventory:list',
  capabilityInventoryDetail: 'capabilityInventory:detail',
  capabilityInventoryManage: 'capabilityInventory:manage',
  capabilityInventoryPrepareSync: 'capabilityInventory:prepareSync',
  capabilityMutationPlanRemove: 'capabilityMutation:planRemove',
  capabilityPluginAction: 'capabilityPlugin:action',
  capabilitySkillLinkRemove: 'capabilitySkillLink:remove',
  capabilityInventoryChanged: 'capabilityInventory:changed',
  /** Main -> renderer: protocol negotiation changed one agent's live options. */
  agentUpdate: 'agents:contractUpdate'
} as const
