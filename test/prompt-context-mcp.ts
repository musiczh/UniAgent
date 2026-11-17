import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { ensureHandoffServer, handoffMcpServers, watchContextInbox, buildUniAgentSessionInstructions } from '../src/main/handoff'

const roster = buildUniAgentSessionInstructions({ agents: [{ id: 'codex', name: 'Codex' }], roles: [{ executable: true, role: { id: 'kitty', name: 'kitty', agentId: 'codex' } }] })
ensureHandoffServer()
assert.equal(roster, '你通过 UniAgent 服务用户。\n\nUniAgent MCP 可使用对象：\n角色：["kitty"]\nAgent：["Codex"]')
const stop = watchContextInbox(async sessionId => {
  if (sessionId !== 'context-caller') throw new Error('unexpected-caller')
  return { sessionId, agentId: 'codex', model: 'fixture-model', channel: 'app', workspace: { workdir: '/fixture' } }
})
const descriptor = handoffMcpServers('context-caller').find(server => server.name === 'uniagent')!
const child = spawn(descriptor.command, descriptor.args, { env: { ...process.env, ...Object.fromEntries(descriptor.env.map(row => [row.name, row.value])) }, stdio: ['pipe', 'pipe', 'pipe'] })
const lines = createInterface({ input: child.stdout })
let id = 0
function request(method: string, params: unknown): Promise<any> {
  const requestId = ++id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { lines.removeListener('line', receive); reject(new Error('MCP response timeout')) }, 5000)
    const receive = (line: string) => {
      const value = JSON.parse(line)
      if (value.id !== requestId) return
      clearTimeout(timer); lines.removeListener('line', receive); resolve(value)
    }
    lines.on('line', receive)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
  })
}
try {
  await request('initialize', { protocolVersion: '2024-11-05' })
  const tools = (await request('tools/list', {})).result.tools
  assert.deepEqual(tools.find((tool: any) => tool.name === 'uniagent_query').inputSchema.properties.action.enum, ['list', 'detail', 'context'])
  const result = await request('tools/call', { name: 'uniagent_query', arguments: { action: 'context' } })
  assert.deepEqual(JSON.parse(result.result.content[0].text), { sessionId: 'context-caller', agentId: 'codex', model: 'fixture-model', channel: 'app', workspace: { workdir: '/fixture' } })
  const crossSession = await request('tools/call', { name: 'uniagent_query', arguments: { action: 'context', id: 'other-session' } })
  assert.equal(crossSession.error.code, -32602, 'context cannot query another caller')
  const list = await request('tools/call', { name: 'uniagent_query', arguments: { action: 'list', type: 'agent' } })
  assert.ok(Array.isArray(JSON.parse(list.result.content[0].text).agents), 'existing directory queries remain usable')
  console.log('PASS current context MCP, name-only roster, caller isolation and existing list queries')
} finally { stop(); lines.close(); child.kill('SIGTERM') }
