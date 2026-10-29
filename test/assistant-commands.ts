import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AssistantCommands } from '../src/main/assistant/commands'
import type { Orchestrator } from '../src/main/orchestrator'
import type { Session, SessionConfig } from '../src/shared/types'

const snapshot = { assistantId: 'personal' as const, soul: '', soulRevision: 1, workingRules: '', workingRulesRevision: 1 }
const previousConfig: SessionConfig = {
  agentId: 'codex', model: 'previous-model', permissionMode: 'full-access', workdir: '/previous', projectId: 'previous-project',
  effort: 'high', collaborationMode: 'plan', fastMode: true, maxMode: true, modelSource: { kind: 'native' },
  requirementId: 'previous-requirement', additionalDirectories: ['/previous-extra']
}
const session: Pick<Session, 'id' | 'config' | 'status'> = { id: 's_a', config: {
  ...previousConfig,
  useAssistant: true, initializationJobId: 'previous-job', initializationTargetAgentId: 'claude',
  workspaceSelection: { mode: 'worktree', requestId: 'previous-request', baseRef: 'master' }, assistantSnapshot: snapshot
}, status: 'idle' }
let created = 0, defaultsRead = 0, invalidated = 0
let defaults: SessionConfig = {
  agentId: 'claude', model: 'default-model', permissionMode: 'ask', workdir: '/default', projectId: 'default-project', assistantSnapshot: { ...snapshot, soulRevision: 2 }
}
const currentSnapshot = { ...snapshot, soulRevision: 3 }
const defaultConfig = async () => { defaultsRead++; return defaults }
const drafts: Array<{ previousId?: string; command?: string }> = []
const fake = Object.assign(new EventEmitter(), {
  assistantCommandSessions: new Set<string>(), getSessionById: () => session, getQueue: () => [],
  lockAssistantCommand(id: string) { this.assistantCommandSessions.add(id) }, interrupt() {},
  createAssistantDraft(config: SessionConfig, previousId?: string, command?: string) { created++; drafts.push({ previousId, command }); return { id: 's_b', config, status: 'draft' } }
})
const commands = new AssistantCommands(fake as unknown as Orchestrator, async () => currentSnapshot, async () => { invalidated++ }, defaultConfig)
const [a,b] = await Promise.all([commands.execute('s_a','new','r1'), commands.execute('s_a','new','r1')])
assert.equal(a.id,b.id)
assert.equal(created,1)
assert.equal(a.nativeSessionId,undefined)
assert.deepEqual(a.config, defaults, '/new must use assistant defaults without inheriting any previous runtime options or workspace bindings')
assert.equal(defaultsRead, 1, 'duplicate requests resolve defaults and create the draft only once')
assert.equal(invalidated, 1)
assert.equal(fake.assistantCommandSessions.size, 0)

defaults = { ...defaults, model: 'updated-default-model', workdir: '/updated-default', projectId: 'updated-default-project' }
session.config.assistantChannel = 'weixin'
const weixin = await commands.execute('s_a','new','r2')
assert.deepEqual(weixin.config, { ...defaults, assistantChannel: 'weixin' }, '/new reads current defaults and retains only channel ownership')
assert.equal(defaultsRead, 2)
assert.equal(defaults.assistantChannel, undefined, 'channel ownership must not mutate the shared default config')

const cleared = await commands.execute('s_a','clear','r3')
assert.deepEqual(cleared.config, { ...previousConfig, assistantSnapshot: currentSnapshot, assistantChannel: 'weixin' }, '/clear retains runtime configuration, refreshes the identity snapshot and strips creation-only fields')
assert.equal(defaultsRead, 2, '/clear does not resolve assistant defaults')
assert.deepEqual(drafts, [
  { previousId: 's_a', command: 'new' }, { previousId: 's_a', command: 'new' }, { previousId: 's_a', command: 'clear' }
], 'draft creation retains the previous session link and command semantics')

const blocked = new AssistantCommands(fake as unknown as Orchestrator, async () => { throw new Error('assistant_disabled') }, async () => {}, defaultConfig)
await assert.rejects(blocked.execute('s_a','clear','r2'), /assistant_disabled/)
const beforeFailure = created, beforeInvalidation = invalidated
const unavailable = new AssistantCommands(fake as unknown as Orchestrator, async () => snapshot, async () => { invalidated++ }, async () => { throw new Error('default_agent_unavailable') })
await assert.rejects(unavailable.execute('s_a','new','r4'), /default_agent_unavailable/)
assert.equal(created, beforeFailure, 'invalid defaults cannot create a replacement session')
assert.equal(invalidated, beforeInvalidation, 'failed configuration resolution must not invalidate the current conversation')
assert.equal(fake.assistantCommandSessions.size, 0, 'failed commands release the session lock')
console.log('assistant commands: defaults, channel ownership, clear, idempotency and failure handling passed')
