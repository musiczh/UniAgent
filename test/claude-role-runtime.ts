import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { TurnRunner, buildCommand } from '../src/main/adapter.ts'
import { NativeCapabilityService } from '../src/main/nativeCapabilityService.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, AgentRole, SessionConfig, UAEvent } from '../src/shared/types.ts'

const agent: AgentDef = {
  id: 'claude', name: 'Claude Code', bin: 'claude', adapter: 'claude', icon: '', builtin: true,
  installed: true, version: '2.1.296', models: [],
  capabilities: { modelSelect: true, reasoningEffort: true, streaming: true,
    permissionModes: [{ id: 'full-access', label: '', hint: '' }] }
}
const role: AgentRole = {
  id: 'review', name: 'Reviewer', agentId: 'claude', permissionMode: 'full-access',
  instructions: 'Only review.', skills: ['review'], toolPolicy: { mode: 'allow-only', tools: ['Read', 'mcp__docs__read'] }
}
const config: SessionConfig = { agentId: 'claude', permissionMode: 'full-access', workdir: '/repo', roleSnapshot: role }

function commandBoundary(): void {
  const command = buildCommand(agent, config, 'Review', undefined, undefined, undefined, undefined, true)
  assert.deepEqual(command.args.slice(command.args.indexOf('--tools'), command.args.indexOf('--tools') + 2), ['--tools', 'Read'])
  assert.equal(command.args.includes('--allowedTools'), false, 'auto-approval cannot enforce an allowlist')
  assert.equal(command.env.CLAUDE_CODE_SIMPLE, '0', 'simple mode must not suppress the role hooks')
  assert.ok(command.args.includes('--disallowedTools'))
  const denied = command.args[command.args.indexOf('--disallowedTools') + 1]
  assert.ok(denied.includes('Agent') && denied.includes('Task'), 'subagents do not inherit main-session skills')
  assert.throws(() => buildCommand({ ...agent, version: '2.1.295' }, config, 'Review'), /2\.1\.296/)
  assert.throws(() => buildCommand(agent, config, 'Review'), /stream-json|交互/)
}

async function usageBoundary(): Promise<void> {
  const runner = new TurnRunner('usage', { n: 0 })
  const events: UAEvent[] = []
  const calls: string[] = []
  runner.on('event', event => events.push(event))
  ;(runner as any).sdk = { request: async (method: string) => {
    calls.push(method)
    if (method === 'context') return { totalTokens: 1300, rawMaxTokens: 200000 }
    throw new Error('Unsupported usage')
  } }
  const context = { model: 'claude-sonnet-4-5', total_tokens: 1200, raw_max_tokens: 200000, percentage: 0.6, categories: [] }
  const report = { session: { total_cost_usd: 1.5, total_api_duration_ms: 100, model_usage: {} }, rate_limits: { limits: [] } }
  ;(runner as any).onLine('claude', JSON.stringify({ type: 'assistant', message: { content: [] }, context_usage: context }))
  ;(runner as any).onLine('claude', JSON.stringify({ type: 'assistant', message: { content: [] }, usage_report: report }))
  assert.deepEqual(events.find(event => event.payload.kind === 'context_usage')?.payload.contextUsage, context)
  assert.deepEqual(events.find(event => event.payload.kind === 'usage_report')?.payload.usageReport, report)
  assert.equal(events.some(event => event.payload.kind === 'usage'), false, 'session reports are not this turn usage')
  assert.deepEqual(await runner.getClaudeContextUsage(), { totalTokens: 1300, rawMaxTokens: 200000 })
  await assert.rejects(runner.getClaudeUsage(), /Unsupported usage/)
  assert.deepEqual(calls, ['context', 'usage'])
}

function subagentBoundary(): void {
  const runner = new TurnRunner('subagents', { n: 0 })
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  const send = (value: object) => (runner as any).onLine('claude', JSON.stringify(value))
  send({ type: 'system', subtype: 'task_started', task_id: 'task-a', tool_use_id: 'toolu_agent', description: 'Review module', task_type: 'local_agent' })
  send({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id: 'child-msg', model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'Child review' }, { type: 'tool_use', id: 'child-read', name: 'Read', input: { file_path: '/repo/a' } }] } })
  send({ type: 'system', subtype: 'task_progress', task_id: 'task-a', tool_use_id: 'toolu_agent', description: 'Read module', usage: { total_tokens: 150, tool_uses: 1, duration_ms: 200 } })
  send({ type: 'system', subtype: 'task_notification', task_id: 'task-a', tool_use_id: 'toolu_agent', status: 'completed', output_file: '/tmp/task-a.output', summary: 'Reviewed' })
  send({ type: 'assistant', message: { id: 'main-msg', content: [{ type: 'text', text: 'Main answer' }] } })
  assert.deepEqual(events.filter((event) => event.type === 'agent_message').map((event) => event.payload.text), ['Main answer'])
  assert.equal(events.some((event) => event.type === 'tool_call'), false, 'child tools must stay out of the main timeline')
  const states = events.filter((event) => event.type === 'subagent').flatMap((event) => event.payload.agents)
  assert.equal(states.at(-1).agentThreadId, 'task-a')
  assert.equal(states.at(-1).status, 'completed')
  assert.equal(states.at(-1).message, 'Reviewed')
  const items = (runner as any).getSubAgentItems('task-a')
  assert.equal(items.find((event: UAEvent) => event.type === 'agent_message')?.payload.text, 'Child review')
  assert.ok(items.some((event: UAEvent) => event.type === 'tool_call'))
  send({ type: 'system', subtype: 'task_started', task_id: 'task-b', description: 'Subtask', parent_task_id: 'task-a', prompt: 'Child task prompt' })
  send({ type: 'system', subtype: 'task_updated', task_id: 'task-b', patch: { status: 'failed', error: 'Task crashed', end_time: 1234 } })
  const failed = events.filter((event) => event.type === 'subagent').at(-1)!.payload.agents[0]
  assert.equal(failed.status, 'errored', 'task_updated patch status must settle the child')
  assert.equal(failed.message, 'Task crashed')
  assert.equal(failed.parentThreadId, 'task-a')
  assert.equal(failed.prompt, 'Child task prompt')
  send({ type: 'system', subtype: 'task_started', task_id: 'task-c', run_id: 'run-002', description: 'New attempt' })
  send({ type: 'system', subtype: 'task_notification', task_id: 'task-c', run_id: 'run-001', status: 'completed', summary: 'Old attempt' })
  assert.equal(events.filter((event) => event.type === 'subagent').at(-1)!.payload.agents[0].status, 'running', 'a late terminal message from a previous native run must not settle the resumed task')
}

async function slashBoundary(): Promise<void> {
  const runner = new TurnRunner('slash', { n: 0 })
  ;(runner as any).claudeRole = { ...role, skills: ['review'] }
  ;(runner as any).claudeBuiltinCommands = new Set(['compact'])
  for (const command of ['/review task', '/compact']) assert.doesNotThrow(() => (runner as any).assertClaudeCommand(command))
  for (const command of ['/未允许技能', '/compact (MCP)', '/review\n/other']) {
    assert.throws(() => (runner as any).assertClaudeCommand(command), /白名单/, 'unlisted and stacked slash commands must be rejected before SDK submission')
  }
}

async function protocolBoundary(mode: 'success' | 'error' | 'timeout' | 'no-hooks' | 'ambiguous' | 'alias-only' | 'malformed-hook' | 'subagent-start'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-claude-role-'))
  const executable = join(root, 'claude-fixture.cjs')
  const log = join(root, 'wire.jsonl')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
function send(v) { process.stdout.write(JSON.stringify(v)+'\\n'); }
let preToolCallback, subagentCallback;
rl.on('line', line => {
 const value = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
 if (value.type==='control_request' && value.request.subtype==='initialize') {
  preToolCallback=value.request.hooks.PreToolUse[0].hookCallbackIds[0];
  subagentCallback=value.request.hooks.SubagentStart[0].hookCallbackIds[0];
  send({type:'control_response',response:{subtype:'success',request_id:'unrelated',response:{}}});
  if (${JSON.stringify(mode)}==='timeout') return;
  setTimeout(() => send({type:'control_response',response:{subtype:${JSON.stringify(mode === 'error' ? 'error' : 'success')},request_id:value.request_id,response:{commands:${JSON.stringify(mode === 'ambiguous' ? [{ name: 'review' }, { name: 'plugin:review' }] : mode === 'alias-only' ? [{ name: 'other', aliases: ['review'] }] : [{ name: 'review' }])},hooks_applied:${mode !== 'no-hooks'}},error:'Unsupported initialize'}}),60);
 }
 if (value.type==='user') {
  send({type:'system',subtype:'init',session_id:'native-role-session'});
  if (${JSON.stringify(mode)}==='subagent-start') {
   send({type:'control_request',request_id:'child-start',request:{subtype:'hook_callback',callback_id:subagentCallback,input:{hook_event_name:'SubagentStart',agent_id:'child',agent_type:'custom-review'}}});
   setTimeout(()=>fs.writeFileSync(${JSON.stringify(join(root,'unauthorized-child'))},'would call a model'),500);return;
  }
  if (${JSON.stringify(mode)}==='malformed-hook') {
   send({type:'control_request',request_id:'malformed',request:{subtype:'hook_callback',callback_id:preToolCallback,input:{tool_name:'Write',tool_input:{}}}});return;
  }
  send({type:'control_request',request_id:'deny-write',request:{subtype:'hook_callback',callback_id:preToolCallback,input:{hook_event_name:'PreToolUse',tool_name:'mcp__docs__write',tool_input:{}}}});
  send({type:'control_request',request_id:'allow-read',request:{subtype:'hook_callback',callback_id:preToolCallback,input:{hook_event_name:'PreToolUse',tool_name:'Read',tool_input:{file_path:'/repo/a'}}}});
  send({type:'control_request',request_id:'deny-skill',request:{subtype:'hook_callback',callback_id:preToolCallback,input:{hook_event_name:'PreToolUse',tool_name:'Skill',tool_input:{skill:'other'}}}});
  send({type:'control_request',request_id:'deny-agent',request:{subtype:'hook_callback',callback_id:preToolCallback,input:{hook_event_name:'PreToolUse',tool_name:'Agent',tool_input:{}}}});
 }
 if (value.type==='control_response' && value.response.request_id==='deny-agent') {
  send({type:'result',subtype:'success',is_error:false,result:'done'}); process.exit(0);
 }
});
`, { mode: 0o700 })
  const runner = new TurnRunner(`fixture-${mode}`, { n: 0 })
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { runner.interrupt(); reject(new Error('Fixture did not finish')) }, 15_000)
    runner.once('done', () => { clearTimeout(timer); resolve() })
  })
  try {
    runner.start({ ...agent, bin: executable }, { ...config, workdir: root }, 'Review', 'resume-role')
    await done
    const wire = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(wire[0].type, 'control_request', 'user/model turn must wait for native initialization')
    assert.deepEqual(wire[0].request.skills, ['review'])
    assert.equal(wire[0].request.hooks.PreToolUse[0].hookCallbackIds.length, 1)
    assert.ok(Array.isArray(wire[0].request.hooks.SubagentStart), 'finite skills must gate subagent preload before execution')
    assert.equal(wire[0].request.hooks.SubagentStart[0].hookCallbackIds.length, 1)
    if (mode === 'subagent-start') {
      assert.ok(events.some(event=>event.type==='error' && /子代理/.test(event.payload.message)))
      await assert.rejects(readFile(join(root,'unauthorized-child')),{code:'ENOENT'},'owned CLI must exit before the SDK graceful-close interval can run the child')
      assert.equal(events.find(event=>event.type==='turn_completed')?.state,'failed')
    } else if (mode === 'malformed-hook') {
      assert.ok(wire.some(item=>item.type==='user'))
      assert.ok(events.some(event=>event.type==='error' && /钩子格式无效/.test(event.payload.message)))
      assert.equal(events.find(event=>event.type==='turn_completed')?.state,'failed','malformed hooks must fail closed through the real SDK callback')
    } else if (mode !== 'success') {
      assert.equal(wire.some((item) => item.type === 'user'), false, 'failed initialization must never start the model')
      assert.ok(events.some((event) => event.type === 'error' && /初始化/.test(event.payload.message)))
      assert.equal(events.find((event) => event.type === 'turn_completed')?.state, 'failed')
    } else {
      assert.equal(wire[1].type, 'user', 'an unrelated successful response must not release the prompt')
      const responses = wire.filter((item) => item.type === 'control_response')
      for (const id of ['deny-write', 'deny-skill', 'deny-agent']) {
        assert.equal(responses.find((item) => item.response.request_id === id)?.response.response.hookSpecificOutput.permissionDecision, 'deny')
      }
      assert.deepEqual(responses.find((item) => item.response.request_id === 'allow-read')?.response.response, {})
      assert.equal(events.some((event) => event.type === 'approval_request'), false, 'policy rejections do not ask users to override the role')
    }
  } finally {
    runner.interrupt()
    await runner.disposeClaudeSdk()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

commandBoundary()
subagentBoundary()
await slashBoundary()
await usageBoundary()
await protocolBoundary('success')
await protocolBoundary('error')
await protocolBoundary('no-hooks')
await protocolBoundary('ambiguous')
await protocolBoundary('alias-only')
await protocolBoundary('malformed-hook')
await protocolBoundary('subagent-start')
await protocolBoundary('timeout')
console.log('Claude role runtime: command policy, correlation, hook deny, resume, error, timeout passed')

if (process.env.UNIAGENT_CLAUDE_REAL_CLI === '1') await realCliHookBoundary()

async function realCliHookBoundary(): Promise<void> {
  const realConfig = { ...config, model: 'claude-sonnet-4-5' }
  const root = await mkdtemp(join(tmpdir(), 'uniagent-claude-role-real-'))
  const { mkdir } = await import('node:fs/promises')
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  await mkdir(join(home, '.claude', 'skills', 'fork-review'), { recursive: true })
  await mkdir(join(home, '.claude', 'skills', 'other'), { recursive: true })
  await mkdir(join(home, '.claude', 'skills', 'review'), { recursive: true })
  await mkdir(join(cwd, '.claude', 'agents'), { recursive: true })
  await writeFile(join(home, '.claude', 'skills', 'fork-review', 'SKILL.md'), '---\nname: fork-review\ndescription: Review through a fork\ncontext: fork\nagent: custom-review\n---\nReview the project.\n')
  await writeFile(join(cwd, '.claude', 'agents', 'custom-review.md'), '---\nname: custom-review\ndescription: A custom reviewer with a preloaded skill\nskills: [other]\n---\nReview the project.\n')
  await writeFile(join(home, '.claude', 'skills', 'other', 'SKILL.md'), '---\nname: other\ndescription: Secret unlisted skill\n---\nOTHER_SKILL_SECRET_SENTINEL\n')
  await writeFile(join(home, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: A regular review skill\n---\nALLOWED_REVIEW_SKILL_SENTINEL\nReview the project without a subagent.\n')
  await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } }))
  let calls = 0
  const requests: any[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (!request.url?.includes('/messages')) { response.writeHead(200); response.end('{}'); return }
    if (request.url.includes('count_tokens')) { response.writeHead(200); response.end('{"input_tokens":10}'); return }
    const payload = JSON.parse(body)
    requests.push(payload)
    const index = calls++
    const mcpScenario = payload.tools?.some((tool: any) => tool.name === 'mcp__docs__read')
    const regularSkillScenario = JSON.stringify(payload.messages).includes('REGULAR_SKILL_SCENARIO')
    const tools = mcpScenario ? index === 0 ? [
      { name: 'mcp__docs__read', input: {} }, { name: 'mcp__docs__write', input: {} }
    ] : [] : regularSkillScenario ? index === 0 ? [
      { name: 'Skill', input: { skill: 'review' } }, { name: 'Skill', input: { skill: 'other' } }
    ] : [] : index === 0 ? [{ name: 'Skill', input: { skill: 'fork-review' } }]
      : index === 1 ? [{ name: 'Skill', input: { skill: 'other' } }, { name: 'Write', input: { file_path: join(cwd, 'blocked.txt'), content: 'must not be written' } }]
        : []
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type: string, value: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    send('message_start', { message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    if (tools.length) {
      tools.forEach((tool, blockIndex) => {
        send('content_block_start', { index: blockIndex, content_block: { type: 'tool_use', id: `toolu_${index}_${blockIndex}`, name: tool.name, input: {} } })
        send('content_block_delta', { index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })
        send('content_block_stop', { index: blockIndex })
      })
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Review completed' } })
      send('content_block_stop', { index: 0 })
    }
    send('message_delta', { delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
    send('message_stop', {})
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as any).port
  const env = {
    HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_API_KEY: 'sk-ant-uniagent-local-fixture',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_SKIP_VERSION_CHECK: '1'
  }
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  const wrapper = join(root, 'claude.cjs')
  const mcpWrapper = join(root, 'claude-mcp.cjs')
  const mcpServer = join(root, 'mcp.cjs')
  const mcpLog = join(root, 'mcp-calls.jsonl')
  await writeFile(mcpServer, `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const v=JSON.parse(line);if(v.id===undefined)return;let result={};if(v.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'docs',version:'1'}};if(v.method==='tools/list')result={tools:[{name:'read',description:'Read only',inputSchema:{type:'object',properties:{}}},{name:'write',description:'Writes a marker',inputSchema:{type:'object',properties:{}}}]};if(v.method==='tools/call'){fs.appendFileSync(${JSON.stringify(mcpLog)},v.params.name+'\\n');result={content:[{type:'text',text:'done'}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:v.id,result})+'\\n');});\n`)
  const realBin = process.env.UNIAGENT_CLAUDE_REAL_BIN || '/Users/bytedance/.local/bin/claude'
  await writeFile(wrapper, `#!/bin/bash\nfiltered=()\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '--mcp-config' ]; then shift 2; else filtered+=("$1"); shift; fi\ndone\nexec '${realBin.replace(/'/g, "'\\''")}' --setting-sources user,project --strict-mcp-config --mcp-config '{"mcpServers":{}}' "\${filtered[@]}"\n`, { mode: 0o700 })
  await writeFile(mcpWrapper, `#!/bin/bash\nfiltered=()\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '--mcp-config' ]; then shift 2; else filtered+=("$1"); shift; fi\ndone\nexec '${realBin.replace(/'/g, "'\\''")}' --setting-sources user,project --strict-mcp-config --mcp-config '${JSON.stringify({ mcpServers: { docs: { command: process.execPath, args: [mcpServer] } } }).replace(/'/g, "'\\''")}' "\${filtered[@]}"\n`, { mode: 0o700 })
  const runner = new TurnRunner('real-role-fixture', { n: 0 })
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))
  let timer: ReturnType<typeof setTimeout> | undefined
  let liveRunner: TurnRunner | undefined
  try {
    const done = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { runner.interrupt(); reject(new Error('Real CLI timed out')) }, 45_000)
      runner.once('done', () => resolve())
    })
    runner.start({ ...agent, bin: wrapper }, {
      ...realConfig, workdir: cwd, roleSnapshot: { ...role, skills: ['fork-review'], toolPolicy: { mode: 'allow-only', tools: ['Skill', 'Read'] } }
    }, 'Call the fork-review skill to review.')
    await done
    assert.equal(calls, 1, 'the child must not receive preloaded skills or start a model call')
    assert.ok(events.some((event) => event.type === 'error' && /子代理/.test(event.payload.message)))
    await assert.rejects(readFile(join(cwd, 'blocked.txt')), { code: 'ENOENT' })
    assert.equal(JSON.stringify(requests).includes('OTHER_SKILL_SECRET_SENTINEL'), false)
    console.log('Claude real CLI: custom-agent skill preload prevented before child model call')
    if (timer) clearTimeout(timer)
    const service = new NativeCapabilityService()
    const beforeUsage = calls
    const usage = await service.queryClaudeUsage({ ...agent, bin: wrapper }, cwd)
    assert.equal(calls, beforeUsage, 'local usage controls must not call a model')
    assert.equal(typeof usage.contextUsage.totalTokens, 'number')
    assert.equal(usage.usageReport.rate_limits_available, false)
    console.log('Claude real CLI: native context and usage reports queried without model call')
    const nativeMcp = await service.discover({ ...agent, bin: mcpWrapper }, cwd, true)
    const docs = nativeMcp.candidates.find((candidate) => candidate.id === 'mcp:docs')
    assert.ok(docs && docs.kind === 'mcp')
    assert.equal(docs.startupStatus, 'ready')
    assert.deepEqual(docs.toolNames, ['read', 'write'], 'native MCP status reports server-local tool names')

    calls = 0
    const regular = new TurnRunner('real-regular-skill', { n: 0 })
    liveRunner = regular
    const regularEvents: UAEvent[] = []
    regular.on('event', (event) => regularEvents.push(event))
    const regularDone = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { regular.interrupt(); reject(new Error('Regular Skill fixture timed out')) }, 30_000)
      regular.once('done', () => resolve())
    })
    regular.start({ ...agent, bin: wrapper }, {
      ...realConfig, workdir: cwd, roleSnapshot: { ...role, skills: ['review'], toolPolicy: { mode: 'allow-only', tools: ['Skill', 'Read'] } }
    }, 'REGULAR_SKILL_SCENARIO: use review and try other.')
    await regularDone
    assert.equal(regularEvents.some((event) => event.type === 'error'), false)
    assert.ok(JSON.stringify(requests).includes('ALLOWED_REVIEW_SKILL_SENTINEL'), 'the allowlisted ordinary skill must load')
    assert.equal(JSON.stringify(requests).includes('OTHER_SKILL_SECRET_SENTINEL'), false)
    assert.ok(regularEvents.some((event) => event.type === 'tool_call' && event.state === 'failed'))
    console.log('Claude real CLI: ordinary allowlisted skill loaded; unlisted skill remained unavailable')
    if (timer) clearTimeout(timer)
    const nativeId = regularEvents.find((event) => event.type === 'turn_started' && typeof event.payload.sessionId === 'string')?.payload.sessionId
    assert.equal(typeof nativeId, 'string')
    await regular.disposeClaudeSdk(); liveRunner = undefined
    const resumedUsage = await service.queryClaudeUsage({ ...agent, bin: wrapper }, cwd, nativeId)
    assert.ok(resumedUsage.contextUsage.totalTokens > 0, 'a local report must inspect the resumed native transcript')
    assert.ok(resumedUsage.usageReport.session.total_cost_usd > 0, 'a resumed native session must retain its recorded cost: ' + JSON.stringify(resumedUsage.usageReport.session))
    const beforeReportCommands = calls
    const reportAgent = { ...agent, bin: wrapper, lifecycle: { availability: 'available' as const, auth: 'authenticated' as const, health: 'healthy' as const, updateStatus: 'current' as const, checkedAt: 1 } }
    const reports = new Orchestrator(() => reportAgent, new SessionStore(join(root, 'reports-sessions.json')), join(root, 'artifacts'))
    const reportSession = { id: 'native-report-session', title: 'Report', status: 'idle', createdAt: 1, nativeSessionId: nativeId, config: { agentId: 'claude', permissionMode: 'full-access', workdir: cwd } }
    ;(reports as any).sessions.set(reportSession.id, reportSession)
    ;(reports as any).events.set(reportSession.id, [])
    ;(reports as any).seqRefs.set(reportSession.id, { n: 0 })
    try {
      await reports.sendMessage(reportSession.id, '/context')
      await reports.sendMessage(reportSession.id, '/usage')
      assert.equal(calls, beforeReportCommands, 'sending exact native report commands through the app must not submit a model turn')
      const reportEvents = (reports as any).events.get(reportSession.id) as UAEvent[]
      assert.ok(reportEvents.some((event) => event.payload.kind === 'context_usage'))
      assert.ok(reportEvents.some((event) => event.payload.kind === 'usage_report'))
      assert.equal(reportSession.status, 'idle')
    } finally { reports.disposeAll() }
    console.log('Claude real CLI: app /context and /usage commands returned reports without a model turn')

    const slash = new TurnRunner('real-slash-skill', { n: 0 })
    liveRunner = slash
    const slashDone = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { slash.interrupt(); reject(new Error('Slash Skill fixture timed out')) }, 30_000)
      slash.once('done', () => resolve())
    })
    slash.start({ ...agent, bin: wrapper }, {
      ...realConfig, workdir: cwd, roleSnapshot: { ...role, skills: ['review'], toolPolicy: { mode: 'allow-only', tools: ['Skill', 'Read'] } }
    }, '/other')
    await slashDone
    assert.equal(JSON.stringify(requests).includes('OTHER_SKILL_SECRET_SENTINEL'), false, 'a direct slash command must not bypass the native skill allowlist')
    if (timer) clearTimeout(timer)

    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ agent: 'custom-review' }))
    const configuredAgent = new TurnRunner('real-default-custom-agent', { n: 0 })
    liveRunner = configuredAgent
    const configuredDone = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { configuredAgent.interrupt(); reject(new Error('Configured Agent fixture timed out')) }, 30_000)
      configuredAgent.once('done', () => resolve())
    })
    configuredAgent.start({ ...agent, bin: wrapper }, {
      ...config, workdir: cwd, roleSnapshot: { ...role, skills: ['review'], toolPolicy: { mode: 'allow-only', tools: ['Skill', 'Read'] } }
    }, 'REGULAR_SKILL_SCENARIO: review within the role.')
    await configuredDone
    assert.equal(JSON.stringify(requests).includes('OTHER_SKILL_SECRET_SENTINEL'), false, 'the configured main agent must not preload an unlisted skill')
    if (timer) clearTimeout(timer)

    calls = 0
    const mcpRunner = new TurnRunner('real-mcp-fixture', { n: 0 })
    liveRunner = mcpRunner
    const mcpEvents: UAEvent[] = []
    mcpRunner.on('event', (event) => mcpEvents.push(event))
    const mcpDone = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { mcpRunner.interrupt(); reject(new Error('MCP fixture timed out')) }, 30_000)
      mcpRunner.once('done', () => resolve())
    })
    mcpRunner.start({ ...agent, bin: mcpWrapper }, {
      ...config, workdir: cwd, roleSnapshot: { ...role, skills: undefined, toolPolicy: { mode: 'allow-only', tools: ['mcp__docs__read'] } }
    }, 'Use docs read and try docs write.')
    await mcpDone
    assert.equal(mcpEvents.some((event) => event.type === 'error'), false)
    assert.equal((await readFile(mcpLog, 'utf8')).trim(), 'read', 'the unlisted MCP write must never execute despite bypassPermissions')
    assert.ok(mcpEvents.some((event) => event.type === 'tool_call' && /hook error/.test(event.payload.output || '')))
    console.log('Claude real CLI: allowlisted MCP read executed; write denied before server call in bypass mode')
  } finally {
    if (timer) clearTimeout(timer)
    runner.interrupt()
    const child = (liveRunner as any)?.child
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'close')
    }
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
