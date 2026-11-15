import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'compact-fork-ui', {
  setup: `
    import { HistoryConfirmation } from './src/renderer/components/ResumePanel';
    import { useSessionFork } from './src/renderer/components/SessionForkProgress';
    const agents = ['codex','claude'].map(id => ({id,name:id,adapter:id,models:[{id:'mimo',label:'MiMo',contextWindow:1048576,efforts:[]}],defaultModel:'mimo',capabilities:{}}));
    window.preflights=[]; window.confirmed=[]; window.opens=[];
    window.job={id:'job',seq:1,request:{},sourceSessionId:'source',status:'running',stage:'compacting',detail:'正在压缩',createdAt:Date.now(),updatedAt:Date.now(),reusedCompaction:false};
    window.uniagent={
      getPrefs:async()=>({lastByAgent:{}}),
      preflightFork:request=>new Promise(resolve=>window.preflights.push({request,resolve})),
      listForkJobs:async()=>[],startFork:async()=>window.job,getForkJob:async()=>window.job,
      cancelForkJob:async()=>({...window.job,status:'stopping'}),revealForkArchive:async()=>{},
      onEvent:()=>()=>{},onSessionUpdated:()=>()=>{}
    };
    function Harness(){
      const [action,setAction]=React.useState({kind:'cross',targetAgentId:'claude'});
      const [show,setShow]=React.useState(true),[active,setActive]=React.useState('source');
      const flow=useSessionFork(active,async id=>window.opens.push(id),error=>{window.lastError=error});
      window.changePoint=()=>setAction({kind:'cross',targetAgentId:'claude',point:{kind:'after-turn',nativeId:'older',eventSeq:1}});
      window.navigate=()=>setActive('elsewhere'); window.begin=()=>{setShow(false);return flow.start('approved')};
      return React.createElement(React.Fragment,null,show&&React.createElement(HistoryConfirmation,{action,sourceAgentId:'codex',sourceNativeId:'native-source',agentName:'Codex',title:'test',targetAgents:agents,chooseTarget:true,onChangeAction:setAction,onCancel:()=>setShow(false),onConfirm:id=>window.confirmed.push(id)}),flow.view);
    }
    createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(Harness));
  `,
  inspect: `(async()=>{
    const wait=async fn=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('fork UI timeout '+document.body.innerText)};
    const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
    await wait(()=>window.preflights.length===1);
    const disabled=button('检查中').disabled;
    const first=window.preflights[0];first.resolve({planId:'fresh',request:first.request,reusable:false,sourceRevision:'r1',contextWindow:200000,modelLabel:'MiMo'});
    await wait(()=>button('压缩并分叉')&&!button('压缩并分叉').disabled);button('压缩并分叉').click();
    window.changePoint();await wait(()=>window.preflights.length===2);
    const second=window.preflights[1];second.resolve({planId:'reused',request:second.request,reusable:true,sourceRevision:'r2',contextWindow:200000,modelLabel:'MiMo'});
    await wait(()=>button('直接分叉')&&!button('直接分叉').disabled);button('直接分叉').click();
    await window.begin();await wait(()=>button('收起'));button('收起').click();window.navigate();
    await wait(()=>document.querySelector('.fork-job-collapsed'));
    window.job={...window.job,seq:2,status:'completed',stage:'completed',targetSessionId:'branch',detail:'分支已创建'};
    await wait(()=>document.querySelector('.fork-job-collapsed')?.textContent.includes('分支已创建'));
    const didNotStealFocus=window.opens.length===0;
    document.querySelector('.fork-job-collapsed').click();await wait(()=>button('打开分支'));button('打开分支').click();
    await wait(()=>window.opens.length===1);
    return {disabled,confirmed:window.confirmed,requestedModel:first.request.targetModel,didNotStealFocus,opened:window.opens,error:window.lastError};
  })()`
})
assert.equal(result.disabled, true)
assert.deepEqual(result.confirmed, ['fresh','reused'])
assert.equal(result.requestedModel, 'mimo')
assert.equal(result.didNotStealFocus, true)
assert.deepEqual(result.opened, ['branch'])
assert.equal(result.error, undefined)
console.log('session-fork-ui: passed (preflight, compact/reuse, collapse, navigation)')
