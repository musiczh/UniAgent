// 提问已经形成卡片时，时间线不再重复工具行；紧邻的助手正文补进输入框上方的卡片。
// 填写时保留选项说明，已回答详情只展示题干和最终答案。这些断言走真实 EventStream / QuestionForm。
import assert from 'node:assert/strict'
import React from 'react'
import DOMPurify from 'dompurify'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UAEvent } from '../src/shared/types.ts'
import {
  QuestionForm,
  coveredQuestionToolSeqs,
  questionBackgroundText,
} from '../src/renderer/components/EventStream.tsx'
import { renderEventStream } from './regression/render-event-stream.mjs'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const ev = (
  seq: number,
  type: UAEvent['type'],
  payload: Record<string, unknown>,
  state?: UAEvent['state'],
): UAEvent => ({ sessionId: 's', seq, ts: seq, type, state, payload })

const questionTool = (seq: number, id: string, state: UAEvent['state'] = 'success', name = 'AskUserQuestion'): UAEvent =>
  ev(seq, 'tool_call', { id, name, input: { questions: [{ question: '是否确认？' }] } }, state)

const questionCard = (seq: number, requestId: string, state: UAEvent['state'] = 'pending', extra: Record<string, unknown> = {}): UAEvent =>
  ev(seq, 'approval_request', {
    requestId,
    method: 'item/tool/requestUserInput',
    kind: 'question',
    params: {
      questions: [{
        id: 'design',
        header: '设计确认',
        prompt: '是否确认？',
        options: [{ label: '开始实施', description: '渲染层只保留卡片' }],
      }],
    },
    ...extra,
  }, state)

const hidden = (events: UAEvent[]): number[] => [...coveredQuestionToolSeqs(events)].sort((a, b) => a - b)

const adjacent = [
  ev(1, 'agent_message', { id: 'reply', text: '设计稿位于失败态帧' }, 'success'),
  questionTool(2, 'tool-1', 'running'),
  questionTool(3, 'tool-1'),
  questionCard(4, 'req-1'),
]
assert.deepEqual(hidden(adjacent), [2, 3], '同一提问工具的 running 与 success 跟卡片一起隐藏')
assert.equal(questionBackgroundText(adjacent, adjacent[3]), '设计稿位于失败态帧')

const acrossCommand = [
  ev(1, 'agent_message', { id: 'reply', text: '更早的正文' }, 'success'),
  questionTool(2, 'tool-grok', 'success', '设计确认'),
  ev(3, 'command_exec', { command: 'echo block' }, 'success'),
  questionCard(4, 'req-grok', 'pending', { params: { toolCallId: 'tool-grok', questions: [{ id: 'design', prompt: '是否确认？', options: [] }] } }),
]
assert.deepEqual(hidden(acrossCommand), [2], 'toolCallId 对上时，中间隔着命令也隐藏这条工具')
assert.equal(questionBackgroundText(acrossCommand, acrossCommand[3]), '', '命令隔开后不把更早正文当作背景')

const commandBetween = [
  ev(1, 'agent_message', { id: 'reply', text: '不应进入卡片' }, 'success'),
  ev(2, 'command_exec', { command: 'echo block' }, 'success'),
  questionTool(3, 'tool-2'),
  questionCard(4, 'req-2'),
]
assert.deepEqual(hidden(commandBetween), [3], '工具紧挨着卡片时仍隐藏，即使前面有命令')
assert.equal(questionBackgroundText(commandBetween, commandBetween[3]), '')

const unrelated = [
  questionTool(1, 'orphan'),
  ev(2, 'command_exec', { command: 'echo keep' }, 'success'),
  questionCard(3, 'req-later'),
]
assert.deepEqual(hidden(unrelated), [], '中间被命令隔开、又对不上 id 的工具行保留')
assert.deepEqual(hidden([questionTool(1, 'alone')]), [], '没有提问卡片时工具行保留')

const glue = [
  ev(1, 'agent_message', { id: 'reply', text: '跳过用量和思考' }, 'success'),
  ev(2, 'system_notice', { kind: 'usage', usage: { inputTokens: 1 } }),
  ev(3, 'reasoning', { text: '想一下' }, 'success'),
  questionTool(4, 'tool-3'),
  questionCard(5, 'req-3'),
]
assert.equal(questionBackgroundText(glue, glue[4]), '跳过用量和思考')

const plan = [
  ev(1, 'agent_message', { id: 'plan', kind: 'plan', text: '实施计划' }, 'success'),
  questionTool(2, 'tool-plan'),
  questionCard(3, 'req-plan'),
]
assert.equal(questionBackgroundText(plan, plan[2]), '', '计划正文不是提问背景')
const commandApproval = ev(2, 'approval_request', { requestId: 'cmd', kind: 'command', params: { command: 'ls' } }, 'pending')
assert.equal(questionBackgroundText([
  ev(1, 'agent_message', { text: '审批前的正文' }, 'success'),
  commandApproval,
], commandApproval), '')

const described = renderToStaticMarkup(
  <QuestionForm
    kind="question"
    method="item/tool/requestUserInput"
    params={{
      questions: [{
        id: 'design',
        header: '设计确认',
        prompt: '是否确认？',
        options: [
          { label: '开始实施', description: '渲染层只保留卡片' },
          { label: '先看设计稿', description: '补充失败态说明' },
        ],
      }],
    }}
    answer={{ answers: { design: { answers: ['先看设计稿'] } } }}
    readOnly
  />,
)
assert.doesNotMatch(described, /question-options|question-opt-desc|开始实施|补充失败态说明/, '回答记录只保留最终答案，不重放选项列表和说明')
assert.match(described, /question-prompt[\s\S]*问题[\s\S]*是否确认？/)
assert.match(described, /question-readonly-answer[^>]*>先看设计稿/)

const blankDescription = renderToStaticMarkup(
  <QuestionForm
    kind="question"
    params={{ questions: [{ id: 'design', prompt: '是否确认？', options: [{ label: '只有标签', description: '   ' }] }] }}
    answer={{ answers: { design: { answers: ['只有标签'] } } }}
    readOnly
  />,
)
assert.doesNotMatch(blankDescription, /question-options/, '空白 description 不额外列出选项')
assert.match(blankDescription, /question-readonly-answer[^>]*>只有标签/)

const pendingForm = renderToStaticMarkup(
  <QuestionForm
    kind="question"
    params={{ questions: [{ id: 'design', prompt: '是否确认？', options: [{ label: '开始实施', description: '渲染层只保留卡片' }] }] }}
    onSubmit={() => {}}
  />,
)
assert.match(pendingForm, /question-opt-desc[^>]*>渲染层只保留卡片/)

const SID = 'question-context'
const user: UAEvent = { sessionId: SID, seq: 0, ts: 0, type: 'user_message', payload: { text: '改一下提问卡片' } }
const { html: stream, presentation } = await renderEventStream([
  user,
  { sessionId: SID, seq: 1, ts: 1, type: 'agent_message', state: 'success', payload: { id: 'orphan-reply', text: '孤立工具前的正文' } },
  { sessionId: SID, seq: 2, ts: 2, type: 'tool_call', state: 'success', payload: { id: 'orphan', name: 'AskUserQuestion', input: { prompt: '孤立' } } },
  { sessionId: SID, seq: 3, ts: 3, type: 'command_exec', state: 'success', payload: { command: 'echo keep' } },
  { sessionId: SID, seq: 4, ts: 4, type: 'agent_message', state: 'success', payload: { id: 'context-reply', text: '设计稿位于失败态帧' } },
  { sessionId: SID, seq: 5, ts: 5, type: 'tool_call', state: 'running', payload: { id: 'paired', name: 'AskUserQuestion', input: { prompt: '确认' } } },
  { sessionId: SID, seq: 6, ts: 6, type: 'tool_call', state: 'success', payload: { id: 'paired', name: 'AskUserQuestion', input: { prompt: '确认' } } },
  questionCard(7, 'req-live', 'pending', {
    delivery: 'async',
    params: { questions: [{ id: 'design', prompt: '是否确认？', options: [{ label: '开始实施', description: '渲染层只保留卡片' }] }] },
  }),
  { sessionId: SID, seq: 8, ts: 8, type: 'agent_message', state: 'success', payload: { id: 'blocked-reply', text: '不应进入卡片' } },
  { sessionId: SID, seq: 9, ts: 9, type: 'command_exec', state: 'success', payload: { command: 'echo block' } },
  { sessionId: SID, seq: 10, ts: 10, type: 'tool_call', state: 'success', payload: { id: 'blocked', name: 'AskUserQuestion', input: { prompt: '被命令隔开' } } },
  questionCard(11, 'req-blocked'),
  questionCard(12, 'req-answered', 'success', {
    params: {
      questions: [{
        id: 'design',
        header: '设计确认',
        prompt: '失败态设计稿是否确认？',
        options: [
          { label: '开始实施', description: '已回答时仍展示选项说明' },
          { label: '先看设计稿', description: '补充失败态说明' },
        ],
      }],
    },
    submittedAnswer: { answers: { design: { answers: ['先看设计稿'] } } },
  }),
].map(event => event.sessionId === 's' ? { ...event, sessionId: SID, ts: event.seq } : event), 'awaiting-approval', SID, {
  inspect: `(async () => {
    const panel = document.querySelector('[data-request-panel]:not([hidden])')
    const context = panel.querySelector('.question-context .agent-md')
    const prompt = panel.querySelector('.question-prompt .agent-md')
    const hint = panel.querySelector('.interaction-hint')
    const options = panel.querySelector('.question-options')
    const actions = panel.querySelector('.approval-actions')
    const typography = node => {const style=getComputedStyle(node);return {fontSize:style.fontSize,lineHeight:style.lineHeight,color:style.color}}
    const layout = {labels:panel.querySelectorAll('.question-detail-label').length,context:typography(context),prompt:typography(prompt),aligned:context.getBoundingClientRect().left===prompt.getBoundingClientRect().left && prompt.getBoundingClientRect().left===options.getBoundingClientRect().left,gap:prompt.getBoundingClientRect().top-context.getBoundingClientRect().bottom,lineHeight:parseFloat(getComputedStyle(context).lineHeight),hintAfterOptions:!!(options.compareDocumentPosition(hint)&Node.DOCUMENT_POSITION_FOLLOWING),hintBeforeActions:!!(hint.compareDocumentPosition(actions)&Node.DOCUMENT_POSITION_FOLLOWING)}
    const secondPanel = document.querySelectorAll('[data-request-panel]')[1]
    const noContext = {contexts:secondPanel.querySelectorAll('.question-context').length,hints:secondPanel.querySelectorAll('.interaction-hint').length,padding:parseFloat(getComputedStyle(secondPanel.querySelector('.approval.pending')).paddingTop)}
    for (const button of document.querySelectorAll('.steps-fold-row[aria-expanded="false"]')) button.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    for (const button of document.querySelectorAll('.process-step-meta[aria-expanded="false"]')) button.click()
    const detail = [...document.querySelectorAll('.interaction-link')].find(node => (node.textContent || '').trim() === '详情')
    detail?.click()
    await new Promise(resolve => setTimeout(resolve, 200))
    const row=document.querySelector('.interaction-step.answered')
    const summaryOpened=row.querySelector('.interaction-summary').textContent
    detail.click()
    await new Promise(resolve => setTimeout(resolve, 80))
    const summaryClosed=row.querySelector('.interaction-summary').textContent
    detail.click()
    await new Promise(resolve => setTimeout(resolve, 80))
    return {html:document.body.innerHTML,presentation:{summaryOpened,summaryClosed,icon:!!document.querySelector('.interaction-dock-head > .ui-icon-question'),tabs:[...document.querySelectorAll('.interaction-tabs button')].map(node=>node.textContent),layout,noContext}}
  })()`,
})

const contexts = [...stream.matchAll(/class="question-context"[\s\S]*?<\/div>/g)].map(match => match[0])
assert.equal(contexts.length, 1, '只有紧邻正文的那张待回答卡片带背景')
assert.match(contexts[0], /设计稿位于失败态帧/)
assert.doesNotMatch(contexts[0], /不应进入卡片/)
assert.match(stream, /不应进入卡片/, '被命令隔开的正文仍留在时间线')
assert.match(stream, /孤立工具前的正文/)
const toolNames = [...stream.matchAll(/class="step-call-name"[^>]*>([^<]*)</g)].map(match => match[1])
assert.deepEqual(toolNames.filter(name => name === 'AskUserQuestion'), ['AskUserQuestion'], '对不上卡片的提问工具仍保留，已成卡的不渲染')
assert.deepEqual(toolNames.filter(name => name === 'Bash'), ['Bash', 'Bash'])
assert.equal([...stream.matchAll(/class="process-step-meta"[^>]*>[^<]*1 工具/g)].length, 1, '可见步骤摘要只计入仍保留的提问工具')
assert.doesNotMatch(stream, /2 工具/)
assert.match(stream, /question-opt-desc[^>]*>渲染层只保留卡片/)
assert.doesNotMatch(stream, /已回答时仍展示选项说明/, '回答记录不再渲染选项说明')
assert.match(stream, /interaction-step answered[\s\S]*question-readonly-answer[^>]*>先看设计稿/)
const { layout, noContext, ...summary } = presentation
assert.deepEqual(summary, {summaryOpened:'',summaryClosed:'失败态设计稿是否确认？',icon:true,tabs:['1 · 是否确认？','2 · 设计确认']}, '摘要随展开状态切换，提问面板使用提问图标和短题目标签')
assert.equal(layout.labels, 0, '输入框上方的待回答卡片不展示问题与回答标签')
assert.deepEqual(layout.prompt, layout.context, '背景和问题使用相同字号、行距与颜色')
assert.equal(layout.aligned, true, '背景、问题正文和选项左侧对齐')
assert.ok(Math.abs(layout.gap - layout.lineHeight) <= 2, '背景和问题之间空一行')
assert.ok(layout.hintAfterOptions && layout.hintBeforeActions, '异步提示位于选项之后、提交操作之前')
assert.deepEqual(noContext, {contexts:0,hints:0,padding:10}, '没有背景的同步提问不留额外空行或异步提示')

console.log('question context card: ok')
