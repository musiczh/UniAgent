import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
import { providerContextLimit } from '../src/shared/providerErrors'

for (const value of [undefined, null, 400, '', 'API key expired', 'token has expired', 'model metadata context window missing']) {
  assert.equal(providerContextLimit(value), undefined, '普通认证、元数据提示和无效输入不属于上下文超限')
}
assert.deepEqual(providerContextLimit('Codex ran out of room in the model\'s context window.'), {})
assert.deepEqual(providerContextLimit('{"error":{"code":"context_length_exceeded"}}'), {})
assert.deepEqual(providerContextLimit('Your request exceeded k3-256k model token limit: 262144'), { model: 'k3-256k', tokens: 262144 })

const rawError = JSON.stringify({ error: {
  message: 'Your request exceeded k3-256k model token limit: 262144',
  type: 'invalid_authentication_error'
} })
const result = await renderEventStream([
  { sessionId: 'feedback', seq: 1, ts: 1000, type: 'user_message', payload: { text: '继续' } },
  { sessionId: 'feedback', seq: 2, ts: 2000, type: 'error', state: 'failed', payload: { message: rawError } },
  { sessionId: 'feedback', seq: 3, ts: 3000, type: 'turn_completed', state: 'failed', payload: {} }
], 'error', 'feedback', {
  setup: `
    import {Composer} from './src/renderer/components/Composer';
    window.feedbackErrors = [];
    window.addEventListener('error', event=>window.feedbackErrors.push(event.message));
    const api = window.uniagent;
    window.uniagent = new Proxy({listPresets:async()=>[]}, {get:(target,key)=>target[key] || api[key]});
    const host = document.body.appendChild(document.createElement('div'));
    window.feedbackCalls = [];
    window.feedbackConfigs = [];
    function Harness() {
      const [state, setState] = React.useState({compacting:true, preparingModel:false, providerSwitchCompacting:false});
      window.setPreparing = setState;
      return React.createElement(Composer, {
        sessionId:'feedback-composer', status:'idle', agent:{
          id:'codex', name:'Codex', adapter:'codex', installed:true, models:[
            {id:'gpt-fixture',label:'GPT fixture',efforts:['high']},
            {id:'kimi-fixture',label:'Kimi fixture',efforts:['high'],modelSource:{kind:'third-party',sourceId:'kimi'}}
          ],
          capabilities:{modelSelect:true, streaming:true, permissionModes:[]}
        }, config:{agentId:'codex', model:'gpt-fixture', permissionMode:'full-access'},
        onSend:async(text)=>window.feedbackCalls.push(text), onForceSend:async()=>window.feedbackCalls.push('force'),
        onInterrupt:()=>{}, onUpdateConfig:async(patch)=>{
          window.feedbackConfigs.push(patch); setState({compacting:true,preparingModel:true,providerSwitchCompacting:true});
          await new Promise(()=>{});
        }, onSetCollaborationMode:()=>{}, onRunNativeAction:()=>{},
        queue:[], onDequeue:()=>{}, onPromoteQueue:()=>{}, onEditQueueItem:()=>{},
        capabilities:{agentId:'codex',source:'provider-native',candidates:[],actions:{goal:false,review:false,plan:null},errors:[]},
        capabilitiesReady:true, contextUsed:0, onCompact:async()=>{}, canCompact:false,
        draftSeed:{sessionId:'feedback-composer',agentId:'codex',text:'保留的草稿',candidateIds:[],attachments:[],command:null}, ...state
      });
    }
    createRoot(host).render(React.createElement(Harness));
  `,
  inspect: `(async () => {
    const tick = () => new Promise(resolve=>setTimeout(resolve,30));
    const input = document.querySelector('.composer .markdown-editor-content');
    const send = document.querySelector('.composer-send-btn');
    if (!input || !send) throw new Error(JSON.stringify({errors:window.feedbackErrors,html:document.body.innerHTML.slice(-4000)}));
    const snapshot = () => ({
      disabled:send.disabled, editable:input.getAttribute('contenteditable')==='true', draft:input.textContent,
      notice:document.querySelector('.composer-preparing')?.textContent,
      calls:[...window.feedbackCalls], error:document.querySelector('.composer-send-error')?.textContent
    });
    const nativeCompaction=snapshot();
    window.setPreparing({compacting:true,preparingModel:true,providerSwitchCompacting:false}); await tick();
    const sameProvider=snapshot();
    window.setPreparing({compacting:true,preparingModel:true,providerSwitchCompacting:true}); await tick();
    const waiting=snapshot();
    send.click();
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}));
    await tick();
    const blocked=snapshot();
    window.setPreparing({compacting:false,preparingModel:true}); await tick();
    const switching=snapshot();
    window.setPreparing({compacting:false,preparingModel:false}); await tick();
    const ready=snapshot(); send.click(); await tick();
    const submitted=snapshot();
    const menu=document.querySelector('.sb-agent');
    menu.querySelector('summary').click(); await tick();
    menu.querySelector('.sb-sub-entry').click(); await tick();
    const menuBefore={open:menu.open,options:menu.querySelectorAll('[role="option"]').length};
    menu.querySelectorAll('[role="option"]')[1].click(); await tick();
    const menuDuringRequest={open:menu.open,submenu:!!menu.querySelector('[role="listbox"]'),
      configs:window.feedbackConfigs.length,notice:document.querySelector('.composer-preparing')?.textContent};
    const card=document.querySelector('.card.error');
    const error={title:card.querySelector('.card-head').textContent,
      message:card.querySelector('.error-msg').textContent,
      detail:card.querySelector('details')?.textContent,
      expanded:card.querySelector('details')?.open};
    return {nativeCompaction,sameProvider,waiting,blocked,switching,ready,submitted,error,menuBefore,menuDuringRequest};
  })()`
})

assert.equal(result.nativeCompaction.notice, undefined, 'Codex 自发或手动压缩只显示工作过程，不能显示输入框等待提示')
assert.equal(result.nativeCompaction.editable, true, '手动或自发压缩期间仍允许编辑草稿')
assert.equal(result.sameProvider.notice, undefined, '同 provider 切换不显示横幅')
assert.equal(result.waiting.disabled, true)
assert.equal(result.waiting.editable, false, '跨来源切换期间输入框直接禁用')
assert.equal(result.waiting.notice, undefined, '跨来源切换不再显示压缩横幅，屏蔽输入即可')
assert.equal(result.waiting.error, undefined, '正常等待不能显示为错误')
assert.deepEqual(result.blocked.calls, [], '按钮和快捷键都不能越过压缩锁')
assert.equal(result.blocked.draft, '保留的草稿')
assert.equal(result.switching.disabled, true, '压缩完成后仍等待目标模型连接完成')
assert.equal(result.switching.editable, false, '切换事务完成前输入保持禁用')
assert.equal(result.switching.notice, undefined, '无横幅，仅保留切换事务的发送锁')
assert.equal(result.ready.disabled, false)
assert.equal(result.ready.editable, true, '切换事务结束后输入恢复')
assert.equal(result.ready.draft, '保留的草稿')
assert.deepEqual(result.submitted.calls, ['保留的草稿'], '准备完成后只发送一次原草稿')
assert.equal(result.menuBefore.open, true)
assert.equal(result.menuBefore.options, 2)
assert.equal(result.menuDuringRequest.configs, 1)
assert.equal(result.menuDuringRequest.open, false, '选中模型后立即关闭主菜单，不等待配置请求完成')
assert.equal(result.menuDuringRequest.submenu, false, '模型子菜单同时消失')
assert.equal(result.menuDuringRequest.notice, undefined, '切换事务期间输入框上方无横幅')
assert.equal(result.error.title, '本次请求超过模型上下文上限')
assert.match(result.error.message, /k3-256k.*262,144/)
assert.doesNotMatch(result.error.message, /invalid_authentication|\{"error"/)
assert.match(result.error.detail, /invalid_authentication_error/, '保留服务端原始错误用于排查')
assert.equal(result.error.expanded, false)
console.log('context compaction feedback: waiting, draft, send guards and context limit errors passed')
