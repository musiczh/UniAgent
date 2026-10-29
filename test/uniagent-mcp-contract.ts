import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'uniagent-mcp-contract-'))
process.env.UNIAGENT_USER_DATA = root
const handoff = await import('../src/main/handoff.ts')
handoff.ensureHandoffServer()
const catalog = {
  agents: [{ id: 'codex', name: 'Codex', adapter: 'codex', capabilities: { steer: true }, permissionModes: ['ask'],
    models: [{ id: 'model-1', label: 'Model 1', efforts: ['low', 'high'], defaultEffort: 'high' }] }],
  roles: [
    { role: { id: 'reviewer', name: '审查员', agentId: 'codex', instructions: '只读审查代码', permissionMode: 'read-only', skills: ['review'] }, executable: true },
    { role: { id: 'offline', name: '未安装', agentId: 'missing' }, executable: false, unavailableReason: 'Agent 未安装' }
  ],
  presets: [{ id: 'review', name: '代码评审', prompt: '检查边界问题' }],
  projects: [{ id: 'project', name: '项目', primaryDirectory: root, additionalDirectories: ['/extra'] }]
}
await writeFile(handoff.handoffCatalogPath(), JSON.stringify(catalog))
const source = (await readFile(handoff.handoffServerPath(), 'utf8'))
  .replace('startedAt + 3 * 60 * 60 * 1000', 'startedAt + 350')
  .replace('now + 10 * 60 * 1000', 'now + 100')
  .replaceAll('setTimeout(tick, 400)', 'setTimeout(tick, 10)')
const server = join(root, 'test-server.cjs')
await writeFile(server, source)
const child = spawn(process.execPath, [server], {
  env: { ...process.env, UNIAGENT_HANDOFF_INBOX: handoff.handoffInboxDir(),
    UNIAGENT_HANDOFF_RESULTS: handoff.handoffResultsDir(), UNIAGENT_CATALOG: handoff.handoffCatalogPath() },
  stdio: ['pipe', 'pipe', 'pipe']
})
let seq = 0
let buffer = ''
let stderr = ''
const received = new Map<number, any>()
const pending = new Map<number, (message: any) => void>()
child.stderr.on('data', chunk => { stderr += chunk.toString() })
child.stdout.on('data', chunk => {
  buffer += chunk.toString()
  let end: number
  while ((end = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    received.set(message.id, message)
    pending.get(message.id)?.(message)
  }
})
function send(id: number, method: string, params: unknown): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
}
function rpc(method: string, params: unknown): Promise<any> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${id} timed out: ${stderr}`)) }, 3000)
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message) })
    send(id, method, params)
  })
}
const call = (name: string, args: object) => rpc('tools/call', { name, arguments: args })
const value = (message: any) => { assert.ok(message.result, JSON.stringify(message)); return JSON.parse(message.result.content[0].text) }
const query = async (args: object) => value(await call('uniagent_query', args))
const task = async (args: object) => value(await call('uniagent_task', args))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function state(id: string, status: string, text = '', ts = Date.now()): Promise<void> {
  await writeFile(join(handoff.handoffResultsDir(), id + '.json'), JSON.stringify({ status, text, ts, sessionId: 'session-' + id }))
}
try {
  const tools = (await rpc('tools/list', {})).result.tools
  assert.deepEqual(tools.map((tool: any) => tool.name).sort(), ['send_to_feishu', 'send_to_weixin', 'uniagent_query', 'uniagent_task'])
  assert.deepEqual(tools.find((tool: any) => tool.name === 'send_to_weixin').inputSchema, tools.find((tool: any) => tool.name === 'send_to_feishu').inputSchema)
  assert.equal((await call('send_to_weixin', { text: 'missing caller' })).error.code, -32000)
  assert.deepEqual(tools.find((tool: any) => tool.name === 'uniagent_task').inputSchema.properties.action.enum, ['create', 'followup', 'stop', 'get'])
  assert.equal(tools.find((tool: any) => tool.name === 'uniagent_task').inputSchema.properties.wait.type, 'boolean')

  const directory = await query({ action: 'list' })
  assert.deepEqual(directory.agents, [{ id: 'codex', name: 'Codex' }])
  assert.deepEqual(directory.roles, [
    { id: 'reviewer', name: '审查员', agentId: 'codex', executable: true },
    { id: 'offline', name: '未安装', agentId: 'missing', executable: false, unavailableReason: 'Agent 未安装' }
  ])
  assert.deepEqual(directory.presets, [{ id: 'review', name: '代码评审' }])
  assert.deepEqual(directory.projects, [{ id: 'project', name: '项目' }])
  assert.deepEqual(await query({ action: 'list', type: 'agent' }), { agents: directory.agents })
  const agent = (await query({ action: 'detail', type: 'agent', id: 'codex' })).item
  assert.deepEqual(agent.models, catalog.agents[0].models)
  assert.deepEqual(agent.permissionModes, ['ask'])
  assert.equal(agent.capabilities.steer, true)
  const role = (await query({ action: 'detail', type: 'role', id: 'reviewer' })).item
  assert.equal(role.instructions, '只读审查代码')
  assert.deepEqual(role.skills, ['review'])
  assert.equal(role.executable, true)
  assert.equal((await query({ action: 'detail', type: 'role', id: 'offline' })).item.unavailableReason, 'Agent 未安装')
  assert.equal((await query({ action: 'detail', type: 'preset', id: 'review' })).item.prompt, '检查边界问题')
  assert.deepEqual((await query({ action: 'detail', type: 'project', id: 'project' })).item.additionalDirectories, ['/extra'])
  for (const args of [{ action: 'detail', type: 'agent', id: 'missing' }, { action: 'detail', id: 'codex' },
    { action: 'list', id: 'codex' }, { action: 'list', type: 'unknown' }, { action: 'wrong' }]) {
    assert.equal((await call('uniagent_query', args)).error.code, -32602)
  }
  for (const args of [{ action: 'get', taskId: '../outside' }, { action: 'get', taskId: 'x', wait: 'true' },
    { action: 'get', taskId: 'x', timeout: -1 }, { action: 'get', taskId: 'x', prompt: 'wrong' },
    { action: 'stop', taskId: 'x', wait: true }, { action: 'create', taskId: 'x', prompt: 'wrong' },
    { action: 'followup', prompt: 'missing id' }, { action: 'unknown' },
    { action: 'create', role: 'reviewer', agent: 'codex', prompt: 'cannot override' }]) {
    assert.equal((await call('uniagent_task', args)).error.code, -32602, JSON.stringify(args))
  }
  assert.ok((await call('send_to_feishu', { text: 'hi' })).error, 'Feishu must still require the caller session')

  const missing = await task({ action: 'get', taskId: 'missing', wait: true })
  assert.equal(missing.status, 'unknown')
  assert.equal(missing.done, false)
  await state('running', 'running', '执行中')
  const immediate = await task({ action: 'get', taskId: 'running' })
  assert.equal(immediate.status, 'running')
  assert.equal(immediate.latestReply, '执行中')
  assert.equal(immediate.done, false)

  for (const [status, expected] of [['idle', 'completed'], ['error', 'failed'], ['interrupted', 'stopped']]) {
    await state('wait-' + status, 'running')
    let resolved = false
    const waiting = task({ action: 'get', taskId: 'wait-' + status, wait: true, timeout: 0.02 }).then(result => { resolved = true; return result })
    await sleep(55)
    assert.equal(resolved, false, 'a healthy running task must keep waiting beyond its first wait window')
    await state('wait-' + status, status, '最终回复-' + status)
    const result = await waiting
    assert.equal(result.done, true)
    assert.equal(result.status, expected)
    assert.equal(result.latestReply, '最终回复-' + status)
    assert.equal(result.timedOut, undefined)
    assert.equal((await task({ action: 'get', taskId: 'wait-' + status, wait: true })).done, true)
  }
  await state('stale', 'running', '保留已有输出', Date.now() - 90_000)
  const timedOut = await task({ action: 'get', taskId: 'stale', wait: true, timeout: 0.02 })
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.hardLimit, false)
  assert.equal(timedOut.done, false)
  assert.equal(timedOut.latestReply, '保留已有输出')
  assert.equal(timedOut.stale, true)
  await state('hard-limit', 'running')
  const hardLimit = await task({ action: 'get', taskId: 'hard-limit', wait: true, timeout: 0.02 })
  assert.equal(hardLimit.timedOut, true)
  assert.equal(hardLimit.hardLimit, true)
  assert.equal(hardLimit.done, false)

  await state('cancel', 'running')
  send(9000, 'tools/call', { name: 'uniagent_task', arguments: { action: 'get', taskId: 'cancel', wait: true } })
  await sleep(25)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9000 } }) + '\n')
  await rpc('ping', {})
  await state('cancel', 'idle', '取消等待后任务自行完成')
  await sleep(40)
  assert.equal(received.has(9000), false, 'a cancelled waiter must never deliver a later result')
  assert.equal((await task({ action: 'get', taskId: 'cancel' })).latestReply, '取消等待后任务自行完成')
} finally {
  child.kill()
  handoff.handoffTaskStore.close()
  await rm(root, { recursive: true, force: true })
}
console.log('uniagent-mcp-contract: ok')
