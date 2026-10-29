import DOMPurify from 'dompurify'
// SSR checks layout only; browser sanitization is covered by engine acceptance.
DOMPurify.sanitize = (html: string) => html
import assert from 'node:assert/strict'
import { createElement } from 'react'
import type { UAEvent } from '../src/shared/types.ts'
import { renderOpenChains } from './regression/open-chain'
import { EventStream } from '../src/renderer/components/EventStream.tsx'

const render = (events: UAEvent[], status = 'completed'): string =>
  renderOpenChains(createElement(EventStream, { events, status }), { processed: true })

const base: UAEvent[] = [
  { sessionId: 's-ms', seq: 1, ts: 1, type: 'user_message', payload: { text: '继续' } },
  { sessionId: 's-ms', seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { text: '完成', phase: 'final_answer' } },
  { sessionId: 's-ms', seq: 3, ts: 3, type: 'turn_completed', payload: {} }
]

const switchEvent = (seq: number, state: 'running' | 'success' | 'failed', patch: Record<string, any> = {}): UAEvent => ({
  sessionId: 's-ms', seq, ts: seq, type: 'model_switch', state,
  payload: {
    id: 'mswitch-1',
    fromModel: 'gpt-6.1-sol', fromLabel: 'gpt-6.1-sol', fromSource: { kind: 'native' },
    toModel: 'uniagent-model:third-party:kimi:k3-256k', toLabel: 'k3-256k', toSource: { kind: 'third-party', sourceId: 'kimi' },
    step: 'apply', compacted: false, hints: [], startedAt: 1000, ...patch
  }
})

// 进行中：压缩步骤 active、应用步骤 pending，来源与目标模型及来源名称直读。
{
  const markup = render([...base, switchEvent(4, 'running', { step: 'compact' })], 'idle')
  assert.equal((markup.match(/class="ms-card /g) || []).length, 1)
  assert.ok(markup.includes('ms-status running'))
  assert.ok(markup.includes('进行中 · 正在压缩上下文'))
  assert.ok(markup.includes('ms-step active'))
  assert.ok(markup.includes('ms-step pending'))
  assert.ok(markup.includes('gpt-6.1-sol') && markup.includes('k3-256k'))
  assert.ok(markup.includes('OpenAI 官方') && markup.includes('Kimi'), '来源名称直读')
  assert.ok(markup.includes('压缩上下文，适配目标模型容量') && markup.includes('应用新模型并恢复会话'))
}

// 切换回合混入启动信息：只渲染卡片，不出现工作过程标题与任务开始步骤。
{
  const markup = render([
    ...base,
    switchEvent(4, 'running', { step: 'compact' }),
    { sessionId: 's-ms', seq: 5, ts: 5, type: 'system_notice', payload: { kind: 'launch', text: '启动: codex app-server sandbox=read-only approval=on-request model=k3-256k', label: 'Codex app-server' } }
  ], 'idle')
  assert.equal((markup.match(/class="ms-card /g) || []).length, 1)
  assert.equal(markup.includes('工作过程'), false, '切换回合不渲染工作过程标题')
  assert.equal(markup.includes('任务开始'), false, '切换回合不渲染任务开始步骤')
  assert.equal(markup.includes('启动: codex app-server'), false, '切换附带的启动信息不单独成行')
}

// 完成（恢复的历史含 running + success 两条同 id 快照）：只渲染一张卡片的最新状态，
// 压缩行折叠进卡片，原始英文警告收进卡片底部。
{
  const hint1 = 'This session was recorded with model `gpt-6.1-sol` but is resuming with `k3-256k`. Consider switching back to `gpt-6.1-sol` as it may affect Codex performance.'
  const hint2 = 'This session was recorded with model `k3-256k` but is resuming with `gpt-6.1-sol`. Consider switching back to `k3-256k` as it may affect Codex performance.'
  const markup = render([
    ...base,
    { sessionId: 's-ms', seq: 4, ts: 4, type: 'context_compaction', state: 'running', payload: { id: 'swc-1', reason: 'provider-switch' } },
    switchEvent(5, 'running', { step: 'compact' }),
    { sessionId: 's-ms', seq: 6, ts: 6, type: 'context_compaction', state: 'success', payload: { id: 'swc-1', reason: 'provider-switch' } },
    switchEvent(7, 'running', { step: 'apply', compacted: true, hints: [hint1] }),
    switchEvent(8, 'success', { compacted: true, hints: [hint1, hint2], endedAt: 7400 })
  ])
  assert.equal((markup.match(/class="ms-card /g) || []).length, 1, '同 id 快照合并为一张卡片')
  assert.ok(markup.includes('ms-status success'))
  assert.ok(markup.includes('已完成 · 用时 6.4s'))
  assert.equal(markup.includes('data-compaction-id'), false, '切换附带的压缩行折叠进卡片')
  assert.ok(markup.includes('原始提示（2）'))
  assert.equal((markup.match(/class="ms-hint"/g) || []).length, 2)
  assert.equal((markup.match(/process-notice warning/g) || []).length, 0, '折叠后不再出现散落的警告行')
  assert.equal((markup.match(/ms-step done/g) || []).length, 2, '压缩与应用两个步骤都完成')
}

// 失败：保留原模型、给出原因，应用步骤标记失败。
{
  const markup = render([
    ...base,
    switchEvent(4, 'running', { step: 'apply' }),
    switchEvent(5, 'failed', { step: 'apply', error: 'Codex 未应用所选模型或来源。已保留原模型和来源；请检查相关模型的容量、额度与接入配置后重试。', endedAt: 4200 })
  ])
  assert.equal((markup.match(/class="ms-card /g) || []).length, 1)
  assert.ok(markup.includes('ms-status failed'))
  assert.ok(markup.includes('失败 · 已保留原模型'))
  assert.ok(markup.includes('ms-error'))
  assert.ok(markup.includes('Codex 未应用所选模型或来源'))
  assert.ok(markup.includes('ms-step failed'))
}

// 失败且切换回合混入杂散事件（未带 reason 的压缩失败、断连 error）：卡片承载这次
// 切换的一切显示，时间轴不再渲染该回合的任何异常行。
{
  const markup = render([
    ...base,
    switchEvent(4, 'running', { step: 'compact' }),
    { sessionId: 's-ms', seq: 5, ts: 5, type: 'context_compaction', state: 'failed', payload: { id: 'swc-2', error: '等待压缩完成超时，请稍后重试' } },
    { sessionId: 's-ms', seq: 6, ts: 6, type: 'error', state: 'failed', payload: { message: 'app-server 连接已断开' } },
    switchEvent(7, 'failed', { step: 'compact', error: '等待压缩完成超时，请稍后重试。已保留原模型和来源；请检查相关模型的容量、额度与接入配置后重试，或新建会话并带入任务摘要。', endedAt: 6000 })
  ])
  assert.equal((markup.match(/class="ms-card /g) || []).length, 1)
  assert.ok(markup.includes('ms-status failed'))
  assert.ok(markup.includes('失败 · 已保留原模型'))
  assert.ok(markup.includes('ms-error'), '失败原因展示在卡片内')
  assert.ok(markup.includes('等待压缩完成超时，请稍后重试。已保留原模型和来源'))
  assert.ok(markup.includes('ms-step failed'), '压缩步骤标记失败')
  assert.equal(markup.includes('工作过程'), false, '切换回合不渲染工作过程标题')
  assert.equal(markup.includes('任务开始'), false, '切换回合不渲染任务开始步骤')
  assert.equal((markup.match(/process-step process-runtime/g) || []).length, 0, '切换回合时间轴不渲染异常行')
  assert.equal(markup.includes('data-compaction-id'), false, '失败的压缩事件不单独成行')
  assert.equal(markup.includes('app-server 连接已断开'), false, '切换窗口的断连错误不再散落时间轴')
}

// 无切换卡片的历史（旧格式）：provider-switch 压缩行与普通提示保持原样渲染。
{
  const warning = 'This session was recorded with model `gpt-6.1-sol` but is resuming with `k3-256k`. Consider switching back to `gpt-6.1-sol` as it may affect Codex performance.'
  const markup = render([
    ...base,
    { sessionId: 's-ms', seq: 4, ts: 4, type: 'context_compaction', state: 'success', payload: { id: 'legacy-1', reason: 'provider-switch' } },
    { sessionId: 's-ms', seq: 5, ts: 5, type: 'system_notice', payload: { kind: 'warning', text: warning } }
  ])
  assert.ok(markup.includes('data-compaction-id="legacy-1"'), '旧格式历史保留压缩行')
  assert.ok(markup.includes('process-notice warning'), '无卡片时原始警告仍是普通提示')
  assert.equal(markup.includes('ms-card'), false)
}

// 无需压缩的切换：只显示应用步骤。
{
  const markup = render([...base, switchEvent(4, 'success', { compacted: false, endedAt: 2600 })])
  assert.equal(markup.includes('压缩上下文，适配目标模型容量'), false, '未压缩时不显示压缩步骤')
  assert.ok(markup.includes('已完成 · 用时 1.6s'))
}

console.log('model-switch-card: ok')
