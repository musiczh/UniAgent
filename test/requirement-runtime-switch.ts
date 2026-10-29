// Run on request: node scripts/run-ts-test.mjs test/requirement-runtime-switch.ts
import assert from 'node:assert/strict'
import type { Session, SessionConfig } from '../src/shared/types'
import type { TeamProject } from '../src/shared/teamTypes'
import {
  configureRequirementRuntime,
  isRequirementsEnabled,
  requirementCaller,
  requirementInstructions,
  requirementMcpEnv,
  setRequirementsEnabled
} from '../src/main/requirementRuntime'
import { teamInstructions } from '../src/main/teamContext'

const config = { agentId: 'codex', projectId: 'p', workdir: '/w', requirementId: 'req-1' } as SessionConfig
const session = { id: 's1', config } as Session
configureRequirementRuntime((id) => (id === 's1' ? session : undefined))

try {
  assert.equal(isRequirementsEnabled(), false, 'switch starts disabled before settings load')
  assert.equal(requirementInstructions(config), '', 'default state does not inject instructions')
  assert.deepEqual(requirementMcpEnv('s1'), {}, 'default state does not issue MCP tokens')
  assert.throws(() => requirementCaller('s1', 'token'), /需求功能已停用/)

  // 开启态：指令与 MCP token 正常。
  setRequirementsEnabled(true)
  assert.match(requirementInstructions(config), /requirement_context/)
  assert.ok(requirementMcpEnv('s1').UNIAGENT_REQUIREMENT_TOKEN)
  const token = requirementMcpEnv('s1').UNIAGENT_REQUIREMENT_TOKEN
  assert.equal(requirementCaller('s1', token), session)

  setRequirementsEnabled(false)
  assert.equal(isRequirementsEnabled(), false)
  assert.equal(requirementInstructions(config), '', 'no prompt injection while disabled')
  assert.deepEqual(requirementMcpEnv('s1'), {}, 'no MCP token while disabled')
  assert.throws(() => requirementCaller('s1', token), /需求功能已停用/, 'in-flight tokens are rejected while disabled')
  assert.equal(requirementInstructions({ ...config, requirementId: undefined }), '')

  // 团队内联需求指令同样被门控。
  const project = {
    id: 'tp-1', goal: '目标', requirementId: 'req-1',
    team: { leaderMemberId: 'm1', rules: '规则', members: [{ id: 'm1', role: { name: 'Leader', instructions: '', agentId: 'codex', permissionMode: 'ask' } }] }
  } as unknown as TeamProject
  assert.ok(!teamInstructions(project, 'm1').includes('需求共享上下文'), 'team requirement section hidden while disabled')

  setRequirementsEnabled(true)
  assert.match(requirementInstructions(config), /requirement_context/, 're-enable restores instructions')
  assert.ok(requirementMcpEnv('s1').UNIAGENT_REQUIREMENT_TOKEN, 're-enable restores MCP token')
  assert.ok(teamInstructions(project, 'm1').includes('需求共享上下文'), 'team requirement section restored')

  // 无需求绑定的会话始终不受开关影响。
  assert.equal(requirementInstructions({ agentId: 'codex', workdir: '/w' }), '')
} finally {
  setRequirementsEnabled(false)
  configureRequirementRuntime(() => undefined)
}

console.log('requirement-runtime-switch: ok')
