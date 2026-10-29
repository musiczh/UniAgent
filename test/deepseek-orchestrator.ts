import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore, SessionStoreWriteError } from '../src/main/sessionStore.ts'
import type { AgentDef, Session } from '../src/shared/types.ts'

const dir = await mkdtemp(join(tmpdir(), 'ua-dsh-orchestrator-'))
const bin = join(dir, 'dsh'), storePath = join(dir, 'sessions.json')
await writeFile(bin, `#!/usr/bin/env node\nrequire(${JSON.stringify(resolve('test/fixtures/fake-deepseek.cjs'))})\n`)
await chmod(bin, 0o755)
class FailingStore extends SessionStore {
  failure?: 'not-committed' | 'committed-durability-uncertain'
  saveOrThrow(sessions: Session[]): void {
    if (this.failure === 'not-committed') throw new SessionStoreWriteError('fixture disk full', this.failure, undefined)
    super.saveOrThrow(sessions)
    if (this.failure) throw new SessionStoreWriteError('fixture directory sync failed', this.failure, undefined)
  }
}
const store = new FailingStore(storePath)
const agent = { id:'deepseek', name:'DeepSeek Harness', adapter:'deepseek', bin, icon:'deepseek', builtin:true, installed:true,
  models:[], capabilities:{ protocol:'acp', modelSelect:true, reasoningEffort:true, permissionModes:[{ id:'ask', label:'Ask' }, { id:'full-access', label:'Full access' }] } } as AgentDef
const orchestrator = new Orchestrator(id => id === 'deepseek' ? agent : undefined, store)
async function waitFor(read: () => Promise<any> | any, predicate: (value: any) => boolean) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 20)) }
  throw new Error('fixture did not settle')
}
try {
  const planBin = join(dir, 'dsh-plan')
  await writeFile(planBin, `#!${process.execPath}
const send=frame=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\\n')
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line)
 if(method==='initialize')return send({id,result:{protocolVersion:1,_meta:{'uniagent/bridge':{version:1}},agentCapabilities:{sessionCapabilities:{resume:{},close:{}}}}})

 if(method==='session/new')return send({id,result:{sessionId:'native-plan',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'},{id:'plan',name:'Plan'}]}}})
 if(method==='session/set_mode')return send({id,result:{}})
 if(method==='session/prompt'){send({method:'session/update',params:{sessionId:'native-plan',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Native plan reply'}}}});return send({id,result:{stopReason:'end_turn'}})}
 if(id!==undefined)send({id,result:{}})
})
`)
  await chmod(planBin, 0o755)
  const planAgent = { ...agent, bin: planBin }
  const planHost = new Orchestrator(id => id === 'deepseek' ? planAgent : undefined, new SessionStore(join(dir,'plan-sessions.json')))
  const planned = planHost.createSession({ agentId:'deepseek', workdir:dir, permissionMode:'full-access', collaborationMode:'plan' }, 'native plan first')
  await waitFor(() => planHost.getSessionById(planned.id), s => s.status === 'idle')
  await planHost.sendMessage(planned.id, 'native plan follow-up')
  await waitFor(() => planHost.getSessionById(planned.id), s => s.status === 'idle')
  assert.equal(planned.config.collaborationMode, 'plan', 'native Plan remains usable across follow-up turns')
  assert.equal((await planHost.getEvents(planned.id)).filter(event => event.type === 'turn_completed').length,2)
  assert.ok((await planHost.getEvents(planned.id)).some(event => event.type === 'agent_message' && event.payload.text === 'Native plan reply'))
  await planHost.deleteSession(planned.id)
  planHost.disposeAll()
  const legacy = planHost.createSession({agentId:'deepseek',workdir:dir,permissionMode:'ask'}, 'legacy goal')
  await waitFor(()=>planHost.getSessionById(legacy.id),s=>s.status==='idle')
  legacy.goal = {objective:'old goal',autonomous:true,nativeActivation:'confirmed'} as any
  legacy.agentContract = {...legacy.agentContract!,nativeGoal:true,sessionFork:true,sideChat:true,crossAgentFork:true,structuredSubagents:true}
  planHost.reconcileAgentConfigs()
  assert.equal(legacy.goal?.autonomous,false)
  assert.equal(legacy.agentContract?.nativeGoal,false)
  assert.equal(legacy.agentContract?.crossAgentFork,false)
  await planHost.sendMessage(legacy.id,'normal turn after legacy goal migration')
  await waitFor(()=>planHost.getSessionById(legacy.id),s=>s.status==='idle')
  assert.equal(legacy.goal?.objective,'old goal')
  await planHost.deleteSession(legacy.id)
  planHost.disposeAll()
  await planHost.closeSessionLogs()
  const session = orchestrator.createSession({ agentId:'deepseek', workdir:dir, model:'deepseek-official/flash', effort:'off', permissionMode:'full-access' }, 'first')
  await waitFor(() => orchestrator.getSessionById(session.id), s => s.status === 'idle')
  const original = { ...session.config }
  agent.capabilities.protocol = 'web'
  session.agentContract = { ...session.agentContract!, steer: true, sessionFork: true, structuredUsage: true, formElicitation: true }
  orchestrator.reconcileAgentConfigs()
  assert.equal(session.agentContract.steer, true, 'catalog refresh must not replace a Host contract with legacy ACP restrictions')
  assert.equal(session.agentContract.sessionFork, true)
  assert.equal(session.agentContract.structuredUsage, true)
  assert.equal(session.agentContract.formElicitation, true)
  agent.capabilities.protocol = 'acp'
  store.failure = 'not-committed'
  await assert.rejects(orchestrator.updateSessionConfig(session.id, { model:'deepseek-official/pro', effort:'high' }), /disk full/)
  assert.deepEqual(session.config, original)
  assert.equal(session.agentContract?.currentModelId, original.model)
  assert.equal(JSON.parse(await readFile(storePath, 'utf8'))[0].config.model, original.model)
  store.failure = undefined
  await orchestrator.sendMessage(session.id, 'after-rollback')
  await waitFor(() => orchestrator.getSessionById(session.id), s => s.status === 'idle')
  assert.equal(session.agentContract?.currentModelId, original.model)
  store.failure = 'committed-durability-uncertain'
  await assert.rejects(orchestrator.updateSessionConfig(session.id, { model:'deepseek-official/pro', effort:'low' }), /sync failed/)
  assert.equal(session.config.model, 'deepseek-official/pro')
  assert.equal(JSON.parse(await readFile(storePath, 'utf8'))[0].config.model, session.config.model)
  assert.ok((await orchestrator.getEvents(session.id)).some(e => e.type === 'system_notice' && /持久化/.test(e.payload.text)))
  store.failure = undefined
  await orchestrator.updateSessionConfig(session.id, { permissionMode:'ask' })
  await orchestrator.sendMessage(session.id, 'pending-delete')
  await waitFor(() => orchestrator.getEvents(session.id), evs => evs.some(e => e.type === 'approval_request' && e.state === 'pending'))
  const transcript = join(dir, 'deepseek/events', session.id + '.jsonl')
  await orchestrator.flushSessionLogs()
  assert.ok((await readFile(transcript, 'utf8')).includes('approval_request'))
  await orchestrator.deleteSession(session.id)
  await assert.rejects(readFile(transcript), { code:'ENOENT' })
  assert.equal(orchestrator.getSessionById(session.id), undefined)
} finally { orchestrator.disposeAll(); await orchestrator.closeSessionLogs(); await rm(dir, { recursive:true, force:true }) }
console.log('deepseek-orchestrator: metadata rollback, uncertain commit and pending approval deletion passed')
