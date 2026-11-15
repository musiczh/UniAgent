import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'detail-toolbar', {
  setup: `
    import {DetailChatPopover} from './src/renderer/components/DetailChatPopover';
    let statusChanged, finishSide;
    const saved=[],discarded=[],closed=[];
    const api={
      onDetailStatus:callback=>{statusChanged=callback;return()=>{}},
      explainDetailSelection:async()=>{},getDetailEvents:async()=>[],getDetailStatus:async()=> 'running',
      promoteDetailToSide:id=>{saved.push(['side',id]);return new Promise(resolve=>{finishSide=resolve})},
      promoteDetailToSession:async id=>{saved.push(['session',id]);return{id:'saved-session'}},
      closeDetail:async id=>{discarded.push(id)}
    };
    window.uniagent=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
    window.fixture={saved,discarded,closed,status:value=>statusChanged(value),finishSide:value=>finishSide(value)};
    const host=document.body.appendChild(document.createElement('div'));
    createRoot(host).render(React.createElement(DetailChatPopover,{sessionId:'source',quote:'选区',selectedMessageText:'完整选区',nonce:1,detached:true,
      onClose:()=>closed.push('closed'),onPromoted:()=>{},onSessionCreated:()=>{}}));
  `,
  inspect: `(async()=>{
    const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
    const buttons=()=>Array.from(document.querySelectorAll('.detail-icon-btn'));
    const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick()}throw new Error('detail toolbar did not settle')};
    await wait(()=>buttons().length===3);
    const hints=()=>buttons().map(button=>{
      const rect=button.getBoundingClientRect(),target=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      return{label:button.getAttribute('aria-label'),disabled:button.disabled,hint:target?.closest('[title]')?.title,
        buttonReceivesPointer:!!target?.closest('button'),width:rect.width,height:rect.height};
    });
    const running=hints();
    window.fixture.status({sessionId:'source',status:'idle'});
    await wait(()=>!buttons()[0].disabled);
    const idle=hints();
    buttons()[0].click();await wait(()=>buttons()[2].disabled);
    const saving=hints();window.fixture.finishSide(true);
    await wait(()=>window.fixture.closed.length===1&&!buttons()[1].disabled);
    buttons()[1].click();await wait(()=>window.fixture.closed.length===2&&!buttons()[2].disabled);
    buttons()[2].click();await wait(()=>window.fixture.closed.length===3);
    return{running,idle,saving,saved:window.fixture.saved,discarded:window.fixture.discarded};
  })()`
})

for (const item of result.running.slice(0, 2)) {
  assert.equal(item.disabled, true)
  assert.equal(item.buttonReceivesPointer, false, 'disabled buttons must expose a hoverable tooltip target')
  assert.match(item.hint, /解释生成完成后可用/)
}
assert.deepEqual(result.running.map((item: any) => item.label), ['保留为侧边对话', '保存为新会话', '关闭解释'])
assert.match(result.running[2].hint, /关闭.*丢弃未保存/)
assert.match(result.idle[0].hint, /原会话.*侧边栏/)
assert.match(result.idle[1].hint, /保存到会话列表/)
for (const item of result.saving) {
  assert.equal(item.disabled, true)
  assert.equal(item.buttonReceivesPointer, false)
  assert.match(item.hint, /正在保存解释/)
}
assert.ok(result.idle.every((item: any) => item.width === 28 && item.height === 28), 'tooltip targets preserve existing button dimensions')
assert.deepEqual(result.saved, [['side', 'source'], ['session', 'source']])
assert.deepEqual(result.discarded, ['source'])
console.log('detail toolbar: action hints, disabled hover targets, saving state and original actions passed')
