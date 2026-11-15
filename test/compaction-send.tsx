import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Session } from '../src/shared/types'
import { hasRunningContextCompaction } from '../src/shared/eventSnapshots'
import { contextCompactionAvailability } from '../src/renderer/contextCompaction'

const runningCompaction = { type: 'context_compaction', state: 'running', payload: { id: 'compact' } }
for (const state of ['success', 'failed', 'cancelled']) {
  const events = [runningCompaction, { ...runningCompaction, state }]
  assert.equal(hasRunningContextCompaction(events), false, '旧开始记录不得盖过同 ID 终态')
  assert.equal(contextCompactionAvailability(true, 'running', events, true).compacting, false)
}
assert.equal(hasRunningContextCompaction([runningCompaction]), true)
assert.equal(hasRunningContextCompaction([runningCompaction, { type: 'turn_completed' }]), false)
assert.equal(hasRunningContextCompaction([runningCompaction, { ...runningCompaction, payload: { id: 'other' }, state: 'success' }]), true)

const ui = await renderEventStream([], 'idle', 'compaction-send', {
  setup: `
    import {Composer} from './src/renderer/components/Composer';
    const api=window.uniagent;
    window.uniagent=new Proxy({listPresets:async()=>[]},{get:(target,key)=>target[key] || api[key]});
    window.sendCalls=[]; window.promoteCalls=[];
    function Harness(){
      const [compacting,setCompacting]=React.useState(true);
      window.setCompacting=setCompacting;
      return React.createElement(Composer,{
        sessionId:'compaction-send',status:'running',runtimeStatus:'running',compacting,
        agent:{id:'codex',name:'Codex',adapter:'codex',installed:true,models:[],capabilities:{steer:true,streaming:true,permissionModes:[]}},
        config:{agentId:'codex',permissionMode:'full-access'},
        onSend:async(text)=>window.sendCalls.push(text),onForceSend:async()=>{throw new Error('must not force send')},
        onInterrupt:()=>{},onUpdateConfig:()=>{},onSetCollaborationMode:()=>{},onRunNativeAction:()=>{},
        queue:[{id:'q1',prompt:'队列消息',state:'pending',acceptedAt:1,attempts:0}],
        onDequeue:()=>{},onPromoteQueue:(id)=>window.promoteCalls.push(id),onEditQueueItem:()=>{},
        capabilities:{agentId:'codex',source:'provider-native',candidates:[],actions:{goal:false,review:false,plan:null},errors:[]},
        capabilitiesReady:true,contextUsed:0,onCompact:async()=>{},canCompact:false,
        draftSeed:{sessionId:'compaction-send',agentId:'codex',text:'压缩时点击发送',candidateIds:[],attachments:[],command:null}
      });
    }
    createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(Harness));
  `,
  inspect: `(async()=>{
    const tick=()=>new Promise(resolve=>setTimeout(resolve,50));
    const send=()=>document.querySelector('.composer-send-btn');
    const direct=()=>document.querySelector('.queue-steer');
    const input=()=>document.querySelector('.composer .markdown-editor-content');
    const initial={sendDisabled:send().disabled,directDisabled:direct().disabled,directColor:getComputedStyle(direct()).color,
      editable:input().getAttribute('contenteditable'),editDisabled:document.querySelector('.queue-edit').disabled,deleteDisabled:document.querySelector('.queue-del').disabled};
    direct().click();send().click();await tick();
    const clicked={calls:[...window.sendCalls],promotes:[...window.promoteCalls]};
    input().focus();document.execCommand('insertText',false,'压缩时快捷键发送');await tick();
    input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}));await tick();
    const keyboard={calls:[...window.sendCalls]};
    window.setCompacting(false);await tick();
    const completed={directDisabled:direct().disabled,directColor:getComputedStyle(direct()).color,promotes:[...window.promoteCalls]};
    direct().click();await tick();
    return {initial,clicked,keyboard,completed,promoted:[...window.promoteCalls]};
  })()`
})
assert.equal(ui.initial.sendDisabled, false, '压缩期间主发送按钮应可入队')
assert.equal(ui.initial.directDisabled, true, '压缩期间直接发送箭头必须禁用')
assert.equal(ui.initial.editable, 'true')
assert.equal(ui.initial.editDisabled, false)
assert.equal(ui.initial.deleteDisabled, false)
assert.deepEqual(ui.clicked, { calls: ['压缩时点击发送'], promotes: [] })
assert.deepEqual(ui.keyboard.calls, ['压缩时点击发送', '压缩时快捷键发送'])
assert.equal(ui.completed.directDisabled, false)
assert.notEqual(ui.completed.directColor, ui.initial.directColor)
assert.deepEqual(ui.completed.promotes, [], '完成压缩不能自动强制发送')
assert.deepEqual(ui.promoted, ['q1'])

const directory = await mkdtemp(join(tmpdir(), 'uniagent-compaction-send-'))
const agent: AgentDef = { id:'fixture',name:'Fixture',bin:'/usr/bin/true',adapter:'generic',icon:'',builtin:false,installed:true,
  models:[],capabilities:{modelSelect:false,permissionModes:[],steer:true} }
const session: Session = { id:'session',title:'Compaction queue',status:'idle',createdAt:1,config:{agentId:agent.id,workdir:directory} }
const store = new SessionStore(join(directory, 'sessions.json'))
store.save([session])
const orchestrator = new Orchestrator(id=>id===agent.id?agent:undefined,store)
orchestrator.loadPersisted()
const internal=orchestrator as any
let steers=0
internal.streamers.set(session.id,{steer:async()=>{steers++},isRunning:()=>true})
try {
  const owner=orchestrator.getSessionById(session.id)!
  internal.record(session.id,{type:'context_compaction',state:'running',payload:{id:'compact'}})
  await orchestrator.sendMessage(session.id,'idle 压缩期间入队')
  assert.equal(orchestrator.getQueue(session.id).length,1)
  const id=orchestrator.getQueue(session.id)[0].id
  orchestrator.promoteQueueItem(session.id,id)
  await new Promise(setImmediate)
  assert.equal(steers,0,'后端必须拦截过时 UI 的直接发送')
  assert.equal(orchestrator.getQueue(session.id)[0].state,'pending')
  await assert.rejects(orchestrator.forceSend(session.id,'不得插入压缩'),/compaction_in_progress/)
  await orchestrator.sendMessage(session.id,'运行中压缩再次入队')
  assert.equal(orchestrator.getQueue(session.id).length,2)
  assert.equal(owner.status,'queued')
  internal.record(session.id,{type:'context_compaction',state:'success',payload:{id:'compact'}})
  orchestrator.promoteQueueItem(session.id,id)
  await new Promise(setImmediate)
  assert.equal(steers,1,'终态后应恢复直接发送')
  assert.equal(orchestrator.getQueue(session.id).length,1)

  // Main manual compaction starts while idle: accepted messages must wait, then drain FIFO.
  internal.commitQueue(owner,[])
  owner.status='idle'
  agent.adapter='codex'
  agent.capabilities.streaming=true
  owner.nativeSessionId='thread'
  let finishCompact!:()=>void
  let dispatches=0
  internal.dispatchPendingQueue=()=>{dispatches++}
  internal.streamers.set(session.id,{isRunning:()=>false,compact:()=>{
    internal.record(session.id,{type:'context_compaction',state:'running',payload:{id:'manual'}})
    return new Promise<void>(resolve=>{finishCompact=()=>{
      internal.record(session.id,{type:'context_compaction',state:'success',payload:{id:'manual'}})
      resolve()
    }})
  }})
  const compaction=orchestrator.compactSession(session.id)
  await orchestrator.sendMessage(session.id,'手动压缩时排队')
  assert.equal(dispatches,0)
  assert.equal(orchestrator.getQueue(session.id)[0].prompt,'手动压缩时排队')
  finishCompact()
  await compaction
  await new Promise(setImmediate)
  assert.equal(dispatches,1,'空闲压缩结束应恢复 FIFO，不能滞留')

  let finishSide!:()=>void
  let sideDispatches=0
  internal.sideStatus.set(session.id,'idle')
  internal.dispatchSideQueue=()=>{sideDispatches++}
  internal.sideStreamers.set(session.id,{isRunning:()=>false,steer:async()=>{steers++},compact:()=>{
    internal.recordSide(session.id,{type:'context_compaction',state:'running',payload:{id:'side'}})
    return new Promise<void>(resolve=>{finishSide=()=>{
      internal.recordSide(session.id,{type:'context_compaction',state:'success',payload:{id:'side'}})
      resolve()
    }})
  }})
  const sideCompaction=orchestrator.compactSideChat(session.id)
  await orchestrator.sendSideMessage(session.id,'侧边压缩时排队')
  const sideItem=internal.sideQueues.get(session.id)[0]
  assert.equal(sideItem.prompt,'侧边压缩时排队')
  orchestrator.promoteSideMessage(session.id,sideItem.id)
  await assert.rejects(orchestrator.forceSendSideMessage(session.id,'侧边不得插入'),/compaction_in_progress/)
  assert.equal(steers,1,'侧边压缩期间也不能直接发送')
  assert.equal(sideDispatches,0)
  finishSide()
  await sideCompaction
  assert.equal(sideDispatches,1,'侧边空闲压缩结束后恢复 FIFO')
} finally {
  internal.streamers.clear()
  internal.sideStreamers.clear()
  await orchestrator.closeSessionLogs()
  await rm(directory,{recursive:true,force:true})
}
console.log('PASS compaction send: click/shortcut enqueue, disabled direct send, completion restore and backend guards')
