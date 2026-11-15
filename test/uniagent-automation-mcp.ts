import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeAutomationInput, Session } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'uniagent-automation-mcp-'))
const originalNow = Date.now
Date.now = () => new Date(2026, 9, 29, 8).getTime()
process.env.UNIAGENT_USER_DATA = root
const handoff = await import('../src/main/handoff')
const { NativeAutomations } = await import('../src/main/nativeAutomations')
const file = join(root, 'native-automations.json')
let changes = 0
let requests = 0
const runs: NativeAutomationInput[] = []
const runtime = {
  run: async (task: NativeAutomationInput, isCurrent: () => boolean) => {
    assert.equal(isCurrent(), true)
    runs.push(task)
    return { id: 'scheduled-session', status: 'idle' } as Session
  },
  getSession: () => undefined,
  getError: async () => undefined,
  changed: () => { changes++ },
  onError: (error: unknown) => { throw error }
}
const automations = new NativeAutomations(runtime, file)
const server = handoff.ensureHandoffServer()
handoff.writeHandoffCatalog([], [], [], [{ id: 'project', name: '测试空间', primaryDirectory: root, additionalDirectories: [] } as any],
  [{ id: 'requirement', name: '测试需求', projectId: 'project', status: 'active' } as any, { id: 'archived', name: '归档需求', projectId: 'project', status: 'archived' } as any])
const child = spawn(process.execPath, [server], {
  env: { ...process.env, UNIAGENT_HANDOFF_INBOX: handoff.handoffInboxDir(),
    UNIAGENT_HANDOFF_RESULTS: handoff.handoffResultsDir(), UNIAGENT_CATALOG: join(root, 'mcp', 'catalog.json') },
  stdio: ['pipe', 'pipe', 'pipe']
})
let sequence = 0
let buffer = ''
let stderr = ''
const pending = new Map<number, (message: any) => void>()
child.stderr.on('data', chunk => { stderr += chunk.toString() })
child.stdout.on('data', chunk => {
  buffer += chunk.toString()
  let end: number
  while ((end = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    pending.get(message.id)?.(message)
  }
})
function rpc(method: string, params: unknown): Promise<any> {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${stderr}`)) }, 5000)
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const call = (args: unknown) => rpc('tools/call', { name: 'uniagent_automation', arguments: args })
const input = {
  action: 'create', name: ' 每日审查 ', prompt: ' 检查项目并汇报风险 ', schedule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=30',
  agentId: 'codex', projectId: 'project', permissionMode: 'read-only', model: 'model-1', reasoningEffort: 'high'
}
let stop: (() => void) | undefined
try {
  const tools = (await rpc('tools/list', {})).result.tools
  const tool = tools.find((item: any) => item.name === 'uniagent_automation')
  assert.ok(tool, 'MCP must advertise scheduled task creation')
  assert.match(tool.inputSchema.properties.schedule.description, /ONCE:/, 'MCP clients must discover the one-off schedule format')
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['create'])
  assert.deepEqual(tool.inputSchema.required, ['action', 'name', 'prompt', 'schedule', 'agentId', 'permissionMode'])
  assert.deepEqual(tool.inputSchema.anyOf, [{ required: ['projectId'] }, { required: ['taskScope'] }])
  assert.equal(tool.inputSchema.properties.taskScope.oneOf.length, 2)
  const directory = (await rpc('tools/call', { name: 'uniagent_query', arguments: { action: 'list', type: 'requirement' } })).result
  assert.deepEqual(JSON.parse(directory.content[0].text), { requirements: [{ id: 'requirement', name: '测试需求', projectId: 'project', status: 'active' }] })
  const detail = (await rpc('tools/call', { name: 'uniagent_query', arguments: { action: 'detail', type: 'requirement', id: 'requirement' } })).result
  assert.equal(JSON.parse(detail.content[0].text).item.projectId, 'project')
  stop = handoff.watchAutomationInbox(async args => {
    requests++
    if (args.agentId === 'offline') throw new Error('所选 Agent 当前不可用')
    return automations.create(args)
  })
  for (const invalid of [null, [], 'wrong', {}, { ...input, action: 'delete' }, { ...input, extra: true },
    { ...input, name: ' ' }, { ...input, prompt: '' }, { ...input, schedule: 123 },
    { ...input, agentId: undefined }, { ...input, projectId: '' }, { ...input, permissionMode: 'root' },
    { ...input, model: 1 }, { ...input, reasoningEffort: 'extreme' }, { ...input, dayMode: 'weekdays' },
    { ...input, projectId: undefined }, { ...input, taskScope: null }, { ...input, taskScope: [] },
    { ...input, taskScope: { kind: 'requirement', requirementId: 'requirement' } },
    { ...input, projectId: undefined, taskScope: { kind: 'requirement', requirementId: '' } },
    { ...input, projectId: undefined, taskScope: { kind: 'requirement', requirementId: 'requirement', extra: true } }]) {
    assert.equal((await call(invalid)).error?.code, -32602, JSON.stringify(invalid))
  }
  assert.equal(requests, 0, 'malformed arguments must never reach the main process')
  for (const schedule of ['not-a-schedule', '*/5 * * * *', '0 24 * * *', 'RRULE:FREQ=HOURLY']) {
    const response = await call({ ...input, schedule })
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /有效的执行计划/)
  }
  const unavailable = await call({ ...input, agentId: 'offline' })
  assert.equal(unavailable.result.isError, true)
  assert.match(unavailable.result.content[0].text, /Agent 当前不可用/)
  assert.equal(automations.list().length, 0, 'rejected creation must not persist a task')
  assert.equal(changes, 0)

  for (const taskScope of [{ kind: 'space', projectId: 'project' }, { kind: 'requirement', requirementId: 'requirement' }]) {
    const response = await call({ ...input, projectId: undefined, taskScope })
    assert.equal(response.result.isError, undefined)
    const created = JSON.parse(response.result.content[0].text)
    assert.deepEqual(created.taskScope, taskScope)
    assert.equal(created.projectId, taskScope.kind === 'space' ? 'project' : undefined)
    assert.deepEqual(automations.get(created.id)?.taskScope, taskScope)
    automations.delete(created.id)
  }
  changes = 0

  for (const schedule of ['ONCE:2026-10-28T09:00:00+08:00', 'ONCE:2026-02-30T09:00:00Z',
    'ONCE:2026-10-31T09:30:00']) {
    const response = await call({ ...input, schedule })
    assert.equal(response.result.isError, true, schedule)
  }
  const oneOffTime = new Date(Date.now() + 30 * 60_000)
  const onceResponse = await call({ ...input, schedule: `ONCE:${oneOffTime.toISOString()}` })
  const once = JSON.parse(onceResponse.result.content[0].text)
  assert.equal(once.nextRunAt, oneOffTime.getTime(), 'MCP must persist the exact one-off instant')
  assert.equal(once.nextRunAtIso, oneOffTime.toISOString())
  assert.equal(once.dayMode, 'all')
  assert.equal(automations.get(once.id)?.schedule, `ONCE:${oneOffTime.toISOString()}`)
  const filteredOnce = await call({ ...input, schedule: once.schedule, dayMode: 'workday' })
  assert.equal(filteredOnce.result.isError, true)
  assert.match(filteredOnce.result.content[0].text, /一次性.*筛选/)
  automations.delete(once.id)
  changes = 0

  for (const [schedule, dayMode] of [[input.schedule, 'workday'], ['30 9 * * 1-5', 'all'], ['0 15 10 1,15 * *', 'non-workday']]) {
    const response = await call({ ...input, schedule, dayMode })
    assert.equal(response.result.isError, undefined)
    const created = JSON.parse(response.result.content[0].text)
    assert.match(created.id, /^uniagent:/)
    assert.equal(created.source, 'uniagent')
    assert.equal(created.status, 'active')
    assert.equal(created.dayMode, dayMode)
    assert.equal(created.name, input.name.trim())
    assert.equal(created.prompt, input.prompt.trim())
    for (const key of ['schedule', 'agentId', 'projectId', 'permissionMode', 'model', 'reasoningEffort']) {
      assert.equal(created[key], key === 'schedule' ? schedule : input[key as keyof typeof input])
    }
    assert.ok(created.nextRunAt > Date.now())
    assert.equal(created.nextRunAtIso, new Date(created.nextRunAt).toISOString())
    assert.equal(created.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
    const date = new Date(created.nextRunAt)
    assert.equal(date.getHours(), schedule.startsWith('0 ') ? 10 : 9)
    assert.equal(date.getMinutes(), schedule.startsWith('0 ') ? 15 : 30)
    assert.deepEqual(automations.get(created.id), JSON.parse(await readFile(file, 'utf8')).find((row: any) => row.id === created.id))
  }
  const { model: _model, reasoningEffort: _effort, ...defaultInput } = input
  const defaultResponse = await call(defaultInput)
  const defaultTask = JSON.parse(defaultResponse.result.content[0].text)
  assert.equal(defaultTask.dayMode, 'all')
  assert.equal(defaultTask.model, undefined)
  assert.equal(defaultTask.reasoningEffort, undefined)
  assert.equal(changes, 4, 'creation must notify the existing automation UI once per task')
  assert.deepEqual(await readdir(join(handoff.handoffResultsDir(), 'automations')), [], 'receipts must be consumed')
  assert.equal((await readdir(handoff.handoffInboxDir())).filter(name => name.endsWith('.json')).length, 0,
    'automation requests must not become immediate handoff tasks')

  const saved = JSON.parse(await readFile(file, 'utf8'))
  saved[0].nextRunAt = Date.now() - 1000
  await writeFile(file, JSON.stringify(saved))
  const restored = new NativeAutomations(runtime, file)
  try {
    restored.start()
    for (let i = 0; !restored.get(saved[0].id)?.lastSessionId && i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(runs.length, 1)
    assert.equal(runs[0].prompt, input.prompt.trim())
    assert.equal(runs[0].projectId, input.projectId)
    assert.equal(runs[0].permissionMode, input.permissionMode)
    assert.equal(runs[0].model, input.model)
    assert.equal(runs[0].reasoningEffort, input.reasoningEffort)
    assert.equal(restored.get(saved[0].id)?.lastSessionId, 'scheduled-session')
    assert.equal(restored.get(saved[0].id)?.lastRunStatus, 'success')
  } finally { restored.stop() }
} finally {
  stop?.()
  child.kill()
  handoff.handoffTaskStore.close()
  Date.now = originalNow
  await rm(root, { recursive: true, force: true })
}
console.log('uniagent-automation-mcp: ok')
