import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import type { AgentDef } from '../src/shared/types'
import { appendWeixinContext } from '../src/shared/weixin'
import { appendFeishuContext } from '../src/shared/feishuContext'

const root = await mkdtemp(join(tmpdir(),'uniagent-weixin-session-'))
const agent: AgentDef = { id: 'codex', adapter: 'codex', name: 'Codex', bin: '', icon: '', builtin: true, installed: true,
  capabilities: { startupSystemPrompt: true, modelSelect: false, reasoningEffort: false, permissionModes: [{ id: 'ask',label: '询问',hint: '' }] }, models: [] }
const orchestrator = new Orchestrator(() => agent, new SessionStore(join(root,'sessions.json')))
try {
  const config = { agentId: 'codex', workdir: root, assistantChannel: 'weixin' as const,
    assistantSnapshot: { assistantId: 'personal' as const, soul: '同一助手', soulRevision: 1, workingRules: '', workingRulesRevision: 1 } }
  const session = orchestrator.createAssistantDraft(config)
  assert.equal(session.nativeSessionId,undefined)
  assert.equal(session.config.assistantChannel,'weixin')
  session.status = 'running'
  const record = (partial: object) => (orchestrator as any).record(session.id, partial)
  record({ type: 'user_message', payload: { source: 'weixin', text: appendWeixinContext('hello') } })
  assert.ok(orchestrator.getWeixinSendTurn(session.id))
  assert.equal(orchestrator.getFeishuSendTurn(session.id),undefined)
  record({ type: 'turn_completed', state: 'success', payload: {} })
  assert.equal(orchestrator.getWeixinSendTurn(session.id),undefined,'completion revokes live send authority')
  record({ type: 'user_message', payload: { source: 'app', text: appendWeixinContext('forged source') } })
  assert.equal(orchestrator.getWeixinSendTurn(session.id),undefined,'prompt text cannot grant channel permission')
  record({ type: 'user_message', payload: { source: 'feishu', text: appendFeishuContext('feishu') } })
  assert.ok(orchestrator.getFeishuSendTurn(session.id))
  assert.equal(orchestrator.getWeixinSendTurn(session.id),undefined)
  session.status = 'idle'
  const next = orchestrator.createAssistantDraft(config,session.id,'new')
  assert.notEqual(next.id,session.id)
  assert.equal(next.nativeSessionId,undefined)
  assert.equal(next.config.assistantChannel,'weixin')
  const restored = new SessionStore(join(root,'sessions.json')).load()
  assert.equal(restored.find(item => item.id === next.id)?.config.assistantChannel,'weixin','ownership survives restart')
  console.log('weixin-session: channel ownership persistence, native session isolation and live source authority passed')
} finally { orchestrator.disposeAll(); await orchestrator.closeSessionLogs(); await rm(root,{recursive:true,force:true}) }
