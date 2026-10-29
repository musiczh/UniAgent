import assert from 'node:assert/strict'
import { grokNativeHandshake, grokCapabilityAvailable, projectGrokContract, unconfirmGrokContract, grokModelContextWindows } from '../src/main/grokNativeCapabilities.ts'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { projectACPContract } from '../src/main/acp/acpProvider.ts'
import { encodeGrokQuestionAnswer, normalizeQuestions, questionAnswerKind, questionAnswerValues, validateGrokQuestionReply } from '../src/shared/questions.ts'

const init = { protocolVersion: 1, agentInfo: { version: '1.0.62' }, agentCapabilities: { promptCapabilities: { image: false } } }
const state = grokNativeHandshake(init)
const base = projectACPContract('grok', init, { configOptions: [{ id:'model', category:'model', type:'select', currentValue:'grok-4.7', options:[{value:'grok-4.7'},{value:'grok-4.6'}] }] }, {agentId:'grok',workdir:'/tmp'})
assert.equal(grokCapabilityAvailable(state, 'steer'), true, 'first user steer must not require a previous successful steer')
assert.equal(grokCapabilityAvailable(state, 'goal'), false, 'Goal additionally requires its actual command declaration')
state.capabilities.goal.status = 'verified'
let contract = projectGrokContract(base,state)
assert.equal(contract.nativeGoal,true); assert.equal(contract.imageAttachments,true)
assert.equal(contract.models[1].imageInput,false)
state.capabilities.steer = {status:'degraded',reason:'method removed'}
contract = projectGrokContract({...base,commands:['compact']},state)
assert.equal(contract.nativeGoal,true); assert.equal(contract.steer,false)
assert.equal(projectGrokContract({...base,currentModelId:'grok-4.6'},state).imageAttachments,false)
assert.equal(unconfirmGrokContract(contract).nativeGoal,false)
for (const version of ['1.0.61','1.0.63','1.0.620','unknown','']) assert.equal(grokNativeHandshake({...init,agentInfo:{version}}).confirmed,false)
assert.equal(grokNativeHandshake({...init,agentInfo:undefined,_meta:{agentVersion:'1.0.62'}}).confirmed,true)
const latest=grokNativeHandshake({...init,agentInfo:{version:'1.0.70'}})
assert.equal(latest.confirmed,true)
assert.equal(projectGrokContract(base,latest).structuredUsage,true)
assert.equal(projectGrokContract(base,latest).formElicitation,true)
assert.equal(grokNativeHandshake({...init,agentInfo:{version:'1.0.71'}}).confirmed,false,'an unverified future version must still be gated')

const fields=normalizeQuestions('grok',{questions:[{id:'scope',question:'范围',options:[{value:'local',label:' 工作区（推荐） '}]},{id:'note',question:'补充'}]})
const reply=encodeGrokQuestionAnswer(fields,{'范围':{choice:['local'],text:'',other:''},'补充':{choice:[],text:'说明',other:''}})
assert.deepEqual(reply,{outcome:'accepted',answers:{'范围':[' 工作区（推荐） '],'补充':['说明']}})
assert.equal(questionAnswerKind('question','_x.ai/ask_user_question'),'grok')
assert.deepEqual(questionAnswerValues('grok',fields[0],reply),[' 工作区（推荐） '])
assert.deepEqual(validateGrokQuestionReply(fields,{outcome:'cancelled'}),{outcome:'cancelled'})
for(const invalid of [{answers:{scope:{answers:['local']}}},{outcome:'accepted',answers:{scope:['local'],note:['说明']}},{outcome:'accepted',answers:{scope:[' 工作区（推荐） ']}},{outcome:'accepted',answers:{scope:[' 工作区（推荐） ',' 工作区（推荐） '],note:['说明']}},{outcome:'cancelled',answers:{}}]) assert.throws(()=>validateGrokQuestionReply(fields,invalid))
assert.throws(()=>encodeGrokQuestionAnswer(fields,{'范围':{choice:['forged'],text:'',other:''}}))
assert.deepEqual(normalizeQuestions('grok',{questions:[{question:'Duplicate'},{question:'Duplicate'}]}),[])
const home=await mkdtemp(join(tmpdir(),'ua-grok-model-cache-'))
try {
  await writeFile(join(home,'models_cache.json'),JSON.stringify({grok_version:'1.0.62',models:{
    good:{api_key:'TEST_SECRET',info:{id:'good',context_window:123456}},bad:{info:{id:'bad',context_window:-1}},mismatch:{info:{id:'other',context_window:1024}}
  }}))
  assert.deepEqual(await grokModelContextWindows({GROK_HOME:home}),{good:123456})
  await writeFile(join(home,'models_cache.json'),JSON.stringify({grok_version:'1.0.61',models:{good:{info:{id:'good',context_window:123456}}}}))
  assert.deepEqual(await grokModelContextWindows({GROK_HOME:home}),{})
} finally {await rm(home,{recursive:true,force:true})}
console.log('grok-native-capabilities: version, first use, downgrade, restored contracts and question boundary passed')
