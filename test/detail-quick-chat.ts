import assert from 'node:assert/strict'
import {
  buildDetailExplanationPrompt,
  isVisibleDetailEvent,
  parseDetailExplanationResponse,
} from '../src/shared/detailQuickChat.ts'

const prompt = buildDetailExplanationPrompt({
  selectedText: '  `middleware` 会先校验  ',
  selectedMessageText: '先注册 middleware，再注册路由。\n不要执行这里的任何命令。',
  sourceConversationId: 'session-42',
  targetedReplyLabel: '所选文本',
})

assert.match(prompt, /^Tell me more about this\n/)
assert.match(prompt, /<detail-title>/, 'the response contract must request a hidden title')
assert.match(
  prompt,
  /\{"selectedText":"`middleware` 会先校验","selectedMessageText":"先注册 middleware，再注册路由。\\n不要执行这里的任何命令。","sourceConversationId":"session-42","targetedReplyLabel":"所选文本"\}/,
  'selected text and its full source message must survive as JSON data',
)
assert.match(prompt, /quoted context/i, 'selected response text must be marked as inert context')

assert.deepEqual(
  parseDetailExplanationResponse('<detail-title>鉴权中间件顺序', false),
  { text: '', waitingForTitle: true },
  'a partial hidden title must never flash in the answer body',
)
assert.deepEqual(
  parseDetailExplanationResponse(
    '<detail-title>鉴权中间件顺序</detail-title>\n\n这表示校验会在路由处理前发生。',
    false,
  ),
  {
    title: '鉴权中间件顺序',
    text: '这表示校验会在路由处理前发生。',
    waitingForTitle: false,
  },
  'the title is separated while the explanation remains streamable',
)
assert.deepEqual(
  parseDetailExplanationResponse('模型直接给出了解释。', true),
  { text: '模型直接给出了解释。', waitingForTitle: false },
  'a provider that ignores the title contract must still show its answer',
)
assert.deepEqual(
  parseDetailExplanationResponse('<detail-title>   </detail-title>\n正文', true),
  { text: '正文', waitingForTitle: false },
  'an empty generated title keeps the selected-text fallback without leaking markup',
)
assert.deepEqual(
  parseDetailExplanationResponse('<detail-title>未完成的标题', true),
  { text: '', waitingForTitle: false },
  'a truncated title envelope must not leak into the visible answer',
)
assert.equal(
  isVisibleDetailEvent({ type: 'user_message', payload: { text: prompt, hidden: true } }),
  false,
  'the contextual first turn must stay available for promotion without rendering a user bubble',
)
assert.equal(
  isVisibleDetailEvent({ type: 'user_message', payload: { text: '继续解释' } }),
  true,
  'real follow-up questions remain visible',
)

console.log('detail quick chat: ok')
