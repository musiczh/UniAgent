import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderEventStream } from './regression/render-event-stream.mjs'

// The unified task mounts the original conversation, including image-only input and tool history.
const result = await renderEventStream([], 'idle', 'task-history-ui', {
  setup: `
    import {SessionTaskContent} from './src/renderer/components/TaskDetail';
    const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6f7sAAAAASUVORK5CYII=';
    const errors=[],reads=[],fileReads=[];
    window.addEventListener('error',e=>errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({
      fsReadAttachmentImage:async(sessionId,path)=>{
        reads.push({sessionId,path});
        if(path.endsWith('missing.png'))return null;
        if(path.endsWith('unreadable.png'))throw Error('unreadable image');
        return png;
      },
      fsReadFile:async(sessionId,path,_depth,root)=>{
        fileReads.push({sessionId,path,root});
        return sessionId==='s'?{ok:true,kind:'image',dataUrl:png}:{ok:false,error:'missing session'};
      }
    },{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
    const session={id:'s',title:'实现创作者操作记录',status:'completed',readOnly:true,createdAt:1,config:{agentId:'codex',workdir:'/fixture'}};
    const row=(seq,date,type,payload)=>({sessionId:'s',seq,ts:Date.parse(date+'+08:00'),type,state:'success',payload});
    const attachments=[{kind:'image',name:'first.png',path:'/fixture/first.png'},{kind:'file',name:'notes.txt',path:'/fixture/notes.txt'},
      {kind:'image',name:'second.png',path:'/fixture/second.png'},{kind:'image',name:'missing.png',path:'/fixture/missing.png'},
      {kind:'image',name:'unreadable.png',path:'/fixture/unreadable.png'}];
    const events=[
      row(300,'2026-11-04T22:55:08','user_message',{text:'看下评论'}),
      row(301,'2026-11-04T22:56:00','reasoning',{text:'正在核对原文'}),
      row(302,'2026-11-04T22:59:30','agent_message',{text:'看到了两条评论。'}),
      row(400,'2026-11-05T11:14:56','user_message',{text:'',attachments}),
      row(401,'2026-11-05T11:15:00','agent_message',{text:'查看过程图。\\n\\n![过程图](/fixture/progress.png)'}),
      row(402,'2026-11-05T11:18:43','agent_message',{text:'已按标注做了修改前后的对比预览。\\n\\n![预览](/fixture/preview.png)'}),
      row(500,'2026-11-05T11:20:45','user_message',{text:'同意，继续'}),
      row(501,'2026-11-05T11:20:47','command_exec',{command:'验证渲染',output:'通过'}),
      row(502,'2026-11-05T11:20:50','agent_message',{text:'我会按已确认的预览修改。'})
    ];
    const host=document.body.appendChild(document.createElement('div'));
    host.style.cssText='position:absolute;inset:0;display:flex;background:var(--bg);width:1024px;height:640px';
    const root=createRoot(host);
    const render=rows=>root.render(React.createElement(SessionTaskContent,{session,events:rows}));
    render(events);
    const earlier=Array.from({length:21},(_,i)=>[
      row(10+i*3,'2026-11-03T10:'+String(i).padStart(2,'0')+':00','user_message',{text:'早期输入'+(i+1)}),
      row(11+i*3,'2026-11-03T10:'+String(i).padStart(2,'0')+':30','agent_message',{text:'早期回答'+(i+1)})
    ]).flat();
    window.historyFixture={host,errors,reads,fileReads,renderLong:()=>render([...earlier,...events]),
      renderFollowup:answered=>render([...earlier,...events,
        row(600,'2026-11-05T11:21:00','user_message',{text:'继续检查时间线'}),
        ...(answered?[row(601,'2026-11-05T11:21:30','agent_message',{text:'最新检查结果'})]:[])])};
  `,
  inspect: `(async()=>{
    const f=window.historyFixture,tick=()=>new Promise(r=>setTimeout(r,25));
    const wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label)};
    await wait(()=>f.host.querySelectorAll('.user-msg').length===3,'three inputs');
    await wait(()=>f.host.querySelectorAll('.bubble-image-button img').length===2,'attachment images');
    const inputs=()=>[...f.host.querySelectorAll('.user-msg')];
    const order=inputs().map(el=>el.dataset.sourceSeq);
    const input=inputs()[1],thumbs=[...input.querySelectorAll('button.bubble-image-button')];
    const loaded=thumbs.map(button=>({label:button.getAttribute('aria-label'),loaded:button.querySelector('img').complete&&button.querySelector('img').naturalWidth>0,width:button.getBoundingClientRect().width,height:Math.round(button.getBoundingClientRect().height)}));
    const fallback=[...input.querySelectorAll('.bubble-attach')].map(el=>el.textContent.trim());
    thumbs[1].click();await wait(()=>document.querySelector('[role=dialog]'),'open preview');
    const dialog=document.querySelector('[role=dialog]'),initial=dialog.querySelector('img').alt,count=dialog.querySelector('.image-lightbox-count').textContent;
    dialog.querySelector('[aria-label=上一张图片]').click();await tick();const previous=dialog.querySelector('img').alt;
    dialog.querySelector('[aria-label=放大图片]').click();await tick();const zoom=dialog.querySelector('.image-lightbox-scale').textContent;
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await tick();
    const lightbox={initial,count,previous,zoom,closed:!document.querySelector('[role=dialog]')};
    for(const selector of ['.processed-fold.closed > .processed-head','.steps-fold-row[aria-expanded=false]','.process-step-meta[aria-expanded=false]','.process-call-group .chain-head','.chain.closed > .chain-head']){f.host.querySelectorAll(selector).forEach(button=>button.click());await tick();await tick()}
    await wait(()=>f.host.querySelectorAll('.agent-md img').length>=2&&[...f.host.querySelectorAll('.agent-md img')].every(img=>img.naturalWidth),'Markdown images');
    const images=[...f.host.querySelectorAll('.agent-md img')].map(img=>img.src),expanded=f.host.textContent;
    f.renderLong();await wait(()=>inputs().length===24,'full history');
    const full={count:inputs().length,first:inputs()[0].textContent,last:inputs().at(-1).textContent,noLegacy:!f.host.querySelector('.task-load-more,.task-timeline,[role=tablist]')};
    f.renderFollowup(false);await wait(()=>inputs().length===25,'new input');const newestInput=inputs().at(-1).textContent;
    f.renderFollowup(true);await wait(()=>f.host.textContent.includes('最新检查结果'),'new reply');
    return{order,loaded,fallback,lightbox,images,expanded,full,newestInput,reads:f.reads,fileReads:f.fileReads,errors:f.errors};
  })()`
})

test('unified task history uses original conversation order and keeps the entire transcript', () => {
  assert.deepEqual(result.order, ['300','400','500'])
  assert.deepEqual(result.errors, [])
  assert.equal(result.full.count, 24)
  assert.match(result.full.first, /早期输入1/)
  assert.match(result.full.last, /同意，继续/)
  assert.equal(result.full.noLegacy, true)
  assert.match(result.newestInput, /继续检查时间线/)
  for (const text of ['正在核对原文','看到了两条评论','查看过程图','我会按已确认的预览修改']) assert.ok(result.expanded.includes(text), text)
})

test('image-only task inputs retain thumbnails, attachment fallbacks and the original lightbox', () => {
  assert.deepEqual(result.loaded, [{label:'预览 first.png',loaded:true,width:48,height:48},{label:'预览 second.png',loaded:true,width:48,height:48}])
  assert.deepEqual(result.fallback, ['📎 notes.txt','🖼 missing.png','🖼 unreadable.png'])
  assert.deepEqual(result.lightbox,{initial:'second.png',count:'2 / 4',previous:'first.png',zoom:'125%',closed:true})
  assert.ok(result.reads.length>=4&&result.reads.every((read:{sessionId:string})=>read.sessionId==='s'))
  assert.ok(result.images.every((src:string)=>src.startsWith('data:image/png;base64,')))
  assert.ok(result.fileReads.length>=2&&result.fileReads.every((read:{sessionId:string})=>read.sessionId==='s'))
})

const communication = await renderEventStream([], 'idle', 'task-history-communication', {
  setup: `
    import {SessionTaskContent} from './src/renderer/components/TaskDetail';
    const opened=[],external=[],errors=[];
    window.addEventListener('error',e=>errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({
      homeDir:'/fixture',
      fsReadAttachmentImage:async()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6f7sAAAAASUVORK5CYII=',
      fsListDir:async(id,path)=>({ok:id==='s'&&path==='docs',entries:[{name:'review.html',kind:'file',size:1}]}),
      openExternal:async url=>external.push(url),
    },{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
    const session={id:'s',title:'时间线沟通',status:'running',readOnly:true,createdAt:1,config:{agentId:'codex',workdir:'/fixture'}};
    const row=(seq,type,payload,state='success')=>({sessionId:'s',seq,ts:seq*1000,type,state,payload});
    const markdown='已核对。\\n\\n- 空间可折叠\\n- 保留任务提醒\\n\\n1. 第一项\\n2. 第二项\\n\\n[打开交互 HTML](docs/review.html) · [官网](https://example.com/) · [缺失](docs/missing.html) · [危险](javascript:alert(1))';
    const question=row(14,'approval_request',{requestId:'q',kind:'question',method:'item/tool/requestUserInput',
      params:{questions:[{id:'scope',question:'分组方式？见 [交互稿](docs/review.html)',options:[{label:'单层分组'}]}]},
      submittedAnswer:{answers:{scope:{answers:['单层分组']}}}});
    const secret=row(15,'approval_request',{requestId:'secret',kind:'elicitation',
      params:{requestedSchema:{type:'object',properties:{password:{type:'string',format:'password',title:'访问密码'}},required:['password']}},
      submittedAnswer:{action:'accept',content:{password:'fixture-secret-must-stay-hidden'}}});
    const events=[row(10,'user_message',{text:'请检查分组'}),row(11,'reasoning',{text:'正在检查'}),
      row(12,'agent_message',{text:markdown}),
      row(13,'user_message',{text:'补充：只有一级分组',appendedToTurn:true,
        attachments:[{kind:'image',name:'steer.png',path:'/fixture/steer.png'}]}),
      {...question,state:'pending',payload:{...question.payload,submittedAnswer:undefined}},question,secret,
      row(16,'approval_request',{requestId:'pending',kind:'question',params:{questions:[{id:'pending',question:'尚未回答的提问'}]}},'pending'),
      row(17,'approval_request',{requestId:'cancelled',kind:'question',params:{questions:[{id:'cancelled',question:'已取消的提问'}]},submittedAnswer:{action:'cancel'}},'cancelled'),
      row(18,'agent_message',{id:'async',delivery:'async',questions:[{id:'async',question:'还需检查什么？'}],submittedAnswer:{answers:{async:{answers:['间距']}}}}),
      row(19,'user_message',{text:'回答 Agent 提问：还需检查什么？回答：间距',asyncQuestion:true,appendedToTurn:true}),
      row(20,'user_message',{text:'内部 MCP 通知',source:'mcp',appendedToTurn:true}),
      row(21,'command_exec',{command:'检查样式',output:'通过'})];
    const host=document.body.appendChild(document.createElement('div'));
    host.style.cssText='position:fixed;inset:0;display:flex;background:var(--bg)';
    const root=createRoot(host);
    const render=rows=>root.render(React.createElement(SessionTaskContent,{session,events:rows,onOpenFile:(path,line)=>opened.push([path,line])}));
    render(events);
    const settled=row(22,'agent_message',{text:markdown});
    window.communicationFixture={host,opened,external,errors,settledTime:new Date(settled.ts).toLocaleString(),
      settle:()=>{session.status='completed';render([...events,settled])}};
  `,
  inspect: `(async()=>{
    const f=window.communicationFixture,tick=()=>new Promise(r=>setTimeout(r,25));
    const wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label)};
    await wait(()=>f.host.querySelector('.event-stream'),'conversation');
    const expand=async()=>{for(let i=0;i<2;i++){for(const selector of ['.processed-fold.closed > .processed-head','.steps-fold-row[aria-expanded=false]','.process-step-meta[aria-expanded=false]','.chain.closed > .chain-head','details:not([open])>summary','.interaction-link[aria-expanded=false]']){f.host.querySelectorAll(selector).forEach(button=>button.click());await tick();await tick()}}};
    await expand();await wait(()=>f.host.querySelector('.bubble-image-button img')?.naturalWidth,'steering image');
    const running=f.host.textContent;
    f.settle();await wait(()=>f.host.querySelectorAll('.agent-md').length>=2,'settled reply');await expand();
    await wait(()=>[...f.host.querySelectorAll('.agent-md a')].some(el=>el.textContent==='打开交互 HTML'&&el.classList.contains('md-path')),'resolved link');
    const findLink=label=>[...f.host.querySelectorAll('a')].find(el=>el.textContent===label);
    findLink('打开交互 HTML').click();findLink('交互稿').click();findLink('官网').click();findLink('缺失').click();findLink('危险').click();
    const invalidHrefs=['缺失','危险'].map(label=>findLink(label).getAttribute('href'));
    const styles=[...f.host.querySelectorAll('.agent-md li')].map(el=>({before:getComputedStyle(el,'::before').content,margin:getComputedStyle(el).marginBottom,padding:getComputedStyle(el).paddingBottom,list:getComputedStyle(el.parentElement).listStyleType}));
    return{running,settled:f.host.textContent,styles,invalidHrefs,opened:f.opened,external:f.external,errors:f.errors};
  })()`
})

test('original conversation keeps steering, native answers and asynchronous replies while masking secrets', () => {
  assert.deepEqual(communication.errors, [])
  for(const text of ['补充：只有一级分组','分组方式','单层分组','访问密码','已填写','间距']) assert.ok(communication.running.includes(text),text)
  assert.doesNotMatch(communication.running, /native context|fixture-secret-must-stay-hidden/)
  assert.doesNotMatch(communication.settled, /fixture-secret-must-stay-hidden/)
})

test('original Markdown lists and file/external links remain functional in the unified task', () => {
  assert.ok(communication.styles.length>=4)
  for(const item of communication.styles){assert.equal(item.before,'none');assert.equal(item.margin,'0px');assert.equal(item.padding,'4px');assert.ok(['disc','decimal'].includes(item.list))}
  assert.deepEqual(communication.opened,[['docs/review.html',null],['docs/review.html',null]])
  assert.deepEqual(communication.external,['https://example.com/'])
  assert.deepEqual(communication.invalidHrefs,[null,null])
})
