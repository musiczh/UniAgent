import assert from 'node:assert/strict'
import { DEFAULT_ROUTER_CONFIG,parseRouterDecision,resolveRouterConfig,routerAssignmentCall } from '../src/shared/router'
import type {AgentDef} from '../src/shared/types'
import {isTaskTitleEligible} from '../src/shared/taskTitle'

const agent={id:'deepseek',adapter:'deepseek',installed:true,models:[{id:DEFAULT_ROUTER_CONFIG.model,label:'Flash',efforts:['max']}],capabilities:{protocol:'web',startupSystemPrompt:true}} as AgentDef
assert.equal(DEFAULT_ROUTER_CONFIG.enabled,false)
assert.equal(resolveRouterConfig(DEFAULT_ROUTER_CONFIG,[agent]).available,true)
assert.equal(resolveRouterConfig({...DEFAULT_ROUTER_CONFIG,model:'removed'},[agent]).available,false)
assert.equal(resolveRouterConfig(DEFAULT_ROUTER_CONFIG,[{...agent,authenticationRequired:true}]).available,false)
assert.equal(resolveRouterConfig(DEFAULT_ROUTER_CONFIG,[{...agent,adapter:'generic',capabilities:{...agent.capabilities,startupSystemPrompt:false}}]).available,false)
for (const adapter of ['codex','claude','qoder','traex'] as const) {
  const vision = { ...agent, id: adapter, adapter, capabilities: { ...agent.capabilities, streaming: true }, models: [{ id: 'text', label: 'Text', efforts: [], imageInput: false }, { id: 'vision', label: 'Vision', efforts: ['high'], imageInput: true }] } as AgentDef
  assert.equal(resolveRouterConfig({ ...DEFAULT_ROUTER_CONFIG, agentId: adapter, model: 'vision', effort: 'high' }, [vision]).available, true)
  assert.equal(resolveRouterConfig({ ...DEFAULT_ROUTER_CONFIG, agentId: adapter, model: 'text', effort: undefined }, [vision]).available, false)
  assert.equal(resolveRouterConfig({ ...DEFAULT_ROUTER_CONFIG, agentId: adapter, model: 'vision', effort: undefined }, [{ ...vision, capabilities: { ...vision.capabilities, imageAttachments: false } }]).available, false)
  assert.equal(resolveRouterConfig({ ...DEFAULT_ROUTER_CONFIG, agentId: adapter, model: 'vision', effort: 'max' }, [vision]).available, false)
}
assert.equal(parseRouterDecision({action:'reuse_task',taskId:'s1',reason:'相同目标'}).taskId,'s1')
assert.throws(()=>parseRouterDecision({action:'reuse_task',reason:'缺少目标'}),/target_required/)
assert.throws(()=>parseRouterDecision({action:'reuse_task',taskId:'s1',reason:'相同目标',prompt:'模型改写原输入'}),/invalid_router_fields/)
assert.throws(()=>parseRouterDecision({action:'clarify',reason:'同名歧义'}),/target_required/)
const clarify={action:'clarify',reason:'同名歧义',clarification:'请选择目标'}
assert.deepEqual(parseRouterDecision({...clarify,clarificationOptions:[]}).clarificationOptions,[])
const quickOptions=[{label:'把「开发者选项」移到 superAgent 配置页'},{label:'把黄框里的「按项目和需求组织侧栏」移到 superAgent 配置页',description:'仅移动黄框里的设置'}]
assert.deepEqual(parseRouterDecision({...clarify,clarificationOptions:quickOptions}).clarificationOptions,quickOptions,'quick replies do not require routing objects')
assert.equal(parseRouterDecision({...clarify,clarificationOptions:[{objectId:'space',label:'当前空间',description:'空间直属任务'}]}).clarificationOptions?.[0].objectId,'space')
for(const clarificationOptions of [null,{},[{objectId:'',label:'空目标'}],[{label:'  '}],[{label:'x'.repeat(121)}],[{label:'选项',description:'x'.repeat(301)}],[{objectId:'space',label:''}],[{objectId:'space',label:'目标',extra:true}],[{objectId:'space',label:'目标'},{objectId:'space',label:'重复'}],[{label:'重复'},{label:'重复'}],Array.from({length:7},(_,i)=>({label:'选项'+i}))])assert.throws(()=>parseRouterDecision({...clarify,clarificationOptions}),/invalid_clarification_options/)
assert.throws(()=>parseRouterDecision({action:'create_task_in_space',reason:'已确定',projectId:'space',clarificationOptions:[]}),/invalid_clarification_options/)
assert.equal(isTaskTitleEligible({config:{agentId:'deepseek',workdir:'/',managedPurpose:'router'}}),false)
const call=routerAssignmentCall({sessionId:'s1',seq:1,ts:1,type:'tool_call',payload:{name:'mcp__uniagent-router__router_assign_task',input:{requestId:'r1',version:2}}})
assert.deepEqual(call,{requestId:'r1',version:2})
console.log('Router contract: default off, availability, strict decisions and managed session exclusion passed')
