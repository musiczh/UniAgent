import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'toolbar-labels', {
  setup: `
    import { SessionHeader } from './src/renderer/App';
    import { MemberSession } from './src/renderer/components/TeamWorkspace';
    import { FileBrowser } from './src/renderer/components/FileBrowser';
    import { ReviewPanel } from './src/renderer/components/ReviewPanel';
    import { ImmersiveReader } from './src/renderer/components/ImmersiveReader';
    import { SideChatPanel } from './src/renderer/components/SideChatPanel';
    const calls=[],errors=[];
    window.addEventListener('error',event=>errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    const action=name=>()=>calls.push(name);
    const noop=()=>{};
    const agent={id:'codex',name:'Codex',adapter:'codex',bin:'codex',installed:true,models:[],
      capabilities:{sideChat:true,sessionFork:true,permissionModes:[]}};
    const session={id:'toolbar',title:'检查工具按钮在局部空间中的显示',status:'idle',nativeSessionId:'native',importMode:'direct',
      config:{agentId:'codex',workdir:'/workspace/UniAgent',permissionMode:'full-access'}};
    const changeSet={isGitRepo:true,items:[],commits:[]};
    window.uniagent=new Proxy({
      homeDir:'/fixture',fsListDir:async()=>({ok:true,root:'/workspace/UniAgent',entries:[{name:'README.md',path:'README.md',kind:'file',size:10}]}),
      fsReadFile:async()=>({ok:true,path:'README.md',kind:'text',language:'markdown',text:'# Heading',size:10}),
      reviewGetChangeSet:async()=>changeSet,getSideEvents:async()=>[],getSideState:async()=>null
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>noop:async()=>null});
    const host=document.body.appendChild(document.createElement('div'));
    host.id='toolbar-fixture';host.style.cssText='position:absolute;left:0;top:0;width:1100px;height:700px';
    const root=createRoot(host);
    const headers={
      session:()=>React.createElement('div',{className:'session-view'},React.createElement(SessionHeader,{
        session,agents:[agent],onReturn:action('return'),onOpenFiles:action('files'),onForkLatest:action('fork'),
        onOpenSide:action('side'),onOpenComments:action('comments'),commentsOpen:true,onRefreshNativeSession:action('refresh')})),
      team:()=>React.createElement(MemberSession,{sessionId:session.id,p:{name:'项目',team:{leaderMemberId:'leader',members:[{id:'leader',role:{name:'角色'}}]},
        memberSessions:{leader:session.id},assignments:[],messages:[],interactions:[],inbox:[]},agents:[agent],sessions:[session],events:[],loading:false,onBack:noop,onForkLatest:action('team-fork')}),
      file:()=>React.createElement(FileBrowser,{sessionId:session.id,workdir:session.config.workdir,focusPath:'README.md',onClose:action('file-close')}),
      review:()=>React.createElement(ReviewPanel,{sessionId:session.id,diff:'',scope:{kind:'workspace'},initialChangeSet:changeSet,onClose:action('review-close')}),
      reader:()=>React.createElement(ImmersiveReader,{file:{sessionId:session.id,name:'README.md',path:'docs/README.md',text:'# Heading',navigation:null,loading:false},
        sessionTitle:session.title,agentName:'Codex',annotations:[],onAddComment:noop,onUpdateComment:noop,onRemoveComment:noop,onOpenFile:noop,onClose:action('reader-close')}),
      side:()=>React.createElement(SideChatPanel,{sessionId:session.id,open:true,agent,onClose:action('side-close'),onPromote:noop})
    };
    window.toolbarFixture={calls,errors,host,mount:kind=>root.render(React.createElement(React.Fragment,{key:kind},headers[kind]())),
      busy:()=>root.render(React.createElement('div',{className:'session-view'},React.createElement(SessionHeader,{
        session,agents:[agent],onForkLatest:action('disabled-fork'),forkLatestDisabled:true,
        onRefreshNativeSession:action('busy-refresh'),refreshingNativeSession:true})))};
  `,
  inspect: `(async()=>{
    const fixture=window.toolbarFixture;
    const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
    const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const wait=async probe=>{for(let i=0;i<150;i++){if(probe())return;await tick()}throw new Error('Toolbar fixture did not settle: '+fixture.kind+' '+JSON.stringify(fixture.errors)+' '+fixture.host.textContent.slice(0,200))};
    const textRects=button=>{
      const walker=document.createTreeWalker(button,NodeFilter.SHOW_TEXT),rects=[];
      while(walker.nextNode()){
        const node=walker.currentNode;
        if(!node.textContent.trim()||node.parentElement.closest('svg'))continue;
        const range=document.createRange();range.selectNodeContents(node);
        rects.push(...Array.from(range.getClientRects()).filter(rect=>rect.width>0&&rect.height>0).map(rect=>({width:rect.width,height:rect.height})));
      }
      return rects;
    };
    const snapshot=selector=>Array.from(fixture.host.querySelectorAll(selector)).map(button=>{
      const rect=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();
      const toolbar=button.closest('.session-header,.readonly-context,.scene-head,.fb-toolbar,.subagent-panel-head').getBoundingClientRect();
      return{width:rect.width,height:rect.height,iconWidth:icon.width,textRects:textRects(button),
        toolbarWidth:toolbar.width,title:button.title,label:button.getAttribute('aria-label'),disabled:button.disabled,iconOnly:button.classList.contains('toolbar-icon-action'),
        expanded:button.getAttribute('aria-expanded'),busy:button.getAttribute('aria-busy'),
        within:rect.left>=toolbar.left&&rect.right<=toolbar.right&&rect.top>=toolbar.top&&rect.bottom<=toolbar.bottom};
    });
    const layouts=[];
    fixture.mount('session');await wait(()=>fixture.host.querySelectorAll('.summary-toggle').length===4);
    for(const width of [1100,800,680,665,664,600,460,320,1100]){
      fixture.host.style.width=width+'px';await settle();
      const header=fixture.host.querySelector('.session-header').getBoundingClientRect();
      const titleOffsets=Array.from(fixture.host.querySelectorAll('.topbar-title-main,.topbar-title-path,.topbar-title > .page-type-badge,.topbar-title > svg')).map(part=>{
        const rect=part.getBoundingClientRect();return Math.abs(rect.top+rect.height/2-header.top-header.height/2);
      });
      layouts.push({width,buttons:snapshot('.summary-toggle'),height:header.height,titleOffsets});
      if(width===320)for(const button of fixture.host.querySelectorAll('.summary-toggle'))button.click();
    }
    fixture.busy();
    fixture.host.style.width='320px';await wait(()=>fixture.host.querySelector('.summary-toggle[aria-busy="true"]'));await settle();
    const disabled=snapshot('.summary-toggle');for(const button of fixture.host.querySelectorAll('.summary-toggle'))button.click();
    const others=[];
    for(const [kind,selector,ready] of [
      ['team','.session-fork-toggle','.session-fork-toggle'],
      ['file','.scene-back-btn,.fb-reader-btn','.fb-reader-btn'],
      ['review','.scene-back-btn','.scene-back-btn'],
      ['reader','.immersive-reader-comments-toggle,.scene-back-btn','.immersive-reader-comments-toggle'],
      ['side','.side-promote-btn','.side-promote-btn']
    ]){
      fixture.kind=kind;fixture.host.style.width='1100px';fixture.mount(kind);await settle();await wait(()=>fixture.host.querySelector(ready));await settle();
      const container=kind==='side'?fixture.host.querySelector('.side-panel'):kind==='reader'?fixture.host.querySelector('.immersive-reader-overlay'):fixture.host;
      container.style.width='1100px';await settle();const wide=snapshot(selector);
      container.style.width=kind==='file'?'560px':'320px';await settle();const narrow=snapshot(selector);
      others.push({kind,wide,narrow});
    }
    return{layouts,disabled,others,calls:fixture.calls,errors:fixture.errors,viewport:window.innerWidth};
  })()`
})

assert.deepEqual(result.errors, [], '工具栏夹具不应触发运行时异常')
for (const layout of result.layouts) {
  const compact = layout.width <= 664
  assert.equal(layout.titleOffsets.length, 3)
  assert.ok(layout.titleOffsets.every((offset: number) => offset <= 1), `${layout.width}px：主标题、页面标记／目录与展开图标应在标题栏内垂直居中 ${JSON.stringify(layout.titleOffsets)}`)
  assert.equal(layout.buttons.length, 4)
  for (const button of layout.buttons) {
    assert.equal(button.textRects.length === 0, compact || button.iconOnly, `${layout.width}px：评论、分叉和侧边始终只显示图标，其它按钮按可用空间显示标签`)
    assert.equal(button.iconWidth, 14, '图标不能被挤压')
    assert.equal(button.within, true, `${layout.width}px：按钮必须留在工具栏内 ${JSON.stringify(button)}`)
    if (compact || button.iconOnly) {
      assert.ok(button.title && button.label, '只显示图标时仍保留完整提示和无障碍名称')
      assert.ok(button.width >= 28 && button.height >= 28, '紧凑按钮保留点击区域')
    } else assert.equal(button.textRects.length, 1, '标签始终显示在一行')
  }
  assert.ok(layout.height <= 48, '工具栏不能被竖排文字撑高')
  assert.equal(layout.buttons[3].expanded, 'true', '展开状态不受文字隐藏影响')
  assert.equal(layout.buttons.filter((button: any) => button.iconOnly).length, 3, '仅评论、分叉和侧边固定为纯图标')
}
assert.deepEqual(result.calls, ['refresh', 'fork', 'side', 'comments'], '收起文字后操作保留，禁用和加载中的按钮不可触发')
assert.ok(result.disabled.every((button: any) => button.disabled && !button.textRects.length))
assert.equal(result.disabled[0].busy, 'true', '加载状态继续暴露')
assert.ok(result.viewport > 600, '窄工具栏应在宽窗口内独立收起文字')
for (const other of result.others) {
  assert.ok(other.wide.length > 0, `${other.kind}：实际组件中存在待检查的按钮`)
  assert.ok(other.wide.every((button: any) => button.textRects.length > 0), `${other.kind}：宽区域保留文字`)
  assert.ok(other.narrow.every((button: any) => !button.textRects.length && button.iconWidth >= 13 && button.within), `${other.kind}：窄区域只保留完整图标且不溢出 ${JSON.stringify(other.narrow)}`)
  assert.ok(other.narrow.every((button: any) => button.title && button.label), `${other.kind}：保留提示和无障碍名称`)
}
console.log('toolbar labels: local resize, no wrapping, icon dimensions, action/state preservation and related toolbars passed')
