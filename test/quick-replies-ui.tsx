import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

for (const width of [1360, 1024]) {
  const result = await renderEventStream([], 'idle', 'quick-replies-ui', {
    keyEvents: [{ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
    screenshot: { width, height: 760, path: resolve('out/test/quick-replies-ui-' + width + '.png') },
    setup: `
      import {SessionTaskContent} from './src/renderer/components/TaskDetail';
      import {Composer} from './src/renderer/components/Composer';
      import {TurnStatusBar} from './src/renderer/components/EventStream';
      const noop=()=>{},errors=[],sent=[];window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[],capabilities:{modelSelect:false,permissionModes:[]}};
      const choices=[{label:'继续实施',text:'按已确认方案继续实施，并运行相关回归。'},{label:'查看结果',text:'请展示当前结果，说明验证结论。'},{label:'补充说明',text:'请补充说明下一步的改动范围。'}];
      let session={id:'quick-task',title:'快捷回复行为',createdAt:1,status:'completed',config:{agentId:'codex',workdir:'/fixture'},submittedUserMessages:[{type:'user_message',userOrdinal:1,acceptedAt:1,textHash:'input'}],quickReplies:choices};
      const events=[{sessionId:session.id,seq:1,ts:1,type:'user_message',state:'success',payload:{text:'实现快捷回复'}},{sessionId:session.id,seq:2,ts:1001,type:'agent_message',state:'success',payload:{text:'本轮已结束。'}}];
      let composerGeneration=0,phase='active',prefill={text:'',nonce:0};const snapshot=()=>({record:{formatVersion:1,taskId:session.id,version:1,phase,inputRevision:'input',reports:[],history:[],operations:[]},busy:false,pendingDecisions:0,inputRevision:'input',turnRevision:'turn'});
      window.uniagent=new Proxy({getTaskState:async()=>snapshot(),getTaskDecisions:async()=>[],listPresets:async()=>[]},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>noop:async()=>null});
      const capabilities={agentId:'codex',workdir:'/fixture',source:'native',candidates:[],errors:[],actions:{goal:false,review:false,plan:null}};
      const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;left:300px;right:0;top:0;bottom:0;display:flex;background:var(--bg)';
      const root=createRoot(host),render=()=>root.render(React.createElement(SessionTaskContent,{session,status:session.status,events,
        composer:React.createElement(React.Fragment,null,React.createElement(TurnStatusBar,{events,status:session.status}),React.createElement(Composer,{key:session.id+composerGeneration,sessionId:session.id,status:session.status,agent,config:session.config,prefill,queue:[],capabilities,capabilitiesReady:true,contextUsed:0,contextWindow:0,onSend:async text=>{sent.push({id:session.id,text});session.quickReplies=undefined;session.status='running';render()},onForceSend:noop,onInterrupt:noop,onUpdateConfig:noop,onSetCollaborationMode:noop,onRunNativeAction:noop,onDequeue:noop,onPromoteQueue:noop,onEditQueueItem:noop}))},React.createElement('p',null,'本轮回答：按已确认设计继续推进。')));render();
      window.quickFixture={host,sent,errors,choices,remountComposer:()=>{composerGeneration++;render()},setCount:n=>{session.quickReplies=choices.slice(0,n);render()},prefill:text=>{prefill={text,nonce:prefill.nonce+1};render()},standby:()=>{phase='standby';session.taskState={phase,version:2,updatedAt:2};render()},other:()=>{session={...session,id:'another-task',quickReplies:undefined,status:'completed'};prefill={text:'',nonce:0};render()}};
    `,
    inspect: `(async()=>{
      const f=window.quickFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,15)),wait=async p=>{for(let i=0;i<150;i++){if(p())return;await tick()}throw Error('quick reply UI timeout: '+f.host.textContent+' / '+f.errors)};
      const input=()=>q('.composer-input textarea')||q('.composer-input [contenteditable]'),text=()=>input()?.value??input()?.innerText??'';
      const measure=()=>{const bar=q('.task-shared-composer .plan-bar').getBoundingClientRect(),composer=q('.composer-wrap').getBoundingClientRect(),timer=q('.task-shared-composer .turn-timer').getBoundingClientRect(),actions=q('.task-decision-actions').getBoundingClientRect();return{center:Math.abs((timer.left+actions.right)/2-(composer.left+composer.right)/2),above:bar.bottom<=composer.top,overflow:f.host.scrollWidth>f.host.clientWidth}};
      await wait(()=>q('.quick-reply')&&input());const counts=[];for(const n of [1,2,3]){f.setCount(n);await wait(()=>f.host.querySelectorAll('.quick-reply').length===n);counts.push(measure())}
      const labels=[...f.host.querySelectorAll('.quick-reply>span:first-child')].map(x=>x.textContent),tooltip=q('.quick-reply-tooltip').textContent;
      q('.quick-reply').click();await wait(()=>text()===f.choices[0].text&&input()===document.activeElement);const first={text:text(),sent:f.sent.length,focused:input()===document.activeElement};
      f.remountComposer();await tick();await tick();const remountedDraft=text();f.prefill('已有草稿');await wait(()=>text()==='已有草稿');q('.quick-reply').click();await wait(()=>text().includes(f.choices[0].text));const appended=text();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));q('.quick-reply').focus();await tick();const tooltipShown=getComputedStyle(q('.quick-reply-tooltip')).display!=='none';
      f.standby();await wait(()=>q('.task-standby'));const hiddenStandby=![...f.host.querySelectorAll('.task-decision-actions button')].some(b=>b.textContent==='暂存');
      q('[aria-label="发送"]').click();await wait(()=>f.sent.length===1&&!q('.quick-reply'));const clearedAfterSend=!q('.quick-reply');
      f.other();await wait(()=>f.host.querySelector('[data-task-id="another-task"]')&&input());await tick();const otherDraft=text().trim();
      return{counts,labels,tooltip,first,remountedDraft,appended,tooltipShown,hiddenStandby,clearedAfterSend,sent:f.sent,otherDraft,errors:f.errors};
    })()`
  })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.labels, ['继续实施','查看结果','补充说明'])
  assert.equal(result.tooltip, '按已确认方案继续实施，并运行相关回归。')
  assert.deepEqual(result.first, { text: result.tooltip, sent: 0, focused: true })
  assert.equal(result.remountedDraft, result.tooltip, 'remounting the composer never reapplies a consumed suggestion');
  assert.equal(result.appended, '已有草稿\n' + result.tooltip)
  assert.equal(result.tooltipShown, true, 'focused pill exposes its full reply')
  assert.equal(result.hiddenStandby, true, 'disabled standby pill is hidden')
  assert.equal(result.clearedAfterSend, true, 'new input clears old pills')
  assert.deepEqual(result.sent, [{ id: 'quick-task', text: result.appended }])
  assert.equal(result.otherDraft, '', 'switching task never reapplies a previous reply selection')
  assert.ok(result.counts.every(layout => layout.center < 1 && layout.above && !layout.overflow), JSON.stringify(result.counts))
  console.log('PASS centered reply pills, tooltip, preserved draft, explicit send and task switch at ' + width)
}
