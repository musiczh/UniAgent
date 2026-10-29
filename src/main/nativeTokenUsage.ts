import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import {
  createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import type {
  KabooDailyTrend, KabooProfile, KabooProfileResult, KabooStats, KabooUsageQuery
} from '../shared/types'
import { validateTokenUsageQuery } from '../shared/tokenUsageQuery.ts'
import { isDistributionAgent } from '../shared/distribution.ts'
import { CODEX_DIR, TRAE_DIR, CLAUDE_PROJECTS } from './history'
import { privateNodeBin } from './deepseekNodeRuntime'
import { computeCost, loadPricing, type PricingFile } from './pricing'
import { logTokenUsage } from './tokenUsageLog.ts'
import { resolveUserDataHome } from './userData'

const execFileP = promisify(execFile)

/**
 * UniAgent-native Token usage (本机全量口径). A second, Kaboo-independent source:
 * instead of the server-side profile, this scans each agent's OWN on-disk history
 * — including sessions run outside UniAgent (terminal / other tools) — and folds
 * every session's native token snapshot into the SAME KabooProfile shape the panel
 * already renders. So the UI needs zero new components: it just points at a
 * different IPC and gets the same DTO back.
 *
 * Why this exists (vs Kaboo): (1) works with no bytedcli / no login; (2) reads
 * straight off disk with no server aggregation lag, so a just-finished turn shows
 * up on the next refresh. The two sources overlap heavily and must NOT be summed
 * — the panel toggles between them.
 *
 * Cost model = "scan + incremental cache + aggregate". The agents' rollout/jsonl
 * files are the ledger; we only cache the parse result keyed by (mtimeMs,size),
 * exactly like history.ts's titleCache, so steady-state refresh only re-parses the
 * one file that changed (or, for the huge active rollout, tail-reads its last
 * cumulative snapshot). No SQLite, no new deps, no re-tokenizing.
 */

/** A normalized usage contribution attributed to one native event time. */
interface UsageRecord {
  filePath: string
  agentId: 'codex' | 'traex' | 'claude' | 'kimi' | 'grok' | 'zcode' | 'deepseek'
  modelId?: string
  projectPath?: string
  updatedAt: number
  /** Total input (cache-hit + cache-write folded in); cached is a subset. */
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Estimated via pricing.ts (null when the model is unpriceable). */
  cost: number | null
}

/** One file's latest summary plus optional per-day deltas for cross-day sessions. */
interface SessionUsage extends UsageRecord {
  mtimeMs: number
  size: number
  startedAt: number
  daily?: Record<string, UsageRecord[]>
}

interface CacheFile {
  version: number
  timeZone: string
  sessions: Record<string, SessionUsage>
  days: Record<string, UsageRecord[]>
  finalizedDays: string[]
  historyStart?: string
  /** DeepSeek ledger decoder revision that produced the buckets above. */
  deepseekDecoder?: number
  /** Hourly-trend revision that produced the day buckets above. */
  hourlyRevision?: number
}

interface CacheState {
  timeZone: string
  sessions: Map<string, SessionUsage>
  days: Map<string, UsageRecord[]>
  finalizedDays: Set<string>
  historyStart?: string
  deepseekDecoder: number
  hourlyRevision: number
}

interface Counters {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

interface HistoryJob {
  file: string
  agentId: SessionUsage['agentId']
  mtimeMs: number
  size: number
  startDay: string
  endDay: string
}

const CACHE_VERSION = 6
/**
 * Bumped when the DeepSeek ledger decoder changes in a way that invalidates the
 * usage already persisted in the cache. DeepSeek session bundles are concatenated
 * Zstandard frames; revision 0 builds decoded only the first frame, so every
 * DeepSeek session was cached empty and its days were finalized without usage.
 */
const DEEPSEEK_DECODER_REVISION = 1
/**
 * Bumped when the day-view hourly buckets need a different parse granularity.
 * Codex/TraeX single-day sessions used to be summarized from the file mtime, so
 * their whole day landed in the last-modified hour; those days must be rebuilt
 * from the detailed ledger before they can show an honest hourly curve.
 */
const HOURLY_TREND_REVISION = 1
const CACHE_PATH = workerData?.cachePath || join(resolveUserDataHome(join(homedir(), '.uniagent-public')), 'token-usage-cache.json')
const NATIVE_USER_DATA = workerData?.userDataHome || resolveUserDataHome()
// The active rollout grows unbounded; its latest usage snapshot sits at the tail,
// so we only read this trailing window instead of the whole multi-MB file.
const TAIL_WINDOW = 512 * 1024

let cacheState: CacheState | null = null
let usageWorker: Worker | undefined
let requestId = 0
let workerNeedsRefresh = false
const workerRequests = new Map<number, (result: KabooProfileResult) => void>()

function queryWorker(value: unknown): Promise<KabooProfileResult> {
  if (!usageWorker) {
    const worker = new Worker(new URL('./nativeTokenUsageWorker.js', import.meta.url), {
      workerData: { cachePath: CACHE_PATH, userDataHome: NATIVE_USER_DATA }
    })
    usageWorker = worker
    worker.on('message', ({ id, result }) => {
      workerRequests.get(id)?.(result)
      workerRequests.delete(id)
    })
    const failed = (): void => {
      if (usageWorker !== worker) return
      usageWorker = undefined
      for (const resolve of workerRequests.values()) resolve({ unavailable: true, reason: 'service' })
      workerRequests.clear()
    }
    worker.on('error', failed)
    worker.on('exit', failed)
    worker.unref()
  }
  const id = ++requestId
  return new Promise((resolve) => {
    workerRequests.set(id, resolve)
    usageWorker!.postMessage({ id, value, refresh: workerNeedsRefresh })
    workerNeedsRefresh = false
  })
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function loadCache(timeZone: string): CacheState {
  if (cacheState?.timeZone === timeZone) return cacheState
  try {
    if (existsSync(CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as CacheFile
      if (raw?.version === CACHE_VERSION && raw.timeZone === timeZone && raw.sessions && raw.days &&
          Array.isArray(raw.finalizedDays)) {
        const sessions = new Map(Object.entries(raw.sessions))
        let days = new Map(Object.entries(raw.days))
        let finalizedDays = new Set(raw.finalizedDays)
        if ((raw.deepseekDecoder || 0) < DEEPSEEK_DECODER_REVISION) {
          // Drop the empty DeepSeek sessions so they are re-read, and rebuild the day
          // buckets: the finalized ones predate their usage. Other agents' buckets are
          // cheap to rebuild from the retained sessions and never re-read the ledgers.
          for (const [file, session] of sessions) if (session.agentId === 'deepseek') sessions.delete(file)
          days = new Map()
          finalizedDays = new Set()
        }
        if ((raw.hourlyRevision || 0) < HOURLY_TREND_REVISION) {
          // Only days whose Codex/TraeX sessions were summarized from the file mtime
          // need a rebuild; the next day-view query re-reads them in detail.
          for (const session of sessions.values()) {
            if ((session.agentId !== 'codex' && session.agentId !== 'traex') || session.daily) continue
            const day = localDay(session.updatedAt, timeZone)
            days.delete(day)
            finalizedDays.delete(day)
          }
        }
        cacheState = {
          timeZone,
          sessions,
          days,
          finalizedDays,
          historyStart: raw.historyStart,
          deepseekDecoder: DEEPSEEK_DECODER_REVISION,
          hourlyRevision: HOURLY_TREND_REVISION
        }
        return cacheState
      }
    }
  } catch {
    /* corrupt / old-version cache → rebuild from scratch (only slower) */
  }
  cacheState = {
    timeZone, sessions: new Map(), days: new Map(), finalizedDays: new Set(),
    deepseekDecoder: DEEPSEEK_DECODER_REVISION, hourlyRevision: HOURLY_TREND_REVISION
  }
  return cacheState
}

function saveCache(state: CacheState): void {
  try {
    mkdirSync(join(CACHE_PATH, '..'), { recursive: true })
    const out: CacheFile = {
      version: CACHE_VERSION,
      timeZone: state.timeZone,
      sessions: Object.fromEntries(state.sessions),
      days: Object.fromEntries(state.days),
      finalizedDays: [...state.finalizedDays].sort(),
      deepseekDecoder: state.deepseekDecoder,
      hourlyRevision: state.hourlyRevision,
      ...(state.historyStart ? { historyStart: state.historyStart } : {})
    }
    writeFileSync(CACHE_PATH, JSON.stringify(out), 'utf8')
  } catch {
    /* best effort — a missing cache just means a slower cold start */
  }
}

/** Read the latest precise thread total, falling back to legacy `token_count`. */
/**
 * Rollout lines are mostly large message/response payloads. A cheap substring
 * test before JSON.parse keeps multi-hundred-MB compressed history scans fast.
 */
const CODEX_LEDGER_MARKERS = ['"token_usage_record"', '"token_count"', '"session_meta"', '"turn_context"']
function isCodexLedgerLine(line: string): boolean {
  return CODEX_LEDGER_MARKERS.some((marker) => line.includes(marker))
}

async function readLastUsage(file: string, size: number): Promise<{ total: any; precise: boolean } | null> {
  const start = Math.max(0, size - TAIL_WINDOW)
  const fh = await open(file, 'r')
  try {
    const len = size - start
    if (len <= 0) return null
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    let text = buf.toString('utf8')
    // Drop the leading partial line when we didn't start at byte 0.
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const lines = text.split('\n')
    let fallback: any | null = null
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!isCodexLedgerLine(lines[i])) continue
      try {
        const o = JSON.parse(lines[i])
        if (o?.type === 'token_usage_record' && o.payload?.thread_token_usage) {
          return { total: o.payload.thread_token_usage, precise: true }
        }
        if (!fallback && o?.payload?.type === 'token_count') {
          fallback = o.payload.info?.total_token_usage
        }
      } catch {
        /* partial/broken line — keep scanning older lines */
      }
    }
    return fallback ? { total: fallback, precise: false } : null
  } finally {
    await fh.close()
  }
  return null
}

/** Stream complete JSONL records so a multi-MiB session_meta cannot hide metadata. */
async function readCodexMetadata(
  file: string, fallbackAt: number
): Promise<{ cwd?: string; model?: string; startedAt: number; inherited: boolean }> {
  let cwd: string | undefined
  let model: string | undefined
  let startedAt = fallbackAt
  let inherited = false
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!isCodexLedgerLine(line)) continue
    let item: any
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    const at = instant(item.timestamp)
    if (at !== undefined) startedAt = Math.min(startedAt, at)
    if (item.type === 'session_meta') {
      cwd = cwd || item.payload?.cwd
      inherited ||= !!(item.payload?.history_base || item.payload?.forked_from_id)
    }
    if (item.type === 'turn_context') {
      cwd = cwd || item.payload?.cwd
      model = model || item.payload?.model
    }
    if (cwd && model) break
  }
  return { cwd, model, startedAt, inherited }
}

function instant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function counters(value: any): Counters {
  return {
    inputTokens: num(value?.input_tokens),
    outputTokens: num(value?.output_tokens),
    cachedInputTokens: num(value?.cached_input_tokens),
    cacheWriteTokens: num(value?.cache_write_input_tokens ?? value?.cache_creation_input_tokens),
    reasoningTokens: num(value?.reasoning_output_tokens)
  }
}

function counterDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current
}

function deltaCounters(current: Counters, previous?: Counters): Counters {
  if (!previous) return current
  return {
    inputTokens: counterDelta(current.inputTokens, previous.inputTokens),
    outputTokens: counterDelta(current.outputTokens, previous.outputTokens),
    cachedInputTokens: counterDelta(current.cachedInputTokens, previous.cachedInputTokens),
    cacheWriteTokens: counterDelta(current.cacheWriteTokens, previous.cacheWriteTokens),
    reasoningTokens: counterDelta(current.reasoningTokens, previous.reasoningTokens)
  }
}

function addCounters(target: Counters, value: Counters): void {
  target.inputTokens += value.inputTokens
  target.outputTokens += value.outputTokens
  target.cachedInputTokens += value.cachedInputTokens
  target.cacheWriteTokens += value.cacheWriteTokens
  target.reasoningTokens += value.reasoningTokens
}

function hasUsage(value: Counters): boolean {
  return value.inputTokens > 0 || value.outputTokens > 0 || value.cachedInputTokens > 0 ||
    value.cacheWriteTokens > 0 || value.reasoningTokens > 0
}

async function readPreciseTotal(file: string, latest: any): Promise<Counters> {
  const total = counters(undefined)
  let previous: Counters | undefined
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!isCodexLedgerLine(line)) continue
    let item: any
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    if (item.type === 'token_usage_record' && item.payload?.thread_token_usage) {
      const first = counters(item.payload.thread_token_usage)
      addCounters(total, deltaCounters(first, previous))
      addCounters(total, deltaCounters(counters(latest), first))
      return total
    }
    if (item?.payload?.type === 'token_count' && item.payload.info?.total_token_usage) {
      const current = counters(item.payload.info.total_token_usage)
      addCounters(total, deltaCounters(current, previous))
      previous = current
    }
  }
  return counters(latest)
}

async function parseCodexSummary(
  file: string,
  agentId: 'codex' | 'traex',
  mtimeMs: number,
  size: number,
  pricing: PricingFile,
  timeZone: string,
  identity = file
): Promise<SessionUsage> {
  const metadata = await readCodexMetadata(file, mtimeMs)
  if (metadata.inherited) return parseCodexDetailed(file, agentId, mtimeMs, size, pricing, timeZone, identity)
  const latest = await readLastUsage(file, size)
  const usage = latest?.precise
    ? await readPreciseTotal(file, latest.total)
    : counters(latest?.total)
  const cost = computeCost(usage, metadata.model, pricing)
  return {
    filePath: identity, mtimeMs, size, agentId,
    modelId: metadata.model,
    projectPath: metadata.cwd,
    startedAt: metadata.startedAt,
    updatedAt: mtimeMs,
    ...usage,
    cost
  }
}

function addDailyRecord(
  buckets: Map<string, Map<string, UsageRecord>>,
  day: string,
  value: UsageRecord,
  timeZone: string
): void {
  let records = buckets.get(day)
  if (!records) {
    records = new Map()
    buckets.set(day, records)
  }
  const hour = localHourWeekday(value.updatedAt, timeZone).hour
  const key = `${value.filePath}\u0000${value.modelId || ''}\u0000${value.projectPath || ''}\u0000${hour}`
  const current = records.get(key)
  if (!current) {
    records.set(key, value)
    return
  }
  current.inputTokens += value.inputTokens
  current.outputTokens += value.outputTokens
  current.cachedInputTokens += value.cachedInputTokens
  current.cacheWriteTokens += value.cacheWriteTokens
  current.reasoningTokens += value.reasoningTokens
  current.cost = current.cost === null || value.cost === null ? null : current.cost + value.cost
}

function serializeBuckets(buckets: Map<string, Map<string, UsageRecord>>): Record<string, UsageRecord[]> {
  return Object.fromEntries([...buckets].map(([day, records]) => [day, [...records.values()]]))
}

async function parseCodexDetailed(
  file: string,
  agentId: 'codex' | 'traex',
  mtimeMs: number,
  size: number,
  pricing: PricingFile,
  timeZone: string,
  identity = file
): Promise<SessionUsage> {
  let cwd: string | undefined
  let model: string | undefined
  let startedAt = mtimeMs
  let previous: Counters | undefined
  const total = counters(undefined)
  let pendingPrecise = false
  const seenResponses = new Set<string>()
  const buckets = new Map<string, Map<string, UsageRecord>>()
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!isCodexLedgerLine(line)) continue
    let item: any
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    const at = instant(item.timestamp) ?? mtimeMs
    startedAt = Math.min(startedAt, at)
    if (item.type === 'session_meta') cwd = cwd || item.payload?.cwd
    if (item.type === 'turn_context') {
      cwd = item.payload?.cwd || cwd
      model = item.payload?.model || model
    }
    let delta: Counters | undefined
    if (item.type === 'token_usage_record' && item.payload?.usage) {
      const responseId = typeof item.payload.response_id === 'string' ? item.payload.response_id : ''
      if (responseId && seenResponses.has(responseId)) continue
      if (responseId) seenResponses.add(responseId)
      delta = counters(item.payload.usage)
      pendingPrecise = true
    } else if (item?.payload?.type === 'token_count' && item.payload.info?.total_token_usage) {
      const current = counters(item.payload.info.total_token_usage)
      delta = pendingPrecise ? undefined : deltaCounters(current, previous)
      previous = current
      pendingPrecise = false
    } else {
      continue
    }
    if (!delta || !hasUsage(delta)) continue
    addCounters(total, delta)
    addDailyRecord(buckets, localDay(at, timeZone), {
      filePath: identity,
      agentId,
      modelId: model,
      projectPath: cwd,
      updatedAt: at,
      ...delta,
      cost: computeCost(delta, model, pricing)
    }, timeZone)
  }
  return {
    filePath: identity, mtimeMs, size, agentId,
    modelId: model,
    projectPath: cwd,
    startedAt,
    updatedAt: mtimeMs,
    ...total,
    cost: computeCost(total, model, pricing),
    daily: serializeBuckets(buckets)
  }
}

async function parseClaude(
  file: string, mtimeMs: number, size: number, pricing: PricingFile, timeZone: string
): Promise<SessionUsage> {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    /* vanished / unreadable → empty session */
  }
  // Claude streams each assistant message to disk multiple times (partial + final
  // + resumed replays) under one stable message.id; sum usage once per id.
  const seen = new Set<string>()
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0
  let cwd: string | undefined
  let model: string | undefined
  let startedAt = mtimeMs
  const buckets = new Map<string, Map<string, UsageRecord>>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && o.cwd) cwd = o.cwd
    const at = instant(o.timestamp) ?? mtimeMs
    startedAt = Math.min(startedAt, at)
    if (o.type !== 'assistant') continue
    const m = o.message || {}
    if (!model && m.model) model = m.model
    const id = typeof m.id === 'string' ? m.id : ''
    const u = m.usage
    if (!u || (id && seen.has(id))) continue
    if (id) seen.add(id)
    // Fold cache-read + cache-write into total input so `inputTokens` is the true
    // billable input; `cachedInputTokens` stays a subset for the breakdown.
    const usage: Counters = {
      inputTokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
      outputTokens: num(u.output_tokens),
      cachedInputTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      reasoningTokens: num(u.output_tokens_details?.thinking_tokens)
    }
    input += usage.inputTokens
    cacheRead += usage.cachedInputTokens
    cacheWrite += usage.cacheWriteTokens
    output += usage.outputTokens
    reasoning += usage.reasoningTokens
    addDailyRecord(buckets, localDay(at, timeZone), {
      filePath: file,
      agentId: 'claude',
      modelId: m.model || model,
      projectPath: cwd,
      updatedAt: at,
      ...usage,
      cost: computeCost(usage, m.model || model, pricing)
    }, timeZone)
  }
  const cost = computeCost({ inputTokens: input, outputTokens: output, cachedInputTokens: cacheRead }, model, pricing)
  return {
    filePath: file, mtimeMs, size, agentId: 'claude',
    modelId: model, projectPath: cwd, startedAt, updatedAt: mtimeMs,
    inputTokens: input, outputTokens: output, cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite, reasoningTokens: reasoning, cost,
    daily: serializeBuckets(buckets)
  }
}

/** Native usage ledgers only; ignore caches, migrated generations and transcripts. */
async function nativeFiles(root: string, accept: (name: string) => boolean): Promise<string[]> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') files.push(...await nativeFiles(join(root, entry.name), accept))
    else if (entry.isFile() && accept(entry.name)) files.push(join(root, entry.name))
  }
  return files
}

/**
 * DeepSeek session bundles are a concatenated-frame Zstandard container: every
 * appended event batch is its own frame. Node's Zstandard API decodes a single
 * frame per call, so decoding such a bundle directly yields only the session
 * header. Walk the frame structure and decode every frame separately instead.
 * The final frame may still be torn while a session is being written; it is
 * skipped and recovered by the next refresh.
 */
const ZSTD_FRAME_DECODER = `
const fs = require('node:fs')
const { zstdDecompressSync } = require('node:zlib')
function decodeZstd(input) {
  const chunks = []
  let offset = 0
  while (offset < input.length) {
    const start = offset
    if (input.length - offset < 4 || input.readUInt32LE(offset) !== 0xfd2fb528) {
      throw new Error('invalid frame magic at byte ' + offset)
    }
    offset += 4
    if (offset === input.length) break
    const descriptor = input[offset++]
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit at byte ' + (offset - 1))
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (input.length - offset < headerBytes) break
    offset += headerBytes
    let lastBlock = false
    let torn = false
    while (!lastBlock) {
      if (input.length - offset < 3) { torn = true; break }
      const block = input.readUIntLE(offset, 3)
      offset += 3
      lastBlock = (block & 1) !== 0
      const blockType = (block >>> 1) & 3
      if (blockType === 3) throw new Error('reserved block type at byte ' + (offset - 3))
      const payloadBytes = blockType === 1 ? 1 : block >>> 3
      if (input.length - offset < payloadBytes) { torn = true; break }
      offset += payloadBytes
    }
    if (torn) break
    if (checksum) {
      if (input.length - offset < 4) break
      offset += 4
    }
    chunks.push(zstdDecompressSync(input.subarray(start, offset)))
  }
  return Buffer.concat(chunks)
}
`
const ZSTD_DECODE_SCRIPT = `${ZSTD_FRAME_DECODER}
process.stdout.write(decodeZstd(fs.readFileSync(process.argv[1])))
`
const ZSTD_BATCH_DECODE_SCRIPT = `${ZSTD_FRAME_DECODER}
const jobs = JSON.parse(fs.readFileSync(0, 'utf8'))
for (const job of jobs) {
  try {
    fs.writeFileSync(job.dst, decodeZstd(fs.readFileSync(job.src)), { mode: 0o600 })
  } catch (error) {
    fs.writeFileSync(job.error, String((error && error.message) || error))
  }
}
`

let decoderNodePromise: Promise<string> | undefined

/**
 * External Node runtime with Zstandard support. Electron's bundled Node predates
 * the API, so the ledger decoder runs in the Node that DeepSeek itself requires:
 * the app-private runtime when one was installed, otherwise the user's `node`.
 */
function decoderNode(): Promise<string> {
  decoderNodePromise ??= (async () => {
    const override = process.env.UNIAGENT_TOKEN_NODE_BIN
    if (override) {
      if (await nodeSupportsZstd(override)) return override
      throw new Error('native_usage_decoder_unavailable')
    }
    const candidates: string[] = []
    try {
      const bin = privateNodeBin(join(NATIVE_USER_DATA, 'deepseek'))
      if (bin) candidates.push(join(bin, process.platform === 'win32' ? 'node.exe' : 'node'))
    } catch { /* a damaged private-runtime record must not break the stats panel */ }
    candidates.push('node')
    for (const candidate of candidates) if (await nodeSupportsZstd(candidate)) return candidate
    throw new Error('native_usage_decoder_unavailable')
  })().catch((error: unknown) => {
    // Allow a later install/repair of Node to be picked up without an app restart.
    decoderNodePromise = undefined
    throw error
  })
  return decoderNodePromise
}

async function nodeSupportsZstd(command: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(command, ['-p', "typeof require('node:zlib').zstdDecompressSync"], { timeout: 8_000 })
    return stdout.trim() === 'function'
  } catch {
    return false
  }
}

function jsonLine(line: string): any | undefined {
  let item: any
  try { item = JSON.parse(line) } catch { return undefined }
  return item && typeof item === 'object' && !Array.isArray(item) ? item : undefined
}

async function* zstdJsonLines(file: string): AsyncGenerator<any> {
  const command = await decoderNode()
  const child = spawn(command, ['-e', ZSTD_DECODE_SCRIPT, file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < 2_000) stderr = (stderr + chunk).slice(0, 2_000) })
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => {
      // A failed spawn never opens stdout; close the reader instead of waiting forever.
      // Re-probe next time: the runtime may have been removed or replaced.
      decoderNodePromise = undefined
      child.stdout?.destroy()
      resolve({ code: null, error })
    })
    child.once('close', (code) => resolve({ code }))
  })
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const item = jsonLine(line)
      if (item) yield item
    }
    const { code, error } = await completion
    if (error || code !== 0) {
      const reason = error ? (error as NodeJS.ErrnoException).code || error.message : code
      throw new Error(`native_usage_decode_failed:${reason}${stderr ? `:${stderr.trim().slice(-200)}` : ''}`)
    }
  } finally {
    lines.close()
    child.stdout?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

async function* nativeJsonLines(file: string): AsyncGenerator<any> {
  if (file.endsWith('.zstd') || file.endsWith('.zst')) {
    yield* zstdJsonLines(file)
    return
  }
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const item = jsonLine(line)
      if (item) yield item
    }
  } finally {
    lines.close()
  }
}

/** Codex compresses closed rollouts as `rollout-*.jsonl.zst`. */
const isCompressedRollout = (file: string): boolean =>
  file.endsWith('.jsonl.zst') || file.endsWith('.jsonl.zstd')

/**
 * Decode a compressed rollout into a plaintext temp file. Codex uses one
 * Zstandard frame per file; the shared decoder also handles concatenated frames.
 */
async function decodeRolloutToFile(file: string, target: string): Promise<void> {
  const command = await decoderNode()
  const child = spawn(command, ['-e', ZSTD_DECODE_SCRIPT, file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < 2_000) stderr = (stderr + chunk).slice(0, 2_000) })
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => {
      decoderNodePromise = undefined
      child.stdout?.destroy()
      resolve({ code: null, error })
    })
    child.once('close', (code) => resolve({ code }))
  })
  try {
    await pipeline(child.stdout!, createWriteStream(target, { mode: 0o600 }))
    const { code, error } = await completion
    if (error || code !== 0) {
      const reason = error ? (error as NodeJS.ErrnoException).code || error.message : code
      throw new Error(`native_usage_decode_failed:${reason}${stderr ? `:${stderr.trim().slice(-200)}` : ''}`)
    }
  } finally {
    child.stdout?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

interface RolloutDecodeRequest { src: string; dst: string; error: string }

/**
 * Decode many compressed rollouts in ONE external Node process. Spawning one
 * process per rollout dominates a cold full-history scan (1382 files here);
 * batching keeps that scan to seconds instead of minutes.
 */
async function decodeRolloutBatch(jobs: RolloutDecodeRequest[]): Promise<void> {
  if (!jobs.length) return
  const command = await decoderNode()
  const child = spawn(command, ['-e', ZSTD_BATCH_DECODE_SCRIPT], {
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: 300_000
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < 2_000) stderr = (stderr + chunk).slice(0, 2_000) })
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => {
      decoderNodePromise = undefined
      resolve({ code: null, error })
    })
    child.once('close', (code) => resolve({ code }))
  })
  try {
    child.stdin?.end(JSON.stringify(jobs))
    const { code, error } = await completion
    if (error || code !== 0) {
      const reason = error ? (error as NodeJS.ErrnoException).code || error.message : code
      throw new Error(`native_usage_decode_failed:${reason}${stderr ? `:${stderr.trim().slice(-200)}` : ''}`)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

/**
 * Codex / TraeX parsers only read plaintext rollouts. Decode a compressed one
 * into a private temp file for the parse, keeping the original path as identity.
 */
async function withDecodedRollout<T>(
  job: HistoryJob,
  run: (path: string, size: number, identity: string) => Promise<T>
): Promise<T> {
  if (!isCompressedRollout(job.file)) return run(job.file, job.size, job.file)
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-rollout-'))
  try {
    const target = join(directory, 'rollout.jsonl')
    await decodeRolloutToFile(job.file, target)
    const info = await stat(target)
    return await run(target, info.size, job.file)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
}

async function parseNativeLedger(job: HistoryJob, pricing: PricingFile, timeZone: string): Promise<SessionUsage> {
  const { file, agentId, mtimeMs, size } = job
  const total = counters(undefined)
  const buckets = new Map<string, Map<string, UsageRecord>>()
  let startedAt = mtimeMs
  const add = (record: UsageRecord): void => {
    if (!hasUsage(record)) return
    startedAt = Math.min(startedAt, record.updatedAt)
    addCounters(total, record)
    addDailyRecord(buckets, localDay(record.updatedAt, timeZone), record, timeZone)
  }
  const record = (session: string, at: number, usage: Counters, model?: string, cwd?: string, cost?: number): UsageRecord => ({
    filePath: session, agentId, updatedAt: at, ...usage, modelId: model, projectPath: cwd,
    cost: cost ?? computeCost(usage, model, pricing)
  })
  if (agentId === 'zcode') {
    const Database = createRequire(import.meta.url)('better-sqlite3')
    const db = new Database(file, { readonly: true, fileMustExist: true })
    try {
      // One row per actual request attempt. Message/part/turn summaries overlap
      // this table, including forked history, so they must never be added to it.
      const rows = db.prepare(`SELECT u.session_id, u.model_id, u.started_at, u.completed_at,
        u.input_tokens, u.output_tokens, u.cache_read_input_tokens,
        u.cache_creation_input_tokens, u.reasoning_tokens, s.directory
        FROM model_usage u JOIN session s ON s.id = u.session_id`).iterate()
      for (const row of rows) {
        const usage: Counters = {
          // ZCode normalizes cache reads/writes into input before persisting.
          inputTokens: num(row.input_tokens),
          outputTokens: num(row.output_tokens), cachedInputTokens: num(row.cache_read_input_tokens),
          cacheWriteTokens: num(row.cache_creation_input_tokens), reasoningTokens: num(row.reasoning_tokens)
        }
        add(record(`${file}#${row.session_id}`, num(row.completed_at || row.started_at), usage, row.model_id, row.directory))
      }
    } finally { db.close() }
  } else if (agentId === 'grok') {
    const summary = JSON.parse(await readFile(join(file, '..', 'summary.json'), 'utf8'))
    const turns = new Map<string, UsageRecord[]>()
    for await (const item of nativeJsonLines(file)) {
      const update = item.params?.update
      if (update?.sessionUpdate !== 'turn_completed' || !update.usage || !update.prompt_id) continue
      const at = typeof item.timestamp === 'number' ? item.timestamp * 1000 : instant(item.timestamp) ?? mtimeMs
      const usage = update.usage
      const models = usage.modelUsage && typeof usage.modelUsage === 'object' && Object.keys(usage.modelUsage).length
        ? Object.entries(usage.modelUsage) : [[summary.current_model_id, usage]]
      turns.set(update.prompt_id, models.filter(([, value]) => value && typeof value === 'object').map(([model, value]: any) => {
        const tokens: Counters = {
          inputTokens: num(value.inputTokens), outputTokens: num(value.outputTokens),
          cachedInputTokens: num(value.cachedReadTokens), cacheWriteTokens: num(value.cacheCreationTokens),
          reasoningTokens: num(value.reasoningTokens)
        }
        return record(`grok:${summary.info?.id || basename(join(file, '..'))}`, at, tokens, model, summary.info?.cwd,
          num(value.costUsdTicks) > 0 ? value.costUsdTicks / 1e10 : undefined)
      }))
    }
    for (const rows of turns.values()) for (const row of rows) add(row)
  } else if (agentId === 'kimi') {
    const parts = file.split(/[\\/]/)
    const sessionIndex = parts.findLastIndex(part => /^(session_|ses_)/.test(part))
    const session = sessionIndex >= 0 ? parts[sessionIndex].replace(/^(session_|ses_)/, '') : parts[parts.length - 2]
    const sessionRoot = parts.slice(0, sessionIndex >= 0 ? sessionIndex + 1 : -1).join('/')
    let cwd: string | undefined
    try { cwd = JSON.parse(await readFile(join(sessionRoot, 'state.json'), 'utf8')).cwd } catch { /* legacy wire carries no cwd */ }
    for await (const item of nativeJsonLines(file)) {
      const legacy = item.message?.type === 'StatusUpdate' ? item.message.payload?.token_usage : undefined
      if (item.type !== 'usage.record' && !legacy) continue
      const u = item.usage || legacy
      if (!u || typeof u !== 'object') continue
      const usage: Counters = {
        inputTokens: num(u.inputOther ?? u.input_other) + num(u.inputCacheRead ?? u.input_cache_read) + num(u.inputCacheCreation ?? u.input_cache_creation),
        outputTokens: num(u.output), cachedInputTokens: num(u.inputCacheRead ?? u.input_cache_read),
        cacheWriteTokens: num(u.inputCacheCreation ?? u.input_cache_creation), reasoningTokens: 0
      }
      const at = num(item.time) || num(item.timestamp) * 1000 || mtimeMs
      add(record(`kimi:${session}`, at, usage, item.model || 'kimi-code', cwd))
    }
  } else if (agentId === 'deepseek') {
    let session = basename(join(file, '..')), cwd: string | undefined, model: string | undefined, inherited = false
    const steps = new Map<string, UsageRecord>()
    for await (const item of nativeJsonLines(file)) {
      const data = item.data || {}
      if (item.type === 'session') { session = item.id || session; cwd = item.cwd; inherited = item.isSeeded === true }
      if (item.type === 'session/end-seed') { inherited = false; continue }
      if (item.type === 'request/header') model = data.header?.config?.model || model
      if (inherited || !['assistant/message', 'assistant/attempt', 'compaction/summary'].includes(item.type)) continue
      const u = data.usage || (Array.isArray(data.stream)
        ? data.stream.findLast((entry: any) => entry.type === 'chunk' && entry.chunk?.type === 'usage')?.chunk.usage : undefined)
      if (!u) continue
      const usage: Counters = {
        inputTokens: num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens),
        outputTokens: num(u.outputTokens), cachedInputTokens: num(u.cacheReadTokens),
        cacheWriteTokens: num(u.cacheWriteTokens), reasoningTokens: num(u.reasoningTokens)
      }
      const key = item.type === 'compaction/summary' ? `compact:${item.seq}` : `${data.turn}:${data.step}`
      steps.set(key, record(`deepseek:${session}`, num(item.time) || mtimeMs, usage, data.provider && data.model ? data.model : model, cwd))
    }
    for (const row of steps.values()) add(row)
  }
  return {
    filePath: file, agentId, mtimeMs, size, startedAt, updatedAt: mtimeMs,
    ...total, cost: null, daily: serializeBuckets(buckets)
  }
}

const ROLLOUT_LEDGER_RE = /^rollout-.*\.jsonl(?:\.zst|\.zstd)?$/

/** Recursively collect plaintext and zstd-compressed rollout ledgers. */
async function collectRolloutLedgers(dir: string, out: string[]): Promise<void> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collectRolloutLedgers(full, out)
    else if (entry.isFile() && ROLLOUT_LEDGER_RE.test(entry.name)) out.push(full)
  }
}

/**
 * Every plaintext or compressed rollout under a codex-like agent's sessions +
 * archived_sessions. Codex compresses closed rollouts to `.jsonl.zst`; a session
 * briefly present in both forms is counted once (plaintext wins).
 */
async function codexLikeFiles(baseDir: string): Promise<string[]> {
  const files: string[] = []
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = join(baseDir, sub)
    if (existsSync(root)) await collectRolloutLedgers(root, files)
  }
  const byRollout = new Map<string, string>()
  for (const file of files) {
    const key = basename(file).replace(/\.jsonl(?:\.zst|\.zstd)?$/, '')
    const current = byRollout.get(key)
    if (!current || (isCompressedRollout(current) && !isCompressedRollout(file))) byRollout.set(key, file)
  }
  return [...byRollout.values()]
}

/** Every `<id>.jsonl` under ~/.claude/projects/<project>/. */
async function claudeFiles(): Promise<string[]> {
  const out: string[] = []
  let projects: string[] = []
  try {
    projects = await readdir(CLAUDE_PROJECTS)
  } catch {
    return out
  }
  for (const proj of projects) {
    let entries: string[] = []
    try {
      entries = await readdir(join(CLAUDE_PROJECTS, proj))
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) out.push(join(CLAUDE_PROJECTS, proj, name))
    }
  }
  return out
}

async function discoverHistory(timeZone: string): Promise<HistoryJob[]> {
  const jobs: Array<{ file: string; agentId: UsageRecord['agentId'] }> = []
  for (const file of await codexLikeFiles(CODEX_DIR)) jobs.push({ file, agentId: 'codex' })
  for (const file of isDistributionAgent('traex') ? await codexLikeFiles(TRAE_DIR) : []) jobs.push({ file, agentId: 'traex' })
  for (const file of await claudeFiles()) jobs.push({ file, agentId: 'claude' })
  for (const root of new Set([process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'), join(homedir(), '.kimi')])) {
    for (const file of await nativeFiles(join(root, 'sessions'), name => name === 'wire.jsonl')) jobs.push({ file, agentId: 'kimi' })
  }
  for (const file of await nativeFiles(join(process.env.GROK_HOME || join(homedir(), '.grok'), 'sessions'), name => name === 'updates.jsonl')) {
    jobs.push({ file, agentId: 'grok' })
  }
  for (const root of new Set([process.env.DSH_HOME || join(homedir(), '.dsh'), join(NATIVE_USER_DATA, 'deepseek', 'home')])) {
    const files = await nativeFiles(root, name => /^session\.v[34]\.jsonl(?:\.zstd)?$/.test(name))
    // A format migration keeps an older generation beside the new ledger.
    const latest = new Map<string, string>()
    for (const file of files) {
      const directory = join(file, '..')
      if (!latest.has(directory) || basename(file) > basename(latest.get(directory)!)) latest.set(directory, file)
    }
    for (const file of latest.values()) jobs.push({ file, agentId: 'deepseek' })
  }
  for (const file of await nativeFiles(join(NATIVE_USER_DATA, 'zcode', 'data'), name => name === 'session.sqlite')) {
    jobs.push({ file, agentId: 'zcode' })
  }
  if (process.env.ZCODE_SESSION_DB_PATH && !jobs.some(job => job.file === process.env.ZCODE_SESSION_DB_PATH)) {
    jobs.push({ file: process.env.ZCODE_SESSION_DB_PATH, agentId: 'zcode' })
  }
  const found: HistoryJob[] = []
  for (const { file, agentId } of jobs) {
    try {
      const st = await stat(file)
      let mtimeMs = st.mtimeMs, size = st.size
      if (agentId === 'zcode') {
        try {
          const wal = await stat(file + '-wal')
          mtimeMs = Math.max(mtimeMs, wal.mtimeMs)
          size += wal.size
        } catch { /* no active WAL */ }
      }
      const endDay = localDay(mtimeMs, timeZone)
      const startDay = agentId === 'codex' || agentId === 'traex'
        ? rolloutStartDay(file) || endDay : localDay(Math.min(st.birthtimeMs || mtimeMs, mtimeMs), timeZone)
      found.push({ file, agentId, mtimeMs, size, startDay, endDay })
    } catch {
      continue // vanished between listing and stat
    }
  }
  return found
}

function rolloutStartDay(file: string): string | undefined {
  return basename(file).match(/^rollout-(\d{4}-\d{2}-\d{2})T/)?.[1]
}

// ---- Aggregation into the KabooProfile shape the panel already renders ----

function localDay(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ms))
  const p = (type: string): string => parts.find((x) => x.type === type)?.value || ''
  return `${p('year')}-${p('month')}-${p('day')}`
}

function localHourWeekday(ms: number, timeZone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', hour12: false
  }).formatToParts(new Date(ms))
  const wd = parts.find((x) => x.type === 'weekday')?.value || 'Mon'
  const hourRaw = Number(parts.find((x) => x.type === 'hour')?.value || '0')
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
  return { weekday: map[wd] ?? 0, hour: hourRaw % 24 }
}

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function daysBetween(start: string, end: string): string[] {
  if (!start || !end || start > end) return []
  const out: string[] = []
  for (let day = start; day <= end; day = shiftDay(day, 1)) out.push(day)
  return out
}

function previousWindow(query: KabooUsageQuery): { start: string; end: string } | undefined {
  if (!query.start || !query.end) return undefined
  const length = daysBetween(query.start, query.end).length
  const end = shiftDay(query.start, -1)
  return { start: shiftDay(end, -(length - 1)), end }
}

function sessionRecord(session: SessionUsage): UsageRecord {
  const { mtimeMs: _mtimeMs, size: _size, startedAt: _startedAt, daily: _daily, ...record } = session
  return record
}

function overlaps(job: HistoryJob, dates: Set<string>): boolean {
  if (job.agentId !== 'codex' && job.agentId !== 'traex') return true
  for (const date of dates) if (date >= job.startDay && date <= job.endDay) return true
  return false
}

function jobNeedsDaily(job: HistoryJob, hourlyDate?: string): boolean {
  const codexLike = job.agentId === 'codex' || job.agentId === 'traex'
  // A day view needs per-event timestamps for the hourly curve, so single-day
  // Codex/TraeX sessions must use the detailed ledger instead of the tail summary.
  // Only the queried day itself is forced; the comparison window keeps the cheaper
  // summary path.
  const hourly = hourlyDate !== undefined && job.startDay <= hourlyDate && job.endDay >= hourlyDate
  return !codexLike || job.startDay !== job.endDay || hourly
}

async function populateDays(
  state: CacheState,
  requestedDates: string[],
  today: string,
  prefetchedJobs?: HistoryJob[],
  hourlyDate?: string
): Promise<void> {
  const started = Date.now()
  const jobs = prefetchedJobs || await discoverHistory(state.timeZone)
  const discoverMs = Date.now() - started
  const earliest = jobs.map((job) => job.startDay).sort()[0]
  if (earliest && (!state.historyStart || earliest < state.historyStart)) state.historyStart = earliest
  const requested = new Set(requestedDates.filter((date) => date <= today))
  const targets = new Set([...requested].filter((date) =>
    date === today || !state.days.has(date) || !state.finalizedDays.has(date)
  ))
  // A finalized day must be rebuilt when a session covering it is new or changed:
  // late writes after midnight, a rollout compressed to `.jsonl.zst`, or a newly
  // imported ledger would otherwise stay missing from the cached day forever.
  for (const job of jobs) {
    const session = state.sessions.get(job.file)
    const unchanged = session && session.mtimeMs === job.mtimeMs && session.size === job.size
    // A day view needs per-event buckets. A finalized day cached from the tail
    // summary must be upgraded to the detailed ledger even though it is unchanged.
    if (unchanged && hourlyDate && !session.daily &&
        job.startDay <= hourlyDate && job.endDay >= hourlyDate) {
      targets.add(hourlyDate)
      continue
    }
    if (unchanged) continue
    const days = new Set<string>(daysBetween(job.startDay, job.endDay))
    for (const date of Object.keys(session?.daily || {})) days.add(date)
    for (const date of days) if (requested.has(date)) targets.add(date)
  }
  if (!targets.size) {
    logTokenUsage('native', 'populate_skip', { jobs: jobs.length, discoverMs, hourlyDate })
    return
  }

  const pricing = loadPricing()
  const computed = new Map([...targets].map((date) => [date, [] as UsageRecord[]]))
  const incomplete = new Set<string>()

  // Decode every compressed ledger this pass needs in one external Node process;
  // per-file process spawns dominate a cold full-history scan.
  const compressedPlan = jobs.filter((job) => {
    if (!overlaps(job, targets) || !isCompressedRollout(job.file)) return false
    const session = state.sessions.get(job.file)
    const unchanged = session?.mtimeMs === job.mtimeMs && session.size === job.size
    const needsDaily = jobNeedsDaily(job, hourlyDate)
    return !unchanged || needsDaily && !session?.daily
  })
  const tempDirectory = compressedPlan.length ? await mkdtemp(join(tmpdir(), 'uniagent-rollouts-')) : undefined
  const decoded = new Map<string, { path: string; size: number }>()
  const decodeStarted = Date.now()
  if (tempDirectory) {
    const requests = compressedPlan.map((job, index) => ({
      src: job.file,
      dst: join(tempDirectory, `${index}.jsonl`),
      error: join(tempDirectory, `${index}.error`)
    }))
    try {
      await decodeRolloutBatch(requests)
      for (let index = 0; index < requests.length; index++) {
        if (existsSync(requests[index].error)) continue
        const info = await stat(requests[index].dst)
        decoded.set(compressedPlan[index].file, { path: requests[index].dst, size: info.size })
      }
    } catch {
      // Fall back to per-file decoding inside the parse loop below.
    }
    logTokenUsage('native', 'decode_batch', {
      requested: compressedPlan.length,
      decoded: decoded.size,
      durationMs: Date.now() - decodeStarted
    })
  }

  let parsed = 0
  try {
    for (const job of jobs) {
      if (!overlaps(job, targets)) continue
      let session = state.sessions.get(job.file)
      const unchanged = session?.mtimeMs === job.mtimeMs && session.size === job.size
      const needsDaily = jobNeedsDaily(job, hourlyDate)
      const parseStarted = Date.now()
      try {
        if (!unchanged || needsDaily && !session?.daily) {
          if (job.agentId === 'codex' || job.agentId === 'traex') {
            const agentId = job.agentId
            const prepared = decoded.get(job.file)
            if (prepared) {
              session = needsDaily
                ? await parseCodexDetailed(prepared.path, agentId, job.mtimeMs, prepared.size, pricing, state.timeZone, job.file)
                : await parseCodexSummary(prepared.path, agentId, job.mtimeMs, prepared.size, pricing, state.timeZone, job.file)
            } else {
              session = await withDecodedRollout(job, (path, size, identity) => needsDaily
                ? parseCodexDetailed(path, agentId, job.mtimeMs, size, pricing, state.timeZone, identity)
                : parseCodexSummary(path, agentId, job.mtimeMs, size, pricing, state.timeZone, identity))
            }
            // The decompressed temp file is larger than the compressed rollout; the
            // cache must keep comparing against the on-disk artifact's size.
            if (session) session.size = job.size
          } else if (job.agentId === 'claude') {
            session = await parseClaude(job.file, job.mtimeMs, job.size, pricing, state.timeZone)
          } else {
            session = await parseNativeLedger(job, pricing, state.timeZone)
          }
          state.sessions.set(job.file, session)
          parsed += 1
          if (job.agentId === 'codex' || job.agentId === 'traex') {
            logTokenUsage('native', 'session', {
              agent: job.agentId,
              file: basename(job.file),
              compressed: isCompressedRollout(job.file),
              detail: needsDaily,
              mtimeMs: job.mtimeMs,
              size: job.size,
              parseMs: Date.now() - parseStarted,
              tokens: session ? session.inputTokens + session.outputTokens : 0,
              days: session ? Object.keys(session.daily || {}).sort() : [],
              startedAt: session?.startedAt
            })
          }
        }
      } catch (error) {
        // A missing/broken Zstandard decoder is transient (Node can be installed or
        // repaired without an app restart). Keep those days retryable instead of
        // finalizing them as "this agent had no usage".
        const message = error instanceof Error ? error.message : ''
        logTokenUsage('native', 'parse_failed', {
          agent: job.agentId,
          file: basename(job.file),
          compressed: isCompressedRollout(job.file),
          message
        })
        if (message.startsWith('native_usage_decoder_unavailable') || message.startsWith('native_usage_decode_failed')) {
          for (const date of targets) if (date >= job.startDay && date <= job.endDay) incomplete.add(date)
        }
        continue
      }
      if (!session) continue
      const sessionStart = localDay(session.startedAt, state.timeZone)
      if (!state.historyStart || sessionStart < state.historyStart) state.historyStart = sessionStart
      if (needsDaily) {
        for (const date of targets) computed.get(date)!.push(...(session.daily?.[date] || []))
      } else if (targets.has(job.endDay)) {
        computed.get(job.endDay)!.push(sessionRecord(session))
      }
    }

    for (const [date, records] of computed) {
      state.days.set(date, records)
      if (incomplete.has(date)) state.finalizedDays.delete(date)
      else if (date < today) state.finalizedDays.add(date)
      else state.finalizedDays.delete(date)
    }
    saveCache(state)
    logTokenUsage('native', 'populate', {
      jobs: jobs.length,
      targets: [...targets].sort(),
      parsed,
      compressed: compressedPlan.length,
      decoded: decoded.size,
      incomplete: [...incomplete].sort(),
      discoverMs,
      durationMs: Date.now() - started
    })
  } finally {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  }
}

async function datesForQuery(
  query: KabooUsageQuery,
  state: CacheState,
  today: string
): Promise<{ dates: string[]; jobs?: HistoryJob[] }> {
  if (query.period === 'all') {
    let jobs: HistoryJob[] | undefined
    if (!state.historyStart) {
      jobs = await discoverHistory(state.timeZone)
      state.historyStart = jobs.map((job) => job.startDay).sort()[0] || today
    }
    return { dates: daysBetween(state.historyStart || today, today), jobs }
  }
  const currentEnd = query.end! < today ? query.end! : today
  const dates = daysBetween(query.start!, currentEnd)
  const previous = previousWindow(query)
  if (previous) dates.push(...daysBetween(previous.start, previous.end).filter((date) => date <= today))
  return { dates: [...new Set(dates)] }
}

function modelFamily(modelId?: string): string {
  const id = (modelId || '').toLowerCase()
  if (/gpt|codex|o\d/.test(id)) return 'OpenAI'
  if (/claude|opus|sonnet|haiku/.test(id)) return 'Anthropic'
  if (/gemini/.test(id)) return 'Google'
  if (/kimi/.test(id)) return 'Moonshot'
  if (/grok/.test(id)) return 'xAI'
  if (/glm/.test(id)) return '智谱'
  if (/mimo/.test(id)) return '小米 MiMo'
  if (/deepseek/.test(id)) return 'DeepSeek'
  if (/openrouter/.test(id)) return 'OpenRouter'
  return '其它'
}

const AGENT_LABEL: Record<UsageRecord['agentId'], string> = {
  codex: 'Codex', traex: 'TraeX', claude: 'Claude Code',
  kimi: 'Kimi Code', grok: 'Grok', zcode: 'ZCode', deepseek: 'DeepSeek Harness'
}

/** CLI input includes cached-read tokens; Kaboo exposes fresh input separately. */
function freshInput(s: UsageRecord): number {
  return Math.max(0, s.inputTokens - s.cachedInputTokens)
}

/** Total processed tokens includes cache hits, matching the Kaboo headline. */
function totalTokens(s: UsageRecord): number {
  return s.inputTokens + s.outputTokens
}

function emptyStats(): KabooStats {
  return {
    tokens: 0, cost: 0, sessions: 0, hours: 0, codeLines: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0
  }
}

function accumulate(target: KabooStats, s: UsageRecord): void {
  target.tokens += totalTokens(s)
  target.cost += s.cost ?? 0
  target.inputTokens += freshInput(s)
  target.outputTokens += s.outputTokens
  target.cachedTokens += s.cachedInputTokens
  target.reasoningTokens += s.reasoningTokens
}

function statsFor(records: UsageRecord[], start: string, end: string, tz: string): KabooStats {
  const out = emptyStats()
  const sessions = new Set<string>()
  for (const record of records) {
    const day = localDay(record.updatedAt, tz)
    if (start && (day < start || day > end)) continue
    accumulate(out, record)
    sessions.add(record.filePath)
  }
  out.sessions = sessions.size
  return out
}

function buildProfile(all: UsageRecord[], query: KabooUsageQuery): KabooProfile {
  const tz = query.timeZone
  const start = query.start || ''
  const end = query.end || ''
  const inRange = (s: UsageRecord): boolean => {
    if (!start) return true
    const day = localDay(s.updatedAt, tz)
    return day >= start && day <= end
  }
  const records = all.filter(inRange)

  const stats = statsFor(records, '', '', tz)
  const trend = new Map<string, KabooDailyTrend & { models: Map<string, number>; sessionIds: Set<string> }>()
  const models = new Map<string, { tokens: number; cost: number; family: string }>()
  const tools = new Map<string, { tokens: number; cost: number; sessionIds: Set<string> }>()
  const projects = new Map<string, { tokens: number; cost: number; sessionIds: Set<string>; models: Set<string> }>()
  // Cross-history weekday×hour heatmap (mirrors Kaboo's day-view distribution),
  // built from ALL sessions so the day view has a lifetime profile like Kaboo's.
  const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  // The selected day's own hourly curve; only the day view has 24 hour slots.
  const hourlyTrend = query.period === 'day' && query.start
    ? { date: query.start, tokens: new Array<number>(24).fill(0) }
    : undefined

  for (const s of all) {
    const total = totalTokens(s)
    const { weekday, hour } = localHourWeekday(s.updatedAt, tz)
    heatmap[weekday][hour] += total
  }

  for (const s of records) {
    const total = totalTokens(s)
    const day = localDay(s.updatedAt, tz)
    if (hourlyTrend && day === hourlyTrend.date) {
      hourlyTrend.tokens[localHourWeekday(s.updatedAt, tz).hour] += total
    }

    let bucket = trend.get(day)
    if (!bucket) {
      bucket = {
        date: day, tokens: 0, cost: 0, inputTokens: 0, outputTokens: 0,
        cachedTokens: 0, cacheCreationTokens: 0, hours: 0, sessions: 0, messages: 0,
        models: new Map(), sessionIds: new Set()
      }
      trend.set(day, bucket)
    }
    bucket.tokens += total
    bucket.cost += s.cost ?? 0
    bucket.inputTokens += freshInput(s)
    bucket.outputTokens += s.outputTokens
    bucket.cachedTokens += s.cachedInputTokens
    bucket.cacheCreationTokens += s.cacheWriteTokens
    bucket.sessionIds.add(s.filePath)
    bucket.sessions = bucket.sessionIds.size
    if (s.modelId) bucket.models.set(s.modelId, (bucket.models.get(s.modelId) || 0) + total)

    if (s.modelId) {
      const m = models.get(s.modelId) || { tokens: 0, cost: 0, family: modelFamily(s.modelId) }
      m.tokens += total
      m.cost += s.cost ?? 0
      models.set(s.modelId, m)
    }

    const toolKey = AGENT_LABEL[s.agentId]
    const tool = tools.get(toolKey) || { tokens: 0, cost: 0, sessionIds: new Set<string>() }
    tool.tokens += total
    tool.cost += s.cost ?? 0
    tool.sessionIds.add(s.filePath)
    tools.set(toolKey, tool)

    const projKey = s.projectPath ? basename(s.projectPath) || s.projectPath : '(未知项目)'
    const proj = projects.get(projKey) || { tokens: 0, cost: 0, sessionIds: new Set<string>(), models: new Set<string>() }
    proj.tokens += total
    proj.cost += s.cost ?? 0
    proj.sessionIds.add(s.filePath)
    if (s.modelId) proj.models.add(s.modelId)
    projects.set(projKey, proj)
  }

  // Previous equal-length window immediately preceding [start,end] for the deltas.
  let prevStats: KabooStats | undefined
  if (start && end) {
    const previous = previousWindow(query)!
    prevStats = statsFor(all, previous.start, previous.end, tz)
  }

  return {
    range: query.period,
    reportedAt: new Date().toISOString(),
    stats,
    ...(prevStats ? { prevStats } : {}),
    heatmap,
    ...(hourlyTrend ? { hourlyTrend } : {}),
    dailyTrend: [...trend.values()]
      .map(({ models: bucketModels, sessionIds: _sessionIds, ...rest }) => ({
        ...rest,
        topModel: [...bucketModels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    modelBreakdown: [...models.entries()]
      .map(([model, v]) => ({ model, family: v.family, tokens: v.tokens, cost: v.cost }))
      .sort((a, b) => b.tokens - a.tokens),
    toolBreakdown: [...tools.entries()]
      .map(([source, v]) => ({ source, tokens: v.tokens, cost: v.cost, sessions: v.sessionIds.size }))
      .sort((a, b) => b.tokens - a.tokens),
    // Native has no skill attribution — the panel renders an empty card.
    skillBreakdown: [],
    projectBreakdown: [...projects.entries()]
      .map(([project, v]) => ({ project, tokens: v.tokens, cost: v.cost, sessions: v.sessionIds.size, models: v.models.size }))
      .sort((a, b) => b.tokens - a.tokens),
    mcpBreakdown: []
  }
}

export async function getNativeTokenUsage(value: unknown): Promise<KabooProfileResult> {
  const started = Date.now()
  const query = validateTokenUsageQuery(value)
  if (!query) return { unavailable: true, reason: 'invalid-response' }
  try {
    if (isMainThread && existsSync(new URL('./nativeTokenUsageWorker.js', import.meta.url))) return await queryWorker(query)
    const state = loadCache(query.timeZone)
    const today = localDay(Date.parse(query.now), query.timeZone)
    const needed = await datesForQuery(query, state, today)
    const hourlyDate = query.period === 'day' ? query.start : undefined
    await populateDays(state, needed.dates, today, needed.jobs, hourlyDate)
    // Imported ledgers can predate their filesystem timestamps. Include the
    // native event dates discovered during the first scan in the all-time view.
    if (query.period === 'all' && state.historyStart && state.historyStart < needed.dates[0]) {
      await populateDays(state, daysBetween(state.historyStart, today), today)
    }
    const profile = buildProfile([...state.days.values()].flat(), query)
    logTokenUsage('native', 'query', {
      query,
      durationMs: Date.now() - started,
      stats: profile.stats,
      tools: profile.toolBreakdown,
      ...(query.period === 'day' ? { hourlyTrend: profile.hourlyTrend, dailyTrend: profile.dailyTrend } : {}),
      cache: {
        sessions: state.sessions.size,
        days: state.days.size,
        finalized: state.finalizedDays.size
      }
    })
    return profile
  } catch (error) {
    logTokenUsage('native', 'query_failed', {
      query,
      durationMs: Date.now() - started,
      message: error instanceof Error ? error.message : String(error)
    })
    return { unavailable: true, reason: 'service' }
  }
}

export function refreshNativeTokenUsage(): void {
  // Historical day buckets are immutable. Dropping only the in-memory state makes
  // the next request reload them from disk while today is recomputed by populateDays.
  cacheState = null
  workerNeedsRefresh = true
}
