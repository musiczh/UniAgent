import assert from 'node:assert/strict'
import React from 'react'
import DOMPurify from 'dompurify'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import type { UAEvent } from '../src/shared/types.ts'
import {
  ApprovalCard,
  QuestionForm,
  approvalAnswerLabel,
  approvalEventIdentity,
  isCancelledApprovalAnswer,
  isExpandableQuestionAnswer,
  mergeOptimisticApprovalAnswers,
  readonlyQuestionAnswer,
} from '../src/renderer/components/EventStream.tsx'
import {
  isMcpToolApproval,
  mcpToolApprovalAnswer,
  mcpToolApprovalScopes,
} from '../src/shared/questions.ts'

// This SSR suite checks answer redaction; browser sanitizer coverage is separate.
Object.assign(DOMPurify, { sanitize: (html: string) => html })

const request = (
  seq: number,
  requestId: string,
  submittedAnswer?: unknown,
): UAEvent => ({
  sessionId: 'session',
  seq,
  ts: seq,
  type: 'approval_request',
  state: 'pending',
  payload: {
    requestId,
    kind: 'question',
    params: { questions: [{ id: 'token', prompt: 'Token?', isSecret: true }] },
    ...(submittedAnswer === undefined ? {} : { submittedAnswer }),
  },
})

const secret = 'plain-text-secret'
assert.equal(readonlyQuestionAnswer({ secret: true }, [secret]), '已填写')
assert.ok(!readonlyQuestionAnswer({ secret: true }, [secret]).includes(secret))
assert.equal(readonlyQuestionAnswer({ secret: false }, ['visible']), 'visible')
const secretMarkup = renderToStaticMarkup(
  React.createElement(QuestionForm, {
    kind: 'question',
    params: { questions: [{ id: 'token', prompt: 'Token?', isSecret: true }] },
    answer: { answers: { token: { answers: [secret] } } },
    readOnly: true,
  }),
)
assert.match(secretMarkup, /已填写/)
assert.ok(!secretMarkup.includes(secret), 'read-only markup must never contain plaintext secrets')

const cancelled = { action: 'cancel' }
assert.equal(isCancelledApprovalAnswer(cancelled), true)
assert.equal(approvalAnswerLabel('elicitation', cancelled), '取消')
assert.equal(isExpandableQuestionAnswer('elicitation', cancelled), false)
assert.equal(isCancelledApprovalAnswer({ answers: {} }), false)
assert.equal(approvalAnswerLabel('question', { answers: {} }), '回答')
assert.equal(isExpandableQuestionAnswer('question', { answers: {} }), true)
const cancelledMarkup = renderToStaticMarkup(
  React.createElement(ApprovalCard, {
    ev: {
      ...request(9, 'cancelled', cancelled),
      state: 'cancelled',
      payload: {
        ...request(9, 'cancelled', cancelled).payload,
        kind: 'elicitation',
      },
    },
  }),
)
assert.match(cancelledMarkup, /已取消/)
assert.ok(!cancelledMarkup.includes('expandable'))
assert.ok(cancelledMarkup.includes('interaction-compact') && cancelledMarkup.includes('详情'))
assert.ok(!cancelledMarkup.includes('去回答') && !cancelledMarkup.includes('<textarea'), 'cancelled question history only offers read-only details')

const first = request(10, 'reused')
const second = request(11, 'reused')
assert.notEqual(approvalEventIdentity(first), approvalEventIdentity(second))

const optimistic = { answers: { token: { answers: [secret] } } }
const submitted = {
  [approvalEventIdentity(first)]: { answer: optimistic, payload: first.payload },
}
const rendered = mergeOptimisticApprovalAnswers([first, second], submitted)
assert.deepEqual(rendered[0].payload.submittedAnswer, optimistic)
assert.equal(rendered[0].state, 'success', 'an accepted local answer updates the original node immediately')
assert.equal(rendered[1].state, 'pending', 'a later event reusing the request id remains pending')
assert.equal(
  rendered[1].payload.submittedAnswer,
  undefined,
  'a new event reusing requestId must not inherit the previous event answer',
)

const authoritative = { answers: { token: { answers: ['server-answer'] } } }
const reconciled = mergeOptimisticApprovalAnswers(
  [request(10, 'reused', authoritative)],
  submitted,
)
assert.deepEqual(
  reconciled[0].payload.submittedAnswer,
  authoritative,
  'an externally supplied answer is authoritative over the optimistic answer',
)
const externallyAnsweredMarkup = renderToStaticMarkup(
  React.createElement(ApprovalCard, {
    ev: request(10, 'reused', authoritative),
  }),
)
assert.match(
  externallyAnsweredMarkup,
  /已回答/,
  'the same mounted event identity renders externally supplied completion state',
)

const mcpApprovalParams = {
  serverName: 'capcode-mcp',
  message: 'Allow the capcode-mcp MCP server to run tool "knowledge_search"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    persist: ['session', 'always'],
    tool_description: '检索 Codin 知识库',
    tool_params: { query: 'CapCut Q4' },
  },
}
assert.equal(isMcpToolApproval(mcpApprovalParams), true)
assert.deepEqual(mcpToolApprovalScopes(mcpApprovalParams), ['session', 'always'])
assert.deepEqual(mcpToolApprovalAnswer('accept', 'session'), {
  action: 'accept', content: null, _meta: { persist: 'session' },
})
const mcpApprovalMarkup = renderToStaticMarkup(
  React.createElement(ApprovalCard, {
    ev: {
      ...request(11, 'mcp-tool'),
      payload: {
        requestId: 'mcp-tool',
        method: 'mcpServer/elicitation/request',
        kind: 'elicitation',
        params: mcpApprovalParams,
      },
    },
    onRespond: () => {},
  }),
)
assert.match(mcpApprovalMarkup, /MCP 工具授权/)
assert.match(mcpApprovalMarkup, /允许 capcode-mcp 运行 knowledge_search/)
assert.match(mcpApprovalMarkup, /检索 Codin 知识库/)
assert.match(mcpApprovalMarkup, /CapCut Q4/)
assert.match(mcpApprovalMarkup, /允许一次/)
assert.match(mcpApprovalMarkup, /本会话允许/)
assert.match(mcpApprovalMarkup, /始终允许/)
assert.ok(!mcpApprovalMarkup.includes('提交回答'))

const serverEvents: UAEvent[] = []
const writes: unknown[] = []
const runner = new AppServerRunner(
  'full-access-question',
  { n: 0 },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    adapter: 'codex',
    icon: '',
    builtin: true,
    capabilities: {
      modelSelect: true,
      reasoningEffort: true,
      permissionModes: [],
      streaming: true,
    },
    models: [],
  },
  {
    agentId: 'codex',
    workdir: process.cwd(),
    permissionMode: 'full-access',
    model: 'gpt-5',
  },
)
runner.on('event', (event: UAEvent) => serverEvents.push(event))
;(runner as any).write = (message: unknown) => writes.push(message)
;(runner as any).onServerRequest({
  jsonrpc: '2.0',
  id: 42,
  method: 'item/tool/requestUserInput',
  params: { questions: [{ id: 'choice', question: 'Choose?' }] },
})
const pendingQuestion = serverEvents.find(
  (event) => event.type === 'approval_request' && event.state === 'pending',
)
assert.ok(pendingQuestion, 'full-access must still surface requestUserInput')
assert.equal(pendingQuestion.payload.requestId, 'req_42')
assert.equal(pendingQuestion.payload.kind, 'question')
assert.equal(writes.length, 0, 'full-access must not auto-answer information requests')

;(runner as any).onServerRequest({
  jsonrpc: '2.0',
  id: 43,
  method: 'mcpServer/elicitation/request',
  params: mcpApprovalParams,
})
assert.deepEqual(writes.at(-1), {
  jsonrpc: '2.0',
  id: 43,
  result: { action: 'accept', content: null, _meta: null },
})
assert.equal(
  serverEvents.some((event) => event.payload?.requestId === 'req_43'),
  false,
  'full-access auto-approves MCP tool consent instead of showing an empty question form',
)

// TraeX uses the elicitation transport for MCP permissions with an empty form.
// Treating this as a question leaves the real UI's submit button disabled forever.
const mcpApproval = {
  jsonrpc: '2.0', id: 43, method: 'mcpServer/elicitation/request',
  params: { serverName: 'uniagent', mode: 'form', message: 'Allow get_team_context?',
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
    requestedSchema: { type: 'object', properties: {} } },
}
;(runner as any).config.permissionMode = 'read-only'
;(runner as any).onServerRequest(mcpApproval)
const permission = serverEvents.at(-1)!
assert.equal(permission.payload.kind, 'mcpTool', 'MCP permission must use the actionable approval card')
const permissionMarkup = renderToStaticMarkup(React.createElement(ApprovalCard, { ev: permission, onRespond() {} }))
assert.match(permissionMarkup, /MCP 工具授权/)
assert.match(permissionMarkup, /允许一次/)
assert.ok(!permissionMarkup.includes('提交回答'), 'empty MCP permission schema is not a question form')

const replies: unknown[] = []
const transport = { respond: (id: number, answer: unknown) => replies.push({ id, answer }) }
;(runner as any).transport = transport
;(runner as any).connectionGeneration = 1
for (const expected of [
  mcpToolApprovalAnswer('accept'),
  mcpToolApprovalAnswer('accept', 'session'),
  mcpToolApprovalAnswer('decline'),
]) {
  ;(runner as any).onServerRequest(mcpApproval, 1, transport)
  assert.equal(runner.respond('req_1_43', expected).handled, true)
  assert.deepEqual(replies.at(-1), { id: 43, answer: expected }, 'use elicitation wire vocabulary')
}
;(runner as any).config.permissionMode = 'full-access'
;(runner as any).onServerRequest(mcpApproval, 1, transport)
assert.deepEqual(replies.at(-1), { id: 43, answer: mcpToolApprovalAnswer('accept') })
;(runner as any).onServerRequest({ ...mcpApproval, id: 44, params: { requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } }, 1, transport)
assert.equal(serverEvents.at(-1)!.payload.kind, 'elicitation', 'ordinary information requests stay interactive')

console.log('question state/security: ok')
