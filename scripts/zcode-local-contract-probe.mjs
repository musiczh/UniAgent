import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ProbeConnection, uuid7 } from './zcode-probe.mjs'

// Local protocol fixture: no real model, credentials, or user workspace.
const args = process.argv.slice(2)
const actualHandoff = args.includes('--uniagent-handoff')
const configPath = args[args.indexOf('--runtime-config') + 1]
const output = resolve(args[args.indexOf('--output') + 1])
if (!args.includes('--runtime-config') || !args.includes('--output')) throw new Error('Expected --runtime-config and --output')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const root = await mkdtemp('/tmp/uzl-')
const workspace = join(root, 'workspace')
const manifest = { scope: 'local-fixture-model-and-mcp-only', checkedAt: new Date().toISOString(), checks: {}, unverified: ['real-zhipu-auth', 'real-model-quality', 'real-model-tool-choice'] }
const modelCalls = []
const exec = promisify(execFile)
const server = createServer(async (req, res) => {
  try {
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 * 1024) throw new Error('request_limit') }
    const input = JSON.parse(body)
    const messages = input.messages ?? []
    const tools = input.tools ?? []
    const lastUser = messages.findLastIndex(m => m.role === 'user')
    const prompt = JSON.stringify(messages[lastUser]?.content ?? '')
    const authMarker = prompt.match(/ZCODE_AUTH_OK_[12]/)?.[0]
    const longResponse = prompt.includes('FIXTURE_LARGE') ? 'FIXTURE_LARGE_OK ' + 'L'.repeat(256 * 1024) : undefined
    const toolName = prompt.includes('FIXTURE_WRITE') ? 'Write' : prompt.includes('FIXTURE_STOP') ? 'Bash'
        : prompt.includes('FIXTURE_QUESTION') ? 'AskUserQuestion' : actualHandoff ? 'requirement_context' : 'echo_caller'
    const tool = authMarker || longResponse ? undefined : tools.find(t => ['echo_caller', 'requirement_context'].includes(toolName) ? t.function?.name?.endsWith('__' + toolName) : t.function?.name === toolName)
    const toolArguments = toolName === 'Write' ? { file_path: join(workspace, 'permission-fixture.txt'), content: 'FIXTURE_APPROVED\n' }
      : toolName === 'Bash' ? { command: '/bin/sleep 30', description: 'Local stop fixture' }
        : toolName === 'AskUserQuestion' ? { questions: [{ question: 'Which local fixture value?', header: 'Fixture', options: [{ label: 'Alpha', description: 'Fixture Alpha' }, { label: 'Beta', description: 'Fixture Beta' }], multiSelect: true }] } : actualHandoff ? { action: 'read' } : {}
    const toolResult = messages.slice(lastUser + 1).find(m => m.role === 'tool')
    modelCalls.push({ stream: input.stream, toolNames: tools.map(t => t.function?.name), toolResult: toolResult?.content, scenario: toolName })
    const id = 'fixture-' + randomUUID()
    const common = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: input.model }
    const delta = tool && !toolResult
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(toolArguments) } }] }
      : { role: 'assistant', content: authMarker ?? longResponse ?? ('LOCAL_FIXTURE_OK ' + (toolResult?.content ?? 'NO_MCP_TOOL')) }
    const finishReason = tool && !toolResult ? 'tool_calls' : 'stop'
    if (input.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\n')
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: delta, finish_reason: finishReason }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }))
    }
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })) }
})
let connection
const clientId = randomUUID()
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), ZCODE_DATA_BASE_DIR: join(root, 'data'), ZCODE_STORAGE_DIR: join(root, 'storage'), ZCODE_SESSION_DB_PATH: join(root, 'db.sqlite'), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(root, 'provider_config.json'), ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(config.resourceRoot, 'provider/zcode-builtin.json'), NODE_ENV: 'production' }
const modelSelection = { providerId: 'personal:uniagent-fixture', modelId: 'uniagent-fixture', options: { reasoningLevel: 'disabled' } }
const mcpScript = join(root, actualHandoff ? 'mcp-fixture.cjs' : 'mcp-fixture.mjs')
const requirementInbox = join(root, 'requirement-inbox')
const requirementResults = join(root, 'requirement-results')
const descriptor = caller => [{ name: 'uniagent-fixture', command: config.executable, args: [mcpScript], env: [
  { name: 'UNIAGENT_CALLER_SESSION', value: caller },
  ...(actualHandoff ? [
    { name: 'UNIAGENT_REQUIRE_CALLER', value: '1' },
    { name: 'UNIAGENT_REQUIREMENT_TOKEN', value: 'LOCAL_FIXTURE_TOKEN_' + caller },
    { name: 'UNIAGENT_REQUIREMENT_INBOX', value: requirementInbox },
    { name: 'UNIAGENT_REQUIREMENT_RESULTS', value: requirementResults },
  ] : []),
], isolation: 'session', protocolVersion: 'legacy', timeoutMs: 10000 }]
let requirementTimer
let polling = false
let brokerError
const forwarded = []
const incoming = []
const command = (type, sessionId, payload) => connection.request('v4/command', { commandId: uuid7(), clientId, sessionId, type, payload, issuedAt: Date.now() })
const deltasFor = sessionId => connection.frames.filter(f => f.frame.topic === `conversation/${sessionId}`).flatMap(f => f.frame.payload.deltas ?? [])
const terminal = (sessionId, commandId, state = 'completedSuccess') => connection.waitFor(() => deltasFor(sessionId).some(d => d.row?.kind === 'turnHeader' && d.row.sourceCommandId === commandId && d.row.state === state) ? true : undefined, 10000)
const snapshot = async sessionId => {
  const ack = await connection.request('v4/conversation/subscribe', { topic: `conversation/${sessionId}`, connectionId: randomUUID(), clientMode: 'desktop-continuous', workspace: { workspacePath: workspace, workspaceKey: workspace } })
  return connection.waitFor(() => connection.frames.find(f => f.frame.subscriptionId === ack.ack.subscriptionId && f.frame.payload.kind === 'snapshot'))
}
const start = async () => {
  // Permission RPC and v4 compete. Leave the legacy RPC pending so v4 can settle it.
  connection = new ProbeConnection(config, workspace, env, { deferredCallbackMethods: ['interaction/requestPermission', 'interaction/requestUserInput'] })
  await connection.waitFor(() => connection.notifications.some(n => n.method === 'startup/storageState' && n.params?.phase === 'ready') ? true : undefined)
  await connection.request('runtime/capabilities', {})
}
const close = async () => {
  if (!connection) return
  incoming.push(...connection.trace)
  const result = await connection.close()
  if (!result.exited) throw new Error('child_cleanup_failed')
  connection = undefined
}
const turn = async (sessionId, caller) => {
  const before = modelCalls.length
  const ack = await command('sendText', sessionId, { text: `Call ${actualHandoff ? 'requirement_context with action read' : 'echo_caller'}, then reply with its result. This is a local fixture.`, modelSelection, mode: 'yolo', planEnabled: false })
  if (ack.status !== 'accepted') throw new Error('send_not_accepted:' + JSON.stringify(ack))
  await connection.waitFor(() => modelCalls.slice(before).some(c => c.toolResult?.includes(caller)) ? true : undefined)
  // Observe this command's own terminal turn row, never an older turn or just the ACK.
  await terminal(sessionId, ack.commandId)
  return ack
}
try {
  for (const path of [workspace, env.HOME, env.TMPDIR, env.ZCODE_DATA_BASE_DIR, env.ZCODE_STORAGE_DIR]) await mkdir(path, { recursive: true })
  await writeFile(mcpScript, `import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin});
for await (const line of lines) { const m=JSON.parse(line); if(m.id===undefined) continue; let result;
if(m.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'uniagent-local-fixture',version:'1'}};
else if(m.method==='tools/list') result={tools:[{name:'echo_caller',description:'Return the fixture caller identity',inputSchema:{type:'object',properties:{}}}]};
else if(m.method==='tools/call') result={content:[{type:'text',text:process.env.UNIAGENT_CALLER_SESSION}]};
else if(m.method==='ping') result={};
else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'fixture method unavailable'}})+'\\n');continue;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}
`, { mode: 0o600 })
  if (actualHandoff) {
    // Use the exact production stdio server; only its main-process response broker is a fixture.
    const handoff = await readFile(join(import.meta.dirname, '../src/main/handoff.ts'), 'utf8')
    const source = handoff.match(/const SERVER_SRC = String.raw`([\s\S]*?)\n`\n/)
    if (!source || source[1].includes('${')) throw new Error('handoff_source_extraction_failed')
    await writeFile(mcpScript, source[1], { mode: 0o600 })
    manifest.handoffServerSha256 = createHash('sha256').update(source[1]).digest('hex')
    await mkdir(requirementInbox)
    await mkdir(requirementResults)
    requirementTimer = setInterval(async () => {
      if (polling || brokerError) return
      polling = true
      try {
        for (const name of await readdir(requirementInbox)) {
          if (!name.endsWith('.json')) continue
          const path = join(requirementInbox, name)
          const request = JSON.parse(await readFile(path, 'utf8'))
          if (!['UNIAGENT_FIXTURE_A', 'UNIAGENT_FIXTURE_B'].includes(request.sessionId)
            || request.token !== 'LOCAL_FIXTURE_TOKEN_' + request.sessionId || request.args.action !== 'read') throw new Error('handoff_caller_binding_mismatch')
          forwarded.push({ sessionId: request.sessionId, action: request.args.action })
          await writeFile(join(requirementResults, name), JSON.stringify({ ok: true, value: { callerSessionId: request.sessionId } }), { mode: 0o600 })
          await rm(path)
        }
      } catch (error) { brokerError = error }
      finally { polling = false }
    }, 20)
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: modelSelection.providerId, providerName: 'Local fixture', enabled: true, config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'LOCAL_FIXTURE_ONLY' }, api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, personalModelIds: [modelSelection.modelId] } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: modelSelection } }), { mode: 0o600 })
  await start()
  const sessions = []
  for (const caller of ['UNIAGENT_FIXTURE_A', 'UNIAGENT_FIXTURE_B']) {
    const created = await command('createSession', null, { workspaceId: workspace, config: { mode: 'build', modelSelection, planEnabled: false }, mcpServers: descriptor(caller) })
    if (created.status !== 'accepted') throw new Error('create_not_accepted:' + JSON.stringify(created))
    const sessionId = created.result.sessionId
    await snapshot(sessionId)
    await turn(sessionId, caller)
    sessions.push({ sessionId, caller })
  }
  manifest.checks.personalProviderLocalExecution = true
  manifest.checks.twoSessionMcpIsolation = true
  await close()
  await start()
  for (const { sessionId, caller } of sessions) {
    await connection.request('session/resume', { sessionId, workspace: { workspacePath: workspace, workspaceKey: workspace }, mcpServers: descriptor(caller) })
    const cold = await snapshot(sessionId)
    if (!cold.frame.payload.snapshot.rows.window.some(row => row.kind === 'userInput')) throw new Error('cold_history_missing')
    const page = await connection.request('v4/conversation/rowsRange', { sessionId, clientMode: 'desktop-continuous', limit: 3 })
    const earlier = await connection.request('v4/conversation/rowsRange', { sessionId, clientMode: 'desktop-continuous', limit: 3, beforeRowId: page.rows[0].rowId })
    if (!page.hasMore || earlier.rows.length === 0 || earlier.rows.some(row => row.rowId >= page.rows[0].rowId)
      || page.atLogEpoch !== cold.frame.payload.snapshot.logEpoch || earlier.atLogEpoch !== page.atLogEpoch) throw new Error('history_cursor_mismatch')
    manifest.checks.historyRowsRangeCursor = true
    await turn(sessionId, caller)
  }
  manifest.checks.durableColdHistory = true
  manifest.checks.mcpCallerColdResume = true
  if (actualHandoff) {
    if (brokerError) throw brokerError
    if (forwarded.length !== 4 || ['UNIAGENT_FIXTURE_A', 'UNIAGENT_FIXTURE_B'].some(caller => forwarded.filter(item => item.sessionId === caller).length !== 2)) throw new Error('handoff_forwarded_count_mismatch')
    manifest.checks.uniagentHandoffServerCallerForwarding = true
    manifest.scope = 'local-model-with-production-handoff-server-and-isolated-response-broker'
    manifest.unverified.push('production-requirement-main-handler')
  }
  const sessionId = sessions[0].sessionId
  const questionFrom = connection.frames.length
  const questioned = await command('sendText', sessionId, { text: 'FIXTURE_QUESTION ask the fixture question.', modelSelection, mode: 'build', planEnabled: false })
  if (questioned.status !== 'accepted') throw new Error('question_send_rejected')
  const question = await connection.waitFor(() => connection.frames.slice(questionFrom).flatMap(f => f.frame.payload.deltas ?? []).flatMap(d => d.patch?.pendingInteractions ?? []).find(i => i.kind === 'userInput'))
  const nativeQuestion = question.payload.questions?.[0]
  if (!nativeQuestion || !nativeQuestion.multiSelect || nativeQuestion.options.length !== 2) throw new Error('question_shape_mismatch')
  const values = nativeQuestion.options.map(option => option.value)
  const answeredQuestion = await command('resolveInteraction', sessionId, { interactionId: question.interactionId, answer: { action: 'accept', content: { answers: { [nativeQuestion.question]: values } } } })
  if (answeredQuestion.status !== 'accepted') throw new Error('question_answer_rejected')
  await terminal(sessionId, questioned.commandId)
  if (!modelCalls.some(call => call.scenario === 'AskUserQuestion' && call.toolResult?.includes('Alpha') && call.toolResult?.includes('Beta'))) throw new Error('question_answer_not_delivered')
  manifest.checks.multiSelectQuestionAnswer = true
  for (const choice of ['deny', 'allow_once']) {
    const from = connection.frames.length
    const sent = await command('sendText', sessionId, { text: 'FIXTURE_WRITE create the fixture file.', modelSelection, mode: 'build', planEnabled: false })
    if (sent.status !== 'accepted') throw new Error('write_send_rejected:' + JSON.stringify(sent))
    const interaction = await connection.waitFor(() => connection.frames.slice(from).flatMap(f => f.frame.payload.deltas ?? []).flatMap(d => d.patch?.pendingInteractions ?? []).find(i => i.kind === 'permission' && i.payload.toolName === 'Write'))
    const answered = await command('resolveInteraction', sessionId, { interactionId: interaction.interactionId, answer: { optionId: choice } })
    if (answered.status !== 'accepted') throw new Error('permission_response_rejected')
    await terminal(sessionId, sent.commandId)
    const content = await readFile(join(workspace, 'permission-fixture.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (choice === 'deny' ? content !== undefined : content !== 'FIXTURE_APPROVED\n') throw new Error('permission_file_mismatch:' + choice)
    manifest.checks[choice === 'deny' ? 'permissionDeniedNoWrite' : 'permissionApprovedWrite'] = true
  }
  const stopFrom = connection.frames.length
  const slow = await command('sendText', sessionId, { text: 'FIXTURE_STOP run the local sleep command.', modelSelection, mode: 'yolo', planEnabled: false })
  if (slow.status !== 'accepted') throw new Error('stop_fixture_rejected')
  await connection.waitFor(() => connection.frames.slice(stopFrom).flatMap(f => f.frame.payload.deltas ?? []).some(d => d.row?.kind === 'toolCall' && d.row.toolName === 'Bash' && d.row.status === 'running') ? true : undefined)
  const stopped = await command('stop', sessionId, {})
  if (!['accepted', 'noop'].includes(stopped.status)) throw new Error('stop_rejected')
  await terminal(sessionId, slow.commandId, 'completedInterrupted')
  manifest.checks.stopInterruptedNativeTurn = true
  const large = await command('sendText', sessionId, { text: 'FIXTURE_LARGE return the large local response.', modelSelection, mode: 'build', planEnabled: false })
  if (large.status !== 'accepted') throw new Error('large_response_rejected')
  await terminal(sessionId, large.commandId)
  if (!connection.notifications.some(n => n.params?.kind === 'fragment')) throw new Error('physical_fragment_not_observed')
  const largeRows = deltasFor(sessionId).filter(d => d.row?.kind === 'assistantText' && d.row.state === 'complete').map(d => d.row)
  if (!largeRows.some(row => row.text.startsWith('FIXTURE_LARGE_OK ') && row.text.length === 256 * 1024 + 17)) throw new Error('large_response_assembly_mismatch')
  manifest.checks.physicalFragmentAssembly = true
  await close()
  const authFixture = await exec(process.execPath, [join(import.meta.dirname, 'zcode-real-auth-probe.mjs'), '--runtime-config', configPath, '--provider-config', env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, '--output', join(root, 'auth-probe-out')], { timeout: 90000 })
  if (JSON.parse(authFixture.stdout).result !== 'real-auth-passed') throw new Error('auth_probe_local_fixture_failed')
  manifest.checks.realAuthProbeLocalSelfCheck = true
  manifest.runtime = { nodeVersion: (await exec(config.executable, ['--version'])).stdout.trim(), bundleSha256: createHash('sha256').update(await readFile(config.bundlePath)).digest('hex') }
  manifest.result = 'local-contract-passed'
} catch (error) {
  manifest.result = 'local-contract-failed'
  manifest.error = error.message
} finally {
  try { await close() } catch (error) { manifest.cleanupError = error.message }
  clearInterval(requirementTimer)
  await new Promise(resolve => server.close(resolve))
  await mkdir(output, { recursive: true, mode: 0o700 })
  const scrub = value => JSON.stringify(value, null, 2).replaceAll(root, '/LOCAL_FIXTURE_ROOT') + '\n'
  await writeFile(join(output, 'manifest.json'), scrub(manifest), { mode: 0o600 })
  await writeFile(join(output, 'model-calls.json'), scrub(modelCalls), { mode: 0o600 })
  await writeFile(join(output, 'incoming.json'), scrub(incoming), { mode: 0o600 })
  if (!connection) await rm(root, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(manifest) + '\n')
process.exitCode = manifest.result === 'local-contract-passed' ? 0 : 1
