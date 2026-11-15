import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AssistantCommands } from '../src/main/assistant/commands'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { acceptsFeishuAssistant } from '../src/shared/weixin'
import type { AgentDef } from '../src/shared/types'
import type { AssistantConversationSelection } from '../src/shared/assistantConversation'

// A dedicated App conversation must never become the Feishu resident fallback.
assert.equal(acceptsFeishuAssistant({ assistantChannel: 'app' } as any), false)
const root = await mkdtemp(join(tmpdir(), 'uniagent-assistant-app-'))
const agent = { id: 'codex', adapter: 'codex', name: 'Codex', bin: '', icon: '', builtin: true, installed: true,
  capabilities: { startupSystemPrompt: true, modelSelect: true, reasoningEffort: true, permissionModes: [{ id: 'ask', label: '询问', hint: '' }] }, models: [{ id: 'chosen', label: 'Chosen', efforts: ['low'] }] } as AgentDef
const orchestrator = new Orchestrator(() => agent, new SessionStore(join(root, 'sessions.json')))
const snapshot = { assistantId: 'personal' as const, soul: '助手', soulRevision: 1, workingRules: '', workingRulesRevision: 1 }
let defaultsRead = 0
const defaults = async (selection?: AssistantConversationSelection) => { defaultsRead++; return { agentId: agent.id, workdir: root, assistantSnapshot: snapshot,
  ...(selection ? { model: selection.model, effort: selection.effort } : {}) } }
const commands = new AssistantCommands(orchestrator, async () => snapshot, async () => {}, defaults)
try {
  const remote = orchestrator.createAssistantDraft({ ...(await defaults()), assistantChannel: 'weixin' })
  const legacy = orchestrator.createAssistantDraft(await defaults())
  const before = orchestrator.listSessions().length
  const [first, same] = await Promise.all([commands.openAppConversation(), commands.openAppConversation()])
  assert.equal(first.id, same.id, 'concurrent App opening creates one resident conversation')
  assert.equal(first.config.assistantChannel, 'app')
  assert.equal(first.nativeSessionId, undefined)
  assert.equal(orchestrator.listSessions().length, before + 1)
  assert.notEqual(first.id, remote.id)
  assert.notEqual(first.id, legacy.id, 'legacy channel-less sessions cannot be adopted as App-only')
  const reads = defaultsRead
  assert.equal((await commands.openAppConversation()).id, first.id)
  assert.equal(defaultsRead, reads, 'opening an existing App conversation keeps its configuration')
  const next = await commands.execute(first.id, 'new', 'app-new')
  assert.notEqual(next.id, first.id)
  assert.equal(next.config.assistantChannel, 'app', '/new retains App-only ownership')
  assert.equal(next.previousSessionId, first.id)
  const selected = await commands.execute(next.id, 'new', 'app-selected', { agentId: 'codex', model: 'chosen', effort: 'low' })
  assert.equal(selected.previousSessionId, next.id)
  assert.equal(selected.config.assistantChannel, 'app')
  assert.equal(selected.config.model, 'chosen')
  assert.equal(selected.config.effort, 'low')
  const afterReopen = new AssistantCommands(orchestrator, async () => snapshot, async () => {}, defaults)
  assert.equal((await afterReopen.openAppConversation()).id, selected.id, 'current conversation survives controller recreation')
  const saved = new SessionStore(join(root, 'sessions.json')).load()
  assert.equal(saved.find(row => row.id === next.id)?.config.assistantChannel, 'app', 'App ownership is durable')
  assert.equal(saved.find(row => row.id === selected.id)?.config.model, 'chosen', 'one-off parameters survive persisted history')
  assert.equal(saved.find(row => row.id === remote.id)?.config.assistantChannel, 'weixin')
  assert.equal(saved.find(row => row.id === legacy.id)?.assistantEndReason, undefined)
  await orchestrator.setArchived(first.id, true)
  const archivedHistory = new SessionStore(join(root, 'sessions.json')).load().find(row => row.id === first.id)
  assert.equal(archivedHistory?.archived, true, 'archiving old assistant history is durable')
  assert.equal(archivedHistory?.assistantEndReason, 'new', 'archive preserves the original /new boundary')
  assert.equal(archivedHistory?.config.assistantChannel, 'app', 'archive preserves channel ownership')
  await orchestrator.setArchived(first.id, false)
  assert.equal(new SessionStore(join(root, 'sessions.json')).load().find(row => row.id === first.id)?.archived, false, 'unarchive is durable')
  assert.equal((await afterReopen.openAppConversation()).id, selected.id, 'restoring old history does not replace the resident conversation')
  await orchestrator.setArchived(selected.id, true)
  const replacement = await commands.openAppConversation()
  assert.notEqual(replacement.id, selected.id, 'archived conversations do not become the active App Tab')
  console.log('PASS dedicated App assistant: channel isolation, concurrent opening, reuse, /new, durable history archive/unarchive and resident ownership')
} finally {
  orchestrator.disposeAll(); await orchestrator.closeSessionLogs(); await rm(root, { recursive: true, force: true })
}
