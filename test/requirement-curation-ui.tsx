import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'curation-ui', {
  setup: `import{useState}from'react';import{RequirementCurationPanel}from'./src/renderer/components/RequirementCurationPanel';import{RequirementCurationSettings}from'./src/renderer/components/RequirementCurationSettings';import{RequirementCurationConversation}from'./src/renderer/components/RequirementCurationConversation';import'./src/renderer/components/requirementReader.css';
    const calls=[],saves=[];let state={sessionId:'curation-r',status:'queued',queue:[{id:'one',sessionId:'a',kind:'task'},{id:'two',sessionId:'b',kind:'task'}],history:[],updatedAt:1};
    let conversationReads=0,updated=false,readFailure=false;const events=[{sessionId:'curation-r',seq:0,ts:1,type:'user_message',payload:{text:'CURATION_INPUT'}},{sessionId:'curation-r',seq:1,ts:2,type:'agent_message',state:'success',payload:{id:'reply',text:'CURATION_OUTPUT',phase:'final_answer'}}];
    window.uniagent={requirementCuration:async(id,action='read')=>{calls.push(action);if(action==='pause')state={...state,status:'paused'};if(action==='retry')state={...state,status:'queued'};return state},setAppSettings:async patch=>{saves.push(patch);return patch},requirementStorage:async()=>({files:0}),requirementCurationConversation:async id=>{conversationReads++;if(readFailure)throw Error('history unavailable');return{requirementId:id,sessionId:'curation-'+id,model:'small',status:'idle',events:updated?[...events,{sessionId:'curation-r',seq:2,ts:3,type:'agent_message',payload:{id:'later',text:'LATER_RESULT',phase:'final_answer'}}]:events}}};
    const agents=[{id:'codex',name:'Codex',adapter:'codex',installed:true,capabilities:{startupSystemPrompt:true,modelSelect:true},models:[{id:'small',label:'Small',imageInput:true,efforts:['low','high']}]}];
    window.uniagent.listAgents=async()=>agents;window.uniagent.getAppSettings=async()=>({requirementCuration:{enabled:false,agentId:'codex',model:'small'}});
    function Fixture(){const[settings,setSettings]=useState({requirementCuration:{enabled:false}}),[conversation,setConversation]=useState(false);return conversation?<RequirementCurationConversation id="r" name="需求样例" onBack={()=>setConversation(false)}/>:<><RequirementCurationPanel id="r" initial={state} onOpenConversation={()=>setConversation(true)}/><RequirementCurationSettings agents={agents} settings={settings} onSaved={setSettings} onDirtyChange={()=>{}}/></>}
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;background:var(--bg);overflow:auto;padding:30px';createRoot(host).render(<Fixture/>);window.curationFixture={host,calls,saves,update:()=>{updated=true},fail:value=>{readFailure=value},reads:()=>conversationReads};`,
  inspect: `(async()=>{const f=window.curationFixture,q=s=>f.host.querySelector(s),all=s=>[...f.host.querySelectorAll(s)],tick=()=>new Promise(r=>setTimeout(r,40)),button=t=>all('button').find(b=>b.textContent===t);for(let i=0;i<60&&!q('.rr-curation-entry');i++)await tick();
    q('.rr-curation-entry').click();await tick();button('暂停整理').click();await tick();if(!f.host.textContent.includes('已暂停'))throw Error('pause not visible');button('继续整理').click();await tick();
    const select=async(label,selector)=>{q('[aria-label="'+label+'"]').click();await tick();document.querySelector(selector).click();await tick()};
    await select('整理 Agent','[data-title-agent="codex"]');await select('整理模型','[data-title-model="small"]');await select('整理思考强度','[data-title-effort="low"]');q('.requirement-curation-settings button[role="switch"]').click();await tick();button('保存整理配置').click();await tick();
    q('.rr-curation-maintenance summary').click();button('压缩旧资料副本').click();await tick();const noOldFiles=f.host.textContent.includes('没有待清理'),stableId=q('.rr-curation-model').title.includes('curation-r');
    const wait=async(probe,label)=>{for(let i=0;i<100;i++){if(probe())return;await tick()}throw Error(label)};
    button('查看会话').click();await wait(()=>q('.event-stream')?.textContent.includes('CURATION_OUTPUT'),'native conversation');
    const pane=q('.requirement-curation-conversation'),stream=q('.event-stream'),readOnly=pane.textContent.includes('只读')&&!pane.querySelector('textarea,[contenteditable=true],.composer-wrap,.fork-bar,.task-decision-actions');
    f.update();await wait(()=>pane.textContent.includes('LATER_RESULT'),'new background messages');const sameStream=q('.event-stream')===stream;
    f.fail(true);await wait(()=>pane.querySelector('[role=alert]'),'read error');const retained=stream.textContent.includes('CURATION_OUTPUT');f.fail(false);button('重试').click();await wait(()=>!pane.querySelector('[role=alert]'),'retry');
    q('[aria-label="返回需求概览"]').click();await wait(()=>q('.rr-curation-entry'),'return to overview');const reads=f.reads();await new Promise(r=>setTimeout(r,1700));
    return{actions:f.calls.filter(a=>a!=='read'),config:f.saves[0].requirementCuration,noOldFiles,stableId,readOnly,sameStream,retained,stopped:f.reads()===reads};})()`
})
assert.deepEqual(result.actions, ['pause','retry'])
assert.deepEqual(result.config, { enabled:true, agentId:'codex', model:'small', effort:'low' })
assert.equal(result.noOldFiles,true)
assert.equal(result.stableId,true)
for(const key of ['readOnly','sameStream','retained','stopped'])assert.equal(result[key],true,key)
console.log('PASS curation entry, read-only native conversation, live updates, retry/return, settings and storage feedback')

for (const width of [1120, 540]) {
  const layout = await renderEventStream([], 'idle', 'curation-layout', {
    screenshot: { width, height: 850, path: resolve('out/verification/requirement-context/curation-panel-' + width + '.png') },
    setup: `import{useState}from'react';import{RequirementCurationPanel}from'./src/renderer/components/RequirementCurationPanel';import'./src/renderer/components/requirementReader.css';import'./src/renderer/components/workspaceBrowser.css';
      const names=['调整 RouterAgent 顶栏配置与任务创建输入区','修复首页输入未按不同任务排队的问题','校验 SuperAgent 开关默认关闭并发版','修复无排队时短暂显示排队 UI 的问题','统一任务看板与侧栏的未读状态','补齐需求资料的检索入口'];
      const sessions=names.map((title,index)=>({id:'source-'+index,title,config:{agentId:'codex'}}));
      const initial={sessionId:'curation-r',nativeThreadId:'native-thread',model:'ferry-deepseek-v4-1-flash-max',status:'running',current:{id:'current',sessionId:'current-source',kind:'task'},queue:Array.from({length:114},(_,i)=>({id:'job-'+i,sessionId:'source-'+i,kind:i===6?'reading':'task'})),history:[{id:'current',title:'整理任务：处理 Traex 模型下 Router Agent 的定位与可用性',detail:'补提取最近讨论片段的重要信息，保留出处与未验证状态',status:'running'},{id:'old',title:'旧处理记录',detail:'不应出现在面板中',status:'completed'}],updatedAt:1};
      initial.failures=Array.from({length:13},(_,i)=>({id:'failed-'+i,sessionId:'failed-source-'+i,kind:'task',queuedAt:1,title:'失败任务 '+i,error:'引用片段与原文不符，未保存本次摘要',failedAt:1}));
      const actions=[];let value=initial,show,retryError=false;window.uniagent={requirementCuration:async(id,action='read')=>{if(action!=='read')actions.push(action);if(action==='retryFailed'){if(retryError)throw Error('重试失败项失败');value={...value,queue:[...value.queue,...value.failures],failures:[]}}return value},listAgents:async()=>[{id:'codex',name:'Codex',adapter:'codex',capabilities:{startupSystemPrompt:true},models:[{id:initial.model,label:'Ferry DeepSeek-V4.1-Flash-Max',imageInput:true,efforts:['low']}]}],getAppSettings:async()=>({requirementCuration:{enabled:true,agentId:'codex',model:initial.model,effort:'low'}})};
      function Fixture(){const[state,setState]=useState(initial);show=next=>{value=next;setState(next)};return <RequirementCurationPanel id="r" initial={state} sessions={sessions} onOpenConversation={()=>{}}/>}
      const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;background:var(--bg);overflow:auto;padding:24px';createRoot(host).render(<Fixture/>);host.className='scope-context requirement-reader';window.layoutFixture={host,initial,actions,failRetry:value=>{retryError=value},show:next=>show(next)};`,
    inspect: `(async()=>{const f=window.layoutFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,40));for(let i=0;i<60&&!q('.rr-curation-entry');i++)await tick();q('.rr-curation-entry').click();await tick();q('.rr-curation-queue summary').click();await tick();
      const count=()=>q('.rr-curation-queue ol').children.length;
      if(count()!==6||!q('.rr-curation-queue-title').textContent.includes('调整 RouterAgent'))throw Error('queue names or first page');
      const compact=!f.host.textContent.includes('最近处理')&&!f.host.textContent.includes('旧处理记录')&&!f.host.textContent.includes('curation-r')&&!f.host.textContent.includes('补提取最近讨论');
      const nativeTooltip=q('.rr-curation-model').title.includes('curation-r'),currentTitle=q('.rr-curation-current-pill strong').textContent;
      q('[aria-label="下一页待整理任务"]').click();await tick();if(!q('.rr-curation-queue-title').textContent.includes('更新需求重点'))throw Error('next page must show the next item');
      if([...q('.rr-curation-queue ol').children].some(row=>row.textContent.includes('source-')))throw Error('unavailable task exposes ID');
      while(!q('[aria-label="下一页待整理任务"]').disabled){q('[aria-label="下一页待整理任务"]').click();await tick()}
      const last=q('.rr-curation-pagination span').textContent;if(last!=='109–114 / 114')throw Error('cannot reach full queue');
      f.show({...f.initial,queue:f.initial.queue.slice(0,2)});await tick();await tick();if(count()!==2||q('.rr-curation-queue:not(.rr-curation-failures) .rr-curation-pagination'))throw Error('shrinking queue leaves invalid page');
      f.show({...f.initial,status:'failed',lastError:'模型连接失败，请稍后重试'});await tick();await tick();const errorVisible=q('[role=alert]')?.textContent.includes('模型连接失败'),retryVisible=f.host.textContent.includes('继续整理');
      f.show(f.initial);await tick();await tick();const picker=getComputedStyle(q('.rr-curation-model-picker'));if(picker.marginTop!=='0px'||picker.paddingTop!=='0px'||picker.borderTopWidth!=='0px')throw Error('reader details style creates blank space');if(q('.rr-curation-current')||q('.rr-curation-current-pill').getBoundingClientRect().height>34)throw Error('current task must be a small capsule');
      q('.rr-curation-failures summary').click();await tick();if(q('.rr-curation-failures ol').children.length!==6||!q('.rr-curation-failure-copy').textContent.includes('引用片段'))throw Error('failure rows and reason');if(q('.rr-curation-entry').textContent.includes('需要重试'))throw Error('one failed task changes the active queue status');
      while(!q('[aria-label="下一页失败任务"]').disabled){q('[aria-label="下一页失败任务"]').click();await tick()}if(q('.rr-curation-failures nav span').textContent!=='13–13 / 13')throw Error('all failed tasks must be reachable');
      f.show({...f.initial,failures:f.initial.failures.slice(0,1)});await tick();await tick();if(q('.rr-curation-failures ol').children.length!==1||q('.rr-curation-failures nav'))throw Error('failure count shrinks to a valid page');
      const retry=()=>[...q('.rr-curation-failures').querySelectorAll('button')].find(b=>b.textContent==='重试失败项');f.failRetry(true);retry().click();await tick();await tick();if(!q('[role=alert]')?.textContent.includes('重试失败项失败')||!q('.rr-curation-failures'))throw Error('retry error keeps failures visible');f.failRetry(false);retry().click();await tick();await tick();if(q('.rr-curation-failures')||q('.rr-curation-failed-count')||f.actions.join()!=='retryFailed,retryFailed')throw Error('failure action and recovery');
      f.show({...f.initial,status:'idle',current:undefined,queue:[]});await tick();await tick();if(!q('.rr-curation-current-pill').textContent.includes('13 项失败待处理'))throw Error('idle does not hide outstanding failures');
      f.show(f.initial);await tick();await tick();q('.rr-curation-queue:not(.rr-curation-failures)').open=false;q('.rr-curation-failures').open=false;const bounds=q('.rr-curation').getBoundingClientRect();
      return{compact,nativeTooltip,currentTitle,last,errorVisible,retryVisible,rows:count(),overflow:q('.rr-curation').scrollWidth>q('.rr-curation').clientWidth,panelHeight:bounds.height};})()`
  })
  for (const key of ['compact','nativeTooltip','errorVisible','retryVisible']) assert.equal(layout[key], true, key)
  assert.equal(layout.currentTitle,'处理 Traex 模型下 Router Agent 的定位与可用性')
  assert.equal(layout.rows,6)
  assert.equal(layout.overflow,false,'panel has no horizontal overflow')
  assert.ok(layout.panelHeight < (width>1000?270:370),'collapsed queue and failures remain compact')
  console.log('PASS compact curation ' + width + ': no inherited spacing, status capsule, queue/failure pagination, retry and compact layout')
}
