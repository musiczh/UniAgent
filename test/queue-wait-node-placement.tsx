import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../src/renderer/components/EventStream'
import { mergeSessionEvent } from '../src/renderer/App.tsx'
import type { UAEvent } from '../src/shared/types.ts'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const event = (
  seq: number,
  ts: number,
  type: UAEvent['type'],
  payload: Record<string, unknown>,
  state: UAEvent['state'] = 'success',
): UAEvent => ({ sessionId: 'queue-nodes', seq, ts, type, state, payload })

const queueEvent = (
  seq: number,
  ts: number,
  id: string,
  queue: Record<string, unknown>,
): UAEvent => event(seq, ts, 'queue_status', { id, queue }, queue.state === 'ready' ? 'success' : 'running')

// 与 App 一致：经 mergeSessionEvent 合并后再渲染，覆盖合并窗口被用户追加消息截断的真实链路。
const render = (events: UAEvent[]): string =>
  renderToStaticMarkup(createElement(EventStream, {
    status: 'running',
    sessionId: 'queue-nodes',
    events: events.reduce((acc, ev) => mergeSessionEvent(acc, ev), [] as UAEvent[]),
  }))

const metas = (html: string): string[] =>
  [...html.matchAll(/等待算力<\/span><span class="process-step-meta">([^<]*)</g)].map(match => match[1])

const realNow = Date.now
try {
  // 场景1（截图回归）— 同一段排队快照被用户追加消息隔开时，活跃排队节点必须落在
  // 追加消息之后的当前时间轴尾部，而不是被锚回追加前的历史位置。
  Date.now = () => 60_000
  const appendSplit = render([
    event(1, 1_000, 'user_message', { text: '继续需求验收' }),
    event(2, 2_000, 'agent_message', { id: 'step-1', phase: 'commentary', text: '我继续补齐剩余用例…' }),
    event(3, 3_000, 'command_exec', { id: 'cmd-1', command: 'pnpm test' }),
    queueEvent(4, 4_000, 'queue-attempt-1', { state: 'waiting', startedAt: 4_000, waitedMs: 0, position: 707, turnId: 'turn-1' }),
    event(5, 5_000, 'user_message', { text: '现在进度咋样了？', appendedToTurn: true }),
    queueEvent(6, 6_000, 'queue-attempt-1', { state: 'waiting', startedAt: 4_000, waitedMs: 0, position: 708, turnId: 'turn-1' }),
  ])
  assert.match(appendSplit, /用户追加消息/, '追加消息卡片渲染')
  assert.match(appendSplit, /等待算力/, '排队中必须显示排队 UI')
  assert.deepEqual(metas(appendSplit), ['第 709 位 · 已等待 56 秒'], '活跃节点展示最新队列位置与等待时长')
  assert.ok(
    appendSplit.indexOf('用户追加消息') < appendSplit.indexOf('process-queue'),
    '排队节点应出现在用户追加消息之后（当前时间轴尾部），而不是被锚回追加前的历史位置',
  )

  // 场景2 — 同一回合内多段排队各自保留独立节点与独立时长。
  Date.now = () => 10_000
  const multiEpisode = render([
    event(1, 1_000, 'user_message', { text: '开工' }),
    queueEvent(2, 2_000, 'queue-episode-a', { state: 'waiting', startedAt: 2_000, waitedMs: 0, position: 30, turnId: 'turn-1' }),
    queueEvent(3, 3_000, 'queue-episode-a', { state: 'ready', waitedMs: 900, acquired: true, turnId: 'turn-1' }),
    event(4, 4_000, 'command_exec', { id: 'cmd-2', command: 'ls' }),
    queueEvent(5, 5_000, 'queue-episode-b', { state: 'waiting', startedAt: 4_500, waitedMs: 0, position: 5, turnId: 'turn-1' }),
  ])
  assert.deepEqual(metas(multiEpisode), ['1 秒 · 已结束', '第 6 位 · 已等待 6 秒'],
    '每段排队独立成节点：已结束节点保留段内时长，活跃节点单独计时')

  // 场景3 — 单段排队（无追加消息）节点仍留在原位并展示已结束时长。
  const singleEpisode = render([
    event(1, 1_000, 'user_message', { text: '开工' }),
    queueEvent(2, 2_000, 'queue-episode-c', { state: 'waiting', startedAt: 2_000, waitedMs: 0, position: 3, turnId: 'turn-1' }),
    queueEvent(3, 3_500, 'queue-episode-c', { state: 'ready', waitedMs: 1_500, acquired: true, turnId: 'turn-1' }),
    event(4, 4_000, 'command_exec', { id: 'cmd-3', command: 'pwd' }),
  ])
  assert.deepEqual(metas(singleEpisode), ['2 秒 · 已结束'], '已结束排队展示段内等待时长')
  assert.ok(
    singleEpisode.indexOf('process-queue') < singleEpisode.indexOf('pwd'),
    '单段排队节点保持在排队发生的顺序位置',
  )

  // 场景4 — 缺少 queue 载荷的异常快照不参与折叠，走 EventCard 兜底，不能让渲染崩溃。
  Date.now = () => 30_000
  const malformed = render([
    event(1, 1_000, 'user_message', { text: '开工' }),
    event(2, 2_000, 'queue_status', { id: 'queue-broken' }, 'running'),
    event(3, 3_000, 'command_exec', { id: 'cmd-4', command: 'echo ok' }),
  ])
  assert.match(malformed, /echo ok/, '异常排队快照不应阻断时间轴渲染')
  assert.deepEqual(metas(malformed), [], '无 queue 载荷的快照不产生排队节点')
} finally {
  Date.now = realNow
}

console.log('PASS queue wait node placement')
