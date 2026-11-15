import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { CodexSourceService } from '../src/main/codexSourceService'
import { ClaudeSourceService } from '../src/main/claudeSourceService'
import { TaskTitleTrials, bindTaskTitleSourceChanges, bindTaskTitleLocalSourceChanges, taskTitleSelectionMatches, type TaskTitleSelectionChange } from '../src/main/taskTitleIntegration'
import { TaskMetadataStore } from '../src/main/taskMetadataStore'
import { TaskTitleService } from '../src/main/taskTitleService'
import { codexModelKey } from '../src/shared/codexModelIdentity'
import type { AgentDef, Session } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'title-source-events-'))
process.env.UNIAGENT_USER_DATA = root
const source = { id: 'mimo' as const, preset: 'mimo' as const, baseUrl: 'https://api.xiaomimimo.com/v1', enabled: true, models: ['mimo-v2.6-flash'], apiKey: 'fixture-key-first' }
const ref = { enabled: true, agentId: 'codex', model: codexModelKey('mimo-v2.6-flash', { kind: 'third-party', sourceId: 'mimo' }), modelSource: { kind: 'third-party' as const, sourceId: 'mimo' } }
const agents = ['codex', 'claude'].map(id => ({ id, adapter: id, name: id, bin: '/fixture', installed: true, models: [{ id: ref.model, imageInput: true, efforts: [], modelSource: ref.modelSource }, { id: 'native-small', efforts: [] }], capabilities: { modelSelect: true, startupSystemPrompt: true } } as AgentDef))
const session = { id: 'background', title: '临时', config: { agentId: 'codex' } } as Session
const pending: Array<{ signal: AbortSignal; resolve: (text: string) => void }> = []
const generate = async (_agent: AgentDef, _ref: any, _prompt: string, signal: AbortSignal) => new Promise<string>(resolve => pending.push({ signal, resolve }))
const titles = new TaskTitleService(new TaskMetadataStore(join(root, 'titles')), { session: id => id === session.id ? session : undefined, agents: () => agents, config: () => ref, generate }, { debounceMs: 0 })
const trials = new TaskTitleTrials(() => agents, generate)
const codex = new CodexSourceService(), claude = new ClaudeSourceService()
const connections: any[] = []
codex.on('connectionChanged', change => connections.push(change))
// Only the source router's external process is replaced. State/save/quota events remain real.
;(codex as any).spawnChild = async () => {}; (codex as any).stopChild = async () => {}
const invalidate = (change: TaskTitleSelectionChange) => { if (taskTitleSelectionMatches(ref, change)) titles.configurationChanged(); trials.selectionChanged(change) }
bindTaskTitleSourceChanges(codex, 'codex', invalidate)
bindTaskTitleSourceChanges(claude, 'claude', invalidate)
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; assert.fail('source fixture timeout') }
const input = { requestId: '11111111-1111-4111-8111-111111111111', config: ref, prompt: '修复图片漏显' }
try {
  await codex.save(source)
  titles.accepted(session.id, input.prompt, { inputId: 'first' }); titles.responded(session.id, '主 AI 确认了图片漏显的对象', 'first')
  const trial = trials.run(1, input); const result = trial.catch(error => error)
  await until(() => pending.length === 2)
  const initial = pending.slice()
  const mutationsBeforeQuota = connections.length
  const statuses: boolean[] = []; codex.on('changed', snapshot => statuses.push(snapshot.quotaRefreshing))
  await codex.refreshQuotas(true)
  assert.deepEqual(statuses, [true, false], 'real quota start/end notifications still reach renderer listeners')
  assert.equal(connections.length, mutationsBeforeQuota, 'quota status is not a connection revision')
  assert.equal(initial.some(entry => entry.signal.aborted), false, 'quota-only refresh must not cancel background title or unsaved trial')
  await claude.save({ ...source, baseUrl: 'https://api.xiaomimimo.com/anthropic' })
  assert.equal(initial.some(entry => entry.signal.aborted), false, 'unrelated Agent source mutation must not cancel Codex calls')
  await codex.save({ id: 'deepseek', preset: 'deepseek', enabled: true, baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash'], apiKey: 'fixture-other-key' })
  assert.equal(initial.some(entry => entry.signal.aborted), false, 'another source on the same Agent must not cancel selected calls')

  const claudeTrial = trials.run(2, { ...input, config: { ...ref, agentId: 'claude' } }).catch(error => error)
  const nativeTrial = trials.run(3, { ...input, config: { enabled: false, agentId: 'codex', model: 'native-small' } }).catch(error => error)
  await until(() => pending.length === 4)
  const claudeCall = pending[2], nativeCall = pending[3]
  await claude.save({ ...source, baseUrl: 'https://api.xiaomimimo.com/anthropic', apiKey: 'fixture-claude-replaced' })
  assert.equal(claudeCall.signal.aborted, true, 'unsaved trial uses its own Agent/source rather than global selection')
  assert.equal(nativeCall.signal.aborted, false)
  assert.equal(initial.some(entry => entry.signal.aborted), false)
  claudeCall.resolve('{"title":"迟到Claude标题","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await claudeTrial), /取消|cancel/)
  invalidate({ agentId: 'codex', modelSource: { kind: 'native' } })
  assert.equal(nativeCall.signal.aborted, true, 'native login invalidates unset native source')
  assert.equal(initial.some(entry => entry.signal.aborted), false, 'native login leaves supplemental connections untouched')
  nativeCall.resolve('{"title":"迟到原生标题","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await nativeTrial), /取消|cancel/)

  const localModel = codexModelKey('fixture-local', { kind: 'local', sourceId: 'bonsai' })
  agents[0].models.push({ id: localModel, label: 'Local', imageInput: true, efforts: [], modelSource: { kind: 'local', sourceId: 'bonsai' } })
  const local = new EventEmitter()
  bindTaskTitleLocalSourceChanges(local, invalidate)
  const localSnapshot: any = { availability: 'ready', activeModelId: 'fixture-local', packageVersion: '1',
    connection: { providerId: 'uniagent-local', baseUrl: 'http://127.0.0.1:9001', wireApi: 'responses', modelId: 'fixture-local' },
    models: [{ id: 'fixture-local', healthy: true, deploymentState: 'running', downloadState: 'verified', catalogEntry: {} }] }
  local.emit('changed', localSnapshot)
  const localTrial = trials.run(4, { ...input, config: { enabled: true, agentId: 'codex', model: localModel, modelSource: { kind: 'local', sourceId: 'bonsai' } } }).catch(error => error)
  await until(() => pending.length === 5)
  const localCall = pending[4]
  local.emit('changed', { ...localSnapshot, message: 'status-only', operation: { operation: 'download', modelId: 'another', stage: 'progress', percent: 10 } })
  assert.equal(localCall.signal.aborted, false, 'local progress-only/log changes do not invalidate active connection')
  local.emit('changed', { ...localSnapshot, activeModelId: null, connection: null })
  assert.equal(localCall.signal.aborted, true, 'local stop must invalidate selected local source')
  assert.equal(initial.some(entry => entry.signal.aborted), false, 'local source change leaves third-party calls untouched')
  localCall.resolve('{"title":"迟到本地标题","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await localTrial), /取消|cancel/)
  local.emit('changed', localSnapshot)
  const redeployTrial = trials.run(4, { ...input, config: { enabled: true, agentId: 'codex', model: localModel, modelSource: { kind: 'local', sourceId: 'bonsai' } } }).catch(error => error)
  await until(() => pending.length === 6)
  const redeployCall = pending[5]
  local.emit('changed', { ...localSnapshot, operation: { operation: 'deploy', modelId: 'fixture-local', stage: 'starting' } })
  assert.equal(redeployCall.signal.aborted, true, 'same-model local redeploy invalidates even if endpoint stays identical')
  redeployCall.resolve('{"title":"迟到部署标题","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await redeployTrial), /取消|cancel/)
  agents[0].models.push({ id: 'unrelated-model', label: 'Unrelated', efforts: [] })
  trials.agentsChanged()
  assert.equal(initial.some(entry => entry.signal.aborted), false, 'unrelated model catalog additions do not invalidate selected model')
  const otherAgentTrial = trials.run(2, { ...input, config: { enabled: false, agentId: 'claude', model: 'native-small' } }).catch(error => error)
  const otherAgentCall = pending.at(-1)!
  agents[1].version = 'fixture-updated-program'
  trials.agentsChanged()
  assert.equal(otherAgentCall.signal.aborted, true, 'unsaved trial Agent program changes invalidate its own request')
  assert.equal(initial.some(entry => entry.signal.aborted), false, 'unrelated Agent update leaves selected background connection untouched')
  otherAgentCall.resolve('{"title":"迟到程序标题","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await otherAgentTrial), /取消|cancel/)
  const publicFields = () => codex.snapshot().sources.map(({ quota: _quota, ...fields }) => fields)
  const publicBefore = publicFields()
  await codex.save({ ...source, apiKey: 'fixture-key-replaced' })
  assert.deepEqual(publicFields(), publicBefore, 'same-model credential replacement has the identical public connection fields')
  assert.equal(initial.every(entry => entry.signal.aborted), true, 'selected key replacement cancels both old calls')
  assert.deepEqual(connections.at(-1).sourceIds, ['mimo'])
  assert.ok(connections.every((event, index) => event.revision > 0 && (index === 0 || event.revision > connections[index - 1].revision)))
  assert.equal(JSON.stringify(connections).includes('fixture-key'), false, 'connection revisions expose no secret or credential hash')
  for (const entry of initial) entry.resolve('{"title":"迟到标题不应提交","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await result), /取消|cancel/)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.notEqual(session.taskMetadata?.title, '迟到标题不应提交')
  const oldDraftA = trials.run(2, { ...input, config: { enabled: false, agentId: 'claude', model: 'native-small' } }).catch(error => error)
  const oldDraftCallA = pending.at(-1)!
  const oldDraftB = trials.run(3, { ...input, config: { enabled: false, agentId: 'codex', model: 'native-small' } }).catch(error => error)
  const oldDraftCallB = pending.at(-1)!
  // Same cancellation used after a successful task-title settings save.
  trials.cancelAll()
  assert.equal(oldDraftCallA.signal.aborted && oldDraftCallB.signal.aborted, true, 'settings selection changes cancel all old draft selections')
  oldDraftCallA.resolve('{"title":"迟到草稿标题","description":"任务描述夹具","needsClarification":false}')
  oldDraftCallB.resolve('{"title":"迟到草稿标题","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await oldDraftA), /取消|cancel/); assert.match(String(await oldDraftB), /取消|cancel/)
  console.log('PASS real source quota vs credential mutation invalidation and late output rejection')
} finally {
  const close = titles.close()
  for (const entry of pending) entry.resolve('{"title":"清理夹具","description":"任务描述夹具","needsClarification":false}')
  await close; await trials.close(); await codex.close(); await rm(root, { recursive: true, force: true })
}

// Same typed selector ID can belong to independent native/provider models.
// Catalog invalidation must use each trial's own exact resolved source.
const duplicateAgent: AgentDef = { ...agents[0], models: [
  { id: 'light', label: 'Native', efforts: [] },
  { id: 'light', label: 'Provider A', imageInput: true, efforts: ['low'], modelSource: { kind: 'third-party', sourceId: 'provider-a' } },
  { id: 'light', label: 'Provider B', imageInput: true, efforts: [], modelSource: { kind: 'third-party', sourceId: 'provider-b' } }
] }
const duplicatePending: Array<{ signal: AbortSignal; resolve: (text: string) => void }> = []
const duplicateTrials = new TaskTitleTrials(() => [duplicateAgent], async (_agent, _config, _prompt, signal) =>
  new Promise<string>(resolve => duplicatePending.push({ signal, resolve })))
try {
  const native = duplicateTrials.run(1, { ...input, config: { enabled: false, agentId: 'codex', model: 'light' } }).catch(error => error)
  const providerA = duplicateTrials.run(2, { ...input, config: { enabled: false, agentId: 'codex', model: 'light', modelSource: { kind: 'third-party', sourceId: 'provider-a' } } }).catch(error => error)
  const providerB = duplicateTrials.run(3, { ...input, config: { enabled: false, agentId: 'codex', model: 'light', modelSource: { kind: 'third-party', sourceId: 'provider-b' } } }).catch(error => error)
  duplicateAgent.models[1] = { ...duplicateAgent.models[1], efforts: ['off'] }
  duplicateTrials.agentsChanged()
  assert.equal(duplicatePending[1].signal.aborted, true, 'selected provider catalog change cancels its own duplicate-id trial')
  assert.equal(duplicatePending[0].signal.aborted, false, 'native-first catalog entry remains independent')
  assert.equal(duplicatePending[2].signal.aborted, false, 'other same-id provider remains independent')
  duplicatePending[1].resolve('{"title":"迟到来源变更标题","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await providerA), /取消|cancel/)
  duplicateAgent.models.splice(2, 1)
  duplicateTrials.agentsChanged()
  assert.equal(duplicatePending[2].signal.aborted, true, 'selected provider removal cancels despite native same-id entry remaining')
  assert.equal(duplicatePending[0].signal.aborted, false)
  duplicatePending[2].resolve('{"title":"迟到来源删除标题","description":"任务描述夹具","needsClarification":false}')
  assert.match(String(await providerB), /取消|cancel/)
  duplicatePending[0].resolve('{"title":"原生标题仍可用","description":"任务描述夹具","needsClarification":false}')
  assert.equal((await native).title, '原生标题仍可用')
  console.log('PASS duplicate-id native/provider own-reference catalog mutation/removal cancellation')
} finally {
  for (const value of duplicatePending) value.resolve('{"title":"清理夹具","description":"任务描述夹具","needsClarification":false}')
  await duplicateTrials.close()
}
