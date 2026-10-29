// 提问 / 审批卡片必须脱离「调用链路」——用户在等待作答时最关注这张卡片，
// 而链路在运行中默认折叠（autoOpenId = null），卡片一旦进链路就等于被藏起来。
// 这些断言直接渲染真实的 EventStream，检查默认（未展开任何折叠）时的 DOM。
import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
import type { UAEvent } from '../src/shared/types.ts'

const SID = 'pending-approval'

const user: UAEvent = {
  sessionId: SID, seq: 0, ts: 1_000, type: 'user_message',
  payload: { text: '改一下「项目总结」页的折叠行为' },
}

const command: UAEvent = {
  sessionId: SID, seq: 1, ts: 1_001, type: 'command_exec', state: 'success',
  payload: { id: 'cmd', command: 'rg fold', output: 'ok', exitCode: 0 },
}

const question = (
  seq: number,
  state: UAEvent['state'] = 'pending',
  submittedAnswer?: unknown,
): UAEvent => ({
  sessionId: SID, seq, ts: 1_000 + seq, type: 'approval_request', state,
  payload: {
    requestId: `req-${seq}`,
    method: 'item/tool/requestUserInput',
    kind: 'question',
    params: {
      questions: [{
        id: 'fold',
        header: '折叠行为',
        prompt: '要保留折叠吗？',
        options: [{ label: '全部展开' }, { label: '保留可折叠' }],
      }],
    },
    ...(submittedAnswer === undefined ? {} : { submittedAnswer }),
  },
})

const commandApproval = (seq: number): UAEvent => ({
  sessionId: SID, seq, ts: 1_000 + seq, type: 'approval_request', state: 'pending',
  payload: {
    requestId: `req-cmd-${seq}`,
    method: 'execCommandApproval',
    kind: 'command',
    params: { command: 'rm -rf /tmp/x', cwd: '/repo' },
  },
})

const render = (events: UAEvent[], status = 'awaiting-approval'): Promise<string> =>
  renderEventStream([user, ...events], status, SID)

// 1) 提问是链路里唯一内容时：链路行整行消失，卡片默认可见、无需点开。
const onlyQuestion = await render([question(1)])
assert.match(onlyQuestion, /智能体提问/, 'pending 提问卡片必须默认渲染出来')
assert.match(onlyQuestion, /待回答/, 'pending 提问卡片必须标明待回答状态')
assert.match(onlyQuestion, /要保留折叠吗？/, '问题正文必须在默认状态下可见（无需展开任何折叠）')
assert.doesNotMatch(onlyQuestion, /调用链路/, '卡片移出后链路已空，不应再显示一个空的「调用链路」行')
assert.doesNotMatch(onlyQuestion, /chain-body/, '提问卡片不得再嵌在链路 body 内')

// 2) 链路里还有思考 / 命令时：链路行保留且仍然默认折叠，卡片依旧在最外层可见。
const withChain = await render([command, question(2)])
assert.match(withChain, /process-step/, '提问旁的工作步骤必须保留')
assert.doesNotMatch(withChain, /chain-body/, '链路不得因为提问而自动展开')
assert.match(withChain, /要保留折叠吗？/, '链路折叠状态下提问卡片仍必须可见')

// 3) 审批类（命令执行）与提问同等处理。
const approval = await render([commandApproval(1)])
assert.match(approval, /命令执行审批/)
assert.match(approval, /待处理 1/, 'pending 审批卡片必须标明待处理请求数')
assert.match(approval, /rm -rf \/tmp\/x/, '审批详情必须默认可见')
assert.doesNotMatch(approval, /chain-body/)

// 4) 作答后就地变为已答紧凑态，不跳回链路内部。
const answered = await render(
  [question(1, 'success', { answers: { fold: { answers: ['保留可折叠'] } } })],
  'running',
)
assert.match(answered, /已回答/)
assert.doesNotMatch(answered, /chain-body/, '已答卡片必须留在原位，不得被移回链路')

// 5) 已完成轮次的历史回放保持现状：卡片仍在「已处理」折叠块内（默认不展开）。
const done = await render([
  question(1, 'success', { answers: { fold: { answers: ['保留可折叠'] } } }),
  { sessionId: SID, seq: 2, ts: 1_002, type: 'agent_message', state: 'success',
    payload: { id: 'final', phase: 'final_answer', text: '已按「保留可折叠」调整。' } },
  { sessionId: SID, seq: 3, ts: 1_003, type: 'turn_completed', state: 'success', payload: {} },
], 'idle')
assert.match(done, /已处理/, '完成的轮次仍折叠为「已处理」')
assert.doesNotMatch(done, /智能体提问/, '历史回放里的提问卡片仍留在「已处理」折叠块内')

console.log('pending approval stays outside the call chain: ok')

const lateQuestion = await render([
  { sessionId: SID, seq: 1, ts: 1001, type: 'agent_message', state: 'success', payload: { id: 'reply', text: 'Waiting for your scope.' } },
  { sessionId: SID, seq: 2, ts: 1002, type: 'turn_completed', state: 'success', payload: {} },
  question(3, 'success', { answers: { fold: { answers: ['保留可折叠'] } } })
], 'idle')
assert.match(lateQuestion, /已回答/, 'a request arriving after the final reply must remain available in session history')
