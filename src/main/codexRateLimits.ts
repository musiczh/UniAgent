import { open, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CodexRateLimits, CodexRateWindow } from '../shared/types'
import { CODEX_DIR, collectRolloutFiles } from './history'
import { AppServerRpcClient } from './appServerTransport'

/**
 * Latest Codex account quota (用量额度). Rate limits are account-global, not
 * per-session, so we read the newest on-disk rollout that carries a
 * `token_count.rate_limits` snapshot. The active rollout appends its cumulative
 * `token_count` at the tail, so we only tail-read (no full parse). We probe a
 * handful of the most-recently-touched rollouts because the very newest file
 * may not have run a turn yet (no rate_limits line). Read-only; no cache — the
 * settings panel calls this on demand. Manual refresh queries the authenticated
 * app-server instead of treating historical rollout data as a fresh quota.
 *
 * 额度耗尽（5 小时窗口打满）后，Codex 后端不再下发窗口数据，rate_limits 的
 * primary/secondary/plan_type 全部变成 null。这类空快照不携带任何可展示信息，
 * 既不能覆盖内存里最近一次已知窗口（rememberCodexRateLimits），也不能在磁盘
 * 扫描时命中即停（readLastRateLimits 会继续向前找最近一条有数据的快照）。
 */

const TAIL_WINDOW = 512 * 1024
const MAX_FILES_PROBED = 6
let liveSnapshot: CodexRateLimits | null = null
let refreshFlight: Promise<CodexRateLimits> | undefined

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeWindow(w: any): CodexRateWindow | null {
  if (!w || typeof w !== 'object') return null
  const usedPercent = num(w.used_percent ?? w.usedPercent)
  const windowMinutes = num(w.window_minutes ?? w.windowMinutes ?? w.windowDurationMins)
  const resetsAt = num(w.resets_at ?? w.resetsAt)
  if (usedPercent == null || windowMinutes == null || resetsAt == null) return null
  return { usedPercent, windowMinutes, resetsAt }
}

export function normalizeCodexRateLimits(raw: any, capturedAt = Date.now()): CodexRateLimits | null {
  if (!raw || typeof raw !== 'object') return null
  const primary = raw.primary === undefined ? undefined : normalizeWindow(raw.primary)
  const secondary = raw.secondary === undefined ? undefined : normalizeWindow(raw.secondary)
  const planType = typeof (raw.plan_type ?? raw.planType) === 'string'
    ? raw.plan_type ?? raw.planType
    : raw.plan_type === null || raw.planType === null
      ? null
      : undefined
  // 全 null 是额度耗尽后的空快照，与字段缺失一样视为无信息。
  if (primary == null && secondary == null && planType == null) return null
  return { primary, secondary, planType, capturedAt }
}

/** Merge sparse app-server pushes into the newest account-global snapshot. */
export function rememberCodexRateLimits(snapshot: CodexRateLimits): CodexRateLimits {
  liveSnapshot = {
    // null 同样视为「本次未上报」（耗尽时空快照），保留最近一次已知值，
    // 避免耗尽后额度区块整块消失；有效推送或主动查询会更新窗口。
    primary: snapshot.primary ?? liveSnapshot?.primary,
    secondary: snapshot.secondary ?? liveSnapshot?.secondary,
    planType: snapshot.planType ?? liveSnapshot?.planType,
    capturedAt: snapshot.capturedAt
  }
  return liveSnapshot
}

export function refreshCodexRateLimits(bin: string): Promise<CodexRateLimits> {
  if (!refreshFlight) {
    refreshFlight = queryAppServerRateLimits(bin).then(rememberCodexRateLimits).finally(() => { refreshFlight = undefined })
  }
  return refreshFlight
}

export async function queryAppServerRateLimits(bin: string): Promise<CodexRateLimits> {
  const client = new AppServerRpcClient({ bin, args: ['app-server'], cwd: homedir(), timeoutMs: 15_000 })
  try {
    await client.start()
    await client.request('initialize', {
      clientInfo: { name: 'uniagent', title: 'UniAgent', version: '1.0.0' }
    })
    client.notify('initialized', {})
    const result = await client.request<any>('account/rateLimits/read', {})
    const snapshot = normalizeCodexRateLimits(result?.rateLimitsByLimitId?.codex ?? result?.rateLimits)
    if (!snapshot?.primary && !snapshot?.secondary) throw new Error('invalid_codex_quota')
    return snapshot
  } catch {
    // Provider errors may include private data; only this fixed message crosses IPC.
    throw new Error('Codex 额度刷新失败，请确认已登录后重试')
  } finally {
    await client.dispose().catch(() => {})
  }
}

/** Tail-read the file and return the newest `token_count.rate_limits`, if any. */
async function readLastRateLimits(file: string, size: number): Promise<any | null> {
  const start = Math.max(0, size - TAIL_WINDOW)
  const fh = await open(file, 'r')
  try {
    const len = size - start
    if (len <= 0) return null
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue
      try {
        const o = JSON.parse(lines[i])
        const rl = o?.payload?.type === 'token_count' ? o.payload.rate_limits : null
        // 跳过耗尽后的全 null 空快照，继续向前找最近一条有窗口数据的。
        if (rl && typeof rl === 'object' && (rl.primary != null || rl.secondary != null || rl.plan_type != null || rl.planType != null)) {
          return rl
        }
      } catch {
        /* partial/broken line — keep scanning older lines */
      }
    }
  } finally {
    await fh.close()
  }
  return null
}

export async function getCodexRateLimits(): Promise<CodexRateLimits | null> {
  const files: string[] = []
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = join(CODEX_DIR, sub)
    if (existsSync(root)) await collectRolloutFiles(root, files)
  }
  if (!files.length) return liveSnapshot
  // Stat + sort newest-first, then probe only the freshest few for a snapshot.
  const stamped: Array<{ file: string; mtimeMs: number; size: number }> = []
  for (const file of files) {
    try {
      const st = await stat(file)
      stamped.push({ file, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      /* vanished between listing and stat */
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { file, mtimeMs, size } of stamped.slice(0, MAX_FILES_PROBED)) {
    let raw: any = null
    try {
      raw = await readLastRateLimits(file, size)
    } catch {
      continue
    }
    if (!raw) continue
    const diskSnapshot = normalizeCodexRateLimits(raw, mtimeMs)
    if (!diskSnapshot?.primary && !diskSnapshot?.secondary) continue
    if (!liveSnapshot) return rememberCodexRateLimits(diskSnapshot)
    if (liveSnapshot.capturedAt < diskSnapshot.capturedAt) {
      liveSnapshot = diskSnapshot
      return liveSnapshot
    }
    liveSnapshot = {
      primary: liveSnapshot.primary === undefined ? diskSnapshot.primary : liveSnapshot.primary,
      secondary: liveSnapshot.secondary === undefined ? diskSnapshot.secondary : liveSnapshot.secondary,
      planType: liveSnapshot.planType === undefined ? diskSnapshot.planType : liveSnapshot.planType,
      capturedAt: liveSnapshot.capturedAt
    }
    return liveSnapshot
  }
  return liveSnapshot
}
