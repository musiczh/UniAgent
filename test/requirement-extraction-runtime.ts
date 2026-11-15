import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractRequirementText, requirementExtractionUnsupported } from '../src/main/requirementExtractionRuntime'
import { configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter'
import type { AgentDef, SessionConfig } from '../src/shared/types'

const directory=await mkdtemp(join(tmpdir(),'requirement-runtime-contract-'))
const previousCodexHome=process.env.CODEX_HOME
process.env.CODEX_HOME=join(directory,'isolated-codex')
await mkdir(process.env.CODEX_HOME,{recursive:true})
await writeFile(join(process.env.CODEX_HOME,'config.toml'),'openai_base_url="https://native.example.invalid/v1"\n[hooks]\nunsafe="never inherit"\n')
const catalog=join(directory,'models.json')
await writeFile(catalog,JSON.stringify({models:[{slug:'test-model',shell_type:'shell_command',experimental_supported_tools:['shell'],additional_tools:['apply_patch'],apply_patch_tool_type:'freeform'}]}))
configureCodexAppServerArgsProvider(()=>['-c','model_catalog_json='+JSON.stringify(catalog)])
const config={agentId:'codex',workdir:directory,model:'test-model'} as SessionConfig
const agent={id:'codex',adapter:'codex',bin:'fixture-codex',installed:true} as AgentDef
const requests:any[]=[]
let disposed=0
let mode:'success'|'tool'|'abort'|'native-retry'|'oversized'='success'
let controller=new AbortController()
class FakeRpc extends EventEmitter {
  async start() {}
  async request(method:string,params:any):Promise<any> {
    requests.push({method,params})
    if(method==='thread/start'||method==='thread/resume') return {thread:{id:'isolated-thread'}}
    if(method==='turn/start') {
      if(mode==='abort'){controller.abort();return {}}
      if(mode==='tool'){this.emit('notification','item/started',{threadId:'isolated-thread',item:{type:'commandExecution'}});return {}}
      if(mode==='native-retry') this.emit('notification','error',{threadId:'isolated-thread',willRetry:true,error:{message:'temporary'}})
      if(mode==='oversized'){this.emit('notification','item/agentMessage/delta',{threadId:'isolated-thread',delta:'x'.repeat(20)});return {}}
      this.emit('notification','item/completed',{threadId:'isolated-thread',item:{type:'agentMessage',id:'answer',text:'{"candidates":[]}'}})
      this.emit('notification','turn/completed',{threadId:'isolated-thread',turn:{status:'completed'}})
    }
    return {}
  }
  notify() {}
  respond() {assert.fail('background runtime must not request interaction')}
  interrupt() {}
  async dispose(){disposed++}
}
try {
  assert.ok(requirementExtractionUnsupported({...agent,adapter:'claude'}))
  let childDirectory=''
  const output=await extractRequirementText(agent,config,'只提取事实',controller.signal,options=>{
    childDirectory=options.cwd
    assert.notEqual(options.cwd,config.workdir)
    assert.ok(options.env?.CODEX_HOME?.startsWith(options.cwd))
    return new FakeRpc()
  })
  assert.equal(output,'{"candidates":[]}')
  const thread=requests.find(r=>r.method==='thread/start').params
  assert.equal(thread.sandbox,'read-only');assert.equal(thread.ephemeral,true);assert.deepEqual(thread.dynamicTools,[])
  assert.equal(thread.config['features.shell_tool'],false);assert.equal(thread.config['features.orchestrator_mcp'],false)
  assert.deepEqual(Object.keys(thread.config).filter(key=>key.startsWith('mcp_servers.')),[],'isolated extraction must not create MCP entries without a transport')
  await assert.rejects(readFile(join(childDirectory,'models.json')),'own temporary directory cleaned after completion')
  mode='tool';controller=new AbortController()
  await assert.rejects(extractRequirementText(agent,config,'不允许工具',controller.signal,()=>new FakeRpc()),/未授权工具/)
  mode='abort';controller=new AbortController()
  await assert.rejects(extractRequirementText(agent,config,'取消',controller.signal,()=>new FakeRpc()),/cancelled/)
  assert.ok(disposed>=3)
  mode='native-retry';controller=new AbortController()
  const schema={type:'object',properties:{retry:{type:'boolean'}}}
  assert.equal(await extractRequirementText(agent,config,'判断',controller.signal,()=>new FakeRpc(),{outputSchema:schema,maxOutputChars:8192,label:'恢复判断'}),'{"candidates":[]}')
  assert.deepEqual(requests.filter(request=>request.method==='turn/start').at(-1).params.outputSchema,schema)
  let persistentThread:string|undefined
  const persistentDirectory=join(directory,'persistent-session')
  const startCount=requests.filter(request=>request.method==='thread/start').length
  for(let i=0;i<2;i++)await extractRequirementText(agent,config,'整理同一需求',controller.signal,()=>new FakeRpc(),{
    session:{directory:persistentDirectory,threadId:persistentThread,onThread:async id=>{persistentThread=id}}
  })
  assert.equal(requests.filter(request=>request.method==='thread/start').length,startCount+1,'a requirement starts only one native thread')
  assert.equal(requests.filter(request=>request.method==='thread/resume').at(-1).params.threadId,persistentThread)
  assert.equal(requests.filter(request=>request.method==='thread/start').at(-1).params.ephemeral,false)
  assert.ok(await readFile(join(persistentDirectory,'models.json')),'persistent runtime survives turns')
  const transport=await readFile(join(persistentDirectory,'codex','config.toml'),'utf8')
  assert.ok(transport.includes('native.example.invalid')&&!transport.includes('hooks'),'persistent session retains the native endpoint without inheriting automation')
  mode='oversized';controller=new AbortController()
  await assert.rejects(extractRequirementText(agent,config,'判断',controller.signal,()=>new FakeRpc(),{maxOutputChars:10,label:'恢复判断'}),/输出过长/)
  mode='success';controller=new AbortController()
  configureCodexAppServerArgsProvider()
  await mkdir(process.env.CODEX_HOME!,{recursive:true})
  await writeFile(join(process.env.CODEX_HOME!,'models_cache.json'),JSON.stringify({models:[{slug:'other-provider-model'}]}))
  let catalogProbes=0
  assert.equal(await extractRequirementText(agent,config,'原模型目录恢复',controller.signal,options=>{
    const rpc=new FakeRpc(),request=rpc.request.bind(rpc)
    rpc.request=async(method,params)=>{
      if(method==='model/list'){
        catalogProbes++
        await writeFile(join(options.env!.CODEX_HOME!,'models_cache.json'),JSON.stringify({models:[{slug:'test-model',shell_type:'shell_command'}]}))
        return {data:[{id:'test-model'}]}
      }
      return request(method,params)
    }
    return rpc
  }),'{"candidates":[]}')
  assert.equal(catalogProbes,1,'a cache from another provider is refreshed through the native read-only catalog without changing model')
  console.log('PASS requirement extraction isolated thread, tool denial, cancellation and owned resource cleanup')
} finally {
  configureCodexAppServerArgsProvider()
  if(previousCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousCodexHome
  await rm(directory,{recursive:true,force:true})
}
