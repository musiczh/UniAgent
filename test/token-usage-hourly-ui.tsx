import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  TrendModeToggle,
  UsageTrend,
  type Profile
} from '../src/renderer/components/TokenUsagePanel.tsx'

const DAY = '2026-10-19'

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    range: 'day',
    query: {
      period: 'day',
      start: DAY,
      end: DAY,
      now: '2026-10-19T08:00:00.000Z',
      timeZone: 'Asia/Shanghai'
    },
    stats: {
      tokens: 300_000_000, cost: 0, sessions: 1, hours: 0, codeLines: 0,
      inputTokens: 200_000_000, outputTokens: 100_000_000, cachedTokens: 0, reasoningTokens: 0
    },
    heatmap: Array.from({ length: 7 }, (_, weekday) => Array.from(
      { length: 24 },
      (_, hour) => weekday === 0 ? 1_000_000 + hour : 0
    )),
    dailyTrend: [],
    hourlyTrend: {
      date: DAY,
      tokens: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100_000_000, 0, 0, 0, 200_000_000, 0, 0, 0, 0, 0, 0, 0, 0]
    },
    toolBreakdown: [],
    modelBreakdown: [],
    skillBreakdown: [],
    projectBreakdown: [],
    ...overrides
  }
}

function renderTrend(overrides: Partial<Profile>, native: boolean, dayMode: 'day' | 'history'): string {
  return renderToStaticMarkup(createElement(UsageTrend, {
    profile: profile(overrides),
    native,
    dayMode
  }))
}

// Native day view charts the selected day's own 24 hours as bars.
const bars = renderTrend({}, true, 'day')
assert.match(bars, new RegExp(`${DAY} 当天每小时 Token 用量（本地时区）`))
assert.match(bars, /aria-label="当天每小时 Token 用量柱状图"/)
assert.equal((bars.match(/token-bar-col/g) || []).length, 24, '当天视图必须渲染 24 个小时槽位')
assert.equal((bars.match(/class="token-bar"/g) || []).length, 2, '只有有消耗的小时才渲染柱子')
assert.match(bars, /峰值 200M/)
assert.equal((bars.match(/token-trend-path/g) || []).length, 0, '当天视图不再渲染历史折线')

// Native history mode keeps the cross-history weekday profile as a line chart.
const history = renderTrend({}, true, 'history')
assert.match(history, /周一的历史每小时用量分布（跨全部历史聚合，非当日）/)
assert.match(history, /token-trend-path/)
assert.equal((history.match(/token-bar-col/g) || []).length, 0, '历史分布必须保留折线而不是小时柱')

// Kaboo has no per-day hourly series, so even a day query keeps the lifetime profile.
const kabooDay = renderTrend({}, false, 'day')
assert.match(kabooDay, /周一的历史每小时用量分布（跨全部历史聚合，非当日）/)
assert.match(kabooDay, /token-trend-path/)

// An empty day is explicit instead of drawing a meaningless 1-unit Y axis.
const empty = renderTrend({
  hourlyTrend: { date: DAY, tokens: new Array<number>(24).fill(0) },
  stats: {
    tokens: 0, cost: 0, sessions: 0, hours: 0, codeLines: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0
  }
}, true, 'day')
assert.match(empty, /当天暂无用量/)
assert.equal((empty.match(/token-bar-col/g) || []).length, 0)

// The mode switch reports the active choice for assistive technology.
const dayToggle = renderToStaticMarkup(createElement(TrendModeToggle, { mode: 'day', onChange: () => {} }))
assert.match(dayToggle, /aria-label="用量趋势统计口径"/)
assert.equal((dayToggle.match(/aria-pressed="true"/g) || []).length, 1)
assert.match(dayToggle, /class="active"[^>]*aria-pressed="true"[^>]*>当天</)

const historyToggle = renderToStaticMarkup(createElement(TrendModeToggle, { mode: 'history', onChange: () => {} }))
assert.equal((historyToggle.match(/aria-pressed="true"/g) || []).length, 1)
assert.match(historyToggle, /class="active"[^>]*aria-pressed="true"[^>]*>历史分布</)

console.log('token usage hourly ui: ok')
