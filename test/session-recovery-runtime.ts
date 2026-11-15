import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runClaudeRecoveryText } from '../src/main/recoveryDecisionRuntime'
import type { ClaudeSdkClient, ClaudeSdkLaunch } from '../src/main/claudeSdk'

const launch = { options: {} } as ClaudeSdkLaunch
for (const mode of ['success', 'tools', 'tool-use', 'approval', 'malformed', 'failure', 'cancel'] as const) {
  const signal = new AbortController()
  let closed = false
  class Client extends EventEmitter {
    ready = Promise.resolve()
    respond(_id: string, response: any) { assert.equal(response.behavior, 'deny') }
    async close() { closed = true }
    async request() {
      if (mode === 'cancel') { signal.abort(); return new Promise(() => {}) }
      if (mode === 'failure') { this.emit('failure', new Error('unavailable')); return }
      if (mode === 'approval') { this.emit('approval', { requestId: 'tool' }); return new Promise(() => {}) }
      this.emit('message', { type: 'system', subtype: 'init', tools: mode === 'tools' ? ['Bash'] : [] })
      if (mode === 'tool-use') { this.emit('message', { type: 'assistant', message: { content: [{ type: 'tool_use' }] } }); return }
      this.emit('message', { type: 'result', subtype: mode === 'malformed' ? 'error_during_execution' : 'success', result: '{"retry":false,"matchedRuleIds":[],"reason":"无需重试"}' })
    }
  }
  const operation = runClaudeRecoveryText(launch, 'judge', signal.signal, () => new Client() as unknown as ClaudeSdkClient)
  if (mode === 'success') assert.equal(JSON.parse(await operation).retry, false)
  else await assert.rejects(operation)
  assert.equal(closed, true)
}
console.log('PASS recovery judgment: no tools, valid completion, cancellation, failures and process cleanup')
