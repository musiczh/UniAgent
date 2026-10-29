import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { KimiWebRuntime, projectKimiWebGoal } from '../src/main/kimiWebRuntime.ts'
import { KimiWebRunner } from '../src/main/kimiWebRunner.ts'
import { forkKimiWebSession, listKimiWebSessions } from '../src/main/kimiHistory.ts'
import { probeKimiWeb } from '../src/main/kimiWebContract.ts'
import { acquireKimiWebService, closeKimiWebServices } from '../src/main/kimiWebService.ts'
import { inspectACPProcess, signalACPProcess, type ProcessIdentity } from '../src/main/acp/acpProcessLifecycle.ts'

if (process.env.UNIAGENT_KIMI_WEB_NATIVE_TEST !== '1') throw new Error('set UNIAGENT_KIMI_WEB_NATIVE_TEST=1 for isolated installed Kimi verification')
const root = mkdtempSync(join(tmpdir(), 'uniagent-kimi-web-native-'))
const source = join(root, 'source'), workdir = join(root, 'project'), osHome = join(root, 'os-home'), extra = join(root, 'extra')
for (const directory of [source, workdir, osHome, extra]) mkdirSync(directory)
let mode = 'hold'
let requests = 0
let lastRequest: any
const modelServer = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw); requests++; lastRequest = body
  res.setHeader('Content-Type', 'text/event-stream')
  const send = (delta: any, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
  send({ role: 'assistant' })
  const finalMessage = body.messages.at(-1)
  const childRequest = body.messages.some((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('Child task hold marker'))
  if (mode === 'hold' || childRequest) {
    send({ content: 'Holding stream. ' })
    const timer = setInterval(() => send({ content: 'h' }), 100)
    res.on('close', () => clearInterval(timer))
    return
  }
  if (mode === 'subagent' && finalMessage?.role === 'user') {
    send({ tool_calls: [{ index: 0, id: 'spawn-call', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'Fixture owned child', prompt: 'Child task hold marker', run_in_background: true }) } }] })
    send({}, 'tool_calls')
  } else if (mode === 'approval') {
    send({ tool_calls: [{ index: 0, id: 'write-call', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: join(workdir, 'must-not-write.txt'), content: 'denied write' }) } }] })
    send({}, 'tool_calls')
  } else if (mode === 'question') {
    send({ tool_calls: [{ index: 0, id: 'question-call', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ question: 'Choose?', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] }] }) } }] })
    send({}, 'tool_calls')
  } else if (mode === 'complete' && finalMessage?.role !== 'tool') {
    send({ tool_calls: [{ index: 0, id: 'complete-call', type: 'function', function: { name: 'UpdateGoal', arguments: JSON.stringify({ status: 'complete' }) } }] })
    send({}, 'tool_calls')
  } else { send({ content: 'Done' }); send({}, 'stop') }
  res.write('data: ' + JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + '\n\n')
  res.end('data: [DONE]\n\n')
})
await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
const port = (modelServer.address() as { port: number }).port
writeFileSync(join(source, 'config.toml'), `default_model = "local"\n[models.local]\nprovider = "local"\nname = "fixture"\nmax_context_size = 8192\n[providers.local]\ntype = "openai"\nbase_url = "http://127.0.0.1:${port}/v1"\napi_key = "fake-fixture-key"\n`)
writeFileSync(join(source, 'mcp.json'), '{"mcpServers":{}}')
writeFileSync(join(source, 'device_id'), 'uniagent-isolated-web-test')
let runtime: KimiWebRuntime | undefined
let runner: KimiWebRunner | undefined
let sibling: KimiWebRuntime | undefined
let stoppedService: ProcessIdentity | undefined
async function ownedService(): Promise<ProcessIdentity> {
  for (const file of await readdir(join(source, 'server/instances'))) {
    const record = JSON.parse(readFileSync(join(source, 'server/instances', file), 'utf8'))
    const inspected = await inspectACPProcess(record.pid)
    if (inspected.ok && inspected.process?.ppid === process.pid && inspected.process.uid === process.getuid?.()) return inspected.process
  }
  throw new Error('fault injection requires the isolated service started by this test')
}
const saved = { HOME: process.env.HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, UNIAGENT_USER_DATA: process.env.UNIAGENT_USER_DATA }
let released = 0
const frames: any[] = []
const snapshots: any[] = []
const until = async <T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> => {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error('native verification timeout: ' + label)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
try {
  process.env.HOME = osHome; process.env.KIMI_CODE_HOME = source; process.env.UNIAGENT_USER_DATA = join(root, 'userdata')
  const options = {
    bin: process.env.UNIAGENT_KIMI_TEST_BIN || '/opt/homebrew/bin/kimi', sessionId: 'native-web',
    config: { agentId: 'kimi', workdir, model: 'local', permissionMode: 'ask' as const },
    env: { HOME: osHome, KIMI_CODE_HOME: source, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_DATA_HOME: join(root, 'xdg-data'), UNIAGENT_USER_DATA: join(root, 'userdata') },
    timeoutMs: 20_000, acquireWritableRuntime: async () => () => { released++ }
  }
  runtime = await KimiWebRuntime.start(options)
  await runtime.setProfile({ plan_mode: true })
  assert.equal((await runtime.status()).plan_mode, true, 'the installed CLI must enter native Plan')
  await runtime.setProfile({ plan_mode: false })
  assert.equal((await runtime.status()).plan_mode, false, 'the installed CLI must leave native Plan')
  assert.equal((await probeKimiWeb(options.bin, workdir, options.env)).status, 'ready')
  const sessionId = runtime.nativeSessionId
  await runtime.subscribe({ onEvent(frame) { frames.push(frame) }, onSnapshot(snapshot) { snapshots.push(snapshot) }, onError(error) { throw error } })
  assert.equal(await runtime.getGoal(), null)
  const goal = await runtime.createGoal({ objective: 'Perform fixture goal' })
  assert.equal(goal?.status, 'active'); assert.equal(goal?.budget.tokenBudget, null)
  assert.equal(projectKimiWebGoal(goal, { createdAt: 1, updatedAt: 2 })?.continuation, 'native')
  const starter = await runtime.submitPrompt('start held fixture')
  await until(async () => requests, n => n > 0, 'model request')
  const tools = lastRequest.tools.map((tool: any) => tool.function.name)
  assert.ok(tools.includes('Read') && tools.includes('Write'))
  const steering = await runtime.steer('Native steer marker')
  assert.equal(steering.steered, true)
  await until(async () => frames, list => list.some(frame => frame.type === 'prompt.steered'), 'steer event')
  assert.equal((await runtime.controlGoal('pause'))?.status, 'paused')
  assert.equal((await runtime.controlGoal('resume'))?.status, 'active')
  assert.equal(await runtime.controlGoal('cancel'), null)
  await until(async () => { if ((await runtime!.status()).busy) await runtime!.abortSession(); return runtime!.status() }, state => !state.busy, 'Goal cancellation finishes')
  assert.ok(frames.some(frame => frame.type === 'assistant.delta'))
  assert.ok(frames.some(frame => frame.type === 'turn.ended' && frame.payload.reason === 'cancelled'))
  mode = 'approval'
  await runtime.submitPrompt('Request denied write')
  const approvalRows = await until(() => runtime!.pendingApprovals(), value => value.items.length > 0, 'approval')
  const approval = approvalRows.items[0]
  mode = 'done'
  await runtime.resolveApproval(approval.approval_id, { decision: 'rejected', feedback: 'native denied' })
  await until(() => runtime!.status(), state => !state.busy, 'approval turn completion')
  assert.ok(frames.some(frame => frame.type === 'event.approval.requested' || frame.type === 'interaction' && frame.kind === 'approval' && frame.status === 'pending'))
  assert.throws(() => readFileSync(join(workdir, 'must-not-write.txt')), /ENOENT/)
  mode = 'question'
  await runtime.submitPrompt('Ask native question')
  const questions = await until(() => runtime!.pendingQuestions(), value => value.items.length > 0, 'question')
  const question = questions.items[0]
  mode = 'done'
  await runtime.answerQuestion(question.question_id, { [question.questions[0].id]: { kind: 'single', option_id: question.questions[0].options[0].id } })
  await until(() => runtime!.status(), state => !state.busy, 'question completion')
  assert.ok(frames.some(frame => frame.type === 'event.question.requested' || frame.type === 'interaction' && frame.kind === 'question' && frame.status === 'pending'))
  const snapshot = await runtime.snapshot()
  assert.ok(typeof snapshot.epoch === 'string')
  assert.equal((snapshot.session as any).id, sessionId)
  const fork = await forkKimiWebSession(sessionId, options.bin, workdir, options.env)
  assert.notEqual(fork.nativeId, sessionId)
  assert.ok((await listKimiWebSessions(options.bin, workdir, options.env)).some(row => row.id === fork.nativeId))
  await runtime.closeAndWait(); runtime = undefined
  assert.equal(released, 1)
  runtime = await KimiWebRuntime.start({ ...options, nativeSessionId: sessionId })
  assert.equal(runtime.nativeSessionId, sessionId)
  assert.ok((await runtime.snapshot() as any).messages.items.length > 0, 'native history survives runtime transfer')
  await runtime.closeAndWait(); runtime = undefined
  assert.equal(released, 2)
  const events: any[] = []
  runner = new KimiWebRunner('native-runner', { n: 0 }, { id: 'kimi', name: 'Kimi', bin: options.bin, adapter: 'kimi', icon: 'kimi', builtin: true, capabilities: { modelSelect: true, reasoningEffort: false, permissionModes: [], protocol: 'web' }, models: [] }, options.config, undefined, options.env)
  runner.on('event', event => events.push(event))
  mode = 'done'
  await runner.startTurn('ordinary web runner')
  assert.ok(events.some(event => event.type === 'agent_message' && event.payload.text === 'Done'))
  assert.equal(new Map(events.filter(event => event.type === 'agent_message').map(event => [event.payload.id, event.payload.text])).size, 1, 'stream and transcript must share one rendered message: ' + JSON.stringify(events.filter(event => ['agent_message', 'turn_started'].includes(event.type)).map(event => event.payload)))
  mode = 'approval'
  const approvalTurn = runner.startTurn('runner denied write')
  const pendingApproval: any = await until(async () => events.find(event => event.type === 'approval_request' && event.state === 'pending' && event.payload.kind === 'permission'), value => !!value, 'runner approval')
  mode = 'done'
  assert.equal((await runner.respondResult(pendingApproval.payload.requestId, { outcome: { outcome: 'selected', optionId: 'reject_once' } })).handled, true)
  await approvalTurn
  mode = 'question'
  const questionTurn = runner.startTurn('runner native question')
  const pendingQuestion: any = await until(async () => events.find(event => event.type === 'approval_request' && event.state === 'pending' && event.payload.kind === 'question'), value => !!value, 'runner question')
  mode = 'done'
  const first = pendingQuestion.payload.params.questions[0]
  assert.equal((await runner.respondResult(pendingQuestion.payload.requestId, { answers: { [first.id]: { answers: [first.options[0].label] } } })).handled, true)
  await questionTurn
  mode = 'hold'
  const goalRequests = requests
  assert.equal((await runner.setGoal({ objective: 'Native runner goal' })).status, 'active')
  await until(async () => requests, n => n > goalRequests, 'runner Goal starter')
  await runner.steer('Runner native steer')
  assert.equal((await runner.updateGoal({ action: 'pause' }))?.status, 'paused')
  assert.equal((await runner.updateGoal({ action: 'resume' }))?.status, 'active')
  assert.equal(await runner.updateGoal({ action: 'clear' }), undefined)
  runner.interrupt()
  await until(async () => events, list => list.some(event => event.type === 'turn_completed' && event.state === 'cancelled'), 'runner interrupt')
  const goalChanges: any[] = []
  runner.on('goalChanged', goal => goalChanges.push(goal))
  const runtimeFrames: any[] = []
  const nativeHandler = (runner as any).onFrame.bind(runner)
  ;(runner as any).onFrame = async (frame: any) => { runtimeFrames.push(frame); return nativeHandler(frame) }
  mode = 'complete'
  assert.equal((await runner.setGoal({ objective: 'Native completion verification' })).status, 'active')
  await until(async () => goalChanges, changes => changes.some(goal => goal?.status === 'complete'), 'confirmed native complete goal')
  await until(async () => runner!.isRunning(), running => !running, 'native completion terminal')
  assert.equal(await (runner as any).runtime.getGoal(), null, 'official completion clears current endpoint')
  assert.equal((await runner.getGoal())?.status, 'complete', 'host retains the native terminal snapshot')
  const updates = runtimeFrames.filter(frame => frame.type === 'goal.updated')
  const completeAt = updates.findIndex(frame => frame.payload.snapshot?.status === 'complete')
  assert.ok(completeAt >= 0 && updates.slice(completeAt + 1).some(frame => frame.payload.snapshot === null), 'native emits completion followed by automatic clear')
  assert.equal(await runner.updateGoal({ action: 'clear' }), undefined, 'explicit clear removes terminal history even when native current goal is absent')
  await runner.disposeAndWait(); runner = undefined
  mode = 'done'
  const ordinaryConfig = { agentId: 'kimi' as const, workdir, model: 'local', permissionMode: 'full-access' as const }
  await assert.rejects(KimiWebRuntime.start({ ...options, sessionId: 'rejected-dirs', config: { ...ordinaryConfig, additionalDirectories: [extra] } }))
  runtime = await KimiWebRuntime.start({ ...options, sessionId: 'parent', config: ordinaryConfig })
  mode = 'subagent'
  await runtime.submitPrompt('Spawn owned background child')
  const owned = await until(() => runtime!.listSubagentTasks(), rows => rows.some(row => row.status === 'running'), 'owned task registry')
  const child = owned.find(row => row.status === 'running')!
  assert.equal(child.session_id, runtime.nativeSessionId)
  assert.equal((await runtime.getSubagentTask(child.agent_id)).id, child.id)
  const detail = await until(() => runtime!.getSubagentTranscript(child.agent_id), rows => rows.some(row => row.type === 'agent_message' && row.payload.text?.length > 0), 'child transcript')
  assert.ok(detail.some(row => row.type === 'agent_message' && row.payload.text?.length > 0))
  await assert.rejects(runtime.getSubagentTask('foreign-child'), /subagent_not_owned/)
  await assert.rejects(runtime.cancelSubagentTask('foreign-child'), /subagent_not_owned/)
  mode = 'done'
  await runtime.cancelSubagentTask(child.agent_id)
  await until(() => runtime!.getSubagentTask(child.agent_id), task => task.status === 'cancelled', 'owned task cancellation')
  const parentId = runtime.nativeSessionId
  await runtime.closeAndWait(); runtime = undefined
  runtime = await KimiWebRuntime.start({ ...options, sessionId: 'dirs-a', config: ordinaryConfig, nativeSessionId: parentId })
  const cold = await runtime.getSubagentTranscript(child.agent_id, { nativeTaskId: child.id, parentNativeSessionId: parentId })
  assert.ok(cold.some(row => row.type === 'agent_message'), 'owned child transcript survives web restart without activating child')
  await runtime.closeAndWait(); runtime = undefined
  runtime = await KimiWebRuntime.start({ ...options, sessionId: 'recovery-durable', config: ordinaryConfig })
  await runtime.submitPrompt('Recovery history marker: reply Done')
  await until(() => runtime!.status(), status => !status.busy, 'recovery fixture completed turn')
  const durableId = runtime.nativeSessionId
  const durableTranscript = (await runtime.transcript()).items
  assert.ok(durableTranscript.length > 0)
  const originalConfig = readFileSync(join(source, 'config.toml'), 'utf8'), requestsBeforeRecovery = requests
  const service = await acquireKimiWebService({ bin: options.bin, cwd: workdir, env: options.env, timeoutMs: 20_000 })
  stoppedService = await ownedService()
  Object.defineProperty(service.transport, 'timeoutMs', { value: 250 })
  assert.ok(signalACPProcess(stoppedService, await inspectACPProcess(stoppedService.pid), 'SIGSTOP'))
  await assert.rejects(runtime.snapshot(), /request_aborted/)
  const gone = await inspectACPProcess(stoppedService.pid)
  assert.ok(gone.ok && !gone.process, 'automatic recovery must finish stopping the old native service')
  await runtime.closeAndWait(); runtime = undefined
  assert.equal((await probeKimiWeb(options.bin, workdir, options.env)).status, 'ready', 'replacement must pass actual REST and WebSocket protocol checks')
  runtime = await KimiWebRuntime.start({ ...options, sessionId: 'recovery-durable', nativeSessionId: durableId, config: ordinaryConfig })
  assert.equal(runtime.nativeSessionId, durableId)
  assert.deepEqual((await runtime.transcript()).items, durableTranscript, 'the actual native transcript must survive service replacement')
  assert.equal(readFileSync(join(source, 'config.toml'), 'utf8'), originalConfig)
  assert.equal(requests, requestsBeforeRecovery, 'service recovery must not send another model request')
  mode = 'hold'
  await runtime.submitPrompt('In-flight recovery marker')
  await until(async () => requests, n => n > requestsBeforeRecovery, 'in-flight recovery request')
  const inFlightRequests = requests
  const activeService = await acquireKimiWebService({ bin: options.bin, cwd: workdir, env: options.env, timeoutMs: 20_000 })
  Object.defineProperty(activeService.transport, 'timeoutMs', { value: 250 })
  stoppedService = await ownedService()
  assert.ok(signalACPProcess(stoppedService, await inspectACPProcess(stoppedService.pid), 'SIGSTOP'))
  await assert.rejects(runtime.snapshot(), /request_aborted/)
  await runtime.closeAndWait(); runtime = undefined
  mode = 'done'
  runtime = await KimiWebRuntime.start({ ...options, sessionId: 'recovery-durable', nativeSessionId: durableId, config: ordinaryConfig })
  assert.equal(runtime.nativeSessionId, durableId)
  const recoveredTurns = (await runtime.transcript()).items
  const recoveredHistory = JSON.stringify(recoveredTurns)
  for (const turn of durableTranscript) assert.deepEqual(recoveredTurns.find(row => row.turnId === turn.turnId), turn, 'completed native history must remain unchanged when an active turn is interrupted')
  const resumedStatus = await runtime.status(), resumedPrompts = await runtime.prompts()
  assert.equal(resumedStatus.busy, false)
  assert.equal(resumedPrompts.active, null)
  assert.equal(resumedPrompts.queued.length, 0)
  console.log('Native interrupted-turn verification:', JSON.stringify({ completedHistoryPreserved: true, interruptedTurnReturned: recoveredHistory.includes('In-flight recovery marker'), busy: resumedStatus.busy }))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(requests, inFlightRequests, 'recovering an interrupted native turn must not resend its input')
  await activeService.release()
  await runtime.closeAndWait(); runtime = undefined; await service.release()
  console.log('Native Kimi recovery: isolated unresponsive service replaced, protocol healthy, transcript/config preserved and no model request replay')
  console.log(JSON.stringify({ verified: ['official live OpenAPI/AsyncAPI', 'loopback bearer auth', 'unsupported directory configuration rejected', 'native goal create/get/pause/resume/cancel', 'native completion snapshot retained after automatic clear', 'active turn queued steer', 'manual approval rejection', 'native question answer', 'native history resume', 'owned child exit', 'owned subagent registry/detail/cancel/cold transcript'], requests, eventTypes: [...new Set(frames.map(frame => frame.type))] }))
} finally {
  if (stoppedService) signalACPProcess(stoppedService, await inspectACPProcess(stoppedService.pid), 'SIGCONT')
  await runtime?.abortSession().catch(() => {})
  await runtime?.closeAndWait()
  await sibling?.closeAndWait()
  runner?.interrupt()
  if (runner) await until(async () => runner!.isRunning(), running => !running, 'cleanup runner').catch(() => {})
  await runner?.disposeAndWait()
  await closeKimiWebServices()
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  modelServer.closeAllConnections()
  await new Promise<void>((resolve) => modelServer.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}
