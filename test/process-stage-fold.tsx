import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../src/renderer/components/EventStream'
import type { UAEvent } from '../src/shared/types.ts'
import { renderOpenChains } from './regression/open-chain'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const event = (
  seq: number,
  type: UAEvent['type'],
  payload: Record<string, unknown>,
  state: UAEvent['state'] = 'success',
): UAEvent => ({ sessionId: 'stage-fold', seq, ts: seq * 1_000, type, state, payload })

const HINT_TEXT = 'Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep things sharp.'

const foldCount = (markup: string): number => (markup.match(/class="steps-fold-row"/g) || []).length

// 未达到 8 步上限时，追加消息不再把前面的步骤与上下文压缩整段收起。
const staged = renderOpenChains(createElement(EventStream, {
  status: 'running',
  sessionId: 'stage-fold',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'agent_message', { id: 's1', phase: 'commentary', text: '步骤一' }),
    event(3, 'command_exec', { id: 'c1', command: 'pwd' }),
    event(4, 'user_message', { text: '追加 A', appendedToTurn: true }),
    event(5, 'agent_message', { id: 's2', phase: 'commentary', text: '步骤二' }),
    event(6, 'command_exec', { id: 'c2', command: 'ls' }),
    event(7, 'context_compaction', { id: 'k1' }),
    event(8, 'user_message', { text: '追加 B', appendedToTurn: true }),
    event(9, 'agent_message', { id: 's3', phase: 'commentary', text: '步骤三' }),
    event(10, 'command_exec', { id: 'c3', command: 'git status' }),
  ],
}))

assert.equal(foldCount(staged), 0, '总共只有 3 步，不因追加消息触发折叠')
const stagedOrder = ['步骤一', '追加 A', '步骤二', '上下文压缩完成', '追加 B', '步骤三'].map(text => staged.indexOf(text))
assert.ok(stagedOrder.every((index, i) => index >= 0 && (i === 0 || index > stagedOrder[i - 1])),
  '最近的步骤与上下文压缩、用户追加消息保持原始顺序')

// 最近 8 步按整个过程计算；更早区域被锚点切成 1～2 步时也保持可见。
for (const { count, hidden } of [
  ...[0, 1, 2, 8, 9, 10, 11, 12].map(count => ({ count, hidden: [] as number[] })),
  { count: 14, hidden: [4, 5, 6] },
  { count: 15, hidden: [4, 5, 6] },
]) {
  for (const answered of count >= 2 ? [false, true] : [false]) {
    const events = [event(1, 'user_message', { text: 'run' })]
    const push = (type: UAEvent['type'], payload: Record<string, unknown>): void => {
      events.push(event(events.length + 1, type, payload))
    }
    for (let i = 1; i <= count; i++) {
      push('agent_message', { id: `s${i}`, phase: 'commentary', text: `边界步骤 ${i}` })
      push('command_exec', { id: `c${i}`, command: `cmd-${i}` })
      if (i === 2) {
        push('agent_message', {
          id: 'async-question', delivery: 'async', phase: 'final_answer', text: '确认实验分组？',
          questions: [{ title: '确认实验分组？', options: ['继续'] }],
          ...(answered ? { submittedAnswer: { answers: { q0: { answers: ['继续'] } } } } : {}),
        })
      }
      if (i % 3 === 0) push('user_message', { text: `追加 ${i}`, appendedToTurn: true })
    }
    push('user_message', { text: '最后追加', appendedToTurn: true })
    const markup = renderToStaticMarkup(createElement(EventStream, {
      status: 'running', sessionId: 'stage-fold', events,
    }))
    assert.equal((markup.match(/class="process-step(?: active)?(?: open)?"/g) || []).length, count - hidden.length,
      `${count} 步、提问${answered ? '已回答' : '待回答'}时，最近 8 步和不超过 2 步的旧区域保持可见`)
    for (let i = 1; i <= count; i++) {
      const pattern = new RegExp(`边界步骤 ${i}(?![0-9])`)
      if (hidden.includes(i)) assert.doesNotMatch(markup, pattern, `包含 3 步的旧区域中步骤 ${i} 默认收起`)
      else assert.match(markup, pattern, `最近或零散的旧步骤 ${i} 保持可见`)
    }
    assert.equal(foldCount(markup), hidden.length > 0 ? 1 : 0, '仅超过 2 步的旧区域生成折叠行')
    assert.match(markup, /最后追加/, '尾部追加消息始终可见')
    if (count >= 2) assert.match(markup, /确认实验分组？/, '待回答或已回答的异步提问始终可见')
  }
}

// 不跨锚点时同样按更早区域的步骤数判断，跨越 2→3 的边界后才折叠。
for (const earlierCount of [0, 1, 2, 3]) {
  const markup = renderToStaticMarkup(createElement(EventStream, {
    status: 'running', sessionId: 'stage-fold',
    events: [
      event(1, 'user_message', { text: 'run' }),
      ...Array.from({ length: 8 + earlierCount }, (_, i): UAEvent[] => [
        event(2 + i * 2, 'agent_message', { id: `s${i}`, phase: 'commentary', text: `连续步骤 ${i}` }),
        event(3 + i * 2, 'command_exec', { id: `c${i}`, command: `cmd-${i}` }),
      ]).flat(),
    ],
  }))
  assert.equal(foldCount(markup), earlierCount > 2 ? 1 : 0, `${earlierCount} 步的更早区域仅在超过 2 步时折叠`)
  assert.equal((markup.match(/class="process-step(?: active)?(?: open)?"/g) || []).length,
    earlierCount > 2 ? 8 : 8 + earlierCount, '不折叠时直接展示步骤内容')
}

// 超出最近 8 步的旧内容仍按锚点分段折叠，不能移动消息或合并成一段。
const historicalEvents = [
  event(1, 'user_message', { text: 'run' }),
  ...['步骤一', '步骤二', '步骤三'].flatMap((text, i): UAEvent[] => [
    event(2 + i * 2, 'agent_message', { id: `old-a${i}`, phase: 'commentary', text }),
    event(3 + i * 2, 'command_exec', { id: `old-ca${i}`, command: `old-cmd-a${i}` }),
  ]),
  event(8, 'user_message', { text: '追加 A', appendedToTurn: true }),
  ...['步骤四', '步骤五', '步骤六'].flatMap((text, i): UAEvent[] => [
    event(9 + i * 2, 'agent_message', { id: `old-b${i}`, phase: 'commentary', text }),
    event(10 + i * 2, 'command_exec', { id: `old-cb${i}`, command: `old-cmd-b${i}` }),
  ]),
  event(15, 'context_compaction', { id: 'k1' }),
  event(16, 'user_message', { text: '追加 B', appendedToTurn: true }),
  ...Array.from({ length: 8 }, (_, i): UAEvent[] => [
    event(17 + i * 2, 'agent_message', { id: `recent-${i}`, phase: 'commentary', text: `最近步骤 ${i}` }),
    event(18 + i * 2, 'command_exec', { id: `recent-c${i}`, command: `recent-cmd-${i}` }),
  ]).flat(),
]
const historical = renderToStaticMarkup(createElement(EventStream, {
  status: 'running', sessionId: 'stage-fold', events: historicalEvents,
}))
assert.equal(foldCount(historical), 2, '两段更早内容分别保留一条折叠行')
const fold0 = historical.indexOf('class="steps-fold-row"')
const fold1 = historical.indexOf('class="steps-fold-row"', fold0 + 1)
assert.ok(fold0 < historical.indexOf('追加 A') && historical.indexOf('追加 A') < fold1 &&
  fold1 < historical.indexOf('追加 B') && historical.indexOf('追加 B') < historical.indexOf('最近步骤 0'),
  '旧折叠行、追加消息与最近步骤按原始时间顺序排列')
assert.equal((historical.match(/更早的 3 个步骤/g) || []).length, 2, '每个旧区域的 3 步分别折叠')
assert.doesNotMatch(historical, /步骤[一二三四五六]|上下文压缩完成/, '更早区域的步骤与上下文压缩一起收起')
assert.match(historical, /steps-fold-meta">[^<]*3 命令 · 1 次压缩/, '旧区域摘要保留调用数与压缩次数')

// 区域式而非过滤式：段内的警告等非步骤行随区域一起折叠，不被过滤在外面。
const regionMarkup = renderToStaticMarkup(createElement(EventStream, {
  status: 'running',
  sessionId: 'stage-fold',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'system_notice', { id: 'w1', kind: 'warning', text: 'Storage is running low.' }),
    ...Array.from({ length: 11 }, (_, i): UAEvent[] => [
      event(3 + i * 2, 'agent_message', { id: `s${i}`, phase: 'commentary', text: `步骤 ${i}` }),
      event(4 + i * 2, 'command_exec', { id: `c${i}`, command: `cmd-${i}` }),
    ]).flat(),
  ],
}))
assert.doesNotMatch(regionMarkup, /Storage is running low/,
  '警告与同段步骤一起收进折叠行，不再过滤式地留在折叠行外面')
assert.match(regionMarkup, /更早的 3 个步骤/,
  '折叠行只按步骤计数，警告随区域一并收纳')
assert.match(regionMarkup, /步骤 9/,
  '最近 8 条步骤窗口之外的尾部步骤保持可见')

// id 碰撞回归：历史恢复的重复 payload.id 不得让尾部步骤误入更早区（「全程一直在压缩」）。
const collisionMarkup = renderToStaticMarkup(createElement(EventStream, {
  status: 'running',
  sessionId: 'stage-fold',
  events: [
    event(1, 'user_message', { text: 'run' }),
    ...Array.from({ length: 11 }, (_, i): UAEvent[] => [
      event(2 + i * 2, 'agent_message', { id: 'dup', phase: 'commentary', text: `步骤 ${i}` }),
      event(3 + i * 2, 'command_exec', { id: `c${i}`, command: `cmd-${i}` }),
    ]).flat(),
  ],
}))
assert.match(collisionMarkup, /步骤 9/,
  '步骤 id 撞车时尾部步骤仍按位置留在窗口内')
assert.match(collisionMarkup, /步骤 8/,
  '倒数第 8 条步骤属于最近窗口')
assert.doesNotMatch(collisionMarkup, /步骤 0/,
  '窗口前缀按位置收进折叠行')
assert.doesNotMatch(collisionMarkup, /步骤 1[^0-9]/,
  '窗口前缀收起后不留第二条')
assert.match(collisionMarkup, /更早的 3 个步骤/,
  '折叠行按位置切出 3 条更早步骤')

// 提示折进归属 item：紧随上下文压缩的提示与压缩一起收进工作步骤内部，
// 会话开头无归属的提示维持独立展示（conversation-hints 覆盖）。
const hintMarkup = renderOpenChains(createElement(EventStream, {
  status: 'running',
  sessionId: 'stage-fold',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'agent_message', { id: 's1', phase: 'commentary', text: '准备工作' }),
    event(3, 'command_exec', { id: 'c1', command: 'pwd' }),
    event(4, 'context_compaction', { id: 'k1' }),
    event(5, 'system_notice', { id: 'h1', kind: 'warning', text: HINT_TEXT }),
    event(6, 'agent_message', { id: 's2', phase: 'commentary', text: '继续工作' }),
    event(7, 'command_exec', { id: 'c2', command: 'ls' }),
  ],
}))
const ownerAt = hintMarkup.indexOf('data-step-id="step-reply-s1"')
const compactionAt = hintMarkup.indexOf('data-compaction-id="k1"')
const hintAt = hintMarkup.indexOf('process-notice')
assert.ok(ownerAt >= 0 && compactionAt > ownerAt, '上下文压缩收进所属工作步骤')
assert.doesNotMatch(hintMarkup, /process-runtime/, '上下文压缩不再渲染独立事件行')
assert.match(hintMarkup, /上下文压缩完成/,
  '压缩行保持原有文案')
assert.ok(hintAt > compactionAt, '提示在工作步骤内紧随压缩记录')
const nextRow = /class="process-step[" ]/.exec(hintMarkup.slice(ownerAt + 1))
assert.ok(!nextRow || hintAt < ownerAt + 1 + nextRow.index,
  '提示不占独立时间轴行')
assert.match(hintMarkup, /process-notice warning"><details><summary>/,
  '折进事件行的提示默认收起')

// 展开全部折叠后，各段内容回到原始时间顺序完整呈现。
const expanded = renderOpenChains(createElement(EventStream, {
  status: 'running',
  sessionId: 'stage-fold',
  events: historicalEvents,
}))
const expandedOrder = [
  expanded.indexOf('步骤一'),
  expanded.indexOf('步骤二'),
  expanded.indexOf('步骤三'),
  expanded.indexOf('追加 A'),
  expanded.indexOf('步骤四'),
  expanded.indexOf('步骤五'),
  expanded.indexOf('步骤六'),
  expanded.indexOf('上下文压缩完成'),
  expanded.indexOf('追加 B'),
  expanded.indexOf('最近步骤 0'),
]
assert.ok(expandedOrder.every((index) => index >= 0) && expandedOrder.every((index, i) => i === 0 || index > expandedOrder[i - 1]),
  '展开后按原始顺序完整呈现所有步骤、追加消息与上下文压缩')
assert.equal((expanded.match(/class="steps-fold-row"[^>]*aria-expanded="true"/g) || []).length, 2,
  '两条折叠行展开为「收起」态')

console.log('process stage fold: ok')
