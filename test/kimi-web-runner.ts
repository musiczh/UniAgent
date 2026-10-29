import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/main/sessionStore.ts'
import { KimiWebRunner } from '../src/main/kimiWebRunner.ts'
import { kimiWebContract } from '../src/main/kimiWebContract.ts'
import { assertKimiWebConfig } from '../src/main/kimiRoleConfig.ts'
import { buildKimiWebContent, projectKimiWebUsage } from '../src/main/kimiWebEventProjection.ts'
import { resolveAgentModel } from '../src/shared/agentChoices.ts'

const config: any = { agentId: 'kimi', workdir: '/tmp', permissionMode: 'ask' }
const agent: any = { id: 'kimi', name: 'Kimi', bin: 'unused', adapter: 'kimi', capabilities: {}, models: [] }
const runner: any = new KimiWebRunner('fixture', { n: 0 }, agent, config)
const events: any[] = [], profiles: any[] = [], answers: any[] = []
runner.runtime = {
  setProfile: async (profile: any) => { profiles.push(profile) }, status: async () => ({ model: 'local', plan_mode: false, permission: profiles.at(-1)?.permission_mode }),
  models: async () => ({ items: [{ model: 'local', max_context_size: 8192, support_efforts: ['off', 'high'], capabilities: ['image_in'] }] }),
  answerQuestion: async (...args: any[]) => { answers.push(args) }, resolveApproval: async (...args: any[]) => { answers.push(args) },
  closeAndWait: async () => {}, steerContent: async () => ({ steered: false, prompt_id: 'accepted-next-turn' })
}
runner.on('event', (event: any) => events.push(event))
await runner.updateConfig({ ...config, model: 'local', permissionMode: 'full-access' })
assert.equal(profiles[0].permission_mode, 'yolo')
assert.equal(runner.contract.sideChat, false)
assert.equal(runner.contract.steer, true)
assert.equal(runner.contract.models[0].thinkingOptions[1], 'high')
await assert.rejects(runner.updateConfig({ ...config, additionalDirectories: ['/other'] }), /附加目录/)
assert.throws(() => assertKimiWebConfig({ ...config, roleSnapshot: { instructions: 'privileged role' } }), /角色系统指令/)
assert.throws(() => assertKimiWebConfig({ ...config, roleSnapshot: { skills: [] } }), /白名单/)
assert.equal(profiles.length, 1, 'invalid policies must fail before native profile mutation')
await runner.onFrame({ type: 'turn.started', payload: { turnId: 1 } })
await runner.onFrame({ type: 'event.question.requested', payload: { question_id: 'q', questions: [{ id: 'one', question: 'Pick', options: [{ id: 'a', label: 'A' }], allow_other: false }] } })
assert.equal((await runner.respondResult('kimi-web-question-q', { answers: { one: { answers: ['unknown'] } } })).handled, false)
assert.equal(answers.length, 0)
assert.equal((await runner.respondResult('kimi-web-question-q', { answers: { one: { answers: ['A'] } } })).handled, true)
assert.deepEqual(answers[0], ['q', { one: { kind: 'single', option_id: 'a' } }])
assert.equal((await runner.respondResult('kimi-web-question-q', {})).handled, false, 'resolved requests cannot be answered twice')
// ExitPlanMode plan_review must surface plan decision buttons (planMode), not a permission box
const planRow = (approvalId: string): any => ({ approval_id: approvalId, tool_call_id: `tool-${approvalId}`, tool_name: 'ExitPlanMode', action: 'exit_plan_mode', display: { kind: 'plan_review', plan: '# 计划', path: '/tmp/plan.md' } })
await runner.onFrame({ type: 'event.approval.requested', payload: planRow('ap-plan') })
const planRequest = events.find(event => event.type === 'approval_request' && event.payload?.requestId === 'kimi-web-approval-ap-plan')
assert.equal(planRequest?.payload?.kind, 'planMode', 'plan review must render plan decision buttons')
assert.equal(planRequest?.payload?.params?.plan, '# 计划')
assert.ok(events.some(event => event.payload?.kind === 'plan' && event.payload?.text === '# 计划'), 'plan body must reach the stream')
assert.equal((await runner.respondResult('kimi-web-approval-ap-plan', { decision: 'approved' })).handled, true)
assert.deepEqual(answers.at(-1), ['ap-plan', { decision: 'approved' }], 'implement must exit plan mode via native approved')
await runner.onFrame({ type: 'event.approval.requested', payload: planRow('ap-revise') })
assert.equal((await runner.respondResult('kimi-web-approval-ap-revise', { decision: 'rejected', feedback: '改成方案 B' })).handled, true)
assert.deepEqual(answers.at(-1), ['ap-revise', { decision: 'rejected', feedback: '改成方案 B' }], 'revise feedback rides the native rejection')
await runner.onFrame({ type: 'event.approval.requested', payload: planRow('ap-skip') })
assert.equal((await runner.respondResult('kimi-web-approval-ap-skip', { decision: 'cancelled' })).handled, true)
assert.deepEqual(answers.at(-1), ['ap-skip', { decision: 'cancelled' }], 'skip dismisses the approval and keeps plan mode')
// Non-plan approvals keep the permission-option contract
await runner.onFrame({ type: 'event.approval.requested', payload: { approval_id: 'ap-bash', tool_call_id: 'tool-bash', tool_name: 'Bash', action: 'run', display: { kind: 'command', command: 'ls' } } })
const permissionRequest = events.find(event => event.type === 'approval_request' && event.payload?.requestId === 'kimi-web-approval-ap-bash')
assert.equal(permissionRequest?.payload?.kind, 'permission', 'non-plan approvals stay permission requests')
assert.equal((await runner.respondResult('kimi-web-approval-ap-bash', { outcome: { outcome: 'selected', optionId: 'allow_once' } })).handled, true)
assert.deepEqual(answers.at(-1), ['ap-bash', { decision: 'approved' }])
await runner.onFrame({type:'interaction',kind:'approval',interaction_id:'new-permission',status:'pending',tool_call_id:'write-new',request:{tool_name:'Write',action:'write',tool_input_display:{kind:'file_io',path:'/fixture'}}})
assert.equal(events.find(event=>event.payload?.requestId==='kimi-web-approval-new-permission')?.state,'pending')
assert.equal((await runner.respondResult('kimi-web-approval-new-permission',{outcome:{outcome:'selected',optionId:'reject_once'}})).handled,true)
assert.deepEqual(answers.at(-1),['new-permission',{decision:'rejected'}])
await runner.onFrame({type:'interaction',kind:'question',interaction_id:'new-question',status:'pending',request:{questions:[{id:'one',question:'Pick',options:[{id:'a',label:'A'}],allow_other:false}]}})
assert.equal((await runner.respondResult('kimi-web-question-new-question',{answers:{one:{answers:['A']}}})).handled,true)
assert.deepEqual(answers.at(-1),['new-question',{one:{kind:'single',option_id:'a'}}])
await runner.onFrame({type:'interaction',kind:'approval',interaction_id:'expired',status:'pending',request:{tool_name:'Bash',action:'run'}})
await runner.onFrame({type:'interaction',kind:'approval',interaction_id:'expired',status:'ended',outcome:'cancelled'})
assert.equal((await runner.respondResult('kimi-web-approval-expired',{decision:'approved'})).handled,false,'ended interactions cannot be answered again')
assert.deepEqual(await runner.steer('next'), { appendedToTurn: false, nativePromptId: 'accepted-next-turn' })
await runner.onFrame({ type: 'turn.step.completed', payload: { turnId: 1, step: 0, usage: { inputOther: 10, inputCacheRead: 3, output: 2 } } })
await runner.onFrame({ type: 'turn.step.completed', payload: { turnId: 1, step: 1, usage: { inputOther: 20, output: 4 } } })
await runner.onFrame({ type: 'turn.step.completed', payload: { turnId: 1, step: 1, usage: { inputOther: 20, output: 4 } } })
runner.finish('success')
const usage = events.filter(event => event.payload.kind === 'usage')
assert.equal(usage.length, 1, 'one usage footer per native turn, not one per model step or replay')
assert.equal(usage[0].payload.usage.inputTokens, 33)
assert.equal(usage[0].payload.usage.outputTokens, 6)
assert.equal(usage[0].payload.usage.contextTokens, 20, 'context occupancy is the last model input, not cumulative billing')
await assert.rejects(runner.setGoal({ objective: 'test', tokenBudget: 20 }), /goal_budget_unsupported/)
assert.deepEqual(projectKimiWebUsage({ inputOther: 10, inputCacheRead: 3, inputCacheCreation: 2, output: 5 }), { inputTokens: 15, outputTokens: 5, cachedInputTokens: 3 })
assert.deepEqual(await buildKimiWebContent('literal $HOME'), [{ type: 'text', text: 'literal $HOME' }])
assert.equal(kimiWebContract([]).sessionForkAtTurn, false)
const modelRows = [{ model: 'alphabetically-first' }, { model: 'existing-default', display_name: 'Existing default', capabilities: ['image_in'] }]
const catalogContract = kimiWebContract(modelRows)
assert.deepEqual(catalogContract.models.map(model => model.id), ['alphabetically-first', 'existing-default'], 'only real catalog models are selectable')
assert.equal(catalogContract.currentModelId, 'alphabetically-first', 'a missing model falls back to a concrete catalog entry')
const selectedContract = kimiWebContract(modelRows, { model: 'existing-default' })
assert.equal(selectedContract.currentModelId, 'existing-default', 'the native selection must take priority over catalog order')
assert.equal(selectedContract.imageAttachments, true)
assert.equal(selectedContract.models[1].label, 'Existing default')
assert.equal(kimiWebContract(modelRows, { model: 'removed-model' }).currentModelId, 'alphabetically-first', 'an obsolete selection must resolve to an available model')
assert.equal(kimiWebContract([]).currentModelId, undefined, 'an empty catalog must not invent a default model')
assert.deepEqual(kimiWebContract([]).models, [])
assert.deepEqual(kimiWebContract([{ model: 'default', display_name: 'Real model alias' }]).models.map(model => model.label), ['Real model alias'], 'a real model alias named default is preserved')
const modelAgent = { ...agent, capabilities: { modelSelect: true }, models: catalogContract.models, defaultModel: 'existing-default' }
assert.equal(resolveAgentModel(modelAgent, 'default')?.id, 'existing-default', 'a saved legacy placeholder resolves to the native default')
assert.equal(resolveAgentModel(modelAgent, 'alphabetically-first')?.id, 'alphabetically-first', 'an existing concrete user selection is preserved')
await runner.updateConfig({ ...config, permissionMode: 'unattended' })
assert.equal(profiles.at(-1).permission_mode, 'auto')
assert.equal(runner.contract.currentPermissionMode, 'unattended')
await runner.updateConfig({ ...config, permissionMode: 'full-access' })
const apply = runner.runtime.setProfile
runner.runtime.setProfile = async (profile: any) => {
  if (profile.permission_mode === 'auto') throw new Error('profile_not_applied')
  return apply(profile)
}
await assert.rejects(runner.updateConfig({ ...config, permissionMode: 'unattended' }), /profile_not_applied/)
assert.equal(runner.config.permissionMode, 'full-access', 'a rejected switch must preserve the saved permission')
assert.equal(profiles.at(-1).permission_mode, 'yolo', 'a rejected switch must restore the native permission')
await runner.disposeAndWait()
const directory = await mkdtemp(join(tmpdir(), 'kimi-home-binding-'))
try {
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.saveOrThrow([{ id: 'bound', title: 'Bound native identity', config: { ...config, kimiDataHome: join(directory, 'native-home') }, nativeSessionId: 'same-id', status: 'idle', createdAt: 1 }])
  assert.equal(new SessionStore(join(directory, 'sessions.json')).load()[0].config.kimiDataHome, join(directory, 'native-home'), 'storage identity must survive a cold load, independent of default HOME')
} finally { await rm(directory, { recursive: true, force: true }) }
console.log('Kimi Web runner: applied profile, policy rejection, typed question, plan decision mapping and steer receipt passed')
