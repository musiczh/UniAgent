import assert from 'node:assert/strict'
import { prepareAssistantMessage, configureProjectContext, configureAssistantContextRuntime, configureAssistantContext,
  prepareAssistantInitialization, assistantInitialization, assistantContextCompacted, stripAssistantContext, currentAssistantContext } from '../src/main/assistant/context'
import { withAssistantMessageSource } from '../src/main/assistant/context'
import { reconcileAssistantInput, reconcileAssistantText } from '../src/main/assistant/context'
import { Orchestrator } from '../src/main/orchestrator'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { GrokACPRunner } from '../src/main/grokACPRunner'
import { appendFeishuContext } from '../src/shared/feishuContext'
import { appendWeixinContext } from '../src/shared/weixin'
import { parseAssistantSnapshot } from '../src/shared/assistant'
import { buildInput } from '../src/main/maxMode'
import { SessionStore } from '../src/main/sessionStore'
import { sessionInstructions } from '../src/main/sessionInstructions'
import { parseSessionPromptContext } from '../src/shared/promptContext'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session } from '../src/shared/types'

configureProjectContext(async () => '[uniagent_project_context]\n固定项目资料指南\n[]')
const sessions = new Map<string, Session>()
const create = (id: string, agentId = 'codex') => {
  const value: Session = { id, title: id, config: { agentId, workdir: '/work' }, status: 'idle', createdAt: 1 }
  sessions.set(id, value); return value
}
let writes = 0
configureAssistantContextRuntime(id => sessions.get(id), () => { writes++ })
const codex = create('native-codex')
const first = await prepareAssistantMessage(codex.id, codex.config, '原始请求')
assert.equal(first.text, '原始请求'); first.accepted()
const rules = sessionInstructions(codex.config, codex.id)
assert.match(rules, /UniAgent MCP 可使用对象/)
assert.match(rules, /飞书通道下[\s\S]*send_to_feishu[\s\S]*微信通道下[\s\S]*send_to_weixin/)
assert.doesNotMatch(rules, /response-annotations|response-comments|codex-annotation|需要当前 Agent|完整通道交付规则/)
assert.doesNotMatch(assistantInitialization(codex.id), /"workspace"|初始化时采集的资料快照/)
for (const system of [true, false]) {
  for (const channel of ['app', 'feishu', 'weixin'] as const) {
    const session = create(`first-${channel}-${system}`, system ? 'codex' : 'grok')
    const label = channel === 'app' ? 'UniAgent App' : channel === 'feishu' ? '飞书' : '微信'
    const delivery = await withAssistantMessageSource(session.id, channel, () => prepareAssistantMessage(session.id, session.config, '首条原文', '固定规则', system))
    assert.ok((system ? delivery.context : delivery.text)?.includes(`当前消息通道：${label}\n`), 'the first input carries its host channel without relying on a context query')
    assert.equal(stripAssistantContext(delivery.text), '首条原文')
    if (system) assert.deepEqual(delivery.content, [{ type: 'text', text: delivery.context }, { type: 'text', text: '首条原文' }])
    delivery.accepted()
    const next = await withAssistantMessageSource(session.id, channel, () => prepareAssistantMessage(session.id, session.config, '后续原文', '固定规则', system))
    assert.equal(next.text, '后续原文'); assert.equal(next.context, undefined); next.accepted()
    assistantContextCompacted(session.id, `compact-${channel}-${system}`)
    await prepareAssistantInitialization(session)
    assert.equal((await currentAssistantContext(session.id) as any).channel, channel, 'context rebuilding preserves the last delivered channel')
    if (!system) {
      const command = await withAssistantMessageSource(session.id, channel, () => prepareAssistantMessage(session.id, session.config, '/help', '固定规则', system))
      assert.equal(command.text, '/help')
      command.bindNativeInput(`command-${channel}`)
      reconcileAssistantInput(session.id, `command-${channel}`)
      command.accepted()
    }
    const restored = await withAssistantMessageSource(session.id, channel, () => prepareAssistantMessage(session.id, session.config, '恢复原文', '固定规则', system))
    assert.ok((system ? restored.context : restored.text)?.includes(`当前消息通道：${label}\n`), 'a rebuilt context receives its current channel even when the source did not change')
    assert.equal(stripAssistantContext(restored.text), '恢复原文')
    if (!system) assert.doesNotMatch(restored.text, /uniagent_initial_context|固定规则/)
    restored.accepted()
    const continued = await withAssistantMessageSource(session.id, channel, () => prepareAssistantMessage(session.id, session.config, '继续原文', '固定规则', system))
    assert.equal(continued.text, '继续原文'); assert.equal(continued.context, undefined); continued.accepted()
  }
}
assert.equal(parseSessionPromptContext({ ...codex.promptContext, channelContextPending: 'yes' }), undefined, 'pending channel metadata must be a boolean')
const steer = await prepareAssistantMessage(codex.id, codex.config, '加速')
assert.equal(steer.text, '加速'); assert.equal(steer.context, undefined); steer.accepted()
assert.equal((await prepareAssistantMessage(codex.id, codex.config, '/compact')).text, '/compact')
const feishu = await prepareAssistantMessage(codex.id, codex.config, appendFeishuContext('加速'))
assert.equal(feishu.text, '加速')
assert.match(feishu.context!, /UniAgent App → 飞书/)
assert.equal(buildInput(feishu.text, undefined, undefined, feishu.context).at(-1).text, '加速', 'control word is its own native text block')
assert.equal(codex.promptContext!.lastChannel, 'app', 'preparation does not advance the delivered channel')
feishu.failed(true)
assert.equal(codex.promptContext!.lastChannel, 'app')
const retried = await prepareAssistantMessage(codex.id, codex.config, appendFeishuContext('加速'))
retried.accepted()
const sameChannel = await prepareAssistantMessage(codex.id, codex.config, appendFeishuContext('下一条'))
assert.equal(sameChannel.text, '下一条'); assert.equal(sameChannel.context, undefined); sameChannel.accepted()
const back = await prepareAssistantMessage(codex.id, codex.config, '/compact')
assert.equal(back.text, '/compact'); assert.match(back.context!, /飞书 → UniAgent App/); back.accepted()
const weixin = await prepareAssistantMessage(codex.id, codex.config, appendWeixinContext('微信输入'))
assert.equal(weixin.text, '微信输入'); weixin.accepted()
assert.equal((await currentAssistantContext(codex.id) as any).channel, 'weixin')
const pasted = await withAssistantMessageSource(codex.id, 'app', () => prepareAssistantMessage(codex.id, codex.config, appendFeishuContext('桌面粘贴旧标记')))
assert.equal(pasted.text, appendFeishuContext('桌面粘贴旧标记'), 'literal pasted text is preserved')
assert.match(pasted.context!, /微信 → UniAgent App/); pasted.accepted()
assert.equal((await currentAssistantContext(codex.id) as any).channel, 'app', 'channel ownership comes from the host, not pasted prompt text')
await assert.rejects(currentAssistantContext('other-session'), /context_session_not_found/)
const serialized = create('serialized')
const seed = await prepareAssistantMessage(serialized.id, serialized.config, '首条 App 输入'); seed.accepted()
const live = new AppServerRunner(serialized.id, { n: 0 }, { id: 'codex', adapter: 'codex', bin: '/fixture', capabilities: {} } as any, serialized.config) as any
serialized.nativeSessionId = live.threadId = 'serial-thread'; live.curTurnId = 'serial-turn'
const calls: any[] = []
let release!: () => void
const barrier = new Promise<void>(resolve => { release = resolve })
live.rpc = async (_method: string, params: any) => { calls.push(params); if (calls.length === 1) await barrier; return {} }
const toFeishu = withAssistantMessageSource(serialized.id, 'feishu', () => live.steerStrict(appendFeishuContext('加速')))
const toApp = withAssistantMessageSource(serialized.id, 'app', () => live.steerStrict('加速'))
await new Promise(resolve => setImmediate(resolve))
assert.equal(calls.length, 1, 'concurrent steering waits for the preceding native receipt')
release(); await Promise.all([toFeishu, toApp])
assert.match(calls[0].input[0].text, /UniAgent App → 飞书/)
assert.match(calls[1].input[0].text, /飞书 → UniAgent App/)
assert.equal(calls[0].input.at(-1).text, '加速'); assert.equal(calls[1].input.at(-1).text, '加速')
live.curTurnId = undefined; live.dispose()

for (const provider of ['grok', 'mcode']) {
  const session = create(`steer-${provider}`, provider)
  const initial = await prepareAssistantMessage(session.id, session.config, '初始业务输入', '固定规则', false)
  initial.accepted()
  const runner = new GrokACPRunner(session.id, { n: 0 }, { id: provider, adapter: provider, bin: '/fixture', capabilities: {} } as any, session.config) as any
  runner.running = true; runner.promptTurnId = 1; runner.nativeSessionId = `native-${provider}`
  runner.native = { confirmed: true, capabilities: { steer: { status: 'verified' } } }
  runner.initializeResult = { _meta: { 'minimax-code/extensions': { methods: ['mcode/session/steer'] } } }
  const requests: any[] = []
  runner.connection = { request: async (_method: string, params: any) => {
    requests.push(params)
    return provider === 'grok' ? { result: { status: 'queued' } } : { mode: 'steered' }
  } }
  await withAssistantMessageSource(session.id, 'feishu', () => runner.steer(appendFeishuContext('切换后的引导')))
  assert.match(requests[0].text, /UniAgent App → 飞书/, `${provider} text-only steering carries the channel transition`)
  assert.equal(stripAssistantContext(requests[0].text), '切换后的引导')
  await withAssistantMessageSource(session.id, 'feishu', () => runner.steer(appendFeishuContext('同通道引导')))
  assert.equal(requests[1].text, '同通道引导')
}

const fallback = create('fallback', 'grok')
let message = await prepareAssistantMessage(fallback.id, fallback.config, '原始输入', '固定规则', false)
assert.match(message.text, /固定规则/); assert.equal(stripAssistantContext(message.text), '原始输入')
assert.equal(fallback.promptContext!.fallback, 'pending')
await assert.rejects(prepareAssistantMessage(fallback.id, fallback.config, '未知后续', '固定规则', false), /送达结果尚未确认/)
message.failed(true)
assert.equal(fallback.promptContext!.fallback, 'ready')
message = await prepareAssistantMessage(fallback.id, fallback.config, '原始输入', '固定规则', false)
message.accepted()
assert.equal((await prepareAssistantMessage(fallback.id, fallback.config, '加速', '固定规则', false)).text, '加速')
const uncertain = create('uncertain', 'nika')
const uncertainMessage = await prepareAssistantMessage(uncertain.id, uncertain.config, '首条输入', '固定规则', false)
uncertainMessage.bindNativeInput('native-message-id')
reconcileAssistantInput(uncertain.id, 'other-native-id')
assert.equal(uncertain.promptContext!.fallback, 'pending')
reconcileAssistantInput(uncertain.id, 'native-message-id')
assert.equal(uncertain.promptContext!.fallback, 'accepted', 'only a matching native receipt resolves delivery uncertainty')
const textUncertain = create('text-uncertain', 'grok')
await prepareAssistantInitialization(textUncertain)
textUncertain.nativeSessionId = 'native-a'
const submitted = await prepareAssistantMessage(textUncertain.id, textUncertain.config, '首轮请求', '固定规则', false)
reconcileAssistantText(textUncertain.id, submitted.text, 'native-b')
assert.equal(textUncertain.promptContext!.fallback, 'pending')
reconcileAssistantText(textUncertain.id, '其它输入', 'native-a')
assert.equal(textUncertain.promptContext!.fallback, 'pending')
reconcileAssistantText(textUncertain.id, submitted.text, 'native-a')
assert.equal(textUncertain.promptContext!.fallback, 'accepted', 'exact native history in the same thread can reconcile a lost first receipt')
const legacy = create('legacy', 'grok'); legacy.nativeSessionId = 'existing-native'
const legacyMessage = await prepareAssistantMessage(legacy.id, legacy.config, '继续', '固定规则', false)
assert.equal(stripAssistantContext(legacyMessage.text), '继续')
assert.match(legacyMessage.text, /当前消息通道：UniAgent App/)
assert.doesNotMatch(legacyMessage.text, /uniagent_initial_context|固定规则/, 'legacy native history receives its current channel without repeating initialization')
const routerTarget = create('router-target')
const owner = Object.assign(Object.create(Orchestrator.prototype), { sessions, persistOrThrow: () => {} }) as Orchestrator
assert.equal(owner.setInitialRequirementContext(routerTarget.id, '任务目标与来源：docs/spec.md'), true)
await prepareAssistantInitialization(routerTarget)
assert.match(assistantInitialization(routerTarget.id), /任务目标与来源：docs\/spec.md/)
assert.equal(owner.setInitialRequirementContext(routerTarget.id, '第二次补充'), false)
assert.doesNotMatch(assistantInitialization(routerTarget.id), /第二次补充/)

const memorySession = create('assistant')
memorySession.config.assistantSnapshot = parseAssistantSnapshot({ assistantId: 'personal', soul: '角色', soulRevision: 1, workingRules: '纪律', workingRulesRevision: 1 })!
let memory = '最初记忆', reads = 0
configureAssistantContext(async () => { reads++; return [{ assistantId: 'personal', type: 'memory', content: memory, revision: reads, updatedAt: 1, updatedBy: 'user' }] })
await prepareAssistantInitialization(memorySession)
assert.match(assistantInitialization(memorySession.id), /最初记忆/)
memory = '用户更新的记忆'
await prepareAssistantInitialization(memorySession)
assert.equal(reads, 1); assert.doesNotMatch(assistantInitialization(memorySession.id), /用户更新/)
assistantContextCompacted(memorySession.id, 'compact-1')
await prepareAssistantInitialization(memorySession)
assert.equal(reads, 2); assert.match(assistantInitialization(memorySession.id), /用户更新的记忆/)
assistantContextCompacted(memorySession.id, 'compact-1')
await prepareAssistantInitialization(memorySession); assert.equal(reads, 2)
memory = ''
assistantContextCompacted(memorySession.id, 'compact-2')
await prepareAssistantInitialization(memorySession)
assert.doesNotMatch(assistantInitialization(memorySession.id), /MEMORY.md|"documents":\[\]/)

const policySession = create('worktree-policy')
policySession.nativeSessionId = 'policy-native'
policySession.config.projectId = 'policy-project'
policySession.config.assistantSnapshot = memorySession.config.assistantSnapshot
policySession.config.worktree = {
  id: '11111111-1111-4111-8111-111111111111', projectId: 'policy-project', sourcePrimaryDirectory: '/source', repositoryRoot: '/source',
  gitCommonDirectory: '/source/.git', checkoutRoot: '/work', workdir: '/work', branch: 'uniagent/policy', baseRef: 'refs/heads/main',
  baseCommit: 'a'.repeat(40), creationRequestId: '22222222-2222-4222-8222-222222222222', state: 'ready', autoSyncBack: false
}
let policyReads = 0, policyMemory = '策略初始化记忆'
configureAssistantContext(async id => {
  assert.equal(id, policySession.id)
  policyReads++
  return [{ assistantId: 'personal', type: 'memory', content: policyMemory, revision: policyReads, updatedAt: 1, updatedBy: 'user' }]
})
await prepareAssistantInitialization(policySession)
assert.equal(policyReads, 1)
assert.match(sessionInstructions(policySession.config, policySession.id), /不自动合并回源分支/)
const disabled = await prepareAssistantMessage(policySession.id, policySession.config, '关闭时的原文'); disabled.accepted()
const policySnapshot = assistantInitialization(policySession.id)
policyMemory = '策略变更后的记忆'
policySession.config.worktree = { ...policySession.config.worktree, autoSyncBack: undefined, baseCommit: 'b'.repeat(40) }
await prepareAssistantInitialization(policySession)
assert.equal(policyReads, 1, 'equivalent disabled policy and non-rendered Git metadata keep assistant memory frozen')
assert.equal(assistantInitialization(policySession.id), policySnapshot)
const policyFollowup = await prepareAssistantMessage(policySession.id, policySession.config, '同策略原文')
assert.equal(policyFollowup.text, '同策略原文'); assert.equal(policyFollowup.context, undefined); policyFollowup.accepted()
policySession.config.worktree = { ...policySession.config.worktree, autoSyncBack: true }
await prepareAssistantInitialization(policySession)
assert.equal(policyReads, 2, 'enabling source merge rebuilds the frozen rules before the next turn')
assert.match(sessionInstructions(policySession.config, policySession.id), /提交后由你合并回本机源分支/)
assert.match(assistantInitialization(policySession.id), /策略变更后的记忆/)
const enabled = await prepareAssistantMessage(policySession.id, policySession.config, '开启后的原文'); enabled.accepted()
policyMemory = '关闭后重建的记忆'
policySession.config.worktree = { ...policySession.config.worktree, autoSyncBack: false }
await prepareAssistantInitialization(policySession)
assert.equal(policyReads, 3, 'disabling source merge replaces the previously enabled rules')
assert.match(sessionInstructions(policySession.config, policySession.id), /不自动合并回源分支/)
assert.doesNotMatch(sessionInstructions(policySession.config, policySession.id), /提交后由你合并回本机源分支/)
assert.match(assistantInitialization(policySession.id), /关闭后重建的记忆/)

const directory = await mkdtemp(join(tmpdir(), 'ua-prompt-context-'))
// Project directories are resolved by the host after loading persisted config.
const store = new SessionStore(join(directory, 'sessions.json'), config => config.worktree ? { ...config, workdir: config.worktree.workdir } : config)
store.saveOrThrow([codex, fallback, legacy, memorySession, policySession])
const restored = store.load()
assert.deepEqual(restored.find(s => s.id === fallback.id)!.promptContext, JSON.parse(JSON.stringify(fallback.promptContext)))
configureAssistantContextRuntime(id => restored.find(s => s.id === id), () => {})
assert.equal((await prepareAssistantMessage(fallback.id, fallback.config, '重启后继续', '固定规则', false)).text, '重启后继续')
const restoredPolicy = restored.find(s => s.id === policySession.id)!
assert.ok(restoredPolicy, 'the persisted policy fixture keeps its valid project/worktree binding')
policyMemory = '重启后的最新记忆'
await prepareAssistantInitialization(restoredPolicy)
assert.equal(policyReads, 3, 'restart with the same policy reuses persisted rules and frozen assistant memory')
assert.doesNotMatch(assistantInitialization(restoredPolicy.id), /重启后的最新记忆/)
restoredPolicy.config.worktree = { ...restoredPolicy.config.worktree!, autoSyncBack: true }
await prepareAssistantInitialization(restoredPolicy)
assert.equal(policyReads, 4, 'a policy change after restart invalidates the persisted binding')
assert.match(sessionInstructions(restoredPolicy.config, restoredPolicy.id), /提交后由你合并回本机源分支/)
assert.match(assistantInitialization(restoredPolicy.id), /重启后的最新记忆/)
await prepareAssistantInitialization(restoredPolicy); assert.equal(policyReads, 4)
policyMemory = '源绑定变更后的记忆'
restoredPolicy.config.worktree = { ...restoredPolicy.config.worktree, baseRef: 'refs/heads/release', sourcePrimaryDirectory: '/source-release' }
await prepareAssistantInitialization(restoredPolicy)
assert.equal(policyReads, 5, 'changed source instructions invalidate the binding even when the tree ID and merge switch stay the same')
assert.match(sessionInstructions(restoredPolicy.config, restoredPolicy.id), /源分支：release；源目录："\/source-release"/)
assert.match(assistantInitialization(restoredPolicy.id), /源绑定变更后的记忆/)
await prepareAssistantInitialization(restoredPolicy); assert.equal(policyReads, 5)
assert.ok(writes > 0)
configureProjectContext(undefined)
configureAssistantContext(undefined)
configureAssistantContextRuntime(() => undefined, () => {})
console.log('PASS system/user separation, controls, channel receipts, fallback delivery, frozen memory, compaction and restart')
