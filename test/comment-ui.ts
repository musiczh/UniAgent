import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([
  { sessionId: 'owner', seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { id: 'stable-reply', turnId: 'stable-turn', text: '上下文快照固定', phase: 'final_answer' } },
  { sessionId: 'owner', seq: 3, ts: 3, type: 'turn_completed', payload: {} }
], 'idle', 'owner', {
  setup: `
    import {CommentProvider, useComments, findCommentHighlight} from './src/renderer/comments';
    import {CommentPanel} from './src/renderer/components/CommentPanel';
    import {ImmersiveReader} from './src/renderer/components/ImmersiveReader';
    import {commentAnchor} from './src/shared/comments';
    import {SessionHeader} from './src/renderer/App';
    import './src/renderer/commentStyles.css';
    window.commentErrors=[];
    window.addEventListener('error',event=>window.commentErrors.push(event.error?.stack || event.message));
    let changed, removed;
    window.uniagent = new Proxy({}, {get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null});
    const session = {id:'owner', config:{agentId:'codex', model:'a', permissionMode:'full-access', workdir:'/repo'}};
    const agents = [{id:'codex',name:'Codex',adapter:'codex',capabilities:{sideChat:true,permissionModes:[{id:'full-access'}]},models:[{id:'a',label:'Model A',efforts:[]},{id:'b',label:'Model B',efforts:[]}]},
      {id:'claude',name:'Claude',adapter:'claude',capabilities:{permissionModes:[{id:'full-access'}]},models:[{id:'foreign',label:'Foreign Model',efforts:[]}]}];
    localStorage.setItem('ua.comment-model:thread-1',JSON.stringify(['claude','foreign']));
    window.fixtureSession=session; window.fixtureAgents=agents;
    window.rows = []; window.sends = []; window.stops = [];
    window.uniagent.onCommentChanged = cb => { changed = cb; return () => {} };
    window.uniagent.onCommentRemoved = cb => { removed = cb; return () => {} };
    window.deleted=[]; window.commentChanged=thread=>changed(thread); window.findCommentHighlight=findCommentHighlight;
    window.uniagent.deleteComment = async (owner,id) => {
      if(window.failDelete){window.failDelete=false;throw new Error('写盘失败')}
      window.deleted.push({owner,id}); window.rows=window.rows.filter(row=>row.id!==id); removed({sessionId:owner,id});
    };
    window.uniagent.listComments = async owner => window.rows.filter(row=>row.sessionId===owner);
    window.uniagent.createComment = async (owner, selection) => {
      window.captured = selection;
      const thread = {id:'thread-'+(window.rows.length+1),sessionId:owner,createdAt:1,updatedAt:1,anchor:{...commentAnchor(selection),seq:selection.filePath?-1:1},config:session.config,events:[],status:'draft'};
      window.rows.push(thread); return thread;
    };
    window.uniagent.sendComment = async (owner,id,text,model,clientTurnKey) => {
      window.sends.push({owner,id,text,model});
      if(window.delaySend) await new Promise(resolve=>{window.releaseSend=resolve});
      const row = window.rows.find(row=>row.id===id); Object.assign(row,{status:'running',updatedAt:Date.now(),events:[{sessionId:owner,seq:1,ts:1,type:'user_message',payload:{text,clientTurnKey}},
        {sessionId:owner,seq:2,ts:2,type:'agent_message',state:'success',payload:{id:'comment-answer',text:'这是解释。',phase:'final_answer'}}]});
      changed({...row});
    };
    window.uniagent.stopComment = async (owner,id) => { window.stops.push(id); const row=window.rows.find(row=>row.id===id); changed({...row,status:'interrupted',updatedAt:Date.now()}); };
    function Fixture() {
      const comments = useComments();
      const [mode,setMode] = React.useState('main'); window.showFile=()=>setMode('file'); window.showReply=()=>setMode('reply'); window.showMain=()=>setMode('main');
      React.useEffect(()=>{comments.configure(session,agents)},[]);
      window.commentFixture = comments;
      const props={annotations:[],onAddComment:()=>{},onUpdateComment:()=>{},onRemoveComment:()=>{},onOpenFile:()=>{},onClose:()=>{}};
      const body=mode==='file' ? React.createElement(ImmersiveReader,{...props,file:{sessionId:'owner',name:'doc.md',path:'/repo/doc.md',text:'# 文档\\n\\nMarkdown 文件阅读。',navigation:null,loading:false}}) : mode==='reply' ? React.createElement(ImmersiveReader,{...props,event:{sessionId:'owner',seq:200,ts:2,type:'agent_message',payload:{id:'stable-reply',turnId:'stable-turn',text:'上下文快照固定',phase:'final_answer'}}}) : React.createElement(CommentPanel);
      return React.createElement(React.Fragment,null,React.createElement(SessionHeader,{session:comments.session||session,agents,commentsOpen:comments.open,
        onOpenComments:()=>{comments.setTab('ai');comments.show()},onOpenSide:()=>comments.close()}),body);
    }
    const fixture = document.createElement('div'); fixture.id='comment-fixture'; document.body.append(fixture);
    createRoot(fixture).render(React.createElement(CommentProvider,null,React.createElement(Fixture)));
    window.__eventStreamProps = {selection:{annotations:[],onComment:()=>{},onEditComment:()=>{},onUpdateComment:()=>{},onRemoveComment:()=>{},onEditRequestHandled:()=>{},onDetail:()=>{},onSide:()=>{},onSideComment: selection=>window.commentFixture.begin(selection)}};
  `,
  inspect: `(async()=>{
    try {
    const wait=()=>new Promise(resolve=>setTimeout(resolve,40)); await wait();
    const headerButton=document.querySelector('[aria-label="打开侧边评论"]'); headerButton.click(); await wait();
    const headerOpensEmpty=!!document.querySelector('.ai-comments')&&window.rows.length===0&&headerButton.getAttribute('aria-expanded')==='true';
    const sideButton=document.querySelector('.session-side-toggle'); const differentIcons=sideButton.querySelector('svg').innerHTML!==headerButton.querySelector('svg').innerHTML;
    sideButton.click(); await wait(); const sideClosesComments=!document.querySelector('.ai-comments');
    const root=document.querySelector('#root .agent-md'); const range=document.createRange(); range.selectNodeContents(root);
    const native=window.getSelection(); native.removeAllRanges(); native.addRange(range); root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); await wait();
    const actions=[...document.querySelectorAll('.sel-pop .sel-btn')].map(button=>button.textContent.trim());
    [...document.querySelectorAll('.sel-pop .sel-btn')].find(button=>button.textContent.includes('侧边评论')).click(); await wait();
    const card=!!document.querySelector('.ai-comment-card');
    const helpers= /结合创建时的会话上下文回答|咨询 · 跟随主会话权限|原文与问题已保留/.test(document.querySelector('#comment-fixture').textContent);
    const textarea=document.querySelector('.ai-comment-composer textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    textarea.focus(); const focusedBorder=getComputedStyle(document.querySelector('.ai-comment-composer')).borderColor;
    const source=document.querySelector('.ai-comment-source'); const head=document.querySelector('.ai-comment-head'); const marker=getComputedStyle(head,'::before');
    const markerOnlyInHeader=parseFloat(marker.height)>0&&parseFloat(marker.height)<=head.offsetHeight&&getComputedStyle(document.querySelector('.ai-comment-card'),'::before').content==='none';
    const compactTitle=source.textContent.includes('上下文快照固定')&&!document.querySelector('.ai-comment-number,.ai-comment-quote,.ai-comments .ui-icon-search')&&!source.textContent.includes('本条回复');
    const smallerControls=document.querySelector('.ai-comment-send').getBoundingClientRect().width===30&&document.querySelector('.ai-comment-compose-actions .agent-icon-codex').getBoundingClientRect().width===15;
    setter.call(textarea,' 为什么固定？ '); textarea.dispatchEvent(new Event('input',{bubbles:true})); await wait();
    window.delaySend=true;document.querySelector('.ai-comment-send').click(); await wait();
    const immediateComment=!!document.querySelector('.ai-comment-conversation .user-msg')&&!!document.querySelector('[data-send-flight]');
    const stopVisible=!!document.querySelector('.ai-comment-stop');
    document.querySelector('.ai-comment-toggle').click(); await wait();
    const foldsWhileRunning=!document.querySelector('.ai-comment-card.active')&&!document.querySelector('.ai-comment-composer')&&window.stops.length===0;
    window.releaseSend();window.delaySend=false;await wait();
    document.querySelector('.ai-comment-toggle').click(); await wait();
    const resumesRunning=!!document.querySelector('.ai-comment-stop')&&window.sends.length===1;
    const submittedDraftCleared=document.querySelector('.ai-comment-composer textarea').value==='';
    document.querySelector('.ai-comment-stop').click(); await wait();
    const avatars=!!document.querySelector('.ai-comment-conversation [aria-label="用户"] .ui-icon-user-circle')&&!!document.querySelector('.ai-comment-conversation [aria-label="AI"] .agent-icon-codex');
    const userRow=document.querySelector('.ai-comment-conversation .user-msg');
    const assistantRow=document.querySelector('.ai-comment-conversation .agent-msg');
    const avatarsAligned=Math.abs(userRow.querySelector('.bubble').getBoundingClientRect().left-userRow.getBoundingClientRect().left-28)<1&&
      Math.abs(assistantRow.querySelector('.agent-md').getBoundingClientRect().left-assistantRow.getBoundingClientRect().left-28)<1;
    document.querySelector('.mp-trigger').click(); await wait();
    const menu=document.querySelector('.mp-menu-portal'); const portal=menu.parentElement===document.body;
    const currentAgentOnly=[...menu.querySelectorAll('.mp-opt-label')].every(option=>option.textContent.startsWith('Codex ·'))&&!menu.textContent.includes('Foreign Model');
    const option=[...menu.querySelectorAll('.mp-opt')].find(button=>button.textContent.includes('Model B')); option.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); option.click(); await wait();
    const selectedModel=document.querySelector('.mp-trigger').textContent.includes('Model B');
    const separator=document.querySelector('[aria-label="调整侧边评论宽度"]'); separator.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await wait();
    const maximum=separator.getAttribute('aria-valuenow')===separator.getAttribute('aria-valuemax'); separator.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); await wait();
    const minimum=separator.getAttribute('aria-valuenow')==='260';
    let located, locateCount=0; window.addEventListener('ua:locate-comment',event=>{located=event.detail.id;locateCount++});
    await window.commentFixture.begin({...window.captured,start:0,end:3,quote:'上下文'}); await wait();
    const inactive=document.querySelector('.ai-comment-card:not(.active)'); const neutral=getComputedStyle(inactive).borderColor;
    const grayBorders=getComputedStyle(document.querySelector('.ai-comment-card.active')).borderColor===neutral&&focusedBorder===neutral;
    inactive.click(); await wait(); const itemExpands=window.commentFixture.selected==='thread-1'&&located==='thread-1'&&document.querySelectorAll('.ai-comment-conversation').length===1;
    document.querySelector('.ai-comment-card:not(.active) .ai-comment-source').click(); await wait();
    const draft=document.querySelector('.ai-comment-composer textarea'); setter.call(draft,'保留这条草稿'); draft.dispatchEvent(new Event('input',{bubbles:true})); await wait();
    document.querySelector('.ai-comment-card:not(.active) .ai-comment-source').click(); await wait();
    document.querySelector('.ai-comment-card:not(.active) .ai-comment-source').click(); await wait();
    const keepsDraft=document.querySelector('.ai-comment-composer textarea').value==='保留这条草稿';
    const countBeforeFold=locateCount;
    document.querySelector('.ai-comment-card.active .ai-comment-toggle').click(); await wait();
    const allFolded=!document.querySelector('.ai-comment-card.active');
    document.querySelectorAll('.ai-comment-toggle')[1].click(); await wait();
    const foldKeepsDraft=allFolded&&document.querySelector('.ai-comment-composer textarea').value==='保留这条草稿'&&locateCount===countBeforeFold;
    document.querySelector('.ai-comment-card.active .ai-comment-source').click(); await wait();
    document.querySelector('.ai-comment-card.active .ai-comment-source').click(); await wait();
    const repeatedTitleLocates=locateCount===countBeforeFold+2&&located==='thread-2';
    window.commentFixture.select('thread-1'); await wait();
    document.querySelector('[aria-label="收起侧边评论"]').click(); await wait();
    const closed=!document.querySelector('.ai-comments'); window.commentFixture.select('thread-1'); await wait();
    const reopened=!!document.querySelector('.ai-comment-card') && document.querySelector('.mp-trigger').textContent.includes('Model B');
    window.commentFixture.configure({...window.fixtureSession,id:'other'},window.fixtureAgents); await wait();
    const isolated=window.commentFixture.threads.length===0;
    const captured={...window.captured,start:0,end:8,quote:'上下文快照固定'};
    window.commentFixture.configure(window.fixtureSession,window.fixtureAgents); await wait(); window.showFile(); await wait();
    const documentText=document.querySelector('.immersive-reader-overlay .agent-md'); range.selectNodeContents(documentText); native.removeAllRanges();native.addRange(range); documentText.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); await wait();
    const readerActions=[...document.querySelectorAll('.reader-selection-pop .sel-btn')].map(button=>button.textContent.trim());
    [...document.querySelectorAll('.reader-selection-pop .sel-btn')].find(button=>button.textContent.includes('侧边评论')).click(); await wait();
    const fileSource={path:window.captured.filePath,source:window.captured.sourceText,embedded:!!document.querySelector('.ai-comments.embedded')};
    const rebound=window.commentFixture.annotations([],'owner',[{sessionId:'owner',seq:200,type:'agent_message',payload:{id:'stable-reply',turnId:'stable-turn',text:'上下文快照固定'}}]).find(annotation=>annotation.id==='ai-comment:thread-1')?.seq;
    window.showReply(); await wait();
    const restoredHighlight=!!document.querySelector('.immersive-reader-document [data-anno-id="ai-comment:thread-1"]');
    const noSourceNumbers=!document.querySelector('.immersive-reader-document .ai-comment-badge');
    const normalMessagesUnchanged=!document.querySelector('#root .message-role-icon');
    const readerMark=document.querySelector('.immersive-reader-document [data-anno-id="ai-comment:thread-1"]');
    const covered=document.createElement('mark');covered.dataset.annoId='ai-comment:thread-1';covered.textContent='被阅读层覆盖的原文';document.querySelector('#root').append(covered);
    const prefersVisibleReader=window.findCommentHighlight('thread-1')===readerMark;covered.remove();
    window.showMain(); await wait(); window.commentFixture.select('thread-2'); await wait();
    let target=document.querySelector('.ai-comment-card.active');
    if(!target)throw new Error('comment state after reader: '+JSON.stringify({selected:window.commentFixture.selected,open:window.commentFixture.open,ids:window.commentFixture.threads.map(row=>row.id),text:document.querySelector('#comment-fixture').textContent,errors:window.commentErrors}));
    target.querySelector('.ai-comment-more').click();await wait();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait();
    const menuKeyboard=!document.querySelector('.ai-comment-menu')&&document.activeElement===target.querySelector('.ai-comment-more');
    target.querySelector('.ai-comment-more').click();await wait();target.querySelector('[role="menuitem"]').click();await wait();
    const asksBeforeDelete=window.deleted.length===0&&!!target.querySelector('[role="alertdialog"]');target.querySelector('.ai-comment-confirm button').click();await wait();
    const cancelDelete=window.deleted.length===0&&!target.querySelector('[role="alertdialog"]');
    target.querySelector('.ai-comment-more').click();await wait();target.querySelector('[role="menuitem"]').click();await wait();
    window.failDelete=true;target.querySelector('.ai-comment-confirm .danger').click();await wait();
    const keepsFailedDelete=window.commentFixture.threads.length===3&&target.textContent.includes('写盘失败');
    const stale={...window.rows.find(row=>row.id==='thread-2'),updatedAt:Date.now()+1000};
    target.querySelector('.ai-comment-confirm .danger').click();await wait();window.commentChanged(stale);await wait();
    const deletesItem=window.commentFixture.threads.length===2&&!window.commentFixture.threads.some(row=>row.id==='thread-2')&&!localStorage.getItem('ua.comment-draft:thread-2');
    const list=window.uniagent.listComments;window.uniagent.listComments=async owner=>[...await list(owner),stale];
    window.commentFixture.configure({...window.fixtureSession,id:'other'},window.fixtureAgents);await wait();window.commentFixture.configure(window.fixtureSession,window.fixtureAgents);await wait();
    const staleListIgnored=!window.commentFixture.threads.some(row=>row.id==='thread-2');
    return {actions,card,helpers,stopVisible,immediateComment,closed,reopened,isolated,sends:window.sends,stops:window.stops,captured,readerActions,fileSource,portal,selectedModel,maximum,minimum,rebound,restoredHighlight,
      headerOpensEmpty,differentIcons,sideClosesComments,markerOnlyInHeader,compactTitle,avatars,avatarsAligned,currentAgentOnly,grayBorders,itemExpands,keepsDraft,noSourceNumbers,normalMessagesUnchanged,
      smallerControls,foldsWhileRunning,resumesRunning,submittedDraftCleared,foldKeepsDraft,repeatedTitleLocates,prefersVisibleReader,menuKeyboard,asksBeforeDelete,cancelDelete,keepsFailedDelete,deletesItem,staleListIgnored,deleted:window.deleted};
    } catch(error) { throw new Error(error.stack || error.message) }
  })()`
})
assert.deepEqual(result.actions, ['评论', '解释', '侧边聊天', '侧边评论'])
assert.equal(result.card, true)
assert.equal(result.immediateComment, true, 'comment input appears and animates before host publication or acceptance')
assert.equal(result.helpers, false)
assert.equal(result.stopVisible, true)
assert.equal(result.closed, true)
assert.equal(result.reopened, true)
assert.equal(result.isolated, true)
for(const key of ['headerOpensEmpty','differentIcons','sideClosesComments','markerOnlyInHeader','compactTitle','avatars','avatarsAligned','currentAgentOnly','grayBorders','itemExpands','keepsDraft','noSourceNumbers','normalMessagesUnchanged']) assert.equal(result[key],true,key)
for(const key of ['smallerControls','foldsWhileRunning','resumesRunning','submittedDraftCleared','foldKeepsDraft','repeatedTitleLocates','prefersVisibleReader','menuKeyboard','asksBeforeDelete','cancelDelete','keepsFailedDelete','deletesItem','staleListIgnored']) assert.equal(result[key],true,key)
assert.deepEqual(result.deleted,[{owner:'owner',id:'thread-2'}])
assert.equal(result.portal, true, 'the model menu escapes the scrolling comment list')
assert.equal(result.selectedModel, true)
assert.equal(result.maximum, true)
assert.equal(result.minimum, true)
assert.equal(result.sends[0].text, ' 为什么固定？ ')
assert.deepEqual(result.sends[0].model, { agentId: 'codex', model: 'a' })
assert.deepEqual(result.stops, ['thread-1'])
assert.equal(result.captured.selectedMessageText, '上下文快照固定\n')
assert.equal(result.captured.messageId, 'stable-reply')
assert.equal(result.captured.turnId, 'stable-turn')
assert.equal(result.rebound, 200, 'persisted anchors follow native identity when history seq changes')
assert.equal(result.restoredHighlight, true, 'immersive reading uses the current reply position for highlights')
assert.deepEqual(result.readerActions, ['评论', '复制', '侧边评论'])
assert.deepEqual(result.fileSource, {path:'/repo/doc.md',source:'# 文档\n\nMarkdown 文件阅读。',embedded:true})
console.log('comment UI: collapse, repeated location, visible reader, delete/cancel/failure, draft recovery and Agent-scoped models passed')
