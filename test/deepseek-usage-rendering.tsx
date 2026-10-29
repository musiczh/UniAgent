import assert from 'node:assert/strict'
import { projectDeepSeekNativeEvent, type DeepSeekProjectionContext } from '../src/main/deepseekEventProjection'
import { appendEventSnapshot } from '../src/shared/eventSnapshots'
import { computeContext, mergeSessionEvent } from '../src/renderer/App'
import type { UAEvent } from '../src/shared/types'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Fifteen model settlements from the reported multi-tool turn, not fifteen turns.
const inputs = [14924,34366,57090,83643,112595,145326,179589,217008,257611,299218,342945,397494,454665,514327,575613]
const outputs = [229,578,940,1394,1848,2412,2628,3213,3839,4268,4493,4691,5499,6783,9260]
const cached = [10368,25472,45184,68224,95104,124416,157696,192128,230016,271232,313216,357120,411776,469632,530560]
const context: DeepSeekProjectionContext = { sessionId: 'usage-session' }
const raw: UAEvent[] = []
let nativeSeq = 0
function native(type: string, data: Record<string, unknown>) {
  for (const event of projectDeepSeekNativeEvent({ type, data, seq: nativeSeq++, time: 1000 + nativeSeq }, context)) {
    raw.push({ ...event, seq: raw.length })
  }
}
function start(turn: number) {
  native('user/message', { turn, id: `user-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize project' }] })
  native('turn/start', { turn })
}
start(1)
inputs.forEach((input, step) => {
  const cacheReadTokens = cached[step] - (cached[step - 1] || 0)
  native('assistant/message', { turn: 1, step, message: { id: `reply-${step}`, content: [{ type: 'text', text: `Step ${step}` }], source: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    usage: { inputTokens: input - (inputs[step - 1] || 0) - cacheReadTokens, outputTokens: outputs[step] - (outputs[step - 1] || 0), cacheReadTokens } })
  raw.push({ sessionId: 'usage-session', seq: raw.length, ts: 1000 + nativeSeq, type: 'tool_call', state: 'success', payload: { id: `tool-${step}`, name: 'read', output: 'file contents', turnId: '1' } })
})
native('turn/end', { turn: 1, reason: { kind: 'completed' } })
const firstTurn = [...raw]
const usageEvents = (events: UAEvent[]) => events.filter(e => e.type === 'system_notice' && e.payload.kind === 'usage')
const cards = (events: UAEvent[]) => renderEventStream(events, 'completed', 'usage-session', {
  inspect: "document.querySelectorAll('.card.system-notice.usage').length"
})

assert.equal(await cards(firstTurn), 1, 'saved duplicate snapshots must render ONE usage card, not fifteen')
const live = firstTurn.reduce<UAEvent[]>((events, event) => mergeSessionEvent(events, event), [])
const inPlace: UAEvent[] = []
firstTurn.forEach(event => assert.equal(mergeSessionEvent(inPlace, event, true), inPlace))
assert.deepEqual(inPlace, live, 'batched in-place streaming must match immutable updates')
assert.equal(usageEvents(firstTurn).length, 15, 'immutable updates leave source snapshots intact')
const buffered: UAEvent[] = []
firstTurn.forEach(event => appendEventSnapshot(buffered, event))
assert.equal(usageEvents(live).length, 1, 'renderer live updates replace cumulative usage')
assert.equal(usageEvents(buffered).length, 1, 'main-process buffer replaces cumulative usage')
assert.equal(usageEvents(live)[0].payload.usage.inputTokens, 575613)
assert.equal(usageEvents(live)[0].payload.usage.contextTokens, 61286, 'context occupancy remains the last request, not total billed input')
const finalUsage = usageEvents(live)[0]
assert.equal(computeContext([finalUsage, { ...finalUsage, seq: finalUsage.seq - 1,
  payload: { kind: 'usage', id: 'compaction', usage: { inputTokens: 90000, outputTokens: 100 } } }]).used, 61286,
  'a replaced usage snapshot is newer than a compaction footer later in the display array')

// Break caught: Grok's usage footer sums every model call (2.4M billed tokens
// for a 256k window); using it as occupancy pinned the meter at 100%.
const grokCumulative: UAEvent = {
  sessionId: 'usage-session', seq: finalUsage.seq + 1, ts: finalUsage.ts + 1, type: 'system_notice',
  payload: { kind: 'usage', id: 'grok-cumulative', usage: { inputTokens: 2369802, outputTokens: 36495, cachedInputTokens: 2241280, totalTokens: 2406297 } }
}
assert.equal(computeContext([finalUsage, grokCumulative]).used, 0,
  'cumulative billed tokens are never treated as context occupancy')
const grokContext: UAEvent = {
  ...grokCumulative, seq: grokCumulative.seq + 1,
  payload: { kind: 'context', id: 'grok-context', usage: { contextTokens: 127539, contextWindow: 256000 } }
}
assert.deepEqual(computeContext([finalUsage, grokCumulative, grokContext]), { used: 127539, window: 256000, detail: {} },
  'Grok persisted context overrides the cumulative usage footer')
assert.deepEqual(computeContext([finalUsage, grokContext, { ...grokCumulative, seq: grokContext.seq + 1 }]),
  { used: 127539, window: 256000, detail: {} },
  'a later cumulative footer without a bounded figure cannot hide the context tick')

start(2)
native('assistant/message', { turn: 2, step: 0, message: { id: 'second', content: [{ type: 'text', text: 'Second turn' }], source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 5 } })
native('turn/end', { turn: 2, reason: { kind: 'aborted' } })
const tables = await renderEventStream(JSON.parse(JSON.stringify(raw)), 'completed', 'usage-session', {
  inspect: `(async () => {
    document.querySelectorAll('.usage-line').forEach(line => line.click());
    await new Promise(resolve => setTimeout(resolve, 50));
    return [...document.querySelectorAll('.usage-table')].map(table => [...table.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent)));
  })()`
})
// Off-peak Flash: 0.15 miss / 0.003 hit / 0.6 output USD per 1M tokens.
// Turn 1 = 45,053 miss + 530,560 hit + 9,260 output = $0.01390563.
// Turn 2 = 7 miss + 3 hit + 5 output = $0.000004059; the session cumulative
// keeps the priced turn and adds the second one.
assert.deepEqual(tables, [
  [['575,613','9,260','530,560','$0.0139'], ['575,613','9,260','530,560','$0.0139']],
  [['10','5','3','<$0.0001'], ['575,623','9,265','530,563','$0.0139']]
], 'expanded session totals count each turn once, including restored old transcripts')

const unknownHistory: UAEvent[] = [{
  sessionId: 'usage-session', seq: 0, ts: 1, type: 'system_notice',
  payload: { kind: 'usage', usage: { inputTokens: 10, outputTokens: 5, cost: 0.5, sessionInputTokens: 20, sessionOutputTokens: 10, sessionCost: null } }
}]
const unknownTable = await renderEventStream(unknownHistory, 'completed', 'usage-session', {
  inspect: `(async () => {
    document.querySelector('.usage-line').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    return [...document.querySelectorAll('.usage-table tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
  })()`
})
assert.deepEqual(unknownTable.map((row: string[]) => row[3]), ['$0.5000', '—'],
  'an explicitly unknown session total must not fall back to a partial sum')
const partialHistory: UAEvent[] = [
  { sessionId: 'usage-session', seq: 0, ts: 1, type: 'user_message', payload: { text: 'first' } },
  { sessionId: 'usage-session', seq: 1, ts: 2, type: 'system_notice', payload: { kind: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } },
  { sessionId: 'usage-session', seq: 2, ts: 3, type: 'user_message', payload: { text: 'second' } },
  { sessionId: 'usage-session', seq: 3, ts: 4, type: 'system_notice', payload: { kind: 'usage', usage: { inputTokens: 10, outputTokens: 5, cost: 0.5 } } }
]
const partialTables = await renderEventStream(partialHistory, 'completed', 'usage-session', {
  inspect: `(async () => {
    document.querySelectorAll('.usage-line').forEach(line => line.click());
    await new Promise(resolve => setTimeout(resolve, 50));
    return [...document.querySelectorAll('.usage-table')].map(table => table.querySelectorAll('tbody tr')[1].lastElementChild.textContent);
  })()`
})
assert.deepEqual(partialTables, ['—', '—'], 'unpriced history must not become a partial session total')
console.log('deepseek-usage-rendering: live, buffered, saved, multi-step, interrupted turn and expanded DOM totals passed')
