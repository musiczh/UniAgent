import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

for (const requirementId of ['r', undefined]) {
const result = await renderEventStream([], 'idle', 'task-focus-queue', {
  setup: `
    import {TaskBoard,TaskBoardWorkspace} from './src/renderer/components/TaskBoard';
    import {projectTaskBoard} from './src/shared/taskBoard';import {projectTaskDecisions} from './src/shared/taskDecisions';
    const sessions=${JSON.stringify(requirementId ? ['a','b','other'] : ['a','b'])}.map((id,i)=>({id,title:'任务 '+id,status:'awaiting-approval',createdAt:i+1,nativeSessionId:'native-'+id,config:{agentId:'codex',projectId:'p',requirementId:id==='other'?'another':'r'}}));
    const logs=Object.fromEntries(sessions.map(s=>[s.id,[{sessionId:s.id,seq:1,ts:1,type:'user_message',state:'success',payload:{text:'描述与最近输入 '+s.id}},{sessionId:s.id,seq:2,ts:2,type:'approval_request',state:'pending',payload:{requestId:'q-'+s.id,kind:'question',params:{questions:[{id:'scope',question:'选择范围 '+s.id+'：[候选设计图](docs/design.html) · [技术方案](/reviews/'+s.id+'/technical.md:2) · [官网](https://example.com/design) · [不存在](docs/missing.html) · [危险链接](javascript:alert(1))',options:[{label:'当前范围'},{label:'扩大范围'}]}]}}}]]));
    let fail=true;const loaded=[],calls=[],events=[],boards=[];
    const changed=()=>{boards.forEach(cb=>cb());events.forEach(cb=>cb({sessionId:'a',type:'approval_request',payload:{}}));events.forEach(cb=>cb({sessionId:'b',type:'approval_request',payload:{}}))};
    window.uniagent=new Proxy({getTaskBoard:async query=>projectTaskBoard(sessions,id=>projectTaskDecisions(sessions.find(s=>s.id===id),logs[id]),query),getEvents:async id=>{loaded.push(id);return logs[id]},getTaskDecisions:async id=>projectTaskDecisions(sessions.find(s=>s.id===id),logs[id]),resolveTaskDecision:async(id,input)=>{calls.push({id,input});if(fail)throw Error('发送失败，草稿保留');logs[id][1].state='success';sessions.find(s=>s.id===id).status='idle';changed()},onEvent:cb=>{events.push(cb);return()=>{}},onTaskBoardChanged:cb=>{boards.push(cb);return()=>{}}},{get:(t,k)=>k in t?t[k]:()=>()=>{}});
    const reads=[],external=[];
    Object.assign(window.uniagent,{homeDir:'/Users/fixture',fsListDir:async(id,path,root)=>{
      const file=(name,path)=>({name,path,kind:'file',size:32,ext:name.split('.').at(-1),isSymlink:false});
      return {ok:true,root:root||'/workspace/'+id,dirPath:path,entries:root==='/reviews/'+id?[file('technical.md','technical.md')]:path==='docs'?[file('design.html','docs/design.html')]:path===''?[{name:'docs',path:'docs',kind:'dir',isSymlink:false}]:[]};
    },fsReadFile:async(id,path,options,root)=>{reads.push({id,path,root:root||null});return {ok:true,path,kind:'text',size:32,ext:path.split('.').at(-1),text:'第一行\\n第二行\\n第三行'}},openExternal:async url=>external.push(url)});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;width:1024px;height:640px;display:flex;background:var(--bg);padding:20px;box-sizing:border-box';
    createRoot(host).render(React.createElement(${requirementId ? 'TaskBoardWorkspace' : 'TaskBoard'},{projects:[{id:'p',name:'空间'}],requirements:[{id:'r',name:'需求'}],requirementId:${JSON.stringify(requirementId)},onOpenTask:()=>{},onCreate:()=>{}}));window.focusFixture={host,loaded,calls,reads,external,allow:()=>fail=false};
  `,
  inspect: `(async()=>{
    const f=window.focusFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,20)),wait=async(p,label)=>{for(let i=0;i<150;i++){if(p())return;await tick()}throw Error(label+': '+f.host.textContent)};
    const visible=()=>[...f.host.querySelectorAll('.task-focus-panel')].find(e=>!e.hidden),radio=()=>visible().querySelector('input[type=radio]'),submit=()=>visible().querySelector('.approval-actions .btn-send');
    await wait(()=>radio()&&!radio().disabled,'first question loaded');const initial={loaded:[...f.loaded],description:visible().querySelector('.task-focus-context').textContent,columns:f.host.querySelectorAll('.task-board-column').length};
    const link=label=>[...visible().querySelectorAll('.question-prompt a')].find(a=>a.textContent===label);
    const checkLinks=async id=>{
      await wait(()=>link('候选设计图')?.classList.contains('md-path')&&link('技术方案')?.classList.contains('md-path'),'local links verified');
      const before=f.reads.length;link('候选设计图').click();await wait(()=>f.reads.length>before&&q('.filebrowser-overlay'),'relative preview opens');
      const relative=f.reads.at(-1),relativeRoot=q('.filebrowser-overlay .titles p').textContent;
      q('[aria-label=关闭文件浏览器]').click();await wait(()=>!q('.filebrowser-overlay'),'close relative preview');
      link('技术方案').click();await wait(()=>q('.fb-code-line[data-line="2"]'),'absolute preview focuses line');const absolute=f.reads.at(-1);
      q('[aria-label=关闭文件浏览器]').click();await wait(()=>!q('.filebrowser-overlay'),'close absolute preview');
      link('官网').click();link('不存在').click();link('危险链接').click();await tick();
      return {id,relative,relativeRoot,absolute,missing:link('不存在').getAttribute('href'),dangerous:link('危险链接').getAttribute('href'),selected:radio().checked,submitted:f.calls.length,overlay:!!q('.filebrowser-overlay')};
    };
    const linksA=await checkLinks('a');
    radio().click();const choice=radio();q('.task-focus-more').open=true;q('.task-focus-more button').click();await wait(()=>visible().textContent.includes('任务 b')&&radio()&&!radio().disabled,'switch second');
    const linksB=await checkLinks('b');
    q('.task-focus-more').open=true;q('.task-focus-more button').click();await wait(()=>visible().textContent.includes('任务 a'),'return first');const preserved=choice.checked&&radio().checked&&radio()===choice;
    q('[aria-label=收起提问卡片]').click();await tick();const folded=q('.task-focus-folded')?.textContent;q('[aria-label=展开提问卡片]').click();await tick();const unfolded=radio().checked;
    submit().click();await wait(()=>visible().textContent.includes('发送失败'),'submission failure');const retained=radio().checked&&visible().textContent.includes('任务 a');
    f.allow();submit().click();await wait(()=>q('.task-focus-queue.leaving'),'dismissal transition');await wait(()=>visible().textContent.includes('任务 b'),'next task enters');const next={single:[...f.host.querySelectorAll('.task-focus-panel')].filter(e=>!e.hidden).length,title:visible().querySelector('.task-focus-context').textContent};
    radio().click();submit().click();await wait(()=>q('.task-focus-queue.leaving'),'last request exits');const lastCollapses=q('.task-focus-queue').getAnimations().some(animation=>animation.effect.getKeyframes().some(frame=>frame.height==='0px'));await wait(()=>!q('.task-focus-queue'),'no placeholder after last request');
    return {links:[linksA,linksB],external:f.external,initial,preserved,folded,unfolded,retained,next,lastCollapses,ids:f.calls.map(c=>c.id),sameRetry:f.calls[0].input.actionId===f.calls[1].input.actionId,otherLoaded:f.loaded.includes('other'),cardActions:f.host.querySelectorAll('.task-board-card .question-form,.task-board-card .appr-accept').length,overflow:f.host.scrollWidth>f.host.clientWidth};
  })()`
})
assert.deepEqual(result.initial.loaded, ['a']); assert.match(result.initial.description, /描述与最近输入 a/); assert.equal(result.initial.columns, 4)
assert.equal(result.preserved, true); assert.match(result.folded, /任务 a/); assert.equal(result.unfolded, true); assert.equal(result.retained, true)
assert.equal(result.next.single, 1); assert.match(result.next.title, /任务 b/); assert.deepEqual(result.ids, ['a', 'a', 'b']); assert.equal(result.sameRetry, true)
assert.equal(result.otherLoaded, false); assert.equal(result.cardActions, 0); assert.equal(result.overflow, false)
assert.equal(result.lastCollapses, true, 'the last question closes its layout space continuously')
for (const link of result.links) assert.deepEqual(link, {id:link.id,relative:{id:link.id,path:'docs/design.html',root:null},relativeRoot:'/workspace/'+link.id,absolute:{id:link.id,path:'technical.md',root:'/reviews/'+link.id},missing:null,dangerous:null,selected:false,submitted:0,overlay:false}, '链接使用各自任务的文件上下文，点击不选中答案或提交审批')
assert.deepEqual(result.external, ['https://example.com/design','https://example.com/design'])
}
console.log('PASS global/scoped request links, per-task relative/absolute previews and line focus, external URLs, missing/unsafe links, preserved drafts and response retry identity')
