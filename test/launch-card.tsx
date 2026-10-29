import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../src/renderer/components/EventStream.tsx'
import { renderOpenChains } from './regression/open-chain'
import type { UAEvent } from '../src/shared/types.ts'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const event = (
  seq: number,
  type: UAEvent['type'],
  payload: Record<string, unknown>,
  state: UAEvent['state'] = 'success',
): UAEvent => ({ sessionId: 'launch', seq, ts: seq * 1_000, type, state, payload })

const launchPayload = {
  kind: 'launch',
  text: '启动: /Users/bytedance/.local/bin/traecli app-server sandbox=danger-full-access approval=never model=GPT-5.6-Sol effort=xhigh max=off',
  label: 'TraeX app-server',
  sandbox: 'danger-full-access',
  approvalPolicy: 'never',
  model: 'GPT-5.6-Sol',
  effort: 'xhigh',
  maxMode: false,
  appendedPrompt: '只报告真实问题。',
}
const warnText = 'TRAE CLI is ignoring 1 unrecognized configuration setting. user: desktop is ignored.'

// 场景一：只有启动信息和警告、没有任何调用 —— 直接进入「任务开始」，
// 启动信息归入节点内部的调用容器，警告使用独立的时间线披露入口。
const startupOnly = renderToStaticMarkup(createElement(EventStream, {
  status: 'running',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'system_notice', launchPayload),
    event(3, 'system_notice', { kind: 'warning', text: warnText }),
    event(4, 'system_notice', { kind: 'warning', text: warnText }),
  ],
}))
assert.match(startupOnly, /process-step-calls"><div class="launch-card/, '启动信息归入任务节点的调用容器')
assert.match(startupOnly, /已启动 <span class="launch-label">TraeX app-server<\/span>/)
assert.equal((startupOnly.match(/class="process-notice warning"/g) || []).length, 2, '启动警告各自在时间线中保留披露入口')
assert.match(startupOnly, /<span class="launch-chip primary">GPT-5.6-Sol<\/span>/, '模型作为高亮 chip')
assert.match(startupOnly, /<b>effort<\/b>xhigh/)
assert.match(startupOnly, /<b>sandbox<\/b>danger-full-access/)
assert.match(startupOnly, /<b>approval<\/b>never/)
assert.match(startupOnly, /<b>max<\/b>off/)
assert.match(startupOnly, /任务开始/, '启动信息到达时即显示任务开始节点')
assert.ok(startupOnly.indexOf('任务开始') < startupOnly.indexOf('launch-card'), '启动信息位于任务开始节点下面')
assert.equal(startupOnly.match(/class="process-step active open"/g)?.length, 1, '启动信息和警告只形成一个节点')
assert.doesNotMatch(startupOnly, /执行调用/, '启动节点不显示执行调用标题')
assert.match(startupOnly, /launch-pre">\/Users\/bytedance\/.local\/bin\/traecli app-server/, '展开区保留完整启动命令且去掉「启动: 」前缀')
assert.match(startupOnly, /launch-prompt-card/, '追加的系统提示迁入卡片展开区')
assert.equal((startupOnly.match(/class="process-notice-preview"/g) || []).length, 2)
assert.doesNotMatch(startupOnly, /launch-warncnt/, '警告使用时间线披露入口，不再嵌入启动卡片')

// 场景二：启动后出现思考（无模型旁白）—— 本轮第一个无标题步骤显示「任务开始」，
// 启动卡片收在步骤内。
const withWork = renderOpenChains(createElement(EventStream, {
  status: 'running',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'system_notice', launchPayload),
    event(3, 'system_notice', { kind: 'warning', text: warnText }),
    event(4, 'reasoning', { id: 'r1', text: '先查看项目结构' }, 'running'),
  ],
}))
assert.match(withWork, /任务开始/, '首个无标题步骤兜底为「任务开始」')
assert.match(withWork, /执行调用/, '警告披露之后的工作使用独立步骤')
assert.match(withWork, /launch-card/, '启动卡片收在步骤内')
assert.ok(withWork.indexOf('任务开始') < withWork.indexOf('launch-card'), '步骤标题在启动卡片之前')

// 场景三：两个无标题步骤 —— 只有第一个叫「任务开始」，其余仍是「执行调用」。
const twoSteps = renderToStaticMarkup(createElement(EventStream, {
  status: 'running',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'command_exec', { id: 'c1', command: 'pwd' }),
    event(3, 'tool_call', { id: 'img1', name: 'image_generation' }),
    event(4, 'command_exec', { id: 'c2', command: 'ls' }),
  ],
}))
assert.match(twoSteps, /任务开始/)
assert.match(twoSteps, /执行调用/)
assert.ok(twoSteps.indexOf('任务开始') < twoSteps.indexOf('执行调用'), '「任务开始」只用于第一个无标题步骤')

// 场景四：启动后只有一条空思考（流式占位，无文本）—— 空思考不渲染内容，
// 启动信息已经形成「任务开始」，空思考不额外增加节点。
const emptyReasoning = renderToStaticMarkup(createElement(EventStream, {
  status: 'running',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'system_notice', launchPayload),
    event(3, 'system_notice', { kind: 'warning', text: warnText }),
    event(4, 'reasoning', { id: 'r1', text: '' }, 'running'),
  ],
}))
assert.match(emptyReasoning, /任务开始/, '空思考不影响启动节点显示')
assert.equal(emptyReasoning.match(/class="process-step active open"/g)?.length, 1, '空思考不额外增加步骤')
assert.match(emptyReasoning, /process-step-calls"><div class="launch-card/, '启动信息保留在任务节点中')

console.log('launch card: ok')
