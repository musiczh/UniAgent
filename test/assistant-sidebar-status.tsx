import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'assistant-sidebar-status', {
  setup: `
    import {useState} from 'react';
    import {SpaceRequirementNavigation} from './src/renderer/components/WorkspaceBrowser';
    const make=(id,extra={},config={})=>({id,title:id,status:'idle',createdAt:1,config:{agentId:'codex',workdir:'/fixture',assistantSnapshot:{assistantId:'personal'},...config},...extra});
    const sessions=[make('feishu'),make('weixin',{}, {assistantChannel:'weixin'}),make('app',{}, {assistantChannel:'app'}),make('archived',{archived:true,status:'running'}),make('archived-status',{status:'archived'}),make('archived-phase',{taskState:{phase:'archived'}}),make('member',{teamBinding:{}}),make('downstream',{handoffId:'handoff',handoffUserContinued:true}),make('normal')];
    delete sessions.at(-1).config.assistantSnapshot;
    const host=document.body.appendChild(document.createElement('aside'));host.className='sidebar';host.style.cssText='width:260px;min-width:260px';
    const navigations=[];
    function Fixture(){
      const [state,setState]=useState({sessions,status:{},pending:{},unread:{}});window.updateAssistantStatus=patch=>setState(current=>({...current,...patch}));
      return <SpaceRequirementNavigation data={{projects:[],requirements:[],requirementsEnabled:true,projectsLoading:false,requirementsLoading:false}} location={{kind:'assistant'}} {...state} onNavigate={value=>navigations.push(value)} onCreate={()=>{}}/>;
    }
    const root=createRoot(host);root.render(<Fixture/>);window.assistantStatusFixture={host,root,sessions,navigations};
  `,
  inspect: `(async()=>{
    const f=window.assistantStatusFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,25)),wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label)},check=(value,label)=>{if(!value)throw Error(label)};
    const marker=()=>q('.scope-assistant .si-spinner,.scope-assistant .si-unread,.scope-assistant .si-ask');
    const unread=()=>q('.scope-assistant .si-unread');
    await wait(()=>q('.scope-assistant'),'mount');check(!marker(),'idle/read assistants have no indicator');
    const height=q('.scope-assistant').getBoundingClientRect().height;
    window.updateAssistantStatus({status:{normal:'running',member:'running',downstream:'running','archived-status':'running','archived-phase':'running'},unread:{archived:'main','archived-status':'main','archived-phase':'main',normal:'main',member:'main',downstream:'main'}});await tick();check(!marker(),'ordinary, archived, member and downstream tasks cannot affect the assistant entry');
    window.updateAssistantStatus({status:{feishu:'running'},unread:{}});await wait(()=>q('.scope-assistant .si-spinner'),'running assistant indicator');
    check(getComputedStyle(marker()).animationName==='si-spin','reuse the real session running animation');
    window.updateAssistantStatus({status:{feishu:'completed'},unread:{feishu:'main'}});await wait(()=>unread(),'completion unread dot');
    check(unread().textContent===''&&unread().getBoundingClientRect().height===8&&getComputedStyle(unread()).backgroundColor==='rgb(91, 157, 255)'&&unread().getAttribute('aria-label')==='个人助手有未读消息'&&!q('.scope-assistant .scope-badge'),'assistant shows an accessible blue dot without a numeric badge');
    q('.scope-assistant').click();await tick();check(!!unread(),'opening the assistant workspace alone does not read every channel');
    window.updateAssistantStatus({unread:{}});await tick();check(!marker(),'reading the conversation removes the dot');
    window.updateAssistantStatus({unread:{weixin:'side'}});await tick();check(unread()&&getComputedStyle(unread()).backgroundColor==='rgb(91, 157, 255)','side replies use the same blue dot');
    window.updateAssistantStatus({unread:{weixin:'side',app:'main'}});await tick();check(q('.scope-assistant').querySelectorAll('.si-unread').length===1,'multiple unread channels share one sidebar dot');
    const many=Array.from({length:12},(_,i)=>({...f.sessions[0],id:'many-'+i}));
    window.updateAssistantStatus({sessions:many,unread:Object.fromEntries(many.map(s=>[s.id,'main']))});await tick();
    const row=q('.scope-assistant');
    check(unread().textContent===''&&unread().getBoundingClientRect().width===8&&row.scrollWidth<=row.clientWidth,'many unread sessions keep one compact dot');
    window.updateAssistantStatus({sessions:f.sessions,unread:{weixin:'side',app:'main'}});await tick();
    window.updateAssistantStatus({status:{app:'queued'}});await tick();check(q('.scope-assistant .si-spinner')&&unread(),'queued activity and unread remain visible together');
    window.updateAssistantStatus({pending:{weixin:true}});await tick();check(q('.scope-assistant .si-ask')&&unread(),'pending questions retain priority over activity while unread stays visible');
    window.updateAssistantStatus({pending:{},status:{app:'awaiting-approval'}});await tick();check(q('.scope-assistant .si-ask'),'approval status stays visible without an event');
    for(const activity of ['running','queued','cancelling','waiting_members']){window.updateAssistantStatus({status:{app:activity}});await tick();check(q('.scope-assistant .si-spinner'),'busy state '+activity);}
    window.updateAssistantStatus({status:{},unread:{},sessions:f.sessions.map(s=>s.id==='app'?{...s,recovery:{phase:'backoff'}}:s)});await tick();check(q('.scope-assistant .si-spinner'),'recovery remains active');
    window.updateAssistantStatus({sessions:f.sessions.map(s=>s.id==='app'?{...s,pendingQueue:[{state:'pending'}]}:s)});await tick();check(q('.scope-assistant .si-spinner'),'pending queued input remains active');
    window.updateAssistantStatus({sessions:f.sessions.map(s=>s.id==='app'?{...s,status:'running',archived:true}:s)});await tick();check(!marker(),'archiving a running assistant removes its contribution');
    window.updateAssistantStatus({sessions:[]});await tick();check(!marker(),'empty assistant list has no stale indicator');
    check(q('.scope-assistant').getBoundingClientRect().height===height,'status changes preserve the existing row height');
    const navigation=f.navigations;f.root.unmount();return {ok:true,navigation};
  })()`
})

assert.equal(result.ok, true)
assert.deepEqual(result.navigation, [{ kind: 'assistant' }])
console.log('PASS assistant sidebar: blue unread dot, live activity, unread/read transitions, channel aggregation, priority and excluded sessions')
