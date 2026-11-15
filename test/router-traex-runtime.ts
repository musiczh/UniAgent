import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommand, TurnRunner } from '../src/main/adapter'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { RouterMcpBridge, routerMcpServers } from '../src/main/router/mcp'
import { parseCodexConfig } from '../src/main/codexSourceConfig'
import { ROUTER_SYSTEM_PROMPT } from '../src/shared/router'
import type { AgentDef, SessionConfig, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-router-traex-'))
const calls: Array<{ tool: string; args: unknown }> = []
const bridge = new RouterMcpBridge(root, async (tool, args) => {
  calls.push({ tool, args })
  return { ok: true, marker: 'router-tool-result' }
})
await bridge.bind('router-traex-runtime')
const config: SessionConfig = { agentId: 'traex', model: 'vision', effort: 'high', workdir: root, permissionMode: 'full-access', managedPurpose: 'router' }
const image = { kind: 'image' as const, name: 'input.png', path: join(root, 'input.png') }
await writeFile(image.path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGNQaPj/Hx9mGBkKAACSp4HBeljbAAAAAElFTkSuQmCC', 'base64'))
const binary = join(root, 'traex')
await writeFile(binary, '#!/usr/bin/env node\n' + `
  const args=process.argv.slice(2),end=args.indexOf('--');
  if(args.includes('mcp'))throw Error('Router must not inspect native MCP to disable it');
  if(end>=0&&args.length!==end+2)throw Error('Options must precede the prompt separator');
  if(args.includes('--disallowed-tool')||args.includes('--ignore-rules'))throw Error('Router must retain native tools and rules');
  console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-native-router'}));
  console.log(JSON.stringify({type:'item.completed',item:{id:'reply',type:'agent_message',text:'已读取路由配置'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:4}}));
`, { mode: 0o700 })
const agent = { id: 'traex', name: 'TraeX', adapter: 'traex', installed: true, bin: binary, builtin: true,
  models: [{ id: 'vision', label: 'Vision', efforts: ['high'], imageInput: true }],
  capabilities: { startupSystemPrompt: true, streaming: true, modelSelect: true, reasoningEffort: true, permissionModes: [{ id: 'full-access', label: '自动', hint: '' }] } } as AgentDef

async function turn(selected: AgentDef, value: SessionConfig, resumeId?: string): Promise<{ nativeSessionId?: string; events: UAEvent[] }> {
  const runner = new TurnRunner('router-traex-runtime', { n: 0 }), events: UAEvent[] = []
  runner.on('event', event => events.push(event))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = new Promise<{ nativeSessionId?: string }>((resolve, reject) => {
      timer = setTimeout(() => { runner.interrupt(); reject(new Error('TraeX Router turn timed out')) }, 30_000)
      runner.once('done', resolve)
    })
    runner.start(selected, value, '读取这一项新输入的路由证据。', resumeId, [image])
    const done = await result
    assert.equal(events.some(event => event.type === 'error'), false, JSON.stringify(events.filter(event => event.type === 'error')))
    return { ...done, events }
  } finally { clearTimeout(timer) }
}

try {
  for (const resumeId of [undefined, 'fixture-native-router']) {
    const launch = buildCommand(agent, config, 'route', resumeId, [image], 'router-traex-runtime')
    assert.deepEqual(launch.args.slice(0, resumeId ? 3 : 1), resumeId ? ['exec', 'resume', resumeId] : ['exec'])
    assert.equal(launch.args[launch.args.indexOf('-i') + 1], image.path)
    assert.deepEqual(launch.args.slice(-2), ['--', 'route'], 'the variadic native image flag must not consume the prompt as another image')
    assert.equal(launch.appendedPrompt, ROUTER_SYSTEM_PROMPT)
    assert.ok(!launch.args.includes('--ignore-rules'))
    assert.ok(!launch.args.includes('--allowed-tool'), 'TraeX allowed-tool is a Bash permission, not a tool allowlist')
    assert.ok(!launch.args.includes('--disallowed-tool'))
    assert.ok(!launch.args.includes('mcp_servers={}'))
    const overrides = parseCodexConfig(launch.args.filter((_arg, index) => launch.args[index - 1] === '-c').join('\n'))
    assert.deepEqual(Object.keys(overrides.mcp_servers).sort(), ['uniagent', 'uniagent-router'])
    assert.equal(overrides.model_tool_modes, undefined)
    assert.equal(overrides.mcp_servers['uniagent-router'].env.UNIAGENT_ROUTER_ENDPOINT, routerMcpServers('router-traex-runtime')![0].env.find(row => row.name === 'UNIAGENT_ROUTER_ENDPOINT')!.value)
    for (const feature of ['hooks', 'plugins', 'computer_use', 'browser_use', 'code_mode']) assert.equal(overrides.features?.[feature], undefined)
  }
  assert.throws(() => buildCommand(agent, config, 'route', undefined, [image], 'expired-router-session'), /工具资格已失效/)
  const ordinary = buildCommand(agent, { ...config, managedPurpose: undefined }, 'ordinary', undefined, undefined, 'ordinary-traex')
  assert.ok(!ordinary.args.includes('mcp_servers={}'))
  assert.ok(!ordinary.args.includes('--disallowed-tool'))
  assert.ok(!ordinary.args.some(arg => arg.startsWith('model_tool_modes=')), 'ordinary TraeX sessions retain their native tool mode')
  const host = new Orchestrator(() => agent, new SessionStore(join(root, 'sessions.json')), root, join(root, 'logs'))
  try {
    const session = host.createRouterDraft(config, 'router-traex-runtime')
    assert.equal((host as any).prepareCurrentAgentRun(session, {}).route, 'one-shot')
    const regular = (host as any).createSessionRecord({ ...config, managedPurpose: undefined }, '普通任务').session
    assert.equal((host as any).prepareCurrentAgentRun(regular, {}).route, 'app-server')
    host.disposeSession(regular.id)
  } finally { await host.closeSessionLogs() }
  const first = await turn(agent, config), second = await turn(agent, config, first.nativeSessionId)
  assert.equal(first.nativeSessionId, 'fixture-native-router'); assert.equal(second.nativeSessionId, first.nativeSessionId)
  assert.ok(first.events.some(event => event.type === 'agent_message' && event.payload.text === '已读取路由配置'))
  const capability = routerMcpServers('router-traex-runtime')![0].env.find(row => row.name === 'UNIAGENT_ROUTER_TOKEN')!.value
  assert.ok(!JSON.stringify([...first.events, ...second.events]).includes(capability), 'launch events must not expose Router capability tokens')
  console.log('PASS TraeX Router native tools/config, additive MCP, images, native resume, expired scope and token redaction')

  if (process.env.UNIAGENT_ROUTER_TRAEX_NATIVE === '1') {
    const previousHome = process.env.TRAE_HOME
    const home = join(root, 'native'); await mkdir(join(home, 'cli'), { recursive: true })
    const catalog = JSON.parse(await readFile(join(previousHome || join(homedir(), '.trae'), 'cli', 'models_cache.json'), 'utf8'))
    const models = ['GPT-5.6-Luna', 'DeepSeek-V4.1-Flash'].map(slug => {
      const model = catalog.models.find((row: any) => row.slug === slug)
      assert.ok(model, `native qualification needs ${slug} in the installed CLI model catalog`)
      return model
    })
    await writeFile(join(home, 'models.json'), JSON.stringify({ models }))
    const captures: any[] = []
    let responseIndex = 0
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      if (!request.url?.endsWith('/responses')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return }
      const body = JSON.parse(raw)
      const routing = body.input?.some((item: any) => item.content?.some((block: any) => block.type === 'input_image'))
      const phase = routing ? captures.length % 3 : 2
      if (routing) captures.push(body)
      const replyIndex = ++responseIndex
      const item = phase < 2 ? {
        id: 'fc-' + replyIndex, type: 'function_call', status: 'completed', call_id: 'call-' + replyIndex,
        name: phase === 0 ? 'mcp__uniagent_router__router_query' : 'mcp__uniagent_router__router_assign_task',
        arguments: JSON.stringify(phase === 0 ? { requestId: 'fixture-request', mode: 'bootstrap' }
          : { requestId: 'fixture-request', version: 1, action: 'clarify', reason: '缺少归属', clarification: '请选择归属' })
      } : { id: 'msg-' + replyIndex, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: routing ? '已完成路由协议验证' : '辅助模型请求已完成', annotations: [] }] }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [type, data] of [
        ['response.created', { response: { id: 'resp-fixture-' + replyIndex, object: 'response', status: 'in_progress', output: [] } }],
        ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
        ['response.output_item.done', { output_index: 0, item }],
        ['response.completed', { response: { id: 'resp-fixture-' + replyIndex, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } }]
      ] as const) response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
      response.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + (server.address() as any).port + '/v1'
    await writeFile(join(home, 'traecli.toml'), 'model_provider="fixture"\nmodel_catalog_json=' + JSON.stringify(join(home, 'models.json')) +
      '\n[mcp_servers."forbidden.with.dot"]\ncommand=' + JSON.stringify(process.execPath) + '\nargs=' + JSON.stringify([join(root, 'router-mcp.cjs')]) + '\n' +
      '[model_providers.fixture]\nname="Fixture"\nbase_url=' + JSON.stringify(base) + '\nwire_api="responses"\nexperimental_bearer_token="fixture"\nrequires_openai_auth=false\nsupports_websockets=false\n')
    process.env.TRAE_HOME = home
    try {
      const native = { ...agent, bin: process.env.UNIAGENT_ROUTER_TRAEX_BIN || join(homedir(), '.local/bin/traex') }
      for (const model of models) {
        captures.length = 0; calls.length = 0
        const value = { ...config, model: model.slug }
        const auxiliary = await fetch(base + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.slug, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'auxiliary fixture probe' }] }], tools: [] }) })
        const auxiliaryResponse = await auxiliary.text()
        assert.doesNotMatch(auxiliaryResponse, /function_call/, 'an auxiliary model response must not route a business request')
        assert.equal(captures.length, 0, 'auxiliary model requests must not advance the routing fixture')
        const initial = await turn(native, value)
        assert.ok(initial.nativeSessionId)
        const resumed = await turn(native, value, initial.nativeSessionId)
        assert.equal(resumed.nativeSessionId, initial.nativeSessionId)
        assert.equal(captures.length, 6, `${model.slug}: initial and resumed turns must each execute query and assignment`)
        assert.deepEqual(calls.map(call => call.tool), ['router_query', 'router_assign_task', 'router_query', 'router_assign_task'])
        assert.deepEqual(calls[0].args, { requestId: 'fixture-request', mode: 'bootstrap' })
        for (const request of captures) {
          const tools = request.tools.flatMap((tool: any) => tool.type === 'namespace' ? tool.tools.map((row: any) => tool.name + row.name) : [tool.name || tool.type])
          assert.ok(tools.some((name: string) => /(?:exec|Read|Bash)$/.test(name)), 'native tools remain available')
          assert.match(JSON.stringify(request), /mcp__forbidden_with_dot/, 'native MCP remains discoverable by the model')
          assert.match(JSON.stringify(request), /mcp__uniagent_router/, 'Router MCP remains discoverable by the model')
          const images = request.input.flatMap((item: any) => item.content || []).filter((block: any) => block.type === 'input_image')
          assert.ok(images.some((block: any) => typeof block.image_url === 'string' && block.image_url.startsWith('data:image/')), 'the native model request must include image content')
          assert.equal(request.model, value.model, 'exec -m uses the selected native model slug')
        }
        assert.ok(![...initial.events, ...resumed.events].some(event => event.type === 'system_notice' && /Code Mode is unavailable/.test(String(event.payload.text))))
        for (const index of [1, 2, 4, 5]) assert.ok(captures[index].input.some((item: any) => item.type === 'function_call_output' && JSON.stringify(item.output).includes('router-tool-result')), 'the model must receive the actual MCP result')
        console.log(`PASS installed TraeX ${model.slug} exec and resume: query/assignment, native tools and MCP, images and native history`)
      }
    } finally {
      if (previousHome === undefined) delete process.env.TRAE_HOME; else process.env.TRAE_HOME = previousHome
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
} finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
