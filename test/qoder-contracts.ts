import assert from 'node:assert/strict'
import { initializeQoderQuery, projectQoderModels, qoderAuth, qoderDaemonRequest, qoderLaunch, qoderPermission, qoderRegionForBin, qoderToolCall } from '../src/main/qoderSdk.ts'
import { qoderConfigRoot } from '../src/main/qoderPaths.ts'
import { projectQoderMcpCandidate } from '../src/main/qoderNativeCapabilities.ts'
import { QoderRunner, qoderUsage, projectQoderGoal, qoderReviewInput } from '../src/main/qoderRunner.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionConfig, UAEvent } from '../src/shared/types.ts'
import { snapshotFileChange } from '../src/main/turnFileChanges.ts'
import { reverseApplyToBefore } from '../src/main/turnArtifacts.ts'

const accountCalls: unknown[] = []
const daemon = {
  getModels: async (options: unknown) => { accountCalls.push(options); return ['model'] },
  getByokConfig: async () => ['provider'],
  listByokConfigs: async () => [],
  checkByokConfig: async (input: unknown) => input
} as any
assert.deepEqual(await qoderDaemonRequest(daemon, 'models'), ['model'])
assert.deepEqual(accountCalls, [{ fetchStrategy: 'live' }])
assert.deepEqual(await qoderDaemonRequest(daemon, 'byok.providers'), ['provider'])
assert.deepEqual(await qoderDaemonRequest(daemon, 'byok.list'), [])
assert.deepEqual(await qoderDaemonRequest(daemon, 'byok.check', { id: 'config' }), { id: 'config' })
await assert.rejects(qoderDaemonRequest(daemon, 'unknown'), /不支持/)
const initializationCalls: unknown[] = []
let selectedModel: string | undefined
const query = {
  initializationResult: async () => { initializationCalls.push('initialize'); return { capabilities: ['goal_v1'] } },
  setModel: async (model: string) => { initializationCalls.push(['setModel', model]); selectedModel = model },
  mcpServerStatus: async () => [
    { name: 'external', status: 'connected', config: { command: 'native-server' } },
    { name: 'disabled', status: 'disabled', config: { command: 'disabled-server' } },
    { name: 'sdk', status: 'connected', config: { type: 'sdk', name: 'embedded' } }
  ],
  setMcpServers: async (servers: unknown) => { initializationCalls.push(['mcp', servers]) }
} as any
assert.deepEqual(await initializeQoderQuery(query, 'qfmodel', { uniagent: { command: 'host-server' } }), { capabilities: ['goal_v1'] })
assert.equal(selectedModel, 'qfmodel', 'native model must be applied before SDK readiness is published')
assert.deepEqual(initializationCalls, ['initialize', ['setModel', 'qfmodel'], ['mcp', {
  external: { command: 'native-server' }, uniagent: { command: 'host-server' }
}]], 'initialization reconnects native and injected MCP services after applying the model without enabling disabled or embedded services')
const strictCalls: unknown[] = []
await initializeQoderQuery({ ...query, mcpServerStatus: async () => { throw new Error('strict initialization must not import native MCP connections') }, setMcpServers: async servers => { strictCalls.push(servers) } }, undefined, { router: { command: 'router-server' } }, true)
assert.deepEqual(strictCalls, [{ router: { command: 'router-server' } }])
await assert.rejects(initializeQoderQuery({ ...query, setMcpServers: undefined }, 'qfmodel'), /初始化后连接/, 'a missing SDK initialization method stops readiness instead of silently losing MCP questions')
assert.deepEqual(qoderToolCall('mcp_call', { toolName: 'mcp__fixture__form_elicit' }), { name: 'mcp__fixture__form_elicit', input: {} }, 'native MCP arguments may be omitted for parameterless tools')
const authSdk = { DEFAULT_ACCESS_TOKEN_ENV_VAR: 'CN_PAT', accessToken: (token: string) => ({ token }), qodercliAuth: () => ({ native: true }) } as any
assert.deepEqual(qoderAuth(authSdk, { CN_PAT: 'fixture-only' }), { token: 'fixture-only' }, 'explicit worker credentials must be used')
assert.deepEqual(qoderAuth(authSdk, {}), { native: true })
assert.equal(qoderConfigRoot('cn', '/home', {}), '/home/.qoder-cn')
assert.equal(qoderConfigRoot('cn', '/home', { QODERCN_CLI_HOME: '/shared' }), '/shared/.qoder-cn')
assert.equal(qoderConfigRoot('cn', '/home', { QODERCN_CLI_HOME: '/shared', QODERCN_CONFIG_DIR: '/custom' }), '/custom')
assert.equal(qoderConfigRoot('global', '/home', { QODER_CONFIG_DIR: '/global', QODERCN_CONFIG_DIR: '/cn' }), '/global')
assert.deepEqual(projectQoderMcpCandidate({ name: 'fixture', status: 'connected', tools: [{ name: 'proof' }] }),
  { id: 'mcp:fixture', kind: 'mcp', name: 'fixture', authStatus: 'unknown', startupStatus: 'ready', toolNames: ['proof'] })
assert.equal(projectQoderMcpCandidate({ name: 'fixture', status: 'needs-auth' }).authStatus, 'notLoggedIn')

assert.equal(qoderRegionForBin('/home/a/.qoder-cn/bin/qoderclicn/qoderclicn-1.1.85'), 'cn')
assert.equal(qoderRegionForBin('/home/a/.local/bin/qodercli'), 'global')
assert.equal(qoderPermission('ask'), 'default')
assert.equal(qoderPermission('auto-edit'), 'acceptEdits')
assert.equal(qoderPermission('full-access'), 'bypassPermissions')
assert.throws(() => qoderPermission('read-only'), /OS/)
assert.throws(() => qoderPermission(undefined), /OS/)
const models = projectQoderModels([{ value: 'vision', displayName: 'Vision', description: '', isVl: true,
  thinking_config: { disabled: {}, enabled: { efforts: { low: {}, high: { is_default: true } } } },
  context_config: { '200K': { token_count: 200000, is_default: true }, '1M': { token_count: 1000000 } } },
  { value: 'disabled', displayName: '', description: '', isEnabled: false }])
assert.equal(models.length, 1)
assert.equal(models[0].defaultEffort, 'high')
assert.equal(models[0].contextWindow, 200000)
assert.equal(models[0].supportsFast, undefined)
assert.equal(models[0].supportsMax, undefined)
assert.deepEqual(models[0].qoderContextWindows, [200000, 1000000])
const config: SessionConfig = { agentId: 'qoder', workdir: '/repo', permissionMode: 'ask', collaborationMode: 'plan',
  roleSnapshot: { id: 'r', name: 'r', agentId: 'qoder', instructions: 'review', skills: [], toolPolicy: { mode: 'allow-only', tools: ['Read'] } } }
const launch = qoderLaunch('/home/.local/bin/qoderclicn', config, 'instructions', { uniagent: { command: 'host-server' } }, 'resume')
assert.equal(launch.region, 'cn')
assert.equal(launch.options.planMode, true)
assert.equal(launch.options.permissionMode, 'default', 'plan does not overwrite tool permissions')
assert.deepEqual(launch.options.tools, ['Read'])
assert.equal(launch.options.allowedTools, undefined, 'preapproval is not a tool allowlist')
assert.deepEqual(launch.options.skills, [])
assert.equal(launch.options.resume, 'resume')
assert.deepEqual(launch.options.mcpServers, { uniagent: { command: 'host-server' } }, 'injected MCP servers travel through public startup options')
const reviewLaunch = qoderLaunch('/qoderclicn', config, 'review', { external: { command: 'node' } }, undefined, {}, true)
assert.deepEqual(reviewLaunch.options.tools, ['Read'])
assert.deepEqual(reviewLaunch.options.skills, [])
assert.deepEqual(reviewLaunch.options.mcpServers, {})
assert.deepEqual(reviewLaunch.options.settingSources, [])
assert.equal((reviewLaunch.options.settings as any).disableAllHooks, true)
const usage = qoderUsage({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 }, total_credits: 7 }, 'm', 4)!
assert.equal(usage.inputTokens, 33)
assert.equal(usage.credits, 3)
assert.equal(usage.cost, undefined)
assert.equal(usage.contextTokens, undefined, 'occupancy percentages cannot become exact token counts')
assert.equal(qoderUsage({ total_credits: 7 }), undefined)
assert.equal(qoderUsage({ usage: {}, total_credits: 7 }, 'm')!.credits, undefined, 'resumed cumulative credits cannot be billed as this turn')
const goal = projectQoderGoal({ objective: 'review', status: 'budget_limited', turns_used: 2, max_turns: 5, credits_budget: 20, credits_used: 22, created_at: 1, updated_at: 2 })!
assert.equal(goal.status, 'budgetLimited')
assert.equal(goal.tokenBudget, null)
assert.equal(goal.creditsBudget, 20)
assert.deepEqual(goal.roundLimit, { maxRounds: 5, roundsStarted: 2 })
assert.throws(() => projectQoderGoal({ objective: 'x', status: 'unknown' }), /状态/)
const budgetRunner = new QoderRunner('budget-fixture', { n: 0 })
let budgetState: any
budgetRunner.on('goalChanged', value => { budgetState = value })
budgetRunner.configureClaudeGoal({ ...goal, status: 'active', tokenBudget: 100, continuation: 'native' })
budgetRunner.acceptMessage({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 }, total_credits: 1 })
assert.equal(budgetState.status, 'blocked')
assert.equal(budgetState.blockedReason.code, 'token_usage_unavailable')
budgetRunner.acceptMessage({ type: 'system', subtype: 'goal_updated', goal: { objective: 'review', status: 'blocked', turns_used: 1, created_at: 1, updated_at: 3 } })
assert.equal(budgetState.blockedReason.code, 'token_usage_unavailable', 'native goal updates retain the host budget failure reason')
budgetRunner.acceptMessage({ type: 'system', subtype: 'goal_cleared' })
assert.equal(budgetState?.blockedReason?.code, 'token_usage_unavailable', 'late native clearing cannot erase the host budget stop')
const activation = new QoderRunner('budget-activation', { n: 0 }) as any
const activationCalls: string[] = []
activation.initialize = async () => { activationCalls.push('initialize') }
activation.control = async (method: string) => { activationCalls.push(method); return { objective: 'review', status: 'active' } }
const blockedActivation = await activation.activateGoal({ id: 'qoder' }, { agentId: 'qoder', workdir: '/repo' }, { ...goal, tokenBudget: 100 })
assert.equal(blockedActivation.status, 'blocked', 'unknown native counters must block before autonomous Goal activation')
assert.equal(blockedActivation.blockedReason.code, 'token_usage_unavailable')
assert.deepEqual(activationCalls, [], 'a new budget Goal cannot open a native runtime or submit paid work')
activation.sdk = { request: async (method: string, args: any) => { activationCalls.push(method); return method === 'getGoal' ? { status: 'active' } : undefined } }
await activation.activateGoal({ id: 'qoder' }, { agentId: 'qoder', workdir: '/repo' }, { ...goal, tokenBudget: 100 }, 'native', true)
assert.deepEqual(activationCalls, ['getGoal', 'setGoal', 'interrupt'], 'editing/resuming a budget stops an existing native Goal without reactivating it')
const runner = new QoderRunner('qoder-fixture', { n: 0 })
const events: UAEvent[] = []
runner.on('event', value => events.push(value))
runner.acceptMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'query', name: 'mcp_call', input: { toolName: 'mcp__uniagent__uniagent_query', arguments: { action: 'list', type: 'agent' } } }] } })
assert.deepEqual(events.at(-1)?.payload.input, { action: 'list', type: 'agent' })
assert.equal(events.at(-1)?.payload.name, 'mcp__uniagent__uniagent_query')
events.length = 0
runner.acceptMessage({ type: 'tool_progress', tool_name: 'Read', tool_use_id: 'read', output: 'reading' })
runner.acceptMessage({ type: 'tool_progress', tool_name: 'Bash', tool_use_id: 'child-bash', parent_tool_use_id: 'agent', output: 'child output' })
assert.equal(events.length, 0, 'non-command and child progress cannot create main command cards')
runner.acceptMessage({ type: 'system', subtype: 'init', session_id: 'native', model: 'm' })
runner.acceptMessage({ type: 'assistant', message: { id: 'reply', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'pwd' } }] } })
runner.acceptMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: '/repo', is_error: false }] } })
runner.acceptMessage({ type: 'system', subtype: 'task_started', task_id: 'child', tool_use_id: 'agent', description: 'Read files' })
runner.acceptMessage({ type: 'user', tool_use_result: { agentId: 'native-child' }, message: { content: [{ type: 'tool_result', tool_use_id: 'agent', content: 'child done' }] } })
assert.ok(events.some(event => event.type === 'subagent' && event.payload.agents[0].nativeHistoryId === 'native-child'))
runner.acceptMessage({ type: 'assistant', parent_tool_use_id: 'agent', message: { id: 'child-msg', content: [{ type: 'text', text: 'Child result' }] } })
runner.acceptMessage({ type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed', summary: 'done' })
runner.acceptMessage({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } })
assert.equal(events.find(e => e.type === 'turn_started')?.payload.sessionId, 'native')
assert.ok(events.some(e => e.type === 'command_exec' && e.state === 'success' && e.payload.output === '/repo'))
assert.equal(events.some(e => e.type === 'agent_message' && e.payload.text === 'Child result'), false)
assert.equal(runner.getSubAgentItems('child').find(e => e.type === 'agent_message')?.payload.text, 'Child result')
assert.ok(events.some(e => e.type === 'subagent' && e.payload.agents[0].status === 'completed'))

// Minimal sanitized 1.1.91 native frames: Agent receipts arrive without task_started,
// and later notifications use another task_id but the same output file.
const receiptRunner = new QoderRunner('qoder-native-receipts', { n: 0 })
const receiptEvents: UAEvent[] = []
receiptRunner.on('event', event => receiptEvents.push(event))
const child = (id: string) => receiptEvents.filter(event => event.type === 'subagent').flatMap(event => event.payload.agents).filter(agent => agent.agentThreadId === id).at(-1)
receiptRunner.acceptMessage({ type: 'system', subtype: 'init', session_id: 'native-parent', model: 'qfmodel' })
receiptRunner.acceptMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'foreground-call', name: 'Agent', input: {
  description: 'Read workspace', subagent_type: 'fixture-reader', prompt: 'Read files and return CHILD_CN_OK'
} }] } })
receiptRunner.acceptMessage({ type: 'assistant', parent_tool_use_id: 'foreground-call', message: { id: 'early-child', content: [{ type: 'text', text: 'CHILD_CN_OK' }] } })
const foregroundReceipt = { type: 'user', tool_use_result: { kind: 'agent-result', agentId: 'native-reader', agentType: 'fixture-reader',
  content: 'CHILD_CN_OK', state: 'completed', terminateReason: 'GOAL', outputPath: '/fixture/reader.output', transcriptPath: '/fixture/reader.jsonl' },
  message: { content: [{ type: 'tool_result', tool_use_id: 'foreground-call', content: 'CHILD_CN_OK' }] } }
receiptRunner.acceptMessage(foregroundReceipt)
assert.equal(child('native-reader')?.nativeHistoryId, 'native-reader', 'foreground completion receipts must expose the actual native child history')
assert.equal(child('native-reader')?.status, 'completed')
assert.equal(child('native-reader')?.dispatchId, 'foreground-call')
assert.equal(child('native-reader')?.parentThreadId, 'native-parent')
assert.equal(child('native-reader')?.tool, 'fixture-reader')
assert.equal(child('native-reader')?.name, 'Read workspace')
assert.equal(child('native-reader')?.prompt, 'Read files and return CHILD_CN_OK')
assert.equal(receiptRunner.getSubAgentItems('native-reader').find(event => event.type === 'agent_message')?.payload.text, 'CHILD_CN_OK', 'early streamed child frames must migrate from the actual tool-use identity')
assert.equal(receiptEvents.some(event => event.type === 'agent_message' && event.payload.text === 'CHILD_CN_OK'), false)
receiptRunner.acceptMessage(foregroundReceipt)
assert.equal(new Set(receiptEvents.filter(event => event.type === 'subagent').map(event => event.payload.agents[0].agentThreadId)).size, 1, 'replayed receipts cannot create duplicate child cards')

receiptRunner.acceptMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'background-call', name: 'Agent', input: {
  description: 'Run background reader', subagent_type: 'general-purpose', prompt: 'Read in the child', run_in_background: true
} }] } })
receiptRunner.acceptMessage({ type: 'user', tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'native-background',
  description: 'Run background reader', prompt: 'Read in the child', outputFile: '/fixture/background.output' },
  message: { content: [{ type: 'tool_result', tool_use_id: 'background-call', content: 'Background agent launched' }] } })
assert.equal(child('native-background')?.nativeHistoryId, 'native-background')
assert.equal(child('native-background')?.status, 'running')
assert.equal(child('native-background')?.endedAt, undefined, 'launch receipts do not prove completion')
receiptRunner.acceptMessage({ type: 'assistant', parent_tool_use_id: 'background-call', message: { id: 'background-child', content: [{ type: 'text', text: 'child progress' }] } })
assert.equal(receiptRunner.getSubAgentItems('native-background').find(event => event.type === 'agent_message')?.payload.text, 'child progress')
receiptRunner.acceptMessage({ type: 'system', subtype: 'task_notification', task_id: 'unrelated-task', output_file: '/fixture/other.output', status: 'completed', summary: 'Run background reader' })
assert.equal(child('native-background')?.status, 'running', 'an unrelated Task notification cannot complete the Agent')
receiptRunner.acceptMessage({ type: 'system', subtype: 'task_notification', task_id: 'native-control-task', output_file: '/fixture/background.output', status: 'stopped', summary: 'Run background reader' })
assert.equal(child('native-background')?.status, 'interrupted', 'the exact native output file associates the stopped notification with its real Agent')
assert.equal(child('native-control-task'), undefined, 'the different notification identity cannot create a duplicate child')
receiptRunner.acceptMessage({ type: 'user', tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'native-background', outputFile: '/fixture/background.output' },
  message: { content: [{ type: 'tool_result', tool_use_id: 'background-call', content: 'Background agent launched' }] } })
assert.equal(child('native-background')?.status, 'interrupted', 'replaying the launch receipt cannot reopen a stopped child')
receiptRunner.acceptMessage({ type: 'assistant', parent_tool_use_id: 'background-call', message: { content: [{ type: 'tool_use', id: 'nested-call', name: 'Agent', input: { description: 'Nested reader', subagent_type: 'fixture-reader' } }] } })
receiptRunner.acceptMessage({ type: 'user', parent_tool_use_id: 'background-call', tool_use_result: { kind: 'agent-result', agentId: 'native-nested', agentType: 'fixture-reader', state: 'completed', content: 'Nested result' },
  message: { content: [{ type: 'tool_result', tool_use_id: 'nested-call', content: 'Nested result' }] } })
assert.equal(child('native-nested')?.parentThreadId, 'native-background', 'native parent tool-use metadata preserves nested Agent lineage')
for (const [state, expected] of [['running', 'running'], ['error', 'errored'], ['cancelled', 'interrupted']] as const) {
  receiptRunner.acceptMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: state + '-call', name: 'Agent', input: { description: state, subagent_type: 'fixture-reader' } }] } })
  receiptRunner.acceptMessage({ type: 'user', tool_use_result: { kind: 'agent-result', agentId: 'native-' + state, agentType: 'fixture-reader', state, content: state },
    message: { content: [{ type: 'tool_result', tool_use_id: state + '-call', content: state }] } })
  assert.equal(child('native-' + state)?.status, expected, 'completion receipts preserve their actual failure or cancellation state')
}
for (const state of ['constructor', 'toString', '__proto__', 'unknown']) {
  const malformedRunner = new QoderRunner('qoder-malformed-' + state, { n: 0 })
  const malformedEvents: UAEvent[] = []
  malformedRunner.on('event', event => malformedEvents.push(event))
  malformedRunner.acceptMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'malformed-call', name: 'Agent', input: { description: 'Reader', subagent_type: 'fixture-reader' } }] } })
  malformedRunner.acceptMessage({ type: 'user', tool_use_result: { kind: 'agent-result', agentId: 'malformed-child', agentType: 'fixture-reader', state, content: 'Invalid native state' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'malformed-call', content: 'Invalid native state' }] } })
  assert.equal(malformedEvents.filter(event => event.type === 'subagent').length, 0, `${state} is not a native Agent state and must not invent a running child or history identity`)
}

const legacyReceiptRunner = new QoderRunner('qoder-legacy-receipts', { n: 0 })
const legacyEvents: UAEvent[] = []
legacyReceiptRunner.on('event', event => legacyEvents.push(event))
legacyReceiptRunner.acceptMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'foreground-call', name: 'Agent', input: { description: 'Read files', subagent_type: 'fixture-reader' } }] } })
legacyReceiptRunner.acceptMessage({ type: 'system', subtype: 'task_started', task_id: 'legacy-task', tool_use_id: 'foreground-call', description: 'Read files' })
legacyReceiptRunner.acceptMessage(foregroundReceipt)
assert.deepEqual([...new Set(legacyEvents.filter(event => event.type === 'subagent').map(event => event.payload.agents[0].agentThreadId))], ['legacy-task'])
assert.equal(legacyEvents.filter(event => event.type === 'subagent').at(-1)?.payload.agents[0].nativeHistoryId, 'native-reader')
const beforeUnknownReceipt = receiptEvents.filter(event => event.type === 'subagent').length
receiptRunner.acceptMessage({ type: 'user', tool_use_result: foregroundReceipt.tool_use_result, message: { content: [{ type: 'tool_result', tool_use_id: 'unknown-call', content: 'CHILD_CN_OK' }] } })
assert.equal(receiptEvents.filter(event => event.type === 'subagent').length, beforeUnknownReceipt, 'unassociated receipts cannot invent Agent lineage')
await assert.rejects(runner.steer(), /严格/)
const before = 'one\ntwo\n'
const after = 'one\nthree\n'
const change = await snapshotFileChange('example.txt', before, after)
assert.ok(change?.diff?.includes('-two\n+three\n'))
assert.equal(reverseApplyToBefore(after, change!.diff!), before)
assert.equal(await snapshotFileChange('example.txt', before, before), undefined)
assert.deepEqual(await snapshotFileChange('new.txt', undefined, 'no newline'), { path: 'new.txt', kind: 'add', diff: 'no newline' })
const repo = await mkdtemp(join(tmpdir(), 'qoder-review-'))
try {
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim()
  await git('init', '-b', 'main')
  await writeFile(join(repo, 'tracked.txt'), 'before\n')
  await git('add', 'tracked.txt')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base')
  await git('branch', 'base')
  await writeFile(join(repo, 'tracked.txt'), 'committed\n')
  await git('add', 'tracked.txt')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'change')
  const sha = await git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'tracked.txt'), 'staged\n')
  await git('add', 'tracked.txt')
  await writeFile(join(repo, 'tracked.txt'), 'unstaged\n')
  await writeFile(join(repo, 'new.txt'), 'untracked\n')
  const local = await qoderReviewInput({ scope: { type: 'uncommittedChanges' } }, repo)
  assert.match(local, /\+unstaged/)
  assert.match(local, /\+untracked/)
  const commit = await qoderReviewInput({ scope: { type: 'commit', sha } }, repo)
  assert.match(commit, /\+committed/)
  assert.doesNotMatch(commit, /\+unstaged/)
  assert.match(await qoderReviewInput({ scope: { type: 'baseBranch', branch: 'base' } }, repo), /\+committed/)
  await assert.rejects(qoderReviewInput({ scope: { type: 'baseBranch', branch: '--output=file' } }, repo), /无效/)
  await assert.rejects(qoderReviewInput({ scope: { type: 'custom' } }, repo), /填写/)
  assert.match(await qoderReviewInput({ scope: { type: 'custom' }, instructions: 'check nulls' }, repo), /check nulls/)
} finally { await rm(repo, { recursive: true, force: true }) }
console.log('Qoder contracts passed')
