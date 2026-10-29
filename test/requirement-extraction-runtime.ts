import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractRequirementText, requirementExtractionUnsupported } from '../src/main/requirementExtractionRuntime'
import { configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter'
import type { AgentDef, SessionConfig } from '../src/shared/types'

const directory=await mkdtemp(join(tmpdir(),'requirement-runtime-contract-'))
const previousCodexHome=process.env.CODEX_HOME
process.env.CODEX_HOME=join(directory,'isolated-codex')
const catalog=join(directory,'models.json')
await writeFile(catalog,JSON.stringify({models:[{slug:'test-model',shell_type:'shell_command',experimental_supported_tools:['shell'],additional_tools:['apply_patch'],apply_patch_tool_type:'freeform'}]}))
configureCodexAppServerArgsProvider(()=>['-c','model_catalog_json='+JSON.stringify(catalog)])
const config={agentId:'codex',workdir:directory,model:'test-model'} as SessionConfig
const agent={id:'codex',adapter:'codex',bin:'fixture-codex',installed:true} as AgentDef
const requests:any[]=[]
let disposed=0
let mode:'success'|'tool'|'abort'='success'
let controller=new AbortController()
class FakeRpc extends EventEmitter {
  async start() {}
  async request(method:string,params:any):Promise<any> {
    requests.push({method,params})
    if(method==='thread/start') return {thread:{id:'isolated-thread'}}
    if(method==='turn/start') {
      if(mode==='abort'){controller.abort();return {}}
      if(mode==='tool'){this.emit('notification','item/started',{threadId:'isolated-thread',item:{type:'commandExecution'}});return {}}
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
  await assert.rejects(readFile(join(childDirectory,'models.json')),'own temporary directory cleaned after completion')
  mode='tool';controller=new AbortController()
  await assert.rejects(extractRequirementText(agent,config,'不允许工具',controller.signal,()=>new FakeRpc()),/未授权工具/)
  mode='abort';controller=new AbortController()
  await assert.rejects(extractRequirementText(agent,config,'取消',controller.signal,()=>new FakeRpc()),/cancelled/)
  assert.ok(disposed>=3)
  console.log('PASS requirement extraction isolated thread, tool denial, cancellation and owned resource cleanup')
} finally {
  configureCodexAppServerArgsProvider()
  if(previousCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousCodexHome
  await rm(directory,{recursive:true,force:true})
}
