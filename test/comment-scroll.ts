import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

// The existing comment UI fixture mounts the panel beside a separate React root;
// use the real conversation/panel layout here so opening it reflows the reply.
const result = await renderEventStream([], 'idle', 'unused', {
  setup: `
    import {CommentProvider, useComments} from './src/renderer/comments';
    import {CommentPanel} from './src/renderer/components/CommentPanel';
    import {SessionConversation} from './src/renderer/components/SessionConversation';
    import {commentAnchor} from './src/shared/comments';
    import './src/renderer/commentStyles.css';
    const noop=()=>{};
    window.uniagent=new Proxy({}, {get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? ()=>noop : async()=>null});
    const agent={id:'codex',name:'Codex',adapter:'codex',models:[],capabilities:{permissionModes:[]}};
    window.uniagent.listComments=async()=>[];
    let nextId=0;
    window.uniagent.createComment=async(sessionId,selection)=>{
      await new Promise(resolve=>{window.finishCreate=resolve});
      return {id:'comment-'+(++nextId),sessionId,anchor:commentAnchor(selection),createdAt:1,updatedAt:1,
        config:{agentId:'codex'},events:[],status:'draft'};
    };
    function Fixture(){
      const comments=useComments();
      const [scenario,setScenario]=React.useState('history');
      const [extra,setExtra]=React.useState(0);
      const [signal,setSignal]=React.useState(0);
      const session=React.useMemo(()=>({id:scenario,config:{agentId:'codex'}}),[scenario]);
      const sentence='布局改变后，需要保持所选原文在视口中的位置。';
      const text=Array.from({length:18},(_,i)=>'第'+i+'段：'+sentence.repeat(12)).join('\\n\\n')+
        '\\n\\n'+sentence.repeat(10)+'**评论定位目标**'+sentence.repeat(5)+
        (scenario==='history' ? '\\n\\n'+Array.from({length:8},()=>sentence.repeat(12)).join('\\n\\n') : '');
      const events=[{sessionId:scenario,seq:1,ts:1,type:'agent_message',state:'success',payload:{id:'reply',turnId:'turn',text,phase:'final_answer'}},
        {sessionId:scenario,seq:2,ts:2,type:'turn_completed',payload:{}},
        ...(extra ? [{sessionId:scenario,seq:3,ts:3,type:'user_message',payload:{text:sentence.repeat(25*extra)}}] : [])];
      React.useEffect(()=>comments.configure(session,[agent]),[session]);
      window.scrollFixture={comments,append:()=>setExtra(value=>value+1),bottom:()=>setSignal(value=>value+1),
        switchSession:()=>{setScenario('bottom');setExtra(0)}};
      return React.createElement('main',{className:'main',style:{width:1100,height:560,flex:'none'}},
        React.createElement('div',{className:'session-view',style:{flex:1,minWidth:0}},
          React.createElement(SessionConversation,{sessionId:scenario,events,status:'idle',scrollToBottomSignal:signal,
            selection:{annotations:comments.annotations([],scenario,events),onSideComment:value=>comments.begin(value),
              onComment:noop,onEditComment:noop,onUpdateComment:noop,onRemoveComment:noop,onEditRequestHandled:noop}})),
        React.createElement(CommentPanel));
    }
    const style=document.head.appendChild(document.createElement('style'));style.textContent='#root{display:none}';
    const host=document.body.appendChild(document.createElement('div'));host.id='scroll-fixture';
    createRoot(host).render(React.createElement(CommentProvider,null,React.createElement(Fixture)));
  `,
  inspect: `(async()=>{
    const wait=()=>new Promise(resolve=>setTimeout(resolve,80));
    const stream=()=>document.querySelector('#scroll-fixture .session-view .event-stream');
    const target=()=>stream().querySelector('.agent-md strong');
    const rect=()=>{const range=document.createRange();range.selectNodeContents(target());return range.getBoundingClientRect()};
    const position=()=>rect().top-stream().getBoundingClientRect().top;
    const bottomGap=()=>stream().scrollHeight-stream().scrollTop-stream().clientHeight;
    const open=async()=>{
      const range=document.createRange();range.selectNodeContents(target());
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      target().dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await wait();
      const before=position();const width=stream().clientWidth;
      [...document.querySelectorAll('.sel-pop button')].find(button=>button.textContent.includes('侧边评论')).click();
      await wait();const loading=position();const narrowed=stream().clientWidth<width;
      window.finishCreate();await wait();
      return {before,loading,after:position(),narrowed,highlight:!!target().querySelector('mark'),
        composerFocused:document.activeElement===document.querySelector('.ai-comment-composer textarea')};
    };
    await wait();
    stream().scrollTop+=position()-180;await wait();
    const history=await open();
    const separator=document.querySelector('[aria-label="调整侧边评论宽度"]');
    separator.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));await wait();
    const resized=position();const shell=stream().closest('.main');shell.style.height='140px';await wait();const shorterViewport=position();
    shell.style.height='560px';await wait();window.scrollFixture.append();await wait();const appended=position();
    stream().dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true}));stream().scrollTop+=120;await wait();
    const manual=position();separator.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));await wait();
    const manualScrollReleased=Math.abs(position()-history.before)>50;
    window.scrollFixture.bottom();await wait();const explicitBottom=bottomGap();
    window.scrollFixture.append();await wait();const resumedFollowing=bottomGap();
    window.scrollFixture.switchSession();await wait();const switchedBottom=bottomGap();
    const following=await open();
    // Another comment in an already-open panel must keep the same source visible.
    const repeated=await open();
    window.scrollFixture.append();await wait();const followingAppend=position();
    return {history,resized,shorterViewport,appended,manual,manualScrollReleased,explicitBottom,resumedFollowing,switchedBottom,following,repeated,followingAppend};
  })()`
})

for (const [name, sample] of Object.entries({ history: result.history, following: result.following, repeated: result.repeated })) {
  assert.ok(sample.before >= 0 && sample.before < 560, `${name}: selected source starts in the viewport`)
  assert.ok(Math.abs(sample.loading - sample.before) <= 2, `${name}: opening the panel moved the source: ${JSON.stringify(sample)}`)
  assert.ok(Math.abs(sample.after - sample.before) <= 2, `${name}: async highlight/focus moved the source: ${JSON.stringify(sample)}`)
  assert.equal(sample.highlight, true, `${name}: persisted highlight is applied`)
  assert.equal(sample.composerFocused, true, `${name}: comment input receives focus`)
}
assert.equal(result.history.narrowed, true, 'fixture exercises the actual side-panel reflow')
assert.equal(result.following.narrowed, true)
assert.equal(result.repeated.narrowed, false)
assert.ok(Math.abs(result.resized - result.history.before) <= 2, 'panel resizing keeps the source anchored')
assert.ok(result.shorterViewport >= 0 && result.shorterViewport <= 110, 'a shorter viewport keeps the selected text visible')
assert.ok(Math.abs(result.appended - result.history.before) <= 2, 'incoming messages do not steal the comment position')
assert.ok(Math.abs(result.followingAppend - result.following.before) <= 2, 'commenting suspends bottom following')
assert.ok(Math.abs(result.manual - result.history.before + 120) <= 2, 'the user can still scroll away')
assert.equal(result.manualScrollReleased, true, 'manual scrolling releases the selection anchor')
assert.ok(result.explicitBottom < 2, 'explicit navigation to the bottom releases the anchor')
assert.ok(result.resumedFollowing < 2, 'bottom following resumes for later messages after explicit navigation')
assert.ok(result.switchedBottom < 2, 'switching sessions restores normal bottom following')
console.log('comment scroll: reflow, delayed highlight/focus, resize, incoming messages, manual scroll and session reset passed')
