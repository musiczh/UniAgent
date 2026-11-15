import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
import type { UAEvent } from '../src/shared/types'

const sessionId = 'message-prompts'
const event = (seq: number, type: UAEvent['type'], payload: UAEvent['payload']): UAEvent => ({ sessionId, seq, ts: 1000 + seq, type, payload })
const wire = '请独立分配这一项新输入。先 router_query mode=bootstrap。\n\n本轮请求数据：\n{"input":"检查布局"}'
const events = [
  event(0, 'user_message', { text: '用户自己写的 router_query 与 [system] 原样保留' }),
  event(1, 'turn_completed', {}),
  event(2, 'user_message', { text: wire, displayText: '检查布局', appendedPrompt: '启动系统提示不属于此浮层' }),
  event(3, 'turn_completed', {}),
  event(4, 'user_message', { text: '图片路由指令', displayText: '', attachments: [{ kind: 'image', name: 'screen.png', path: '/fixture/screen.png' }] }),
  event(5, 'turn_completed', {}),
  event(6, 'goal_message', { text: '只有目标原文', displayText: '只有目标原文' }),
  event(7, 'turn_completed', {}),
  event(8, 'user_message', { text: '仍在运行' }),
  event(9, 'user_message', { text: '追加消息的附加指令', displayText: '用户追加原文', appendedToTurn: true }),
  event(10, 'agent_message', { text: '已收到' }),
]
const setup = `
  window.promptCopies=[];
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.promptCopies.push(text)}});
  window.uniagent=new Proxy({fsReadAttachmentImage:async()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII='},
    {get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
  const style=document.head.appendChild(document.createElement('style'));
  style.textContent='#root {display:flex;flex-direction:column;height:100vh}';
`
const result = await renderEventStream(events, 'running', sessionId, {
  setup,
  mouseEvents: [`(()=>{
    const row=document.querySelector('[data-source-seq="2"]');
    window.promptInitialOpacity=getComputedStyle(row.querySelector('.message-actions')).opacity;
    row.scrollIntoView();const r=row.querySelector('.bubble').getBoundingClientRect();
    return {type:'mouseMoved',x:r.left+r.width/2,y:r.top+r.height/2};
  })()`],
  inspect: `(async()=>{
    const tick=()=>new Promise(r=>setTimeout(r,170));await tick();
    const row=document.querySelector('[data-source-seq="2"]'),actions=row.querySelector('.message-actions');
    const trigger=row.querySelector('[aria-label="查看附加提示词"]');
    const image=document.querySelector('[data-source-seq="4"]');
    const initial={text:row.querySelector('.bubble').textContent.trim(),hidden:window.promptInitialOpacity,hover:getComputedStyle(actions).opacity,
      order:[...actions.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')),
      plain:document.querySelector('[data-source-seq="0"] .bubble').textContent.trim(),
      absent:![0,6,8].some(seq=>document.querySelector('[data-source-seq="'+seq+'"] [aria-label="查看附加提示词"]')),
      imageText:image.querySelector('.bubble .agent-md')?.textContent,image:!!image.querySelector('img'),imageButton:!!image.querySelector('[aria-label="查看附加提示词"]'),
      popupCount:document.querySelectorAll('.message-prompt-popover').length};
    if(!trigger)return {initial};
    const popup=()=>document.getElementById(trigger.getAttribute('aria-controls'));
    trigger.click();await tick();
    const panel=popup();if(!panel)throw Error('附加提示词浮层未打开：'+document.body.textContent);const rect=panel.getBoundingClientRect();
    const opened={text:panel.querySelector('pre').textContent,role:panel.getAttribute('role'),expanded:trigger.getAttribute('aria-expanded'),
      pinned:getComputedStyle(actions).opacity,body:panel.parentElement===document.body,
      bounded:rect.left>=11&&rect.right<=innerWidth-11&&rect.top>=11&&rect.bottom<=innerHeight-11,
      noSystem:!panel.textContent.includes('启动系统提示')};
    panel.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await tick();const internal=!!popup();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();
    const escape=!popup()&&document.activeElement===trigger;
    trigger.click();await tick();popup().querySelector('[aria-label="关闭附加提示词"]').click();await tick();
    const close=!popup()&&document.activeElement===trigger;
    trigger.click();await tick();document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await tick();const outside=!popup();
    trigger.click();await tick();trigger.click();await tick();const toggle=!popup()&&trigger.getAttribute('aria-expanded')==='false';
    row.querySelector('[aria-label="复制消息"]').click();
    const append=document.querySelector('.user-append-step');if(!append)throw Error('追加消息未渲染：'+document.body.textContent);
    const appendTrigger=append.querySelector('[aria-label="查看附加提示词"]');
    const appendText=append?.querySelector('.user-append-preview')?.textContent;
    appendTrigger?.click();await tick();const appendPanel=appendTrigger&&document.getElementById(appendTrigger.getAttribute('aria-controls'));
    return {initial,opened,internal,escape,close,outside,toggle,copies:window.promptCopies,appendText,
      appendPrompt:appendPanel?.querySelector('pre').textContent,appendStayedClosed:!append.querySelector('details').open,errors:window.__fixtureErrors};
  })()`,
})
assert.equal(result.initial.text, '检查布局', 'without comment cards the bubble still uses the original user text')
assert.equal(result.initial.hidden, '0')
assert.equal(result.initial.hover, '1', 'the actual pointer hover reveals the toolbar')
assert.deepEqual(result.initial.order.slice(0, 2), ['复制消息', '查看附加提示词'])
assert.equal(result.initial.plain, '用户自己写的 router_query 与 [system] 原样保留')
assert.equal(result.initial.absent, true, 'absent or identical display text adds no prompt button')
assert.equal(result.initial.imageText, '', 'an explicit empty original input must not fall back to the wire prompt')
assert.equal(result.initial.image, true)
assert.equal(result.initial.imageButton, true)
assert.equal(result.initial.popupCount, 0)
assert.deepEqual(result.opened, { text: wire, role: 'dialog', expanded: 'true', pinned: '1', body: true, bounded: true, noSystem: true })
for (const key of ['internal', 'escape', 'close', 'outside', 'toggle', 'appendStayedClosed']) assert.equal(result[key], true, key)
assert.deepEqual(result.copies, ['检查布局'], 'copy excludes the host-injected instructions')
assert.equal(result.appendText, '用户追加原文')
assert.equal(result.appendPrompt, '追加消息的附加指令')
assert.deepEqual(result.errors, [])

const narrow = await renderEventStream([event(0, 'user_message', { text: '<script>window.__unsafe=true</script>\n' + '长指令'.repeat(2000), displayText: '图片说明' })], 'idle', sessionId, {
  setup,
  screenshot: { path: process.cwd() + '/out/test/user-message-prompts-narrow.png', width: 360, height: 320 },
  inspect: `(async()=>{
    const trigger=document.querySelector('[aria-label="查看附加提示词"]');if(!trigger)return {};
    trigger.click();await new Promise(r=>setTimeout(r,80));
    const panel=document.querySelector('.message-prompt-popover'),body=panel.querySelector('pre'),r=panel.getBoundingClientRect();
    body.scrollTop=body.scrollHeight;await new Promise(r=>setTimeout(r,20));
    return {bounded:r.left>=11&&r.right<=innerWidth-11&&r.top>=11&&r.bottom<=innerHeight-11,
      scroll:body.scrollTop>0,unsafe:window.__unsafe===true||!!panel.querySelector('script'),
      intact:body.textContent.length===${JSON.stringify('<script>window.__unsafe=true</script>\n'.length + '长指令'.repeat(2000).length)},errors:window.__fixtureErrors};
  })()`,
})
assert.deepEqual(narrow, { bounded: true, scroll: true, unsafe: false, intact: true, errors: [] })
console.log('PASS user message prompts: original text, images, hover action, appended turns, copy, dismissal, narrow layout and inert full prompt')
