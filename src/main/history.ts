import { readFile, readdir, stat, open, writeFile, mkdir, appendFile, cp, rename, unlink } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { AgentDef, HistoryForkPoint, SessionSummary, UAEvent, UASubAgent } from '../shared/types'
import { deriveSessionTitle, isCrossForkSourceAgent, isCrossForkTargetAgent } from '../shared/types'
import { resolveAgentModel } from '../shared/agentChoices'
import { isAsyncQuestion } from '../shared/interactionRequests'
import { diagnostics } from './diagnostics'
import { historyModelEvidenceOf, normalizeServerModelNotification, restoredMaxMode } from './maxMode'
import { ContextCompactionHistory } from './contextCompactionHistory'
import {
  finalizeHistoricalSubAgent,
  historicalTimestamp,
  isSubAgentTerminal,
  nativeSubAgentName,
  readableSubAgentInput,
  subAgentDisplayName,
  reduceHistoricalSubAgent,
  SubAgentDispatchTracker
} from '../shared/subAgentLifecycle'
import {
  listGrokSessions,
  listMCodeSessions,
  loadMCodeSessionEvents,
  loadGrokSessionEvents,
  loadKimiSessionEvents
} from './acp/acpRunner'
import { listKimiWebSessions as listKimiSessions } from './kimiHistory.ts'
import { readHistoryFile, trackHistoryWork, type HistoryProgressCallback } from './historyProgress'
import { claudeFileChange } from './claudeFileChanges'
import { updateClaudeTaskPlan } from './claudeTaskPlan'
import { filesFromTurnChanges } from './turnFileChanges'
import { loadDeepSeekHostHistory, listDeepSeekHostSessions } from './deepseekHostHistory.ts'
import { mcodeRuntimeEnv } from './mcodeService.ts'

/**
 * History scanning + replay (Doc2 需求 3.2). Reads each CLI's native session
 * store and normalizes it into UniAgent's models:
 *  - `listAgentHistory` -> SessionSummary[] for the resume panel.
 *  - `loadSessionEvents` -> UAEvent[] for one-shot replay into EventStream.
 *
 * Codex / TraeX share a JSONL rollout schema; Claude uses its own project
 * jsonl. All mapping mirrors the live adapters so replayed history renders
 * identically to a fresh turn.
 *
 * 跨 Agent 迁移诊断: this is also the READ side of cross-agent session migration
 * — the normalized UAEvent[] here is what a native-session transplant would feed
 * to the target agent. So this is where "unhandled new data" first surfaces: a
 * record type / payload type / content block we've never seen, or a line that
 * fails to parse. Rather than silently dropping it (which quietly degrades the
 * transplant), we report it to the diagnostics store with a raw sample. The
 * KNOWN_* sets below are populated from real on-disk sessions so today's data is
 * silent — only genuinely NEW shapes trigger a diagnostic.
 */

// Exported so the native Token-usage collector (nativeTokenUsage.ts) scans the
// exact same on-disk session stores this module already treats as the source of
// truth — one definition of "where each agent keeps its history".
export const CODEX_DIR = join(homedir(), '.codex')
export const TRAE_DIR = join(homedir(), '.trae/cli')
export const CLAUDE_PROJECTS = join(homedir(), '.claude/projects')
const PORTABLE_IMAGE_TOOL = 'uniagent_image_history'

// ---- 跨 Agent 迁移诊断: known-shape allowlists ----
// Codex/TraeX rollout top-level record types we recognize (handled OR knowingly
// skipped). Anything outside this set is genuinely new → worth a diagnostic.
const KNOWN_ROLLOUT_RECORDS = new Set([
  'session_meta',
  'turn_context',
  'event_msg',
  'response_item',
  'world_state',
  'compacted',
  'history_mutation',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
  'token_usage_record'
])
// event_msg payload types we recognize. Handled ones drive replay; the rest are
// intentionally skipped but known (task lifecycle, settings, telemetry…).
const KNOWN_EVENT_MSG_TYPES = new Set([
  // handled
  'user_message',
  'agent_message',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'exec_command_end',
  'image_generation_end',
  'patch_apply_end',
  'mcp_tool_call_end',
  'token_count',
  'task_complete',
  'plan_update',
  // known-but-skipped
  'task_started',
  'item_completed',
  'turn_aborted',
  'thread_goal_updated',
  'thread_settings_applied',
  'context_compacted',
  'model_rerouted',
  'model_fallback',
  'model_verification',
  'sub_agent_activity',
  'terminal_interaction',
  'collab_waiting_end',
  'collab_close_end',
  'collab_agent_spawn_end',
  'collab_agent_interaction_end',
  'thread_rolled_back',
  'web_search_end',
  'mode_change_response'
])
// Claude project-jsonl record types we recognize.
const KNOWN_CLAUDE_RECORDS = new Set([
  'user',
  'assistant',
  'summary',
  'system',
  'queue-operation',
  'attachment',
  'last-prompt',
  'file-history-snapshot'
])
// Claude message content block types we recognize.
const KNOWN_CLAUDE_BLOCKS = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'tool_result',
  'image'
])

// Extract the session uuid from a rollout filename: rollout-<localTs>-<uuid>.jsonl.
// The trailing 8-4-4-4-12 hex uuid is stable across CLI versions; the leading
// timestamp fragment is ignored. (Same id embedded in session_meta.payload.id.)
const ROLLOUT_ID_RE =
  /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * 需求(历史会话只显示零星几个): a title/meta cache keyed by file path, validated by
 * (mtimeMs, size). The head-read + JSON parse of a rollout is the expensive part;
 * re-listing the panel only re-reads files whose mtime/size changed. Cheap to keep
 * in-process for the app's lifetime (a few hundred entries per agent).
 */
interface RolloutMeta {
  id: string
  title: string
  firstUserMessage?: string
  cwd?: string
  /**
   * 需求1 — true when this rollout is a spawned SUB-agent's own session (a child
   * thread), identified from its `session_meta`: codex/traex stamp child rollouts
   * with `payload.source.subagent` (a `{thread_spawn:{parent_thread_id,…}}` or
   * `{other}` marker) and/or a top-level `payload.parent_thread_id`. These are the
   * "零星几个 + 污染" entries the user saw — they belong to the sub-agent panel,
   * not the top-level history list, so listCodexLike filters them out.
   */
  isSubAgent?: boolean
  /**
   * 需求1 — true when we found at least one genuine (non-synthetic) user OR
   * assistant message in the head scan. Sessions with none are empty shells
   * (aborted before any real turn / pure injected-context) and are hidden.
   */
  hasContent?: boolean
  /** Native Codex fork lineage; inherited parent content makes an empty shell importable. */
  historyBaseId?: string
  /**
   * 需求6 — true when this rollout was produced BY UniAgent itself (not by an
   * independent CLI/TUI run). Three cases, all read from session_meta.payload:
   *  - `originator === 'uniagent'` — created directly inside UniAgent.
   *  - `forked_from` present — a same-agent 分叉 copy minted in UniAgent.
   *  - `uniagent_transplant === true` — a cross-agent 搬运 landed by UniAgent
   *    (whose originator is faked to 'codex-tui' so it can be resumed, so this
   *    dedicated marker is the only reliable signal).
   * The 导入会话 list hides these so the user only sees sessions produced
   * independently in other agents.
   */
  isUniAgentOrigin?: boolean
}
const titleCache = new Map<string, { mtimeMs: number; size: number; meta: RolloutMeta }>()

/**
 * 需求(历史会话只显示零星几个) — list a codex/traex agent's history by scanning the
 * rollout files on disk, NOT the sparse `session_index.jsonl` (which only a few
 * entry points write, so TUI/exec-created sessions were invisible). Every entry
 * point writes a rollout-*.jsonl under the nested `sessions` tree (and closed
 * ones move to `archived_sessions/`), so this is the complete, single source of
 * truth — the same files `findRollout()` / `loadSessionEvents()` resolve by id.
 *
 * Each file = one session. We take updatedAt from the file mtime (last activity,
 * for sorting), and bounded-head-read the file to derive the id / cwd / first
 * real user message as the title. Results are (mtime,size)-cached and capped so
 * opening the panel stays responsive even with ~1k rollouts.
 */
async function listCodexLike(
  agentId: string,
  baseDir: string,
  limit = 400
): Promise<SessionSummary[]> {
  // Codex keeps user-facing generated / renamed titles in this append-only index.
  // Rollouts remain the source of truth for existence because the index is sparse;
  // a missing index row therefore falls back to the rollout's first user message.
  const indexedTitles = agentId === 'codex'
    ? await readSessionIndexTitles(join(baseDir, 'session_index.jsonl'))
    : new Map<string, string>()
  const roots = ['sessions', 'archived_sessions'].map((s) => join(baseDir, s))
  const files: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    await collectRolloutFiles(root, files)
  }
  // Stat everything first so we can sort by recency and only head-read the newest
  // `limit` files (the head-read + parse is the costly part).
  const stated: { file: string; mtimeMs: number; size: number }[] = []
  for (const file of files) {
    try {
      const st = await stat(file)
      stated.push({ file, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const slice = stated.slice(0, limit)
  const rolloutIds = new Set(
    stated.map(({ file }) => file.match(ROLLOUT_ID_RE)?.[1]).filter((id): id is string => !!id)
  )

  const out: SessionSummary[] = []
  const seen = new Set<string>()
  for (const { file, mtimeMs, size } of slice) {
    let meta: RolloutMeta
    const cached = titleCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      meta = cached.meta
    } else {
      meta = await parseRolloutHead(file)
      titleCache.set(file, { mtimeMs, size, meta })
    }
    if (!meta.id || seen.has(meta.id)) continue
    // 需求1 — treat the disk as the source of truth but hide the two kinds of
    // "污染" the user saw in the history list: (a) spawned sub-agent child
    // rollouts (they live in the sub-agent panel, not top-level history), and
    // (b) empty shells with neither local content nor a resolvable inherited
    // history base. Both are cheap to detect from metadata already collected.
    if (meta.isSubAgent) continue
    if (!meta.hasContent && (!meta.historyBaseId || !rolloutIds.has(meta.historyBaseId))) continue
    // 需求6 — hide sessions UniAgent produced itself (direct create / same-agent
    // 分叉 / cross-agent 搬运). The 导入会话 list should only surface sessions born
    // independently in other agents' native CLI/TUI.
    if (meta.isUniAgentOrigin) continue
    seen.add(meta.id)
    out.push({
      id: meta.id,
      title: indexedTitles.get(meta.id) || meta.title || '(未命名会话)',
      firstUserMessage: meta.firstUserMessage,
      cwd: meta.cwd,
      updatedAt: mtimeMs,
      agentId
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** Latest valid thread_name wins because Codex appends rename records per id. */
async function readSessionIndexTitles(file: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (!existsSync(file)) return titles
  try {
    const lines = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      try {
        const record = JSON.parse(line)
        const id = typeof record?.id === 'string' ? record.id.trim() : ''
        const title = typeof record?.thread_name === 'string' ? record.thread_name.trim() : ''
        if (id && title) titles.set(id, title)
      } catch {
        /* tolerate a partial append or legacy malformed row */
      }
    }
  } catch {
    /* unavailable index — rollout-derived titles remain usable */
  }
  return titles
}

/** Recursively collect every `rollout-*.jsonl` under a root (sessions is nested YYYY/MM/DD; archived_sessions is flat). */
export async function collectRolloutFiles(dir: string, out: string[]): Promise<void> {
  let entries: { name: string; isDir: boolean }[] = []
  try {
    entries = (await readdir(dir, { withFileTypes: true })).map((d) => ({
      name: d.name,
      isDir: d.isDirectory()
    }))
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDir) {
      await collectRolloutFiles(full, out)
    } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      out.push(full)
    }
  }
}

/**
 * Bounded head-read of a rollout to derive its id / cwd / title. Streams the file
 * line-by-line and stops as soon as id + cwd + title are resolved, capped at a
 * generous byte budget. The title is the first real user message; injected /
 * system prefixes (AGENTS.md, <...> tags, skills/multi-agent context, world_state)
 * are skipped. Falls back to the filename-embedded uuid for the id.
 *
 * NOTE: a fixed 64KB head is NOT enough — the harness injects large developer /
 * user context blobs (skills_instructions, AGENTS.md, recommended_plugins,
 * world_state), each tens of KB, BEFORE the real first user message, which can
 * therefore sit ~100KB+ into the file. We read up to `MAX_TITLE_SCAN_BYTES` so
 * the genuine first user line is reached.
 */
const MAX_TITLE_SCAN_BYTES = 2 * 1024 * 1024

async function parseRolloutHead(file: string): Promise<RolloutMeta> {
  const fnameId = file.match(ROLLOUT_ID_RE)?.[1]
  let id = fnameId || ''
  let cwd: string | undefined
  let title = ''
  let firstUserMessage: string | undefined
  let isSubAgent = false
  let hasContent = false
  let isUniAgentOrigin = false
  let historyBaseId: string | undefined
  try {
    await forEachHeadLine(file, MAX_TITLE_SCAN_BYTES, (line) => {
      let o: any
      try {
        o = JSON.parse(line)
      } catch {
        return true // keep scanning
      }
      if (o.type === 'session_meta') {
        const p = o.payload || {}
        if (!id && (p.id || p.session_id)) id = p.id || p.session_id
        if (!cwd && p.cwd) cwd = p.cwd
        const inheritedId = p.history_base?.thread_id
        if (typeof inheritedId === 'string' && inheritedId.trim()) {
          historyBaseId = inheritedId.trim()
        }
        // 需求1 — child rollout marker: a spawned sub-agent stamps its
        // session_meta with a parent_thread_id and/or a source.subagent block.
        if (p.parent_thread_id || p.source?.subagent) {
          isSubAgent = true
        }
        // 需求6 — UniAgent-produced markers: direct create (originator), same-agent
        // fork (forked_from), or cross-agent transplant (dedicated flag, since its
        // originator is faked to 'codex-tui' to remain resumable).
        if (p.originator === 'uniagent' || p.forked_from || p.uniagent_transplant === true) {
          isUniAgentOrigin = true
        }
        // 需求2（侧边对话 /side）— defense-in-depth: an explicitly ephemeral or
        // side-sourced branch is not meant to surface in history. Do NOT treat
        // `forked_from_id` alone as ephemeral: Codex Desktop writes that marker
        // for normal user-visible forks, which must remain independently importable.
        if (p.ephemeral === true || p.source === 'side') {
          isSubAgent = true
        }
        return true
      }
      // 需求1 — record whether we've seen any real conversational content (a
      // genuine user OR assistant message), so empty shells can be filtered.
      if (!hasContent && rolloutHasContent(o)) hasContent = true
      if (!title) {
        const t = rolloutUserText(o)
        if (t) {
          firstUserMessage = t
          title = t.slice(0, 60)
        }
      }
      // Stop once we have BOTH a title and confirmed content (id + sub-agent
      // marker come from the early session_meta); keep scanning otherwise so a
      // late first user message / assistant-only session is still detected.
      return !(title && hasContent)
    })
  } catch {
    /* unreadable — return whatever we resolved (at least the filename id) */
  }
  return {
    id,
    title,
    firstUserMessage,
    cwd,
    isSubAgent,
    hasContent,
    isUniAgentOrigin,
    historyBaseId
  }
}

/**
 * 需求1 — does this rollout record carry genuine conversational content (a real
 * user OR an assistant message)? Used to hide empty-shell sessions (aborted
 * before any turn / pure injected context) from the history list. Mirrors the
 * shapes rolloutUserText handles, plus assistant replies (event_msg
 * agent_message / response_item assistant message).
 */
function rolloutHasContent(o: any): boolean {
  if (rolloutUserText(o)) return true
  if (o.type === 'event_msg' && o.payload?.type === 'agent_message') {
    return typeof o.payload.message === 'string' && o.payload.message.trim() !== ''
  }
  if (
    o.type === 'response_item' &&
    o.payload?.type === 'message' &&
    o.payload.role === 'assistant'
  ) {
    return collectResponseText(o.payload.content).trim() !== ''
  }
  return false
}

/**
 * Stream a file line-by-line up to `maxBytes`, invoking `onLine` for each
 * complete line. `onLine` returns false to stop early (title found). Reads in
 * 128KB chunks so large rollouts aren't fully loaded into memory.
 */
async function forEachHeadLine(
  file: string,
  maxBytes: number,
  onLine: (line: string) => boolean
): Promise<void> {
  const fh = await open(file, 'r')
  try {
    const chunk = Buffer.alloc(128 * 1024)
    let carry = ''
    let read = 0
    let pos = 0
    while (read < maxBytes) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos)
      if (bytesRead <= 0) break
      pos += bytesRead
      read += bytesRead
      carry += chunk.slice(0, bytesRead).toString('utf8')
      let nl: number
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl)
        carry = carry.slice(nl + 1)
        if (line.trim() && !onLine(line)) return
      }
    }
    if (carry.trim()) onLine(carry)
  } finally {
    await fh.close()
  }
}

/**
 * Extract a real (non-synthetic) first user message from one rollout record, for
 * titling. Handles the three shapes a user turn takes across CLI versions:
 *  - event_msg { type:'user_message', message }
 *  - response_item { type:'message', role:'user', content:[{input_text}] }
 *  - history_mutation carrying a role:'user' item with input_text
 * Returns '' for anything that isn't a genuine user line (or is injected context).
 */
function rolloutUserText(o: any): string {
  if (o.type === 'event_msg' && o.payload?.type === 'user_message') {
    const m = o.payload.message
    if (typeof m === 'string' && m.trim() && !isSyntheticUserText(m)) return m.trim()
    return ''
  }
  if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') {
    const t = collectResponseText(o.payload.content)
    if (t && !isSyntheticUserText(t)) return t
    return ''
  }
  if (o.type === 'history_mutation') {
    // history_mutation payloads carry added items; scan for a user message.
    const p = o.payload || {}
    const items: any[] = p.items || p.added || p.messages || []
    for (const it of Array.isArray(items) ? items : []) {
      if (it?.role === 'user' || it?.type === 'message') {
        const t = collectResponseText(it.content)
        if (t && !isSyntheticUserText(t)) return t
      }
    }
  }
  return ''
}

function rolloutGoal(o: any): { id: string; text: string } | undefined {
  if (o?.type !== 'history_mutation' || o.payload?.operation !== 'append') return undefined
  const items: any[] = o.payload?.items || o.payload?.added || o.payload?.messages || []
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type !== 'message' || item?.role !== 'user') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) continue
    const text = collectResponseText(item.content)
    if (!/^\s*<command-name>\s*\/goal\s*<\/command-name>/i.test(text)) continue
    const objective = text.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1]?.trim()
    if (objective) return { id, text: objective }
  }
  return undefined
}

/**
 * Claude writes harness-only records into its project transcript: the /compact
 * summary plus continuation prompt (`isCompactSummary`, transcript-only) and
 * meta notes such as image-size annotations (`isMeta`). They are the model's
 * bookkeeping, never the user's words — neither replay nor a session title may
 * surface them.
 */
function isClaudeInternalUserRecord(record: any): boolean {
  return record?.isCompactSummary === true || record?.isVisibleInTranscriptOnly === true || record?.isMeta === true
}

/** Scan Claude's project dirs for session jsonl files. */
async function listClaude(): Promise<SessionSummary[]> {
  if (!existsSync(CLAUDE_PROJECTS)) return []
  let projects: string[] = []
  try {
    projects = await readdir(CLAUDE_PROJECTS)
  } catch {
    return []
  }
  const out: SessionSummary[] = []
  for (const proj of projects) {
    const dir = join(CLAUDE_PROJECTS, proj)
    let files: string[] = []
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const full = join(dir, file)
      const id = file.replace(/\.jsonl$/, '')
      let updatedAt = 0
      let title = ''
      let cwd: string | undefined
      try {
        const st = await stat(full)
        updatedAt = st.mtimeMs
      } catch {
        /* ignore */
      }
      try {
        const head = await readHead(full, 64 * 1024)
        for (const line of head.split('\n')) {
          if (!line.trim()) continue
          let o: any
          try {
            o = JSON.parse(line)
          } catch {
            continue
          }
          if (!cwd && o.cwd) cwd = o.cwd
          if (!title && o.type === 'user' && !isClaudeInternalUserRecord(o)) {
            const c = o.message?.content
            const t = typeof c === 'string' ? c : Array.isArray(c) ? textFromBlocks(c) : ''
            if (t && !t.startsWith('<')) title = t.slice(0, 60)
          }
          if (cwd && title) break
        }
      } catch {
        /* ignore */
      }
      out.push({ id, title: title || '(Claude 会话)', cwd, updatedAt, agentId: 'claude' })
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

export async function listAgentHistory(agentId: string, agentBin?: string): Promise<SessionSummary[]> {
  if (agentId === 'deepseek') {
    if (!agentBin) throw new Error('DeepSeek 历史需要已检测的可执行文件')
    return listDeepSeekHostSessions()
  }
  if (agentId === 'codex') return listCodexLike('codex', CODEX_DIR)
  if (agentId === 'traex') return listCodexLike('traex', TRAE_DIR)
  if (agentId === 'claude') return listClaude()
  if (agentId === 'kimi') {
    if (!agentBin) throw new Error('Kimi 历史需要已检测的可执行文件')
    return listKimiSessions(agentBin)
  }
  if (agentId === 'grok') {
    if (!agentBin) throw new Error('Grok 历史需要已检测到的 ACP 可执行文件')
    return listGrokSessions(agentBin)
  }
  if (agentId === 'mcode') {
    if (!agentBin) throw new Error('MiniMax Code 历史需要已检测到的 ACP 可执行文件')
    return listMCodeSessions(agentBin, undefined, mcodeRuntimeEnv())
  }
  return []
}

/** Find a codex/traex rollout file whose name ends with the session id suffix. */
async function findRollout(baseDir: string, id: string): Promise<string | null> {
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = join(baseDir, sub)
    if (!existsSync(root)) continue
    const hit = await walkFind(root, id)
    if (hit) return hit
  }
  return null
}

/** Resolve the exact file-backed native Session used by replay and occupancy checks. */
export async function resolveNativeSessionFile(agentId: string, id: string): Promise<string | null> {
  if (agentId === 'codex') return findRollout(CODEX_DIR, id)
  if (agentId === 'traex') return findRollout(TRAE_DIR, id)
  return null
}

/** Repair UniAgent transplants before native resume rebuilds the model context. */
export async function repairTransplantedSessionHistory(agentId: string, id: string): Promise<boolean> {
  const file = await resolveNativeSessionFile(agentId, id)
  if (!file) return false
  let repairableHeader = false
  await forEachHeadLine(file, MAX_TITLE_SCAN_BYTES, (line) => {
    try {
      const record = JSON.parse(line)
      repairableHeader = record?.type === 'session_meta' &&
        record.payload?.uniagent_transplant === true
    } catch {
      repairableHeader = false
    }
    return false
  })
  if (!repairableHeader) return false

  const text = await readFile(file, 'utf8')
  const lines = text.split('\n')
  const records: Record<string, any>[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return false
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false
    records.push(record as Record<string, any>)
  }
  if (!records.length) return false

  const repairOrdinals = records.every((record) => !Object.hasOwn(record, 'ordinal'))
  let changed = false

  let next = 0
  const repaired = lines.map((line) => {
    if (!line.trim()) return line
    const record = records[next++]
    let recordChanged = false
    if (repairOrdinals) {
      record.ordinal = next - 1
      recordChanged = true
    }
    const payload = record.payload
    if (record.type === 'response_item' &&
        (payload?.type === 'function_call' || payload?.type === 'function_call_output') &&
        typeof payload.call_id === 'string' && payload.call_id.length > 64) {
      payload.call_id = codexCallId(payload.call_id)
      recordChanged = true
    }
    changed ||= recordChanged
    return recordChanged ? JSON.stringify(record) : line
  }).join('\n')
  if (!changed) return false
  const temp = `${file}.transplant-repair-${process.pid}-${randomUUID()}.tmp`
  try {
    const mode = (await stat(file)).mode & 0o777
    await writeFile(temp, repaired, { encoding: 'utf8', mode })
    await rename(temp, file)
  } finally {
    await unlink(temp).catch(() => {})
  }
  return true
}

/** Resolve a set of rollout ids with one directory walk. */
async function findRollouts(baseDir: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const remaining = new Set(ids)
  const found = new Map<string, string>()
  if (!remaining.size) return found
  const files: string[] = []
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = join(baseDir, sub)
    if (existsSync(root)) await collectRolloutFiles(root, files)
  }
  for (const file of files) {
    for (const id of remaining) {
      if (!file.endsWith(`-${id}.jsonl`)) continue
      found.set(id, file)
      remaining.delete(id)
      break
    }
    if (!remaining.size) break
  }
  return found
}

/**
 * First terminal turn boundary at/after a dispatch in one child rollout. The
 * same thread can be resumed much later, so the rollout's global EOF is not a
 * valid bound for an earlier generation.
 */
export async function rolloutGenerationEndTimestamp(
  file: string,
  startedAt: number | undefined
): Promise<number | undefined> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let historyStartOrdinal: number | undefined
  let sawMetadata = false
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (record.type === 'session_meta' && !sawMetadata) {
          sawMetadata = true
          historyStartOrdinal = subAgentHistoryStartOrdinal(record)
        }
        if (historyStartOrdinal !== undefined && record.ordinal < historyStartOrdinal) continue
        const timestamp = historicalTimestamp(record.timestamp)
        if (timestamp === undefined || (startedAt !== undefined && timestamp < startedAt)) continue
        const payload = record.payload || {}
        if (record.type === 'event_msg' && (
          payload.type === 'task_complete' ||
          payload.type === 'turn_aborted' ||
          payload.phase === 'final_answer'
        )) return timestamp
      } catch {
        // A malformed child line cannot invalidate the surrounding valid timestamps.
      }
    }
  } catch {
    return undefined
  } finally {
    lines.close()
    input.destroy()
  }
  return undefined
}

async function walkFind(dir: string, id: string): Promise<string | null> {
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  // archived_sessions is flat; sessions is YYYY/MM/DD nested. The rollout file
  // name embeds the session id as its suffix: rollout-<ts>-<id>.jsonl.
  const suffix = '-' + id + '.jsonl'
  for (const name of entries) {
    if (name.endsWith(suffix)) return join(dir, name)
  }
  for (const name of entries) {
    if (name.endsWith('.jsonl')) continue
    const full = join(dir, name)
    try {
      const st = await stat(full)
      if (st.isDirectory()) {
        const hit = await walkFind(full, id)
        if (hit) return hit
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Parse a session (rollout / project jsonl) into replayable UAEvents.
 * Returns { events, cwd, model, effort } so the caller can restore config.
 */
export async function loadSessionEvents(
  agentId: string,
  id: string,
  agentBin?: string,
  cwd?: string,
  onProgress?: HistoryProgressCallback
): Promise<{ events: UAEvent[]; cwd?: string; model?: string; effort?: string; maxMode?: boolean; contextWindow?: number }> {
  onProgress?.({ phase: 'locating' })
  if (agentId === 'deepseek') {
    if (!agentBin) throw new Error('DeepSeek 历史需要已检测的可执行文件')
    return loadDeepSeekHostHistory(id)
  }
  if (agentId === 'claude') return loadClaudeEvents(id, onProgress)
  if (agentId === 'kimi') {
    if (!agentBin) throw new Error('Kimi 历史需要已检测的可执行文件')
    return loadKimiSessionEvents(id, agentBin, cwd)
  }
  if (agentId === 'grok') {
    if (!agentBin) throw new Error('Grok 历史需要已检测到的 ACP 可执行文件')
    onProgress?.({ phase: 'replaying' })
    return loadGrokSessionEvents(id, agentBin, cwd)
  }
  if (agentId === 'mcode') {
    if (!agentBin) throw new Error('MiniMax Code 历史需要已检测到的 ACP 可执行文件')
    onProgress?.({ phase: 'replaying' })
    return loadMCodeSessionEvents(id, agentBin, cwd, mcodeRuntimeEnv())
  }
  if (agentId !== 'codex' && agentId !== 'traex') return { events: [] }
  const baseDir = agentId === 'traex' ? TRAE_DIR : CODEX_DIR
  const file = await resolveNativeSessionFile(agentId, id)
  if (!file) return { events: [] }
  const replayText = await readCodexLikeReplayText(baseDir, file, undefined, new Set(), onProgress)
  return loadCodexLikeEvents(file, agentId, id, resolveNativeChildRolloutEnds, replayText, onProgress)
}

interface HistoryBasePointer {
  threadId: string
  endByteOffset?: number
  endOrdinalExclusive?: number
}

/**
 * Codex paginated forks persist only branch-local records and point at the
 * inherited parent prefix through session_meta.history_base. Rebuild that chain
 * before replay so empty forks and continued forks expose the same conversation
 * the Codex app shows. Each parent prefix is bounded by the recorded byte/ordinal
 * cutoff, so later turns added to the parent never leak into an older fork.
 */
async function readCodexLikeReplayText(
  baseDir: string,
  file: string,
  limit?: Omit<HistoryBasePointer, 'threadId'>,
  visited = new Set<string>(),
  onProgress?: HistoryProgressCallback
): Promise<string> {
  if (visited.has(file)) return ''
  const nextVisited = new Set(visited)
  nextVisited.add(file)

  const raw = await readHistoryFile(file, onProgress, visited.size ? 'reading-parent' : 'reading')
  const current = sliceRolloutHistory(raw, limit)
  const base = historyBasePointer(current)
  if (!base) return current

  onProgress?.({ phase: 'locating' })
  const parent = await findRollout(baseDir, base.threadId)
  if (!parent) return current
  const inherited = await readCodexLikeReplayText(
    baseDir,
    parent,
    {
      endByteOffset: base.endByteOffset,
      endOrdinalExclusive: base.endOrdinalExclusive
    },
    nextVisited,
    onProgress
  )
  return inherited ? `${inherited.trimEnd()}\n${current}` : current
}

function historyBasePointer(text: string): HistoryBasePointer | undefined {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.type !== 'session_meta') continue
    const base = record.payload?.history_base
    const threadId = typeof base?.thread_id === 'string' ? base.thread_id.trim() : ''
    if (!threadId) return undefined
    return {
      threadId,
      endByteOffset: finiteNonNegative(base.end_byte_offset),
      endOrdinalExclusive: finiteNonNegative(base.end_ordinal_exclusive)
    }
  }
  return undefined
}

function sliceRolloutHistory(
  raw: Buffer,
  limit?: Omit<HistoryBasePointer, 'threadId'>
): string {
  if (limit?.endByteOffset !== undefined) {
    return raw.subarray(0, Math.min(raw.length, limit.endByteOffset)).toString('utf8')
  }
  const text = raw.toString('utf8')
  if (limit?.endOrdinalExclusive === undefined) return text
  return text
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false
      try {
        const ordinal = JSON.parse(line)?.ordinal
        return typeof ordinal !== 'number' || ordinal < limit.endOrdinalExclusive!
      } catch {
        return true
      }
    })
    .join('\n')
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function subAgentHistoryStartOrdinal(record: any): number | undefined {
  const meta = record?.type === 'session_meta' ? record.payload : undefined
  const ordinal = meta?.subagent_history_start_ordinal
  const child = meta?.thread_source === 'subagent' || meta?.source?.subagent?.thread_spawn
  return child && Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : undefined
}

/** Keep a child's own records; ordinary forks still replay their inherited history. */
async function ownSubAgentReplayText(
  text: string,
  sessionId: string,
  onProgress?: HistoryProgressCallback
): Promise<string> {
  const lines = text.split('\n')
  const progress = trackHistoryWork('scanning', lines.length, onProgress)
  let start: number | undefined
  const retained: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const pending = progress(index)
    if (pending) await pending
    const line = lines[index]
    let record: any
    try { record = JSON.parse(line) } catch {
      if (start !== undefined) retained.push(line)
      continue
    }
    if (start === undefined) {
      if (record.type !== 'session_meta' || (record.payload?.id ?? record.payload?.session_id) !== sessionId) continue
      start = subAgentHistoryStartOrdinal(record)
      if (start === undefined) return text
      retained.push(line)
    } else if (!(record.ordinal < start)) {
      retained.push(line)
    }
  }
  return start === undefined ? text : retained.join('\n')
}

function rolloutAgentCommunication(record: any): {
  id?: string; author: string; recipient: string; kind: string; text: string
} | undefined {
  const native = record?.type === 'response_item' && record.payload?.type === 'agent_message'
  if (!native && record?.type !== 'inter_agent_communication') return undefined
  const p = record.payload || {}
  const text = native
    ? collectResponseText(p.content).replace(/^Message Type:[^\n]*\nTask name:[^\n]*\nSender:[^\n]*\nPayload:\s*/, '').trim()
    : typeof p.content === 'string' ? p.content.trim() : ''
  return {
    id: p.id,
    author: String(p.author || ''),
    recipient: String(p.recipient || ''),
    kind: native ? 'message' : p.kind,
    text: readableSubAgentInput(text) || ''
  }
}

/** Recover opaque child messages only when the parent's confirmed deliveries align. */
async function recoverSubAgentParentMessages(
  text: string,
  agentId: string,
  sessionId: string,
  onProgress?: HistoryProgressCallback
): Promise<Map<number, string>> {
  const recovered = new Map<number, string>()
  if (agentId !== 'codex' && agentId !== 'traex') return recovered
  let header: any
  try { header = JSON.parse(text.trimStart().split('\n', 1)[0]) } catch { return recovered }
  if (header?.type !== 'session_meta' || (header.payload?.id ?? header.payload?.session_id) !== sessionId) return recovered
  const spawn = header.payload.source?.subagent?.thread_spawn
  const parentId = spawn?.parent_thread_id ?? header.payload.parent_thread_id
  const agentPath = header.payload.agent_path ?? spawn?.agent_path
  if (typeof parentId !== 'string' || !parentId || typeof agentPath !== 'string' || !agentPath) return recovered
  const lines = text.split('\n')
  const messages: { index: number; text: string; timestamp?: number }[] = []
  const report = trackHistoryWork('scanning', lines.length, onProgress)
  for (const [index, line] of lines.entries()) {
    const pending = report(index)
    if (pending) await pending
    let record: any
    try { record = JSON.parse(line) } catch { continue }
    const message = rolloutAgentCommunication(record)
    if (message?.recipient === agentPath &&
        message.author === agentPath.slice(0, agentPath.lastIndexOf('/')) &&
        ['new_task', 'followup', 'message'].includes(message.kind)) {
      messages.push({ index, text: message.text, timestamp: historicalTimestamp(record.timestamp) })
    }
  }
  if (!messages.some(message => !message.text)) return recovered
  try {
    const file = await findRollout(agentId === 'codex' ? CODEX_DIR : TRAE_DIR, parentId)
    if (!file) return recovered
    const raw = (await readHistoryFile(file, onProgress, 'reading-parent')).toString('utf8')
    const parentText = await foldRolloutRollbacks(await ownSubAgentReplayText(raw, parentId, onProgress), onProgress)
    const calls = new Map<string, string>()
    const deliveries: { callId: string; timestamp?: number }[] = []
    const parentLines = parentText.split('\n')
    const parentReport = trackHistoryWork('scanning', parentLines.length, onProgress)
    let verifiedParent = false
    for (const [index, line] of parentLines.entries()) {
      const pending = parentReport(index)
      if (pending) await pending
      let record: any
      try { record = JSON.parse(line) } catch { continue }
      const p = record.payload || {}
      if (record.type === 'session_meta' && (p.id ?? p.session_id) === parentId) verifiedParent = true
      if (record.type === 'response_item' && p.type === 'function_call' && p.namespace === 'collaboration' &&
          ['spawn_agent', 'send_message', 'followup_task'].includes(p.name) && typeof p.call_id === 'string') {
        const args = parsePortableToolResult(p.arguments) as { message?: unknown } | undefined
        if (typeof args?.message === 'string' && args.message.trim()) calls.set(p.call_id, args.message.trim())
      }
      const activity = record.type === 'event_msg'
        ? p.type === 'sub_agent_activity' ? p : p.type === 'item_completed' && p.item?.type === 'SubAgentActivity' ? p.item : undefined
        : undefined
      if (activity?.agent_thread_id === sessionId && activity.agent_path === agentPath &&
          ['started', 'interacted'].includes(activity.kind)) {
        deliveries.push({ callId: activity.event_id ?? activity.id, timestamp: historicalTimestamp(record.timestamp) })
      }
    }
    // There is no shared message id in this format. Require the entire ordered
    // delivery sequence, including readable copies, to agree before recovering.
    if (!verifiedParent || deliveries.length !== messages.length || messages.some((message, index) => {
      const delivery = deliveries[index]
      const body = calls.get(delivery.callId)
      return !body || message.text && message.text !== body ||
        message.timestamp !== undefined && delivery.timestamp !== undefined && message.timestamp < delivery.timestamp
    })) return recovered
    messages.forEach((message, index) => {
      const text = readableSubAgentInput(calls.get(deliveries[index].callId))
      if (!message.text && text) recovered.set(message.index, text)
    })
  } catch { /* A missing or growing parent rollout must not hide readable child history. */ }
  return recovered
}

function rolloutTurnId(record: any): string | undefined {
  const id = record?.turn_id ?? record?.payload?.turn_id ??
    record?.payload?.internal_chat_message_metadata_passthrough?.turn_id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

/** Apply native rollback mutations before normalizing the surviving transcript. */
async function foldRolloutRollbacks(text: string, onProgress?: HistoryProgressCallback): Promise<string> {
  const kept: string[] = []
  const turns: { lineIndex: number; turnId?: string }[] = []
  const refreshTurnIds = (turnId: string): void => {
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].turnId) break
      turns[index].turnId = turnId
    }
  }
  const lines = text.split('\n')
  const report = trackHistoryWork('rollbacks', lines.length, onProgress)
  for (let index = 0; index < lines.length; index++) {
    const pending = report(index)
    if (pending) await pending
    const line = lines[index]
    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      kept.push(line)
      continue
    }
    const payload = record?.payload || {}
    const isRollback =
      (record?.type === 'event_msg' && payload.type === 'thread_rolled_back') ||
      (record?.type === 'history_mutation' && payload.operation === 'rollback')
    if (isRollback) {
      const count = payload.num_turns
      const target = typeof payload.target_turn_id === 'string'
        ? payload.target_turn_id.trim()
        : ''
      let turnIndex = -1
      if (Number.isSafeInteger(count) && count > 0) {
        if (target) {
          const candidate = turns.findLastIndex((turn) => turn.turnId === target)
          // Modern records provide both the first discarded turn and a count.
          // Require them to agree; a corrupt/stale target must never fall back
          // to deleting a different valid turn merely because count is present.
          if (candidate >= 0 && turns.length - candidate === count) turnIndex = candidate
        } else if (count <= turns.length) {
          // Legacy Codex has no target id, so count is the only authority. An
          // oversized value is treated as malformed instead of clearing history.
          turnIndex = turns.length - count
        }
      }
      if (turnIndex >= 0) {
        kept.length = turns[turnIndex].lineIndex
        turns.length = turnIndex
      }
      // Rollback records are imperative metadata, not timeline content. Invalid
      // records remain a safe no-op and are still recognized by the allowlists.
      continue
    }
    const lineIndex = kept.length
    kept.push(line)
    const recordTurn = rolloutTurnId(record)
    if (record?.type === 'event_msg' && payload.type === 'task_started') {
      turns.push({
        lineIndex,
        turnId: recordTurn
      })
    } else if (recordTurn) {
      // Some modern app-server task_started rows omit turn_id; the first
      // following history_mutation/response item carries it instead.
      refreshTurnIds(recordTurn)
    }
  }
  await report(lines.length)
  return kept.join('\n')
}

/**
 * Doc2 — cross-agent resume (原生结构全量移植). Transplant a native session from
 * `sourceAgentId` into `targetAgentId`'s own on-disk history, so the target CLI
 * can resume it (`exec resume` / `thread/resume` / `--resume`) with the full
 * prior conversation as context.
 *
 * We deliberately do NOT byte-copy the source rollout — each CLI's native schema
 * differs (codex/traex JSONL rollout vs Claude project jsonl), and a foreign
 * rollout would fail to resume. Instead we go through the SAME normalized
 * UAEvent[] the read side produces (loadSessionEvents), then re-serialize it into
 * the *target* agent's native layout. That makes the transplant lossless w.r.t.
 * the conversation (user/assistant/reasoning + tool/command/file summaries) and
 * resumable natively. Returns the freshly-minted native id + cwd/model so the
 * orchestrator can immediately import & open it.
 */
export async function exportNativeSession(
  sourceAgentId: string,
  nativeId: string,
  targetAgentId: string,
  resolveAgent?: (id: string) => AgentDef | undefined,
  point?: HistoryForkPoint
): Promise<{ nativeId: string; cwd?: string; model?: string } | null> {
  if (resolveAgent) {
    const source = resolveAgent(sourceAgentId)
    const target = resolveAgent(targetAgentId)
    if (!isCrossForkSourceAgent(source) || !isCrossForkTargetAgent(target)) return null
  } else if (!['codex', 'traex', 'claude'].includes(sourceAgentId) ||
      !['codex', 'traex', 'claude'].includes(targetAgentId)) {
    return null
  }
  const source = resolveAgent?.(sourceAgentId)
  if (point && !source) throw new Error('无法确认来源 Agent 的分叉位置，请刷新后重试')
  const { events, cwd, model } = point
    ? await (await import('./historyFork')).loadHistoryAtPoint(source!, nativeId, point)
    : await loadSessionEvents(sourceAgentId, nativeId)
  if (!events.length) {
    diagnostics.record({
      level: 'warn',
      agentId: sourceAgentId,
      sessionId: nativeId,
      code: 'export_empty_source',
      message: `跨 Agent 搬运：源会话没有可回放的事件，无法移植到 ${targetAgentId}。`,
      sample: { sourceAgentId, targetAgentId, nativeId }
    })
    return null
  }
  const workdir = cwd || process.env.HOME || '.'
  const targetModel = sourceAgentId === targetAgentId
    ? model
    : resolveAgentModel(resolveAgent?.(targetAgentId))?.id
  try {
    switch (targetAgentId) {
      case 'claude': {
        const newId = await writeClaudeSession(events, workdir, targetModel)
        return { nativeId: newId, cwd: workdir, model: targetModel }
      }
      case 'traex':
      case 'codex': {
        const baseDir = targetAgentId === 'traex' ? TRAE_DIR : CODEX_DIR
        const newId = await writeCodexLikeSession(baseDir, events, workdir, targetModel, targetAgentId)
        return { nativeId: newId, cwd: workdir, model: targetModel }
      }
      default:
        return null
    }
  } catch (err: any) {
    diagnostics.record({
      level: 'error',
      agentId: targetAgentId,
      sessionId: nativeId,
      code: 'export_write_failed',
      message: `跨 Agent 搬运：写入 ${targetAgentId} 原生会话失败：${err?.message || err}`,
      sample: { sourceAgentId, targetAgentId, nativeId }
    })
    return null
  }
}

/** A short uuid-ish id for a freshly-minted native session (filename + index). */
function newNativeId(): string {
  return randomUUID()
}

/**
 * 需求5（外部会话导入并发治理）— 原Agent分叉：a LOSSLESS same-format fork of a
 * native rollout. We byte-copy the source rollout into a NEW native id under the
 * SAME agent, rewriting only the identity (session_meta.id/session_id + the
 * filename's embedded id) so the fork is an independent, resumable branch that
 * never touches the original file (which a TUI / another window may still own or
 * lock). Because the schema is identical, nothing is normalized away — reasoning
 * `encrypted_content`, tool calls, world_state all survive verbatim, so the
 * branch resumes with the full model context (no 需求7-style loss).
 *
 * Only codex/traex share this rollout schema; Claude uses its own project jsonl,
 * so a Claude "same-agent fork" falls back to the normalized rebuild path.
 * Returns the new native id + cwd/model, or null if the source can't be read.
 */
export async function forkSameSession(
  agentId: string,
  nativeId: string,
  agentBin?: string
): Promise<{ nativeId: string; cwd?: string; model?: string } | null> {
  if (agentId === 'claude') {
    // No shared byte-format — rebuild from normalized events into a fresh Claude id.
    const { events, cwd, model } = await loadSessionEvents(agentId, nativeId)
    if (!events.length) return null
    const newId = await writeClaudeSession(events, cwd || process.env.HOME || '.', model)
    return { nativeId: newId, cwd, model }
  }
  const baseDir = agentId === 'traex' ? TRAE_DIR : CODEX_DIR
  const srcFile = await findRollout(baseDir, nativeId)
  if (!srcFile) {
    diagnostics.record({
      level: 'warn',
      agentId,
      sessionId: nativeId,
      code: 'fork_same_missing',
      message: `原Agent分叉：找不到源 rollout（${nativeId}），无法复制。`,
      sample: { agentId, nativeId }
    })
    return null
  }
  let text = ''
  try {
    text = await readFile(srcFile, 'utf8')
  } catch {
    return null
  }
  const newId = newNativeId()
  const { iso, frag, date } = nowStamp()
  let cwd: string | undefined
  let model: string | undefined
  // Byte-copy every line, rewriting ONLY the session identity so the branch is
  // independent. session_meta carries id/session_id; turn_context carries model;
  // everything else is passed through untouched (lossless).
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      out.push(line) // preserve even unparsable lines verbatim
      continue
    }
    if (o.type === 'session_meta' && o.payload) {
      o.payload = { ...o.payload }
      if (o.payload.id) o.payload.id = newId
      if (o.payload.session_id) o.payload.session_id = newId
      // Mark lineage so a re-scan can tell this branched from another session.
      o.payload.forked_from = nativeId
      cwd = cwd || o.payload.cwd
      model = model || o.payload.model
    }
    if (o.type === 'turn_context' && o.payload) {
      cwd = cwd || o.payload.cwd
      model = model || o.payload.model
    }
    out.push(JSON.stringify(o))
  }
  const dir = join(
    baseDir,
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  )
  await mkdir(dir, { recursive: true })
  const file = join(dir, `rollout-${frag}-${newId}.jsonl`)
  await writeFile(file, out.map((l) => l + '\n').join(''), 'utf8')

  // The .jsonl only *references* images / large tool outputs via
  // `traex-rollout-blob:...` (and tool-results / background-tasks); the bytes
  // live in the sibling `<rollout>.artifacts/` dir. Byte-copying just the jsonl
  // left the fork's blobs unresolvable, so thread/resume's history
  // materialization failed with "No such file". Copy the sidecar too so the
  // fork is genuinely lossless.
  const srcArtifacts = `${srcFile.replace(/\.jsonl$/, '')}.artifacts`
  if (existsSync(srcArtifacts)) {
    try {
      await cp(srcArtifacts, `${file.replace(/\.jsonl$/, '')}.artifacts`, { recursive: true })
    } catch {
      /* best-effort: a fork missing artifacts still resumes for text-only threads */
    }
  }

  const title = deriveSessionTitle(
    (await loadSessionEvents(agentId, newId)).events.find(
      (e) => e.type === 'user_message' || e.type === 'goal_message'
    )?.payload
      ?.text,
    60
  )
  const indexPath = join(baseDir, 'session_index.jsonl')
  try {
    await appendFile(
      indexPath,
      JSON.stringify({ id: newId, thread_name: title || '(分叉会话)', updated_at: iso }) + '\n',
      'utf8'
    )
  } catch {
    /* best-effort index */
  }
  return { nativeId: newId, cwd, model }
}


/** ISO now + a filename-safe timestamp fragment (rollout-<frag>-<id>.jsonl). */
function nowStamp(): { iso: string; frag: string; date: Date } {
  const date = new Date()
  const iso = date.toISOString()
  // Local-time YYYY-MM-DDTHH-MM-SS, matching the CLI's rollout filename shape.
  const p = (n: number): string => String(n).padStart(2, '0')
  const frag =
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  return { iso, frag, date }
}

/**
 * 需求(从 codex 导入到 traex 上下文丢失/无法续跑) — build a session_meta payload the
 * REAL codex/traex CLI will accept on `thread/resume`. The synthetic meta we used
 * to write (`{originator:'uniagent', source:'uniagent'}`) is REJECTED by the
 * thread-store recorder with `missing field 'cli_version'` (and, once that's
 * added, the transcript is treated as "does not start with session metadata"),
 * so the transplanted session could never be continued in the target agent.
 *
 * Empirically (probed against traex 0.201.5), a rollout only needs
 * `{id,timestamp,cwd,originator,cli_version}` to deserialize, but the safest,
 * most future-proof shape is to CLONE the target agent's own most-recent genuine
 * session_meta (same CLI version, same catalog snapshot, same history_mode) and
 * only overwrite identity + cwd + model. That guarantees every field the running
 * binary expects is present and internally consistent. We fall back to a minimal
 * hand-written meta (with a plausible originator + cli_version) when the agent has
 * no prior real session to template from.
 */
async function buildCodexSessionMeta(
  baseDir: string,
  id: string,
  iso: string,
  cwd: string,
  model: string | undefined
): Promise<Record<string, any>> {
  const template = await findTemplateSessionMeta(baseDir)
  if (template) {
    const meta: Record<string, any> = { ...template }
    // Overwrite identity + location + model; drop the old session_id alias and any
    // stale git block (the transplant's cwd may be a different repo).
    meta.id = id
    meta.session_id = id
    meta.timestamp = iso
    meta.cwd = cwd
    delete meta.git
    // parent/subagent markers must NOT leak onto a top-level transplant, or the
    // history list would hide it as a sub-agent (需求1) and it wouldn't open.
    delete meta.parent_thread_id
    if (meta.source && typeof meta.source === 'object') delete meta.source
    if (model) meta.model = model
    else delete meta.model
    // 需求6 — stamp a dedicated marker so listCodexLike can hide this cross-agent
    // 搬运 from the 导入会话 list. We can't key off `originator` (it's deliberately a
    // real-CLI value so the binary will resume the session), so this flag is the
    // only reliable signal that UniAgent produced this rollout.
    meta.uniagent_transplant = true
    return meta
  }
  // No template on disk — write the minimal set the recorder requires. originator
  // must not be 'uniagent' (the real binary keys behavior off known originators);
  // 'codex-tui' is what the CLI itself stamps.
  return {
    id,
    session_id: id,
    timestamp: iso,
    cwd,
    originator: 'codex-tui',
    cli_version: await detectCliVersion(baseDir),
    source: 'cli',
    // 需求6 — see above; mark this transplant so the import list hides it.
    uniagent_transplant: true,
    ...(model ? { model } : {})
  }
}

/**
 * Find the most-recent genuine session_meta payload under `baseDir` to use as a
 * transplant template: newest by mtime, must have a `cli_version` (i.e. written by
 * the real CLI, not a prior uniagent transplant), and must NOT be a sub-agent
 * child rollout. Returns the parsed payload or null.
 */
async function findTemplateSessionMeta(baseDir: string): Promise<Record<string, any> | null> {
  const files: string[] = []
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = join(baseDir, sub)
    if (existsSync(root)) await collectRolloutFiles(root, files)
  }
  const stated: { file: string; mtimeMs: number }[] = []
  for (const file of files) {
    try {
      stated.push({ file, mtimeMs: (await stat(file)).mtimeMs })
    } catch {
      /* vanished — skip */
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { file } of stated.slice(0, 60)) {
    let meta: Record<string, any> | null = null
    try {
      await forEachHeadLine(file, 512 * 1024, (line) => {
        try {
          const o = JSON.parse(line)
          if (o.type === 'session_meta') {
            meta = o.payload || null
          }
        } catch {
          /* keep scanning */
        }
        return false // only need the first record
      })
    } catch {
      continue
    }
    if (
      meta &&
      typeof (meta as any).cli_version === 'string' &&
      (meta as any).originator !== 'uniagent' &&
      !(meta as any).parent_thread_id &&
      !(meta as any).source?.subagent
    ) {
      return meta
    }
  }
  return null
}

/** Best-effort CLI version for the minimal-meta fallback (no template available). */
async function detectCliVersion(baseDir: string): Promise<string> {
  // Try the versioned release dir the launcher symlinks to; fall back to a recent
  // known-good version string the recorder accepts.
  try {
    const rel = join(homedir(), '.local/share', baseDir.includes('.trae') ? 'traex' : 'codex', 'releases')
    if (existsSync(rel)) {
      const dirs = await readdir(rel)
      const m = dirs
        .map((d) => d.match(/^(\d+\.\d+\.\d+[^-]*(?:-[A-Za-z0-9.]+)?)/)?.[1])
        .filter(Boolean) as string[]
      if (m.length) return m.sort().reverse()[0]
    }
  } catch {
    /* ignore */
  }
  return '0.0.0'
}

/**
 * Serialize normalized events into a codex/traex rollout JSONL + register it in
 * `session_index.jsonl`, so `exec resume <id>` / `thread/resume` sees it. We
 * emit the minimal record set the CLI needs to rebuild context: a session_meta
 * header, a turn_context (model), then one event_msg per conversational item.
 */
async function writeCodexLikeSession(
  baseDir: string,
  events: UAEvent[],
  cwd: string,
  model: string | undefined,
  agentId: string
): Promise<string> {
  const id = newNativeId()
  const { iso, frag, date } = nowStamp()
  const dir = join(
    baseDir,
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  )
  await mkdir(dir, { recursive: true })
  const file = join(dir, `rollout-${frag}-${id}.jsonl`)

  const lines: string[] = []
  const rec = (type: string, payload: any, timestamp = iso): void => {
    lines.push(JSON.stringify({ timestamp, type, payload, ordinal: lines.length }))
  }
  rec('session_meta', await buildCodexSessionMeta(baseDir, id, iso, cwd, model))
  if (model) rec('turn_context', { model, cwd })

  const title = deriveSessionTitle(
    events.find((e) => e.type === 'user_message' || e.type === 'goal_message')?.payload?.text,
    60
  )
  // 需求7 (从 codex 导入到 traex 上下文丢失) — codex/traex 在 `thread/resume` 时是从
  // `response_item` 记录（发送给模型 API 的真实会话项）重建模型上下文的，`event_msg`
  // 只驱动 TUI 的可视化回放。此前的搬运只写了 event_msg，导致目标 Agent 恢复后模型看到
  // 的是空历史（"这是我们对话的开始"）。这里为每条消息同时补写 response_item，让续跑时
  // 模型真正带上此前的对话。二者互不冲突：UniAgent 再次导入时优先走 event_msg 路径
  // （同一 session_meta 段有 event conversation），response_item 仅作为原生 resume 的模型上下文来源。
  for (const ev of eventsForNativeExport(events)) {
    const timestamp = Number.isFinite(ev.ts) && ev.ts > 0 ? new Date(ev.ts).toISOString() : iso
    for (const ri of codexResponseItems(ev)) rec('response_item', ri, timestamp)
    const msg = codexEventMsg(ev)
    if (msg) rec('event_msg', msg, timestamp)
  }
  await writeFile(file, lines.map((l) => l + '\n').join(''), 'utf8')

  // Register in the index so listAgentHistory + resume can find it by id.
  const indexPath = join(baseDir, 'session_index.jsonl')
  try {
    await appendFile(
      indexPath,
      JSON.stringify({ id, thread_name: title || '(迁移会话)', updated_at: iso }) + '\n',
      'utf8'
    )
  } catch {
    /* index is best-effort; findRollout also locates by filename suffix */
  }
  // A successful transplant is NOT a diagnostic gap — the 迁移诊断 log exists only
  // to surface UNHANDLED data / anomalies. Recording an "export_ok" here badged
  // the panel on every clean import; per product it must stay silent on success
  // and only ever show real anomalies. (Any unknown-shape gaps hit during the
  // read are still recorded separately below.)
  return id
}

/**
 * Map one normalized UAEvent to a codex/traex `event_msg` payload for the
 * transplant. Only the conversationally-meaningful shapes are re-emitted; the
 * KNOWN_EVENT_MSG_TYPES read allowlist governs what round-trips cleanly.
 */
function codexEventMsg(ev: UAEvent): any | null {
  const p = ev.payload || {}
  switch (ev.type) {
    case 'user_message':
      return p.text ? { type: 'user_message', message: p.text } : null
    case 'goal_message':
      return p.text ? { type: 'user_message', message: p.text, uniagentGoal: true } : null
    case 'agent_message':
      return p.text
        ? {
            type: 'agent_message',
            message: p.text,
            ...(p.phase ? { phase: p.phase } : {}),
            ...(p.uniagentSubagentSummary ? { uniagentSubagentSummary: p.uniagentSubagentSummary } : {})
          }
        : null
    case 'reasoning':
      return p.text ? { type: 'agent_reasoning', text: p.text } : null
    case 'command_exec':
      return {
        type: 'exec_command_end',
        call_id: p.id,
        command: p.command,
        aggregated_output: p.output || '',
        exit_code: p.exitCode ?? null
      }
    case 'tool_call':
      if (p.name === 'image_generation') {
        const result = portableImageResult(ev)
        return {
          type: 'image_generation_end',
          call_id: portableCallId(ev),
          status: result.status,
          revised_prompt: portableImagePrompt(p),
          result: '',
          ...(result.savedPath ? { saved_path: result.savedPath } : {}),
          ...(result.transparentBackground !== undefined
            ? { transparent_background: result.transparentBackground }
            : {}),
          ...(result.failure ? { failure: result.failure } : {})
        }
      }
      return null
    default:
      return null
  }
}

/**
 * 需求7 — map one normalized UAEvent to a codex/traex `response_item` payload,
 * the record type the CLI ACTUALLY replays into the model's context on
 * `thread/resume`. `event_msg` only feeds the TUI's visual timeline, so a
 * transplant that wrote event_msg alone resumed with an empty model history
 * (the "这是我们对话的开始" bug). We mirror codex's on-disk shape for the pieces
 * that carry conversational context losslessly: user/assistant turns become
 * `message` items (input_text / output_text blocks).
 *
 * We deliberately DO NOT emit `reasoning` response_items: codex stores those with
 * an opaque `encrypted_content` blob we cannot forge, and a reasoning item that
 * lacks it can make `thread/resume` reject the transcript. The user + assistant
 * messages fully carry "what happened" for context recovery. Image generation
 * uses the native compact result shape, with its large base64 payload omitted.
 */
function codexResponseItems(ev: UAEvent): any[] {
  const p = ev.payload || {}
  switch (ev.type) {
    case 'user_message':
    case 'goal_message':
      return p.text
        ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: String(p.text) }] }]
        : []
    case 'agent_message':
      return p.text
        ? [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: String(p.text) }],
            ...(p.phase ? { phase: p.phase } : {}),
            ...(p.uniagentSubagentSummary
              ? { uniagentSubagentSummary: p.uniagentSubagentSummary }
              : {})
          }]
        : []
    case 'tool_call': {
      if (p.name === 'image_generation') {
        const result = portableImageResult(ev)
        return [{
          type: 'image_generation_call',
          id: portableCallId(ev),
          status: result.status,
          revised_prompt: portableImagePrompt(p),
          result: ''
        }]
      }
      if (!p.name || ev.state === 'running') return []
      const callId = codexCallId(String(p.id || `call_${randomUUID()}`))
      const output = ev.state === 'failed' ? p.error ?? p.result : p.result ?? p.error
      const uniagentTool = { version: 1, eventType: 'tool_call', name: String(p.name), state: ev.state }
      return [{
        type: 'function_call',
        name: String(p.name),
        ...(typeof p.namespace === 'string' ? { namespace: p.namespace } : {}),
        arguments: JSON.stringify(p.input ?? {}),
        call_id: callId
      }, {
        type: 'function_call_output',
        call_id: callId,
        output: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
        uniagentTool
      }]
    }
    default:
      return []
  }
}

/**
 * Serialize normalized events into a Claude project jsonl so `claude --resume
 * <id>` picks it up. Claude keys sessions by a file under the *dashed real cwd*
 * project dir; we mirror that layout and write minimal user/assistant records.
 */
async function writeClaudeSession(
  events: UAEvent[],
  cwd: string,
  model: string | undefined
): Promise<string> {
  const id = newNativeId()
  const projectDir = join(CLAUDE_PROJECTS, dashProjectPath(cwd))
  await mkdir(projectDir, { recursive: true })
  const file = join(projectDir, `${id}.jsonl`)
  const iso = new Date().toISOString()
  const lines: string[] = []
  for (const ev of eventsForNativeExport(events)) {
    const p = ev.payload || {}
    if ((ev.type === 'user_message' || ev.type === 'goal_message') && p.text) {
      lines.push(
        JSON.stringify({
          type: 'user',
          cwd,
          sessionId: id,
          timestamp: iso,
          ...(ev.type === 'goal_message' ? { uniagentGoal: true } : {}),
          message: { role: 'user', content: p.text }
        })
      )
    } else if (ev.type === 'agent_message' && p.text) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          cwd,
          sessionId: id,
          timestamp: iso,
          ...(p.uniagentSubagentSummary
            ? { uniagentSubagentSummary: p.uniagentSubagentSummary }
            : {}),
          message: {
            role: 'assistant',
            ...(model ? { model } : {}),
            content: [{ type: 'text', text: p.text }]
          }
        })
      )
    } else if (ev.type === 'reasoning' && p.text) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          cwd,
          sessionId: id,
          timestamp: iso,
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: p.text }] }
        })
      )
    } else if (
      ev.type === 'tool_call' && p.name === 'image_generation'
    ) {
      const toolUseId = portableCallId(ev)
      const assistantUuid = randomUUID()
      lines.push(
        JSON.stringify({
          type: 'assistant',
          uuid: assistantUuid,
          cwd,
          sessionId: id,
          timestamp: iso,
          message: {
            role: 'assistant',
            ...(model ? { model } : {}),
            content: [{
              type: 'tool_use',
              id: toolUseId,
              name: PORTABLE_IMAGE_TOOL,
              input: { prompt: portableImagePrompt(p) }
            }]
          }
        })
      )
      lines.push(
        JSON.stringify({
          type: 'user',
          uuid: randomUUID(),
          parentUuid: assistantUuid,
          sourceToolAssistantUUID: assistantUuid,
          cwd,
          sessionId: id,
          timestamp: iso,
          uniagentTool: {
            version: 1,
            eventType: 'tool_call',
            name: 'image_generation',
            state: ev.state
          },
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: JSON.stringify(portableImageResult(ev)),
              is_error: ev.state === 'failed'
            }]
          }
        })
      )
    }
  }
  await writeFile(file, lines.map((l) => l + '\n').join(''), 'utf8')
  // See note above: success is silent; 迁移诊断 only surfaces real anomalies.
  return id
}

/** Claude derives its per-project dir by dashing the absolute cwd path. */
function dashProjectPath(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

function portableCallId(ev: UAEvent): string {
  const existing = String(ev.payload?.id ?? '')
  return existing || `ig_${randomUUID()}`
}

/** Timeline item IDs can exceed the Responses API's 64-character call_id limit. */
function codexCallId(id: string): string {
  return id.length <= 64 ? id : `call_${createHash('sha256').update(id).digest('base64url')}`
}

function portableImagePrompt(payload: Record<string, any>): string {
  return typeof payload.input === 'string'
    ? payload.input
    : typeof payload.input?.prompt === 'string'
      ? payload.input.prompt
      : ''
}

function portableImageResult(ev: UAEvent): Record<string, any> {
  const payload = ev.payload || {}
  const result = {
    ...(payload.result && typeof payload.result === 'object' ? payload.result : {}),
    ...(payload.error && typeof payload.error === 'object' ? payload.error : {})
  }
  const status = typeof result.status === 'string'
    ? result.status
    : ev.state === 'failed'
      ? 'failed'
      : ev.state === 'cancelled'
        ? 'cancelled'
        : 'completed'
  return {
    status,
    ...(typeof result.savedPath === 'string' ? { savedPath: result.savedPath } : {}),
    ...(typeof result.transparentBackground === 'boolean'
      ? { transparentBackground: result.transparentBackground }
      : {}),
    ...(result.failure != null && result.failure !== '' ? { failure: result.failure } : {})
  }
}

/**
 * A migrated target has no native child rollouts for source-agent thread ids.
 * Collapse each generation to its latest snapshot and serialize it as a plain
 * assistant summary instead of creating a clickable-but-empty child thread.
 */
function eventsForNativeExport(events: UAEvent[]): UAEvent[] {
  const latest = new Map<string, { index: number; event: UAEvent; agent: UASubAgent }>()
  events.forEach((event, index) => {
    if (event.type !== 'subagent') return
    for (const agent of (event.payload?.agents ?? []) as UASubAgent[]) {
      if (!agent?.agentThreadId) continue
      const key = historicalGenerationKey(agent)
      const previous = latest.get(key)?.agent
      latest.set(key, {
        index,
        event,
        agent: {
          ...previous,
          ...agent,
          prompt: agent.prompt || previous?.prompt,
          message: agent.message || previous?.message
        }
      })
    }
  })
  const summaries = new Map<number, UASubAgent[]>()
  for (const { index, agent } of latest.values()) {
    const list = summaries.get(index) ?? []
    list.push(agent)
    summaries.set(index, list)
  }
  const out: UAEvent[] = []
  events.forEach((event, index) => {
    if (event.type !== 'subagent') {
      out.push(
        event.type === 'tool_call' && event.payload?.name === 'image_generation' && !event.payload?.id
          ? { ...event, payload: { ...event.payload, id: `ig_${randomUUID()}` } }
          : event
      )
      return
    }
    const agents = summaries.get(index)
    if (!agents?.length) return
    out.push({
      ...event,
      type: 'agent_message',
      state: 'success',
      payload: portableSubAgentSummary(agents)
    })
  })
  return out
}

function portableSubAgentSummary(agents: UASubAgent[]): Record<string, any> {
  const markers = agents.map((agent) => ({
    version: 1,
    agentThreadId: agent.agentThreadId,
    detailAvailable: false,
    name: agent.name,
    status: agent.status,
    generation: agent.generation,
    dispatchId: agent.dispatchId,
    prompt: agent.prompt,
    message: agent.message,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt
  }))
  const statusText: Record<UASubAgent['status'], string> = {
    pendingInit: '准备中', running: '进行中', interrupted: '已中断',
    completed: '已完成', errored: '出错', shutdown: '已结束', notFound: '未找到'
  }
  return {
    id: `subagent-summary-${markers.map((marker) => marker.dispatchId || marker.agentThreadId).join('-')}`,
    kind: 'subagent_summary',
    uniagentSubagentSummary: markers,
    text: markers.map((marker) => [
      `[子智能体摘要] ${marker.name || marker.agentThreadId.slice(0, 8)}（${statusText[marker.status]}）`,
      marker.prompt ? `任务：${marker.prompt}` : '',
      marker.message ? `结果：${marker.message}` : ''
    ].filter(Boolean).join('\n')).join('\n\n')
  }
}

function portableSubAgentMarkers(value: unknown): Record<string, any>[] | undefined {
  if (!Array.isArray(value)) return undefined
  const statuses = new Set([
    'pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'
  ])
  const markers = value.flatMap((raw) => {
    if (raw?.version !== 1 || typeof raw.agentThreadId !== 'string' || !raw.agentThreadId.trim() ||
        !statuses.has(raw.status)) return []
    return [{ ...raw, agentThreadId: raw.agentThreadId.trim(), detailAvailable: false }]
  })
  return markers.length ? markers : undefined
}

function imageGenerationState(status: unknown): UAEvent['state'] {
  const value = String(status ?? '').toLowerCase()
  if (value === 'completed' || value === 'success' || value === 'succeeded') return 'success'
  if (value === 'failed' || value === 'error') return 'failed'
  if (value === 'cancelled' || value === 'canceled' || value === 'interrupted') return 'cancelled'
  return 'running'
}

interface HistoricalGenerationWindow {
  key: string
  childId: string
  startedAt?: number
  parentUpperBound?: number
}

type ChildRolloutEndResolver = (
  agentId: string,
  generations: readonly HistoricalGenerationWindow[]
) => Promise<Map<string, number | undefined>>

async function resolveNativeChildRolloutEnds(
  agentId: string,
  generations: readonly HistoricalGenerationWindow[]
): Promise<Map<string, number | undefined>> {
  const childBaseDir = agentId === 'traex' ? TRAE_DIR : CODEX_DIR
  const childFiles = await findRollouts(childBaseDir, generations.map((generation) => generation.childId))
  return new Map(await Promise.all(generations.map(async (generation) => {
    const childFile = childFiles.get(generation.childId)
    const terminal = childFile
      ? await rolloutGenerationEndTimestamp(childFile, generation.startedAt)
      : undefined
    const boundedTerminal =
      terminal !== undefined &&
      (generation.parentUpperBound === undefined || terminal <= generation.parentUpperBound)
        ? terminal
        : undefined
    return [
      generation.key,
      boundedTerminal
    ] as const
  })))
}

function historicalGenerationKey(agent: Pick<UASubAgent, 'agentThreadId' | 'generation' | 'dispatchId'>): string {
  return `${agent.agentThreadId}\u0000${agent.generation ?? agent.dispatchId ?? 'legacy'}`
}

function historicalDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : undefined
  if (!value || typeof value !== 'object') return undefined
  const secs = Number((value as any).secs ?? 0)
  const nanos = Number((value as any).nanos ?? 0)
  return Number.isFinite(secs) && Number.isFinite(nanos)
    ? Math.max(0, secs * 1_000 + nanos / 1_000_000)
    : undefined
}

function historicalUsage(value: any): { input: number; output: number; cached: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const token = (key: string): number =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : 0
  return { input: token('input_tokens'), output: token('output_tokens'), cached: token('cached_input_tokens') }
}

interface CodexLikeReplayOptions {
  /**
   * Test-only capacity seam for the sub-agent lifecycle guard. Production replay
   * leaves this undefined and keeps the full transcript; a capped prefix cannot
   * be shown as a complete conversation because the newest records are the ones
   * dropped.
   */
  replayEventLimit?: number
}

/** Exported for protocol-fixture tests; normal callers use loadSessionEvents. */
export async function loadCodexLikeEvents(
  file: string,
  agentId: string,
  sessionId: string,
  resolveChildRolloutEnds: ChildRolloutEndResolver = resolveNativeChildRolloutEnds,
  replayText?: string,
  onProgress?: HistoryProgressCallback,
  options: CodexLikeReplayOptions = {}
): Promise<{ events: UAEvent[]; cwd?: string; model?: string; effort?: string; maxMode?: boolean; contextWindow?: number }> {
  let text = replayText
  if (text === undefined) {
    try {
      text = (await readHistoryFile(file, onProgress)).toString('utf8')
    } catch {
      return { events: [] }
    }
  }
  text = await ownSubAgentReplayText(text, sessionId, onProgress)
  text = await foldRolloutRollbacks(text, onProgress)
  const recoveredParentMessages = await recoverSubAgentParentMessages(text, agentId, sessionId, onProgress)
  const events: UAEvent[] = []
  const replayEventLimit = options.replayEventLimit ?? Infinity
  let seq = 0
  let cwd: string | undefined
  let model: string | undefined
  let effort: string | undefined
  let contextWindow: number | undefined
  let maxMode: boolean | undefined
  let sawVariantMismatch = false
  const restoredNoticeKeys = new Set<string>()
  const knownGoalIds = new Set<string>()
  const emittedGoalIds = new Set<string>()
  const restoredGoalTextsByTurn = new Map<string, Set<string>>()
  let pendingGoalText: string | undefined
  let lastRolloutTs: number | undefined
  let currentRecordTs: number | undefined
  // 需求1/2/3(历史会话续跑 turn 边界) — restore the provider's NATIVE turn id so a
  // replayed session supports the same turn-scoped review + 回退到某轮 the live
  // path does. codex/traex stamp `turn_id` on task_started / turn_context /
  // task_complete / patch_apply_end / history_mutation (thread id == this
  // rollout's session id). Open each native turn on its first user message;
  // later messages under the same id are steering within that turn. Close it
  // with `turn_completed` at the next native turn / EOF. Old rollouts without a
  // `turn_id` (early codex) leave `currentTurnId` undefined → we emit NO boundary
  // rather than guessing, so nothing regresses for id-less history.
  const threadId = sessionId || undefined
  let currentTurnId: string | undefined
  let openTurnId: string | undefined
  let turnOpen = false
  let transplanted = false
  const closeOpenTurn = (): void => {
    if (!turnOpen) return
    push('turn_completed', { threadId, turnId: openTurnId }, 'success')
    turnOpen = false
    openTurnId = undefined
  }
  const protectedSubAgentEvents = new Set<UAEvent>()
  const subAgentGenerationKeysByEvent = new Map<UAEvent, string[]>()
  const subAgentEventsByGeneration = new Map<string, Set<UAEvent>>()
  const droppedSubAgentGenerations = new Set<string>()

  const unregisterSubAgentEvent = (event: UAEvent): void => {
    protectedSubAgentEvents.delete(event)
    const keys = subAgentGenerationKeysByEvent.get(event) ?? []
    subAgentGenerationKeysByEvent.delete(event)
    for (const key of keys) {
      const generationEvents = subAgentEventsByGeneration.get(key)
      generationEvents?.delete(event)
      if (!generationEvents?.size) subAgentEventsByGeneration.delete(key)
    }
  }
  const removeEventAt = (index: number): void => {
    const [removed] = events.splice(index, 1)
    if (removed) unregisterSubAgentEvent(removed)
  }
  const registerSubAgentEvent = (event: UAEvent, keys: string[], protect: boolean): void => {
    if (!keys.length) return
    subAgentGenerationKeysByEvent.set(event, keys)
    for (const key of keys) {
      const generationEvents = subAgentEventsByGeneration.get(key) ?? new Set<UAEvent>()
      generationEvents.add(event)
      subAgentEventsByGeneration.set(key, generationEvents)
    }
    if (protect) protectedSubAgentEvents.add(event)
  }
  const generationHasTerminal = (key: string): boolean =>
    [...(subAgentEventsByGeneration.get(key) ?? [])].some((event) =>
      (event.payload?.agents ?? []).some((agent: UASubAgent) =>
        historicalGenerationKey(agent) === key && isSubAgentTerminal(agent.status)
      )
    )
  const evictSubAgentGeneration = (initialKey: string): void => {
    // A subagent snapshot can theoretically contain several agents. Evict the
    // transitive key group so removing a shared event never leaves another
    // generation with only half of its lifecycle retained.
    const keys = new Set([initialKey])
    let expanded = true
    while (expanded) {
      expanded = false
      for (const [event, eventKeys] of subAgentGenerationKeysByEvent) {
        if (!eventKeys.some((key) => keys.has(key))) continue
        for (const key of eventKeys) {
          if (keys.has(key)) continue
          keys.add(key)
          expanded = true
        }
      }
    }
    for (let index = events.length - 1; index >= 0; index--) {
      const eventKeys = subAgentGenerationKeysByEvent.get(events[index]) ?? []
      if (eventKeys.some((key) => keys.has(key))) removeEventAt(index)
    }
    for (const key of keys) droppedSubAgentGenerations.add(key)
  }
  const makeRoomForLifecycle = (incomingKeys: readonly string[]): boolean => {
    if (events.length < replayEventLimit) return true
    const nonLifecycleIndex = events.findLastIndex((event) => !protectedSubAgentEvents.has(event))
    if (nonLifecycleIndex >= 0) {
      removeEventAt(nonLifecycleIndex)
      return true
    }

    const incoming = new Set(incomingKeys)
    const candidates = [...subAgentEventsByGeneration.keys()].filter((key) => !incoming.has(key))
    const evictedKey = candidates.find(generationHasTerminal) ?? candidates[0]
    if (evictedKey) {
      evictSubAgentGeneration(evictedKey)
      return events.length < replayEventLimit
    }

    // The buffer contains only this generation. Drop it as a whole; retaining a
    // lone terminal or a running start without its terminal is worse than
    // omitting the lifecycle from a capped replay.
    const currentKey = incomingKeys.find((key) => subAgentEventsByGeneration.has(key))
    if (currentKey) evictSubAgentGeneration(currentKey)
    return false
  }
  const push = (
    type: UAEvent['type'],
    payload: any,
    state?: UAEvent['state'],
    timestamp?: unknown,
    reserveTerminal = false
  ): UAEvent | undefined => {
    const subAgentSnapshots: UASubAgent[] = type === 'subagent' && Array.isArray(payload?.agents)
      ? payload.agents
      : []
    const lifecycleKeys = subAgentSnapshots.map((agent) =>
      historicalGenerationKey(agent)
    )
    if (lifecycleKeys.some((key) => droppedSubAgentGenerations.has(key))) return undefined
    const opensGeneration = lifecycleKeys.some((key) => !subAgentEventsByGeneration.has(key))
    const closesGeneration = subAgentSnapshots.some((agent) => isSubAgentTerminal(agent.status))
    const preserveSubAgent = subAgentSnapshots.length > 0 && (opensGeneration || closesGeneration)
    const nextEvent: UAEvent = {
      sessionId: '',
      seq: seq++,
      ts: historicalTimestamp(timestamp) ?? currentRecordTs ?? lastRolloutTs ?? 0,
      type,
      state,
      payload
    }
    if (isAsyncQuestion(nextEvent) && currentNativeSessionId !== sessionId) {
      const sourceIndex = nativeSessionLineage.indexOf(currentNativeSessionId)
      const targetIndex = nativeSessionLineage.lastIndexOf(sessionId)
      nextEvent.payload = { ...payload, inheritedFromNativeSessionIds: targetIndex > sourceIndex && sourceIndex >= 0
        ? nativeSessionLineage.slice(sourceIndex, targetIndex).reverse() : [currentNativeSessionId] }
    }
    if (events.length >= replayEventLimit) {
      if (!reserveTerminal && !preserveSubAgent) return undefined
      // EOF reconciliation is correctness-critical: a capped replay must not
      // leave a child running forever. First evict ordinary replay detail; if
      // every retained event is lifecycle-critical, evict one complete generation
      // as a unit so neither an orphan start nor an orphan terminal survives.
      if (!makeRoomForLifecycle(lifecycleKeys)) return undefined
    }
    events.push(nextEvent)
    // Rebuilt history has no target-native turn ids, including older transplants.
    if (transplanted && (type === 'user_message' || type === 'goal_message')) turnOpen = true
    registerSubAgentEvent(nextEvent, lifecycleKeys, preserveSubAgent)
    return nextEvent
  }
  // Emit one usage footer per turn. New rollouts provide authoritative per-turn
  // and thread totals; older rollouts fall back to token_count deltas.
  let baseline = { input: 0, output: 0, cached: 0 }
  let latestTotal: { input: number; output: number; cached: number } | null = null
  let latestSourceTotal: { input: number; output: number; cached: number } | null = null
  let latestTurnUsage: { input: number; output: number; cached: number } | null = null
  let preciseUsageForTurn = false
  let latestLastInput: number | undefined
  let emittedForTurn = true
  const compactionHistory = new ContextCompactionHistory()
  const pushCompaction = (nativeId: unknown, timestamp: unknown, source: 'top' | 'event'): void => {
    const id = compactionHistory.accept(nativeId, timestamp, source, events.length)
    if (!id) return
    push('context_compaction', { id }, 'success')
  }

  // 需求2(子 Agent 恢复) — accumulate the parent thread's `sub_agent_activity`
  // lifecycle records into a per-child roster so a restored session can rebuild
  // its sub-agent list (name / thread id), just like the live path's `subagent`
  // events. The child's actual output isn't here — it lives in the child's own
  // rollout (filename id == agentThreadId), fetched on demand by the detail
  // panel. Since we're replaying a finished rollout, children default to
  // `completed` (terminal) so the timer doesn't run; an `interrupted` kind wins.
  const subAgents = new Map<string, UASubAgent>()
  const historicalSubAgentDispatches = new SubAgentDispatchTracker()
  const subAgentLastEvidenceTs = new Map<string, number>()
  const imageEventCallIds = new Set<string>()
  const nativeTerminalCallIds = new Set<string>()
  const responseToolNamespaces = new Map<string, string>()
  const subAgentIdByPath = new Map<string, string>()
  const pendingSubAgentMessageByPath = new Map<string, string>()
  const collabMetadataByCall = new Map<string, {
    threadId: string
    name?: string
    prompt?: string
    message?: string
    status?: UASubAgent['status']
    endedAt?: number
  }>()
  let currentAgentPath = '/root'
  let currentNativeSessionId = sessionId
  const nativeSessionLineage: string[] = []
  const historicalGenerations = new Map<string, {
    agent: UASubAgent
    parentUpperBound?: number
    explicitTerminal?: UASubAgent
    startEvent?: UAEvent
  }>()
  const rememberSubAgentMessage = (
    agentPath: string,
    message: string,
    eventId?: string,
    timestamp?: unknown
  ): void => {
    const pathKey = `${currentNativeSessionId}\0${agentPath}`
    const childId = subAgentIdByPath.get(pathKey)
    const current = childId ? subAgents.get(childId) : undefined
    if (!childId || !current) {
      pendingSubAgentMessageByPath.set(pathKey, message)
      return
    }
    const key = historicalGenerationKey(current)
    const next = { ...current, message }
    subAgents.set(childId, next)
    const generation = historicalGenerations.get(key)
    if (generation) {
      generation.agent = next
      if (generation.explicitTerminal) generation.explicitTerminal = { ...generation.explicitTerminal, message }
    }
    const messageTs = historicalTimestamp(timestamp) ?? currentRecordTs
    if (messageTs !== undefined) {
      subAgentLastEvidenceTs.set(
        childId,
        Math.max(subAgentLastEvidenceTs.get(childId) ?? Number.NEGATIVE_INFINITY, messageTs)
      )
    }
    push('subagent', {
      id: eventId || `sa-message-${childId}-${seq}`,
      agents: [next]
    }, undefined, messageTs)
  }

  // One segment can switch message formats after a migration or CLI update.
  // Match copies per native turn and text, retaining repeated occurrences.
  const lines = text.split('\n')
  type ConversationCopy = { position: string; source: number; id?: string; turnId?: string }
  const conversationCopies = new Map<string, ConversationCopy[]>()
  const eventReasoningBySegment = new Map<number, Map<string, number>>()
  const completedReasoningItemIds = new Set<string>()
  let scanSegment = -1
  let scanTurnId: string | undefined
  const rememberConversation = (
    role: string, text: string, position: string, source: number, id?: string,
    turnId = scanTurnId
  ): void => {
    // Response user messages include image placeholders absent from display items.
    const normalized = (role === 'user' ? text.replace(/<image\b[^>]*>[\s\S]*?<\/image>/g, '') : text).trim()
    if (!normalized) return
    const key = JSON.stringify([scanSegment, role, normalized])
    const copies = conversationCopies.get(key) ?? []
    copies.push({ position, source, ...(id ? { id } : {}), ...(turnId ? { turnId } : {}) })
    conversationCopies.set(key, copies)
  }
  const scanProgress = trackHistoryWork('scanning', lines.length, onProgress)
  for (let index = 0; index < lines.length; index++) {
    const pending = scanProgress(index)
    if (pending) await pending
    const line = lines[index]
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const goal = rolloutGoal(o)
    const goalTurnId = o?.turn_id ?? o?.payload?.turn_id
    if (goal) {
      knownGoalIds.add(goal.id)
      if (typeof goalTurnId === 'string' && goalTurnId.trim()) {
        const turnId = goalTurnId.trim()
        const texts = restoredGoalTextsByTurn.get(turnId) ?? new Set<string>()
        texts.add(goal.text)
        restoredGoalTextsByTurn.set(turnId, texts)
      }
    }
    const t = o?.type === 'event_msg' ? o.payload?.type : undefined
    const p = o?.payload || {}
    if (o?.type === 'session_meta') { scanSegment++; scanTurnId = undefined }
    const recordTurnId = o.turn_id ?? p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id
    if (t === 'task_started') scanTurnId = undefined
    if (typeof recordTurnId === 'string' && recordTurnId.trim()) scanTurnId = recordTurnId.trim()
    if (o.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      // Response ids belong to the model transcript, not the visible item id space.
      rememberConversation(p.role, collectResponseText(p.content), String(index), 4)
    }
    if (t === 'user_message' || t === 'agent_message') {
      rememberConversation(t === 'user_message' ? 'user' : 'assistant', String(p.message || ''), String(index), 1, p.id)
    }
    if (t === 'item_completed') {
      const item = p.item
      const itemType = String(item?.type ?? '').toLowerCase()
      if (itemType === 'usermessage' || itemType === 'agentmessage') {
        rememberConversation(itemType === 'usermessage' ? 'user' : 'assistant',
          item.text || collectResponseText(item.content), String(index), item.delivery === 'async' ? 0 : 2, item.id)
      }
    }
    if (o.type === 'history_mutation' && p.operation === 'append' && Array.isArray(p.display_completions)) {
      p.display_completions.forEach((completion: any, completionIndex: number) => {
        const item = completion?.item
        const itemType = String(item?.type ?? '').toLowerCase()
        if (itemType === 'usermessage' || itemType === 'agentmessage') {
          rememberConversation(itemType === 'usermessage' ? 'user' : 'assistant',
            collectResponseText(item.content), `${index}:${completionIndex}`, 3, item.id,
            completion.turn_id || scanTurnId)
        }
      })
    }
    if (o?.type === 'response_item' &&
      (p.type === 'function_call' || p.type === 'custom_tool_call') &&
      typeof p.namespace === 'string') {
      responseToolNamespaces.set(`${scanSegment}\0${p.call_id || p.id || ''}`, p.namespace)
    }
    // Modern Codex stores the same call as a response pair and a completed item.
    if (t === 'item_completed' && typeof p.item?.id === 'string' && p.item.id &&
      ['commandexecution', 'filechange', 'dynamictoolcall', 'mcptoolcall']
        .includes(String(p.item.type).toLowerCase())) {
      nativeTerminalCallIds.add(`${scanSegment}\0${p.item.id}`)
    }
    if (o?.type === 'session_meta') {
      const agentPath = p.agent_path ?? p.source?.subagent?.thread_spawn?.agent_path
      currentAgentPath = typeof agentPath === 'string' && agentPath.trim() ? agentPath.trim() : '/root'
      const nativeId = p.id ?? p.session_id
      if (typeof nativeId === 'string' && nativeId.trim()) {
        currentNativeSessionId = nativeId.trim()
        nativeSessionLineage.push(currentNativeSessionId)
      }
    } else if (t === 'sub_agent_activity') {
      const id = p.agent_thread_id || p.agentThreadId
      const agentPath = p.agent_path || p.agentPath
      if (id && typeof agentPath === 'string' && agentPath) {
        subAgentIdByPath.set(`${currentNativeSessionId}\0${agentPath}`, id)
      }
    } else if (t === 'collab_agent_spawn_end') {
      const callId = typeof p.call_id === 'string' ? p.call_id : ''
      const childId = typeof p.new_thread_id === 'string' ? p.new_thread_id : ''
      const senderId = typeof p.sender_thread_id === 'string' ? p.sender_thread_id : ''
      if (callId && childId && (!senderId || senderId === currentNativeSessionId)) {
        collabMetadataByCall.set(`${currentNativeSessionId}\0${callId}`, {
          threadId: childId,
          name: typeof p.new_agent_nickname === 'string' ? p.new_agent_nickname : undefined,
          prompt: typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt : undefined
        })
      }
    } else if (t === 'collab_agent_interaction_end') {
      const callId = typeof p.call_id === 'string' ? p.call_id : ''
      const senderId = typeof p.sender_thread_id === 'string' ? p.sender_thread_id : ''
      const receiverId = typeof p.receiver_thread_id === 'string' ? p.receiver_thread_id : ''
      const status = historicalCollabStatus(p.status)
      const message = p.status && typeof p.status === 'object'
        ? ['interrupted', 'failed', 'error', 'errored', 'shutdown', 'not_found', 'notFound', 'completed']
          .map((key) => p.status[key])
          .find((value) => typeof value === 'string' && value.trim())
        : undefined
      if (callId && receiverId && (!senderId || senderId === currentNativeSessionId)) {
        collabMetadataByCall.set(`${currentNativeSessionId}\0${callId}`, {
          threadId: receiverId,
          name: typeof p.receiver_agent_nickname === 'string' ? p.receiver_agent_nickname : undefined,
          prompt: typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt : undefined,
          message,
          status,
          endedAt: historicalTimestamp(p.completed_at_ms)
        })
      } else if (callId && senderId && receiverId === currentNativeSessionId) {
        collabMetadataByCall.set(`${currentNativeSessionId}\0${callId}`, {
          threadId: senderId,
          message: message || (typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt : undefined),
          status,
          endedAt: historicalTimestamp(p.completed_at_ms)
        })
      }
    }
    if (t === 'image_generation_end' && typeof p.call_id === 'string' && p.call_id) {
      imageEventCallIds.add(`${scanSegment}\0${p.call_id}`)
    }
    if (
      t === 'item_completed' &&
      String(p.item?.type).toLowerCase() === 'reasoning' &&
      p.item?.id &&
      [...(p.item.summary_text || []), ...(p.item.raw_content || [])]
        .some((part) => typeof part === 'string' && part.trim())
    ) {
      completedReasoningItemIds.add(`${scanSegment}\0${p.item.id}`)
    }
    if (
      typeof p.call_id === 'string' &&
      p.call_id &&
      (t === 'exec_command_end' ||
        t === 'patch_apply_end' ||
        t === 'mcp_tool_call_end')
    ) {
      nativeTerminalCallIds.add(`${scanSegment}\0${p.call_id}`)
    }
    if (t === 'agent_reasoning' || t === 'agent_reasoning_raw_content') {
      const text = typeof p.text === 'string' ? p.text.trim() : ''
      if (text) {
        const counts = eventReasoningBySegment.get(scanSegment) ?? new Map<string, number>()
        counts.set(text, (counts.get(text) ?? 0) + 1)
        eventReasoningBySegment.set(scanSegment, counts)
      }
    }
    const communication = rolloutAgentCommunication(o)
    if (communication) {
      const { author, recipient, kind } = communication
      const parentText = communication.text || recoveredParentMessages.get(index)
      const parentPath = currentAgentPath.slice(0, currentAgentPath.lastIndexOf('/'))
      if (
        parentText &&
        recipient === currentAgentPath &&
        author === parentPath &&
        (kind === 'new_task' || kind === 'followup' || kind === 'message')
      ) {
        rememberConversation('user', parentText, String(index), 1, communication.id)
      }
    }
  }
  const conversationPositions = new Set<string>()
  for (const copies of conversationCopies.values()) {
    const selected: ConversationCopy[] = []
    for (const source of [0, 1, 2, 3, 4]) {
      const unmatched = new Map<string, ConversationCopy[]>()
      for (const prior of selected) {
        const key = prior.turnId || ''
        const bucket = unmatched.get(key) || []
        bucket.push(prior)
        unmatched.set(key, bucket)
      }
      for (const copy of copies.filter(copy => copy.source === source)) {
        // Known turns inspect only their own bucket and legacy copies without a turn id.
        const buckets = copy.turnId
          ? [unmatched.get(copy.turnId) || [], unmatched.get('') || []]
          : [...unmatched.values()]
        let match: { bucket: ConversationCopy[]; index: number } | undefined
        for (const byId of [true, false]) {
          for (const bucket of buckets) {
            const index = bucket.findIndex(prior => byId ? !!copy.id && prior.id === copy.id : !copy.id || !prior.id)
            if (index >= 0) { match = { bucket, index }; break }
          }
          if (match) break
        }
        if (match) match.bucket.splice(match.index, 1)
        else { selected.push(copy); conversationPositions.add(copy.position) }
      }
    }
  }
  currentAgentPath = '/root'
  currentNativeSessionId = sessionId
  let replaySegment = -1
  const pendingResponseTools = new Map<string, UAEvent[]>()
  const cancelPendingResponseTools = (): void => {
    for (const queue of pendingResponseTools.values()) {
      for (const event of queue) event.state = 'cancelled'
    }
    pendingResponseTools.clear()
  }
  const updateTotal = (current: { input: number; output: number; cached: number }): void => {
    if (!latestTotal || !latestSourceTotal) {
      latestTotal = { ...current }
    } else {
      latestTotal = {
        input: latestTotal.input + (current.input >= latestSourceTotal.input
          ? current.input - latestSourceTotal.input
          : current.input),
        output: latestTotal.output + (current.output >= latestSourceTotal.output
          ? current.output - latestSourceTotal.output
          : current.output),
        cached: latestTotal.cached + (current.cached >= latestSourceTotal.cached
          ? current.cached - latestSourceTotal.cached
          : current.cached)
      }
    }
    latestSourceTotal = current
  }

  const flushTurnUsage = (): void => {
    if (emittedForTurn || !latestTotal) return
    const inputTokens = latestTurnUsage?.input ?? Math.max(0, latestTotal.input - baseline.input)
    const outputTokens = latestTurnUsage?.output ?? Math.max(0, latestTotal.output - baseline.output)
    const cachedInputTokens = latestTurnUsage?.cached ?? Math.max(0, latestTotal.cached - baseline.cached)
    push('system_notice', {
      kind: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cached_input_tokens: cachedInputTokens,
        // Occupancy: the last call's bounded input (falls back to cumulative).
        contextTokens: latestLastInput ?? latestTotal.input,
        contextWindow,
        // Whole-session running totals at the end of this turn (for 会话累计).
        sessionInputTokens: latestTotal.input,
        sessionOutputTokens: latestTotal.output,
        sessionCachedInputTokens: latestTotal.cached
      }
    })
    baseline = { ...latestTotal }
    latestTurnUsage = null
    preciseUsageForTurn = false
    emittedForTurn = true
  }

  const pushUserMessage = (payload: { id?: string; text: string }, nativeTurnId = currentTurnId): void => {
    const turnId = typeof nativeTurnId === 'string' && nativeTurnId.trim() ? nativeTurnId.trim() : undefined
    if (turnOpen && turnId && turnId === openTurnId) {
      push('user_message', { ...payload, appendedToTurn: true })
      return
    }
    flushTurnUsage()
    closeOpenTurn()
    push('user_message', payload)
    if (turnId) {
      openTurnId = turnId
      turnOpen = true
      push('turn_started', { threadId, turnId: openTurnId })
    }
    if (latestTotal) baseline = latestTotal
    emittedForTurn = false
  }

  const replaySubAgentActivity = (p: any, timestamp: unknown, details?: {
    name?: string
    prompt?: string
    message?: string
    status?: UASubAgent['status']
    endedAt?: number
  }): void => {
    const id = p.agent_thread_id || p.agentThreadId
    if (!id) return
    const prev = subAgents.get(id)
    const agentPath = p.agent_path || p.agentPath
    const pathKey = typeof agentPath === 'string' && agentPath
      ? `${currentNativeSessionId}\0${agentPath}` : undefined
    if (pathKey) subAgentIdByPath.set(pathKey, id)
    const eventId = p.event_id || p.eventId
    const candidate = collabMetadataByCall.get(`${currentNativeSessionId}\0${eventId}`)
    const metadata = details ?? (candidate?.threadId === id ? candidate : undefined)
    const name = metadata?.name || prev?.name || nativeSubAgentName(p)
    const appendEventId = String(p.kind).toLowerCase() === 'interacted' && eventId
      ? `sa-interaction-${id}-${eventId}` : undefined
    const activityTs = historicalTimestamp(p.occurred_at_ms) ?? currentRecordTs
    let next = reduceHistoricalSubAgent(prev, {
      agentThreadId: id, kind: p.kind, occurredAt: p.occurred_at_ms, eventId, name
    }, timestamp, historicalSubAgentDispatches)
    if (prev && next === prev) return
    const generationAdvanced = !!prev && next.generation !== undefined &&
      (prev.generation === undefined || next.generation > prev.generation)
    const pendingMessage = pathKey ? pendingSubAgentMessageByPath.get(pathKey) : undefined
    next = {
      ...next,
      parentThreadId: currentNativeSessionId,
      name: metadata?.name || next.name,
      prompt: readableSubAgentInput(generationAdvanced ? metadata?.prompt : prev?.prompt || metadata?.prompt || next.prompt),
      message: metadata?.message || pendingMessage || next.message,
      ...(metadata?.status && metadata.status !== 'completed'
        ? { status: metadata.status, endedAt: metadata.endedAt ?? activityTs ?? next.endedAt } : {})
    }
    if (pathKey) pendingSubAgentMessageByPath.delete(pathKey)
    if (generationAdvanced) {
      const priorKey = historicalGenerationKey(prev)
      const prior = historicalGenerations.get(priorKey)
      if (!prior) return
      prior.agent = prev
      prior.parentUpperBound = activityTs ?? prev.startedAt
      if (isSubAgentTerminal(prev.status)) prior.explicitTerminal = prev
    }
    subAgents.set(id, next)
    const nextKey = historicalGenerationKey(next)
    if (activityTs !== undefined) {
      subAgentLastEvidenceTs.set(id, Math.max(subAgentLastEvidenceTs.get(id) ?? Number.NEGATIVE_INFINITY, activityTs))
    }
    const emittedEvent = push('subagent', {
      id: appendEventId || `sa-hist-${id}-${seq}`, agents: [next]
    }, undefined, activityTs)
    const tracked = historicalGenerations.get(nextKey) ?? { agent: next, startEvent: emittedEvent }
    if (!tracked.startEvent && emittedEvent) tracked.startEvent = emittedEvent
    tracked.agent = next
    if (isSubAgentTerminal(next.status)) tracked.explicitTerminal = next
    historicalGenerations.set(nextKey, tracked)
  }

  await scanProgress(lines.length)
  const parseProgress = trackHistoryWork('parsing', lines.length, onProgress)
  for (let index = 0; index < lines.length; index++) {
    const pending = parseProgress(index)
    if (pending) await pending
    const line = lines[index]
    if (!line.trim()) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      // 跨 Agent 迁移诊断: a rollout line we can't parse would be silently lost on
      // transplant. Record it (deduped) with a bounded sample of the raw line.
      diagnostics.record({
        level: 'error',
        agentId,
        sessionId,
        code: 'rollout_line_parse_failed',
        message:
          '跨 Agent 搬运时遇到一行无法 JSON 解析的 rollout 记录，该行会被丢弃，可能导致历史缺失。',
        sample: line.slice(0, 400)
      })
      continue
    }
    currentRecordTs = historicalTimestamp(o.timestamp)
    if (currentRecordTs !== undefined) {
      lastRolloutTs = Math.max(lastRolloutTs ?? Number.NEGATIVE_INFINITY, currentRecordTs)
    } else {
      currentRecordTs = lastRolloutTs
    }
    // 需求1/2/3 — track the provider's native turn id. codex/traex stamp it on
    // task_started / turn_context / task_complete / patch_apply_end /
    // history_mutation (top-level OR under payload). user_message records carry no
    // turn_id, but the turn's task_started precedes it, so by the time we reach a
    // user turn `currentTurnId` already holds its id. Absent ⇒ stays undefined and
    // no boundary is synthesized (old id-less rollouts don't regress).
    const recordTurnId = o?.turn_id ?? o?.payload?.turn_id ??
      o?.payload?.internal_chat_message_metadata_passthrough?.turn_id
    const normalizedTurnId =
      typeof recordTurnId === 'string' && recordTurnId.trim() ? recordTurnId.trim() : undefined
    // `task_started` is the authoritative start of a new native turn. Clear an
    // older id when this new turn is id-less; otherwise mixed legacy/new rollout
    // records would incorrectly inherit the preceding turn's identity.
    if (o?.type === 'event_msg' && o?.payload?.type === 'task_started') {
      currentTurnId = normalizedTurnId
    } else if (normalizedTurnId) {
      currentTurnId = normalizedTurnId
    }
    // 跨 Agent 迁移诊断: a top-level record type we've never seen means the source
    // agent added a new rollout shape. We don't map it → it's dropped on
    // transplant. Report it so the mapping can be extended.
    if (o.type && !KNOWN_ROLLOUT_RECORDS.has(o.type)) {
      diagnostics.record({
        level: 'warn',
        agentId,
        sessionId,
        code: 'unknown_rollout_record',
        field: String(o.type),
        message: `遇到未知的 rollout 记录类型 "${o.type}"，当前不会被搬运到目标 Agent。`,
        sample: o
      })
    }
    if (o.type === 'token_usage_record') {
      const turnUsage = historicalUsage(o.payload?.turn_token_usage)
      const threadUsage = historicalUsage(o.payload?.thread_token_usage)
      latestTurnUsage = turnUsage ?? latestTurnUsage
      if (threadUsage) updateTotal(threadUsage)
      if (turnUsage || threadUsage) {
        preciseUsageForTurn = true
        emittedForTurn = false
      }
      continue
    }
    if (o.type === 'session_meta') {
      replaySegment++
      cancelPendingResponseTools()
      flushTurnUsage()
      closeOpenTurn()
      currentTurnId = undefined
      transplanted = o.payload?.uniagent_transplant === true
      cwd = o.payload?.cwd || cwd
      const nativeId = o.payload?.id ?? o.payload?.session_id
      if (typeof nativeId === 'string' && nativeId.trim()) {
        currentNativeSessionId = nativeId.trim()
      }
      const agentPath = o.payload?.agent_path ?? o.payload?.source?.subagent?.thread_spawn?.agent_path
      currentAgentPath = typeof agentPath === 'string' && agentPath.trim() ? agentPath.trim() : '/root'
      continue
    }
    if (o.type === 'turn_context') {
      model = o.payload?.model || model
      const rawVariant = Object.prototype.hasOwnProperty.call(o.payload || {}, 'model_backend_variant')
        ? o.payload.model_backend_variant
        : o.payload?.modelBackendVariant
      if (rawVariant !== undefined) {
        const turnMax = restoredMaxMode(undefined, rawVariant)
        if (turnMax !== undefined) {
          if (maxMode !== undefined && maxMode !== turnMax) sawVariantMismatch = true
          maxMode = turnMax
        }
      }
      const turnWindow = o.payload?.model_context_window ?? o.payload?.modelContextWindow
      if (typeof turnWindow === 'number') contextWindow = turnWindow
      continue
    }
    if (o.type === 'compacted') {
      pushCompaction(o.payload?.id || o.payload?.item_id || o.payload?.window_id, o.timestamp, 'top')
      if (!restoredNoticeKeys.has('compacted')) {
        restoredNoticeKeys.add('compacted')
        push('system_notice', {
          kind: 'notice',
          text: '该历史回合发生过上下文自动压缩，后续回复基于压缩后的上下文。'
        })
      }
      continue
    }
    const communication = rolloutAgentCommunication(o)
    if (communication) {
      const { author, recipient, kind, text } = communication
      const parentText = text || recoveredParentMessages.get(index)
      const parentPath = currentAgentPath.slice(0, currentAgentPath.lastIndexOf('/'))
      // A child's own rollout receives its assigned task/follow-up as native
      // collaboration records rather than user_message events. Restore only
      // messages from its direct parent so child results never pollute a parent
      // thread's main conversation.
      if (
        parentText &&
        recipient === currentAgentPath &&
        author === parentPath &&
        (kind === 'new_task' || kind === 'followup' || kind === 'message')
      ) {
        if (conversationPositions.has(String(index))) pushUserMessage({ id: communication.id, text: parentText })
      } else if (
        text &&
        recipient === currentAgentPath &&
        author.startsWith(`${currentAgentPath}/`)
      ) {
        rememberSubAgentMessage(
          author,
          text,
          communication.id,
          o.timestamp
        )
      }
      continue
    }
    // Restore response-only messages while excluding copies of visible items.
    if (o.type === 'response_item' && o.payload?.type === 'image_generation_call') {
      const p = o.payload || {}
      const id = typeof p.id === 'string' ? p.id : undefined
      if (!id || !imageEventCallIds.has(`${replaySegment}\0${id}`)) {
        push(
          'tool_call',
          {
            id,
            name: 'image_generation',
            input: p.revised_prompt,
            result: {
              status: p.status,
              ...(typeof p.saved_path === 'string' ? { savedPath: p.saved_path } : {})
            }
          },
          imageGenerationState(p.status)
        )
      }
      continue
    }
    if (
      o.type === 'response_item' &&
      (o.payload?.type === 'function_call' || o.payload?.type === 'custom_tool_call')
    ) {
      const p = o.payload || {}
      const id = String(p.call_id || p.id || '')
      if (!id || nativeTerminalCallIds.has(`${replaySegment}\0${id}`)) continue
      const event = push(
        'tool_call',
        {
          id,
          name: p.name,
          ...(typeof p.namespace === 'string' ? { namespace: p.namespace } : {}),
          input: parsePortableToolResult(p.type === 'custom_tool_call' ? p.input : p.arguments)
        },
        'running'
      )
      if (!event) continue
      const queue = pendingResponseTools.get(id) ?? []
      queue.push(event)
      pendingResponseTools.set(id, queue)
      continue
    }
    if (
      o.type === 'response_item' &&
      (o.payload?.type === 'function_call_output' || o.payload?.type === 'custom_tool_call_output')
    ) {
      const p = o.payload || {}
      const id = String(p.call_id || '')
      if (!id || nativeTerminalCallIds.has(`${replaySegment}\0${id}`)) continue
      const queue = pendingResponseTools.get(id) ?? []
      const event = queue.shift()
      if (!queue.length) pendingResponseTools.delete(id)
      if (!event) continue
      const result = parsePortableToolResult(p.output)
      const outputText = Array.isArray(p.output)
        ? p.output.map((part: any) => typeof part === 'string' ? part : part?.text || '').join('')
        : typeof p.output === 'string' ? p.output : ''
      const state = claudeToolState(
        p.uniagentTool?.state,
        o.payload?.type === 'custom_tool_call_output' && /^Script (failed|error)(?:\n|$)/i.test(outputText)
      )
      event.payload[state === 'failed' ? 'error' : 'result'] = result
      event.state = state
      continue
    }
    if (o.type === 'response_item' && o.payload?.type === 'reasoning') {
      const p = o.payload || {}
      if (completedReasoningItemIds.has(`${replaySegment}\0${p.id}`)) continue
      const textOut = collectResponseText([...(p.summary || []), ...(p.content || [])])
      const duplicateCount = eventReasoningBySegment.get(replaySegment)?.get(textOut) ?? 0
      if (duplicateCount > 0) {
        eventReasoningBySegment.get(replaySegment)?.set(textOut, duplicateCount - 1)
      } else if (textOut) {
        push('reasoning', { id: p.id, text: textOut }, 'success')
      }
      continue
    }
    if (o.type === 'response_item') {
      const p = o.payload || {}
      if (p.type === 'message') {
        const textOut = collectResponseText(p.content)
        if (!textOut) continue
        if (p.role === 'assistant') {
          if (!conversationPositions.has(String(index))) continue
          const summary = portableSubAgentMarkers(p.uniagentSubagentSummary)
          push('agent_message', {
            text: textOut,
            ...(p.phase ? { phase: p.phase } : {}),
            ...(summary ? { kind: 'subagent_summary', uniagentSubagentSummary: summary } : {})
          })
        } else if (p.role === 'user') {
          if (!conversationPositions.has(String(index))) continue
          // Skip the harness's synthetic context blobs (recommended_plugins,
          // environment_context, AGENTS.md, <skill>… ) — keep only real user text.
          if (!isSyntheticUserText(textOut)) pushUserMessage({ text: textOut })
        }
        // developer/system roles are pure instruction context → skip.
      }
      continue
    }
    if (o.type === 'history_mutation') {
      const goal = rolloutGoal(o)
      if (goal && !emittedGoalIds.has(goal.id)) {
        if (pendingGoalText === goal.text) pendingGoalText = undefined
        emittedGoalIds.add(goal.id)
        flushTurnUsage()
        closeOpenTurn()
        push('goal_message', { text: goal.text })
        if (latestTotal) baseline = latestTotal
        emittedForTurn = false
      }
      // TraeX canonical_v1 stores visible transcript items only in
      // history_mutation.display_completions. Restore those items through the
      // same UA event shapes used by the older item_completed history format.
      const completions = o.payload?.operation === 'append' &&
        Array.isArray(o.payload?.display_completions)
        ? o.payload.display_completions
        : []
      for (const [completionIndex, completion] of completions.entries()) {
        const item = completion?.item
        const itemType = String(item?.type ?? '').toLowerCase()
        if (
          itemType === 'usermessage' &&
          conversationPositions.has(`${index}:${completionIndex}`)
        ) {
          const text = collectResponseText(item.content)
          if (
            text &&
            !isSyntheticUserText(text) &&
            !(currentTurnId && restoredGoalTextsByTurn.get(currentTurnId)?.has(text)) &&
            !(typeof item.id === 'string' && knownGoalIds.has(item.id))
          ) {
            pushUserMessage({ id: item.id, text }, completion.turn_id || currentTurnId)
          }
        } else if (
          itemType === 'agentmessage' &&
          conversationPositions.has(`${index}:${completionIndex}`)
        ) {
          const text = collectResponseText(item.content)
          if (text) push('agent_message', {
            id: item.id,
            text,
            ...(item.phase ? { phase: item.phase } : {})
          })
        } else if (
          itemType === 'reasoning' &&
          !completedReasoningItemIds.has(`${replaySegment}\0${item.id}`)
        ) {
          const text = [...(item.summary_text || []), ...(item.raw_content || [])]
            .filter((part) => typeof part === 'string' && part.trim())
            .join('\n\n')
          const duplicateCount = eventReasoningBySegment.get(replaySegment)?.get(text) ?? 0
          if (duplicateCount > 0) {
            eventReasoningBySegment.get(replaySegment)?.set(text, duplicateCount - 1)
          } else if (text) {
            push('reasoning', { id: item.id, text }, 'success')
          }
        }
      }
      continue
    }
    if (o.type !== 'event_msg') continue
    const p = o.payload || {}
    const modelEvidence = historyModelEvidenceOf(p)
    if (modelEvidence.model) model = modelEvidence.model
    if (modelEvidence.hasVariant) {
      const turnMax = restoredMaxMode(undefined, modelEvidence.variant)
      if (turnMax !== undefined) {
        if (maxMode !== undefined && maxMode !== turnMax) sawVariantMismatch = true
        maxMode = turnMax
      }
    }
    if (typeof modelEvidence.contextWindow === 'number') contextWindow = modelEvidence.contextWindow
    // 跨 Agent 迁移诊断: unknown event_msg payload type = a new event we don't
    // replay. Known-but-skipped types stay silent (they're in the allowlist).
    if (p.type && !KNOWN_EVENT_MSG_TYPES.has(p.type)) {
      diagnostics.record({
        level: 'warn',
        agentId,
        sessionId,
        code: 'unknown_event_msg_type',
        field: String(p.type),
        message: `遇到未知的 event_msg 类型 "${p.type}"，该事件不会在目标 Agent 中重建。`,
        sample: o
      })
    }
    switch (p.type) {
      case 'thread_goal_updated': {
        const objective = typeof p.goal?.objective === 'string' ? p.goal.objective.trim() : ''
        pendingGoalText = p.goal?.status === 'active' && objective ? objective : undefined
        break
      }
      case 'context_compacted':
        pushCompaction(p.id || p.item_id, o.timestamp, 'event')
        if (!restoredNoticeKeys.has('compacted')) {
          restoredNoticeKeys.add('compacted')
          push('system_notice', {
            kind: 'notice',
            text: '该历史回合发生过上下文自动压缩，后续回复基于压缩后的上下文。'
          })
        }
        break
      case 'user_message':
        if (!conversationPositions.has(String(index))) break
        {
          const goalText = p.uniagentGoal === true
            ? String(p.message || '').trim()
            : pendingGoalText
          pendingGoalText = undefined
          if (goalText === String(p.message || '').trim()) {
            flushTurnUsage()
            closeOpenTurn()
            push('goal_message', { text: p.message })
            if (currentTurnId) {
              openTurnId = currentTurnId
              turnOpen = true
              push('turn_started', { threadId, turnId: openTurnId })
            }
            if (latestTotal) baseline = latestTotal
            emittedForTurn = false
            break
          }
        }
        if (
          (currentTurnId && restoredGoalTextsByTurn.get(currentTurnId)?.has(String(p.message || '').trim())) ||
          (typeof p.id === 'string' && knownGoalIds.has(p.id))
        ) break
        if (p.message && !String(p.message).startsWith('<')) {
          pushUserMessage({ text: p.message })
        }
        break
      case 'agent_message':
        pendingGoalText = undefined
        if (p.message && conversationPositions.has(String(index))) {
          const summary = portableSubAgentMarkers(p.uniagentSubagentSummary)
          push('agent_message', {
            text: p.message,
            ...(p.phase ? { phase: p.phase } : {}),
            ...(p.id ? { id: p.id } : {}),
            ...(p.delivery ? { delivery: p.delivery } : {}),
            ...(Array.isArray(p.questions) ? { questions: p.questions } : {}),
            ...(summary ? { kind: 'subagent_summary', uniagentSubagentSummary: summary } : {})
          })
        }
        break
      case 'item_completed': {
        // Codex persists the final Plan document as a completed item, separate
        // from turn/plan updates (which are only the mutable step checklist).
        // Replay the document through the normal Markdown-capable reply path and
        // retain its native id + kind so the renderer can style it like live Plan.
        const item = p.item
        const itemType = String(item?.type ?? '').toLowerCase()
        if (itemType === 'usermessage' && conversationPositions.has(String(index))) {
          const text = collectResponseText(item.content)
          if (
            text &&
            !isSyntheticUserText(text) &&
            !(currentTurnId && restoredGoalTextsByTurn.get(currentTurnId)?.has(text)) &&
            !(typeof item.id === 'string' && knownGoalIds.has(item.id))
          ) {
            pushUserMessage({ id: item.id, text })
          }
        } else if (itemType === 'agentmessage' && conversationPositions.has(String(index))) {
          const text = item.text || collectResponseText(item.content)
          if (text) push('agent_message', {
            id: item.id,
            text,
            ...(item.phase ? { phase: item.phase } : {}),
            ...(item.delivery ? { delivery: item.delivery } : {}),
            ...(Array.isArray(item.questions) ? { questions: item.questions } : {}),
            ...(p.turn_id ? { turnId: p.turn_id } : {})
          })
        } else if (itemType === 'plan' && typeof item?.text === 'string' && item.text.trim()) {
          push('agent_message', { id: item.id, text: item.text, kind: 'plan' }, 'success')
        } else if (itemType === 'reasoning') {
          const text = [...(item.summary_text || []), ...(item.raw_content || [])]
            .filter((part) => typeof part === 'string' && part.trim())
            .join('\n\n')
          const duplicateCount = eventReasoningBySegment.get(replaySegment)?.get(text) ?? 0
          if (duplicateCount > 0) {
            eventReasoningBySegment.get(replaySegment)?.set(text, duplicateCount - 1)
          } else if (text) {
            push('reasoning', { id: item.id, text }, 'success')
          }
        } else if (itemType === 'subagentactivity') {
          replaySubAgentActivity({
            ...item,
            event_id: item.id,
            occurred_at_ms: item.occurred_at_ms ?? item.occurredAt
          }, o.timestamp)
        } else if (itemType === 'collabagenttoolcall') {
          const sender = item.sender_thread_id ?? item.senderThreadId
          if (sender && sender !== currentNativeSessionId) break
          const states = item.agents_states ?? item.agentsStates ?? {}
          const receivers = item.receiver_thread_ids ?? item.receiverThreadIds ?? []
          const receiverAgents = item.receiver_agents ?? item.receiverAgents ?? []
          const ids = new Set<string>([...Object.keys(states), ...(Array.isArray(receivers) ? receivers : [])])
          const tool = String(item.tool).replace(/_/g, '').toLowerCase()
          for (const id of ids) {
            const state = states[id]
            const status = historicalCollabStatus(state?.status ?? state)
            const receiver = Array.isArray(receiverAgents)
              ? receiverAgents.find((agent: any) => (agent?.thread_id ?? agent?.threadId) === id) : undefined
            const details = {
              name: nativeSubAgentName(receiver),
              prompt: typeof item.prompt === 'string' ? item.prompt : undefined,
              message: typeof state?.message === 'string' ? state.message
                : status && state && typeof state === 'object'
                  ? Object.values(state).find((value): value is string => typeof value === 'string') : undefined
            }
            const dispatch = tool === 'spawnagent' || tool === 'resumeagent'
            const kind = dispatch ? 'started' : tool === 'sendinput' ? 'interacted' : status ?? 'running'
            const activity = { agent_thread_id: id, event_id: item.id, kind }
            replaySubAgentActivity(activity, o.timestamp, details)
            if ((dispatch || tool === 'sendinput') && status) {
              replaySubAgentActivity({ ...activity, kind: status }, o.timestamp, details)
            }
          }
        } else if (itemType === 'commandexecution') {
          push('command_exec', {
            id: item.id,
            command: Array.isArray(item.command) ? item.command.join(' ') : item.command,
            output: item.aggregated_output || item.formatted_output || item.stdout || '',
            exitCode: item.exit_code ?? null,
            durationMs: historicalDurationMs(item.durationMs ?? item.duration) ?? null
          }, item.status === 'failed' || item.status === 'declined' ||
            (typeof item.exit_code === 'number' && item.exit_code !== 0)
            ? 'failed'
            : 'success')
        } else if (itemType === 'filechange') {
          push('file_change', {
            id: item.id,
            changes: Array.isArray(item.changes)
              ? item.changes.map((change: any) => ({
                  kind: typeof change?.kind === 'string' ? change.kind : change?.kind?.type || 'update',
                  path: change?.path,
                  diff: change?.diff,
                  ...(change?.kind?.move_path ? { movePath: change.kind.move_path } : {})
                }))
              : changesFromPatch(item.changes),
            turnId: currentTurnId
          }, item.status === 'failed' || item.status === 'declined' ? 'failed' : 'success')
        } else if (itemType === 'dynamictoolcall') {
          push('tool_call', {
            id: item.id,
            name: item.tool || item.name,
            ...(responseToolNamespaces.has(`${replaySegment}\0${item.id}`)
              ? { namespace: responseToolNamespaces.get(`${replaySegment}\0${item.id}`) }
              : {}),
            input: item.arguments,
            result: item.content_items,
            raw: item
          }, item.status === 'failed' || item.success === false ? 'failed' : 'success')
        } else if (itemType === 'mcptoolcall') {
          push('tool_call', {
            id: item.id,
            provider: 'mcp',
            server: item.server,
            name: item.tool,
            ...(responseToolNamespaces.has(`${replaySegment}\0${item.id}`)
              ? { namespace: responseToolNamespaces.get(`${replaySegment}\0${item.id}`) }
              : {}),
            input: item.arguments,
            result: item.result ?? null,
            error: item.error ?? null,
            durationMs: historicalDurationMs(item.durationMs ?? item.duration) ?? null
          }, item.status === 'failed' ? 'failed' : 'success')
        }
        break
      }
      case 'agent_reasoning':
      case 'agent_reasoning_raw_content':
        if (p.text) push('reasoning', { text: p.text })
        break
      case 'image_generation_end':
        push(
          'tool_call',
          {
            id: p.call_id,
            name: 'image_generation',
            input: p.revised_prompt,
            result: {
              status: p.status,
              ...(p.saved_path ? { savedPath: p.saved_path } : {}),
              ...(typeof p.transparent_background === 'boolean'
                ? { transparentBackground: p.transparent_background }
                : {}),
              ...(p.failure != null && p.failure !== '' ? { failure: p.failure } : {})
            }
          },
          imageGenerationState(p.status)
        )
        break
      case 'collab_agent_spawn_end':
      case 'collab_agent_interaction_end':
        // Metadata was indexed in the pre-scan so activity records can consume
        // it regardless of which record happened to be persisted first.
        break
      case 'plan_update': {
        // Doc4 — a persisted plan snapshot. Normalize to the same plan_update
        // event the live path emits so restored sessions show the task list too.
        const raw: any[] = p.plan ?? p.steps ?? []
        const steps = (Array.isArray(raw) ? raw : []).map((s: any) => ({
          text: typeof s === 'string' ? s : s?.step ?? s?.text ?? s?.content ?? '',
          status: histPlanStatus(s?.status)
        }))
        if (steps.length) {
          push('plan_update', { id: 'plan-restore', steps, explanation: p.explanation })
        }
        break
      }
      case 'exec_command_end':
        push(
          'command_exec',
          {
            id: p.call_id,
            command: Array.isArray(p.command) ? p.command.join(' ') : p.command,
            output: p.aggregated_output || p.formatted_output || '',
            exitCode: p.exit_code ?? null,
            durationMs: historicalDurationMs(p.durationMs ?? p.duration) ?? null
          },
          p.exit_code === 0 ? 'success' : 'failed'
        )
        break
      case 'patch_apply_end':
        push(
          'file_change',
          // 需求1 — carry the native turnId (present on patch_apply_end itself, or
          // inherited from the turn's task_started) so a turn-scoped review can
          // filter file changes to exactly this turn. Omitted for id-less rollouts.
          { id: p.call_id, changes: changesFromPatch(p.changes), turnId: currentTurnId },
          p.success === false ? 'failed' : 'success'
        )
        break
      case 'mcp_tool_call_end':
        push(
          'tool_call',
          {
            id: p.call_id,
            provider: 'mcp',
            server: p.invocation?.server,
            name: p.invocation?.tool || p.invocation?.server,
            input: p.invocation?.arguments,
            result: p.result ?? null,
            durationMs: historicalDurationMs(p.durationMs ?? p.duration) ?? null,
            raw: p.invocation
          },
          'success'
        )
        break
      case 'token_count': {
        // Accumulate only — do NOT emit here. The single per-turn footer is
        // flushed at the turn boundary from these running figures.
        const info = p.info
        if (info?.total_token_usage && !preciseUsageForTurn) {
          const total = historicalUsage(info.total_token_usage)
          if (total) {
            updateTotal(total)
            emittedForTurn = false
          }
        }
        if (info?.last_token_usage) latestLastInput = info.last_token_usage.input_tokens
        if (info?.model_context_window) contextWindow = info.model_context_window
        break
      }
      case 'task_complete':
        pendingGoalText = undefined
        // 需求22 — do NOT flush here. A single user turn can contain MULTIPLE
        // `task_complete` records (traex emits them for compaction/summary/review
        // sub-turns), and stray `token_count` snapshots between a task_complete
        // and the next user_message re-open the turn (emittedForTurn=false),
        // which used to spill an extra usage card per sub-turn (cards > turns).
        // The single per-turn footer is flushed at the next native turn boundary
        // and at EOF, so one card maps to exactly one user turn.
        break
      case 'model_rerouted':
      case 'model_fallback':
      case 'model_verification': {
        const method = `model/${p.type.slice('model_'.length)}`
        const normalized = normalizeServerModelNotification(method, p, [])
        if (normalized && !restoredNoticeKeys.has(normalized.key)) {
          restoredNoticeKeys.add(normalized.key)
          push('system_notice', { kind: 'warning', text: normalized.text })
        }
        break
      }
      case 'sub_agent_activity': {
        replaySubAgentActivity(p, o.timestamp)
        break
      }
      default:
        break
    }
  }
  await parseProgress(lines.length)
  cancelPendingResponseTools()
  // Trailing turn (rollouts without a final task_complete).
  flushTurnUsage()
  // 需求1/2/3 — close the last native turn at EOF so the final restored turn is
  // marked done (DoneTurn) and still exposes its turnId for review / 回退.
  closeOpenTurn()
  // 改动1 — per-activity `subagent` events were already emitted in-order above, so
  // restored sessions reproduce the live inline phase rows; no aggregated snapshot
  // is needed here. `subAgents` still tracked the roster for status derivation.
  // 修复#3 — a restored rollout is FINISHED, yet a child whose last recorded
  // activity was a live tick (no explicit completed/interrupted record) would stay
  // stuck at `running` → the panel shows 正在思考 and the summary card shows 运行中
  // forever. Reconcile every still-`running` child to a terminal `completed` with a
  // trailing snapshot so both the inline "已完成" row and the roster settle.
  const unresolvedGenerations: HistoricalGenerationWindow[] = []
  for (const [key, generation] of historicalGenerations) {
    if (
      generation.explicitTerminal ||
      isSubAgentTerminal(generation.agent.status) ||
      !generation.startEvent ||
      droppedSubAgentGenerations.has(key) ||
      !subAgentEventsByGeneration.has(key)
    ) continue
    unresolvedGenerations.push({
      key,
      childId: generation.agent.agentThreadId,
      startedAt: generation.agent.startedAt,
      parentUpperBound: generation.parentUpperBound
    })
  }
  onProgress?.({ phase: 'subagents' })
  const childRolloutEnds = await resolveChildRolloutEnds(agentId, unresolvedGenerations)
  for (const [key, generation] of historicalGenerations) {
    const sa = generation.agent
    const startEvent = generation.startEvent
    if (
      generation.explicitTerminal ||
      isSubAgentTerminal(sa.status) ||
      !startEvent ||
      droppedSubAgentGenerations.has(key) ||
      !subAgentEventsByGeneration.has(key)
    ) continue
    const id = sa.agentThreadId
    // The parent can keep running for hours after this child finished. Its global
    // EOF therefore cannot bound child duration. Prefer the child's own rollout
    // end; if unavailable, use only evidence from this child (never unrelated
    // parent traffic), which safely degrades to a zero-length terminal snapshot.
    const childRolloutEnd = childRolloutEnds.get(key)
    const childEvidenceEnd = subAgentLastEvidenceTs.get(id) ?? sa.startedAt
    const boundedChildEnd =
      childRolloutEnd !== undefined &&
      (sa.startedAt === undefined || childRolloutEnd >= sa.startedAt)
        ? childRolloutEnd
        : generation.parentUpperBound ?? childEvidenceEnd
    const finalized = finalizeHistoricalSubAgent(sa, boundedChildEnd)
    if (finalized) {
      const startIndexBeforeCapacity = events.indexOf(startEvent)
      if (startIndexBeforeCapacity < 0 || !makeRoomForLifecycle([key])) continue
      // Capacity eviction may have removed events before this generation. Resolve
      // its index again, and never synthesize a terminal if its retained start
      // disappeared as part of a whole-generation eviction.
      const startIndex = events.indexOf(startEvent)
      if (startIndex < 0 || droppedSubAgentGenerations.has(key)) continue

      const nextDispatchIndex = events.findIndex((event, index) =>
        index > startIndex &&
        event.type === 'subagent' &&
        (event.payload?.agents ?? []).some((candidate: UASubAgent) =>
          candidate.agentThreadId === id && historicalGenerationKey(candidate) !== key
        )
      )
      const windowEnd = nextDispatchIndex >= 0 ? nextDispatchIndex : events.length
      const nextDispatchTs = nextDispatchIndex >= 0 ? events[nextDispatchIndex].ts : undefined
      const rawTerminalTs = finalized.endedAt ?? startEvent.ts
      const upperBound = generation.parentUpperBound ?? nextDispatchTs
      const terminalTs = Math.max(
        startEvent.ts,
        upperBound === undefined ? rawTerminalTs : Math.min(rawTerminalTs, upperBound)
      )
      const terminalPayload = {
        id: `sa-hist-final-${id}-${seq}`,
        agents: [{ ...finalized, endedAt: terminalTs }]
      }
      const terminalEvent: UAEvent = {
        sessionId: '',
        seq: seq++,
        ts: terminalTs,
        type: 'subagent',
        payload: terminalPayload
      }
      // Insert stably by timestamp inside this generation's retained window.
      // Existing equal-timestamp parent events stay before the synthetic terminal,
      // while the next dispatch remains after it even when both share a timestamp.
      let insertAt = startIndex + 1
      while (insertAt < windowEnd && events[insertAt].ts <= terminalTs) insertAt++
      events.splice(insertAt, 0, terminalEvent)
      registerSubAgentEvent(terminalEvent, [key], true)
    }
  }
  if (sawVariantMismatch) {
    push('system_notice', {
      kind: 'warning',
      text: `历史会话包含标准与 Max 两种后端记录，已按最后一轮恢复为 ${maxMode ? 'Max' : '标准'} 模式。`
    })
  }
  // Older lifecycle records omit nicknames. Read only the child header, never
  // replay its conversation into the parent timeline.
  const unnamed = [...subAgents.values()].filter(agent => subAgentDisplayName(agent) === '子智能体')
  const childFiles = await findRollouts(agentId === 'traex' ? TRAE_DIR : CODEX_DIR,
    unnamed.map(agent => agent.agentThreadId))
  const names = new Map<string, string>()
  await Promise.all(unnamed.map(async agent => {
    const childFile = childFiles.get(agent.agentThreadId)
    if (!childFile) return
    try {
      await forEachHeadLine(childFile, 64 * 1024, line => {
        let record: any
        try { record = JSON.parse(line) } catch { return true }
        if (record.type !== 'session_meta') return true
        const meta = record.payload
        const spawn = meta?.source?.subagent?.thread_spawn
        if ((meta?.id ?? meta?.session_id) !== agent.agentThreadId ||
          spawn?.parent_thread_id && spawn.parent_thread_id !== agent.parentThreadId) return false
        const name = nativeSubAgentName(meta)
        if (name) names.set(agent.agentThreadId, name)
        return false
      })
    } catch { /* Missing child metadata leaves the existing fallback intact. */ }
  }))
  for (const event of events) {
    if (event.type !== 'subagent') continue
    for (const agent of event.payload.agents as UASubAgent[]) {
      const name = names.get(agent.agentThreadId)
      if (name) agent.name = name
    }
  }
  // Synthetic terminals are inserted into their historical timestamp windows,
  // so their construction-time sequence numbers are no longer array-monotonic.
  // Restamp once at the boundary consumed by EventStream and the orchestrator.
  events.forEach((event, index) => { event.seq = index })
  return { events, cwd, model, effort, maxMode, contextWindow }
}

function changesFromPatch(changes: any): { kind: string; path: string; diff?: string; movePath?: string }[] {
  if (!changes || typeof changes !== 'object') return []
  const out: { kind: string; path: string; diff?: string; movePath?: string }[] = []
  for (const [path, c] of Object.entries<any>(changes)) {
    const kind = typeof c?.type === 'string' ? c.type : 'update'
    out.push({ kind, path, diff: kind === 'add' || kind === 'delete' ? c?.content : c?.unified_diff,
      ...(c?.move_path ? { movePath: c.move_path } : {}) })
  }
  return out
}

/** Normalize a persisted plan status → pending | in_progress | completed. */
function histPlanStatus(s: any): 'pending' | 'in_progress' | 'completed' {
  const v = String(s ?? '').toLowerCase()
  if (v === 'completed' || v === 'complete' || v === 'done') return 'completed'
  if (v === 'in_progress' || v === 'inprogress' || v === 'active' || v === 'running') return 'in_progress'
  return 'pending'
}

function historicalCollabStatus(status: unknown): UASubAgent['status'] | undefined {
  const value = typeof status === 'string'
    ? status
    : status && typeof status === 'object'
      ? ['interrupted', 'failed', 'error', 'errored', 'shutdown', 'not_found', 'notFound', 'completed']
          .find((key) => Object.prototype.hasOwnProperty.call(status, key))
      : undefined
  switch (String(value ?? '').toLowerCase()) {
    case 'interrupted': return 'interrupted'
    case 'failed':
    case 'error':
    case 'errored': return 'errored'
    case 'shutdown': return 'shutdown'
    case 'not_found':
    case 'notfound': return 'notFound'
    case 'completed': return 'completed'
    default: return undefined
  }
}

/**
 * P2 — flatten a `response_item` message's `content` array into plain text.
 * Codex uses `input_text` (user/developer) and `output_text` (assistant); we
 * accept both plus a bare `text` for forward-compat. Non-text parts (images,
 * refusals) are ignored. Returns '' when there's nothing renderable.
 */
function collectResponseText(content: any): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block) continue
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    const type = typeof block.type === 'string' ? block.type.toLowerCase() : ''
    if (type === 'input_text' || type === 'output_text' || type === 'summary_text' || type === 'text') {
      if (typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * P2 — is this `response_item` user block one of the harness's synthetic context
 * blobs rather than something the human typed? The Codex desktop wraps the first
 * turn with recommended_plugins / environment_context / AGENTS.md / <skill>… ,
 * which would otherwise pollute the restored transcript (and mis-title it).
 */
function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart()
  if (t.startsWith('<')) return true
  if (t.startsWith('# AGENTS.md') || t.startsWith('AGENTS.md')) return true
  if (t.startsWith('<recommended_plugins') || t.startsWith('<environment_context')) return true
  return false
}

async function loadClaudeEvents(
  id: string,
  onProgress?: HistoryProgressCallback
): Promise<{ events: UAEvent[]; cwd?: string; model?: string; effort?: string }> {
  // Find the project jsonl containing this session id.
  let file: string | null = null
  try {
    const projects = await readdir(CLAUDE_PROJECTS)
    for (const proj of projects) {
      const candidate = join(CLAUDE_PROJECTS, proj, id + '.jsonl')
      if (existsSync(candidate)) {
        file = candidate
        break
      }
    }
  } catch {
    /* ignore */
  }
  if (!file) return { events: [] }
  let text = ''
  try {
    text = (await readHistoryFile(file, onProgress)).toString('utf8')
  } catch {
    return { events: [] }
  }
  const events: UAEvent[] = []
  let seq = 0
  let cwd: string | undefined
  let model: string | undefined
  let currentRecordTs: number | undefined
  let lastRecordTs: number | undefined
  const pendingTools = new Map<string, { event: UAEvent; assistantUuid?: string }[]>()
  const taskPlan = new Map<string, { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>()
  const taskPlanId = `plan-${id}`
  let openTurnId: string | undefined
  const push = (type: UAEvent['type'], payload: any, state?: UAEvent['state']): void => {
    events.push({ sessionId: '', seq: seq++, ts: currentRecordTs ?? lastRecordTs ?? 0, type, state, payload })
  }
  const lines = text.split('\n')
  const report = trackHistoryWork('parsing', lines.length, onProgress)
  for (let index = 0; index < lines.length; index++) {
    const pending = report(index)
    if (pending) await pending
    const line = lines[index]
    if (!line.trim()) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      // 跨 Agent 迁移诊断: unparsable Claude jsonl line → dropped on transplant.
      diagnostics.record({
        level: 'error',
        agentId: 'claude',
        sessionId: id,
        code: 'claude_line_parse_failed',
        message:
          '跨 Agent 搬运时遇到一行无法 JSON 解析的 Claude 会话记录，该行会被丢弃，可能导致历史缺失。',
        sample: line.slice(0, 400)
      })
      continue
    }
    currentRecordTs = historicalTimestamp(o.timestamp)
    if (currentRecordTs !== undefined) lastRecordTs = currentRecordTs
    else currentRecordTs = lastRecordTs
    if (!cwd && o.cwd) cwd = o.cwd
    if (!model && o.message?.model) model = o.message.model
    const recordStart = events.length
    // 跨 Agent 迁移诊断: unknown Claude record type = a shape we don't reconstruct.
    if (o.type && !KNOWN_CLAUDE_RECORDS.has(o.type)) {
      diagnostics.record({
        level: 'warn',
        agentId: 'claude',
        sessionId: id,
        code: 'unknown_claude_record',
        field: String(o.type),
        message: `遇到未知的 Claude 记录类型 "${o.type}"，当前不会被搬运到目标 Agent。`,
        sample: o
      })
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      push('context_compaction', { id: `claude-compact-${o.uuid || index}` }, 'success')
    } else if (o.type === 'user') {
      const c = o.message?.content
      // Harness-only records (compact summary + continuation prompt, image-size
      // notes) are transcript bookkeeping; replaying them fabricates user turns.
      const internal = isClaudeInternalUserRecord(o)
      const userEventType = o.uniagentGoal === true ? 'goal_message' : 'user_message'
      const visibleUser = !internal && (typeof c === 'string' && !c.startsWith('<') || Array.isArray(c) && c.some((block: any) => block.type === 'text' && block.text))
      if (visibleUser && openTurnId) push('turn_completed', { turnId: openTurnId }, 'success')
      if (typeof c === 'string') {
        if (!internal && !c.startsWith('<')) push(userEventType, { text: c })
      } else if (Array.isArray(c)) {
        for (const block of c) {
          reportUnknownClaudeBlock(block, 'claude', id)
          if (block.type === 'text' && block.text) {
            if (!internal) push(userEventType, { text: block.text })
          }
          else if (block.type === 'tool_result') {
            const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
            const candidates = pendingTools.get(id) ?? []
            const linkedUuid = o.sourceToolAssistantUUID || o.parentUuid
            const index = linkedUuid
              ? candidates.findIndex((candidate) => candidate.assistantUuid === linkedUuid)
              : candidates.length - 1
            const matchIndex = index >= 0 ? index : candidates.length - 1
            const pending = matchIndex >= 0 ? candidates.splice(matchIndex, 1)[0] : undefined
            if (!candidates.length) pendingTools.delete(id)
            const state = claudeToolState(o.uniagentTool?.state, block.is_error)
            if (pending) {
              const value = parsePortableToolResult(block.content)
              if (pending.event.type === 'command_exec') {
                pending.event.payload.output = claudeToolText(block.content)
                if (o.uniagentTool?.exitCode !== undefined) {
                  pending.event.payload.exitCode = o.uniagentTool.exitCode
                }
              } else if (state === 'failed') {
                pending.event.payload.error = value
              } else {
                pending.event.payload.result = value
              }
              pending.event.state = state
              if (state === 'success') {
                const steps = updateClaudeTaskPlan(taskPlan, pending.event.payload.name, pending.event.payload.input, o.toolUseResult ?? o.tool_use_result)
                if (steps) push('plan_update', { id: taskPlanId, steps }, steps.every(step => step.status === 'completed') ? 'success' : 'running')
                const change = claudeFileChange(
                  pending.event.payload.name,
                  pending.event.payload.input,
                  o.toolUseResult
                )
                if (change) push('file_change', { id: `${id}-change`, changes: [change] }, 'success')
              }
            } else {
              push(
                'tool_call',
                { id, name: o.uniagentTool?.name, result: parsePortableToolResult(block.content) },
                state
              )
            }
          }
        }
      }
    } else if (o.type === 'assistant') {
      const content = o.message?.content || []
      for (const block of content) {
        reportUnknownClaudeBlock(block, 'claude', id)
        if (block.type === 'text' && block.text) {
          const summary = portableSubAgentMarkers(o.uniagentSubagentSummary)
          push('agent_message', {
            text: block.text,
            ...(o.message?.stop_reason === 'end_turn' ? { phase: 'final_answer' } : {}),
            ...(summary ? { kind: 'subagent_summary', uniagentSubagentSummary: summary } : {})
          })
        }
        else if (block.type === 'thinking' && block.thinking)
          push('reasoning', { text: block.thinking })
        else if (block.type === 'tool_use') {
          const event: UAEvent = {
            sessionId: '',
            seq: seq++,
            ts: currentRecordTs ?? lastRecordTs ?? 0,
            type: block.name === 'Bash' ? 'command_exec' : 'tool_call',
            state: 'running',
            payload: {
              id: block.id,
              name: block.name === PORTABLE_IMAGE_TOOL ? 'image_generation' : block.name,
              command: block.input?.command,
              input: block.name === PORTABLE_IMAGE_TOOL ? block.input?.prompt : block.input
            }
          }
          events.push(event)
          const queue = pendingTools.get(String(block.id || '')) ?? []
          queue.push({ event, assistantUuid: typeof o.uuid === 'string' ? o.uuid : undefined })
          pendingTools.set(String(block.id || ''), queue)
        }
      }
    }
    // A UUID cuts at the whole native message, never at an individual text or
    // tool block. Expose only its last visible message with no outstanding tool pair.
    const last = events[events.length - 1]
    const blocks = o.message?.content
    if (
      events.length > recordStart &&
      typeof o.uuid === 'string' && o.uuid && !o.isSidechain &&
      pendingTools.size === 0 &&
      !(Array.isArray(blocks) && blocks.some((block: any) => block.type === 'tool_use' || block.type === 'tool_result')) &&
      last && ['user_message', 'goal_message', 'agent_message'].includes(last.type)
    ) last.payload.nativeMessageId = o.uuid
    if (o.type === 'user' && events.slice(recordStart).some(event => event.type === 'user_message' || event.type === 'goal_message') && typeof o.uuid === 'string') {
      openTurnId = o.uuid
      push('turn_started', { turnId: openTurnId, sessionId: id })
    }
  }
  if (openTurnId) push('turn_completed', { turnId: openTurnId }, 'success')
  await report(lines.length)
  if (cwd) {
    const groups: Array<{ start: number; end: number }> = []
    let start = 0
    for (let index = 1; index <= events.length; index++) {
      if (index === events.length || events[index].type === 'user_message' || events[index].type === 'goal_message') {
        groups.push({ start, end: index })
        start = index
      }
    }
    for (const group of groups.reverse()) {
      const changes = events.slice(group.start, group.end).filter((event) => event.type === 'file_change')
      if (!changes.length) continue
      try {
        const files = await filesFromTurnChanges(changes, cwd)
        const diff = files.map((file) => file.unifiedDiff).filter(Boolean).join('')
        if (diff) {
          const last = events[group.end - 1]
          events.splice(group.end, 0, { sessionId: '', seq: 0, ts: last.ts, type: 'diff_update', payload: { diff } })
        }
      } catch {
        // Keep the recorded file_change cards even if a historical patch is incomplete.
      }
    }
    events.forEach((event, index) => { event.seq = index })
  }
  return { events, cwd, model }
}

function claudeToolText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((value: any) => typeof value === 'string' ? value : value?.text || '').join('')
    : typeof content === 'string'
      ? content
      : JSON.stringify(content ?? '')
}

function parsePortableToolResult(content: unknown): unknown {
  if (typeof content !== 'string') return content
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

function claudeToolState(value: unknown, isError: unknown): UAEvent['state'] {
  if (isError === true || value === 'failed') return 'failed'
  if (value === 'cancelled') return 'cancelled'
  return 'success'
}

/**
 * 跨 Agent 迁移诊断: report a Claude content block whose type we don't map. A new
 * block type (beyond text/thinking/tool_use/tool_result/image/redacted_thinking)
 * would be silently dropped on transplant.
 */
function reportUnknownClaudeBlock(block: any, agentId: string, sessionId: string): void {
  if (!block || typeof block !== 'object') return
  if (block.type && !KNOWN_CLAUDE_BLOCKS.has(block.type)) {
    diagnostics.record({
      level: 'warn',
      agentId,
      sessionId,
      code: 'unknown_claude_block',
      field: String(block.type),
      message: `遇到未知的 Claude 内容块类型 "${block.type}"，该内容不会在目标 Agent 中重建。`,
      sample: block
    })
  }
}

// ---- small helpers ----

function textFromBlocks(blocks: any[]): string {
  return blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text || '')
    .join('')
}

/** Read up to `bytes` from the start of a file (for bounded head scans). */
async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.slice(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}
