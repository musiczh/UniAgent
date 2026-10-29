import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentDef } from '../src/shared/types.ts'
import { HistoryConfirmation } from '../src/renderer/components/ResumePanel.tsx'
import * as resumePanel from '../src/renderer/components/ResumePanel.tsx'
import { EventStream } from '../src/renderer/components/EventStream.tsx'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

async function rolloutFile(root: string, nativeId: string): Promise<string> {
  const files = await readdir(root, { recursive: true })
  const relative = files.find((file) => file.endsWith(`${nativeId}.jsonl`))
  assert.ok(relative, `missing rollout for ${nativeId}`)
  return join(root, relative)
}

const agent = (id: string): AgentDef => ({
  id,
  name: id === 'traex' ? 'TraeX' : id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : 'Kimi Code',
  bin: id,
  adapter: id,
  icon: id,
  builtin: true,
  installed: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    streaming: true,
    sessionLoad: true,
    sessionResume: true,
    sessionFork: true,
    permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
  },
  defaultModel: id === 'codex' ? 'gpt-6.1-sol' : 'GPT-5.6-Sol',
  models: [{
    id: id === 'codex' ? 'gpt-6.1-sol' : 'GPT-5.6-Sol',
    label: id === 'codex' ? 'GPT-6.1-Sol' : 'GPT-5.6-Sol',
    efforts: ['high'],
    defaultEffort: 'high'
  }]
} as AgentDef)

const agents = ['traex', 'codex', 'claude', 'kimi'].map(agent)
const targets = (resumePanel as typeof resumePanel & {
  currentSessionForkTargets?: (source: AgentDef, agents: AgentDef[]) => AgentDef[]
}).currentSessionForkTargets?.(agents[0], agents) ?? []

assert.deepEqual(
  targets.map((entry) => entry.id),
  ['traex', 'codex', 'claude'],
  'a current-session fork must offer the source Agent plus the two supported native import targets, never Kimi'
)

const markup = renderToStaticMarkup(createElement(HistoryConfirmation as any, {
  action: { kind: 'same' },
  agentName: 'TraeX',
  title: '当前会话',
  sourceAgentId: 'traex',
  targetAgents: targets,
  chooseTarget: true,
  onChangeAction: () => undefined,
  onCancel: () => undefined,
  onConfirm: () => undefined
}))

assert.match(markup, /目标 Agent/)
assert.equal((markup.match(/<option/g) || []).length, 3)
assert.match(markup, /TraeX（当前 Agent）/)
assert.match(markup, /当前会话末尾/)
assert.match(markup, /兼容模式/)
assert.match(markup, /aria-checked="false"/)
assert.doesNotMatch(markup, /Kimi Code/)

const compatibleMarkup = renderToStaticMarkup(createElement(HistoryConfirmation as any, {
  action: { kind: 'same', compatibilityMode: true },
  agentName: 'Codex',
  title: '当前会话',
  sourceAgentId: 'codex',
  targetAgents: [agents[1]],
  chooseTarget: true,
  onChangeAction: () => undefined,
  onCancel: () => undefined,
  onConfirm: () => undefined
}))
assert.match(compatibleMarkup, /重建历史，便于切换模型来源/)
assert.match(compatibleMarkup, /<strong>兼容模式<\/strong>/)
assert.match(compatibleMarkup, /部分推理、工具及原生上下文可能无法保留/)
assert.match(compatibleMarkup, /aria-checked="true"/)

const claudeMarkup = renderToStaticMarkup(createElement(HistoryConfirmation as any, {
  action: { kind: 'same' },
  agentName: 'Claude Code',
  title: 'Claude 会话',
  sourceAgentId: 'claude',
  targetAgents: [agents[2], agents[0], agents[1]],
  chooseTarget: true,
  onChangeAction: () => undefined,
  onCancel: () => undefined,
  onConfirm: () => undefined
}))
assert.match(claudeMarkup, /原 Agent 历史重建/)
assert.match(claudeMarkup, /部分推理、工具及原生上下文可能无法保留/)
assert.doesNotMatch(claudeMarkup, /重建历史，便于切换模型来源/)

const scratch = await mkdtemp(join(tmpdir(), 'ua-current-session-fork-'))
const previousHome = process.env.HOME
process.env.HOME = scratch
try {
  const nativeId = '11111111-1111-4111-8111-111111111111'
  const sessionsDir = join(scratch, '.trae/cli/sessions/2026/09/28')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(join(sessionsDir, `rollout-2026-09-28T00-00-00-${nativeId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: nativeId, session_id: nativeId, cwd: scratch, originator: 'trae-cli' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'GPT-5.6-Sol', cwd: scratch } }),
    JSON.stringify({ timestamp: '2026-09-28T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '最新问题' } }),
    JSON.stringify({ timestamp: '2026-09-28T00:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: '先检查工作规范', phase: 'commentary' } }),
    JSON.stringify({ timestamp: '2026-09-28T00:00:02Z', type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'check', command: 'pwd', exit_code: 0 } }),
    JSON.stringify({ timestamp: '2026-09-28T00:00:05Z', type: 'event_msg', payload: { type: 'agent_message', message: '最新回答', phase: 'final_answer' } })
  ].join('\n') + '\n')
  const [{ Orchestrator }, { SessionStore }] = await Promise.all([
    import('../src/main/orchestrator.ts'),
    import('../src/main/sessionStore.ts')
  ])
  const store = new SessionStore(join(scratch, 'sessions.json'))
  store.saveOrThrow([{
    id: 'team-member',
    title: '团队成员会话',
    config: { agentId: 'traex', workdir: scratch },
    status: 'idle',
    createdAt: 1,
    nativeSessionId: nativeId,
    teamBinding: { teamProjectId: 'team-1', memberId: 'member-1' }
  }])
  const orchestrator = new Orchestrator((id) => agents.find((entry) => entry.id === id), store)
  orchestrator.loadPersisted()
  const fork = await orchestrator.forkSameSession('traex', nativeId, scratch)
  assert.equal(fork?.teamBinding, undefined, 'a team member transcript must fork into an ordinary independent session')
  assert.equal(fork?.readOnly, false)
  assert.equal(fork?.forkedFrom?.nativeId, nativeId)
  assert.equal(fork?.forkedFrom?.mode, 'same')
  const compatibleFork = await orchestrator.forkSameSession('traex', nativeId, scratch, undefined, true)
  assert.equal(compatibleFork?.config.agentId, 'traex')
  assert.equal(compatibleFork?.forkedFrom?.mode, 'compatible')
  assert.notEqual(compatibleFork?.nativeSessionId, nativeId)
  const compatibleRollout = await rolloutFile(join(scratch, '.trae/cli/sessions'), compatibleFork!.nativeSessionId!)
  const compatibleRecords = (await readFile(compatibleRollout, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(compatibleRecords.some((record) => record.type === 'response_item'))
  assert.equal(
    compatibleRecords.find((record) => record.type === 'session_meta')?.payload?.uniagent_transplant,
    true
  )
  const crossFork = await orchestrator.forkCrossSession('traex', nativeId, 'codex')
  assert.equal(crossFork?.config.agentId, 'codex', 'the selected target Agent must own the cross-Agent fork')
  assert.equal(crossFork?.teamBinding, undefined)
  assert.equal(crossFork?.forkedFrom?.mode, 'cross')
  assert.equal(crossFork?.config.model, 'gpt-6.1-sol', 'the fork must use a target-native model instead of the TraeX model slug')
  assert.equal(fork?.config.model, 'GPT-5.6-Sol', 'same-Agent forks must retain the source model')
  const crossRollout = await rolloutFile(join(scratch, '.codex/sessions'), crossFork!.nativeSessionId!)
  const crossRecords = (await readFile(crossRollout, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(
    crossRecords.map((record) => record.ordinal),
    crossRecords.map((_, index) => index),
    'cross-Agent rollouts must carry contiguous ordinals required by thread-store resume'
  )
  assert.equal(crossRecords.find(record => record.type === 'turn_context')?.payload.model, 'gpt-6.1-sol')
  const crossEvents = await orchestrator.getEvents(crossFork!.id)
  assert.equal(crossEvents.filter(event => event.type === 'turn_completed').length, 1,
    'rebuilt turns without target-native ids must still complete')
  assert.equal(crossEvents.find(event => event.payload.phase === 'commentary')?.payload.text, '先检查工作规范')
  assert.equal(crossEvents.find(event => event.payload.phase === 'final_answer')?.payload.text, '最新回答')
  assert.equal(crossEvents.at(-1)!.ts - crossEvents.find(event => event.type === 'user_message')!.ts, 5_000,
    'the time button must retain source timestamps')
  const crossMarkup = renderToStaticMarkup(createElement(EventStream, {
    events: crossEvents, status: 'idle', sessionId: crossFork!.id
  }))
  assert.match(crossMarkup, /processed-fold closed/, 'forked history must use the existing collapsed timeline')
  assert.match(crossMarkup, /已处理 5s/)
  assert.match(crossMarkup, /class="card agent-msg"[\s\S]*最新回答/, 'the final reply remains visible outside the work step')

  crossFork!.config.model = 'GPT-5.6-Sol'
  assert.equal(orchestrator.reconcileAgentConfigs(), true)
  assert.equal(crossFork!.config.model, 'gpt-6.1-sol', 'old cross-Agent forks must recover their target model')
  const legacyRecords = crossRecords.map(record => {
    const payload = { ...record.payload }
    if (record.type === 'turn_context') payload.model = 'GPT-5.6-Sol'
    delete payload.phase
    return { ...record, payload }
  })
  await writeFile(crossRollout, legacyRecords.map(record => JSON.stringify(record)).join('\n') + '\n')
  const { loadSessionEvents } = await import('../src/main/history.ts')
  const legacy = await loadSessionEvents('codex', crossFork!.nativeSessionId!)
  assert.equal(legacy.events.filter(event => event.type === 'turn_completed').length, 1,
    'legacy transplants without completion records also close at EOF')
  assert.equal(legacy.events.some(event => event.type === 'turn_started'), false,
    'replayed transplants must not invent target-native turn identities')
  assert.match(renderToStaticMarkup(createElement(EventStream, {
    events: legacy.events, status: 'idle', sessionId: crossFork!.id
  })), /processed-fold closed/, 'legacy history without phases must also start collapsed')
  const refreshedCross = await orchestrator.importSession('codex', crossFork!.nativeSessionId!)
  assert.equal(refreshedCross?.config.model, 'gpt-6.1-sol',
    'refreshing an old fork must not overwrite its selected model with the source history model')
  orchestrator.disposeAll()
} finally {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(scratch, { recursive: true, force: true })
}

console.log('current-session-fork: ok')
