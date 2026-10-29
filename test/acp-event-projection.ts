import assert from 'node:assert/strict'
import { ACPHistoryProjection, projectGrokUsage } from '../src/main/acp/acpEventProjection.ts'

assert.equal(projectGrokUsage({ inputTokens:100, outputTokens:20, cachedReadTokens:30 }).cachedInputTokens,30)
assert.equal(projectGrokUsage({}).inputTokens,undefined)

// Native prompt totals include all tool-loop rounds, not the live context.
assert.deepEqual(projectGrokUsage({ input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 7, reasoning_tokens: 3, total_tokens: 52 }), {
  inputTokens: 45, cachedInputTokens: 30, outputTokens: 7, cacheCreationInputTokens:5, reasoningTokens:3, totalTokens:52
})
assert.deepEqual(projectGrokUsage({ inputTokens: 45, cacheReadInputTokens: 30, cacheWriteInputTokens: 5, outputTokens: 7, totalTokens: 52 }), {
  inputTokens: 45, cachedInputTokens: 30, outputTokens: 7, cacheCreationInputTokens:5, totalTokens:52
})
assert.equal(projectGrokUsage({ inputTokens:0,outputTokens:0,cachedReadTokens:0,usageIsIncomplete:true }).usageIsIncomplete,true)
for(const value of [-1,NaN,Infinity,'12',Number.MAX_SAFE_INTEGER+1]) assert.equal(projectGrokUsage({inputTokens:value}).inputTokens,undefined)
assert.deepEqual(projectGrokUsage({inputTokens:10,outputTokens:2,cachedReadTokens:3,modelCalls:2,modelUsage:{other:{inputTokens:5,outputTokens:1,cachedReadTokens:1}}}).modelUsage,
  {other:{inputTokens:5,outputTokens:1,cachedInputTokens:1}})
const replay = new ACPHistoryProjection('deepseek')
replay.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Question' } })
replay.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'First ' } })
replay.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought' } })
replay.push({ sessionUpdate: 'tool_call', toolCallId: 'shell1', title: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'pwd' } })
replay.push({ sessionUpdate: 'tool_call_update', toolCallId: 'shell1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '/workspace' } }] })
replay.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Answer' } })
replay.push({ sessionUpdate: 'usage_update', used: 123, size: 4096 })
assert.deepEqual(replay.events.map(e => e.type), ['user_message', 'reasoning', 'command_exec', 'agent_message', 'system_notice'])
assert.equal(replay.events[1].payload.text, 'First thought')
assert.equal(replay.events[2].state, 'success')
assert.equal(replay.events[2].payload.command, 'pwd')
assert.equal(replay.events[2].payload.output, '/workspace')
assert.equal(replay.events[4].payload.usage.contextTokens, 123)
assert.equal(new Set(replay.events.map(e => e.payload.id)).size, replay.events.length)
const unknown = new ACPHistoryProjection('grok')
unknown.push({sessionUpdate:'agent_message_chunk',messageId:'private-a',content:{type:'text',text:'one'}})
unknown.push({sessionUpdate:'agent_message_chunk',_meta:{messageId:'private-b'},content:{type:'text',text:'two'}})
assert.equal(unknown.events.length,1)
assert.equal(unknown.events[0].payload.text,'onetwo')
const completion = { sessionUpdate: 'turn_completed', prompt_id: 'turn', stop_reason: 'end_turn' }
replay.push(completion)
assert.ok(!replay.events.some(event => event.type === 'turn_completed'), 'Grok completion extensions do not change DeepSeek replay')
unknown.push({ ...completion, prompt_id: '' })
assert.equal(unknown.events.length, 1, 'a completion without a prompt id is ignored')
unknown.push(completion, 12_000)
unknown.push(completion, 12_000)
assert.equal(unknown.events.length, 2, 'duplicate completion notifications remain one boundary')
assert.equal(unknown.events[1].type, 'turn_completed')
assert.equal(unknown.events[1].ts, 12_000)
const usageReplay=new ACPHistoryProjection('grok')
const used={...completion,usage:{inputTokens:100,outputTokens:20,cachedReadTokens:30}}
usageReplay.push(used);usageReplay.push(used)
assert.equal(usageReplay.events.filter(event=>event.payload.kind==='usage').length,1)
assert.equal(usageReplay.events[0].payload.usage.cachedInputTokens,30)
usageReplay.push({...completion,prompt_id:'incomplete',usage:{usageIsIncomplete:true}})
assert.equal(usageReplay.events.filter(event=>event.payload.kind==='usage').length,1)
assert.ok(usageReplay.events.some(event=>event.payload.nativeUsage?.usageIsIncomplete))
usageReplay.push({sessionUpdate:'image_dropped',notes:['Unsupported image']})
assert.ok(usageReplay.events.some(event=>event.payload.text?.includes('Unsupported image')))
for (const timestamp of [NaN, Infinity, -1, 0]) {
  const invalid = new ACPHistoryProjection('grok')
  invalid.push(completion, timestamp)
  assert.ok(Number.isFinite(invalid.events[0].ts) && invalid.events[0].ts > 0, 'invalid historical timestamps fall back to a valid local timestamp')
}
console.log('acp-event-projection: history retains tool results and usage distinguishes cache from live context')
