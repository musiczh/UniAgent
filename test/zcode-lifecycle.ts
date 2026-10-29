import assert from 'node:assert/strict'
import { AgentLifecycleService } from '../src/main/agentLifecycleService'
import { BUILTIN_AGENTS } from '../src/main/agents'
const base = BUILTIN_AGENTS.find(agent => agent.id === 'zcode')!
for (const [installed, incompatible, models, expected] of [
  [false, false, [], 'not-installed'],
  [true, false, [], 'needs-auth'],
  [true, false, [{ id: 'fixture', label: 'fixture' }], 'available'],
  [false, true, [], 'unhealthy']
] as const) {
  const service = new AgentLifecycleService({ detect: async () => [{ ...base, installed, incompatible, models: [...models] }], zcodeSource: async () => undefined })
  const [agent] = await service.detectAll(true)
  assert.equal(agent.lifecycle?.availability, expected)
  if (expected === 'needs-auth') assert.equal(agent.lifecycle?.auth, 'required')
}
console.log('zcode-lifecycle: not installed, installed without authorization, configured and broken states passed')
