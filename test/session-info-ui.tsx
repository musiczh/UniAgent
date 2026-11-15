import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'session-info-ui', {
  setup: `
    import { SessionHeader } from './src/renderer/App';
    import { MemberSession } from './src/renderer/components/TeamWorkspace';
    import { sessionInfoSnapshot } from './src/shared/sessionInfo';
    const requests=[],reveals=[],copies=[],errors=[];
    let copyFails=false,revealFails=false;
    const noop=()=>{};
    window.addEventListener('error',event=>errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{
      if(copyFails)throw new Error('clipboard unavailable');copies.push(value);
    }}});
    const a={id:'a',title:'原生会话信息入口',nativeSessionId:'native-a',status:'idle',createdAt:1,
      taskMetadata:{title:'任务信息标题',description:'保留任务描述，\\n第二段完整显示。'},config:{agentId:'codex',workdir:'/workspace/a',permissionMode:'ask'}};
    const b={...a,id:'b',title:'另一个会话',taskMetadata:undefined,nativeSessionId:'native-b',config:{...a.config,agentId:'grok',workdir:'/workspace/b'}};
    const agent=id=>({id,name:id,adapter:id,models:[],capabilities:{permissionModes:[],sessionFork:false}});
    const agents=[agent('codex'),agent('grok')];
    window.uniagent=new Proxy({
      getSessionInfo:id=>new Promise((resolve,reject)=>requests.push({id,resolve,reject})),
      revealSessionInfoFile:async(id,fieldId)=>{if(revealFails)throw new Error('missing');reveals.push([id,fieldId])}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>noop:async()=>null});
    const host=document.body.appendChild(document.createElement('div'));host.id='session-info-fixture';
    host.style.cssText='position:absolute;top:0;left:0;width:700px;height:500px';
    const root=createRoot(host);
    const mount=(session=a,team=false)=>root.render(team
      ?React.createElement(MemberSession,{sessionId:session.id,sessions:[session],agents,events:[],loading:false,onBack:noop,onForkLatest:noop,
        p:{name:'团队项目',team:{leaderMemberId:'leader',members:[{id:'leader',role:{name:'成员角色'}}]},memberSessions:{leader:session.id},assignments:[],messages:[],interactions:[],inbox:[]}})
      :React.createElement('div',{className:'session-view'},React.createElement(SessionHeader,{session,agents})));
    const fullInfo=session=>{
      const info=sessionInfoSnapshot(session);
      info.native.find(field=>field.id==='workdir').path=session.config.workdir;
      const file='/native/'+session.nativeSessionId+'/'+'long-directory/'.repeat(18)+'history.jsonl';
      info.native.push({id:'sessionFile',label:'会话文件',value:file,path:file});
      info.local.push({id:'diagnosticLog',label:'诊断日志',value:'/logs/'+session.id+'.jsonl',path:'/logs/'+session.id+'.jsonl'});
      return info;
    };
    window.infoFixture={a,b,requests,reveals,copies,errors,host,mount,fullInfo,
      failCopy:value=>copyFails=value,failReveal:value=>revealFails=value};
    mount();
  `,
  inspect: `(async()=>{
    const f=window.infoFixture;
    const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
    const wait=async(probe,label)=>{for(let i=0;i<100;i++){if(probe())return;await tick()}throw Error(label+': '+JSON.stringify(f.errors))};
    const trigger=()=>f.host.querySelector('.session-info-trigger');
    const pop=()=>document.querySelector('.session-info-popover');
    const field=id=>pop()?.querySelector('[data-field="'+id+'"] dd')?.textContent;
    const fields=()=>Array.from(pop().querySelectorAll('[data-field]')).map(row=>row.dataset.field);
    const click=label=>{const button=pop().querySelector('button[aria-label="'+label+'"]');if(!button)throw Error('missing '+label);button.click()};
    const open=async()=>{const n=f.requests.length;trigger().click();await wait(()=>f.requests.length===n+1,'lazy request');return f.requests.at(-1)};
    await wait(()=>trigger(),'header mount');
    const idleCalls=f.requests.length;
    let request=await open();
    const initial={fields:fields(),busy:pop().querySelector('.session-info-content').getAttribute('aria-busy')};
    request.resolve(f.fullInfo(f.a));await wait(()=>field('sessionFile'),'native file lookup');
    const resolved={taskTitle:field('taskTitle'),description:field('taskDescription'),fields:fields(),native:field('nativeSessionId'),local:field('sessionId')};
    click('复制Session ID');await wait(()=>f.copies.length===1,'copy id');
    pop().querySelector('.session-info-copy-all').click();await wait(()=>f.copies.length===2,'copy all');
    const beforeUpdate=f.requests.length;f.mount({...f.a,taskMetadata:{...f.a.taskMetadata,description:'更新后的任务描述。'.repeat(100)}});await wait(()=>field('taskDescription')?.startsWith('更新后'),'live task description');const live={description:field('taskDescription'),requests:f.requests.length-beforeUpdate};f.mount(f.a);await wait(()=>field('taskDescription')===f.a.taskMetadata.description,'restore description');
    click('定位会话文件');await wait(()=>f.reveals.length===1,'reveal file');
    f.failCopy(true);click('复制Session ID');await wait(()=>pop().textContent.includes('复制失败'),'copy failure');
    f.failCopy(false);f.failReveal(true);click('定位会话文件');await wait(()=>pop().textContent.includes('无法定位'),'reveal failure');f.failReveal(false);
    f.host.style.left=(window.innerWidth-100)+'px';window.dispatchEvent(new Event('resize'));await tick();
    const rect=pop().getBoundingClientRect(),content=pop().querySelector('.session-info-content');
    const layout={left:rect.left,right:rect.right,bottom:rect.bottom,width:window.innerWidth,height:window.innerHeight,scrollable:content.scrollHeight>content.clientHeight};
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!pop(),'Escape close');
    const escapeFocus=document.activeElement===trigger();f.host.style.left='0';
    request=await open();request.reject(new Error('read failed'));await wait(()=>pop().querySelector('[role="alert"]'),'read failure');
    const failed={description:field('taskDescription'),fields:fields(),native:field('nativeSessionId')};
    pop().querySelector('.session-info-errors button').click();await wait(()=>f.requests.at(-1)!==request,'retry');
    request=f.requests.at(-1);const partial=f.fullInfo(f.a);partial.native=partial.native.filter(field=>field.id!=='sessionFile');partial.errors=[{label:'会话文件',message:'读取失败'}];
    request.resolve(partial);await wait(()=>pop().querySelector('[role="alert"]')?.textContent.includes('会话文件'),'partial failure');
    const partialState={native:field('nativeSessionId'),log:field('diagnosticLog'),missingFile:!field('sessionFile')};
    pop().querySelector('.session-info-errors button').click();await wait(()=>f.requests.at(-1)!==request,'partial retry');
    f.requests.at(-1).resolve(f.fullInfo(f.a));await wait(()=>field('sessionFile')&&!pop().querySelector('[role="alert"]'),'retry recovered');
    click('关闭会话信息');await wait(()=>!pop(),'close button');const closeFocus=document.activeElement===trigger();
    const oldRequest=await open();
    const next={...f.a,nativeSessionId:'native-a-new'};f.mount(next);
    await wait(()=>f.requests.at(-1)!==oldRequest,'native id change refetch');
    const newRequest=f.requests.at(-1);newRequest.resolve(f.fullInfo(next));await wait(()=>field('nativeSessionId')==='native-a-new'&&field('sessionFile')?.includes('native-a-new'),'new id applied');
    oldRequest.resolve(f.fullInfo(f.a));await tick();
    const stableAfterOld={native:field('nativeSessionId'),file:field('sessionFile')};
    f.mount(f.b);await wait(()=>trigger()?.textContent.includes(f.b.title)&&!pop(),'switch resets popover');
    const bRequest=await open();bRequest.resolve({native:[{id:'nativeSessionId',label:'Session ID',value:'native-b'},{id:'workdir',label:'工作目录',value:'/workspace/b'}],local:[{id:'sessionId',label:'会话 ID',value:'b'}],errors:[]});
    await wait(()=>field('nativeSessionId')==='native-b'&&pop().querySelector('.session-info-content').getAttribute('aria-busy')==='false','other provider');
    const otherProvider={fields:fields(),native:field('nativeSessionId'),text:pop().textContent};
    const outside=document.body.appendChild(document.createElement('input'));outside.focus();outside.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await wait(()=>!pop(),'outside close');
    const outsideFocus=document.activeElement===outside;
    const draft={...f.b,id:'draft',title:'尚未创建原生会话',nativeSessionId:undefined};f.mount(draft);await wait(()=>trigger()?.textContent.includes(draft.title),'draft mount');
    request=await open();request.resolve({native:[{id:'workdir',label:'工作目录',value:'/workspace/b'}],local:[{id:'sessionId',label:'会话 ID',value:'draft'}],errors:[]});
    await wait(()=>field('sessionId')==='draft','draft data');const draftFields=fields(),emptyDescription=field('taskDescription'),emptyCopyDisabled=pop().querySelector('[data-field=taskDescription] button').disabled;
    f.mount(f.a,true);await wait(()=>f.host.querySelector('.team-session-title')&&!pop(),'team mount');
    request=await open();request.resolve(f.fullInfo(f.a));await wait(()=>field('nativeSessionId')==='native-a','team info');
    const team={native:field('nativeSessionId'),title:trigger().textContent,taskAbsent:!field('taskTitle')};
    return {idleCalls,initial,resolved,live,copies:f.copies,reveals:f.reveals,layout,escapeFocus,closeFocus,outsideFocus,failed,partialState,stableAfterOld,otherProvider,draftFields,emptyDescription,emptyCopyDisabled,team,errors:f.errors};
  })()`
})

assert.deepEqual(result.errors, [], 'real React components must render without runtime errors')
assert.equal(result.idleCalls, 0, 'mounting a conversation must not fetch metadata or delay startup')
assert.deepEqual(result.initial.fields, ['taskTitle', 'taskDescription', 'nativeSessionId', 'workdir', 'sessionId'])
assert.equal(result.initial.busy, 'true')
assert.deepEqual(result.resolved.fields, ['taskTitle', 'taskDescription', 'nativeSessionId', 'workdir', 'sessionFile', 'sessionId', 'diagnosticLog'])
assert.equal(result.resolved.native, 'native-a')
assert.equal(result.resolved.local, 'a')
assert.equal(result.resolved.taskTitle, '任务信息标题')
assert.equal(result.live.description, '更新后的任务描述。'.repeat(100))
assert.equal(result.live.requests, 0, 'task updates reuse native metadata without another request')
assert.equal(result.resolved.description, '保留任务描述，\n第二段完整显示。')
assert.equal(result.failed.description, result.resolved.description)
assert.ok(result.copies[1].includes(result.resolved.description) && result.copies[1].includes(result.resolved.taskTitle))
assert.equal(result.emptyDescription, '当前记录中暂无任务描述。')
assert.equal(result.emptyCopyDisabled, true)
assert.equal(result.team.taskAbsent, true)
assert.equal(result.copies[0], 'native-a')
assert.ok(result.copies[1].includes('long-directory/'.repeat(18) + 'history.jsonl'), 'copy all preserves the complete untruncated path')
assert.ok(result.copies[1].includes('会话 ID: a') && result.copies[1].includes('诊断日志: /logs/a.jsonl'))
assert.deepEqual(result.reveals, [['a', 'sessionFile']], 'reveal uses the owning session and a field id')
assert.ok(result.layout.left >= 12 && result.layout.right <= result.layout.width - 12 && result.layout.bottom <= result.layout.height - 12, 'popover stays within the viewport after the anchor moves')
assert.equal(result.layout.scrollable, true, 'long metadata remains scrollable in a small window')
assert.ok(result.escapeFocus && result.closeFocus && result.outsideFocus, 'dismissal respects keyboard and pointer focus')
assert.equal(result.failed.native, 'native-a', 'query failure preserves known metadata')
assert.deepEqual(result.partialState, { native: 'native-a', log: '/logs/a.jsonl', missingFile: true })
assert.equal(result.stableAfterOld.native, 'native-a-new')
assert.ok(result.stableAfterOld.file.includes('native-a-new') && !result.stableAfterOld.file.includes('/native-a/'), 'late responses cannot restore an old native identity')
assert.deepEqual(result.otherProvider.fields, ['taskTitle', 'taskDescription', 'nativeSessionId', 'workdir', 'sessionId'])
assert.equal(result.otherProvider.native, 'native-b')
assert.ok(!result.otherProvider.text.includes('Log ID') && !result.otherProvider.text.includes('未提供') && !result.otherProvider.text.includes('native-a'), 'unsupported fields and other sessions are never displayed')
assert.deepEqual(result.draftFields, ['taskTitle', 'taskDescription', 'workdir', 'sessionId'])
assert.equal(result.team.native, 'native-a')
assert.ok(result.team.title.includes('成员角色'))
console.log('session-info-ui: lazy title entry, dynamic fields, copy/reveal failures, retry, identity changes, focus, layout and team sessions passed')
