import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deepseekSessionRuntimeEnv } from '../src/main/deepseekService.ts'

// The managed runtime is no longer pinned: resolve the newest installed runtime-<version> dir.
function resolveInstalledDeepSeekRuntime(): string {
  const root = join(homedir(), 'Library/Application Support/UniAgent/deepseek')
  const installed = existsSync(root) ? readdirSync(root).filter((name) => /^runtime-.+/.test(name)) : []
  installed.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
  return join(root, installed[0] || 'runtime-0.2.1-rc.2')
}

const officialRuntime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME || resolveInstalledDeepSeekRuntime()
const directory = await mkdtemp(join(tmpdir(), 'ua-dsh-role-native-'))
const priorData = process.env.UNIAGENT_USER_DATA
const runtime = join(directory, 'deepseek/runtime-0.2.1-rc.2')
const workdir = join(directory, 'project')
const role = { id: 'role-a', name: 'A', agentId: 'deepseek', permissionMode: 'read-only' as const, instructions: 'Role A literal {{unbound}}', skills: ['alpha'] }
let child: ChildProcessWithoutNullStreams | undefined
let stderr = ''
let seq = 0
let pending = new Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>()
try {
  process.env.UNIAGENT_USER_DATA = directory
  await mkdir(runtime, { recursive: true })
  await symlink(join(officialRuntime, 'node_modules'), join(runtime, 'node_modules'), 'dir')
  for (const name of ['alpha', 'beta']) {
    const skillDir = join(workdir, '.agents/skills', name)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} role fixture\n---\n${name} instructions\n`)
  }
  const fixture = join(runtime, 'role-fixture.mjs')
  await writeFile(fixture, `
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['agents','commands','systemPrompt','tools','skills','sessions','sandboxPolicy']
export function apply(ctx) {
  // A permissive third-party approval listener cannot override a role guard.
  ctx.on('tools/pre-execute', async () => ({kind:'allow'}))
  const inspect=async(agent,signal)=>{
    const assembly=await ctx.systemPrompt.assemble({scope:agent,agent,signal})
    const skills=await ctx.skills.list({scope:agent,cwd:agent.session.header.cwd,signal})
    const lookup={scope:agent,cwd:agent.session.header.cwd,signal}
    const blocked=await ctx.skills.get('beta',lookup)
    agent.ctx.tools.register(defineTool({name:'write',description:'scope-local mutation',parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{throw new Error('role escape')}}))
    const write=await ctx.tools.execute({agent,signal,name:'write',arguments:{},callId:'fixture-write'})
    const escalated=await ctx.tools.execute({agent,signal,name:'bash',arguments:{command:'pwd',sandbox_permissions:'danger-full-access',justification:'escape'},callId:'fixture-escalate'})
    const bash=await ctx.tools.execute({agent,signal,name:'bash',arguments:{command:'printf forbidden > role-denied.txt'},callId:'fixture-bash'})
    return {prompt:renderPrompt(assembly),tools:assembly.tools.map(tool=>tool.name),skills:skills.filter(skill=>skill.invocation.modelInvocable).map(skill=>skill.name),userSkills:skills.filter(skill=>skill.invocation.userInvocable).map(skill=>skill.name),blocked:blocked??null,writeError:write.isError,escalationError:escalated.isError,bash,mode:ctx.sandboxPolicy.resolve({session:agent.session}).mode}
  }
  ctx.commands.register({name:'ua-role-save',description:'Persist native role session',handler:async({agent,signal})=>{
    const handle=await ctx.agents.create({sessionId:'native-role-resume',meta:{cwd:agent.session.header.cwd},agentOptions:{provider:'deepseek-official',model:'deepseek-flash'},signal})
    const state=await inspect(handle.agent,signal)
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    return {kind:'success',text:JSON.stringify(state)}
  }})
  ctx.commands.register({name:'ua-role-resume',description:'Resume native role session',handler:async({signal})=>{
    const handle=await ctx.agents.resume({resumeSessionId:'native-role-resume',agentOptions:{provider:'deepseek-official',model:'deepseek-flash'},signal})
    const state=await inspect(handle.agent,signal)
    await handle.dispose()
    return {kind:'success',text:JSON.stringify(state)}
  }})
}
`)
  async function start(roleSnapshot = role, session = 'profile-a') {
    const env = deepseekSessionRuntimeEnv(session, { agentId:'deepseek',workdir,permissionMode:'read-only',roleSnapshot })
    const patchFile = join(env.DSH_HOME!, 'cordis.patch.yml')
    const patch = JSON.parse(await readFile(patchFile,'utf8'))
    patch.push({id:'hmr',disabled:true},{id:'otel',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[{id:'role-fixture',name:pathToFileURL(fixture).href}]})
    await writeFile(patchFile,JSON.stringify(patch))
    stderr = ''
    pending = new Map()
    child = spawn(process.execPath,[join(runtime,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','acp'],{cwd:workdir,env:{...process.env,...env,HOME:directory,UNIAGENT_USER_DATA:directory,XDG_CONFIG_HOME:directory,XDG_CACHE_HOME:directory,XDG_DATA_HOME:directory,TMPDIR:directory}})
    child.stderr.on('data',data=>{stderr+=data.toString()})
    let buffer=''
    child.stdout.on('data',data=>{
      buffer+=data.toString()
      let end
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
        let value:any;try{value=JSON.parse(line)}catch{continue}
        if(value.id!==undefined && value.method===undefined){const reply=pending.get(value.id);if(reply){pending.delete(value.id);reply.resolve(value)}}
      }
    })
    child.on('exit',code=>{for(const reply of pending.values())reply.reject(new Error(`Harness exited ${code}: ${stderr.slice(-4000)}`));pending.clear()})
    await request('initialize',{protocolVersion:1,clientInfo:{name:'role-probe'},clientCapabilities:{}})
    return (await request('session/new',{cwd:workdir,mcpServers:[]})).sessionId
  }
  const sessionId = await start()
  const saved = JSON.parse((await request('_uniagent/command',{sessionId,line:'/ua-role-save'})).result.text)
  assert.ok(saved.prompt.includes('Role A literal {{unbound}}'))
  assert.deepEqual(saved.skills,['alpha'])
  assert.deepEqual(saved.userSkills,['alpha'])
  assert.equal(saved.blocked,null)
  assert.equal(saved.writeError,true)
  assert.equal(saved.escalationError,true)
  assert.equal(saved.mode,'read-only')
  await assert.rejects(readFile(join(workdir,'role-denied.txt')), { code:'ENOENT' })
  await stop()
  const nextSession = await start({...role,id:'role-b',instructions:'Role B after resume',skills:[]},'profile-b')
  const resumed = JSON.parse((await request('_uniagent/command',{sessionId:nextSession,line:'/ua-role-resume'})).result.text)
  assert.ok(resumed.prompt.includes('Role B after resume'))
  assert.equal(resumed.prompt.includes('Role A literal'),false)
  assert.deepEqual(resumed.skills,[])
  assert.deepEqual(resumed.userSkills,[])
  assert.equal(resumed.writeError,true)
  assert.equal(resumed.escalationError,true)
  assert.equal(resumed.mode,'read-only')
  await assert.rejects(readFile(join(workdir,'role-denied.txt')), { code:'ENOENT' })
} finally {
  await stop()
  if(priorData===undefined)delete process.env.UNIAGENT_USER_DATA;else process.env.UNIAGENT_USER_DATA=priorData
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
console.log('deepseek-role-native: official profile boots, filesystem skill policy, monotonic denial, sandbox writes and native resume passed')

async function request(method:string,params:any){
  const id=++seq
  const response:any=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out: ${stderr.slice(-4000)}`))},20000)
    pending.set(id,{resolve:(value)=>{clearTimeout(timer);resolve(value)},reject:(error)=>{clearTimeout(timer);reject(error)}})
    child!.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')
  })
  assert.equal(response.error,undefined,`${method}: ${JSON.stringify(response.error)}`)
  return response.result
}
async function stop(){
  if(!child)return
  const owned=child;child=undefined
  if(owned.exitCode!==null)return
  owned.stdin.end()
  await new Promise<void>(resolve=>{
    const terminate=setTimeout(()=>owned.kill('SIGTERM'),3000)
    const force=setTimeout(()=>owned.kill('SIGKILL'),6000)
    owned.once('exit',()=>{clearTimeout(terminate);clearTimeout(force);resolve()})
  })
}
