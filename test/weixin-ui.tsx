import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WeixinBindingView } from '../src/renderer/components/AssistantWeixinBinding'
import { EventStream } from '../src/renderer/components/EventStream'
import { SessionList } from '../src/renderer/components/SessionList'
import { appendWeixinContext, splitWeixinContext, WEIXIN_CONTEXT_TEXT, type AssistantWeixinState } from '../src/shared/weixin'
import { renderEventStream } from './regression/render-event-stream.mjs'

const render = (state: AssistantWeixinState) => renderToStaticMarkup(createElement(WeixinBindingView, {
  state, onLogin() {}, onDisconnect() {}, onVerify() {}, onOpenSession() {}
}))
const idle = render({ configured: false, phase: 'idle' })
assert.match(idle,/扫码绑定/)
assert.doesNotMatch(idle,/打开会话|微信绑定二维码/)
const scanning = render({ configured: false, phase: 'awaiting-scan', qrContent: 'https://ilinkai.weixin.qq.com/test-qr' })
assert.match(scanning,/src="data:image\/gif;base64,/)
assert.match(scanning,/取消绑定/)
assert.doesNotMatch(scanning,/确认配对码/)
const verifying = render({ configured: false, phase: 'awaiting-code', qrContent: 'test-qr' })
assert.match(verifying,/aria-label="微信配对码"/)
assert.match(verifying,/确认配对码/)
assert.match(verifying,/<button[^>]*disabled=""[^>]*>确认配对码/,'empty pairing code cannot be submitted')
const connected = render({ configured: true, phase: 'connected', sessionId: 'weixin-1' })
assert.match(connected,/已连接/)
assert.match(connected,/打开会话/)
assert.match(connected,/断开/)
assert.doesNotMatch(connected,/扫码绑定|微信绑定二维码/)
const expired = render({ configured: true, phase: 'expired', message: '微信授权已失效' })
assert.match(expired,/重新扫码/)
assert.match(expired,/微信授权已失效/)
const reconnecting = render({ configured: true, phase: 'reconnecting' })
assert.match(reconnecting,/正在重连/)
assert.doesNotMatch(reconnecting,/扫码绑定/)

const input = appendWeixinContext('分析项目')
assert.equal(splitWeixinContext(input)?.text,'分析项目')
assert.equal(splitWeixinContext(input + '\n非末尾内容'),undefined)
assert.equal(splitWeixinContext('<uniagent_weixin_context>unknown</uniagent_weixin_context>'),undefined)
const bubble = (source: string) => renderToStaticMarkup(createElement(EventStream, { status: 'idle', events: [{ sessionId: 'weixin',seq: 1,ts: 1,type: 'user_message',payload: { source,text: input } }] }))
assert.match(bubble('weixin'), /<div class="bubble"><span>分析项目<\/span><\/div>/)
assert.match(bubble('weixin'),/user-weixin-source/)
assert.ok(bubble('weixin').includes(`title="${WEIXIN_CONTEXT_TEXT}"`))
assert.doesNotMatch(bubble('app'),/user-weixin-source/,'desktop text cannot acquire a trusted channel marker')
const snapshot = { assistantId: 'personal',soul: '',soulRevision: 1,workingRules: '',workingRulesRevision: 1 }
const session = (id: string, weixin: boolean) => ({ id,title: id,status: 'idle',createdAt: 1,origin: 'created',config: {agentId: 'codex',workdir: '',assistantSnapshot: snapshot,...(weixin ? {assistantChannel: 'weixin'} : {})} })
const noop = () => {}
const sidebar = renderToStaticMarkup(createElement(SessionList, {
  sessions: [session('weixin',true),session('feishu',false)],assistantPrivateSessionIds: ['weixin','feishu'],
  agents: [{id:'codex',name:'Codex',adapter:'codex',installed:true,capabilities:{},models:[],lifecycle:{availability:'available'}}],
  activeId: null,statusBySession: {},unreadBySession: {},onSelect: noop,onArchive: noop,onUnarchive: noop,onDelete: noop,onArchiveMany: noop,onDeleteMany: noop,onRename: noop,onPin: noop
} as any))
assert.match(sidebar,/助手session/)
const expanded = await renderEventStream([], 'idle', 'weixin-sidebar', {
  setup: `
    import {SessionList} from './src/renderer/components/SessionList';
    const api=window.uniagent;
    window.uniagent=new Proxy({listRequirements:async()=>[],listProjects:async()=>[],getUIPrefs:async()=>({})},{get:(target,key)=>target[key]||api[key]});
    const host=document.body.appendChild(document.createElement('div'));host.id='sidebar-fixture';
    const noop=()=>{};
    createRoot(host).render(React.createElement(SessionList,{
      sessions:${JSON.stringify([session('weixin',true),session('feishu',false)])},assistantPrivateSessionIds:['weixin','feishu'],
      agents:[{id:'codex',name:'Codex',adapter:'codex',installed:true,capabilities:{},models:[],lifecycle:{availability:'available'}}],
      activeId:null,statusBySession:{},unreadBySession:{},onSelect:noop,onArchive:noop,onUnarchive:noop,onDelete:noop,onArchiveMany:noop,onDeleteMany:noop,onRename:noop,onPin:noop
    }));`,
  inspect:`(async()=>{document.querySelector('#sidebar-fixture .sl-group-head').click();await new Promise(resolve=>setTimeout(resolve,30));return document.getElementById('sidebar-fixture').innerHTML})()`
})
assert.match(expanded,/aria-label="已绑定微信私聊"/)
assert.match(expanded,/aria-label="已绑定飞书私聊"/)
console.log('weixin-ui: login states, local QR, pairing code, session entry and source presentation passed')
