import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { TeamService } from '../src/main/teamService.ts'
import { qoderUpdateVersions } from '../src/main/agentLifecycleService.ts'
import { QODER_REVIEW_MEMORY_OPTIONS, reviewCapability, sdkReviewToolAllowed } from '../src/main/assistant/reviewRuntime.ts'

assert.deepEqual(qoderUpdateVersions('Checking for updates...\nAlready at the latest version (1.1.85).'), { current: '1.1.85', latest: '1.1.85' })
assert.deepEqual(qoderUpdateVersions('Update available: 1.1.85 -> 1.1.86'), { current: '1.1.85', latest: '1.1.86' })
assert.deepEqual(qoderUpdateVersions('Update available: 1.1.86', '1.1.85'), { current: '1.1.85', latest: '1.1.86' })
assert.equal(qoderUpdateVersions('check failed'), undefined)
assert.deepEqual(reviewCapability({ adapter: 'qoder', installed: true }), { supported: true })
assert.equal(reviewCapability({ adapter: 'qoder', installed: true, incompatible: true }).supported, false)
assert.equal(sdkReviewToolAllowed('mcp_call', { toolName: 'mcp__uniagent__assistant_memory', arguments: { action: 'read' } }, true), true)
assert.equal(sdkReviewToolAllowed('mcp_get', { toolName: 'mcp__uniagent__session_search' }, true), true)
assert.equal(sdkReviewToolAllowed('mcp_call', { toolName: 'mcp__uniagent__uniagent_task', arguments: { action: 'create' } }, true), false)
assert.equal(sdkReviewToolAllowed('mcp_get', { toolName: 'mcp__external__send' }, true), false)
assert.equal(sdkReviewToolAllowed('Write', { file_path: 'memory.md' }, true), false)
assert.equal(sdkReviewToolAllowed('mcp_call', { toolName: 'mcp__uniagent__assistant_memory', arguments: {} }), false, 'Claude keeps its direct MCP tool contract')
for (const sdk of [await import('@qodercn-ai/qodercn-agent-sdk'), await import('@qoder-ai/qoder-agent-sdk')]) {
  // An absent fixture executable stops before any network/model call, after official option validation.
  let query: ReturnType<typeof sdk.query> | undefined
  try {
    await assert.rejects(async () => {
      query = sdk.query({ prompt: 'local configuration fixture', options: { ...QODER_REVIEW_MEMORY_OPTIONS,
        auth: sdk.accessToken('fixture-local-only'), pathToQoderCLIExecutable: '/fixture/uniagent-absent-qoder' } })
      await query.initializationResult()
    }, /Failed to spawn Qoder CLI daemon/, 'review options must pass the real CN and Global SDK validators')
  } finally { await query?.close() }
}
const { QoderRunner } = await import('../src/main/qoderRunner.ts')
const resourceRunner = new QoderRunner('resource-fixture', { n: 0 }) as any
const resourceAgent = { bin: '/fixture/qoderclicn', version: '1', adapter: 'qoder' } as any
const resourceConfig = { agentId: 'qoder', workdir: '/repo', permissionMode: 'ask' } as any
const { prepareAssistantInitializationForSession, assistantInitialization } = await import('../src/main/assistant/context.ts')
await prepareAssistantInitializationForSession('resource-fixture', resourceConfig)
const refreshCalls: string[] = []
resourceRunner.key = JSON.stringify([resourceAgent.bin, resourceAgent.version, resourceConfig, false, assistantInitialization('resource-fixture')])
resourceRunner.sdk = { ready: Promise.resolve({ skills: ['updated'] }), request: async (method: string) => { refreshCalls.push(method) } }
assert.deepEqual(await resourceRunner.initialize(resourceAgent, resourceConfig), { skills: ['updated'] })
assert.deepEqual(refreshCalls, ['reloadPlugins', 'reloadSkills'], 'reused native sessions refresh resources before another turn')

const root = await mkdtemp(join(tmpdir(), 'qoder-lifecycle-'))
const qoderAgent = { id: 'qoder', adapter: 'qoder', bin: '/fixture/qoderclicn', name: 'Qoder', capabilities: { permissionModes: [{ id: 'ask', label: 'Ask' }], sideChat: true }, models: [] } as any
const teamRole = { id: 'r', name: 'Qoder role', agentId: 'qoder', instructions: '', permissionMode: 'ask' }
assert.doesNotThrow(() => (TeamService.prototype as any).validateTeam.call({ agents: () => [qoderAgent] }, { leaderMemberId: 'leader', members: [{ id: 'leader', role: teamRole }, { id: 'member', role: teamRole }] }), 'Qoder supports the existing team MCP transport')
const orchestrator = new Orchestrator(id => id === 'qoder' ? qoderAgent : undefined, new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'))
let disposeCalled = false, release!: () => void
const disposed = new Promise<void>(resolve => { release = resolve })
const internals = orchestrator as any
const session = { id: 'qoder-state', title: 'Draft', status: 'idle', createdAt: 1, nativeSessionId: 'native-qoder', config: { agentId: 'qoder', workdir: root, permissionMode: 'ask' } }
internals.sessions.set(session.id, session)
internals.seqRefs.set(session.id, { n: 0 })
assert.equal(orchestrator.canOpenSideChat(session.id), true, 'a connected Qoder session can open the existing Side UI')
internals.detailStreamers.set(session.id, { removeAllListeners() {}, updateConfig() {}, nativeThreadId: () => 'detail-native-qoder', on() {} })
assert.equal(orchestrator.promoteDetailToSide(session.id), true)
assert.equal(internals.sideNativeSessionIds.get(session.id), 'detail-native-qoder', 'detail-to-Side promotion keeps its independent Qoder native identity')
internals.sideStreamers.clear()
const projected = internals.ensureTurnRunner(session, { id: 'qoder', adapter: 'qoder', bin: '/fixture/qoderclicn', name: 'Qoder', capabilities: { permissionModes: [] }, models: [] })
projected.acceptMessage({ type: 'system', subtype: 'session_title_changed', title: 'Native title' })
assert.equal(session.title, 'Native title')
projected.acceptMessage({ type: 'system', subtype: 'session_title_changed', title: 'Late title' })
assert.equal(session.title, 'Native title', 'native title events respect the locked title')
projected.acceptMessage({ type: 'system', subtype: 'plan_mode_changed', plan_mode: { active: true } })
assert.equal((session.config as any).collaborationMode, 'plan')
assert.equal(session.config.permissionMode, 'ask', 'Plan state does not replace the tool permission policy')
internals.sdkRunners.set('idle-qoder', { removeAllListeners() {}, disposeClaudeSdk() { disposeCalled = true; return disposed } })
try {
  orchestrator.disposeAll()
  assert.equal(disposeCalled, true, 'shutdown also closes idle SDK sessions absent from the active runner map')
  let closed = false
  const closing = orchestrator.closeSessionLogs().then(() => { closed = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(closed, false, 'shutdown waits for the SDK-owned daemon before closing logs')
  release(); await closing
  assert.equal(closed, true)
} finally { release(); await orchestrator.closeSessionLogs(); await rm(root, { recursive: true, force: true }) }
console.log('Qoder idle SDK shutdown and daemon cleanup passed')
