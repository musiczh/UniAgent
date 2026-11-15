import assert from 'node:assert/strict'
import { appendFeishuContext, FEISHU_CONTEXT, FEISHU_CONTEXT_TEXT, splitFeishuContext } from '../src/shared/feishuContext'
import { renderEventStream } from './regression/render-event-stream.mjs'

const text = '生成一张图片'
const prompt = appendFeishuContext(text)
assert.deepEqual(splitFeishuContext(prompt), { text, context: FEISHU_CONTEXT_TEXT })
assert.equal(splitFeishuContext('普通桌面消息'), undefined)
assert.equal(splitFeishuContext(`${prompt}\n这不是消息末尾的 context`), undefined)
assert.equal(splitFeishuContext('<uniagent_feishu_context>\nunknown\n</uniagent_feishu_context>'), undefined)
assert.equal(splitFeishuContext(appendFeishuContext(''))?.text, '[图片]')
assert.equal(splitFeishuContext(appendFeishuContext(prompt))?.text, prompt, 'only the final suffix is removed')

const legacyBody = '{"source":"feishu","chat_id":"oc_example","user_open_id":"ou_example","bot_app_id":"cli_example"}\n旧版完整提示'
const legacy = `${text}\n\n<uniagent_feishu_context>\n${legacyBody}\n</uniagent_feishu_context>`
assert.deepEqual(splitFeishuContext(legacy), { text, context: legacyBody })
const previousBody = '本条消息来自飞书；图片、文件用 send_to_feishu 回传当前话题，不带此context的消息为非飞书发送消息。'
const previous = `${text}\n\n<uniagent_feishu_context>\n${previousBody}\n</uniagent_feishu_context>`
assert.deepEqual(splitFeishuContext(previous), { text, context: previousBody })

const cases = [[prompt, 'feishu'], [legacy, undefined], [previous, 'feishu'], [text, 'app'], [`${text}\n\n${FEISHU_CONTEXT}`, 'app']]
const rendered = await renderEventStream([], 'idle', 'feishu-display', {
  setup: `
    window.feishuContextHosts = ${JSON.stringify(cases)}.map(([text,source],index) => {
      const host = document.body.appendChild(document.createElement('div'));
      createRoot(host).render(React.createElement(EventStream,{status:'idle',events:[{sessionId:'feishu-'+index,seq:0,ts:1,type:'user_message',payload:{text,source}}]}));
      return host;
    });
  `,
  inspect: `(async()=>{
    for(let i=0;i<100;i++){
      if(window.feishuContextHosts.every(host=>host.querySelector('.bubble')))return window.feishuContextHosts.map(host=>({html:host.innerHTML,text:host.querySelector('.bubble').textContent.trim(),title:host.querySelector('.user-feishu-source')?.getAttribute('title')}));
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('Feishu context rendering timeout');
  })()`
})
const [current, renderedLegacy, renderedPrevious, desktop, desktopWrapper] = rendered
assert.equal(current.text, text, 'the bubble shows only the original message through the current Markdown renderer')
assert.equal(current.title, FEISHU_CONTEXT_TEXT, 'hover contains the complete approved context')
assert.doesNotMatch(current.html, /&lt;uniagent_feishu_context&gt;/)
assert.match(renderedLegacy.html, /user-feishu-source/, 'old transcripts receive the same source icon')
assert.doesNotMatch(renderedPrevious.html, /&lt;uniagent_feishu_context&gt;/, 'the previous context stays hidden after the reply rules change')
assert.doesNotMatch(desktop.html, /user-feishu-source/)
assert.doesNotMatch(desktopWrapper.html, /user-feishu-source/, 'desktop text cannot mark itself as a Feishu message')
console.log('feishu-context: ok')
