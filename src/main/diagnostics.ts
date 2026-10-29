import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { DiagnosticEntry } from '../shared/types'
import { CODEX_SOURCE_NAMES, type CodexSourceRuntimeIssue, type CodexSourceServiceRuntimeIssue } from '../shared/codexSources'
import { resolveUserDataHome } from './userData.ts'
import { isConversationHint, isHiddenAgentWarning } from '../shared/agentWarnings.ts'
import { isProviderQuotaExceeded } from '../shared/providerErrors.ts'

/**
 * 跨 Agent 迁移诊断日志 (cross-agent migration diagnostics).
 *
 * When a session is read from one agent's native store and reconstructed for
 * another (see history.ts), the parser may hit data it doesn't yet handle: an
 * unknown record type, an unrecognized payload/item shape, or a field it can't
 * map. Left silent, these degrade the transplant (missing history, dropped tool
 * calls) with no trace. This store is the single collection point: every such
 * gap is recorded here with a clear description + a raw sample, persisted to
 * ~/.uniagent/migration-diagnostics.jsonl, and surfaced in the sidebar's
 * "迁移诊断" entry. The user can copy the whole report and hand it back so the
 * exact unhandled shape gets fixed.
 *
 * Entries are deduped by (agentId, code, field): the same unknown type seen 200
 * times across a long rollout collapses to one row with a count, instead of
 * flooding the log.
 */
/** Max entries kept on disk / in memory (newest win). */
const MAX_ENTRIES = 500
/** Cap a raw sample so a huge tool output doesn't bloat the log. */
const SAMPLE_CAP = 12_000

// These codes either described successful operations or parser shapes fixed from
// the diagnostic report generated at this instant. Hide only entries that existed
// by then: a later parser regression using the same key must remain visible.
const RESOLVED_BEFORE = Date.parse('2026-09-08T13:25:46.286Z')
const RESOLVED_RUNTIME_BEFORE = Date.parse('2026-09-14T12:50:56.240Z')
const REVIEWED_RUNTIME_BEFORE = Date.parse('2026-10-08T06:30:59.139Z')
const REVIEWED_OCT13_BEFORE = Date.parse('2026-10-13T13:41:47.374Z')
const RESOLVED_DIAGNOSTICS = new Set([
  'export_ok\0',
  'fork_same_ok\0',
  'unknown_rollout_record\0token_usage_record',
  'unknown_rollout_record\0inter_agent_communication',
  'unknown_event_msg_type\0agent_reasoning_raw_content',
  'unknown_event_msg_type\0image_generation_end',
  'unknown_event_msg_type\0terminal_interaction',
  'unknown_event_msg_type\0collab_waiting_end',
  'unknown_event_msg_type\0collab_close_end',
  'unknown_event_msg_type\0collab_agent_spawn_end',
  'unknown_event_msg_type\0collab_agent_interaction_end',
  'unknown_event_msg_type\0thread_rolled_back'
])

function isResolvedHistoricalDiagnostic(
  entry: Pick<DiagnosticEntry, 'code' | 'field' | 'message' | 'source' | 'ts' | 'sample'>
): boolean {
  if (!Number.isFinite(entry.ts)) return false
  const sample = diagnosticSample(entry.sample)
  if (entry.ts <= REVIEWED_OCT13_BEFORE) {
    // Old updater rows contain only "network" and include repeated cache hits.
    // Fresh failures retain the transport stage/kind and are still actionable.
    if (entry.source === 'app-update' && entry.code === 'network' && entry.message === 'network' &&
      !sample?.context?.kind) return true
    if (entry.source === 'codex-app-server' && entry.code === 'title_generation_failed' &&
      entry.field === 'response' && sample?.message === '标题回合未完成：failed') return true
    if (entry.source === 'main-process' && entry.code === 'unhandled_rejection' &&
      sample?.error?.code === 'ENOENT' && sample.error.syscall === 'rename' &&
      /\/team-results\/[a-f0-9-]{36}\.json\.tmp$/i.test(String(sample.error.path))) return true
  }
  // Pin each cutoff to its fix, so a later regression is never hidden.
  if (entry.ts <= Date.parse('2026-10-13T06:25:32Z') &&
    /Cannot read properties of undefined \(reading 'info'\)/.test(entry.message) &&
    (entry.source === 'renderer' && /NewTaskPanel/.test(String(sample?.error)) ||
      entry.source === 'renderer-console' && /\/assets\/index-C-fuwkw1\.js$/.test(String(sample?.context?.sourceId)))) return true
  if (entry.ts <= Date.parse('2026-10-13T07:47:45Z') && entry.source === 'agent' &&
    entry.code === 'agent_run_error' && /Invalid '[^']*\.call_id': string too long/.test(entry.message)) return true
  if (entry.ts <= Date.parse('2026-10-12T11:15:16Z') && entry.source === 'agent' &&
    entry.code === 'agent_run_error' && entry.message === 'Trae chat history contains duplicate tool calls; refusing ambiguous history') return true
  if (entry.ts <= Date.parse('2026-10-12T16:19:04Z') && entry.source === 'agent' &&
    entry.code === 'agent_run_error' && /^unexpected status 404 Not Found: 模型不属于当前第三方来源, url: http:\/\/127\.0\.0\.1:\d+\/api\/codex\/v1\/kimi\/responses$/.test(entry.message)) return true
  if (entry.ts <= Date.parse('2026-10-13T08:58:09Z') && entry.source === 'renderer-console' &&
    entry.code === 'console_error' && /\/out\/renderer\/html-preview\.html$/.test(String(sample?.context?.sourceId)) &&
    (/^Not allowed to load local resource: file:.*\/out\/renderer\/assets\/index-[\w-]+\.(?:css|js)$/.test(entry.message) ||
      /^The Content Security Policy .+was delivered via a <meta> element outside the document's <head>/.test(entry.message))) return true
  if (entry.ts <= REVIEWED_RUNTIME_BEFORE) {
    if (entry.source === 'agent' && entry.code === 'agent_run_error' &&
      entry.message === 'Grok ACP 运行失败：Grok ACP 返回了未知 JSON-RPC 响应 id') return true
    if (entry.code === 'ipc_rejected' && (
      entry.source === 'team:archive' && /: Error: team_session_missing$/.test(entry.message) ||
      entry.source === 'team:save' && /: Error: invalid_team_limit_(?:concurrency|maxAssignments|taskMinutes)$/.test(entry.message)
    )) return true
    if (entry.source === 'agent' && entry.code === 'agent_run_warning' &&
      /^Codex is ignoring 1 unrecognized configuration setting\. Check for typos or deprecated settings\.\s+session-flags: `token_budget` is ignored\.$/.test(entry.message)) return true
  }
  if (
    entry.ts <= RESOLVED_BEFORE &&
    RESOLVED_DIAGNOSTICS.has(`${entry.code}\0${entry.field ?? ''}`)
  ) return true
  if (entry.ts > RESOLVED_RUNTIME_BEFORE) return false
  return (
    entry.code === 'render_process_gone' &&
    entry.source === 'renderer' &&
    entry.message.trim() === 'killed'
  ) || (
    entry.code === 'console_error' &&
    entry.source === 'renderer-console' &&
    /Content Security Policy.+was delivered via a <meta> element outside the document's <head>/s.test(entry.message)
  )
}

function isTransientReconnect(input: Pick<DiagnosticInput, 'category' | 'code' | 'message'>): boolean {
  if (input.category !== 'app_runtime' || input.code !== 'agent_run_error') return false
  const message = input.message.trim()
  if (/^Reconnecting(?:…|\.\.\.)\s+\d+\/\d+$/i.test(message)) return true
  return /^stream disconnected before completion:/i.test(message) &&
    /transport error|network error|error decoding response body|connection|socket|timed? out|econnreset/i.test(message)
}

const HANDLED_PROVIDER_NOTIFICATIONS = new Set([
  'hook/started',
  'hook/completed',
  'turn/started',
  'thread/status/changed',
  'thread/inboxStatus/updated',
  'thread/started',
  'remoteControl/status/changed'
])
const CONSUMED_PROVIDER_EVENTS = new Set([
  'notification:account/updated:unsupported_method',
  'notification:account/rateLimits/updated:unsupported_method',
  // 全 null 的额度快照是耗尽后的空推送，按设计忽略（保留最近一次已知额度）。
  'notification:account/rateLimits/updated:missing_rate_limits',
  // TraeX worktree 会话广播已按信息类事件消费。
  'notification:thread/worktreeSession/entered:unsupported_method',
  'notification:thread/worktreeSession/updated:unsupported_method',
  'notification:item/commandExecution/terminalInteraction:unsupported_method',
  'item:taskNotification:started',
  'item:taskNotification:completed'
])

/** Entries produced by older builds for events that are now handled or expected. */
function isExpectedRuntimeNoise(
  input: Pick<DiagnosticInput, 'category' | 'source' | 'code' | 'field' | 'message' | 'sample'>
): boolean {
  if (input.category !== 'app_runtime') return false

  // Detailed timings remain in performance-logs; this is not an execution failure.
  if (input.source === 'renderer-performance' && input.code === 'renderer_long_tasks') return true
  if (input.source === 'renderer-console' && input.code === 'console_error' &&
    input.message === 'Uncaught Error: 设计稿面板越界' &&
    diagnosticSample(input.sample)?.context?.sourceId === 'about:srcdoc') return true
  if (input.source === 'feishu' && input.code === 'progress_card_update_failed') {
    const context = diagnosticSample(input.sample)?.context
    // Retry attempts are retained in session logs. Terminal/unknown failures stay visible.
    if (context?.retryStopped === false && (
      context.failureKind === 'timeout' || context.failureKind === 'network' ||
      [300120, 300308].includes(context.feishuCode)
    )) return true
  }
  if (input.source === 'agent' && input.code === 'agent_run_error' &&
    input.message === 'Selected model is at capacity. Please try a different model.') return true

  if (input.code === 'ignored_provider_event') {
    const key = input.field || input.message.trim()
    if (CONSUMED_PROVIDER_EVENTS.has(key)) return true
    if (input.source === 'traex-app-server' && key === 'notification:thread/name/generated:missing_thread_name') {
      const sample = diagnosticSample(input.sample)
      if (typeof sample?.name === 'string' && !sample.name.trim()) return true
    }
    if (
      /^item:collabAgentToolCall:(?:started|completed):missing_subagent_state$/.test(key) &&
      (
        (input.sample && typeof input.sample === 'object' &&
          (input.sample as Record<string, unknown>).tool === 'wait') ||
        (typeof input.sample === 'string' && /"tool"\s*:\s*"wait"/.test(input.sample))
      )
    ) return true
    const match = /^notification:(.+):unsupported_method$/.exec(key)
    return !!match && HANDLED_PROVIDER_NOTIFICATIONS.has(match[1])
  }
  if (input.code === 'agent_run_warning' || input.code === 'side_run_warning') {
    return /^[-─━=]{8,}$/.test(input.message.trim()) ||
      input.message === 'Automatic continuation of background results is paused after this turn failed. Resolve the error, then send a message to continue.' ||
      // A background marketplace refresh does not invalidate installed plugins.
      /^Failed to update plugin marketplace `[^`]+`: git ls-remote marketplace source failed[^\n]*Send failure: Broken pipe$/.test(input.message) ||
      isConversationHint(input.message) || isHiddenAgentWarning(input.message) ||
      input.message === 'Model output limit reached. Discarded the incomplete response and retrying with a concise-output reminder.' ||
      // Codex 对第三方/本地模型 slug 没有内置元数据，固定回退并逐回合告警；
      // 模型目录已通过 model_catalog_json 提供上下文窗口，该警告不可行动。
      /^Model metadata for `[^`]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.$/.test(input.message) ||
      /^TRAE CLI is ignoring 1 unrecognized configuration setting\. Check for typos or deprecated settings\.\s+user: `desktop` is ignored\.$/.test(input.message)
  }
  if (
    input.code === 'uncaught_exception' ||
    input.code === 'console_error' ||
    input.code === 'console_warning'
  ) {
    if (/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)\.?$/.test(input.message.trim())) {
      return true
    }
  }
  if (input.code === 'outbound_message_failed' && input.source === 'feishu') {
    return /^(?:无效的飞书发送请求|文案和文件不能同时为空|文案不能超过 3500 个字符|一次最多发送 10 个文件|文件路径无效|文件不存在：|文件不在当前工作目录内：|不是普通文件：|文件为空：|.+超过飞书 (?:图片 10 MB|文件 30 MB) 限制|文件在发送前发生变化：)/.test(input.message)
  }

  // These roots remain usable for replies; only editing their title is closed.
  if (input.code === 'feishu_title_sync_failed' && input.source === 'feishu') {
    try {
      const sample = (typeof input.sample === 'string' ? JSON.parse(input.sample) : input.sample) as
        { context?: { feishuCode?: number } } | undefined
      if (sample?.context?.feishuCode === 230072 || sample?.context?.feishuCode === 230075) return true
    } catch { /* keep malformed or unknown failures visible */ }
  }
  if (input.code === 'ipc_rejected' && input.source === 'agents:update' &&
    /: Error: agent_has_active_session$/.test(input.message)) return true

  return input.code === 'ipc_rejected' &&
    input.source === 'session:refreshNative' &&
    /当前会话正在运行，无法刷新|会话状态已变化，请稍后刷新/.test(input.message)
}

function diagnosticSample(sample: unknown): any {
  if (typeof sample !== 'string') return sample
  try { return JSON.parse(sample) } catch { return undefined }
}

/** Filter the diagnostics copy only; conversation failures and provider state stay intact. */
function isQuotaDiagnostic(input: Pick<DiagnosticInput, 'category' | 'source' | 'code' | 'message' | 'sample'>): boolean {
  if (input.category !== 'app_runtime') return false
  const providerFailure =
    input.source === 'agent' && ['agent_run_error', 'agent_run_warning'].includes(input.code) ||
    input.source === 'side-agent' && ['side_run_error', 'side_run_warning'].includes(input.code) ||
    /^(?:codex|traex)-app-server$/.test(input.source || '') && input.code === 'title_generation_failed' ||
    input.source === 'codex-sources' && input.code === 'codex_source_http_error'
  if (!providerFailure) return false
  if (isProviderQuotaExceeded(input.message)) return true
  const sample = diagnosticSample(input.sample)
  // Never scan arbitrary prompts or request context for quota-related words.
  return sample?.context?.provider?.providerError?.codexErrorInfo === 'usageLimitExceeded'
}

function shouldIgnoreDiagnostic(
  input: Pick<DiagnosticInput, 'category' | 'source' | 'code' | 'field' | 'message' | 'sample'>
): boolean {
  return isQuotaDiagnostic(input) || isTransientReconnect(input) || isExpectedRuntimeNoise(input)
}

export interface DiagnosticInput {
  category?: DiagnosticEntry['category']
  level: 'warn' | 'error'
  source?: string
  agentId: string
  sessionId?: string
  code: string
  message: string
  field?: string
  sample?: unknown
}

export class DiagnosticsStore extends EventEmitter {
  private file: string
  private entries: DiagnosticEntry[] = []
  private loaded = false

  constructor(fileOverride?: string) {
    super()
    this.file = fileOverride || join(resolveUserDataHome(), 'migration-diagnostics.jsonl')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (existsSync(this.file)) {
        const text = readFileSync(this.file, 'utf8')
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line) as DiagnosticEntry
            const normalized = {
              ...entry,
              category: entry.category || 'session_import',
              source: entry.source || 'session-import',
              message: trimText(redactDiagnosticText(entry.message || '未知错误')),
              sample: entry.sample ? redactDiagnosticText(trimText(entry.sample)) : undefined
            }
            if (!shouldIgnoreDiagnostic(normalized)) this.entries.push(normalized)
          } catch {
            /* skip a corrupt line */
          }
        }
      }
    } catch {
      /* first run / unreadable — start empty */
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      const text = this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      writeFileSync(this.file, text, 'utf8')
    } catch {
      /* best effort — diagnostics must never crash a parse */
    }
  }

  /**
   * Record one diagnostic. Deduped by (agentId, code, field): a repeat bumps the
   * existing row's count + timestamp instead of adding a new line. Returns the
   * entry (new or updated) and emits 'diagnostic' so the UI can badge it.
   */
  record(input: DiagnosticInput): DiagnosticEntry | undefined {
    this.ensureLoaded()
    if (shouldIgnoreDiagnostic(input)) return undefined
    const field = input.field
    const message = trimText(redactDiagnosticText(input.message))
    const dupIdx = this.entries.findIndex(
      (e) => !isResolvedHistoricalDiagnostic(e) &&
        e.category === (input.category || 'session_import') &&
        e.source === (input.source || 'session-import') &&
        e.agentId === input.agentId && e.code === input.code &&
        e.field === field &&
        ((input.category || 'session_import') === 'session_import' || e.message === message)
    )
    let entry: DiagnosticEntry
    if (dupIdx >= 0) {
      entry = this.entries[dupIdx]
      entry.count += 1
      entry.ts = Date.now()
      entry.sessionId = input.sessionId ?? entry.sessionId
      entry.level = input.level === 'error' ? 'error' : entry.level
      // Keep the freshest sample so the report reflects a real current case.
      if (input.sample !== undefined) entry.sample = redactDiagnosticText(trimSample(input.sample))
      // Move it to the front (newest activity first).
      this.entries.splice(dupIdx, 1)
      this.entries.unshift(entry)
    } else {
      entry = {
        id: 'd_' + nanoid(8),
        ts: Date.now(),
        level: input.level,
        category: input.category || 'session_import',
        source: input.source || 'session-import',
        agentId: input.agentId,
        sessionId: input.sessionId,
        code: input.code,
        message,
        field,
        sample: input.sample !== undefined ? redactDiagnosticText(trimSample(input.sample)) : undefined,
        count: 1
      }
      this.entries.unshift(entry)
      if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES
    }
    this.persist()
    this.emit('diagnostic', entry)
    return entry
  }

  list(): DiagnosticEntry[] {
    this.ensureLoaded()
    return this.entries.filter((entry) => !isResolvedHistoricalDiagnostic(entry))
  }

  clear(): void {
    this.ensureLoaded()
    this.entries = []
    this.persist()
  }

  remove(ids: readonly string[]): void {
    this.ensureLoaded()
    if (!ids.length) return
    const selected = new Set(ids)
    this.entries = this.entries.filter((entry) => !selected.has(entry.id))
    this.persist()
  }

  /**
   * Render the full log into a single copyable report. This is what the user
   * pastes back so the exact unhandled shapes can be fixed — it's deliberately
   * verbose: environment header + one block per entry with code, impact, and the
   * raw JSON sample.
   */
  formatReport(ids?: readonly string[]): string {
    this.ensureLoaded()
    const selected = ids ? new Set(ids) : undefined
    const entries = this.entries.filter((entry) =>
      !isResolvedHistoricalDiagnostic(entry) && (!selected || selected.has(entry.id))
    )
    const lines: string[] = []
    const categories = new Set(entries.map((entry) => entry.category))
    lines.push(categories.size === 1
      ? `# UniAgent ${categories.has('session_import') ? 'Session 导入错误' : 'App 运行错误日志'}`
      : '# UniAgent 诊断与日志报告')
    lines.push(`生成时间: ${new Date().toISOString()}`)
    lines.push(`条目数: ${entries.length}`)
    lines.push(`运行环境: ${runtimeDescription()}`)
    lines.push('说明: 以下是 UniAgent 收集的错误与警告。请将本报告整段发回以便排查。')
    lines.push('')
    if (entries.length === 0) {
      lines.push('(暂无诊断记录 — 目前没有遇到未处理的数据。)')
      return lines.join('\n')
    }
    entries.forEach((e, i) => {
      lines.push(`## [${i + 1}] ${e.level.toUpperCase()} · ${e.code}${e.count > 1 ? ` ×${e.count}` : ''}`)
      lines.push(`- agent: ${e.agentId}`)
      lines.push(`- category: ${e.category}`)
      lines.push(`- source: ${e.source}`)
      if (e.sessionId) lines.push(`- session: ${e.sessionId}`)
      if (e.field) lines.push(`- field: ${e.field}`)
      lines.push(`- time: ${new Date(e.ts).toISOString()}`)
      lines.push(`- 描述: ${redactDiagnosticText(e.message)}`)
      if (e.sample) {
        lines.push('- 原始样本:')
        lines.push('```json')
        lines.push(redactDiagnosticText(e.sample))
        lines.push('```')
      }
      lines.push('')
    })
    return lines.join('\n')
  }
}

export function codexSourceRuntimeDiagnostic(issue: CodexSourceRuntimeIssue | CodexSourceServiceRuntimeIssue): DiagnosticInput {
  const modelIssue = 'sourceId' in issue
  return {
    category: 'app_runtime',
    level: 'error',
    source: 'codex-sources',
    agentId: 'codex',
    code: issue.code,
    ...(modelIssue ? { field: `${issue.sourceId}:${issue.model}` } : {}),
    message: modelIssue ? `${CODEX_SOURCE_NAMES[issue.sourceId]} ${issue.model}：${issue.message}` : issue.message,
    sample: runtimeDiagnosticSample(issue.error || issue.message, {
      ...(modelIssue ? { sourceId: issue.sourceId, model: issue.model } : {}),
      stage: issue.stage,
      ...(modelIssue && issue.statusCode !== undefined ? { statusCode: issue.statusCode } : {}),
      occurredAt: issue.occurredAt
    })
  }
}

function runtimeDescription(): string {
  const versions = [`Node ${process.versions.node}`]
  if (process.versions.electron) versions.push(`Electron ${process.versions.electron}`)
  if (process.versions.chrome) versions.push(`Chromium ${process.versions.chrome}`)
  return `${process.platform} ${process.arch}; ${versions.join('; ')}`
}

/** Preserve actionable error fields that JSON.stringify(Error) normally drops. */
export function runtimeDiagnosticSample(
  error: unknown,
  context?: Record<string, unknown>
): Record<string, unknown> {
  return {
    error: normalizeDiagnosticValue(error),
    ...(context ? { context: normalizeDiagnosticValue(context) } : {}),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      chrome: process.versions.chrome
    }
  }
}

function normalizeDiagnosticValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === 'string' ||
      typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  if (depth >= 4) return `[${Array.isArray(value) ? 'array' : 'object'}]`
  seen.add(value)

  if (value instanceof Error) {
    const extended = value as Error & Record<string, unknown>
    const result: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack
    }
    for (const key of ['code', 'errno', 'syscall', 'path']) {
      if (extended[key] !== undefined) result[key] = normalizeDiagnosticValue(extended[key], depth + 1, seen)
    }
    if (value.cause !== undefined) result.cause = normalizeDiagnosticValue(value.cause, depth + 1, seen)
    return result
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => normalizeDiagnosticValue(item, depth + 1, seen))
  }

  return Object.fromEntries(
    Object.entries(value).slice(0, 30)
      .map(([key, item]) => [key, normalizeDiagnosticValue(item, depth + 1, seen)])
  )
}

function trimSample(sample: unknown): string {
  let s: string
  try {
    s = typeof sample === 'string' ? sample : JSON.stringify(sample)
  } catch {
    s = String(sample)
  }
  return trimText(s)
}

function trimText(value: string): string {
  if (value.length <= SAMPLE_CAP) return value
  const suffix = `… (+${value.length - SAMPLE_CAP} chars)`
  return value.slice(0, SAMPLE_CAP - suffix.length) + suffix
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|app[_-]?secret|api[_-]?key|password|passwd)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[redacted]'
    )
}

/**
 * Process-wide singleton so the history parser (which doesn't hold a reference
 * to any store) can report gaps from anywhere, and main/index.ts can subscribe
 * to fan diagnostics out to the renderer.
 */
export const diagnostics = new DiagnosticsStore()
