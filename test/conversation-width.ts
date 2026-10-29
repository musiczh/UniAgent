import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'conversation-width', {
  setup: `
    import { flushSync } from 'react-dom';
    import { SessionConversation } from './src/renderer/components/SessionConversation';
    import { Composer } from './src/renderer/components/Composer';
    import { GoalStatusBar } from './src/renderer/components/GoalStatusBar';
    const noop = () => {};
    window.uniagent = new Proxy({listPresets:async()=>[],getPrefs:async()=>({lastByAgent:{}})},
      {get:(target,key)=>target[key] || (String(key).startsWith('on') ? () => noop : async () => null)});
    const event = (seq,type,payload) => ({sessionId:'width-fixture',seq,ts:seq*1000,type,payload,state:'success'});
    const events = [
      event(1,'user_message',{text:'检查窗口宽度变化'}),
      event(2,'agent_message',{id:'progress',text:'正在检查布局。',phase:'commentary'}),
      event(3,'command_exec',{id:'read-layout',command:'rg conversation-column-width src/renderer/styles.css',output:'已找到共用宽度。',exitCode:0}),
      event(4,'agent_message',{id:'reply',text:'正文、代码和表格保持在同一内容列。\\n\\n| 内容 | 状态 |\\n| --- | --- |\\n| 布局 | 已检查 |',phase:'final_answer'}),
      event(5,'turn_completed',{})
    ];
    const agent = {id:'codex',name:'Codex',adapter:'codex',bin:'codex',installed:true,models:[],
      capabilities:{modelSelect:false,reasoningEffort:false,permissionModes:[{id:'ask',label:'询问'}]}};
    const composerProps = {status:'idle',sessionId:'width-fixture',agent,
      config:{agentId:'codex',permissionMode:'ask',workdir:'/fixture'},
      onSend:noop,onForceSend:noop,onInterrupt:noop,onUpdateConfig:noop,
      queue:[],onDequeue:noop,onPromoteQueue:noop,onEditQueueItem:noop,
      capabilities:{agentId:'codex',workdir:'/fixture',source:'provider-native',candidates:[],actions:{goal:false,review:false,plan:null},errors:[]},
      capabilitiesReady:true,contextUsed:0,contextWindow:1000000,onCompact:async()=>{},canCompact:false,compacting:false};
    const host = document.body.appendChild(document.createElement('div'));
    host.className = 'width-fixture';
    // Measure settled panel geometry without intermediate animation widths.
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = '.width-fixture .side-panel {animation:none!important}';
    Object.assign(host.style,{width:'1600px',height:'720px',marginLeft:'24px'});
    const root = createRoot(host);
    window.__widthErrors = [];
    window.addEventListener('error',event=>window.__widthErrors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.__widthErrors.push(String(event.reason)));
    window.__mountWidthFixture = async (width,dock,team=false) => {
      host.style.width = width+'px';
      flushSync(()=>root.render(React.createElement('main',{className:'main'+(dock==='summary'?' summary-dock-open':dock==='side'?' side-chat-open':''),style:{height:'100%'}},
        React.createElement('div',{className:'session-view'+(team?' team-session':'')},
          React.createElement('div',{className:'session-header'},'窗口宽度测试'),
          React.createElement('div',{className:'goal-status-shell'},React.createElement(GoalStatusBar,{
            goal:{objective:'验证列宽',status:'active',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:0,updatedAt:0},running:false
          })),
          React.createElement(SessionConversation,{events,status:'idle',workspaceNotice:'当前工作目录提示',afterConversation:
            React.createElement('div',{className:'worktree-creation-shell'},'工作树状态')}),
          React.createElement('div',{className:'interaction-dock-slot'},React.createElement('div',{className:'interaction-dock'},'待回答问题')),
          React.createElement(Composer,composerProps),
          React.createElement('div',{'data-fixed-probe':true,style:{position:'fixed',left:11,top:13,width:1,height:1}})
        ),
        dock ? React.createElement('aside',{className:dock==='summary'?'summary-dock':'subagent-panel side-panel',style:{width:460}},
          dock==='side' ? React.createElement(React.Fragment,null,
            React.createElement('div',{className:'side-panel-stream'},React.createElement(EventStream,{events,status:'idle'})),
            React.createElement('div',{className:'side-composer'},React.createElement(Composer,{...composerProps,sessionId:'side-width-fixture'}))
          ) : '摘要'
        ) : null
      )));
      await Promise.all(host.getAnimations({subtree:true})
        .filter(animation=>animation.effect.getTiming().iterations!==Infinity).map(animation=>animation.finished));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    };
    window.__widthHost = host;
  `,
  inspect: `(async () => {
    const measurements = [];
    const measure = async (label,width,expected,dock,team=false,expanded=false) => {
      await window.__mountWidthFixture(width,dock,team);
      const host = window.__widthHost;
      const session = host.querySelector('.session-view');
      if (!session) throw new Error('Conversation did not render: '+JSON.stringify(window.__widthErrors));
      if (expanded) {
        session.querySelector('.processed-head').click();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      }
      const rect = session.getBoundingClientRect();
      const items = [...session.querySelectorAll('.goal-status-bar,.session-workspace-notice,.user-msg,.agent-msg,.processed-fold,.process-timeline-head,.process-step,.worktree-creation-shell,.interaction-dock,.composer-wrap')]
        .filter(item=>!item.closest('[aria-hidden="true"]'));
      const fixed = session.querySelector('[data-fixed-probe]').getBoundingClientRect();
      const side = host.querySelector('.side-panel');
      const sideRect = side?.getBoundingClientRect();
      measurements.push({label,expected,expanded,sessionWidth:rect.width,overflow:session.scrollWidth>session.clientWidth,
        fixed:{left:fixed.left,top:fixed.top},
        items:items.map(item=>{const bounds=item.getBoundingClientRect();return {
          name:item.className,width:bounds.width,left:bounds.left-rect.left,right:rect.right-bounds.right
        }}),
        side:side ? {width:sideRect.width,items:[...side.querySelectorAll('.user-msg,.agent-msg,.composer-wrap')].map(item=>{
          const bounds=item.getBoundingClientRect();return {name:item.className,left:bounds.left-sideRect.left,right:sideRect.right-bounds.right,width:bounds.width}
        })} : null
      });
    };
    for (const [width,expected] of [[720,680],[879,839],[880,840],[960,840],[1080,840],[1081,841],[1280,1040],[1600,1360],[1920,1680],[960,840]]) {
      await measure('resize/'+width,width,expected);
    }
    await measure('summary-dock',1740,1040,'summary');
    await measure('side-chat',1740,1040,'side');
    await measure('team-session',1600,1360,null,true);
    await measure('expanded-work-history',1600,1360,null,true,true);
    return {measurements,errors:window.__widthErrors};
  })()`
})

assert.deepEqual(result.errors, [], 'conversation fixtures render without runtime errors')
for (const entry of result.measurements) {
  assert.equal(entry.overflow, false, `${entry.label}: resizing must not create horizontal overflow`)
  assert.deepEqual(entry.fixed, { left: 11, top: 13 }, `${entry.label}: viewport overlays retain their positioning`)
  const names = ['goal-status-bar', 'session-workspace-notice', 'user-msg', 'agent-msg', 'processed-fold', 'worktree-creation-shell', 'interaction-dock', 'composer-wrap'];
  if (entry.expanded) names.push('process-timeline-head', 'process-step');
  for (const name of names) {
    assert.ok(entry.items.some(item => item.name.split(' ').includes(name)), `${entry.label}: missing ${name} coverage`)
  }
  for (const item of entry.items) {
    assert.ok(Math.abs(item.width - entry.expected) <= 1, `${entry.label}/${item.name}: expected ${entry.expected}px, got ${item.width}px`)
    assert.ok(Math.abs(item.left - item.right) <= 1, `${entry.label}/${item.name}: gutters must remain symmetric`)
    assert.ok(item.left >= 19 && item.left <= 121, `${entry.label}/${item.name}: gutter must stay within 20–120px`)
  }
  if (entry.side) {
    assert.equal(entry.side.width, 460, 'side chat retains its independent panel width')
    assert.equal(entry.side.items.length, 3, 'side chat renders user, assistant and composer')
    for (const item of entry.side.items) {
      assert.ok(item.width > 0 && item.left >= 0 && item.right >= 0, `side chat/${item.name}: stays within its own panel`)
    }
  }
}
console.log(`conversation width: ${result.measurements.length} resize, dock and team layouts passed`)
