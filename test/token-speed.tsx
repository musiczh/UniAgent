import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { tokenSpeedForTurn } from '../src/shared/tokenSpeed.ts'
import type { UAEvent } from '../src/shared/types.ts'
import { EventStream, TurnStatusBar } from '../src/renderer/components/EventStream.tsx'
import { projectDeepSeekNativeEvent, normalizeDeepSeekHistory } from '../src/main/deepseekEventProjection.ts'
import { KimiWebRunner } from '../src/main/kimiWebRunner.ts'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'

const event = (seq: number, type: UAEvent['type'], payload: any = {}, state?: UAEvent['state']): UAEvent =>
  ({ sessionId: 'speed-session', seq, ts: 1000 + seq, type, payload, ...(state ? { state } : {}) })
const sample = (seq: number, id: string, outputTokens: any, durationMs: any, extra: any = {}): UAEvent =>
  event(seq, 'system_notice', { id, kind: 'token_speed', speed: { outputTokens, durationMs, metric: 'generation', source: 'native timing', model: 'model-a', ...extra } })
const input = event(0, 'user_message', { text: 'Run' })
for (const adapter of ['codex', 'traex']) {
  const runner: any = new AppServerRunner('speed-session', { n: 1 }, { id: adapter, adapter } as any,
    { agentId: adapter, workdir: '/tmp', permissionMode: 'read-only' }, 'main-thread')
  const events: UAEvent[] = [input]
  runner.on('event', (value: UAEvent) => events.push(value))
  const notification = { threadId: 'main-thread', id: 'request-1', ts: 3000,
    speed: { outputTokens: 100, durationMs: 2000, startedAt: 1000, metric: 'request', source: `${adapter} 原生请求计时`, model: 'model-a' } }
  runner.onNotification('uniagent/tokenSpeed', { ...notification, threadId: 'child-thread' })
  assert.equal(tokenSpeedForTurn(events, false), undefined)
  runner.onNotification('uniagent/tokenSpeed', notification)
  assert.equal(tokenSpeedForTurn(events, false)?.outputTokens, 100, `${adapter} must project native request speed`)
  assert.equal(events.at(-1)?.ts, 3000, 'batched telemetry retains the native completion time')
}
// Node verifies rendered structure; the renderer supplies the browser sanitizer.
DOMPurify.sanitize = (html: string) => html
const calls = [input, sample(1, 'one', 100, 1000),
  event(2, 'command_exec', { durationMs: 500_000 }, 'success'),
  event(3, 'approval_request', { durationMs: 90_000 }, 'success'), sample(4, 'two', 300, 6000)]
const average = tokenSpeedForTurn(calls, false)!
assert.equal(average.outputTokens, 400)
assert.equal(average.durationMs, 7000, 'tools and approvals cannot reduce the model speed')
assert.equal(average.samples, 2)
assert.equal(average.partial, false)
assert.equal(tokenSpeedForTurn(calls, true)?.outputTokens, 300, 'a running turn shows the last settled call')
assert.equal(tokenSpeedForTurn(calls, true)?.durationMs, 6000)
const corrected = tokenSpeedForTurn([...calls, sample(5, 'one', 200, 1000)], false)!
assert.equal(corrected.outputTokens, 500, 'a replay/correction replaces a call rather than double counting')
assert.equal(corrected.durationMs, 7000)
assert.equal(tokenSpeedForTurn([...calls, sample(5, 'one', 200, 1000)], true)?.outputTokens, 300,
  'replaying an earlier step cannot replace the most recent settled call')
assert.equal(tokenSpeedForTurn([...calls, event(5, 'user_message', { text: 'Next' })], true), undefined)
assert.equal(tokenSpeedForTurn([...calls, event(5, 'goal_message', { text: 'Next goal' })], true), undefined)
const delayed = [input, sample(1, 'newer', 100, 1000, { startedAt: 2000 }),
  sample(2, 'older', 50, 1000, { startedAt: 1000 })]
assert.equal(tokenSpeedForTurn(delayed, true)?.outputTokens, 100, 'late export cannot replace the latest native request')
assert.equal(tokenSpeedForTurn([event(3, 'user_message', { text: 'Next' }), sample(4, 'previous-turn', 100, 1000, { startedAt: 1000 })], false), undefined,
  'previous-turn telemetry delivered after the next user message must stay out of the new timer')
assert.equal(tokenSpeedForTurn([...calls, event(5, 'user_message', { text: 'Steer', appendedToTurn: true }),
  event(6, 'user_message', { text: '[team_event：finished]' })], false)?.outputTokens, 400)
for (const [tokens, duration] of [[undefined, 1000], ['100', 1000], [-1, 1000], [NaN, 1000], [100, 0], [100, -1], [100, Infinity], [100, NaN], [100, '1000'], [100, Number.MIN_VALUE], [0, 1000]]) {
  assert.equal(tokenSpeedForTurn([input, sample(1, 'bad', tokens, duration)], false), undefined,
    `invalid/empty sample must stay hidden: ${tokens}/${duration}`)
}
assert.equal(tokenSpeedForTurn([...calls, sample(5, 'missing', 50, undefined)], false)?.partial, true)
assert.equal(tokenSpeedForTurn([...calls, sample(5, 'interrupted', 50, 1000, { incomplete: true })], false)?.partial, true)
assert.equal(tokenSpeedForTurn([...calls, sample(5, 'other-model', 500, 1000, { model: 'model-b' })], false)?.outputTokens, 500)
assert.equal(tokenSpeedForTurn([...calls, sample(5, 'other-model', 500, 1000, { model: 'model-b' })], false)?.partial, true)
const request = tokenSpeedForTurn([...calls, sample(5, 'request', 250, 5000, { metric: 'request' })], false)!
assert.equal(request.outputTokens, 250, 'request latency cannot be pooled with stream timing')
assert.equal(request.durationMs, 5000)
assert.equal(request.partial, true)
assert.equal(tokenSpeedForTurn([input, sample(1, 'positive', 100, 1000), sample(2, 'empty', 0, 1000)], false)?.durationMs, 2000)
for (const invalid of [{ metric: 'unknown' }, { source: {} }, { model: {} }]) {
  assert.equal(tokenSpeedForTurn([input, sample(1, 'invalid', 100, 1000, invalid)], false), undefined)
}

const config: any = { agentId: 'kimi', workdir: '/tmp', permissionMode: 'ask' }
const runner: any = new KimiWebRunner('speed-session', { n: 0 }, { id: 'kimi', bin: 'unused' } as any, config)
const kimi: UAEvent[] = [input]
runner.on('event', (value: UAEvent) => kimi.push(value))
await runner.onFrame({ type: 'turn.started', payload: { turnId: 7 } })
await runner.onFrame({ type: 'turn.step.completed', payload: { turnId: 7, step: 0, agentId: 'child', usage: { output: 9999 }, llmStreamDurationMs: 1 } })
assert.equal(tokenSpeedForTurn(kimi, true), undefined, 'child model calls cannot inflate the main Agent speed')
const step = { turnId: 7, step: 0, usage: { inputOther: 10, output: 100 }, llmFirstTokenLatencyMs: 9000, llmStreamDurationMs: 2000 }
await runner.onFrame({ type: 'turn.step.completed', payload: step })
await runner.onFrame({ type: 'turn.step.completed', payload: step })
assert.equal(tokenSpeedForTurn(kimi, false)?.outputTokens, 100)
assert.equal(tokenSpeedForTurn(kimi, false)?.durationMs, 2000, 'native stream timing excludes the first-token wait')
await runner.onFrame({ type: 'turn.step.completed', payload: { turnId: 7, step: 1, usage: { inputOther: 10, output: 50 } } })
assert.equal(tokenSpeedForTurn(kimi, false)?.partial, true, 'an older CLI missing optional timing is shown as partial')

const native = (seq: number, type: string, data: any, time: number) => ({ seq, type, data, time })
const message = { id: 'reply', role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { provider: 'deepseek', model: 'flash' } }
const nativeMessage = (stream: any[], usage: any = { inputTokens: 10, outputTokens: 100 }, extra: any = {}) =>
  native(2, 'assistant/message', { turn: 1, step: 0, message, stream, usage, ...extra }, 11_000)
const packed = [{ type: 'reasoning-chunks', time0: 1000, texts: ['', 'thought'], dt: [2000] },
  { type: 'text-chunks', time0: 8000, texts: ['answer'], dt: [] }]
const deepseekEvents = projectDeepSeekNativeEvent(nativeMessage(packed))
const deepseek = tokenSpeedForTurn([input, ...deepseekEvents], false)!
assert.equal(deepseek.outputTokens, 100)
assert.equal(deepseek.durationMs, 8000, 'the first nonempty native reasoning token starts the generation window')
for (const stream of [
  [{ type: 'chunk', time: 3000, chunk: { type: 'tool-call-delta', argumentsDelta: '{' } }],
  [{ type: 'tool-call-chunks', time0: 3000, name: 'bash', args: [''], dt: [] }],
  [{ type: 'tool-call-chunks', time0: 1000, args: ['', '{'], dt: [2000] }],
  [{ type: 'chunk', time: 3000, chunk: { type: 'text-delta', text: 'x' } }],
]) assert.equal(tokenSpeedForTurn([input, ...projectDeepSeekNativeEvent(nativeMessage(stream))], false)?.durationMs, 8000)
assert.equal(tokenSpeedForTurn([input, ...projectDeepSeekNativeEvent(nativeMessage([]))], false), undefined)
for (const stream of [
  [{ type: 'text-chunks', time0: -100, texts: ['x'], dt: [] }],
  [{ type: 'text-chunks', time0: 1000, texts: ['', 'x'], dt: [-1] }],
  [{ type: 'chunk', time: 12_000, chunk: { type: 'text-delta', text: 'x' } }],
  [{ type: 'chunk', time: 3000, chunk: { type: 'text-delta', text: '' } }],
]) assert.equal(tokenSpeedForTurn([input, ...projectDeepSeekNativeEvent(nativeMessage(stream))], false), undefined)
assert.equal(tokenSpeedForTurn([input, ...projectDeepSeekNativeEvent(nativeMessage(packed, undefined, { interrupted: true }))], false)?.partial, true)
const history = normalizeDeepSeekHistory({ session: { id: 'speed-session' }, events: [
  native(0, 'user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Run' }] }, 500),
  nativeMessage(packed), nativeMessage(packed),
] })
assert.equal(tokenSpeedForTurn(history.events, false)?.outputTokens, 100, 'cold history and live settlements share the same stable call IDs')

const render = (events: UAEvent[], status: any) => renderToStaticMarkup(createElement(TurnStatusBar, { events, status }))
const running = render(calls, 'running')
assert.match(running, /turn-speed-value/)
assert.match(running, /上次/)
assert.match(running, /≈50\.0/)
assert.match(running, /token\/s/)
assert.match(running, /role="tooltip"/)
assert.match(running, /aria-describedby=/)
assert.match(running, /最近一次有效调用/)
const done = render(calls, 'idle')
assert.match(done, /均速/)
assert.match(done, /≈57\.1/, 'the finished value is weighted by actual generation time')
assert.match(done, /2 次有效调用/)
assert.doesNotMatch(render([input], 'running'), /turn-speed-value|token\/s/)
assert.doesNotMatch(render([...calls, event(5, 'user_message', { text: 'Next' })], 'running'), /turn-speed-value/)
assert.match(render([...calls, sample(5, 'missing', 50, undefined)], 'idle'), /部分统计/)
assert.match(render([input, sample(1, 'request', 100, 2000, { metric: 'request' })], 'idle'), /请求均速/)
assert.match(render([input, sample(1, 'request', 100, 2000, { metric: 'request' })], 'idle'), /包含首 token 等待/)
assert.doesNotMatch(render([input, sample(1, 'slow', 1, 100_000)], 'running'), /≈0\.0/)
const renderStream = (events: UAEvent[]) => renderToStaticMarkup(createElement(EventStream, { sessionId: 'speed-session', events, status: 'running' }))
assert.equal(renderStream([input, ...calls.slice(1).filter(item => item.payload.kind === 'token_speed')]), renderStream([input]),
  'speed metadata cannot add timeline steps, warnings or visible cards')
console.log('Token speed: native timings, weighted averages, replay, partial data, task boundaries and timer rendering passed')
