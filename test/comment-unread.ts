import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'unused', {
  setup: `
    import {CommentProvider,useComments} from './src/renderer/comments';
    import {CommentPanel} from './src/renderer/components/CommentPanel';
    import './src/renderer/commentStyles.css';
    const noop=()=>{};
    let changed;
    window.foreground=true;window.visibility='visible';
    document.hasFocus=()=>window.foreground;
    Object.defineProperty(document,'visibilityState',{get:()=>window.visibility});
    const session={id:'owner',config:{agentId:'codex'}};
    const agent={id:'codex',name:'Codex',adapter:'codex',models:[],capabilities:{permissionModes:[]}};
    window.thread={id:'unread-thread',sessionId:'owner',createdAt:1,updatedAt:1,status:'draft',config:session.config,
      anchor:{seq:1,start:0,end:4,quote:'评论原文',prefix:'',suffix:''},events:[]};
    window.uniagent=new Proxy({
      listComments:async()=>[window.thread],onCommentChanged:cb=>{changed=cb;return noop},
      deleteComment:async()=>{}
    },{get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? ()=>noop : async()=>null});
    window.publish=patch=>{window.thread={...window.thread,...patch,updatedAt:window.thread.updatedAt+1};changed(window.thread)};
    function Fixture(){
      const comments=useComments();window.comments=comments;
      React.useEffect(()=>{comments.configure(session,[agent])},[]);
      return React.createElement(CommentPanel);
    }
    const host=document.body.appendChild(document.createElement('div'));
    Object.assign(host.style,{height:'540px',width:'380px',position:'fixed',top:'0',left:'0'});
    let root;
    window.mountComments=()=>{root=createRoot(host);root.render(React.createElement(CommentProvider,null,React.createElement(Fixture)))};
    window.unmountComments=()=>root.unmount();window.mountComments();
  `,
  inspect: `(async()=>{
    const wait=()=>new Promise(resolve=>setTimeout(resolve,100));
    const dot=()=>!!document.querySelector('.ai-comment-unread');
    const reply=(seq,text='回答',state='success',phase='final_answer')=>({sessionId:'owner',seq,ts:seq,type:'agent_message',state,payload:{id:'reply-'+seq,text,phase}});
    await wait();window.comments.show();await wait();const draft=!dot();
    window.publish({status:'running',events:[reply(1,'正在检查','success','commentary')]});await wait();const commentary=!dot();
    window.publish({events:[reply(2,'流式回答','running')]});await wait();const streaming=!dot();
    window.publish({status:'interrupted',events:[reply(2,'中断的部分回复','cancelled')]});await wait();const interrupted=!dot();
    window.publish({status:'error',events:[{sessionId:'owner',seq:2,ts:2,type:'error',payload:{message:'失败'}}]});await wait();const failed=!dot();
    window.publish({status:'idle',events:[reply(2,'   ')]});await wait();const empty=!dot();
    window.publish({status:'idle',events:[reply(2)]});await wait();const collapsed=dot();
    const size=document.querySelector('.ai-comment-unread').getBoundingClientRect().width;
    window.foreground=false;document.querySelector('.ai-comment-toggle').click();await wait();const background=dot();
    window.foreground=true;window.dispatchEvent(new Event('focus'));await wait();const read=!dot();
    const saved=JSON.parse(localStorage.getItem('ua.comment-read-replies'))['unread-thread'];
    document.querySelector('.ai-comment-toggle').click();await wait();
    window.publish({updatedAt:999});await wait();const metadataDoesNotRelight=!dot();
    window.publish({events:[reply(2),reply(3,'第二次回复')]});await wait();const nextReply=dot();
    window.unmountComments();window.mountComments();await wait();const restoredUnread=dot();
    document.querySelector('.ai-comment-toggle').click();await wait();const openedRead=!dot();
    window.unmountComments();window.mountComments();await wait();const restoredRead=!dot();
    window.comments.close();await wait();window.publish({events:[reply(2),reply(3),reply(4,'评论栏关闭时的回复')]});await wait();
    const closedUnread=window.comments.unread(window.thread);
    window.foreground=false;window.comments.show();await wait();const reopenedUnread=dot();
    window.foreground=true;window.dispatchEvent(new Event('focus'));await wait();const reopenedRead=!dot();
    window.visibility='hidden';window.publish({events:[reply(2),reply(3),reply(4),reply(5,'隐藏窗口的新回复')]});await wait();const hiddenUnread=dot();
    window.visibility='visible';document.dispatchEvent(new Event('visibilitychange'));await wait();const visibleRead=!dot();
    window.publish({events:[...window.thread.events,reply(6,'上文内容。'.repeat(500)),reply(7,'列表下方的新回复')]});await wait();
    const offscreenUnread=dot();const list=document.querySelector('.ai-comments-list');list.scrollTop=list.scrollHeight;await wait();const scrolledRead=!dot();
    window.comments.configure({...window.comments.session,id:'other'},[]);await wait();
    window.publish({events:[...window.thread.events,reply(8,'离开会话后的回复')]});await wait();const otherSessionUnread=window.comments.unread(window.thread);
    window.foreground=false;window.comments.configure({id:'owner',config:{agentId:'codex'}},[]);await wait();const returnedUnread=dot();
    await window.comments.remove(window.thread);await wait();
    const removedState=!('unread-thread' in JSON.parse(localStorage.getItem('ua.comment-read-replies')));
    return {draft,commentary,streaming,interrupted,failed,empty,collapsed,size,background,read,saved,metadataDoesNotRelight,nextReply,restoredUnread,
      openedRead,restoredRead,closedUnread,reopenedUnread,reopenedRead,hiddenUnread,visibleRead,offscreenUnread,scrolledRead,otherSessionUnread,returnedUnread,removedState};
  })()`
})

assert.equal(result.size, 7, 'the confirmed unread dot is 7px wide')
assert.equal(result.saved, 2, 'reading persists the latest completed reply sequence')
for (const [name, value] of Object.entries(result)) {
  if (name !== 'size' && name !== 'saved') assert.equal(value, true, name)
}
console.log('comment unread: replies, focus/visibility, reopen/restart, session changes and deletion passed')
