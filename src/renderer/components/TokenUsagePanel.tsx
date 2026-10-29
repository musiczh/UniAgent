import { useCallback, useEffect, useRef, useState } from 'react'
import { INTERNAL_DISTRIBUTION } from '@shared/distribution'
import type {
  KabooDailyTrend, KabooHourlyTrend, KabooPeriod, KabooProfileResult, KabooUsageQuery
} from '@shared/types'
import { AgentIcon } from './AgentIcon'
import { Chevron, UiIcon } from './Icons'

const RANGES: Array<{ value: KabooPeriod; label: string }> = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
  { value: 'all', label: '全部' }
]

// Two independent, non-additive usage sources. Kaboo is the server-side profile
// (default when available); "native" scans this machine's agent history on disk
// (本机全量) so usage shows up with no bytedcli / no login and without server lag.
export type Source = 'kaboo' | 'native'
const SOURCES: Array<{ value: Source; label: string }> = [
  { value: 'kaboo', label: 'Kaboo' },
  { value: 'native', label: 'UniAgent 原生' }
]
const SOURCE_STORAGE_KEY = 'uniagent.tokenUsage.source'

/** Diagnostics only; never let a logging failure affect the panel. */
function logPanel(event: string, data?: Record<string, unknown>): void {
  try {
    void window.uniagent.logTokenUsage(event, data).catch(() => undefined)
  } catch {
    /* bridge unavailable (tests / very early startup) */
  }
}

function readStoredSource(): Source | null {
  try {
    const value = localStorage.getItem(SOURCE_STORAGE_KEY)
    return value === 'kaboo' || value === 'native' ? value : null
  } catch {
    return null
  }
}

interface Stats {
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

interface ToolUsage {
  source: string
  tokens: number
  cost: number
  sessions: number
}

interface BreakdownRow {
  name: string
  tokens: number
  meta: string
  title?: string
}

export interface Profile {
  range: KabooPeriod
  query: KabooUsageQuery
  stats: Stats
  prevStats?: Stats
  heatmap: number[][]
  dailyTrend: KabooDailyTrend[]
  hourlyTrend?: KabooHourlyTrend
  toolBreakdown: ToolUsage[]
  modelBreakdown: BreakdownRow[]
  skillBreakdown: BreakdownRow[]
  projectBreakdown: BreakdownRow[]
  reportedAt?: string | number
}

/** Native day view can chart the selected day itself or its lifetime weekday profile. */
export type DayTrendMode = 'day' | 'history'

export function TrendModeToggle({
  mode,
  onChange
}: {
  mode: DayTrendMode
  onChange: (mode: DayTrendMode) => void
}): JSX.Element {
  return (
    <div className="token-trend-mode" role="group" aria-label="用量趋势统计口径">
      <button
        type="button"
        className={mode === 'day' ? 'active' : ''}
        aria-pressed={mode === 'day'}
        title="按所选日期的小时展示当天实际用量"
        onClick={() => onChange('day')}
      >
        当天
      </button>
      <button
        type="button"
        className={mode === 'history' ? 'active' : ''}
        aria-pressed={mode === 'history'}
        title="所选星期几的跨全部历史聚合（非当日）"
        onClick={() => onChange('history')}
      >
        历史分布
      </button>
    </div>
  )
}

type LoadIssue = { kind: 'unavailable' | 'error'; message: string }
type Loaded = { profile: Profile } | { issue: LoadIssue }

// Kept outside the component: leaving the Token panel unmounts it, and a
// component-local cache would make every return trip reload from scratch.
type CachedProfile = { outcome: { profile: Profile }; at: number }
const profileCache = new Map<string, CachedProfile>()
// Electron persists localStorage in the user-data directory across App restarts.
const PROFILE_STORAGE_PREFIX = 'uniagent.tokenUsage.profile.v1:'
const PROFILE_STORAGE_INDEX = `${PROFILE_STORAGE_PREFIX}index`
const MAX_STORED_PROFILES = 24
let lastView: { range: KabooPeriod; offset: number } | null = null

function readCachedProfile(source: Source, query: KabooUsageQuery): CachedProfile | undefined {
  const key = `${source}:${cacheKey(query)}`
  const memory = profileCache.get(key)
  if (memory) return memory
  try {
    const stored = JSON.parse(localStorage.getItem(`${PROFILE_STORAGE_PREFIX}${key}`) || 'null')
    if (!stored?.query || cacheKey(stored.query) !== cacheKey(query) ||
        typeof stored.at !== 'number' || !Number.isFinite(stored.at)) return undefined
    const outcome = unpackResult(stored.result, stored.query, source)
    if ('issue' in outcome || outcome.profile.range !== query.period) return undefined
    const cached = { outcome, at: stored.at }
    profileCache.set(key, cached)
    return cached
  } catch {
    return undefined
  }
}

function storeProfile(
  source: Source, query: KabooUsageQuery, result: KabooProfileResult, profile: Profile
): Profile {
  const key = `${source}:${cacheKey(query)}`
  const previous = profileCache.get(key)
  // A scan's timestamp changes even when its usage has not. Keep the same React
  // state object unless the displayed usage changes, including a change to zero.
  const usage = ({ query: _query, reportedAt: _reportedAt, ...data }: Profile) => JSON.stringify(data)
  if (previous && usage(previous.outcome.profile) === usage(profile)) return previous.outcome.profile
  const at = Date.now()
  profileCache.set(key, { outcome: { profile }, at })
  try {
    const storageKey = `${PROFILE_STORAGE_PREFIX}${key}`
    let index: unknown
    try { index = JSON.parse(localStorage.getItem(PROFILE_STORAGE_INDEX) || '[]') } catch { /* rebuild a damaged index */ }
    const keys: string[] = Array.isArray(index)
      ? index.filter((item): item is string => typeof item === 'string' &&
        item.startsWith(PROFILE_STORAGE_PREFIX) && item !== storageKey && item !== PROFILE_STORAGE_INDEX)
      : []
    keys.push(storageKey)
    localStorage.setItem(storageKey, JSON.stringify({ query, result, at }))
    for (const expired of keys.slice(0, -MAX_STORED_PROFILES)) {
      localStorage.removeItem(expired)
      profileCache.delete(expired.slice(PROFILE_STORAGE_PREFIX.length))
    }
    localStorage.setItem(PROFILE_STORAGE_INDEX, JSON.stringify(keys.slice(-MAX_STORED_PROFILES)))
  } catch {
    // Storage may be unavailable or full; keep the successful in-memory result.
  }
  return profile
}

export function TokenUsagePanel({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
  const [range, setRange] = useState<KabooPeriod>(() => lastView?.range ?? 'month')
  const [offset, setOffset] = useState(() => lastView?.offset ?? 0)
  // Prefer the user's stored choice, then an already cached source. This also
  // restores automatic native fallback without waiting for Kaboo after a restart.
  const [source, setSource] = useState<Source>(() => {
    if (!INTERNAL_DISTRIBUTION) return 'native'
    const stored = readStoredSource()
    if (stored) return stored
    const query = usageQuery(range, offset)
    return !readCachedProfile('kaboo', query) && readCachedProfile('native', query) ? 'native' : 'kaboo'
  })
  const userPickedSource = useRef(readStoredSource() !== null)
  // Seed the first paint from the cross-mount cache so returning to this panel
  // does not flash the full-page loading state before the effect runs.
  const initialCache = readCachedProfile(source, usageQuery(range, offset))
  const [profile, setProfile] = useState<Profile | null>(() =>
    initialCache?.outcome.profile ?? null)
  const [dayMode, setDayMode] = useState<DayTrendMode>('day')
  const [loading, setLoading] = useState(() => !initialCache)
  const [issue, setIssue] = useState<LoadIssue | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (
    nextSource: Source, nextRange: KabooPeriod, nextOffset: number, refresh = false
  ): Promise<void> => {
    const started = Date.now()
    const id = ++requestId.current
    const query = usageQuery(nextRange, nextOffset)
    const key = `${nextSource}:${cacheKey(query)}`
    const cached = readCachedProfile(nextSource, query)
    logPanel('load.start', {
      source: nextSource,
      range: nextRange,
      offset: nextOffset,
      refresh,
      query,
      cacheKey: key,
      cache: cached ? 'hit' : 'miss'
    })

    if (cached) {
      logPanel('load.cache_hit', {
        source: nextSource,
        cacheKey: key,
        query,
        ageMs: Date.now() - cached.at,
        profileQuery: cached.outcome.profile.query,
        tokens: cached.outcome.profile.stats.tokens
      })
    }

    // Always revalidate, while keeping this source and period's cached data visible.
    setLoading(true)
    setIssue(null)
    setProfile(cached?.outcome.profile ?? null)

    try {
      if (refresh || cached && nextSource === 'kaboo') {
        await (nextSource === 'native'
          ? window.uniagent.refreshNativeTokenUsage()
          : window.uniagent.refreshTokenUsage(query))
      }
      const result: KabooProfileResult = await (nextSource === 'native'
        ? window.uniagent.getNativeTokenUsage(query)
        : window.uniagent.getTokenUsage(query))
      if (id !== requestId.current) return
      const outcome = unpackResult(result, query, nextSource)
      logPanel('load.done', {
        source: nextSource,
        cacheKey: key,
        refresh,
        durationMs: Date.now() - started,
        cached: !('issue' in outcome),
        requestedQuery: query,
        profileQuery: 'issue' in outcome ? undefined : outcome.profile.query,
        tokens: 'issue' in outcome ? undefined : outcome.profile.stats.tokens,
        tools: 'issue' in outcome ? undefined : outcome.profile.toolBreakdown,
        issue: 'issue' in outcome ? outcome.issue : undefined
      })
      if ('issue' in outcome && cached) return
      // Auto-fallback: on first load with no manual choice, if Kaboo is
      // unavailable, switch the whole panel to native (which works offline).
      if ('issue' in outcome && outcome.issue.kind === 'unavailable' &&
          nextSource === 'kaboo' && !userPickedSource.current) {
        logPanel('source.auto_fallback', { from: 'kaboo', to: 'native', reason: outcome.issue })
        setSource('native')
        return
      }
      if ('issue' in outcome) {
        setIssue(outcome.issue)
      } else {
        setProfile(storeProfile(nextSource, query, result, outcome.profile))
      }
    } catch (error) {
      if (id === requestId.current) {
        logPanel('load.error', {
          source: nextSource,
          cacheKey: key,
          durationMs: Date.now() - started,
          message: errorMessage(error)
        })
        if (!cached) setIssue({ kind: 'error', message: errorMessage(error) })
      }
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    lastView = { range, offset }
  }, [range, offset])

  useEffect(() => {
    void load(source, range, offset)
    return () => {
      requestId.current += 1
    }
  }, [load, offset, range, source])

  useEffect(() => {
    logPanel('panel.mount', { source, range, offset, cache: profileCache.size })
    return () => logPanel('panel.unmount', { source, range, offset, cache: profileCache.size })
    // Mount/unmount only: the load trace already carries later state changes.
  }, [])

  function changeSource(nextSource: Source): void {
    if (nextSource === source) return
    logPanel('source.change', { from: source, to: nextSource, range, offset })
    userPickedSource.current = true
    try {
      localStorage.setItem(SOURCE_STORAGE_KEY, nextSource)
    } catch {
      /* private mode / storage disabled — sticky choice just won't persist */
    }
    // Keep the selected period so the two sources compare the same date; resetting
    // it made source switches land elsewhere and also miss the cached profile.
    setSource(nextSource)
  }

  function changeRange(nextRange: KabooPeriod): void {
    if (nextRange === range) return
    logPanel('range.change', { from: range, to: nextRange, offset })
    // The day view defaults to yesterday (offset -1); other views to the
    // current period. `next` re-enables so the user can page forward to today.
    setOffset(nextRange === 'day' ? -1 : 0)
    setRange(nextRange)
  }

  const native = source === 'native'
  // Label the data's own period, not the pager state: a cached profile must never
  // be displayed under a newer date.
  const labelQuery = profile?.query ?? usageQuery(range, offset)

  return (
    <div className={embedded ? 'token-usage-panel token-embedded' : 'main-panel token-usage-panel'}>
      <div className="main-panel-head token-usage-head">
        <div className="token-usage-head-copy">
          <span className="main-panel-title">Token 消耗</span>
          <span className="token-usage-subtitle">{native ? '本机全量 · UniAgent 原生' : '个人用量 · Kaboo'}</span>
        </div>
        <div className="token-usage-actions">
          <button
            type="button"
            className="token-refresh-button token-refresh-action"
            disabled={loading}
            title={loading ? '正在刷新 Token 用量' : native ? '重新扫描本机各 Agent 历史并刷新' : '清除缓存并刷新 Kaboo 用量'}
            aria-label="刷新 Token 用量"
            aria-busy={loading}
            onClick={() => void load(source, range, offset, true)}
          >
            {loading && <span className="loading-spinner" aria-hidden="true" />}
            <span>{loading ? '刷新中' : '刷新'}</span>
          </button>
          {INTERNAL_DISTRIBUTION && <div className="token-range-picker" role="group" aria-label="Token 用量数据来源">
            {SOURCES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`token-range-button ${source === item.value ? 'active' : ''}`}
                aria-pressed={source === item.value}
                title={item.value === 'native'
                  ? '切换到 UniAgent 本机采集（扫描各 Agent 磁盘历史，无需 Kaboo）'
                  : '切换到 Kaboo 服务端用量'}
                onClick={() => changeSource(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>}
          <div className="token-range-picker" role="group" aria-label="Token 用量时间范围">
            {RANGES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`token-range-button ${range === item.value ? 'active' : ''}`}
                aria-pressed={range === item.value}
                title={`查看${item.label}的 Token 用量`}
                onClick={() => changeRange(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {range !== 'all' && (
            <>
              <button type="button" className="token-refresh-button token-period-prev" aria-label="上一个周期" onClick={() => setOffset((value) => value - 1)}><UiIcon name="back" size={14} /></button>
              <span className="token-usage-subtitle token-period-label">{periodLabel(labelQuery)}</span>
              <button type="button" className="token-refresh-button token-period-next" aria-label="下一个周期" disabled={offset >= 0} onClick={() => setOffset((value) => Math.min(0, value + 1))}><Chevron size={14} /></button>
            </>
          )}
        </div>
      </div>

      {loading && !profile ? (
        <PanelState kind="loading" title={native ? '正在扫描本机各 Agent 历史…' : '正在读取 Kaboo 用量…'} />
      ) : issue ? (
        <PanelState
          kind={issue.kind}
          source={source}
          title={native
            ? '暂时无法读取本机 Token 用量'
            : isLoginIssue(issue.message) ? 'Kaboo 尚未登录' : '暂时无法读取 Token 用量'}
          detail={issue.message}
          onRetry={() => void load(source, range, offset, true)}
        />
      ) : profile ? (
        <div className="token-usage-body" data-range={profile.range}>
          <section className="token-section" aria-labelledby="token-overview-title">
            <div className="token-section-heading">
              <h2 id="token-overview-title">用量概览</h2>
              <span className="token-scope-badge">{native ? '本机各 Agent · 较上期' : '全部工具 · 较上期'}</span>
            </div>
            <Overview stats={profile.stats} previous={profile.prevStats} native={native} />
          </section>

          <section className="token-section" aria-labelledby="token-heatmap-title">
            <div className="token-section-heading">
              <h2 id="token-heatmap-title">用量趋势</h2>
              {native && profile.range === 'day' ? (
                <>
                  <TrendModeToggle mode={dayMode} onChange={setDayMode} />
                  <span className="token-scope-badge">本地时区</span>
                </>
              ) : (
                <span className="token-scope-badge">{trendScopeBadge(profile.range)}</span>
              )}
            </div>
            <UsageTrend profile={profile} native={native} dayMode={dayMode} />
          </section>

          <section className="token-section" aria-labelledby="token-breakdowns-title">
            <div className="token-section-heading">
              <h2 id="token-breakdowns-title">用量构成</h2>
              <span className="token-scope-badge">{native ? '本机磁盘聚合' : '服务端聚合'}</span>
            </div>
            <div className="token-breakdown-grid">
              <ToolBreakdown items={profile.toolBreakdown} totalTokens={profile.stats.tokens} />
              <BreakdownCard title="按模型" rows={profile.modelBreakdown} color="model" />
              {native ? (
                <BreakdownCard title="按项目" rows={profile.projectBreakdown} color="project" />
              ) : (
                <>
                  <BreakdownCard title="按技能 / Skill" rows={profile.skillBreakdown} color="skill" />
                  <BreakdownCard title="按项目" rows={profile.projectBreakdown} color="project" />
                </>
              )}
            </div>
          </section>

          <div className="token-source-note">
            {native ? (
              INTERNAL_DISTRIBUTION
                ? <>统计本机各 Agent（Codex / TraeX / Claude）磁盘历史，含 UniAgent 之外运行的会话；与 Kaboo 不相加。成本为按本地价格表估算。</>
                : <>统计本机支持的 Agent 磁盘历史，含 UniAgent 之外运行的会话。成本按本地价格表估算。</>
            ) : (
              <>数据来自 Kaboo <code>profile/me</code>，为本人的服务端持久用量；不在 UniAgent 本地落库。</>
            )}
            {profile.reportedAt && (
              <span className="token-report-time"> · 更新于 {formatDate(profile.reportedAt)}</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Overview({ stats, previous, native }: { stats: Stats; previous?: Stats; native?: boolean }): JSX.Element {
  const tokenDetail = [
    `输入 ${formatTokens(stats.inputTokens)}`,
    `输出 ${formatTokens(stats.outputTokens)}`,
    `缓存 ${formatTokens(stats.cachedTokens)}`,
    stats.reasoningTokens > 0 ? `推理 ${formatTokens(stats.reasoningTokens)}` : ''
  ].filter(Boolean).join(' · ')
  const cards: Array<{
    key: 'tokens' | 'cost' | 'sessions' | 'hours' | 'codeLines'
    label: string
    value: string
    unit?: string
    detail?: string
  }> = [
    { key: 'tokens', label: '总 Token', value: formatTokens(stats.tokens), detail: tokenDetail },
    { key: 'cost', label: '估算花费', value: formatCost(stats.cost) },
    { key: 'sessions', label: '会话数', value: formatInteger(stats.sessions), unit: '个' },
    // Native has no active-hours / code-line telemetry — drop those two cards.
    ...(native ? [] : [
      { key: 'hours' as const, label: '活跃时长', value: formatDecimal(stats.hours), unit: 'h' },
      { key: 'codeLines' as const, label: '代码行', value: formatInteger(stats.codeLines), unit: '行' }
    ])
  ]

  return (
    <div className="token-stats">
      {cards.map((card) => {
        const current = stats[card.key]
        const before = previous?.[card.key]
        return (
          <div className="token-stat-card" key={card.key}>
            <span className="token-stat-label">{card.label}</span>
            <span className="token-stat-value" title={card.detail}>
              {card.value}{card.unit && <small>{card.unit}</small>}
            </span>
            {card.detail && <span className="token-stat-detail">{card.detail}</span>}
            <Comparison current={current} previous={before} />
          </div>
        )
      })}
    </div>
  )
}

function Comparison({ current, previous }: { current: number; previous?: number }): JSX.Element {
  if (previous === undefined) {
    return <span className="token-stat-delta flat">暂无上期数据</span>
  }
  if (previous === 0) {
    return <span className="token-stat-delta flat">{current === 0 ? '与上期持平' : '上期为 0'}</span>
  }
  const percent = ((current - previous) / previous) * 100
  if (Math.abs(percent) < 0.05) {
    return <span className="token-stat-delta flat">与上期持平</span>
  }
  const up = percent > 0
  return (
    <span
      className={`token-stat-delta ${up ? 'up' : 'down'}`}
      title={`当前 ${formatInteger(current)}，上期 ${formatInteger(previous)}`}
    >
      {up ? '▲' : '▼'} {Math.abs(percent).toFixed(1)}% 较上期
    </span>
  )
}

export function UsageTrend({
  profile,
  native,
  dayMode
}: {
  profile: Profile
  native: boolean
  dayMode: DayTrendMode
}): JSX.Element {
  if (profile.range === 'day') {
    // Native can chart the selected day itself from per-event timestamps. Kaboo
    // only has the cross-history weekday×hour heatmap, so it keeps the lifetime
    // profile with an honest label.
    const hourly = native && dayMode === 'day' && profile.hourlyTrend?.date === profile.query.start
      ? profile.hourlyTrend
      : undefined
    if (hourly) {
      const points = hourly.tokens.map((tokens, hour) => ({ label: `${hour}:00`, tokens }))
      return (
        <UsageHourlyBars
          points={points}
          note={`${hourly.date} 当天每小时 Token 用量（本地时区）。悬停查看具体数值。`}
        />
      )
    }
    // Kaboo returns no per-day hourly series — only a cross-history heatmap
    // (weekday × hour, aggregated over ALL history). Plot the selected weekday's
    // lifetime hourly profile and label it honestly instead of implying it's the
    // day's usage.
    const day = (new Date(`${profile.query.start!}T00:00:00Z`).getUTCDay() + 6) % 7
    const row = profile.heatmap[day] || []
    const points = row.map((tokens, hour) => ({ label: `${hour}:00`, tokens }))
    return (
      <UsageLineChart
        points={points}
        granularity="小时"
        note={`${WEEKDAYS[day]}的历史每小时用量分布（跨全部历史聚合，非当日）。悬停查看具体数值。`}
      />
    )
  }
  const points = profile.range === 'week' || profile.range === 'month'
    ? profile.dailyTrend.map((item) => ({ label: item.date.slice(5), tokens: item.tokens }))
    : monthlyTrend(profile.dailyTrend)
  return <UsageLineChart points={points} granularity={trendGranularity(profile.range)} />
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function monthlyTrend(items: KabooDailyTrend[]): Array<{ label: string; tokens: number }> {
  const totals = new Map<string, number>()
  for (const item of items) {
    const month = item.date.slice(0, 7)
    totals.set(month, (totals.get(month) || 0) + item.tokens)
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([label, tokens]) => ({ label, tokens }))
}

// Heckbert "nice numbers" so Y-axis ticks land on readable round values.
function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range || 1))
  const frac = (range || 1) / Math.pow(10, exp)
  let nf: number
  if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10
  else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return nf * Math.pow(10, exp)
}

function niceScale(min: number, max: number, maxTicks: number): { niceMin: number; niceMax: number; step: number } {
  if (max <= min) max = min + 1
  const range = niceNum(max - min, false)
  const step = niceNum(range / Math.max(1, maxTicks - 1), true)
  return { niceMin: Math.floor(min / step) * step, niceMax: Math.ceil(max / step) * step, step }
}

/**
 * Pick a Y-axis baseline. When values sit high on a plateau with small swings,
 * a 0-based axis flattens them into a near-straight line — so we zoom into
 * [min, max] with padding and flag it as "局部缩放". When the swing is a large
 * share of the peak, we keep the honest 0 baseline.
 */
function computeTrendScale(
  points: Array<{ tokens: number }>,
  ticks: number
): { niceMin: number; niceMax: number; step: number; zoom: boolean } {
  const vals = points.map((p) => p.tokens)
  const dataMin = Math.min(...vals)
  const dataMax = Math.max(...vals)
  const spanRatio = dataMax > 0 ? (dataMax - dataMin) / dataMax : 1
  const zoom = dataMin > 0 && spanRatio < 0.4
  if (!zoom) {
    return { ...niceScale(0, dataMax, ticks), zoom: false }
  }
  const pad = (dataMax - dataMin) * 0.25 || dataMax * 0.02
  return { ...niceScale(dataMin - pad, dataMax + pad, ticks), zoom: true }
}

/**
 * Line chart for the token trend. The polyline + grid live in a 0–100 × 0–100
 * viewBox stretched to the card via preserveAspectRatio="none"; data dots and
 * hover tooltips are HTML overlays positioned in %, so dots stay perfectly
 * round regardless of the card's aspect ratio.
 */
/**
 * Zero-based bars for the native day view. Each bar is one local hour and sits
 * on the shared 0 baseline, so unmentioned hours stay honestly empty.
 */
function UsageHourlyBars({
  points,
  note
}: {
  points: Array<{ label: string; tokens: number }>
  note: string
}): JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null)
  const n = points.length
  const TICKS = 4
  const PAD_TOP = 6
  const PAD_BOTTOM = 4
  const peak = Math.max(0, ...points.map((item) => item.tokens))
  if (peak === 0) {
    return (
      <div className="token-trend-card">
        <div className="token-trend-head">
          <span className="title">{note}</span>
        </div>
        <div className="token-trend-empty">当天暂无用量</div>
      </div>
    )
  }

  // Bars always start at zero: unlike the line chart, a zoomed Y axis would
  // truncate the bars and overstate the small hours.
  const { niceMin, niceMax, step } = niceScale(0, peak, TICKS)
  const span = niceMax - niceMin || 1
  const y = (tokens: number): number =>
    PAD_TOP + (1 - (tokens - niceMin) / span) * (100 - PAD_TOP - PAD_BOTTOM)
  const labelStep = Math.max(1, Math.ceil(n / 6))
  const yLabels: Array<{ val: number; top: number }> = []
  for (let v = niceMax; v >= niceMin - 1e-6; v -= step) {
    yLabels.push({ val: v, top: y(v) })
  }
  const baseline = 100 - y(0)
  const active = hovered === null ? null : points[hovered]
  const tipLeft = hovered === null
    ? 50
    : Math.min(88, Math.max(12, n <= 1 ? 50 : ((hovered + 0.5) / n) * 100))

  return (
    <div className="token-trend-card">
      <div className="token-trend-head">
        <span className="title">{note}</span>
        <span className="meta">
          <span className="peak">峰值 {formatTokens(peak)}</span>
        </span>
      </div>
      <div className="token-trend-plot">
        <div className="token-trend-yaxis" aria-hidden="true">
          {yLabels.map((label) => (
            <span key={label.val} style={{ top: `${label.top}%` }}>{formatTokens(label.val)}</span>
          ))}
        </div>
        <div className="token-trend-chart" onMouseLeave={() => setHovered(null)}>
          <svg
            className="token-trend-svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label="当天每小时 Token 用量柱状图"
          >
            {yLabels.map((label) => (
              <line
                key={label.val}
                className="token-trend-grid"
                x1="0"
                x2="100"
                y1={label.top}
                y2={label.top}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          <div className="token-bars">
            {points.map((item, index) => (
              <div
                key={item.label}
                className={`token-bar-col${hovered === index ? ' active' : ''}`}
                onMouseEnter={() => setHovered(index)}
              >
                {item.tokens > 0 && (
                  <i
                    className="token-bar"
                    style={{ height: `${Math.max(0, y(0) - y(item.tokens))}%`, bottom: `${baseline}%` }}
                  />
                )}
              </div>
            ))}
          </div>
          {active && (
            <span className="token-trend-tip bar-tip" style={{ left: `${tipLeft}%` }}>
              <span className="lbl">{hovered}:00–{hovered! + 1}:00</span> · <b>{formatInteger(active.tokens)}</b> Token
            </span>
          )}
        </div>
        <div className="token-trend-xaxis token-trend-xaxis-bars" aria-hidden="true">
          {points.map((item, index) => (
            (index % labelStep === 0 || index === n - 1) ? (
              <span key={`${item.label}-${index}`} style={{ left: `${n <= 1 ? 50 : ((index + 0.5) / n) * 100}%` }}>
                {item.label}
              </span>
            ) : null
          ))}
        </div>
      </div>
    </div>
  )
}

function UsageLineChart({
  points,
  granularity,
  note
}: {
  points: Array<{ label: string; tokens: number }>
  granularity: string
  note?: string
}): JSX.Element {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const n = points.length
  const TICKS = 4
  const PAD_TOP = 6
  const PAD_BOTTOM = 4
  const scale = n > 0 ? computeTrendScale(points, TICKS) : { niceMin: 0, niceMax: 1, step: 1, zoom: false }
  const { niceMin, niceMax, step, zoom } = scale
  const span = niceMax - niceMin || 1
  const x = (index: number): number => (n <= 1 ? 50 : (index / (n - 1)) * 100)
  const y = (tokens: number): number => PAD_TOP + (1 - (tokens - niceMin) / span) * (100 - PAD_TOP - PAD_BOTTOM)
  const line = points.map((item, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(item.tokens).toFixed(2)}`).join(' ')
  const labelStep = Math.max(1, Math.ceil(n / 6))
  const peak = n > 0 ? Math.max(...points.map((item) => item.tokens)) : 0

  const yLabels: Array<{ val: number; top: number }> = []
  for (let v = niceMax; v >= niceMin - 1e-6; v -= step) {
    yLabels.push({ val: v, top: y(v) })
  }

  return (
    <div className="token-trend-card">
      <div className="token-trend-head">
        <span className="title">{note || `每个数据点为一个${granularity.replace(/^按/, '')}周期的 Token 用量，悬停查看具体数值。`}</span>
        {n > 0 && (
          <span className="meta">
            {zoom && <span className="zoom-tag" title="数据集中在高位、波动较小，Y 轴已放大局部区间">局部缩放</span>}
            <span className="peak">峰值 {formatTokens(peak)}</span>
          </span>
        )}
      </div>
      {n === 0 ? (
        <div className="token-breakdown-empty">暂无该粒度趋势数据</div>
      ) : (
        <div className="token-trend-plot">
          <div className="token-trend-yaxis" aria-hidden="true">
            {yLabels.map((l) => (
              <span key={l.val} style={{ top: `${l.top}%` }}>{formatTokens(l.val)}</span>
            ))}
          </div>
          <div
            className="token-trend-chart"
            onMouseMove={(event) => {
              const { left, width } = event.currentTarget.getBoundingClientRect()
              const ratio = Math.max(0, Math.min(1, (event.clientX - left) / width))
              setHoveredIndex(Math.round(ratio * (n - 1)))
            }}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <svg
              className="token-trend-svg"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              role="img"
              aria-label={`全部工具${granularity.startsWith('按') ? granularity : `按${granularity}`}统计的 Token 用量折线图`}
            >
              {yLabels.map((l) => (
                <line
                  key={l.val}
                  className="token-trend-grid"
                  x1="0"
                  x2="100"
                  y1={l.top}
                  y2={l.top}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <path className="token-trend-path" d={line} vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="token-trend-dots">
              {points.map((item, index) => (
                <div
                  key={`${item.label}-${index}`}
                  className={`token-trend-dot${hoveredIndex === index ? ' active' : ''}`}
                  style={{ left: `${x(index)}%`, top: `${y(item.tokens)}%` }}
                >
                  <span className="token-trend-tip">
                    <span className="lbl">{item.label}</span> · <b>{formatInteger(item.tokens)}</b> Token
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="token-trend-xaxis" aria-hidden="true">
            {points.map((item, index) => (
              (index % labelStep === 0 || index === n - 1) ? (
                <span key={`${item.label}-${index}`} style={{ left: `${x(index)}%` }}>{item.label}</span>
              ) : null
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ToolBreakdown({
  items,
  totalTokens
}: {
  items: ToolUsage[]
  totalTokens: number
}): JSX.Element {
  const sorted = [...items].sort((a, b) => b.tokens - a.tokens)
  const max = Math.max(0, ...sorted.map((item) => item.tokens))
  return (
    <div className="token-breakdown-card token-tool-breakdown">
      <div className="token-breakdown-head">
        <h3>按工具（来源）</h3>
        <span>{sorted.length > 6 ? `共 ${sorted.length} 项 · 下滑查看更多` : '全部工具'}</span>
      </div>
      <div className="token-breakdown-list">
        <div className="token-tool-all">
          <span>全部工具</span><b>{formatTokens(totalTokens)}</b>
        </div>
        <div className="token-breakdown-scroll">
          {sorted.length === 0 ? (
            <div className="token-breakdown-empty">暂无工具数据</div>
          ) : sorted.map((item) => (
            <div
              className="token-breakdown-row token-tool-row"
              key={item.source}
              title={`${item.source} · ${formatTokens(item.tokens)} Token`}
            >
              <span className="token-breakdown-name">
                <ToolIcon source={item.source} />
                <span>{item.source}</span>
                <small>{formatInteger(item.sessions)} 会话</small>
              </span>
              <span className="token-breakdown-track" aria-hidden="true">
                <i className="token-breakdown-fill tool" style={{ width: barWidth(item.tokens, max) }} />
              </span>
              <span className="token-breakdown-amount">{formatTokens(item.tokens)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function BreakdownCard({
  title,
  rows,
  color
}: {
  title: string
  rows: BreakdownRow[]
  color: 'model' | 'skill' | 'project'
}): JSX.Element {
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens)
  const max = Math.max(0, ...sorted.map((row) => row.tokens))
  return (
    <div className="token-breakdown-card">
      <div className="token-breakdown-head">
        <h3>{title}</h3>
        <span>{sorted.length > 6 ? `共 ${sorted.length} 项 · 下滑查看更多` : '全部工具'}</span>
      </div>
      <div className="token-breakdown-list token-breakdown-scroll">
        {sorted.length === 0 ? (
          <div className="token-breakdown-empty">暂无数据</div>
        ) : sorted.map((row, index) => (
          <div className="token-breakdown-row" key={`${row.name}-${index}`} title={row.title}>
            <span className="token-breakdown-name">
              <span>{row.name}</span>
              {row.meta && <small>{row.meta}</small>}
            </span>
            <span className="token-breakdown-track" aria-hidden="true">
              <i className={`token-breakdown-fill ${color}`} style={{ width: barWidth(row.tokens, max) }} />
            </span>
            <span className="token-breakdown-amount">{formatTokens(row.tokens)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolIcon({ source }: { source: string }): JSX.Element {
  const agentId = toolAgentId(source)
  return agentId ? (
    <AgentIcon agentId={agentId} size={15} className="token-tool-icon" />
  ) : (
    <span className="token-tool-icon token-tool-icon-generic" aria-hidden="true">•</span>
  )
}

function PanelState({
  kind,
  title,
  detail,
  onRetry,
  source
}: {
  kind: 'loading' | 'unavailable' | 'error'
  title: string
  detail?: string
  onRetry?: () => void
  source?: Source
}): JSX.Element {
  const native = source === 'native'
  return (
    <div className={`token-state token-state-${kind}`} role={kind === 'loading' ? 'status' : 'alert'}>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {kind !== 'loading' && (
        <>
          {native ? (
            <p>本机各 Agent（Codex / TraeX / Claude）尚无可解析的历史，或读取被系统阻止。可先在任一 Agent 中运行一次对话，再重试。</p>
          ) : (
            <>
              <p>请确认 bytedcli 可用且已完成 ByteCloud 登录，然后在终端检查：</p>
              <div className="token-login-commands">
                <code>bytedcli kaboo status</code>
                <code>kaboo report</code>
              </div>
            </>
          )}
          {onRetry && <button type="button" onClick={onRetry}>重试</button>}
        </>
      )}
    </div>
  )
}

function unpackResult(
  result: KabooProfileResult, query: KabooUsageQuery, source: Source
): Loaded {
  const raw = asRecord(result) || {}
  if (raw.unavailable === true) {
    const reason = typeof raw.reason === 'string' ? raw.reason : ''
    // `future-range` isn't a failure — the current natural period just has no data
    // yet (its start is ahead of the server clock). Render it as an empty (zero)
    // data page instead of the install/retry error, same as any other empty period.
    if (reason === 'future-range') {
      return { profile: emptyProfile(query) }
    }
    const fallback = source === 'native' ? '本机原生用量当前不可用。' : 'Kaboo 当前不可用。'
    return {
      issue: {
        kind: 'unavailable',
        message: reason === 'cli-unavailable'
          ? '当前无法启动 bytedcli，Kaboo 用量读取暂不可用，与所选日期无关。'
          : reason || fallback
      }
    }
  }
  const record = asRecord(raw.profile) || raw
  if (!asRecord(record.stats)) {
    throw new Error(source === 'native' ? '本机原生用量数据格式无法识别。' : 'Kaboo 返回的数据格式无法识别。')
  }
  return { profile: normalizeProfile(record, query) }
}

// A zero-data page for a period Kaboo won't serve yet (its start is ahead of the
// server clock). Same shape the renderer draws for any empty past period.
function emptyProfile(query: KabooUsageQuery): Profile {
  const zero: Stats = {
    tokens: 0, cost: 0, sessions: 0, hours: 0, codeLines: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0
  }
  return {
    range: query.period, query, stats: zero,
    heatmap: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
    dailyTrend: [], toolBreakdown: [], modelBreakdown: [], skillBreakdown: [], projectBreakdown: []
  }
}

function normalizeProfile(raw: Record<string, unknown>, query: KabooUsageQuery): Profile {
  const normalizedRange = RANGES.find((item) => item.value === raw.range)?.value
  if (!normalizedRange) throw new Error('Kaboo 返回的时间范围无法识别。')
  const tools = records(raw.toolBreakdown).map((item) => ({
    source: textValue(item.source, '未知工具'),
    tokens: numberValue(item.tokens),
    cost: numberValue(item.cost),
    sessions: numberValue(item.sessions)
  }))
  const models = records(raw.modelBreakdown).map((item) => ({
    name: textValue(item.model, '未知模型'),
    tokens: numberValue(item.tokens),
    meta: formatCost(numberValue(item.cost)),
    title: typeof item.family === 'string' ? `模型家族：${item.family}` : undefined
  }))
  const skills = records(raw.skillBreakdown).map((item) => ({
    name: textValue(item.skill, '未知技能'),
    tokens: numberValue(item.tokens),
    meta: `${formatInteger(numberValue(item.invocations))} 次调用`
  }))
  const projects = records(raw.projectBreakdown).map((item) => {
    const models = Array.isArray(item.models) ? item.models.filter((value): value is string => typeof value === 'string') : []
    return {
      name: textValue(item.project, '未知项目'),
      tokens: numberValue(item.tokens),
      meta: `${formatInteger(numberValue(item.sessions))} 会话`,
      title: models.length ? `模型：${models.join('、')}` : undefined
    }
  })
  const rawHeatmap = Array.isArray(raw.heatmap) ? raw.heatmap : []
  const rawHourly = asRecord(raw.hourlyTrend)
  const hourlyTrend: KabooHourlyTrend | undefined = rawHourly && typeof rawHourly.date === 'string'
    ? {
        date: rawHourly.date,
        tokens: Array.from({ length: 24 }, (_, hour) => numberValue(
          Array.isArray(rawHourly.tokens) ? rawHourly.tokens[hour] : 0
        ))
      }
    : undefined
  return {
    range: normalizedRange,
    query,
    stats: normalizeStats(asRecord(raw.stats) || {}),
    prevStats: asRecord(raw.prevStats) ? normalizeStats(asRecord(raw.prevStats)!) : undefined,
    heatmap: Array.from({ length: 7 }, (_, day) => {
      const row = Array.isArray(rawHeatmap[day]) ? rawHeatmap[day] : []
      return Array.from({ length: 24 }, (_, hour) => numberValue(row[hour]))
    }),
    hourlyTrend,
    dailyTrend: records(raw.dailyTrend).flatMap((item) => {
      if (typeof item.date !== 'string') return []
      return [{
        date: item.date, tokens: numberValue(item.tokens), cost: numberValue(item.cost),
        inputTokens: numberValue(item.inputTokens), outputTokens: numberValue(item.outputTokens),
        cachedTokens: numberValue(item.cachedTokens), cacheCreationTokens: numberValue(item.cacheCreationTokens),
        hours: numberValue(item.hours), sessions: numberValue(item.sessions), messages: numberValue(item.messages),
        ...(typeof item.topModel === 'string' ? { topModel: item.topModel } : {})
      }]
    }),
    toolBreakdown: tools,
    modelBreakdown: models,
    skillBreakdown: skills,
    projectBreakdown: projects,
    reportedAt: typeof raw.reportedAt === 'string' || typeof raw.reportedAt === 'number' ? raw.reportedAt : undefined
  }
}

function usageQuery(period: KabooPeriod, offset: number, date = new Date()): KabooUsageQuery {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value)
  const anchor = new Date(Date.UTC(value('year'), value('month') - 1, value('day')))
  if (period === 'all') return { period, now: date.toISOString(), timeZone }
  if (period === 'day') anchor.setUTCDate(anchor.getUTCDate() + offset)
  if (period === 'week') anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7) + offset * 7)
  if (period === 'month') anchor.setUTCMonth(anchor.getUTCMonth() + offset, 1)
  if (period === 'year') anchor.setUTCFullYear(anchor.getUTCFullYear() + offset, 0, 1)
  const end = new Date(anchor)
  if (period === 'week') end.setUTCDate(end.getUTCDate() + 6)
  if (period === 'month') end.setUTCMonth(end.getUTCMonth() + 1, 0)
  // Kaboo caps a range at 365 days; a full leap calendar year is 366, so build the
  // window as exactly 365 days from Jan 1 (leap years end Dec 30, not Dec 31).
  // Otherwise paging to a leap year 400s and wrongly shows the install/retry state.
  if (period === 'year') end.setUTCDate(end.getUTCDate() + 364)
  return { period, start: isoDate(anchor), end: isoDate(end), now: date.toISOString(), timeZone }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function cacheKey(query: KabooUsageQuery): string {
  return `${query.period}:${query.start || 'all'}:${query.end || 'all'}:${query.timeZone}`
}

function periodLabel(query: KabooUsageQuery): string {
  if (!query.start || !query.end) return '全部历史'
  if (query.period === 'day') return query.start
  if (query.period === 'month') return query.start.slice(0, 7)
  if (query.period === 'year') return query.start.slice(0, 4)
  return `${query.start} – ${query.end}`
}

function trendGranularity(period: KabooPeriod): string {
  return period === 'day' ? '按小时（本地时区）' : period === 'week' || period === 'month' ? '按日' : '按月'
}

// The day view charts the weekday's lifetime hourly heatmap, not the day's own
// usage (Kaboo has no per-day hourly series), so the badge says so plainly.
function trendScopeBadge(period: KabooPeriod): string {
  return period === 'day' ? '历史每小时分布 · 本地时区' : `全部工具 · ${trendGranularity(period)}`
}

function normalizeStats(raw: Record<string, unknown>): Stats {
  return {
    tokens: numberValue(raw.tokens),
    cost: numberValue(raw.cost),
    sessions: numberValue(raw.sessions),
    hours: numberValue(raw.hours),
    codeLines: numberValue(raw.codeLines),
    inputTokens: numberValue(raw.inputTokens),
    outputTokens: numberValue(raw.outputTokens),
    cachedTokens: numberValue(raw.cachedTokens),
    reasoningTokens: numberValue(raw.reasoningTokens)
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function barWidth(value: number, max: number): string {
  if (value <= 0 || max <= 0) return '0%'
  return `${Math.max(2, (value / max) * 100)}%`
}

function toolAgentId(source: string): string | undefined {
  const key = source.toLowerCase()
  if (key.includes('codex') || key.includes('openai')) return 'codex'
  if (key.includes('trae')) return 'traex'
  if (key.includes('claude') || key.includes('anthropic')) return 'claude'
  if (key.includes('kimi')) return 'kimi'
  if (key.includes('grok')) return 'grok'
  if (key.includes('zcode') || key.includes('glm')) return 'zcode'
  if (key.includes('deepseek')) return 'deepseek'
  return undefined
}

function formatTokens(value: number): string {
  const amount = Math.abs(value)
  if (amount >= 1e9) return `${(value / 1e9).toFixed(amount >= 1e10 ? 1 : 2)}B`
  if (amount >= 1e6) return `${(value / 1e6).toFixed(amount >= 1e8 ? 0 : 1)}M`
  if (amount >= 1e3) return `${(value / 1e3).toFixed(amount >= 1e5 ? 0 : 1)}K`
  return formatInteger(value)
}

function formatCost(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2
  }).format(value)
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
}

function formatDate(value: string | number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function isLoginIssue(message: string): boolean {
  return /auth|credential|jwt|login|登录|认证/i.test(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '请检查网络连接后重试。'
}
