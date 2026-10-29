import assert from 'node:assert/strict'
import { sideComposerAgent, sideComposerCapabilities } from '../src/renderer/components/SideChatPanel.tsx'
import type { AgentDef } from '../src/shared/types.ts'
import type { NativeCapabilitySnapshot } from '../src/shared/nativeCapabilities.ts'

const snapshot:NativeCapabilitySnapshot={agentId:'deepseek',workdir:'/repo',source:'provider-native',candidates:[],errors:[],actions:{goal:true,review:true,plan:{id:'plan',name:'Plan',model:null,reasoningEffort:null}}}
for(const adapter of ['kimi','grok','deepseek','zcode'] as const) {
 const agent:AgentDef={id:adapter,name:adapter,adapter,bin:adapter,icon:'',builtin:true,capabilities:{nativeGoal:true,nativeReview:true,sideChat:true,modelSelect:true,reasoningEffort:true,permissionModes:[]},models:[]}
 assert.deepEqual(sideComposerCapabilities(agent,snapshot).actions,{goal:false,review:false,plan:snapshot.actions.plan},'unsupported beta Side actions must not be offered by Composer')
 assert.equal(sideComposerAgent(agent)?.capabilities.nativeGoal,false)
 assert.equal(sideComposerAgent(agent)?.capabilities.nativeReview,false)
 assert.equal(agent.capabilities.nativeGoal,true,'main Agent capability must remain unchanged')
 assert.equal(snapshot.actions.goal,true,'main capability snapshot must remain unchanged')
}
const codex:AgentDef={id:'codex',name:'Codex',adapter:'codex',bin:'codex',icon:'',builtin:true,capabilities:{modelSelect:true,reasoningEffort:true,permissionModes:[]},models:[]}
assert.equal(sideComposerCapabilities(codex,snapshot),snapshot)
assert.equal(sideComposerAgent(codex),codex)
console.log('beta-side-capabilities: beta native action gates and existing Codex Side actions verified')
