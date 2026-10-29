import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHostService } from '../src/main/deepseekHostService.ts'
import { DeepSeekHostRunner } from '../src/main/deepseekHostRunner.ts'
import { prepareDeepSeekHostContext, registerDeepSeekHostContext } from '../src/main/deepseekHostContext.ts'
import { listDeepSeekHostSessions, loadDeepSeekHostHistory, forkDeepSeekHostSession } from '../src/main/deepseekHostHistory.ts'
import type { AgentDef, SessionConfig, UAEvent } from '../src/shared/types.ts'

// Published Harness, real Host transport/persistence/tools, deterministic local model.
// Kept separate from default unit tests because the official runtime is an explicit prerequisite.
const runtime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME
if (!runtime) throw new Error('Set UNIAGENT_DEEPSEEK_TEST_RUNTIME to the installed runtime directory')
const root = await mkdtemp(join(tmpdir(), 'uniagent-host-runner-native-'))
let requestCount = 0, mode = 'text', toolReturned = false
let heldResponse: import('node:http').ServerResponse | undefined
const requests: any[] = []
const model = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk
  const input = JSON.parse(body || '{}'); requests.push(input); requestCount++
  if (mode === 'hold') { heldResponse = response; return }
  const tool = ['tool', 'approve', 'reject', 'question', 'mcp'].includes(mode) && !toolReturned
  if (tool) toolReturned = true
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const blocks = tool ? [mode === 'tool' ? { type: 'tool_use', id: 'call-native-read', name: 'read', input: { file_path: join(root, 'proof.txt') } }
    : mode === 'mcp' ? { type: 'tool_use', id: 'call-native-mcp', name: 'mcp__uniagent__caller', input: {} }
    : mode === 'question' ? { type: 'tool_use', id: 'call-native-question', name: 'ask_user_question', input: { questions: [{ id: 'choice', question: 'Pick a test value', options: [{ label: 'A' }, { label: 'B' }] }] } }
    : { type: 'tool_use', id: 'call-native-bash', name: 'bash', input: { command: `printf approved > '${join(root, mode + '.txt')}'`, description: 'Write an isolated approval test marker', sandbox_permissions: 'danger-full-access', justification: 'Verify one approved isolated test write.' } }]
    : [{ type: 'text', text: 'HOST_NATIVE_OK' }]
  const events: any[] = [{ type: 'message_start', message: { id: `fixture-${requestCount}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }]
  blocks.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
    events.push({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }, { type: 'message_stop' })
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
})
const home = join(root, 'home')
let host: DeepSeekHostService | undefined
const runners: DeepSeekHostRunner[] = []
const timeout = setTimeout(() => { heldResponse?.destroy(); model.closeAllConnections(); void host?.stop() }, 90_000)
try {
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const origin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  await mkdir(home)
  const mcpServer = join(root, 'mcp.cjs')
  await writeFile(mcpServer, `const lines = require('node:readline').createInterface({input:process.stdin});
lines.on('line', line => { const request = JSON.parse(line); if(request.id === undefined) return;
const result = request.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'caller-fixture',version:'1'}}
: request.method === 'tools/list' ? {tools:[{name:'caller',description:'Read the scoped caller',inputSchema:{type:'object',properties:{}}}]}
: request.method === 'tools/call' ? {content:[{type:'text',text:process.env.UNIAGENT_CALLER_SESSION}]} : {};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n'); });`)
  const patchFile = await prepareDeepSeekHostContext(home)
  await writeFile(join(root, 'proof.txt'), 'NATIVE_TOOL_PROOF')
  host = new DeepSeekHostService({ bin: join(runtime, 'node_modules/.bin/dsh'), home, cwd: root, patchFile,
    modelEnvironment: { DEEPSEEK_API_KEY: 'local-test-key', DEEPSEEK_BASE_URL: origin } })
  const client = await host.start()
  registerDeepSeekHostContext(client, home, id => [{ name: 'uniagent', command: process.execPath, args: [mcpServer], env: [{ name: 'UNIAGENT_CALLER_SESSION', value: id }] }])
  const catalog = await client.call<any>('session/modelCatalog')
  const group = catalog.groups.find((row: any) => row.id !== 'deepseek-account' && row.models.length)
  assert.ok(group, 'configured API-key route exists')
  const config: SessionConfig = { agentId: 'deepseek', workdir: root, permissionMode: 'full-access', model: JSON.stringify([group.id, group.models[0].id]), effort: 'off' }
  const agent = { id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', bin: join(runtime, 'node_modules/.bin/dsh') } as AgentDef
  const make = (id: string, nativeId?: string) => {
    const runner = new DeepSeekHostRunner(id, { n: 0 }, agent, config, nativeId, undefined, async () => client)
    runners.push(runner); return runner
  }
  const runner = make('native-test'), events: UAEvent[] = []
  runner.on('event', event => events.push(event))
  let done: any
  runner.on('done', value => { done = value })
  await runner.startTurn('Say HOST_NATIVE_OK')
  assert.equal(done?.failed, false, JSON.stringify(events.filter(e => e.type === 'error')))
  assert.ok(events.some(e => e.type === 'agent_message' && e.payload.text === 'HOST_NATIVE_OK'))
  assert.ok(events.some(e => e.type === 'agent_message' && e.state === 'running'), 'token streaming reaches renderer')
  assert.equal(new Set(events.filter(e => e.type === 'agent_message').map(e => e.payload.id)).size, 1, 'stream and final record merge into one message')
  assert.ok(events.some(e => e.payload.kind === 'usage'))
  assert.ok(requests[0].tools.length, 'native tools reach the model')
  assert.ok(requests[0].tools.some((tool: any) => tool.name === 'mcp__uniagent__caller'), 'UniAgent MCP tools reach the model')
  console.log('PASS native Host prompt, token stream, final deduplication, usage and completion')
  const nativeId = done.nativeSessionId
  const history = await loadDeepSeekHostHistory(nativeId, client)
  assert.ok(history.events.some(event => event.type === 'agent_message' && event.payload.text === 'HOST_NATIVE_OK'))
  assert.ok((await listDeepSeekHostSessions(client)).some(row => row.id === nativeId))
  const fork = await forkDeepSeekHostSession(nativeId, undefined, client)
  assert.notEqual(fork.nativeId, nativeId)
  assert.ok((await loadDeepSeekHostHistory(fork.nativeId, client)).events.some(event => event.type === 'agent_message' && event.payload.text === 'HOST_NATIVE_OK'))
  console.log('PASS read-only history while writer is open, native listing and independent native fork')
  mode = 'mcp'; toolReturned = false
  const forkRunner = make('fork-local-caller', fork.nativeId)
  const forkEvents: UAEvent[] = []; forkRunner.on('event', event => forkEvents.push(event))
  await forkRunner.startTurn('Read the scoped MCP caller.')
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('fork-local-caller'), 'forked native agent receives its own MCP caller: ' + JSON.stringify(forkEvents.filter(event => ['error', 'tool_call'].includes(event.type))))
  mode = 'mcp'; toolReturned = false
  await runner.startTurn('Read the original scoped MCP caller.')
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('native-test'))
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes('fork-local-caller'), 'parallel sessions cannot borrow each other\'s caller')
  console.log('PASS real MCP invocation, forked-agent mounting and independent caller isolation')
  const duplicate = make('duplicate', nativeId)
  await assert.rejects(duplicate.probeSession(), /正在被其他应用使用/)
  await duplicate.disposeAndWait()
  mode = 'tool'; toolReturned = false
  await runner.startTurn('Read proof.txt with the read tool.')
  assert.equal(done.failed, false)
  assert.ok(events.some(e => e.type === 'tool_call' && JSON.stringify(e.payload).includes('NATIVE_TOOL_PROOF')), JSON.stringify(events.filter(e => e.type === 'tool_call')))
  console.log('PASS native tool executes and returns actual file contents; duplicate writer rejects')
  await runner.updateConfig({ ...config, permissionMode: 'ask' })
  for (const decision of ['approve', 'reject']) {
    mode = decision; toolReturned = false
    const pending = new Promise<UAEvent>((resolve, reject) => {
      const timer = setTimeout(() => { runner.off('event', listener); reject(new Error('Native approval timed out')) }, 15_000)
      timer.unref()
      const listener = (event: UAEvent) => { if (event.type === 'approval_request' && event.state === 'pending') { clearTimeout(timer); runner.off('event', listener); resolve(event) } }
      runner.on('event', listener)
    })
    const operation = runner.startTurn('Execute the requested isolated test command.')
    const approval = await Promise.race([pending, operation.then(() => { throw new Error('Native turn ended without expected approval: ' + JSON.stringify(events.filter(event => event.type === 'command_exec').slice(-2))) })])
    await assert.rejects(access(join(root, decision + '.txt')), { code: 'ENOENT' })
    assert.equal(runner.isRunning(), true)
    const reply = await runner.respondResult(approval.payload.requestId, { outcome: { outcome: 'selected', optionId: decision === 'approve' ? 'allow_once' : 'reject_once' } })
    assert.equal(reply.handled, true)
    await operation
    if (decision === 'approve') assert.equal(await readFile(join(root, 'approve.txt'), 'utf8'), 'approved')
    else await assert.rejects(access(join(root, 'reject.txt')), { code: 'ENOENT' })
    console.log(`PASS native tool ${decision}: no write before decision, correct execution afterward`)
  }
  mode = 'question'; toolReturned = false
  const question = new Promise<UAEvent>(resolve => {
    const listener = (event: UAEvent) => { if (event.type === 'approval_request' && event.payload.kind === 'question' && event.state === 'pending') { runner.off('event', listener); resolve(event) } }
    runner.on('event', listener)
  })
  const questioning = runner.startTurn('Ask the test question before proceeding.')
  const asked = await Promise.race([question, questioning.then(() => { throw new Error('Question tool completed without asking') })])
  assert.equal((await runner.respondResult(asked.payload.requestId, { answers: [{ id: 'choice', selected: [], custom: 'CUSTOM_NATIVE_ANSWER' }] })).handled, true)
  await questioning
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('CUSTOM_NATIVE_ANSWER'))
  console.log('PASS native question delivers exact free-text answer back to the model')
  mode = 'text'
  await runner.startTurn('Inspect the attached file.', [{ kind: 'file', path: join(root, 'proof.txt'), name: 'proof.txt' }])
  assert.equal(done.failed, false)
  const uploaded = await loadDeepSeekHostHistory(nativeId, client)
  assert.ok(uploaded.events.some(event => event.type === 'user_message' && event.payload.content?.some((block: any) => block.type === 'file')))
  await runner.updateConfig({ ...config, collaborationMode: 'plan' })
  assert.ok(events.some(event => event.payload.kind === 'collaboration_mode' && event.payload.active === true))
  await runner.updateConfig({ ...config, collaborationMode: 'default' })
  console.log('PASS native staged file attachment persists and Plan mode switches both ways')
  mode = 'hold'
  const inFlight = runner.startTurn('Wait for a slow response')
  while (!heldResponse) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(runner.isRunning(), true, 'HTTP prompt acceptance cannot finish a turn')
  assert.equal((await runner.steer('Use the steered test instruction.')).appendedToTurn, true)
  runner.interrupt(); await inFlight
  assert.equal(done.interrupted, true)
  heldResponse.destroy(); heldResponse = undefined
  console.log('PASS cancellation waits for native turn/end rather than request acknowledgement')
  await runner.disposeAndWait()
  mode = 'mcp'; toolReturned = false
  const resumed = make('resumed', nativeId)
  const resumedEvents: UAEvent[] = []; resumed.on('event', event => resumedEvents.push(event))
  await resumed.startTurn('Continue')
  assert.ok(resumedEvents.some(e => e.type === 'agent_message' && e.payload.text === 'HOST_NATIVE_OK'))
  assert.ok(requests.at(-1).messages.length > 1, 'native context survives runner recreation')
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('resumed'), 'resumed agent MCP uses the new local caller')
  console.log('PASS same native session context resumes after runner disposal')
} finally {
  clearTimeout(timeout)
  for (const runner of runners) await runner.disposeAndWait()
  await host?.stop()
  heldResponse?.destroy(); model.closeAllConnections()
  await new Promise<void>(resolve => model.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
