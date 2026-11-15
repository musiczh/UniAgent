import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'requirement-task-counts-ui', {
  screenshot: { width: 1024, height: 640, path: 'out/test/requirement-task-counts-ui.png' },
  setup: `
    import {useState} from 'react';
    import {SpaceRequirementNavigation} from './src/renderer/components/WorkspaceBrowser';
    import {BROWSER_EXPANDED_KEY} from './src/renderer/scopeBrowser';
    localStorage.clear();localStorage.setItem(BROWSER_EXPANDED_KEY,JSON.stringify(['owner']));
    const sessions=[{id:'run',title:'运行任务',status:'running',createdAt:1,config:{agentId:'codex',projectId:'exec',requirementId:'r'}},{id:'done',title:'已回复任务',status:'completed',createdAt:1,config:{agentId:'codex',projectId:'owner',requirementId:'r'}}];
    const data={projects:[{id:'owner',name:'主空间',isDefault:true},{id:'exec',name:'执行空间'}],projectsLoading:false,projectsError:'',requirements:[{id:'r',name:'DeepSeek superAgent',projectId:'owner',status:'active'}],requirementsEnabled:true,requirementsLoading:false,requirementsError:''};
    const host=document.body.appendChild(document.createElement('aside'));host.className='sidebar';host.style.cssText='position:fixed;left:20px;top:20px;width:300px;min-width:0;height:600px';
    const opened=[],created=[];
    function Fixture(){const [props,setProps]=useState({sessions,status:{},pending:{},unread:{done:'main'},location:{kind:'requirement',id:'r'}});window.updateCounts=patch=>setProps(current=>({...current,...patch}));return <SpaceRequirementNavigation data={data} {...props} onNavigate={value=>opened.push(value)} onCreate={value=>created.push(value)}/>;}
    const root=createRoot(host);root.render(<Fixture/>);window.countsFixture={host,sessions,opened,created,root};
  `,
  inspect: `(async()=>{
    const f=window.countsFixture,tick=()=>new Promise(r=>setTimeout(r,25));
    const wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label+': '+f.host.innerHTML)};
    const row=()=>f.host.querySelector('.scope-nav-row.requirement');
    const values=()=>[...row().querySelectorAll('.requirement-count')].map(el=>({kind:el.dataset.taskCount,count:el.textContent.trim(),label:el.getAttribute('aria-label')}));
    await wait(()=>row(),'navigation');
    const initial=values();
    if(initial.length!==2)throw Error('Expected running and acceptance count icons; got '+JSON.stringify(initial));
    const height=row().getBoundingClientRect().height;
    const initialSizes=[...row().querySelectorAll('.requirement-count')].map(el=>({kind:el.dataset.taskCount,width:parseFloat(getComputedStyle(el).width)}));
    const progressBadge=()=>{
      const el=row().querySelector('.scope-badge:not(.waiting)'),digit=el?.querySelector('b');
      const box=el?.getBoundingClientRect(),text=digit?.getBoundingClientRect();
      return {text:el?.textContent,label:el?.getAttribute('aria-label'),title:el?.getAttribute('title'),color:el?getComputedStyle(el).color:null,
        width:box?.width,height:box?.height,radius:el?getComputedStyle(el).borderRadius:null,graphic:!!el?.querySelector('svg'),inside:!!box&&!!text&&text.left>=box.left&&text.right<=box.right&&text.top>=box.top&&text.bottom<=box.bottom,
        stationary:!!digit&&[el,digit].every(node=>getComputedStyle(node).animationName==='none'&&getComputedStyle(node).transform==='none')};
    };
    window.updateCounts({unread:{done:'main',run:'side'}});await tick();
    const progress=progressBadge(),withProgress=values(),runningAnimation=getComputedStyle(row().querySelector('.ring-arc')).animationName;
    document.documentElement.dataset.colorTheme='ui-paper';await tick();const lightProgress=progressBadge();
    delete document.documentElement.dataset.colorTheme;
    window.updateCounts({unread:{done:'main'}});await tick();const clearedProgress=!row().querySelector('.scope-badge:not(.waiting)');
    row().querySelector('.scope-nav-name').click();await tick();const afterRead=values();
    window.updateCounts({unread:{}});await tick();const afterViewed=values();
    window.updateCounts({unread:{done:'main'}});await tick();const afterUnread=values(),duplicateUnread=!!row().querySelector('.scope-badge');
    window.updateCounts({status:{run:'completed'},unread:{done:'main',run:'main'}});await tick();const ended=values();
    const standby={phase:'standby',version:1,awaitingAcceptance:false,updatedAt:1};
    window.updateCounts({sessions:f.sessions.map(s=>({...s,status:'completed',taskState:standby})),status:{},unread:{}});await tick();const deferred=values();
    window.updateCounts({sessions:f.sessions.map(s=>({...s,archived:true})),status:{}});await tick();const archived=values();
    window.updateCounts({sessions:f.sessions,status:{run:'awaiting-approval'},pending:{run:true},unread:{done:'main'}});await tick();
    const blocked={icons:values(),waiting:row().querySelector('.scope-badge.waiting')?.textContent,graphic:!!row().querySelector('.scope-badge.waiting svg'),color:getComputedStyle(row().querySelector('.scope-badge.waiting')).color};
    window.updateCounts({status:{run:'running'},pending:{}});await tick();const resumed=values();
    window.updateCounts({unread:{done:'main',run:'side'}});await tick();
    const layout=[];
    for(const width of [220,300,380]){f.host.style.width=width+'px';await tick();const bounds=row().getBoundingClientRect();layout.push({width,overflow:row().scrollWidth>row().clientWidth,height:bounds.height,icons:[...row().querySelectorAll('.requirement-count,.scope-badge:not(.waiting)')].map(el=>{const numeral=el.querySelector('b')||el,icon=el.getBoundingClientRect(),digit=numeral.getBoundingClientRect();return {inside:digit.left>=icon.left&&digit.right<=icon.right&&digit.top>=icon.top&&digit.bottom<=icon.bottom,stationary:getComputedStyle(numeral).animationName==='none'}})});}
    f.host.style.width='300px';
    const many=Array.from({length:24},(_,i)=>({...f.sessions[i<12?0:1],id:'many-'+i}));window.updateCounts({sessions:many,status:{},unread:Object.fromEntries(many.slice(12).map(s=>[s.id,'main']))});await tick();const twoDigits=values();
    const twoDigitInside=[...row().querySelectorAll('.requirement-count')].every(el=>{const icon=el.getBoundingClientRect(),digit=el.querySelector('b').getBoundingClientRect();return digit.left>=icon.left&&digit.right<=icon.right});
    window.updateCounts({unread:Object.fromEntries(many.map(s=>[s.id,'side']))});await tick();const multiProgress=progressBadge();
    const plus=row().querySelector('.scope-quick-create');
    const defaultPlus=getComputedStyle(plus).opacity;
    plus.click();await tick();
    const afterPlus=row().getBoundingClientRect();
    window.updateCounts({sessions:f.sessions,unread:{run:'side',done:'main'}});await tick();
    return {initial,initialSizes,progress,withProgress,runningAnimation,lightProgress,clearedProgress,multiProgress,afterRead,afterViewed,afterUnread,duplicateUnread,ended,deferred,archived,blocked,resumed,layout,twoDigits,twoDigitInside,defaultPlus,stablePlus:afterPlus.height===height,opened:f.opened,created:f.created};
  })()`
})

const oneEach = [{ kind: 'running', count: '1', label: '1 个任务运行中' }, { kind: 'acceptance', count: '1', label: '1 个任务待验收' }]
assert.deepEqual(result.initial, oneEach, 'running and normally answered tasks coexist across execution spaces')
assert.deepEqual(result.afterRead, oneEach, 'opening the requirement does not accept its result')
assert.deepEqual(result.initialSizes, [{ kind: 'running', width: 22 }, { kind: 'acceptance', width: 18 }], 'only the orange icon becomes smaller')
assert.equal(result.progress.color, 'rgb(63, 185, 80)', 'unread progress is green instead of execution blue')
assert.equal(result.progress.height, 16, 'unread uses the confirmed compact height')
assert.equal(result.progress.width, 16, 'a single digit fits the compact badge')
assert.equal(result.progress.radius, '4px', 'unread uses the confirmed rounded corners')
assert.equal(result.progress.graphic, false, 'the oversized diamond outline is removed')
assert.equal(result.progress.text, '1')
assert.equal(result.progress.label, '1 项任务有新进展')
assert.equal(result.progress.title, result.progress.label)
assert.ok(result.progress.inside && result.progress.stationary, 'the digit fits and remains upright without animation')
assert.deepEqual(result.withProgress, oneEach, 'unread progress coexists with execution and result reminders')
assert.equal(result.runningAnimation, 'requirement-count-spin', 'execution retains its existing animation')
assert.equal(result.lightProgress.color, 'rgb(42, 110, 63)', 'green follows the light theme palette')
assert.ok(result.lightProgress.inside && result.lightProgress.stationary)
assert.equal(result.clearedProgress, true, 'clearing unread progress removes the badge')
assert.equal(result.multiProgress.text, '24')
assert.ok(result.multiProgress.width > result.progress.width && result.multiProgress.inside, 'multiple digits widen the badge and remain inside')
assert.deepEqual(result.afterViewed, [oneEach[0]], 'viewing the task result clears only its orange reminder')
assert.deepEqual(result.afterUnread, oneEach)
assert.equal(result.duplicateUnread, false, 'the same answered task does not also add an unread badge')
assert.deepEqual(result.ended, [{ kind: 'acceptance', count: '2', label: '2 个任务待验收' }])
assert.deepEqual(result.deferred, [], 'user deferral removes result reminders')
assert.deepEqual(result.archived, [], 'archived tasks do not contribute')
assert.deepEqual(result.blocked, { icons: [{ kind: 'acceptance', count: '1', label: '1 个任务待验收' }], waiting: '1', graphic: false, color: 'rgb(210, 153, 34)' }, 'approval retains its original orange reminder without claiming execution or acceptance')
assert.deepEqual(result.resumed, oneEach, 'new execution restores the running counter')
for (const item of result.layout) {
  assert.equal(item.overflow, false, 'counts fit sidebar width ' + item.width)
  assert.equal(item.height, 36, 'sidebar row height remains unchanged')
  assert.ok(item.icons.every((icon: any) => icon.inside && icon.stationary))
}
assert.deepEqual(result.twoDigits.map((item: any) => item.count), ['12', '12'])
assert.equal(result.twoDigitInside, true)
assert.equal(result.defaultPlus, '0')
assert.equal(result.stablePlus, true)
assert.deepEqual(result.opened, [{ kind: 'requirement', id: 'r' }])
assert.deepEqual(result.created, [{ projectId: 'owner', requirementId: 'r' }])
console.log('PASS requirement count UI: compact green progress, themes, multiple digits, reminder clearing, execution/user decision transitions, approval, ownership and sidebar layout')
