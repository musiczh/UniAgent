import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Horizontal alignment tests do not mount the App's portalled request dock.
// Exercise that actual tree, including its reserved space during fullscreen.
for (const size of [{ width: 1360, height: 900 }, { width: 1024, height: 640 }, { width: 1800, height: 1000 }]) {
  const result = await renderEventStream([], 'idle', 'task-composer-height', {
    screenshot: { ...size, path: resolve('out/test/task-composer-height-' + size.width + '.png') },
    setup: `
      import {SessionTaskContent} from './src/renderer/components/TaskDetail';
      import {Composer} from './src/renderer/components/Composer';
      import {TurnStatusBar} from './src/renderer/components/EventStream';
      import {projectTaskDecisions} from './src/shared/taskDecisions';
      import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
      installMarkdownInputDriver();
      const errors=[],listeners=[];
      window.addEventListener('error',e=>errors.push(e.message));
      window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const session={id:'height',title:'修复任务卡片展开与收起后的输入区高度',status:'running',createdAt:1,
        config:{agentId:'codex',workdir:'/fixture'},
        taskRegistration:{inputText:Array.from({length:20},(_,i)=>'任务描述 '+i+'：保留输入框与原交互链路。').join('\\n\\n')}};
      const row=(seq,type,payload,state='success')=>({sessionId:session.id,seq,ts:Date.now()-1000,type,state,payload});
      const question=id=>({requestId:id,delivery:'async',kind:'question',method:'item/tool/requestUserInput',
        params:{questions:[{id,header:id,prompt:'输入确认意见',options:[]}]}});
      let events=[row(1,'user_message',{text:'输入框下方又空了一大片'}),row(2,'turn_started',{}),
        row(3,'agent_message',{text:Array.from({length:40},(_,i)=>'材料 '+i+'：检查任务页展开、收起与输入框底边距。').join('\\n\\n')}),
        row(4,'approval_request',question('T1'),'pending')];
      window.uniagent=new Proxy({getTaskState:async()=>null,getTaskDecisions:async()=>projectTaskDecisions(session,events),listPresets:async()=>[],
        onEvent:cb=>{listeners.push(cb);return()=>{const i=listeners.indexOf(cb);if(i>=0)listeners.splice(i,1)}}},
        {get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
      const capabilities={agentId:'codex',workdir:'/fixture',source:'native',candidates:[],errors:[],actions:{goal:false,review:false,plan:null}};
      const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[],capabilities:{permissionModes:[],reasoningEffort:false}};
      const host=document.body.appendChild(document.createElement('div'));
      host.className='session-view';host.style.cssText='position:fixed;left:286px;right:0;top:50px;bottom:0;height:auto;background:var(--bg)';
      const root=createRoot(host),dock={current:null};
      const render=()=>root.render(React.createElement(SessionTaskContent,{session,status:session.status,events,
        composer:React.createElement(React.Fragment,null,
          React.createElement(TurnStatusBar,{events,status:session.status}),
          React.createElement('div',{className:'interaction-dock-slot',ref:node=>dock.current=node}),
          React.createElement(Composer,{sessionId:session.id,status:session.status,config:session.config,agent,queue:[],capabilities,capabilitiesReady:true,
            contextUsed:0,contextWindow:0,onSend:()=>{},onForceSend:()=>{},onInterrupt:()=>{},onUpdateConfig:()=>{},onSetCollaborationMode:()=>{},
            onRunNativeAction:()=>{},onDequeue:()=>{},onPromoteQueue:()=>{},onEditQueueItem:()=>{}}))
      },React.createElement(EventStream,{events,status:session.status,sessionId:session.id,onRespond:async()=>{},requestDockRef:dock})));
      render();window.heightFixture={host,errors,rerender:render,
        addQuestion:()=>{events=[...events,row(5,'approval_request',question('T2'),'pending')];render();listeners.forEach(cb=>cb(events.at(-1)))},
        clearQuestions:()=>{events=events.filter(e=>e.type!=='approval_request');render();listeners.forEach(cb=>cb(row(6,'approval_request',{})))} };
    `,
    inspect: `(async()=>{
      const f=window.heightFixture,tick=()=>new Promise(r=>setTimeout(r,30));
      const wait=async p=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error('height fixture did not settle: '+f.host.textContent)};
      await wait(()=>f.host.querySelector('.interaction-dock .approval-answer'));
      const composer=f.host.querySelector('.composer-wrap'),form=f.host.querySelector('.interaction-panel .question-form');
      await wait(()=>composer.querySelector('.markdown-editor-content[contenteditable="true"]'));
      const answer=form.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(answer,'保留这份回答草稿');
      answer.dispatchEvent(new Event('input',{bubbles:true}));
      window.__markdownInput.fill(composer,'保留输入框草稿');await tick();
      const rect=el=>{const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right}};
      const measure=()=>{const dock=f.host.querySelector('.interaction-dock'),panel=dock?.querySelector('.interaction-panel:not([hidden])'),tabs=dock?.querySelector('.interaction-tabs:not([hidden])');
        return {host:rect(f.host),input:rect(composer),dock:dock?rect(dock):null,head:dock?rect(dock.querySelector('.interaction-dock-head')):null,
          tabs:tabs?rect(tabs):null,scrollable:!!panel&&panel.scrollHeight>panel.clientHeight,panelHeight:panel?.clientHeight,
          visible:composer.checkVisibility(),sameComposer:f.host.querySelector('.composer-wrap')===composer,
          transcriptVisible:getComputedStyle(f.host.querySelector('.event-stream')).visibility==='visible',transcriptHeight:f.host.querySelector('.event-stream')?.clientHeight,
          sameForm:f.host.contains(form),draft:window.__markdownInput.text(composer),answer:answer.value,
          horizontalOverflow:f.host.scrollWidth>f.host.clientWidth};};
      const layouts={expanded:measure()};
      const toggle=()=>f.host.querySelector('[data-request-collapse-toggle]').click();
      toggle();await tick();layouts.collapsed=measure();
      toggle();await tick();layouts.reopened=measure();
      f.host.querySelector('[data-request-fullscreen-toggle]').click();
      await wait(()=>f.host.querySelector('.is-fullscreen'));await new Promise(r=>setTimeout(r,350));layouts.fullscreen=measure();
      toggle();await wait(()=>f.host.querySelector('.is-collapsed'));await tick();layouts.collapsedFromFullscreen=measure();
      const noReservedHeight=!f.host.querySelector('.interaction-dock-host').style.height;
      toggle();await tick();
      f.host.querySelector('[data-request-fullscreen-toggle]').click();await new Promise(r=>setTimeout(r,350));
      f.host.querySelector('[data-request-fullscreen-toggle]').click();await new Promise(r=>setTimeout(r,350));layouts.fullscreenReturned=measure();
      const panel=f.host.querySelector('.interaction-panel:not([hidden])');panel.scrollTop=panel.scrollHeight;await tick();
      const scrolled=panel.scrollTop>0;layouts.scrolled=measure();
      f.addQuestion();await wait(()=>f.host.querySelectorAll('.interaction-tabs button').length===2);layouts.multiple=measure();
      f.host.querySelectorAll('.interaction-tabs button')[1].click();await tick();layouts.otherQuestion=measure();
      f.host.querySelectorAll('.interaction-tabs button')[0].click();await tick();
      f.rerender();await tick();layouts.rerendered=measure();
      const shortHeight=Math.min(f.host.clientHeight,560);f.host.style.bottom='auto';f.host.style.height=shortHeight+'px';await tick();layouts.resized=measure();
      f.host.style.height='auto';f.host.style.bottom='0';await tick();layouts.restored=measure();
      f.clearQuestions();await wait(()=>!f.host.querySelector('.interaction-dock'));
      layouts.noQuestion=measure();
      return{layouts,scrolled,noReservedHeight,errors:f.errors};
    })()`
  })
  await writeFile('out/test/task-composer-height-' + size.width + '.json', JSON.stringify(result, null, 2))
  assert.deepEqual(result.errors, [])
  for (const [phase, layout] of Object.entries(result.layouts) as [string, any][]) {
    const label = phase + ' at ' + size.width + 'px: ' + JSON.stringify(layout)
    assert.ok(layout.input.bottom <= layout.host.bottom + 1, 'input stays inside the window, ' + label)
    assert.ok(Math.abs(layout.host.bottom - layout.input.bottom - 14) < 1, 'keep the original 14px bottom gutter, ' + label)
    assert.equal(layout.visible, true, label)
    assert.equal(layout.sameComposer, true, label)
    assert.equal(layout.horizontalOverflow, false, label)
    assert.equal(layout.transcriptVisible, true, 'pending questions retain the actual conversation, ' + label)
    assert.ok(layout.transcriptHeight > 0, 'conversation has usable space, ' + label)
    assert.equal(layout.draft, '保留输入框草稿', label)
    if (phase !== 'noQuestion') {
      assert.equal(layout.sameForm, true, label)
      assert.equal(layout.answer, '保留这份回答草稿', label)
      assert.ok(layout.dock.bottom <= layout.input.top, 'card never covers the input, ' + label)
      assert.ok(layout.head.height > 0 && layout.head.bottom <= layout.dock.bottom + 1, 'card controls stay inside the card, ' + label)
      if (layout.tabs) assert.ok(layout.tabs.bottom <= layout.dock.bottom + 1, 'request switcher stays inside the card, ' + label)
      if (layout.panelHeight !== undefined) assert.ok(layout.panelHeight > 0, 'expanded materials remain scrollable, ' + label)
    }
  }
  assert.ok(result.layouts.expanded.scrollable, 'long request materials scroll within the card')
  assert.ok(result.layouts.fullscreen.dock.height > result.layouts.expanded.dock.height, 'fullscreen still expands the original card')
  assert.ok(result.scrolled, 'request body actually scrolls')
  assert.ok(result.noReservedHeight, 'fullscreen collapse clears its reserved space')
  console.log('PASS task composer height, collapse/fullscreen, request switching, resize and original drafts at ' + size.width + 'px')
}
