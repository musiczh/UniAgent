// Opt-in acceptance: current repository package + official CN CLI, isolated native state.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok((await realpath(binary)).startsWith(await realpath(resolve('release')) + '/'), 'only repository packaged App may be started')
const fixture = await mkdtemp(join(tmpdir(), 'uniagent-qoder-packaged-'))
const home = join(fixture, 'home'), data = join(fixture, 'data'), workdir = join(fixture, 'workspace')
const evidence = resolve('docs/qoder-integration-2026-11-09/verification')
const cli = await realpath(process.env.UNIAGENT_QODER_REAL_BIN || join(homedir(), '.local/bin/qoderclicn'))
const testModel = process.env.UNIAGENT_QODER_TEST_MODEL || 'qfmodel'
const remainingOnly = process.env.UNIAGENT_QODER_VERIFY_REMAINING === '1'
const previousChecks = []
let previousHistory = []
if (remainingOnly) for (const file of ['packaged-results.json', 'packaged-remaining-results.json']) {
  try {
    const report = JSON.parse(await readFile(join(evidence, file), 'utf8'))
    previousChecks.push(...report.checks, ...(report.previousPassed || []).map(id => ({ id, passed: true })))
    if (file === 'packaged-remaining-results.json') previousHistory = report.history || [{ checks: report.checks, errors: report.errors }]
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
const previousPassed = new Set(previousChecks.filter(check => check.passed).map(check => check.id))
const checks = [], errors = [], events = []
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let app, ws, serial = 0, stderr = '', session, nativeId, port
const pending = new Map()
let cleanupPromise, forceCleanup = false
function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('verification closed')) }
    pending.clear()
    ws?.close()
    await sweeper.sweep()
    if (forceCleanup) await sweeper.forceSweep()
    await rm(fixture, { recursive: true, force: true })
  })()
  return cleanupPromise
}
const termination = createAcceptanceTerminationHandler({ cleanup,
  requestForceCleanup: () => { forceCleanup = true; void sweeper.forceSweep() },
  onFirstSignal: signal => console.error(`Received ${signal}; cleaning isolated Qoder verification`),
  onCleanupError: error => console.error('Qoder verification cleanup failed:', error), exit: code => process.exit(code) })
process.on('SIGINT', () => termination.handleTerminationSignal('SIGINT', 130))
process.on('SIGTERM', () => termination.handleTerminationSignal('SIGTERM', 143))
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const check = (id, passed, detail) => { if (remainingOnly && previousPassed.has(id)) return; checks.push({ id, passed: !!passed, detail }); assert.ok(passed, `${id}: ${JSON.stringify(detail)}`); console.log('✓ ' + id) }
async function waitFor(read, predicate, label, timeout = 90_000) {
  const start = Date.now(); let value, reported = start
  while (Date.now() - start < timeout) {
    value = await read()
    if (predicate(value)) return value
    if (Date.now() - reported > 25_000) { console.log('… ' + label); reported = Date.now() }
    await delay(150)
  }
  throw new Error(`${label} timed out${label === 'CN detection' ? ': ' + JSON.stringify(value?.find(agent => agent.id === 'qoder')) : ''}`)
}
function cdp(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')) }, 60_000)
    pending.set(id, { done, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result.value
}
const call = (method, ...args) => evaluate(`window.uniagent[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
async function idle(id) {
  return waitFor(() => call('listSessions'), values => ['idle', 'completed', 'error'].includes(values.find(value => value.id === id)?.status), 'session idle')
}

try {
  for (const path of [home, data, workdir, join(home, '.qoder-cn'), join(home, '.local/bin'), evidence]) await mkdir(path, { recursive: true, mode: 0o700 })
  // Authentication metadata stays local, is never serialized into evidence, and is removed with the fixture.
  await cp(join(homedir(), '.qoder-cn/.auth'), join(home, '.qoder-cn/.auth'), { recursive: true, dereference: true })
  await writeFile(join(home, '.qoder-cn/settings.json'), '{}', { mode: 0o600 })
  await symlink(cli, join(home, '.local/bin/qoderclicn'))
  await writeFile(join(data, 'settings.json'), JSON.stringify({ enabledAgentIds: ['qoder'], startupRestore: false }), { mode: 0o600 })
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); port = server.address().port; await new Promise(done => server.close(done))
  const env = { ...process.env, HOME: home, USERPROFILE: home, UNIAGENT_USER_DATA: data, QODERCN_CONFIG_DIR: join(home, '.qoder-cn'),
    CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'), KIMI_CODE_HOME: join(home, '.kimi-code'),
    TMPDIR: join(fixture, 'tmp'), XDG_CONFIG_HOME: join(fixture, 'xdg'), XDG_DATA_HOME: join(fixture, 'xdg-data'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), npm_config_userconfig: join(fixture, 'npmrc'),
    PATH: join(home, '.local/bin') + ':' + process.env.PATH }
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY|SECRET|PASSWORD/.test(key)) delete env[key]
  await mkdir(env.TMPDIR, { recursive: true })
  const started = Date.now()
  app = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium')], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10_000) }); await sweeper.addRoot(app.pid)
  const renderer = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
  const targets = await waitFor(async () => {
    if (app.exitCode !== null || app.signalCode) throw new Error('isolated package exited during startup')
    try { return await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json()) } catch { return [] }
  }, rows => rows.some(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer), 'packaged renderer', 45_000)
  const target = targets.find(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = event => { const reply = JSON.parse(event.data), request = pending.get(reply.id); if (request) { pending.delete(reply.id); clearTimeout(request.timer); reply.error ? request.reject(new Error(reply.error.message)) : request.done(reply.result) } }
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
  await waitFor(() => evaluate('!!document.body?.innerText.trim()'), value => value, 'first visible body', 20_000)
  const firstUiMs = Date.now() - started
  check('Q06.first-visible-ui', true, { observedAtMs: firstUiMs })
  await evaluate(`window.__qoderEvents=[];window.uniagent.onEvent(e=>{window.__qoderEvents.push(e);if(e.type==='approval_request'&&e.state==='pending')window.uniagent.respondRequest(e.sessionId,e.payload.requestId,{decision:'accept',answers:{q0:{answers:['A']}}})})`)
  await evaluate(`window.uniagent.onSideEvent(({sessionId,event:e})=>{if(e.type==='approval_request'&&e.state==='pending')window.uniagent.respondSideRequest(sessionId,e.payload.requestId,{decision:'accept'})})`)
  await delay(12_000)
  const detected = (await call('getLifecycleSnapshot')).find(agent => agent.id === 'qoder')
  console.log('Qoder detection snapshot', JSON.stringify({ version: detected?.version, lifecycle: detected?.lifecycle, modelCount: detected?.models.length }))
  const qoder = await waitFor(() => call('getLifecycleSnapshot'), values => values.find(agent => agent.id === 'qoder')?.lifecycle?.availability === 'available', 'CN detection').then(values => values.find(agent => agent.id === 'qoder'))
  check('Q01.native-shared-cli', qoder.qoder?.region === 'cn' && await realpath(qoder.bin) === cli, { version: qoder.version, region: qoder.qoder?.region })
  check('Q03.native-auth-reuse', qoder.lifecycle.auth === 'authenticated')
  check('Q07.models', qoder.models.length > 0 && qoder.models.every(model => model.id), { count: qoder.models.length })
  assert.ok(qoder.models.some(model => model.id === testModel), '指定测试模型未在 CN CLI 目录中开放，停止验收，避免静默使用 Auto')
  check('Q10.permission-modes', qoder.capabilities.permissionModes.some(mode => mode.id === 'ask') && !qoder.capabilities.permissionModes.some(mode => mode.id === 'read-only'))
  check('Q18.strict-steer-difference', qoder.capabilities.steer === false)
  await call('setAppSettings', { enabledAgentIds: ['qoder'] })
  const project = await call('createProject', { name: 'Qoder CN acceptance', primaryDirectory: workdir, additionalDirectories: [] })
  const config = { agentId: 'qoder', projectId: project.id, model: testModel, effort: 'low', workdir, permissionMode: 'ask' }
  if (remainingOnly) {
    session = await call('createSession', config, 'Reply ACCEPTANCE_BASE_READY without tools.')
    await idle(session.id)
    assert.ok((await call('getEvents', session.id)).some(row => row.type === 'agent_message' && row.payload.text?.includes('ACCEPTANCE_BASE_READY')), 'remaining checks require one minimal native source session')
    nativeId = (await call('listSessions')).find(row => row.id === session.id)?.nativeSessionId
    assert.ok(nativeId, 'remaining checks require a native source ID')
    const selected = qoder.models.find(model => model.id === testModel)
    const nativeStarts = (await call('getEvents', session.id)).filter(row => row.type === 'turn_started')
    check('Q08.confirmed-native-model', nativeStarts.some(row => row.payload.model === selected.label),
      { requested: testModel, nativeModels: nativeStarts.map(row => row.payload.model) })
  } else {
  session = await call('createSession', config, 'Use Write to create proof.txt containing exactly QODER_FILE_OK. Use Bash to run cat proof.txt. Reply exactly QODER_TOOLS_OK.')
  await idle(session.id)
  let rows = await call('getEvents', session.id)
  check('Q13.streamed-reply', rows.some(event => event.type === 'agent_message' && event.payload.text?.includes('QODER_TOOLS_OK')), rows.filter(event => event.type === 'error').map(event => event.payload.message))
  check('Q14.file-diff', rows.some(event => event.type === 'file_change' && event.state === 'success') && rows.some(event => event.type === 'diff_update'), rows.filter(event => ['file_change','tool_call','command_exec'].includes(event.type)).map(event => ({ type: event.type, state: event.state, tool: event.payload.toolName || event.payload.tool, command: event.payload.command })))
  check('Q14.command-output', rows.some(event => event.type === 'command_exec' && event.state === 'success' && event.payload.output?.includes('QODER_FILE_OK')))
  await call('sendMessage', session.id, 'Reply QODER_MULTI_OK without tools.')
  await idle(session.id); rows = await call('getEvents', session.id)
  check('Q13.multiturn', rows.some(event => event.type === 'agent_message' && event.payload.text?.includes('QODER_MULTI_OK')))
  await call('sendMessage', session.id, 'Call UniAgent uniagent_query with action=list and type=agent. Reply UA_MCP_CN_OK. Do not create tasks or send messages.')
  await idle(session.id)
  const mcpRows = await call('getEvents', session.id)
  const queryCalls = await evaluate(`window.__qoderEvents.filter(row=>row.sessionId===${JSON.stringify(session.id)}&&row.type==='tool_call'&&(row.payload.name?.includes('uniagent_query')||row.payload.name==='mcp_call'&&row.payload.input?.toolName?.includes('uniagent_query'))).map(row=>row.payload.id)`)
  check('Q39.uniagent-mcp-query', mcpRows.some(row => row.type === 'tool_call' && row.state === 'success' && queryCalls.includes(row.payload.id)) && mcpRows.some(row => row.type === 'agent_message' && row.payload.text?.includes('UA_MCP_CN_OK')), mcpRows.filter(row => row.type === 'tool_call' || row.type === 'error').map(row => ({ type: row.type, name: row.payload.name, state: row.state, id: row.payload.id, error: row.type === 'error' ? row.payload.message : undefined })))
  const current = (await call('listSessions')).find(value => value.id === session.id)
  nativeId = current.nativeSessionId
  check('Q25.native-session-id', !!nativeId)
  const usage = rows.filter(event => event.payload?.kind === 'usage').map(event => event.payload.usage)
  check('Q22.credits', usage.some(value => value.credits > 0), usage.map(value => ({ credits: value.credits, tokensAvailable: value.tokensAvailable })))
  check('Q49.percentage-without-fake-tokens', usage.some(value => value.contextUsedPercentage > 0 && value.contextTokens === undefined))
  const capabilities = await call('getNativeCapabilities', { agentId: 'qoder', workdir, sessionId: session.id, force: true })
  check('Q34.native-commands', capabilities.candidates.some(value => value.kind === 'command' && value.name === 'compact'))
  const fork = await call('forkSameSession', 'qoder', nativeId, workdir)
  check('Q26.whole-fork', fork?.nativeSessionId && fork.nativeSessionId !== nativeId)
  const points = await call('getSessionForkPoints', session.id)
  check('Q26.message-fork-points', points.length > 0)
  const messageFork = await call('forkSameSession', 'qoder', nativeId, workdir, points[0])
  check('Q26.message-fork', messageFork?.nativeSessionId && messageFork.nativeSessionId !== nativeId)
  }
  if (!remainingOnly || ['Q28.side-reply', 'Q28.side-tools-and-multiturn', 'Q28.side-promotion'].some(id => !previousPassed.has(id))) {
  await call('sendSideMessage', session.id, 'Reply exactly QODER_SIDE_OK without tools.')
  await waitFor(() => call('getSideStatus', session.id), value => value === 'idle' || value === 'error', 'side idle')
  const side = await call('getSideEvents', session.id)
  check('Q28.side-reply', side.some(event => event.type === 'agent_message' && event.payload.text?.includes('QODER_SIDE_OK')), side.map(event => ({ type: event.type, state: event.state, text: event.payload.text, error: event.payload.message })))
  await call('sendSideMessage', session.id, 'Use Write to create side-proof.txt with SIDE_FILE_OK. Reply SIDE_MULTI_OK.')
  await waitFor(() => call('getSideStatus', session.id), value => value === 'idle' || value === 'error', 'side tools idle')
  check('Q28.side-tools-and-multiturn', (await call('getSideEvents', session.id)).some(event => event.type === 'file_change' && event.state === 'success') && (await readFile(join(workdir, 'side-proof.txt'), 'utf8')).trim() === 'SIDE_FILE_OK')
  const promoted = await call('promoteSideToSession', session.id)
  check('Q28.side-promotion', promoted?.nativeSessionId && promoted.nativeSessionId !== nativeId)
  }
  await call('setCollaborationMode', session.id, 'plan')
  const planned = (await call('listSessions')).find(value => value.id === session.id)
  check('Q32.independent-plan', planned.config.collaborationMode === 'plan' && planned.config.permissionMode === 'ask')
  await call('setCollaborationMode', session.id, 'default')
  const byok = await call('listQoderByok')
  check('Q09.native-byok-list', Array.isArray(byok) && byok.every(value => !Object.hasOwn(value, 'apiKey')))
  const quota = await call('getAgentQuota', 'qoder', true)
  check('Q23.native-quota', quota?.kind === 'windows' && quota.windows.length > 0, { kind: quota?.kind, windows: quota?.windows?.length })
  await call('renameSession', session.id, 'Qoder CN verified')
  await call('archiveSession', session.id)
  check('Q44.archive', (await call('listSessions')).find(value => value.id === session.id)?.archived === true)
  await call('unarchiveSession', session.id)
  const renamed = (await call('listSessions')).find(value => value.id === session.id)
  check('Q44.rename-unarchive', renamed?.taskMetadata?.title === 'Qoder CN verified' && renamed.taskMetadata.source === 'manual' && renamed.archived === false,
    { nativeTitle: renamed?.title, taskTitle: renamed?.taskMetadata?.title, source: renamed?.taskMetadata?.source, archived: renamed?.archived })
  if (!remainingOnly || !previousPassed.has('Q40.scheduler-output')) {
  const automation = await call('createAutomation', { name: 'Qoder CN once', prompt: 'Reply AUTO_CN_OK without tools.', schedule: 'ONCE:' + new Date(Date.now() + 45000).toISOString(), agentId: 'qoder', model: testModel, reasoningEffort: 'low', permissionMode: 'ask', taskScope: { kind: 'space', projectId: project.id } })
  const ran = await waitFor(() => call('getAutomationDetail', automation), value => value?.lastRunStatus === 'success' || value?.lastRunStatus === 'error', 'Qoder scheduled task', 150000)
  check('Q40.scheduler-run', ran.lastRunStatus === 'success' && ran.lastSessionId, { status: ran.lastRunStatus })
  check('Q40.scheduler-output', (await call('getEvents', ran.lastSessionId)).some(row => row.type === 'agent_message' && row.payload.text?.includes('AUTO_CN_OK')))
  }
  if (!remainingOnly || !previousPassed.has('Q41.assistant-review')) {
  await call('savePersonalAssistant', { enabled: true, defaultAgentId: 'qoder', defaultModel: testModel, defaultPermissionMode: 'ask', autoReviewEnabled: true, reviewRuntime: { agentId: 'qoder', model: testModel } }, [])
  const assistant = await call('openAssistantAppConversation')
  check('Q41.assistant-carrier', assistant.config.agentId === 'qoder' && !!assistant.config.assistantSnapshot)
  await call('sendMessage', assistant.id, remainingOnly && previousPassed.has('Q41.assistant-tools') ? 'Reply ASSISTANT_REVIEW_TRIGGER without tools.' : 'Call assistant_memory with action=read and document=memory. Reply ASSISTANT_CN_OK. Do not change memory or send messages.')
  await idle(assistant.id)
  const assistantCalls = await evaluate(`window.__qoderEvents.filter(row=>row.sessionId===${JSON.stringify(assistant.id)}&&row.type==='tool_call'&&(row.payload.name?.includes('assistant_memory')||row.payload.name==='mcp_call'&&row.payload.input?.toolName?.includes('assistant_memory'))).map(row=>row.payload.id)`)
  check('Q41.assistant-tools', (await call('getEvents', assistant.id)).some(row => row.type === 'tool_call' && row.state === 'success' && assistantCalls.includes(row.payload.id)))
  await waitFor(() => call('getPersonalAssistant'), detail => ['queued', 'running', 'failed', 'unsupported'].includes(detail.review.status), 'assistant review scheduled', 30000)
  const reviewed = await waitFor(() => call('getPersonalAssistant'), detail => ['idle', 'failed', 'unsupported'].includes(detail.review.status), 'assistant review finished', 150000)
  check('Q41.assistant-review', reviewed.review.status === 'idle', reviewed.review)
  await call('savePersonalAssistant', { enabled: true, defaultAgentId: 'qoder', defaultModel: testModel, defaultPermissionMode: 'ask', autoReviewEnabled: false }, [])
  }
  if (!remainingOnly || !previousPassed.has('Q18.interrupt-then-send')) {
  await call('sendMessage', session.id, 'Use Bash to sleep 15 seconds, then reply ORIGINAL_DONE.')
  await waitFor(() => call('getEvents', session.id), values => values.some(value => value.type === 'command_exec' && value.state === 'running' && value.payload.command?.includes('sleep 15')), 'interruptible command')
  await call('sendMessage', session.id, 'Reply QUEUED_FIRST without tools.')
  await call('sendMessage', session.id, 'Reply QUEUED_REMOVE without tools.')
  const queued = (await call('listQueues'))[session.id]
  check('Q17.queue-records', queued?.length >= 2)
  const remove = queued.find(item => item.prompt?.includes('QUEUED_REMOVE'))
  if (remove) await call('dequeue', session.id, remove.id)
  const afterRemoval = (await call('listQueues'))[session.id] || []
  check('Q17.dequeue-records', afterRemoval.length === queued.length - 1 && !afterRemoval.some(item => item.id === remove?.id))
  await assert.rejects(call('forceSend', session.id, 'Reply STRICT_FORCE_REJECTED without tools.'), /unsupported_target_capability.*steer/)
  check('Q18.strict-force-rejected', !(await call('getEvents', session.id)).some(event => event.type === 'user_message' && event.payload.text?.includes('STRICT_FORCE_REJECTED')))
  await call('interrupt', session.id)
  await idle(session.id)
  check('Q17.interrupt-clears-queue', !((await call('listQueues'))[session.id] || []).length &&
    (await call('getEvents', session.id)).some(event => event.type === 'turn_completed' && event.state === 'cancelled'))
  await call('sendMessage', session.id, 'Reply REDIRECT_CN_OK without tools.')
  await idle(session.id)
  check('Q18.interrupt-then-send', (await call('getEvents', session.id)).some(event => event.type === 'agent_message' && event.payload.text?.includes('REDIRECT_CN_OK')))
  }
  if (!remainingOnly || !previousPassed.has('Q31.unavailable-token-budget-blocked')) {
  const budgetGoal = await call('createNativeActionSession', config, { type: 'goal.set', objective: 'Reply GOAL_CN_OK without tools, then mark the goal complete.', tokenBudget: 100, maxRounds: 1 })
  await idle(budgetGoal.id)
  const goal = (await call('listSessions')).find(value => value.id === budgetGoal.id)?.goal
  check('Q31.unavailable-token-budget-blocked', goal?.status === 'blocked' && goal.blockedReason?.code === 'token_usage_unavailable', { status: goal?.status, reason: goal?.blockedReason?.code })
  await call('runNativeAction', budgetGoal.id, { type: 'goal.update', action: 'resume' })
  await call('runNativeAction', budgetGoal.id, { type: 'goal.update', action: 'edit', tokenBudget: 200, objective: 'Keep budget safety blocked.' })
  const editedBudget = (await call('listSessions')).find(value => value.id === budgetGoal.id)?.goal
  check('Q31.budget-resume-edit-without-inference', editedBudget?.status === 'blocked' && editedBudget.tokenBudget === 200 &&
    !(await call('getEvents', budgetGoal.id)).some(event => event.type === 'agent_message' || event.payload.usage?.credits > 0),
    { status: editedBudget?.status, tokenBudget: editedBudget?.tokenBudget })
  }
  if (!remainingOnly || !previousPassed.has('Q39.requirement-read-check-propose')) {
    await call('setAppSettings', { requirementsEnabled: true })
    const requirement = await call('createRequirement', { name: 'Qoder isolated requirement', projectId: project.id })
    const reader = await call('createSession', { ...config, requirementId: requirement.id }, 'Use UniAgent requirement_context: read documentId=core, then check, then propose one draft proposal with id=cn-fixture, kind=proposal, title=Local fixture, content=Isolated protocol verification. Use the returned revision as expectedRevision and operationId=cn-fixture-propose. Reply REQ_CN_OK after success. Do not commit effective rules or create other tasks.')
    await idle(reader.id)
    const overview = await call('readRequirementOverview', requirement.id, 'cn-fixture')
    const calls = await evaluate(`(()=>{const rows=window.__qoderEvents;return rows.filter(e=>e.sessionId===${JSON.stringify(reader.id)}&&e.type==='tool_call'&&(e.payload.name?.includes('requirement_context')||e.payload.name==='mcp_call'&&e.payload.input?.toolName?.includes('requirement_context'))).map(e=>({action:(e.payload.input?.arguments||e.payload.input)?.action,success:rows.some(v=>v.type==='tool_call'&&v.payload.id===e.payload.id&&v.state==='success')}))})()`)
    check('Q39.requirement-read-check-propose', ['read', 'check', 'propose'].every(action => calls.some(value => value.action === action && value.success)) && overview.document?.kind === 'proposal' && overview.document.status === 'draft' &&
      (await call('getEvents', reader.id)).some(row => row.type === 'agent_message' && row.payload.text?.includes('REQ_CN_OK')),
      { kind: overview.document?.kind, status: overview.document?.status, calls })
    await call('setAppSettings', { requirementsEnabled: false })
  }
  if (!remainingOnly || !previousPassed.has('Q42.team-dispatch-and-delivery')) {
    const role = { agentId: 'qoder', model: testModel, permissionMode: 'full-access' }
    const team = await call('saveTeam', { name: 'Qoder isolated team', description: 'Protocol verification', rules: 'Only one member task; no outside tasks or files.', leaderMemberId: 'leader', members: [
      { id: 'leader', role: { ...role, id: 'cn-leader', name: 'Coordinator', instructions: 'Use team MCP to coordinate the single requested task.' } },
      { id: 'member', role: { ...role, id: 'cn-member', name: 'Member', instructions: 'Complete only the assigned task; do not use shell or write files.' } }
    ], limits: { concurrency: 1, maxAssignments: 1, taskMinutes: 2, runMinutes: 4 }, status: 'active' })
    const carrier = await call('createTeamProject', { teamId: team.id, spaceId: project.id, prompt: 'Call get_team_context, then dispatch_team_task exactly once to memberId=member with requestId=cn-once, title=Fixture, prompt=Reply TEAM_MEMBER_CN_OK without tools. End this turn to wait for the member. When its result arrives, get_team_context, review_team_task accept with reason=Marker verified, acknowledge the latest handledInboxSeq, and update_team_project action=complete with current expectedRevision and basedOnInboxSeq, finalResult.summary=TEAM_DELIVERY_CN_OK. Finish with TEAM_DELIVERY_CN_OK. Do not use native subagents or other tasks.' })
    const delivered = await waitFor(() => call('teamCatalog'), value => value.projects.some(row => row.id === carrier.id && ['completed', 'failed', 'interrupted'].includes(row.status)), 'Qoder team delivery', 240000)
      .then(value => value.projects.find(row => row.id === carrier.id))
    check('Q42.team-dispatch-and-delivery', delivered.status === 'completed' && delivered.assignments.length === 1 &&
      delivered.assignments[0].result?.includes('TEAM_MEMBER_CN_OK') && delivered.assignments[0].review?.decision === 'accept' &&
      delivered.finalResult?.summary.includes('TEAM_DELIVERY_CN_OK'),
      { status: delivered.status, assignments: delivered.assignments.map(row => ({ status: row.status, review: row.review?.decision })), error: delivered.error })
  }
  await evaluate('location.reload()'); await delay(1000)
  await waitFor(() => evaluate('typeof window.uniagent?.listSessions === "function"'), value => value, 'reloaded renderer')
  check('Q44.persisted-session-list', (await call('listSessions')).some(value => value.id === session.id))
  await waitFor(() => evaluate(`!![...document.querySelectorAll('.sidebar-nav-item')].find(row=>row.textContent.trim()==='任务看板')`), Boolean, 'task board navigation')
  await evaluate(`[...document.querySelectorAll('.sidebar-nav-item')].find(row=>row.textContent.trim()==='任务看板').click()`)
  await waitFor(() => evaluate(`!!document.querySelector('.task-board-card[data-task-id="${session.id}"] .task-board-card-open')`), Boolean, 'Qoder task board card')
  await evaluate(`document.querySelector('.task-board-card[data-task-id="${session.id}"] .task-board-card-open').click()`)
  await waitFor(() => evaluate(`!!document.querySelector('.session-view .event-stream')?.textContent.trim()`), Boolean, 'selected Qoder workspace UI')
  check('Q44.workspace-ui', await evaluate('document.querySelector(".event-stream").textContent.includes("ACCEPTANCE_BASE_READY") || document.querySelector(".event-stream").textContent.includes("QODER_TOOLS_OK")'))
  const screen = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(evidence, 'packaged-workspace.png'), Buffer.from(screen.data, 'base64'))
  if (!remainingOnly || ['Q25.app-restart-native-id', 'Q25.app-restart-resume'].some(id => !previousPassed.has(id))) {
  ws.close()
  await sweeper.sweep()
  app = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium-restart')], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000) }); await sweeper.addRoot(app.pid)
  const restartedTargets = await waitFor(async () => { try { return await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json()) } catch { return [] } },
    rows => rows.some(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer), 'restarted renderer', 45000)
  const restartedTarget = restartedTargets.find(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer)
  ws = new WebSocket(restartedTarget.webSocketDebuggerUrl)
  ws.onmessage = event => { const reply = JSON.parse(event.data), request = pending.get(reply.id); if (request) { pending.delete(reply.id); clearTimeout(request.timer); reply.error ? request.reject(new Error(reply.error.message)) : request.done(reply.result) } }
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
  await waitFor(() => call('listSessions'), rows => rows.some(row => row.id === session.id), 'restored sessions')
  check('Q25.app-restart-native-id', (await call('listSessions')).find(row => row.id === session.id).nativeSessionId === nativeId)
  await call('sendMessage', session.id, 'Reply APP_RESTART_CN_OK without tools.')
  await idle(session.id)
  check('Q25.app-restart-resume', (await call('getEvents', session.id)).some(row => row.type === 'agent_message' && row.payload.text?.includes('APP_RESTART_CN_OK')))
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error)); console.error(errors.at(-1)); process.exitCode = 1
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    try { events.push(...await evaluate('window.__qoderEvents || []')) } catch {}
    ws.close()
  }
  await cleanup()
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, remainingOnly ? 'packaged-remaining-results.json' : 'packaged-results.json'), JSON.stringify({ cliVersion: '1.1.85', region: 'cn', model: testModel, scope: remainingOnly ? 'remaining' : 'full', previousPassed: [...previousPassed], checks, errors, passed: !errors.length,
    ...(remainingOnly ? { history: [...previousHistory, { recordedAt: new Date().toISOString(), checks, errors }] } : {}) }, null, 2))
}
