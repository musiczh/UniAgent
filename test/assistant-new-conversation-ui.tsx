import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'assistant-new-options', {
  setup: `
    import {AssistantNewConversation} from './src/renderer/components/AssistantNewConversation';
    import './src/renderer/components/assistantConversations.css';
    const capabilities={startupSystemPrompt:true,modelSelect:true,reasoningEffort:true,permissionModes:[{id:'ask'}]};
    const base={bin:'',icon:'',builtin:true,installed:true,lifecycle:{availability:'available'},capabilities};
    const agents=[{...base,id:'codex',name:'Codex',adapter:'codex',models:[{id:'c',label:'C',efforts:['low','high'],defaultEffort:'high'}],defaultModel:'c'},
      ...['kimi','zcode'].map(adapter=>({...base,id:adapter,name:adapter,adapter,defaultModel:'native',models:[{id:'native',label:'原生模型',efforts:[],thinkingOptions:['fast','deep'],defaultThinking:'fast',...(adapter==='zcode'?{zcodeSelection:{providerId:'fixture',modelId:'native'}}:{})}]})),
      {...base,id:'auto',name:'自动模型',adapter:'claude',models:[],capabilities:{...capabilities,modelSelect:false,reasoningEffort:false}}];
    let failing=true;const created=[];
    window.uniagent={getPersonalAssistant:async()=>{if(failing)throw Error('读取默认配置失败');return {assistant:{enabled:true,defaultAgentId:'codex',defaultModel:'c',defaultPermissionMode:'ask'}}},getPrefs:async()=>({lastByAgent:{kimi:{defaultThinking:'deep'}}})};
    window.fixture={created,recover:()=>failing=false};
    const host=document.body.appendChild(document.createElement('div'));const root=createRoot(host);root.render(React.createElement(AssistantNewConversation,{agents,pending:false,error:'',onClose:()=>{},onCreate:async selection=>created.push(selection)}));
    window.unmountOptions=()=>root.unmount();
  `,
  inspect: `(async()=>{
    const panel=()=>document.querySelector('[role=dialog][aria-label="新对话参数"]'),field=label=>panel()?.querySelector('[aria-label="'+label+'"]'),tick=()=>new Promise(r=>setTimeout(r,20)),check=(v,m)=>{if(!v)throw Error(m)},wait=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await tick()}throw Error('options fixture timed out: '+document.body.textContent)},choose=async(label,value)=>{const el=field(label);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));await tick()},submit=async()=>{panel().dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await tick()};
    await wait(()=>panel()?.querySelector('[role=alert]'));check(field('新对话 Agent').disabled&&panel().querySelector('button[type=submit]').disabled,'failed defaults cannot create a conversation');
    window.fixture.recover();[...panel().querySelectorAll('button')].find(el=>el.textContent==='重试').click();await wait(()=>!field('新对话 Agent').disabled);
    await submit();check(window.fixture.created.length===1&&window.fixture.created[0]===undefined,'unchanged choices defer to the latest host defaults');
    await choose('新对话 Agent','kimi');check(field('新对话思考强度').value==='deep','native Thinking follows agent defaults');
    await choose('新对话思考强度','fast');await submit();check(JSON.stringify(window.fixture.created.at(-1))===JSON.stringify({agentId:'kimi',model:'native',thinking:'fast'}),'Kimi uses native Thinking instead of generic effort');
    await choose('新对话 Agent','zcode');check(field('新对话思考强度').value==='fast','changing native agent drops the previous native value');await choose('新对话思考强度','deep');await submit();check(window.fixture.created.at(-1).thinking==='deep'&&!window.fixture.created.at(-1).effort,'ZCode preserves native Thinking');
    await choose('新对话 Agent','auto');check(field('新对话模型').disabled&&field('新对话思考强度').disabled,'runtime-selected models and unsupported effort remain disabled');await submit();check(JSON.stringify(window.fixture.created.at(-1))===JSON.stringify({agentId:'auto'}),'unsupported controls do not leak previous model or Thinking');
    window.unmountOptions();return {ok:true};
  })()`
})
assert.equal(result.ok, true)
console.log('PASS assistant new-conversation UI: loading failure, retry, deferred defaults, native Thinking and unsupported controls')
