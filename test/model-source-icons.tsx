import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'model-source-icons', {
  setup: `
    import {ModelPicker,ModelMenuOption} from './src/renderer/components/ModelPicker';
    import {RunConfigPicker} from './src/renderer/components/RunConfigPicker';
    import {SuperAgentConfigPicker} from './src/renderer/components/SuperAgentConfigPicker';
    const models=[{id:'native',label:'方舟 CP · native name',modelSource:{kind:'native'}},{id:'legacy',label:'Legacy model'},{id:'third',label:'方舟 CP · kimi-k3.1-pro',modelSource:{kind:'third-party',sourceId:'ark'}},{id:'local',label:'Local model',modelSource:{kind:'local',sourceId:'local'}},{id:'uniagent-model:third-party:ferry:claude-gpt-6-1-sol',label:'Ferry GPT-6.1-Sol',modelSource:{kind:'third-party',sourceId:'ferry'}},{id:'managed-ferry-name',label:'Ferry custom account',modelSource:{kind:'third-party',sourceId:'custom'}}].map(m=>({...m,imageInput:true,efforts:[]}));
    const agent={id:'codex',adapter:'codex',name:'Codex',installed:true,models,capabilities:{startupSystemPrompt:true,modelSelect:true,permissionModes:[]}};
    window.choices={};
    function Fixture(){return <div style={{padding:40}}><div id="options">{models.map(m=><ModelMenuOption key={m.id} model={m} selected={m.id==='third'} onSelect={()=>window.choices.menu=m}/>)}</div><div id="picker"><ModelPicker models={models} value="native" onChange={id=>window.choices.picker=id}/></div><div id="run"><RunConfigPicker agents={[agent]} value={{agentId:'codex',model:'native',modelSource:{kind:'native'}}} onChange={value=>window.choices.run=value}/></div><div id="super"><SuperAgentConfigPicker agents={[agent]} value={{agentId:'codex',model:'native',modelSource:{kind:'native'}}} field="model" label="测试模型" onChange={value=>window.choices.super=value}/></div></div>};
    createRoot(document.body.appendChild(document.createElement('div'))).render(<Fixture/>);
  `,
  inspect: `(async()=>{
    const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw Error('Model icon fixture timeout: '+document.body.textContent.slice(-2000))};
    const check=selector=>[...document.querySelectorAll(selector)].map(row=>({label:row.textContent,icon:!!row.querySelector('img[alt="UniAgent 提供"]'),size:row.querySelector('img[alt="UniAgent 提供"]')?.getAttribute('width'),selected:row.getAttribute('aria-selected')}));
    await wait(()=>document.querySelector('#options [role=option]'));
    const menu=check('#options [role=option]');document.querySelectorAll('#options [role=option]')[2].click();
    document.querySelector('#picker .mp-trigger').click();await wait(()=>document.querySelector('#picker [role=option]'));const picker=check('#picker [role=option]');document.querySelectorAll('#picker [role=option]')[2].click();
    document.querySelector('#run summary').click();await wait(()=>document.querySelector('#run .sb-sub-menu [role=option]'));document.querySelectorAll('#run .sb-sub-entry')[1].click();await wait(()=>[...document.querySelectorAll('[role=option]')].some(row=>row.closest('.sb-sub-menu')&&row.textContent.includes('Legacy model')));
    const runRows=[...document.querySelectorAll('[role=option]')].filter(row=>row.closest('.sb-sub-menu'));const run=runRows.map(row=>({label:row.textContent,icon:!!row.querySelector('img[alt="UniAgent 提供"]')}));runRows.find(row=>row.textContent.includes('kimi-k3.1-pro')).click();
    document.querySelector('#super summary').click();await wait(()=>document.querySelector('#super [data-title-model=third]'));const superRows=check('#super [role=option]');document.querySelector('#super [data-title-model=third]').click();
    return {menu,picker,run,superRows,choices:window.choices,errors:window.__fixtureErrors};
  })()`
})
for (const key of ['menu', 'picker', 'run', 'superRows']) {
  assert.deepEqual(result[key].map(row => row.icon), [false, false, true, true, false, true], `${key}: Ferry is external; managed sources keep icons regardless of their names`)
}
assert.equal(result.menu[2].selected, 'true')
assert.equal(result.menu[2].size, '16')
assert.equal(result.choices.picker, 'third')
assert.equal(result.choices.menu.modelSource.sourceId, 'ark')
for (const key of ['run', 'super']) assert.deepEqual(result.choices[key].modelSource, { kind: 'third-party', sourceId: 'ark' })
assert.deepEqual(result.errors, [])
console.log('PASS model source icons: source identity, native exclusion, four model menus and selection callbacks')
