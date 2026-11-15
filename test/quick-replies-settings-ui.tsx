import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'quick-replies-settings-ui', {
  setup: `
    import {RequirementTaskSettings} from './src/renderer/components/RequirementTaskSettings';
    const noop=()=>{},saves=[],errors=[];
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));window.confirm=()=>false;
    const agent={id:'claude',name:'Claude Code',adapter:'claude',installed:true,bin:'/fixture',models:[{id:'small',label:'Small',efforts:[]}],capabilities:{startupSystemPrompt:true,modelSelect:true,permissionModes:[]}};
    let settings={taskTitleGeneration:{enabled:false,agentId:'claude',model:'small'},quickRepliesEnabled:true},fail=false;
    window.uniagent=new Proxy({getRouterSnapshot:async()=>({config:{enabled:false,version:1},available:false}),setAppSettings:async patch=>{saves.push(patch);if(fail)throw Error('disk failed');settings={...settings,...patch};return settings}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>noop:async()=>null});
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host),guard={current:null};
    const render=()=>root.render(React.createElement(RequirementTaskSettings,{agents:[agent],settings,navigationGuard:guard}));render();
    window.replySettingsFixture={host,saves,errors,guard,fail:value=>fail=value,unconfigured:()=>{settings={taskTitleGeneration:{enabled:false},quickRepliesEnabled:false};render()}};
  `,
  inspect: `(async()=>{
    const f=window.replySettingsFixture,q=s=>f.host.querySelector('.codex-model-pane')?.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,15)),wait=async p=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error('reply settings timeout: '+f.host.textContent)};
    const reply=()=>q('[aria-label="快捷回复"]'),title=()=>q('[aria-label="自动生成任务标题"]'),save=()=>[...f.host.querySelectorAll('.codex-model-pane button')].find(button=>button.textContent==='保存配置');
    await wait(()=>reply());const initial={reply:reply().getAttribute('aria-checked'),title:title().getAttribute('aria-checked'),pickers:f.host.querySelectorAll('.codex-model-pane .title-generator-picker').length};
    reply().click();await wait(()=>!save().disabled);const dirtyGuard=f.guard.current();f.fail(true);save().click();await wait(()=>q('[role=alert]'));const failed={draft:reply().getAttribute('aria-checked'),guard:f.guard.current()};
    f.fail(false);save().click();await wait(()=>save().disabled&&!q('[role=alert]'));const saved={guard:f.guard.current(),title:title().getAttribute('aria-checked'),reply:reply().getAttribute('aria-checked')};
    reply().click();await wait(()=>!save().disabled);save().click();await wait(()=>save().disabled);const independent={title:title().getAttribute('aria-checked'),reply:reply().getAttribute('aria-checked')};
    f.unconfigured();await wait(()=>q('.title-generator-picker').dataset.agentId==='');reply().click();await tick();const missingModelCannotEnable=save().disabled;
    return{initial,dirtyGuard,failed,saved,independent,missingModelCannotEnable,saves:f.saves,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors, [])
assert.deepEqual(result.initial, { reply: 'true', title: 'false', pickers: 1 })
assert.equal(result.dirtyGuard, false)
assert.deepEqual(result.failed, { draft: 'false', guard: false })
assert.deepEqual(result.saved, { guard: true, title: 'false', reply: 'false' })
assert.deepEqual(result.independent, { title: 'false', reply: 'true' })
assert.equal(result.missingModelCannotEnable, true)
assert.deepEqual(result.saves.map((patch: any) => patch.quickRepliesEnabled), [false, false, true])
assert.ok(result.saves.every((patch: any) => !patch.taskTitleGeneration.enabled && patch.taskTitleGeneration.model === 'small'))
console.log('PASS shared model, independent reply toggle, failed save draft, retry, navigation guard and missing model')
