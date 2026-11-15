import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'task-delivery-mcp-'))
process.env.UNIAGENT_USER_DATA = root
const handoff = await import('../src/main/handoff')
handoff.ensureHandoffServer()
const env = Object.fromEntries(handoff.handoffMcpServers('current')[0].env.map(pair => [pair.name, pair.value]))
const deliveryInbox = join(root, 'task-delivery-inbox')
delete env.ELECTRON_RUN_AS_NODE
// Previously injected credentials must not restore the removed tool.
const child = spawn(process.execPath, [handoff.handoffServerPath()], { env: { ...process.env, ...env,
  UNIAGENT_TASK_DELIVERY_TOKEN: 'stale-token', UNIAGENT_TASK_DELIVERY_INBOX: deliveryInbox,
  UNIAGENT_TASK_DELIVERY_RESULTS: join(root, 'task-delivery-results') }, stdio: ['pipe','pipe','pipe'] })
let sequence = 0, buffer = '', stderr = ''
const pending = new Map<number, (message: any) => void>()
child.stderr.on('data', data => { stderr = (stderr + data).slice(-1000) })
child.stdout.on('data', data => {
  buffer += data
  let end: number
  while ((end = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(value.id)?.(value) }
})
const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP timeout: ' + stderr)) }, 6000)
  pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value) })
  child.stdin.write(JSON.stringify({ jsonrpc:'2.0', id, method, params }) + '\n')
})
const call = (args: object) => rpc('tools/call', { name: 'task_delivery', arguments: args })
try {
  const list = (await rpc('tools/list', {})).result.tools
  assert.equal(list.some((tool: any) => tool.name === 'task_delivery'), false)
  assert.equal(list.some((tool: any) => tool.name === 'uniagent_query'), true)
  for (const args of [{ action:'context' }, { action:'report', operationId:'real-mcp-report', inputRevision:'old', resultVersion:1,
    summary:'显式交付', deliverables:['说明与实现'], verification:{passed:['相关验证'],failed:[],unverified:['发布回归']} }
  ]) {
    const reply = await call(args)
    assert.equal(reply.error?.code, -32602)
    assert.match(reply.error?.message, /unknown tool: task_delivery/)
  }
  await assert.rejects(access(deliveryInbox), { code: 'ENOENT' })
  assert.equal(Object.keys(env).some(key => key.startsWith('UNIAGENT_TASK_DELIVERY_')), false)
  for (const adapter of ['codex', 'traex', 'claude']) {
    assert.equal(handoff.handoffMcpArgs(adapter, 'current').some(arg => arg.includes('UNIAGENT_TASK_DELIVERY_')), false, adapter)
  }
} finally {
  child.stdin.end(); child.kill('SIGTERM')
  await new Promise(resolve => { if (child.exitCode !== null) resolve(null); else child.once('exit', resolve) })
  await rm(root, { recursive:true, force:true })
}
console.log('PASS removed delivery tool is undiscoverable and uncallable with stale credentials; no inbox writes or adapter injection, other MCP tools remain available')
