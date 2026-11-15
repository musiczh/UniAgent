import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

for (const [width, height] of [[1280,820],[800,640],[440,420]]) {
  const result = await renderEventStream([], 'idle', 'submenu-popover-ui', {
    screenshot: { width, height, path: `out/test/submenu-popover-${width}.png` },
    setup: `
      import {Composer} from './src/renderer/components/Composer';
      import {SessionHeader} from './src/renderer/components/SessionHeader';
      import {SessionTaskContent} from './src/renderer/components/TaskDetail';
      const noop=()=>{},patches=[],longName='Very long native model name '.repeat(8);
      const models=Array.from({length:60},(_,i)=>({id:'model-'+i,label:i===59?longName:'模型 '+i,efforts:['low','high']}));
      const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models,capabilities:{modelSelect:true,reasoningEffort:true,streaming:true,sideChat:true,permissionModes:[]}};
      const session={id:'menu-task',title:'检查长模型列表',status:'completed',createdAt:1,config:{agentId:'codex',projectId:'p',requirementId:'r',model:'model-0',effort:'high',permissionMode:'full-access',workdir:'/fixture'}};
      window.uniagent=new Proxy({listPresets:async()=>[],getTaskState:async()=>null,getTaskDecisions:async()=>[],getSessionInfo:async()=>({native:[],local:[],errors:[]})},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>noop:async()=>null});
      function Harness(){const [config,setConfig]=React.useState(session.config);return <><SessionHeader session={session} agents={[agent]} projects={[{id:'p',name:'执行项目'}]} requirements={[{id:'r',name:'所属需求',projectId:'p'}]} onForkLatest={noop} onOpenSide={noop} onOpenComments={noop}/><SessionTaskContent session={session} events={[]} composer={<Composer sessionId={session.id} status="idle" agent={agent} config={config} onUpdateConfig={patch=>{patches.push(patch);setConfig(current=>({...current,...patch}))}} onSend={async()=>{}} onForceSend={async()=>{}} onInterrupt={noop} onSetCollaborationMode={noop} onRunNativeAction={noop} queue={[]} onDequeue={noop} onPromoteQueue={noop} onEditQueueItem={noop} capabilities={{agentId:'codex',source:'native',candidates:[],actions:{goal:false,review:false,plan:null},errors:[]}} capabilitiesReady contextUsed={0}/> }><div style={{height:1200}}>原对话</div></SessionTaskContent></>}
      const host=document.body.appendChild(document.createElement('div'));host.className='session-view';host.style.cssText='position:fixed;inset:40px 0 0;height:auto;background:var(--bg)';createRoot(host).render(<Harness/>);window.menuFixture={host,patches,longName};
    `,
    inspect: `(async()=>{
      const f=window.menuFixture,tick=()=>new Promise(r=>setTimeout(r,30)),wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label+': '+JSON.stringify(window.__fixtureErrors))};
      const details=()=>f.host.querySelector('.sb-agent'),menu=()=>f.host.querySelector('.sb-sub-menu');
      await wait(()=>details(),'composer');details().querySelector('summary').click();await tick();details().querySelector('.sb-sub-entry').click();await wait(()=>menu(),'model menu');await tick();await tick();
      const layout=()=>{const m=menu(),r=m.getBoundingClientRect(),content=f.host.querySelector('.session-task-content').getBoundingClientRect(),point=document.elementFromPoint(r.left+r.width/2,r.top+8);return{height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right,contentTop:content.top,contentBottom:content.bottom,scrollable:m.scrollHeight>m.clientHeight,uncovered:m.contains(point),horizontalOverflow:m.scrollWidth>m.clientWidth,optionCount:m.querySelectorAll('[role=option]').length}};
      const initial=layout();
      const bottom=menu().querySelector('[role=option]:last-child');menu().scrollTop=menu().scrollHeight;await tick();bottom.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));const fullTooltip=bottom.title===f.longName,scrolled=menu().scrollTop>0;
      const scrollBefore=menu().scrollTop;window.dispatchEvent(new Event('resize'));await tick();const scrollPreserved=menu().scrollTop===scrollBefore;
      const hostHeight=f.host.getBoundingClientRect().height;f.host.style.bottom='auto';f.host.style.height=(hostHeight-90)+'px';await tick();await tick();const shorter=layout();
      f.host.style.height='auto';f.host.style.bottom='0';await tick();await tick();const restored=layout();
      menu().scrollTop=menu().scrollHeight;await tick();bottom.click();await wait(()=>f.patches.length===1&&!menu()&&!details().open,'model selection closes menus');
      const picked=f.patches[0],selectedLabel=details().querySelector('.sb-effort-model').textContent;
      details().querySelector('summary').click();await tick();details().querySelector('.sb-sub-entry').click();await wait(()=>menu(),'reopen');await tick();const selected=menu().querySelector('[aria-selected=true]')?.textContent;
      return{initial,shorter,restored,scrolled,fullTooltip,scrollPreserved,picked,selectedLabel,selected,longName:f.longName,errors:window.__fixtureErrors};
    })()`
  })
  assert.deepEqual(result.errors, [])
  for (const [phase, layout] of Object.entries({initial:result.initial,shorter:result.shorter,restored:result.restored}) as [string, any][]) {
    const label = phase + ' at ' + width + 'px: ' + JSON.stringify(layout)
    assert.ok(layout.height > 0 && layout.height <= 520, label)
    assert.ok(layout.top >= Math.max(40,layout.contentTop) - 1 && layout.bottom <= Math.min(height-12,layout.contentBottom) + 1, label)
    assert.ok(layout.left >= 12 && layout.right <= width-12, label)
    assert.equal(layout.scrollable, true, label)
    assert.equal(layout.uncovered, true, label)
    assert.equal(layout.horizontalOverflow, false, label)
    assert.equal(layout.optionCount, 60, 'height limits must retain all native model options')
  }
  assert.equal(result.scrolled, true)
  assert.equal(result.fullTooltip, true)
  assert.equal(result.scrollPreserved, true, 'repositioning preserves list scroll')
  assert.equal(result.picked.model, 'model-59')
  assert.equal(result.picked.effort, 'high')
  assert.equal(result.selectedLabel, result.longName)
  assert.equal(result.selected, result.longName)
  console.log('PASS model submenu: height, clipping bounds, hit testing, scrolling, resize, full tooltip and real Composer selection at '+width+'x'+height)
}
