import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'weixin-settings', {
  setup: `
    import { AssistantWeixinBinding } from './src/renderer/components/AssistantWeixinBinding';
    let state = {configured:false,phase:'idle'};
    let listener = () => {};
    let resolveLogin;
    window.calls = [];
    const publish = value => { state=value; listener(); };
    window.uniagent = {
      getAssistantWeixin: async () => state,
      onAssistantWeixinChanged: callback => {listener=callback;return () => {};},
      loginAssistantWeixin: () => {
        window.calls.push('login'); publish({configured:false,phase:'connecting'});
        return new Promise(resolve => {resolveLogin=resolve;});
      },
      disconnectAssistantWeixin: async () => { window.calls.push('disconnect'); publish({configured:false,phase:'idle'}); return state; },
      verifyAssistantWeixin: async code => { window.calls.push('verify:'+code); publish({configured:true,phase:'connected',sessionId:'weixin-current'}); return state; }
    };
    window.finishLogin = value => { publish(value); resolveLogin(value); };
    window.finishStaleLogin = value => resolveLogin(value);
    window.addEventListener('uniagent-open-assistant-session', event => window.calls.push('open:'+event.detail));
    const host = document.body.appendChild(document.createElement('div'));
    host.className='settings-inner';host.style.width='760px';
    createRoot(host).render(React.createElement(AssistantWeixinBinding));
    window.weixinHost = host;
  `,
  inspect: `(async () => {
    const host=window.weixinHost;
    const settle=() => new Promise(resolve=>setTimeout(resolve,20));
    const wait=async predicate => {for(let i=0;i<100;i++){if(predicate())return;await settle();}throw new Error(host.textContent);};
    const button=text=>[...host.querySelectorAll('button')].find(node=>node.textContent===text);
    await wait(()=>button('扫码绑定'));
    button('扫码绑定').click();
    await wait(()=>button('取消绑定'));
    const canCancel=!button('取消绑定').disabled;
    button('取消绑定').click();
    await wait(()=>button('扫码绑定'));
    window.finishStaleLogin({configured:false,phase:'awaiting-scan',qrContent:'stale'});
    await settle();
    const staleQrIgnored=!host.querySelector('img');
    button('扫码绑定').click();
    await wait(()=>button('取消绑定'));
    window.finishLogin({configured:false,phase:'awaiting-code',qrContent:'local-qr-content'});
    await wait(()=>host.querySelector('input'));
    const input=host.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'123456');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    await settle();
    host.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await wait(()=>button('打开会话'));
    button('打开会话').click();
    return {calls:window.calls,canCancel,staleQrIgnored,connected:host.textContent.includes('已连接')};
  })()`
})
assert.equal(result.canCancel,true,'login network wait can be cancelled')
assert.equal(result.staleQrIgnored,true,'cancelled login cannot overwrite the newer state')
assert.equal(result.connected,true)
assert.deepEqual(result.calls,['login','disconnect','login','verify:123456','open:weixin-current'])
console.log('weixin-settings: binding, cancellation, stale responses, pairing submission and session navigation passed')
