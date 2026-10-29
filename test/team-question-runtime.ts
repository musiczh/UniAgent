import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as TOML from '@iarna/toml'
import { handoffMcpArgs } from '../src/main/handoff'
import { bindTeamRuntime } from '../src/main/teamRuntime'

const fixture = await mkdtemp(join(tmpdir(), 'uniagent-question-runtime-'))
const agentHome = join(fixture, '.codex')
const baseline = process.env.UNIAGENT_TEAM_QUESTION_BASELINE === '1'
const startedAt = Date.now()
const modelEvents: Array<{ timestamp: number; text: string }> = []
let questionStartedAt = 0
let questionCompletedAt = 0
let child: ReturnType<typeof spawn> | undefined
let timeout: ReturnType<typeof setTimeout> | undefined

try {
  await mkdir(agentHome)
  for (const name of ['auth.json', 'models_cache.json']) {
    try { await copyFile(join(homedir(), '.codex', name), join(agentHome, name)) }
    catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  const config = TOML.parse(await readFile(join(homedir(), '.codex/config.toml'), 'utf8'))
  const server = `
let buffer = ''
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
process.stdin.on('data', chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n')
    const message = JSON.parse(buffer.slice(0, index))
    buffer = buffer.slice(index + 1)
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'question-probe', version: '1' } } })
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ask_team_user', description: 'Wait for the user answer.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] } })
    else if (message.method === 'tools/call') setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'USER_ANSWER_READY' }] } }), 42000)
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
`
  bindTeamRuntime('question-runtime', true, '')
  const routing = handoffMcpArgs('codex', 'question-runtime').filter((argument, index, args) =>
    !baseline || !(argument.includes('direct_only_tool_namespaces') || argument === '-c' && args[index + 1]?.includes('direct_only_tool_namespaces')))
  const args = ['--ask-for-approval', 'never', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
    ...(typeof config.model === 'string' ? ['--model', config.model] : []), ...routing,
    '-c', `mcp_servers.uniagent.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.uniagent.args=${JSON.stringify(['-e', server])}`,
    '-c', 'mcp_servers.uniagent.tool_timeout_sec=120',
    'This is an interactive tool blocking test. Invoke uniagent ask_team_user exactly once. Try functions.exec with this exact first line: // @exec: {"yield_time_ms": 1000}. In that script await the ask_team_user tool. If the runtime disallows nested access, call ask_team_user directly. If exec yields Script running before USER_ANSWER_READY, immediately emit BEFORE_ANSWER and wait. After USER_ANSWER_READY emit AFTER_ANSWER. Do not call shell or other tools.']
  child = spawn('codex', args, { cwd: fixture, env: { ...process.env, HOME: fixture, CODEX_HOME: agentHome, UNIAGENT_USER_DATA: join(fixture, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
  child.stdout!.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      if (event.item?.type === 'mcp_tool_call' && event.item.tool === 'ask_team_user') {
        if (event.type === 'item.started') questionStartedAt = Date.now()
        if (event.type === 'item.completed') questionCompletedAt = Date.now()
      }
      if (event.item?.type === 'agent_message') modelEvents.push({ timestamp: Date.now(), text: event.item.text })
      console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, type: event.type, itemType: event.item?.type, tool: event.item?.tool }))
    }
  })
  timeout = setTimeout(() => child?.kill('SIGTERM'), 150000)
  const exitCode = await new Promise<number | null>((resolve, reject) => { child!.once('exit', resolve); child!.once('error', reject) })
  assert.equal(exitCode, 0, stderr)
  const responses: Array<{ timestamp: number; type: string; name?: string; yielded?: boolean }> = []
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await inspect(path)
      else if (entry.name.endsWith('.jsonl')) for (const line of (await readFile(path, 'utf8')).trim().split('\n')) {
        const row = JSON.parse(line)
        const payload = row.payload || {}
        if (row.type !== 'response_item' || !['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(payload.type)) continue
        responses.push({ timestamp: Date.parse(row.timestamp), type: payload.type, name: payload.name, yielded: (JSON.stringify(payload.output) || '').includes('Script running with cell ID') })
      }
    }
  }
  await inspect(join(agentHome, 'sessions'))
  const prematureResponses = modelEvents.filter(event => event.timestamp >= questionStartedAt && event.timestamp < questionCompletedAt)
  const earlyYields = responses.filter(response => response.yielded && response.timestamp >= questionStartedAt && response.timestamp < questionCompletedAt)
  console.log(JSON.stringify({ baseline, waitMs: questionCompletedAt - questionStartedAt, prematureResponses: prematureResponses.length, earlyYields: earlyYields.length, toolCalls: responses.filter(response => response.name).map(response => response.name) }))
  assert.ok(questionStartedAt && questionCompletedAt - questionStartedAt >= 40000, 'exercise a wait longer than the original exec yield')
  assert.ok(modelEvents.some(event => event.text.includes('AFTER_ANSWER')), 'the answered call resumes the same turn')
  if (!baseline) {
    assert.ok(responses.some(response => response.name === 'ask_team_user' || response.name?.endsWith('__ask_team_user')), 'the Leader question uses a direct tool call')
    assert.equal(earlyYields.length, 0, 'the question must not yield control before the user answer')
    assert.equal(prematureResponses.length, 0, 'the model must not produce output while the question is pending')
  }
} finally {
  if (timeout) clearTimeout(timeout)
  if (child && child.exitCode === null) child.kill('SIGTERM')
  await rm(fixture, { recursive: true, force: true })
}
