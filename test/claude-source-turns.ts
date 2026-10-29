import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { TurnRunner } from '../src/main/adapter'
import { configureClaudeSourceRuntime, type ClaudeConnection } from '../src/main/claudeSourceRuntime'
import { codexModelKey } from '../src/shared/codexModelIdentity'
import { claudeSourceEffort } from '../src/shared/claudeSources'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import type { AgentDef, Session, SessionConfig, UAEvent } from '../src/shared/types'

const directory = await mkdtemp(join(tmpdir(), 'ua-claude-source-turn-'))
process.env.UNIAGENT_USER_DATA = directory
const connection: ClaudeConnection = { preset: 'kimi-code', apiKey: 'fixture-turn-key', baseUrl: 'https://api.kimi.com/coding', model: 'k3' }
configureClaudeSourceRuntime(async () => connection)
const bin = join(directory, 'cli.cjs')
await writeFile(bin, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const file=args[args.indexOf('--settings')+1];
const settings=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync('capture.json',JSON.stringify({args,settings,env:process.env.ANTHROPIC_API_KEY}));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);if(input.type==='control_request'){send({type:'control_response',response:{subtype:'success',request_id:input.request_id,response:{commands:[],models:[]}}});return}if(input.type!=='user')return;
 const mode=input.message.content;
 send({type:'system',subtype:'init',session_id:'fixture-session',model:'k3'});
 if(mode==='wait')return;
 if(mode.startsWith('retry-')){const status=Number(mode.slice(6));send({type:'system',subtype:'api_retry',attempt:1,max_retries:10,retry_delay_ms:10000,error_status:status,error:'authentication_failed'});if([401,402,403].includes(status))return;}
 send({type:'assistant',message:{content:[{type:'text',text:'answer'}]},context_usage:{raw_max_tokens:200000},usage_report:{session:{total_cost_usd:123}}});
 send({type:'rate_limit_event',rate_limit_info:{status:'allowed',rateLimitType:'five_hour',utilization:0.3}});
 if(mode==='fail')process.stderr.write('failed '+settings.env.ANTHROPIC_API_KEY);
 send({type:'result',subtype:mode==='fail'?'error_during_execution':'success',is_error:mode==='fail',errors:mode==='fail'?[settings.env.ANTHROPIC_API_KEY]:[],usage:{input_tokens:10,output_tokens:2},total_cost_usd:123,modelUsage:{k3:{contextWindow:200000}},result:mode==='fail'?settings.env.ANTHROPIC_API_KEY:'answer'});
});
`, { mode: 0o700 })
const agent: AgentDef = { id: 'claude', name: 'Claude', adapter: 'claude', bin, builtin: true, installed: true, icon: '', version: '2.1.300', models: [],
  capabilities: { modelSelect: true, reasoningEffort: false, streaming: true, permissionModes: [{ id: 'full-access', label: '', hint: '' }] } }
const config: SessionConfig = { agentId: 'claude', workdir: directory, permissionMode: 'full-access', model: codexModelKey('k3', { kind: 'third-party', sourceId: 'kimi' }) }
const emptyRuntimes = async (): Promise<void> => { assert.deepEqual(await readdir(join(directory, 'claude-sources/runtime')), []) }
try {
  for (const prompt of ['success', 'fail']) {
    const runner = new TurnRunner(prompt, { n: 0 }), events: UAEvent[] = []
    let quotaEvents = 0, doneEvents = 0
    runner.on('event', value => events.push(value)); runner.on('rateLimits', () => quotaEvents++); runner.on('done', () => doneEvents++)
    const done = once(runner, 'done'); runner.start(agent, config, prompt)
    const [result] = await done
    assert.equal(result.failed, prompt === 'fail')
    assert.equal(doneEvents, 1)
    assert.equal(events.find(event => event.type === 'turn_completed')?.state, prompt === 'fail' ? 'failed' : 'success')
    assert.equal(events.some(event => ['context_usage', 'usage_report'].includes(event.payload.kind)), false)
    assert.equal(quotaEvents, 0)
    assert.ok(!JSON.stringify(events).includes(connection.apiKey))
    if (prompt === 'fail') assert.ok(events.some(event => event.type === 'error' && event.payload.message === '[API Key]'), JSON.stringify(events.filter(event => event.type === 'error')))
    const usage = events.find(event => event.payload.kind === 'usage')?.payload.usage
    assert.equal(usage.inputTokens, 10); assert.equal(usage.outputTokens, 2)
    assert.equal(usage.contextWindow, undefined); assert.equal(usage.cost, null)
    const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'))
    assert.ok(capture.args.includes('--model=k3') || capture.args[capture.args.indexOf('--model') + 1] === 'k3', 'the SDK must select the provider wire model')
    assert.ok(!capture.args.join(' ').includes(connection.apiKey))
    assert.equal(capture.env, connection.apiKey)
    await runner.disposeClaudeSdk(); await emptyRuntimes()
  }
  const missing = new TurnRunner('missing', { n: 0 })
  let count = 0; missing.on('done', () => count++)
  const missingDone = once(missing, 'done'); missing.start({ ...agent, bin: join(directory, 'missing') }, config, 'success')
  assert.equal((await missingDone)[0].failed, true); assert.equal(count, 1); await emptyRuntimes()

  for (const status of [401, 402, 403, 429, 500, 529]) {
    const retrying = new TurnRunner('retry-' + status, { n: 0 }), events: UAEvent[] = []
    retrying.on('event', event => events.push(event))
    const done = once(retrying, 'done')
    retrying.start(agent, config, 'retry-' + status)
    const timeout = setTimeout(() => retrying.interrupt(), 1500)
    const [result] = await done; clearTimeout(timeout)
    const fatal = [401, 402, 403].includes(status)
    assert.equal(result.failed, fatal, `HTTP ${status}: authentication/billing rejection must fail without waiting for CLI retries`)
    assert.equal(result.interrupted, false, 'provider rejection must not be reported as a user cancellation')
    assert.equal(events.filter(event => event.type === 'turn_completed').length, 1)
    if (fatal) assert.ok(events.some(event => event.type === 'error' && event.payload.message.includes(String(status))))
    await retrying.disposeClaudeSdk(); await emptyRuntimes()
  }

  const waiting = new TurnRunner('wait', { n: 0 })
  const waitingDone = once(waiting, 'done')
  waiting.on('event', event => { if (event.payload.kind === 'init') waiting.interrupt() })
  waiting.start(agent, config, 'wait')
  const timer = setTimeout(() => waiting.interrupt(), 100)
  assert.equal((await waitingDone)[0].interrupted, true); clearTimeout(timer); await emptyRuntimes()

  let release!: (value: ClaudeConnection) => void
  configureClaudeSourceRuntime(() => new Promise(resolve => { release = resolve }))
  const preparing = new TurnRunner('preparing', { n: 0 })
  const preparingDone = once(preparing, 'done'); preparing.start(agent, config, 'success'); preparing.interrupt()
  assert.equal((await preparingDone)[0].interrupted, true)
  release(connection)
  await new Promise(done => setTimeout(done, 50)); await emptyRuntimes()

  agent.capabilities.reasoningEffort = true
  agent.models = [['kimi', 'k3'], ['kimi', 'k3-256k'], ['kimi', 'kimi-for-coding-highspeed'], ['deepseek', 'deepseek-flash']].map(([sourceId, model]) => ({
    id: codexModelKey(model, { kind: 'third-party', sourceId }), label: model, ...claudeSourceEffort(model, sourceId === 'kimi' ? 'kimi-code' : 'deepseek')
  }))
  agent.models.push({ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] })
  const orchestrator = new Orchestrator(() => agent, new SessionStore(join(directory, 'sessions.json')), join(directory, 'artifacts'))
  const session: Session = { id: 'source', title: 'Source', status: 'idle', createdAt: 1, nativeSessionId: 'native', config }
  ;(orchestrator as any).sessions.set(session.id, session)
  ;(orchestrator as any).seqRefs.set(session.id, { n: 0 }); (orchestrator as any).events.set(session.id, [])
  try {
    const deepseek = { ...config, model: codexModelKey('deepseek-flash', { kind: 'third-party', sourceId: 'deepseek' }) }
    for (const [previous, target] of [[config, deepseek], [deepseek, config]]) {
      session.config = { ...previous }
      for (const status of ['idle', 'running', 'queued', 'cancelling', 'awaiting-approval', 'error'] as const) {
        session.config = { ...previous }
        const runningConfig = session.config
        session.status = status
        await orchestrator.updateSessionConfig(session.id, { model: target.model })
        assert.equal(session.config.model, target.model, 'Claude can select the provider for the next turn')
        assert.equal(runningConfig.model, previous.model, 'selection must not mutate the running turn snapshot')
        assert.equal(session.nativeSessionId, 'native', 'switch must preserve native history')
      }
    }
    session.status = 'running'
    await orchestrator.updateSessionConfig(session.id, { model: deepseek.model, workdir: '/different' })
    assert.equal(session.config.workdir, directory, 'busy model selection must not unlock workspace or permission edits')
    session.config = { ...config, roleSnapshot: { name: 'locked' } as any }
    await assert.rejects(orchestrator.updateSessionConfig(session.id, { model: deepseek.model }), /role_session_config_locked/)
    session.status = 'idle'
    session.config = { ...config }
    await orchestrator.updateSessionConfig(session.id, { effort: 'xhigh' })
    assert.equal(session.config.effort, 'high', 'unsupported saved effort falls back to the model default')
    await orchestrator.updateSessionConfig(session.id, { model: codexModelKey('kimi-for-coding-highspeed', { kind: 'third-party', sourceId: 'kimi' }), effort: 'max' })
    assert.equal(session.config.effort, undefined, 'fixed-thinking model clears stale effort')
    await orchestrator.updateSessionConfig(session.id, { model: 'sonnet', effort: 'medium' })
    assert.equal(session.config.effort, 'medium')
    assert.equal(session.config.modelSource, undefined, 'switching to native must not retain third-party source identity')
    assert.equal(session.nativeSessionId, 'native')
    await orchestrator.updateSessionConfig(session.id, { model: codexModelKey('k3-256k', { kind: 'third-party', sourceId: 'kimi' }) })
    assert.equal(session.nativeSessionId, 'native')
    assert.equal(session.config.model, codexModelKey('k3-256k', { kind: 'third-party', sourceId: 'kimi' }))
    session.nativeSessionId = undefined
    await orchestrator.updateSessionConfig(session.id, { model: deepseek.model })
    assert.equal(session.config.model, deepseek.model, 'a session without native history can still choose its initial provider')
  } finally { orchestrator.disposeAll() }
  console.log('claude-source-turns: wire model, secret redaction, usage isolation, failed result, spawn failure, cancellation and next-turn provider selection passed')
} finally { configureClaudeSourceRuntime(undefined); await rm(directory, { recursive: true, force: true }) }
