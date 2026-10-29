import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { GrokACPRunner } from '../src/main/grokACPRunner.ts'
import type { AgentDef, UAEvent } from '../src/shared/types.ts'

// Exercise an explicitly selected official CLI with an isolated native home and local model.
const bin = process.env.UNIAGENT_MCODE_TEST_BIN
if (!bin) throw new Error('Set UNIAGENT_MCODE_TEST_BIN to the official CLI being qualified')
const root = await mkdtemp(join(tmpdir(), 'ua-mcode-native-'))
const home = join(root, 'home'), workdir = join(root, 'workspace'), data = join(home, '.minimax')
await mkdir(workdir, { recursive: true }); await mkdir(home)
const env = { PATH: process.env.PATH, HOME: home, MINIMAX_DATA_DIR: data, MCODE_PROVIDER_API_KEY: 'ua-local-model-fixture-credential-only', UNIAGENT_USER_DATA: join(root, 'app') }
const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
Object.assign(process.env, env)
let mode: 'text' | 'write' | 'permission' | 'hold' = 'text', requests = 0, mainRequests = 0, allow = false, toolIssued = false, fixtureError: string | undefined
const events: UAEvent[] = []
const notifications: any[] = []
const server = createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk
  const body = text ? JSON.parse(text) : {}
  if (!Array.isArray(body.messages)) { response.end(JSON.stringify({ data: [] })); return }
  requests++
  const titleTool = body.tools?.find((tool: any) => tool.name === 'submit_session_title')
  if (!titleTool) mainRequests++
  if (mode === 'hold' && !titleTool) return
  const toolResult = toolIssued
  const tool = titleTool || (['write', 'permission'].includes(mode) && !toolResult ? body.tools?.find((tool: any) => tool.name === (mode === 'write' ? 'write' : 'bash')) : undefined)
  if (['write', 'permission'].includes(mode) && !toolResult && !tool) {
    fixtureError = 'Fixture requires a direct tool; actual tools: ' + JSON.stringify(body.tools?.map((tool: any) => ({ name: tool.name, function: tool.function?.name, type: tool.type })))
    response.writeHead(500); response.end(JSON.stringify({ error: { message: 'fixture tool configuration mismatch' } })); return
  }
  if (tool && !titleTool) toolIssued = true
  const frames = [
    { type: 'message_start', message: { id: 'msg_ua_local_' + requests, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'write-' + requests, name: tool.name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(titleTool ? { title: 'Native qualification' } : mode === 'permission' ? { command: `rm -rf '${join(root, 'risky-target')}' && mkdir -p '${join(root, 'risky-target')}' && printf owned > '${join(root, 'risky-target/marker')}'`, description: 'Operate only on the isolated qualification marker' } : { path: join(workdir, 'marker.txt'), content: 'owned native fixture' }) } : { type: 'text_delta', text: 'UA_MCODE_NATIVE_OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 16 } },
    { type: 'message_stop' }
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''))
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
let runner: GrokACPRunner | undefined
const checks: string[] = []
try {
  const version = (await promisify(execFile)(bin, ['--version'], { env })).stdout.trim()
  await promisify(execFile)(bin, ['provider', 'set-minimax-key'], { env, cwd: workdir })
  const path = join(data, 'config.yaml'), config: any = yaml.load(await readFile(path, 'utf8'))
  config.minimax_api = { ...config.minimax_api, baseURL: `http://127.0.0.1:${(server.address() as any).port}/anthropic` }
  // The official data-minimal baseline exposes direct tools rather than deferred PTC.
  config.beta = { ...config.beta, ptc: false }
  config.agents = { ...config.agents, default: { ...config.agents?.default, tools: ['read', 'write', 'edit', 'bash', 'grep', 'glob'], builtinTools: [] } }
  await writeFile(path, yaml.dump(config), { mode: 0o600 })
  const agent: AgentDef = { id: 'mcode', adapter: 'mcode', name: 'MiniMax Code', bin, version, icon: '', builtin: true, models: [], capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] } }
  const sessionConfig = { agentId: 'mcode' as const, workdir, permissionMode: 'ask' as const }
  const attach = (nativeId?: string) => {
    runner = new GrokACPRunner('native-qualification', { n: 0 }, agent, sessionConfig, nativeId, env)
    runner.on('event', (event: UAEvent) => {
      events.push(event)
      if (event.type === 'approval_request' && event.state === 'pending') {
        const option = event.payload.options?.find((option: any) => option.kind === (allow ? 'allow_once' : 'reject_once'))
        assert.ok(option, 'permission must offer the native decision')
        runner!.respondResult(event.payload.requestId, { outcome: { outcome: 'selected', optionId: option.optionId } })
      }
    })
  }
  attach()
  const probe = await runner!.probeSession(false)
  ;(runner as any).connection.on('notification', (frame: any) => notifications.push(frame))
  assert.ok(probe.contract.models.length); checks.push('initialize-session-model-parameters')
  await runner!.startTurn('Return the native fixture marker')
  assert.ok(events.some(event => event.type === 'agent_message' && event.payload.text?.includes('UA_MCODE_NATIVE_OK')))
  checks.push('streamed-reply')
  mode = 'write'; await runner!.startTurn('Request the fixture write')
  assert.equal(fixtureError, undefined)
  assert.equal(await readFile(join(workdir, 'marker.txt'), 'utf8'), 'owned native fixture'); checks.push('workspace-tool-write')
  mode = 'permission'; toolIssued = false; await runner!.startTurn('Request the isolated command requiring approval')
  await assert.rejects(readFile(join(root, 'risky-target/marker')), { code: 'ENOENT' }); checks.push('denied-command')
  allow = true; toolIssued = false; await runner!.startTurn('Retry the session-denied command')
  await assert.rejects(readFile(join(root, 'risky-target/marker')), { code: 'ENOENT' })
  assert.equal(events.filter(event => event.type === 'approval_request' && event.state === 'pending').length, 1, 'native session deny rules remain authoritative')
  checks.push('native-session-denial-preserved')
  await runner!.disposeAndWait(); attach()
  const approvedProbe = await runner!.probeSession(false)
  toolIssued = false; await runner!.startTurn('Approve the isolated command in a fresh native session')
  const marker = await readFile(join(root, 'risky-target/marker'), 'utf8').catch(() => {
    throw new Error('Approved fixture command did not complete: ' + JSON.stringify(events.filter(event => ['tool_call', 'approval_request', 'error'].includes(event.type)).map(event => ({ type: event.type, state: event.state, payload: event.payload }))))
  })
  assert.equal(marker, 'owned'); checks.push('approved-command')
  await runner!.disposeAndWait(); attach(approvedProbe.nativeSessionId)
  mode = 'text'; await runner!.startTurn('Continue the native session')
  assert.equal((await runner!.probeSession(false)).nativeSessionId, approvedProbe.nativeSessionId); checks.push('native-session-resume')
  mode = 'hold'; const before = mainRequests, turn = runner!.startTurn('Hold for cancellation')
  const deadline = Date.now() + 20_000
  while (mainRequests === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(mainRequests > before); runner!.interrupt(); await turn
  assert.equal(events.filter(event => event.type === 'turn_completed').at(-1)?.state, 'cancelled'); checks.push('interrupt')
  assert.equal(events.some(event => event.type === 'error'), false)
  console.log(JSON.stringify({ version, checks, scope: 'real-cli-isolated-home-loopback-model' }))
} finally {
  await runner?.disposeAndWait(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await mkdir(join(process.cwd(), 'out/native-qualification'), { recursive: true })
  await writeFile(join(process.cwd(), 'out/native-qualification/mcode-events.json'), JSON.stringify({ events, notifications }, null, 2))
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  await rm(root, { recursive: true, force: true })
}
