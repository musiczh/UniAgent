import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-agent-picker-ui', {
  setup: `
    import {RunConfigPicker} from './src/renderer/components/RunConfigPicker';
    const base={installed:true,models:[{id:'text',label:'Text only',efforts:[],imageInput:false},{id:'vision',label:'Vision model',efforts:['high'],imageInput:true}],defaultModel:'text',capabilities:{modelSelect:true,startupSystemPrompt:true,permissionModes:[],streaming:true}};
    const agents=[{...base,id:'codex',adapter:'codex',name:'Codex'},{...base,id:'claude',adapter:'claude',name:'Claude Code'},
      {...base,id:'qoder',adapter:'qoder',name:'Qoder CN'}, {...base,id:'traex',adapter:'traex',name:'TraeX'}, {...base,id:'kimi',adapter:'kimi',name:'Kimi Code',capabilities:{...base.capabilities,startupSystemPrompt:false}},
      {...base,id:'locked',adapter:'codex',name:'需要登录',authenticationRequired:true},
      {...base,id:'deepseek',adapter:'deepseek',name:'DeepSeek Harness',version:'0.2.1-rc.2',capabilities:{...base.capabilities,protocol:'web'}}];
    const choices=[],host=document.body.appendChild(document.createElement('div'));const root=createRoot(host);
    function Picker(){const [value,setValue]=React.useState({agentId:'unknown'});return React.createElement(RunConfigPicker,{router:true,agents,value,onChange:choice=>{choices.push(choice);setValue(choice)}})}
    root.render(React.createElement(Picker));window.pickerFixture={host,choices};
  `,
  inspect: `(async()=>{
    const f=window.pickerFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async check=>{for(let i=0;i<150;i++){if(check())return;await tick()}throw Error('Router picker timeout: '+f.host.textContent)};
    await wait(()=>f.host.querySelector('details'));f.host.querySelector('summary').click();await wait(()=>f.host.querySelectorAll('[role=option]').length===7);
    const option=name=>[...f.host.querySelectorAll('[role=option]')].find(row=>row.textContent.includes(name));
    const available=['Codex','Claude Code','Qoder CN','TraeX','DeepSeek Harness'].every(name=>!option(name).disabled),blocked=option('Kimi Code').disabled&&option('需要登录').disabled;
    option('DeepSeek Harness').click();await wait(()=>f.choices.length===1&&f.host.querySelector('.agent-version-warning'));
    const warning=f.host.querySelector('.agent-version-warning').textContent;
    f.host.querySelectorAll('.sb-sub-entry')[0].click();await wait(()=>option('TraeX'));
    option('TraeX').click();await wait(()=>f.choices.length===2&&f.host.textContent.includes('Vision model'));
    return {available,blocked,warning,choice:f.choices[1],onlyVision:![...f.host.querySelectorAll('[role=option]')].some(row=>row.textContent.includes('Text only'))};
  })()`
})
assert.equal(result.available, true)
assert.equal(result.blocked, true)
assert.match(result.warning, /可能存在兼容问题.*更新至最新版 UniAgent/)
assert.equal(result.choice.agentId, 'traex')
assert.equal(result.choice.model, 'vision', 'a text-only default cannot disable an Agent with another compatible model')
assert.equal(result.onlyVision, true)
console.log('PASS Router picker: supported Agents, image-only model choices, compatible fallback and unavailable capabilities')
