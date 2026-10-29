import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([
  { sessionId: 'owner', seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { text: '上下文快照固定', phase: 'final_answer' } },
  { sessionId: 'owner', seq: 3, ts: 3, type: 'turn_completed', payload: {} }
], 'idle', 'owner', {
  setup: `
    import {CommentProvider, useComments} from './src/renderer/comments';
    import {CommentPanel} from './src/renderer/components/CommentPanel';
    import {ImmersiveReader} from './src/renderer/components/ImmersiveReader';
    import './src/renderer/commentStyles.css';
    let changed;
    window.uniagent = new Proxy({}, {get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null});
    const session = {id:'owner', config:{agentId:'codex', model:'a', permissionMode:'full-access', workdir:'/repo'}};
    const agents = [{id:'codex',name:'Codex',adapter:'codex',capabilities:{permissionModes:[{id:'full-access'}]},models:[{id:'a',label:'Model A',efforts:[]},{id:'b',label:'Model B',efforts:[]}]}];
    window.fixtureSession=session; window.fixtureAgents=agents;
    window.rows = []; window.sends = []; window.stops = [];
    window.uniagent.onCommentChanged = cb => { changed = cb; return () => {} };
    window.uniagent.listComments = async owner => window.rows.filter(row=>row.sessionId===owner);
    window.uniagent.createComment = async (owner, selection) => {
      window.captured = selection;
      const thread = {id:'thread-'+(window.rows.length+1),sessionId:owner,createdAt:1,updatedAt:1,anchor:selection,config:session.config,events:[],status:'draft'};
      window.rows.push(thread); return thread;
    };
    window.uniagent.sendComment = async (owner,id,text,model) => {
      window.sends.push({owner,id,text,model});
      const row = window.rows.find(row=>row.id===id); Object.assign(row,{status:'running',updatedAt:Date.now(),events:[{sessionId:owner,seq:1,ts:1,type:'user_message',payload:{text}}]});
      changed({...row});
    };
    window.uniagent.stopComment = async (owner,id) => { window.stops.push(id); const row=window.rows.find(row=>row.id===id); changed({...row,status:'interrupted',updatedAt:Date.now()}); };
    function Fixture() {
      const comments = useComments();
      const [file,setFile] = React.useState(false); window.showFile=()=>setFile(true);
      React.useEffect(()=>{comments.configure(session,agents)},[]);
      window.commentFixture = comments;
      return file ? React.createElement(ImmersiveReader,{file:{sessionId:'owner',name:'doc.md',path:'/repo/doc.md',text:'# 文档\\n\\nMarkdown 文件阅读。',navigation:null,loading:false},annotations:[],onAddComment:()=>{},onUpdateComment:()=>{},onRemoveComment:()=>{},onOpenFile:()=>{},onClose:()=>{}}) : React.createElement(CommentPanel);
    }
    const fixture = document.createElement('div'); fixture.id='comment-fixture'; document.body.append(fixture);
    createRoot(fixture).render(React.createElement(CommentProvider,null,React.createElement(Fixture)));
    window.__eventStreamProps = {selection:{annotations:[],onComment:()=>{},onEditComment:()=>{},onUpdateComment:()=>{},onRemoveComment:()=>{},onEditRequestHandled:()=>{},onDetail:()=>{},onSide:()=>{},onSideComment: selection=>window.commentFixture.begin(selection)}};
  `,
  inspect: `(async()=>{
    const wait=()=>new Promise(resolve=>setTimeout(resolve,40)); await wait();
    const root=document.querySelector('#root .agent-md'); const range=document.createRange(); range.selectNodeContents(root);
    const native=window.getSelection(); native.removeAllRanges(); native.addRange(range); root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); await wait();
    const actions=[...document.querySelectorAll('.sel-pop .sel-btn')].map(button=>button.textContent.trim());
    [...document.querySelectorAll('.sel-pop .sel-btn')].find(button=>button.textContent.includes('侧边评论')).click(); await wait();
    const card=!!document.querySelector('.ai-comment-card');
    const helpers= /结合创建时的会话上下文回答|咨询 · 跟随主会话权限|原文与问题已保留/.test(document.querySelector('#comment-fixture').textContent);
    const textarea=document.querySelector('.ai-comment-composer textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    setter.call(textarea,'为什么固定？'); textarea.dispatchEvent(new Event('input',{bubbles:true})); await wait();
    document.querySelector('.ai-comment-send').click(); await wait();
    const stopVisible=!!document.querySelector('.ai-comment-stop'); document.querySelector('.ai-comment-stop').click(); await wait();
    document.querySelector('.mp-trigger').click(); await wait();
    const menu=document.querySelector('.mp-menu-portal'); const portal=menu.parentElement===document.body;
    const option=[...menu.querySelectorAll('.mp-opt')].find(button=>button.textContent.includes('Model B')); option.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); option.click(); await wait();
    const selectedModel=document.querySelector('.mp-trigger').textContent.includes('Model B');
    const separator=document.querySelector('[aria-label="调整侧边评论宽度"]'); separator.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await wait();
    const maximum=separator.getAttribute('aria-valuenow')===separator.getAttribute('aria-valuemax'); separator.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); await wait();
    const minimum=separator.getAttribute('aria-valuenow')==='260';
    document.querySelector('[aria-label="收起侧边评论"]').click(); await wait();
    const closed=!document.querySelector('.ai-comments'); window.commentFixture.select('thread-1'); await wait();
    const reopened=!!document.querySelector('.ai-comment-card') && document.querySelector('.mp-trigger').textContent.includes('Model B');
    window.commentFixture.configure({...window.fixtureSession,id:'other'},window.fixtureAgents); await wait();
    const isolated=window.commentFixture.threads.length===0;
    const captured=window.captured;
    window.commentFixture.configure(window.fixtureSession,window.fixtureAgents); await wait(); window.showFile(); await wait();
    const documentText=document.querySelector('.immersive-reader-overlay .agent-md'); range.selectNodeContents(documentText); native.removeAllRanges();native.addRange(range); documentText.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); await wait();
    const readerActions=[...document.querySelectorAll('.reader-selection-pop .sel-btn')].map(button=>button.textContent.trim());
    [...document.querySelectorAll('.reader-selection-pop .sel-btn')].find(button=>button.textContent.includes('侧边评论')).click(); await wait();
    const fileSource={path:window.captured.filePath,source:window.captured.sourceText,embedded:!!document.querySelector('.ai-comments.embedded')};
    return {actions,card,helpers,stopVisible,closed,reopened,isolated,sends:window.sends,stops:window.stops,captured,readerActions,fileSource,portal,selectedModel,maximum,minimum};
  })()`
})
assert.deepEqual(result.actions, ['评论', '解释', '侧边聊天', '侧边评论'])
assert.equal(result.card, true)
assert.equal(result.helpers, false)
assert.equal(result.stopVisible, true)
assert.equal(result.closed, true)
assert.equal(result.reopened, true)
assert.equal(result.isolated, true)
assert.equal(result.portal, true, 'the model menu escapes the scrolling comment list')
assert.equal(result.selectedModel, true)
assert.equal(result.maximum, true)
assert.equal(result.minimum, true)
assert.equal(result.sends[0].text, '为什么固定？')
assert.deepEqual(result.sends[0].model, { agentId: 'codex', model: 'a' })
assert.deepEqual(result.stops, ['thread-1'])
assert.equal(result.captured.selectedMessageText, '上下文快照固定\n')
assert.deepEqual(result.readerActions, ['评论', '复制', '侧边评论'])
assert.deepEqual(result.fileSource, {path:'/repo/doc.md',source:'# 文档\n\nMarkdown 文件阅读。',embedded:true})
console.log('comment UI: four selection actions, compose, default model, stop, close/reopen and owner isolation passed')
