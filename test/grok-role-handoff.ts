import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, AgentRole } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-grok-role-handoff-'))
process.env.UNIAGENT_USER_DATA = join(root, 'user-data')

const [{ buildAgentRoleCatalog, resolveAgentRoleInvocation }, handoff] = await Promise.all([
  import('../src/main/agentRoles.ts'),
  import('../src/main/handoff.ts')
])

const grok: AgentDef = {
  id: 'grok',
  name: 'Grok',
  bin: '/usr/bin/true',
  adapter: 'grok',
  icon: '',
  builtin: true,
  installed: true,
  lifecycle: {
    availability: 'available',
    auth: 'authenticated',
    health: 'healthy',
    updateStatus: 'current',
    checkedAt: 1
  },
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    permissionModes: [
      { id: 'read-only', label: '只读', hint: '' },
      { id: 'ask', label: '请求批准', hint: '' },
      { id: 'approve-for-me', label: '自动批准', hint: '' },
      { id: 'full-access', label: '完全访问', hint: '' }
    ],
    streaming: true
  },
  models: [
    {
      id: 'grok-4.6',
      label: 'Grok 4.6',
      efforts: ['xhigh', 'high', 'medium', 'low'],
      defaultEffort: 'high'
    }
  ],
  defaultModel: 'grok-4.6'
}

const baseRole: AgentRole = {
  id: 'grok-reviewer',
  name: 'Grok Reviewer',
  agentId: 'grok',
  model: 'grok-4.6',
  effort: 'high',
  permissionMode: 'read-only'
}

try {
  const workdir = join(root, 'project')
  await mkdir(workdir)

  const catalog = buildAgentRoleCatalog([
    baseRole,
    { ...baseRole, id: 'grok-instructions', instructions: '只报告真实问题。' },
    { ...baseRole, id: 'grok-skills', skills: ['review'] },
    {
      ...baseRole,
      id: 'grok-tools',
      toolPolicy: { mode: 'deny-only', tools: ['shell'] }
    }
  ], [grok])
  const status = new Map(catalog.map((entry) => [entry.role.id, entry]))
  assert.equal(status.get('grok-reviewer')?.executable, true)
  assert.equal(status.get('grok-instructions')?.executable, true)
  assert.equal(status.get('grok-skills')?.unavailableReason, 'role_skills_unsupported')
  assert.equal(status.get('grok-tools')?.executable, true)

  const invocation = resolveAgentRoleInvocation({
    roleId: baseRole.id,
    roles: [baseRole],
    agents: [grok],
    callerWorkdir: workdir
  })
  assert.equal(invocation.agent.id, 'grok')
  assert.deepEqual(invocation.config, {
    agentId: 'grok',
    model: 'grok-4.6',
    effort: 'high',
    permissionMode: 'read-only',
    workdir,
    roleSnapshot: baseRole
  })

  handoff.ensureHandoffServer()
  const selfTest = await handoff.handoffSelfTest()
  assert.equal(selfTest.ok, true, selfTest.error)
  assert.ok(selfTest.injectedFor.includes('grok'), 'Grok ACP sessions receive the UniAgent handoff MCP server')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('grok-role-handoff: ok')
