import { isDistributionAgent } from '../shared/distribution.ts'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentDef, ModelDef, PermissionModeDef, ReasoningEffort } from '../shared/types'
import { AppServerRpcClient } from './appServerTransport.ts'
import { detectDeepSeek } from './deepseekService.ts'
import { DEEPSEEK_PERMISSION_MODES, MCODE_PERMISSION_MODES } from './acp/acpProvider.ts'
import { probeKimiWeb, KIMI_WEB_PERMISSION_MODES } from './kimiWebContract.ts'
import {
  GROK_PERMISSION_MODES,
  probeGrokACP
} from './acp/acpRunner.ts'
import { ZCODE_PERMISSION_MODES, zcodeModelKey } from './zcode/catalog'
import { getZCodeRuntimeSnapshot, importPreparedZCodeRuntime } from './zcode/runtime'
import { detectMCode } from './mcodeService.ts'
import { findAgentExecutable } from './agentSetupProcess.ts'
import { loadNativeCredentials, nativeCredentialEnv } from './agentSetupCredentials.ts'
import { initializeClaudeSdk } from './claudeSdk'
import { parseCodexConfig } from './codexSourceConfig.ts'


const execFileP = promisify(execFile)
export async function codexUsesExternalProvider(home = process.env.CODEX_HOME || join(homedir(), '.codex'), env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let text: string
  try { text = await readFile(join(home, 'config.toml'), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new Error('Codex Provider 配置无法读取') }
  const config = parseCodexConfig(text)
  const provider = typeof config.model_provider === 'string' && config.model_provider !== 'openai' ? config.model_providers?.[config.model_provider] : undefined
  if (!provider || provider.requires_openai_auth !== false || typeof provider.base_url !== 'string') return false
  try { if (!['http:', 'https:'].includes(new URL(provider.base_url).protocol)) return false } catch { return false }
  return provider.env_key === undefined || typeof provider.env_key === 'string' && !!env[provider.env_key]
}
type CodexModelsProvider = (nativeModels: ModelDef[]) => ModelDef[]
const nativeCodexModels: CodexModelsProvider = models => models
let codexModelsProvider = nativeCodexModels
let claudeModelsProvider = nativeCodexModels
export function configureClaudeModelsProvider(provider?: CodexModelsProvider): void {
  claudeModelsProvider = provider || nativeCodexModels
}

export function configureCodexModelsProvider(provider?: CodexModelsProvider): void {
  codexModelsProvider = provider || nativeCodexModels
}

const VALID_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

function sanitizeEfforts(raw: unknown): ReasoningEffort[] {
  if (!Array.isArray(raw)) return []
  const out: ReasoningEffort[] = []
  for (const e of raw) {
    const v = (typeof e === 'string' ? e : e?.effort ?? e?.reasoningEffort) as string | undefined
    if (v && VALID_EFFORTS.has(v as ReasoningEffort) && !out.includes(v as ReasoningEffort)) {
      out.push(v as ReasoningEffort)
    }
  }
  return out
}

/**
 * 需求9 — whether a cache entry advertises the Codex "Fast"/priority service
 * tier. Codex exposes it two ways: a `service_tiers` array with an entry whose
 * id is 'priority', and/or `additional_speed_tiers` containing 'fast'. Either is
 * enough to offer the 快速 toggle (which sends `serviceTier: 'priority'`).
 */
function hasFastTier(m: any): boolean {
  const tiers = m?.service_tiers ?? m?.serviceTiers
  if (Array.isArray(tiers) && tiers.some((t) => (typeof t === 'string' ? t : t?.id) === 'priority')) {
    return true
  }
  const speeds = m?.additional_speed_tiers ?? m?.additionalSpeedTiers
  return Array.isArray(speeds) && speeds.includes('fast')
}

/**
 * Read a codex/traecli model cache (JSON) and project it into ModelDef[].
 * The `-m` value is the entry's `slug` for BOTH CLIs (e.g. codex "gpt-5.6-sol",
 * traex "GPT-5.6-Sol"): that is exactly what `traecli models` / codex print and
 * what each CLI accepts. The lowercase `config_name` is an internal alias and is
 * NOT what traecli emits, so keying by it would miss every model.
 * Hidden entries (visibility !== "list") are dropped.
 */
async function loadModelCache(
  cachePath: string,
  idField: 'slug' | 'config_name' | 'model',
  reasoningVariant?: 'standard'
): Promise<ModelDef[]> {
  const text = await readFile(cachePath, 'utf8')
  const parsed = JSON.parse(text)
  const container = parsed?.models ?? parsed
  const entries: any[] = Array.isArray(container) ? container : Object.values(container)
  return projectModelCache(entries, idField, reasoningVariant)
}

/** Pure cache projection exported for protocol-fixture tests. */
export function projectModelCache(
  entries: any[],
  idField: 'slug' | 'config_name' | 'model' = 'slug',
  reasoningVariant?: 'standard'
): ModelDef[] {
  const out: ModelDef[] = []
  for (const m of entries) {
    if ((m?.visibility && m.visibility !== 'list') || m?.hidden === true) continue
    const id: string | undefined = m?.[idField] || m?.id || m?.model || m?.slug || m?.config_name
    if (!id) continue
    const businessMetadata = m?.business_metadata ?? m?.businessMetadata
    const variants = businessMetadata?.variants
    const efforts = sanitizeEfforts(
      reasoningVariant === 'standard'
        ? variants?.standard_supported_reasoning_levels ?? m?.supported_reasoning_levels ?? m?.supportedReasoningEfforts
        : m?.supported_reasoning_levels ?? m?.supportedReasoningEfforts
    )
    const rawDefault = (
      reasoningVariant === 'standard'
        ? variants?.standard_default_reasoning_level ?? m?.default_reasoning_level ?? m?.defaultReasoningEffort
        : m?.default_reasoning_level ?? m?.defaultReasoningEffort
    ) as string | undefined
    const defaultEffort =
      rawDefault && VALID_EFFORTS.has(rawDefault as ReasoningEffort) && efforts.includes(rawDefault as ReasoningEffort)
        ? (rawDefault as ReasoningEffort)
        : efforts[0]
    const contextWindow = typeof (m?.context_window ?? m?.contextWindow) === 'number'
      ? m.context_window ?? m.contextWindow
      : undefined
    const rawMaxWindow =
      typeof m?.max_context_window === 'number'
        ? m.max_context_window
        : typeof m?.maxContextWindow === 'number'
          ? m.maxContextWindow
          : typeof variants?.max_context_window === 'number'
            ? variants.max_context_window
            : undefined
    // A larger window plus a concrete max backend key is the authoritative TraeX
    // capability signal. Some cache revisions only carry the key in variants.
    const supportsMax =
      typeof contextWindow === 'number' &&
      typeof rawMaxWindow === 'number' &&
      rawMaxWindow > contextWindow &&
      typeof variants?.max_key === 'string' &&
      variants.max_key.length > 0
    out.push({
      id,
      label: m?.display_name || m?.displayName || m?.slug || id,
      efforts,
      defaultEffort,
      // Context window (Doc1 需求3) — surfaced in the composer status bar so the
      // load meter can compute a percentage. Undefined when the cache omits it.
      contextWindow,
      maxContextWindow: supportsMax ? rawMaxWindow : undefined,
      supportsMax,
      // Server-side load (Doc1 — TraeX model load badge). Only the traecli cache
      // carries business_metadata.load.load_percent; codex omits it so the badge
      // simply hides. Can exceed 100 under overload.
      loadPercent:
        typeof businessMetadata?.load?.load_percent === 'number'
          ? businessMetadata.load.load_percent
          : undefined,
      // 需求9 — Codex "Fast"/priority service tier. The codex cache advertises it
      // via `service_tiers` (an entry with id 'priority') and/or
      // `additional_speed_tiers` containing 'fast'. Undefined→false elsewhere so
      // only priority-capable models expose the 快速 toggle.
      supportsFast: hasFastTier(m)
    })
  }
  return out
}

async function loadAppServerModels(
  bin: string,
  idField: 'slug' | 'config_name' | 'model'
): Promise<ModelDef[]> {
  const transport = new AppServerRpcClient({
    bin,
    args: ['app-server'],
    cwd: homedir(),
    env: { ...process.env },
    timeoutMs: 10000
  })
  try {
    await transport.start()
    await transport.request('initialize', {
      clientInfo: { name: 'uniagent', version: '1.0.0' },
      capabilities: { experimentalApi: true }
    })
    transport.notify('initialized', {})
    const entries: any[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const response = await transport.request<any>('model/list', cursor ? { cursor } : {})
      if (!Array.isArray(response?.data)) throw new Error('model/list 返回格式无效')
      entries.push(...response.data)
      cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined
      if (cursor && cursors.has(cursor)) throw new Error('model/list 返回了重复游标')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return projectModelCache(entries, idField)
  } finally {
    await transport.dispose().catch(() => undefined)
  }
}

/** Ask TraeX itself for model efforts; use the cache only when app-server is unavailable. */
export async function loadTraexModels(bin: string): Promise<ModelDef[]> {
  let advertisedModels: ModelDef[] = []
  try {
    // model/list is the same capability source as TraeX's native selector and
    // already removes values that the selected backend would clamp or reject.
    advertisedModels = await loadAppServerModels(bin, 'model')
  } catch {
    /* fall back to cache enrichment below */
  }
  let cacheModels: ModelDef[] = []
  try {
    // `traecli models` prints each model's `slug` (e.g. "GPT-5.6-Sol"), so key the
    // cache by slug too — matching by the lowercase `config_name` misses everything.
    cacheModels = await loadModelCache(join(homedir(), '.trae/cli/models_cache.json'), 'slug', 'standard')
  } catch {
    /* cache optional */
  }
  try {
    const { stdout } = await execFileP(bin, ['models'], { timeout: 10000 })
    const ids = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length) {
      // Case-insensitive lookup as a safety net against slug-casing drift between
      // the CLI output and the on-disk cache.
      const byId = new Map(cacheModels.map((m) => [m.id.toLowerCase(), m]))
      for (const model of advertisedModels) byId.set(model.id.toLowerCase(), model)
      return ids.map((id) => byId.get(id.toLowerCase()) || { id, label: id, efforts: [] })
    }
  } catch {
    /* fall back to cache */
  }
  return advertisedModels.length ? advertisedModels : cacheModels
}

export async function loadCodexModels(bin: string): Promise<ModelDef[]> {
  let nativeModels: ModelDef[]
  try {
    nativeModels = await loadAppServerModels(bin, 'slug')
  } catch {
    nativeModels = await loadModelCache(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'slug')
  }
  return codexModelsProvider(nativeModels)
}

export function resolveCodexRuntimeBin(
  fallback: string,
  _env: NodeJS.ProcessEnv = process.env
): string {
  return fallback
}

/**
 * Claude Code here is backed by a fixed model via env (see ~/.claude/settings.json);
 * the CLI still accepts the standard aliases, and effort is model-agnostic
 * (`--effort {low,medium,high,xhigh,max}`).
 */
const CLAUDE_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
// Claude Code models expose a 200K-token context window (Doc1 需求3); the CLI
// has no machine-readable cache for this, so we hardcode the published sizes so
// the composer load meter can still show a percentage.
const CLAUDE_CTX = 200000
const CLAUDE_MODELS: ModelDef[] = [
  { id: 'sonnet', label: 'Sonnet', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium', contextWindow: CLAUDE_CTX },
  { id: 'opus', label: 'Opus', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', contextWindow: CLAUDE_CTX },
  { id: 'haiku', label: 'Haiku', efforts: CLAUDE_EFFORTS, defaultEffort: 'low', contextWindow: CLAUDE_CTX }
]

/**
 * Read the `env` block from ~/.claude/settings.json. `cc switch` (and similar
 * third-party model switchers) redirect Claude Code to a custom endpoint by
 * setting ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL here,
 * so the sonnet/opus/haiku aliases no longer describe the real model.
 */
export async function readClaudeEnv(): Promise<Record<string, string>> {
  try {
    const text = await readFile(join(homedir(), '.claude/settings.json'), 'utf8')
    const parsed = JSON.parse(text)
    const env = parsed?.env
    if (env && typeof env === 'object') {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    }
  } catch {
    /* no settings / unreadable → vanilla Anthropic */
  }
  return {}
}

/**
 * Resolve Claude Code's real model list. When the settings env pins the model
 * to a concrete name (e.g. `cc switch` → kimi-k3), surface THAT name so the
 * composer reflects the model actually in use instead of the misleading
 * sonnet/opus/haiku aliases. Falls back to the built-in aliases for a vanilla
 * Anthropic setup where the aliases genuinely map to distinct models.
 */
export function resolveClaudeModels(
  env: Record<string, string>
): { models: ModelDef[]; defaultModel?: string } {
  const concrete = new Map<string, ModelDef>()
  const add = (name?: string): void => {
    const n = name?.trim()
    if (!n || concrete.has(n)) return
    concrete.set(n, {
      id: n,
      label: n,
      efforts: CLAUDE_EFFORTS,
      defaultEffort: 'medium',
      contextWindow: CLAUDE_CTX
    })
  }
  const displayNames = [
    env.ANTHROPIC_MODEL_NAME,
    ...Object.entries(env)
      .filter(([key]) => /^ANTHROPIC_DEFAULT_.+_MODEL_NAME$/.test(key))
      .map(([, value]) => value),
    env.CLAUDE_CODE_SUBAGENT_MODEL
  ]
  const routingModels = [
    env.ANTHROPIC_MODEL,
    ...Object.entries(env)
      .filter(([key]) => /^ANTHROPIC_DEFAULT_.+_MODEL$/.test(key))
      .map(([, value]) => value)
  ]
  for (const name of displayNames.some((name) => name?.trim()) ? displayNames : routingModels) add(name)
  if (concrete.size > 0) {
    return { models: [...concrete.values()], defaultModel: concrete.keys().next().value }
  }
  return { models: CLAUDE_MODELS, defaultModel: 'sonnet' }
}

async function loadClaudeModels(): Promise<{ models: ModelDef[]; defaultModel?: string }> {
  return resolveClaudeModels(await readClaudeEnv())
}

// Claude Code docs: effort-capable models default to `high`, except these.
const CLAUDE_DEFAULT_EFFORTS: Record<string, ReasoningEffort> = {
  'claude-opus-5-5': 'medium',
  'claude-opus-4-7': 'xhigh'
}

/**
 * Ask the official SDK for the native model catalog so labels carry real versions.
 * No session is persisted and hooks are disabled for this probe. The context
 * window is left unset: the CLI reports it per turn (`result.modelUsage`).
 */
export async function loadClaudeCliModels(bin: string, timeoutMs = 10000): Promise<ModelDef[]> {
  const initialized = await initializeClaudeSdk(bin, { ...process.env, ...nativeCredentialEnv('claude') }, timeoutMs)
  const entries = initialized.models || []
  const models: ModelDef[] = []
  for (const model of entries) {
    if (typeof model.value !== 'string' || model.value === 'default') continue
    const efforts = model.supportsEffort ? sanitizeEfforts(model.supportedEffortLevels) : []
    const label = typeof model.displayName === 'string' && /\d/.test(model.displayName)
      ? model.displayName : typeof model.description === 'string' && model.description.split(' · ')[0]
    models.push({ id: model.value, label: label || model.displayName || model.value, efforts,
      defaultEffort: efforts.length ? CLAUDE_DEFAULT_EFFORTS[model.resolvedModel] ?? 'high' : undefined })
  }
  if (!models.length) throw new Error('Claude SDK 未返回模型列表')
  return models
}

/**
 * Per-agent permission-mode tables. Each CLI exposes a different set of档位 with
 * different display names — codex拆出「请求批准 / 帮我批准 / 完全访问」, traex用
 * default/auto/bypass_permissions, claude用 acceptEdits/auto/bypassPermissions
 * 且没有纯只读档。The logical id is the stable contract (see PermissionModeId in
 * shared/types.ts); label/hint是该 Agent 的真实展示名与提示。first item = default.
 * The id→real-flag mapping lives in adapter.ts (one-shot) / appServerAdapter.ts
 * (streaming); this table only drives what the selector OFFERS + how it reads.
 */
const CODEX_MODES: PermissionModeDef[] = [
  { id: 'read-only', label: '只读', hint: '可读不可写，命令在只读沙箱执行' },
  { id: 'ask', label: '请求批准', hint: '可写工作区，命令/联网按需请求你批准（on-request）' },
  { id: 'approve-for-me', label: '帮我批准', hint: '可写工作区，审批交给自动审查子代理（--approve-for-me）' },
  { id: 'full-access', label: '完全访问', hint: '跳过审批、可访问工作区外（danger-full-access）' }
]

const TRAEX_MODES: PermissionModeDef[] = [
  { id: 'read-only', label: '只读', hint: '可读不可写（-s read-only）' },
  { id: 'ask', label: '请求批准', hint: '可写工作区，联网/改工作区外文件需批准（default 模式）' },
  { id: 'approve-for-me', label: '帮我批准', hint: '可写工作区，符合条件的审批走自动审查子代理（auto 模式）' },
  { id: 'full-access', label: '完全放开', hint: '可改工作区外文件、免批准联网（bypass_permissions）' }
]

// Claude Code has no pure read-only permission档; its plan mode是只读式分析模式，
// so `read-only` is intentionally omitted from its subset.
const CLAUDE_MODES: PermissionModeDef[] = [
  { id: 'plan', label: '计划模式', hint: '只读分析、产出计划，不修改文件（--permission-mode plan）' },
  { id: 'ask', label: '请求批准', hint: '每次改动/命令请求你确认（manual）' },
  { id: 'auto-edit', label: '自动编辑', hint: '自动批准文件编辑和常见文件命令；其他命令仍按原生规则审批（acceptEdits）' },
  { id: 'approve-for-me', label: '帮我批准', hint: '审批交给自动审查（auto）' },
  { id: 'deny-unapproved', label: '仅预先允许', hint: '只执行已允许的操作，需要额外审批的操作直接拒绝（dontAsk），不会自动放行。' },
  { id: 'full-access', label: '完全放开', hint: '跳过常规审批；显式拒绝规则、必须交互的工具和原生关键路径保护仍生效（bypassPermissions）。' }
]
/** The permission-mode table for a given adapter (falls back to a安全 subset). */
function permissionModesFor(adapter: AgentDef['adapter']): PermissionModeDef[] {
  if (adapter === 'codex') return CODEX_MODES
  if (adapter === 'traex') return TRAEX_MODES
  if (adapter === 'claude') return CLAUDE_MODES
  if (adapter === 'kimi') return KIMI_WEB_PERMISSION_MODES
  if (adapter === 'grok') return GROK_PERMISSION_MODES
  if (adapter === 'mcode') return MCODE_PERMISSION_MODES
  if (adapter === 'zcode') return ZCODE_PERMISSION_MODES
  return [{ id: 'read-only', label: '只读', hint: '可读不可写' }]
}

/**
 * Built-in agents. Model lists are populated at detect time from the real CLI
 * caches so the UI only ever offers models/efforts the CLI actually accepts.
 * Permission-mode tables are likewise injected per legacy adapter at detect
 * time. ACP providers expose session-scoped modes, so their process-wide seed
 * is deliberately empty until session/new|load|resume completes.
 */
export const BUILTIN_AGENTS: AgentDef[] = [
  {
    id: 'zcode', name: 'ZCode', bin: 'zcode', adapter: 'zcode', icon: 'zcode', builtin: true,
    capabilities: { modelSelect: true, reasoningEffort: true, attachments: true, permissionModes: ZCODE_PERMISSION_MODES,
      streaming: true, protocol: 'zcode-protocol', imageAttachments: false, fileAttachments: true,
      sessionList: false, sessionLoad: true, sessionResume: true, steer: false, followup: true,
      sessionFork: true, sessionForkAtTurn: true, crossAgentFork: false, sideChat: true, structuredSubagents: false,
      formElicitation: true, freeTextElicitation: true, nativeGoal: true, nativeReview: false, structuredUsage: true,
      capabilityInventory: false, additionalDirectoriesNew: false, additionalDirectoriesResume: false,
      collaborationModes: ['default', 'plan'], commands: [] }, models: []
  },
  {
    id: 'mcode', name: 'MiniMax Code', bin: 'mcode', adapter: 'mcode', icon: 'mcode', builtin: true,
    capabilities: {
      modelSelect: true, reasoningEffort: true, permissionModes: MCODE_PERMISSION_MODES,
      streaming: true, protocol: 'acp', imageAttachments: true, fileAttachments: false,
      sessionList: true, sessionLoad: true, sessionResume: true,
      steer: false, followup: true, sessionFork: true, sessionForkAtTurn: false,
      crossAgentFork: false, sideChat: false, structuredSubagents: false,
      formElicitation: true, freeTextElicitation: true, nativeGoal: false,
      nativeReview: false, structuredUsage: false, capabilityInventory: false,
      additionalDirectoriesNew: false, additionalDirectoriesResume: false,
      collaborationModes: ['default', 'plan'], commands: []
    }, models: []
  },
  {
    id: 'deepseek', name: 'DeepSeek Harness', bin: 'dsh', adapter: 'deepseek', icon: 'deepseek', builtin: true,
    capabilities: {
      modelSelect: true, reasoningEffort: true, permissionModes: DEEPSEEK_PERMISSION_MODES,
      streaming: true, protocol: 'acp', imageAttachments: false, fileAttachments: false,
      sessionList: false, sessionLoad: false, sessionResume: false,
      steer: false, followup: true, sessionFork: false, sessionForkAtTurn: false,
      crossAgentFork: false, sideChat: false, structuredSubagents: false,
      formElicitation: false, freeTextElicitation: false, nativeGoal: false,
      nativeReview: false, structuredUsage: false, capabilityInventory: false,
      additionalDirectoriesNew: false, additionalDirectoriesResume: false,
      collaborationModes: ['default'], commands: []
    }, models: []
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    adapter: 'codex',
    icon: '🟢',
    builtin: true,
    capabilities: {
      modelSelect: true,
      reasoningEffort: true,
      permissionModes: CODEX_MODES,
      startupSystemPrompt: true,
      steer: true,
      followup: true,
      sessionFork: true,
      sessionForkAtTurn: true,
      crossAgentFork: true,
      sideChat: true,
      structuredSubagents: true,
      formElicitation: true,
      freeTextElicitation: true,
      nativeGoal: true,
      nativeReview: true,
      structuredUsage: true,
      capabilityInventory: true,
      additionalDirectoriesNew: true,
      additionalDirectoriesResume: true
    },
    models: []
  },
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    adapter: 'claude',
    icon: '🟣',
    builtin: true,
    capabilities: {
      modelSelect: true,
      reasoningEffort: true,
      permissionModes: CLAUDE_MODES,
      startupSystemPrompt: true,
      sideChat: true,
      capabilityInventory: true,
      nativeReview: true,
      nativeGoal: true,
      steer: true,
      followup: true,
      sessionFork: true,
      sessionForkAtTurn: true,
      crossAgentFork: true,
      structuredSubagents: true,
      structuredUsage: true,
      formElicitation: true,
      freeTextElicitation: true,
      additionalDirectoriesNew: true,
      additionalDirectoriesResume: true
    },
    models: CLAUDE_MODELS,
    defaultModel: 'sonnet'
  },
  {
    id: 'kimi', name: 'Kimi Code', bin: 'kimi', adapter: 'kimi', icon: 'kimi', builtin: true,
    capabilities: {
      modelSelect: true, reasoningEffort: true, permissionModes: KIMI_WEB_PERMISSION_MODES,
      streaming: true, protocol: 'web', imageAttachments: true, fileAttachments: true,
      sessionList: false, sessionLoad: false, sessionResume: false,
      steer: false, followup: true, sessionFork: false, sessionForkAtTurn: false,
      crossAgentFork: false, sideChat: false, structuredSubagents: false,
      formElicitation: false, freeTextElicitation: false,
      nativeGoal: false, nativeReview: false,
      structuredUsage: false, capabilityInventory: false,
      additionalDirectoriesNew: false, additionalDirectoriesResume: false,
      collaborationModes: ['default', 'plan'], commands: []
    },
    models: []
  },
  {
    id: 'grok',
    name: 'Grok',
    bin: 'grok',
    adapter: 'grok',
    icon: 'grok',
    builtin: true,
    capabilities: {
      modelSelect: true,
      reasoningEffort: true,
      permissionModes: GROK_PERMISSION_MODES,
      streaming: true,
      protocol: 'acp',
      imageAttachments: false,
      fileAttachments: false,
      sessionList: false,
      sessionLoad: false,
      sessionResume: false,
      steer: false,
      followup: true,
      sessionFork: false,
      sessionForkAtTurn: false,
      crossAgentFork: false,
      sideChat: false,
      structuredSubagents: false,
      formElicitation: false,
      freeTextElicitation: false,
      nativeGoal: false,
      nativeReview: false,
      structuredUsage: false,
      capabilityInventory: false,
      additionalDirectoriesNew: false,
      additionalDirectoriesResume: false
    },
    models: []
  }
]

/** Resolve a binary on PATH and grab its version. Returns null if not found. */
async function probe(bin: string): Promise<{ path: string; version: string } | null> {
  const path = await findAgentExecutable(bin)
  if (!path) return null
  let version = ''
  try {
    const { stdout } = await execFileP(path, ['--version'], { timeout: 8000 })
    version = stdout.trim().split('\n')[0]
  } catch { version = 'unknown' }
  return { path, version }
}

/**
 * Whether `<bin> app-server` exists — the JSON-RPC backend that streams
 * token-level output. Only codex/traex ship it; older CLIs don't, so we probe
 * and fall back to the one-shot `exec --json` path when absent.
 */
export function probeAppServer(bin: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['app-server', '--help'], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin.end()
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** Initialize through the SDK before advertising the installed CLI as usable. */
async function probeClaudeSdk(bin: string): Promise<boolean> {
  try {
    await initializeClaudeSdk(bin, { ...process.env, ...nativeCredentialEnv('claude') })
    return true
  } catch {
    return false
  }
}

/** Load the real model list for an installed agent. */
async function loadModels(agent: AgentDef, bin: string): Promise<ModelDef[]> {
  try {
    if (agent.adapter === 'codex') return await loadCodexModels(bin)
    if (agent.adapter === 'traex') return await loadTraexModels(bin)
    if (agent.adapter === 'claude') {
      const { models } = await loadClaudeModels()
      // Vanilla setup: the bare aliases hide the real versions, so ask the CLI.
      return claudeModelsProvider(models === CLAUDE_MODELS ? await loadClaudeCliModels(bin) : models)
    }
  } catch {
    /* ignore, fall through */
  }
  return agent.adapter === 'claude' ? claudeModelsProvider(agent.models) : agent.models
}

export type AgentDetectionScope = 'all' | 'core' | 'protocol'
export type AgentDetectionObserver = (agent: AgentDef) => void | Promise<void>

export function matchesAgentDetectionScope(agent: AgentDef, scope: AgentDetectionScope): boolean {
  const protocol = agent.capabilities.protocol === 'acp' || agent.capabilities.protocol === 'zcode-protocol' || agent.adapter === 'kimi' || agent.adapter === 'nika'
  return scope === 'all' || (scope === 'protocol' ? protocol : !protocol)
}

export function failedAgentDetection(agent: AgentDef, error: unknown): AgentDef {
  const detail = (error instanceof Error ? error.message : String(error ?? '')).replace(/^Error:\s*/, '').split('\n')[0].trim()
  const message = detail.includes('kimi_web_shutdown_')
    ? '本地服务退出状态无法确认，请重试。'
    : detail || 'Agent 检测失败，请重试。'
  return {
    ...agent,
    lifecycle: {
      availability: 'unhealthy', auth: 'unknown', health: 'unhealthy', updateStatus: 'idle',
      detectionStatus: 'failed', detectionError: message, checkedAt: Date.now()
    }
  }
}

/** Detect which built-in agents are installed and enrich their defs. */
export async function detectAgents(scope: AgentDetectionScope = 'all', agentId?: string, onDetected?: AgentDetectionObserver): Promise<AgentDef[]> {
  const credentialsError = await loadNativeCredentials().then(() => undefined, error => error)
  const candidates = BUILTIN_AGENTS.filter(agent => isDistributionAgent(agent.id, agent.adapter) && matchesAgentDetectionScope(agent, scope) && (agentId === undefined || agent.id === agentId))
  const results = await Promise.all(
    candidates.map(async (a) => {
      if (credentialsError && (a.adapter === 'claude' || a.adapter === 'grok')) throw credentialsError
      if (a.adapter === 'zcode') {
        try { await importPreparedZCodeRuntime() }
        catch (error) { return failedAgentDetection({ ...a, installed: true }, error) }
        const runtime = await getZCodeRuntimeSnapshot()
        return { ...a, installed: !!runtime.config, incompatible: runtime.phase === 'failed',
          capabilities: { ...a.capabilities, imageAttachments: runtime.models?.some(model => model.imageInput) === true },
          bin: runtime.config?.executable ?? a.bin, version: runtime.version, unavailableReason: runtime.message,
          models: runtime.models ?? [], defaultModel: runtime.currentModel ? zcodeModelKey(runtime.currentModel) : undefined } satisfies AgentDef
      }
      if (a.adapter === 'deepseek') return detectDeepSeek(a)
      
      if (a.adapter === 'mcode') return detectMCode(a)
      if (a.adapter === 'kimi') {
        const probe = await probeKimiWeb(a.bin)
        const contract = probe.contract
        return {
          ...a,
          bin: probe.path || a.bin,
          version: probe.version,
          installed: probe.status !== 'uninstalled',
          incompatible: probe.status === 'incompatible',
          authenticationRequired: probe.status === 'needs-auth' || probe.status === 'needs-config',
          unavailableReason: probe.reason,
          capabilities: {
            ...a.capabilities,
            modelSelect: (contract?.models.length || 0) > 0,
            reasoningEffort: contract?.models.some(model => model.efforts.length > 0 || (model.thinkingOptions?.length || 0) > 0) ?? false,
            permissionModes: contract?.permissionModes || KIMI_WEB_PERMISSION_MODES,
            imageAttachments: contract?.imageAttachments ?? false,
            fileAttachments: contract?.fileAttachments ?? false,
            sessionList: contract?.sessionList ?? false,
            sessionLoad: contract?.sessionLoad ?? false,
            sessionResume: contract?.sessionResume ?? false,
            steer: contract?.steer ?? false,
            followup: true,
            sessionFork: contract?.sessionFork ?? false,
            sessionForkAtTurn: false,
            crossAgentFork: false,
            sideChat: false,
            structuredSubagents: contract?.structuredSubagents ?? false,
            formElicitation: contract?.formElicitation ?? false,
            freeTextElicitation: false,
            nativeGoal: contract?.nativeGoal ?? false,
            nativeReview: false,
            structuredUsage: contract?.structuredUsage ?? false,
            capabilityInventory: false,
            additionalDirectoriesNew: contract?.additionalDirectoriesNew ?? false,
            additionalDirectoriesResume: contract?.additionalDirectoriesResume ?? false,
            commands: contract?.commands || [],
            collaborationModes: contract?.collaborationModes || []
          },
          models: contract?.models || [],
          defaultModel: contract?.currentModelId
        } satisfies AgentDef
      }
      if (a.adapter === 'grok') {
        const probe = await probeGrokACP(a.bin)
        const contract = probe.contract
        return {
          ...a,
          bin: probe.path || a.bin,
          version: probe.version,
          installed: probe.status !== 'uninstalled',
          incompatible: probe.status === 'incompatible',
          authenticationRequired: probe.status === 'needs-auth',
          unavailableReason: probe.reason,
          capabilities: {
            ...a.capabilities,
            modelSelect: (contract?.models.length || 0) > 0,
            reasoningEffort: contract?.models.some(model => model.efforts.length > 0 || (model.thinkingOptions?.length || 0) > 0) ?? false,
            permissionModes: contract?.permissionModes || GROK_PERMISSION_MODES,
            imageAttachments: contract?.imageAttachments ?? false,
            fileAttachments: contract?.fileAttachments ?? false,
            sessionList: contract?.sessionList ?? false,
            sessionLoad: contract?.sessionLoad ?? false,
            sessionResume: contract?.sessionResume ?? false,
            steer: contract?.steer ?? false,
            followup: contract?.followup ?? true,
            sessionFork: contract?.sessionFork ?? false,
            sessionForkAtTurn: false,
            crossAgentFork: false,
            sideChat: contract?.sessionFork === true,
            structuredSubagents: contract?.structuredSubagents ?? false,
            formElicitation: contract?.formElicitation ?? false,
            freeTextElicitation: contract?.freeTextElicitation ?? false,
            nativeGoal: contract?.nativeGoal ?? false,
            nativeReview: false,
            structuredUsage: contract?.structuredUsage ?? false,
            capabilityInventory: contract?.capabilityInventory ?? false,
            additionalDirectoriesNew: contract?.additionalDirectoriesNew ?? false,
            additionalDirectoriesResume: contract?.additionalDirectoriesResume ?? false,
            commands: contract?.commands || [],
            collaborationModes: contract?.collaborationModes || []
          },
          models: contract?.models || [],
          defaultModel: contract?.currentModelId
        } satisfies AgentDef
      }
      const installedCodex = a.adapter === 'codex' ? await probe(a.bin) : null
      const preferredBin = a.adapter === 'codex' ? resolveCodexRuntimeBin(installedCodex?.path || a.bin) : a.bin
      const found = preferredBin === installedCodex?.path
        ? installedCodex
        : await probe(preferredBin) || installedCodex
      const bin = found?.path || a.bin
      const [models, streaming] = await Promise.all([
        found ? loadModels(a, bin) : Promise.resolve(a.models),
        !found ? Promise.resolve(false)
          : a.adapter === 'codex' || a.adapter === 'traex' ? probeAppServer(bin)
          : a.adapter === 'claude' ? probeClaudeSdk(bin) : Promise.resolve(false)
      ])
      // Claude's default model depends on the settings env (cc switch etc.);
      // keep it in sync with the resolved list so a concrete model like kimi-k3
      // is preselected instead of the stale `sonnet` alias.
      let defaultModel = a.defaultModel
      if (a.adapter === 'claude' && found) {
        defaultModel = (await loadClaudeModels()).defaultModel ?? defaultModel
      } else if (defaultModel && !models.some((m) => m.id === defaultModel)) {
        defaultModel = (a.adapter === 'codex'
          ? models.find(model => !model.modelSource || model.modelSource.kind === 'native')?.id
          : models[0]?.id) ?? defaultModel
      }
      // Codex/TraeX stream via `app-server`; Claude streams token-level deltas
      // through its one-shot `--include-partial-messages` flag. Probe whichever
      // applies so streaming lights up automatically when the CLI supports it.
      const capabilities = {
        ...a.capabilities,
        // Collapse the effort control if no model actually exposes efforts.
        reasoningEffort: a.capabilities.reasoningEffort && models.some((m) => m.efforts.length > 0),
        // Inject the per-adapter permission-mode table (id + display name + hint)
        // so the selector offers each Agent's真实档位, not a写死统一集合.
        permissionModes: permissionModesFor(a.adapter),
        streaming,
        ...((a.adapter === 'codex' || a.adapter === 'traex')
          ? { steer: streaming, followup: true }
          : {})
      }
      return {
        ...a,
        installed: !!found,
        bin,
        version: found?.version,
        ...(a.adapter === 'claude' && found && !streaming ? { incompatible: true,
          unavailableReason: 'Claude SDK 初始化失败，请刷新状态重试；已有连接配置已保留' } : {}),
        models,
        ...(a.adapter === 'codex' && found && models.length && await codexUsesExternalProvider() ? { authenticationRequired: false } : {}),
        defaultModel,
        capabilities
      }
    }).map((probe, index) => probe.catch(error => failedAgentDetection(candidates[index], error)).then(async agent => {
      await onDetected?.(agent)
      return agent
    }))
  )
  return results
}
