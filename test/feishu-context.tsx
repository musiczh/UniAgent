import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { appendFeishuContext, FEISHU_CONTEXT, FEISHU_CONTEXT_TEXT, splitFeishuContext } from '../src/shared/feishuContext'
import { EventStream } from '../src/renderer/components/EventStream'

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

function render(raw: string, source?: 'feishu' | 'app'): string {
  return renderToStaticMarkup(createElement(EventStream, {
    status: 'idle',
    events: [{ sessionId: 'feishu-display', seq: 0, ts: 1, type: 'user_message', payload: { text: raw, source } }]
  }))
}
const current = render(prompt, 'feishu')
assert.match(current, /<div class="bubble"><span>生成一张图片<\/span><\/div>/)
assert.ok(current.includes(`title="${FEISHU_CONTEXT_TEXT}"`), 'hover contains the complete approved context')
assert.doesNotMatch(current, /&lt;uniagent_feishu_context&gt;/)
assert.match(render(legacy), /user-feishu-source/, 'old transcripts receive the same source icon')
assert.doesNotMatch(render(previous, 'feishu'), /&lt;uniagent_feishu_context&gt;/, 'the previous context stays hidden after the reply rules change')
assert.doesNotMatch(render(text, 'app'), /user-feishu-source/)
assert.doesNotMatch(render(`${text}\n\n${FEISHU_CONTEXT}`, 'app'), /user-feishu-source/, 'desktop text cannot mark itself as a Feishu message')
console.log('feishu-context: ok')
