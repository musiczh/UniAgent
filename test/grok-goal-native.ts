import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokACPRunner } from '../src/main/grokACPRunner.ts'
import type { AgentDef, UAEvent } from '../src/shared/types.ts'

if (process.env.UNIAGENT_GROK_NATIVE_TEST !== '1') {
  console.log('grok-goal-native: opt in with UNIAGENT_GROK_NATIVE_TEST=1')
} else {
  const root = await mkdtemp(join(tmpdir(), 'uniagent-grok-goal-native-'))
  await chmod(root, 0o700)
  const home = join(root, 'home'), grokHome = join(home, '.grok'), cwd = join(root, 'workspace')
  await mkdir(grokHome, { recursive: true }); await mkdir(cwd)
  await writeFile(join(cwd, 'EVIDENCE.txt'), 'UA_FACT_CONFIRMED\n')
  const captures: any[] = [], events: UAEvent[] = [], goals: any[] = [], done: any[] = [], nativeRequests: any[] = []
  let hold = true, held = false, release: (() => void) | undefined
  const plan = '# Plan: Confirm the isolated evidence fact\n\n## Goal kind\nanalysis\n\n## Acceptance criteria\n1. Report that EVIDENCE.txt contains UA_FACT_CONFIRMED.\n\n## Verification plan\n1. gating: Read EVIDENCE.txt and verify its observed fact UA_FACT_CONFIRMED.\n\n## Non-goals\n- No project changes.\n\n## Assumed scope\nEVIDENCE.txt in the isolated workspace.\n'
  const tool = (name: string, args: any, id: string) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    if (!body?.messages) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'ua-goal-native', object: 'model', context_window: 200000 }] })); return }
    const messages = body.messages, users = messages.filter((message: any) => message.role === 'user').map((message: any) => String(message.content || '')).join('\n')
    const tools = (body.tools || []).map((entry: any) => entry.function?.name), schema = body.response_format?.json_schema?.schema
    const executed = new Set(messages.filter((message: any) => message.role === 'tool').map((message: any) => message.tool_call_id))
    let delta: any = { role: 'assistant', content: 'EVIDENCE.txt:1 contains UA_FACT_CONFIRMED.' }, route = 'background'
    if (tools.length === 1 && tools[0] === 'session_title') { route = 'title'; delta = tool('session_title', { title: 'Isolated native goal' }, 'ua-title') }
    else if (users.includes('You are the Goal Plan Writer')) {
      route = 'planner'
      const target = [...users.matchAll(/(\/[^`\n]+\/goal\/plan-[^`\n]+\.md)/g)].at(-1)?.[1]
      assert.ok(target, 'native planner must provide its dynamic absolute plan filename')
      delta = !executed.has('ua-plan') ? tool('write', { file_path: target, content: plan }, 'ua-plan') : { role: 'assistant', content: 'Done' }
    } else if (users.includes('### 1. JSON verdict')) {
      route = 'skeptic'
      const target = [...users.matchAll(/(\/[^`\n]+\/goal-verdict-[^`\n]+\.json)/g)].at(-1)?.[1]
      const details = [...users.matchAll(/(\/[^`\n]+\/goal-classifier-[^`\n]+-skeptic-\d+\.md)/g)].at(-1)?.[1]
      assert.ok(target && details)
      delta = !executed.has('ua-skeptic-read') ? tool('read_file', { target_file: join(cwd, 'EVIDENCE.txt') }, 'ua-skeptic-read')
        : !executed.has('ua-verdict') ? tool('write', { file_path: target, content: JSON.stringify({ refuted: false, findings: [], evidence: 'Native read_file EVIDENCE.txt:1 confirmed UA_FACT_CONFIRMED.', confidence: 'high', blocking: 'none', details_md: 'Observed EVIDENCE.txt:1 matches the requested fact.' }) }, 'ua-verdict')
          : !executed.has('ua-details') ? tool('write', { file_path: details, content: 'Observed EVIDENCE.txt:1 matches the requested fact.' }, 'ua-details')
            : { role: 'assistant', content: 'Not Refuted' }
    } else if (schema?.properties?.decision) {
      route = 'evaluator'; delta = { role: 'assistant', content: JSON.stringify({ decision: 'candidate_complete', evidence: 'Native read_file EVIDENCE.txt:1 confirmed UA_FACT_CONFIRMED.', next_step: 'Run independent verification.', blocker_key: '' }) }
    } else if (tools.length && users.includes('A goal has been set:')) {
      route = 'implementer'
      if (hold && executed.has('ua-implementer-read')) { hold = false; held = true; await new Promise<void>(resolve => { release = resolve }) }
      delta = !executed.has('ua-implementer-read') ? tool('read_file', { target_file: join(cwd, 'EVIDENCE.txt') }, 'ua-implementer-read') : delta
    }
    captures.push({ route, body })
    const finish = delta.tool_calls ? 'tool_calls' : 'stop', usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
    if (body.stream) res.end('data: ' + JSON.stringify({ id: 'ua-native', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: 'ua-goal-native', choices: [{ index: 0, delta, finish_reason: finish }], usage }) + '\n\ndata: [DONE]\n\n')
    else res.end(JSON.stringify({ id: 'ua-native', object: 'chat.completion', model: 'ua-goal-native', choices: [{ index: 0, message: delta, finish_reason: finish }], usage }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`
  await writeFile(join(grokHome, 'config.toml'), `[cli]\nuse_leader=false\n[features]\nmanaged_config=false\nfeedback=false\ntelemetry=false\n[managed_mcps]\nenabled=false\n[models]\ndefault="ua-goal-native"\n[model.ua-goal-native]\nmodel="ua-goal-native"\nbase_url="${base}"\napi_key="ua-isolated-goal-test"\napi_backend="chat_completions"\nagent_type="grok-build"\nmax_retries=0\ncontext_window=200000\n[endpoints]\nmodels_base_url="${base}"\nxai_api_base_url="${base}"\ncli_chat_proxy_base_url="${base}"\n`)
  const agent: AgentDef = { id: 'grok', name: 'Grok', adapter: 'grok', bin: process.env.UNIAGENT_GROK_BIN || '/Users/bytedance/.grok/bin/grok', builtin: true, icon: '', models: [], capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] } }
  const runner = new GrokACPRunner('isolated-grok-native', { n: 0 }, agent, { agentId: 'grok', workdir: cwd, model: 'ua-goal-native', permissionMode: 'ask' }, undefined,
    { HOME: home, GROK_HOME: grokHome, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
      XAI_API_KEY: 'ua-isolated-goal-test', GROK_SUBAGENTS: '0', GROK_GOAL_USE_CURRENT_MODEL_ONLY: '1', GROK_GOAL_VERIFIER_N: '1', GROK_GOAL_CLASSIFIER: '1', GROK_GOAL_SUMMARY: '0' })
  runner.on('event', event => {
    events.push(event)
    if (event.type === 'approval_request' && event.state === 'pending') {
      const allow = event.payload.options?.find((option: any) => option.kind === 'allow_once')
      assert.ok(allow, 'native planner approval must offer an explicit allow_once option')
      assert.equal(runner.respondResult(event.payload.requestId, { outcome: { outcome: 'selected', optionId: allow.optionId } }).handled, true)
    }
  }); runner.on('goalChanged', goal => goals.push(goal)); runner.on('done', value => done.push(value))
  const until = async (predicate: () => boolean) => { const deadline = Date.now() + 18000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Native Grok condition timed out: ' + JSON.stringify({ held, routes: captures.map(row => row.route), goal: goals.at(-1), errors: events.filter(row => row.type === 'error') })); await new Promise(resolve => setTimeout(resolve, 10)) } }
  const objective = 'Analyze EVIDENCE.txt and report its confirmed fact without changing project files'
  try {
    const probe = await runner.probeSession(false)
    assert.equal(probe.contract.nativeGoal, true); assert.equal(probe.contract.steer, true)
    const connection = (runner as any).connection, nativeRequest = connection.request.bind(connection)
    connection.request = (method: string, params: any, timeout?: number) => {
      nativeRequests.push({ method, params }); return nativeRequest(method, params, timeout)
    }
    assert.equal(await runner.getGoal(), undefined)
    const goal = await runner.setGoal({ objective, tokenBudget: 10000 })
    assert.equal(goal.status, 'active'); assert.equal(goal.autonomous, true)
    await until(() => held)
    await until(() => events.some(event => event.type === 'turn_started'))
    await runner.steer('UA_GROK_NATIVE_STEER: keep the EVIDENCE.txt fact exact.')
    release!()
    await until(() => goals.at(-1)?.status === 'complete' && done.length >= 1)
    assert.ok(captures.some(row => row.route === 'implementer' && JSON.stringify(row.body.messages).includes('UA_GROK_NATIVE_STEER')), 'real model continuation must receive the active interjection')
    assert.ok(captures.some(row => row.route === 'skeptic'))
    assert.ok(events.some(event => event.type === 'approval_request' && event.state === 'pending'), 'ask mode must surface the real native planner write approval before a parent model round exists')
    assert.equal(goals.at(-1).tokenBudget, 10000); assert.ok(goals.at(-1).tokensUsed > 0)
    assert.ok(goals.at(-1).timeUsedSeconds > 0)
    assert.equal(events.filter(event => event.type === 'turn_started').length, 1)
    assert.equal(events.filter(event => event.type === 'turn_completed').length, 1)
    await assert.rejects(runner.steer('idle interjection must not create a new prompt'), /运行|回合|引导/)
    await runner.updateGoal({ action: 'clear' })
    assert.equal(goals.at(-1), undefined)
    assert.equal(await runner.getGoal(), undefined)
    assert.equal(events.filter(event => event.type === 'error').length, 0)
    assert.deepEqual(nativeRequests.filter(row => row.method === 'session/prompt').map(row => row.params.prompt[0].text), ['/goal ' + objective + ' --budget 10000', '/goal clear'], 'the official Goal owns every internal continuation without another parent prompt')
    const evidence = join(process.cwd(), 'out', 'test-results', `grok-goal-native-${Date.now()}`)
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ nativeRequests, captures, events, goals, done }, null, 2))
    console.log('grok-goal-native: real isolated planner, worker, evaluator, skeptic, completion, clear and active steer passed')
    console.log('grok-goal-native evidence: ' + join(evidence, 'evidence.json'))
  } finally {
    release?.(); await runner.disposeAndWait(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
}
