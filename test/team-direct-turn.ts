import assert from 'node:assert/strict'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { AppServerRpcClient } from '../src/main/appServerTransport'
import { Orchestrator } from '../src/main/orchestrator'
const runner = new AppServerRunner('member', { n: 0 }, { id: 'codex', adapter: 'codex' } as any, { agentId: 'codex', workdir: '/tmp' })
const raw = runner as any
raw.threadId = 'thread'; raw.curTurnId = 'current'
let calls = 0, request: any, events: any[] = []
raw.transport = { request: async (method: string, params: any) => { calls++; request = { method, params }; return {} } }
runner.on('event', e => events.push(e))
await assert.rejects(runner.steerStrict('stale', undefined, undefined, 'old'), { message: 'team_stale_turn', deliveryState: 'failed' })
assert.equal(calls, 0)
raw.pendingRequests.set('native', {})
await assert.rejects(runner.steerStrict('not an answer', undefined, undefined, 'current'), { message: 'member_awaiting_response', deliveryState: 'failed' })
raw.pendingRequests.clear()
await runner.steerStrict('new scope', undefined, undefined, 'current')
assert.equal(calls, 1); assert.equal(request.method, 'turn/steer'); assert.equal(request.params.expectedTurnId, 'current')
raw.transport.request = async () => { throw new Error('timeout') }
await assert.rejects(runner.steerStrict('unknown', undefined, undefined, 'current'), /timeout/)
assert.ok(events.some(e => e.payload.text?.includes('结果未知')))
const client = new AppServerRpcClient({ bin: '', args: [], cwd: '/tmp', timeoutMs: 10 }) as any
client.child = { stdin: { write() {} } }
const rejected = client.request('turn/steer', {})
client.onMessage({ id: 1, error: { code: -1, message: 'wrong turn' } })
await assert.rejects(rejected, { deliveryState: 'failed' })
await assert.rejects(client.request('turn/steer', {}), (e: any) => e.message.includes('超时') && e.deliveryState !== 'failed')
// Team route cannot bypass a missing/nonrunning member or use an unrelated transport.
const fake = { sessions: new Map([['member', { teamBinding: { teamProjectId: 'tp' }, status: 'idle' }]]), streamers: new Map(), record() { throw new Error('must not record') } }
await assert.rejects(Orchestrator.prototype.steerTeamMessage.call(fake as any, 'member', 'scope'), { deliveryState: 'failed' })
console.log('PASS strict expected-turn fence, pending native response, RPC refusal versus unknown, and team route protection')
