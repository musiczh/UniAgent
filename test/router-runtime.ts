import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { RouterMcpBridge } from '../src/main/router/mcp'
import { handoffMcpArgs, handoffMcpServers } from '../src/main/handoff'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { buildCommand } from '../src/main/adapter'
import { claudeSdkLaunch } from '../src/main/claudeSdk'
import { qoderLaunch } from '../src/main/qoderSdk'
import { ROUTER_SYSTEM_PROMPT, routerRole } from '../src/shared/router'
import type { AgentDef, SessionConfig } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-router-runtime-'))
const bridge = new RouterMcpBridge(root, async (name, _args, sessionId) => ({ name, sessionId }))
await bridge.bind('router-runtime')
try {
  const flags = handoffMcpArgs('claude', 'router-runtime')
  const mcp = JSON.parse(flags[flags.indexOf('--mcp-config') + 1]).mcpServers
  assert.deepEqual(Object.keys(mcp).sort(), ['uniagent', 'uniagent-router'])
  assert.deepEqual(handoffMcpServers('router-runtime').map(server => server.name).sort(), ['uniagent', 'uniagent-router'])
  assert.ok(!flags.includes('--strict-mcp-config'), 'Router inherits native MCP configuration')
  const descriptor = mcp['uniagent-router']
  const child = spawn(descriptor.command, descriptor.args, { env: { ...process.env, ...descriptor.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const receive = () => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { lines.removeListener('line', onLine); reject(new Error('Router MCP stdio response timed out')) }, 3000)
    const onLine = (line: string) => { clearTimeout(timer); resolve(JSON.parse(line)) }
    lines.once('line', onLine)
  })
  try {
    let response = receive()
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n')
    assert.equal((await response).result.serverInfo.name, 'uniagent-router')
    response = receive()
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
    const tools = (await response).result.tools
    assert.deepEqual(tools.map((row: any) => row.name), ['router_query', 'router_assign_task'])
    const assignment = tools.find((row: any) => row.name === 'router_assign_task')
    assert.deepEqual(assignment.inputSchema.required, ['requestId','version','action','reason'])
    assert.deepEqual(assignment.inputSchema.allOf.map((row: any) => row.then.required), [['taskId'],['requirementId'],['projectId'],['requirementName'],['clarification','clarificationOptions']])
    assert.equal(assignment.inputSchema.properties.clarificationOptions.maxItems,6)
    assert.deepEqual(assignment.inputSchema.properties.clarificationOptions.items.required,['label'])
    assert.equal(assignment.inputSchema.properties.scopeAssessment.properties.evidenceRefs.minItems, undefined)
    assert.equal(assignment.inputSchema.properties.reuseAssessment.properties.evidenceRefs.minItems, undefined)
    response = receive()
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'router_query', arguments: {} } }) + '\n')
    assert.equal(JSON.parse((await response).result.content[0].text).sessionId, 'router-runtime')
  } finally { lines.close(); child.kill('SIGTERM') }

  const config: SessionConfig = { agentId: 'claude', model: 'vision', workdir: root, managedPurpose: 'router', permissionMode: 'full-access' }
  const agent = { id: 'claude', name: 'Claude', bin: 'claude', adapter: 'claude', version: '2.1.296', models: [],
    capabilities: { permissionModes: [{ id: 'full-access' }], modelSelect: true } } as AgentDef
  const launch = buildCommand(agent, config, 'route', undefined, undefined, 'router-runtime', undefined, true)
  const sdk = claudeSdkLaunch(agent.bin, root, launch.args, launch.env, routerRole(config))
  assert.equal(sdk.options.tools, undefined, 'native shell, filesystem and other builtin tools remain available')
  assert.equal(sdk.options.strictMcpConfig, undefined)
  assert.deepEqual(Object.keys(sdk.options.mcpServers!).sort(), ['uniagent', 'uniagent-router'])
  assert.equal(sdk.role?.toolPolicy, undefined)
  assert.equal(sdk.role?.skills, undefined)
  assert.ok(!launch.args.includes('--disallowedTools'))
  assert.equal(launch.appendedPrompt, ROUTER_SYSTEM_PROMPT)
  const qoder = qoderLaunch('qodercn', { ...config, agentId: 'qoder' }, ROUTER_SYSTEM_PROMPT, mcp)
  assert.equal(qoder.options.tools, undefined)
  assert.equal(qoder.role?.toolPolicy, undefined)
  assert.equal(qoder.role?.skills, undefined)
  assert.deepEqual(qoder.options.settingSources, ['user', 'project', 'local'])
  assert.equal(qoder.options.strictMcpConfig, undefined)

  for (const nativeServers of [
    {},
    { external: { command: '/usr/bin/true' } },
    { external: { command: '/usr/bin/true' }, uniagent: { url: 'http://127.0.0.1:1/mcp' } }
  ]) {
    const adapter = 'codex'
    class Transport extends EventEmitter {
      calls: Array<{ method: string; params: any }> = []
      async start() {}
      async request(method: string, params: any) {
        this.calls.push({ method, params })
        if (method === 'config/read') return { config: { mcp_servers: nativeServers } }
        if (method === 'thread/start') return { thread: { id: 'fresh-native-' + adapter } }
        if (method === 'turn/start') return { turn: { id: 'native-turn' } }
        return {}
      }
      notify() {} respond() {} interrupt() {} async dispose() {}
    }
    const transport = new Transport()
    const runner = new AppServerRunner('router-runtime', { n: 0 }, { ...agent, id: adapter, adapter }, { ...config, agentId: adapter }, undefined, undefined, () => transport as never)
    try {
      await runner.startTurn('route', [{ kind: 'image', name: 'input.png', path: join(root, 'input.png') }])
      const start = transport.calls.find(row => row.method === 'thread/start')!.params
      assert.equal(start.config['mcp_servers.uniagent-router.enabled'], true)
      for (const name of ['uniagent', 'external']) {
        assert.notEqual(start.config[`mcp_servers.${name}.enabled`], false, 'Router preserves native MCP servers')
      }
      assert.equal(start.config['features.shell_tool'], undefined)
      assert.equal(start.config['features.multi_agent'], undefined)
      assert.equal(start.developerInstructions, ROUTER_SYSTEM_PROMPT)
      const turn = transport.calls.find(row => row.method === 'turn/start')!.params
      assert.ok(turn.input.some((row: any) => row.type === 'localImage' && row.path.endsWith('input.png')))
    } finally { runner.dispose() }
  }
} finally { await bridge.close() }
console.log('PASS Router runtime: real MCP handshake, normal tools and settings, native images and Router system instructions across Codex/Claude/Qoder')
