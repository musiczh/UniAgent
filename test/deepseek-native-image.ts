import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { loadDeepSeekHostImage } from '../src/main/deepseekHostHistory.ts'
import type { AgentDef, Session, UAEvent } from '../src/shared/types.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream, toolCallDetail } from '../src/renderer/components/EventStream.tsx'
import DOMPurify from 'dompurify'
Object.assign(DOMPurify,{sanitize:(html:string)=>html})

const root = await mkdtemp(join(tmpdir(), 'uniagent-native-image-'))
const agent: AgentDef = { id: 'deepseek', name: 'DeepSeek', bin: join(root, 'dsh'), adapter: 'deepseek',
  builtin: true, icon: '', installed: true, models: [], capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] } }
const host = new Orchestrator(id => id === 'deepseek' ? agent : undefined, new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'))
const session: Session = { id: 'local-image', nativeSessionId: 'native-image', title: 'Images', status: 'running', createdAt: 1,
  config: { agentId: 'deepseek', workdir: root } }
const selector = { eventSeq: 9, blockIndex: 1, toolResult: true }
const events: UAEvent[] = [{ sessionId: session.id, seq: 1, ts: 1, type: 'tool_call', state: 'success',
  payload: { id: 'image', name: 'image_generation', result: { nativeImage: selector } } }]
;(host as any).sessions.set(session.id, session)
;(host as any).events.set(session.id, events)
let reads = 0
const liveRunner = {
  readNativeImage: (request: any) => {
    reads++
    if (request.eventSeq !== 9 || request.blockIndex !== 1 || request.toolResult !== true) return null
    return 'data:image/png;base64,YWJj'
  },
  getSubAgentItems: (id: string) => id === 'owned-child' ? events.map(event => ({ ...event, sessionId: id })) : []
}
;(host as any).protocolRunners.set(session.id, liveRunner)
try {
  // A live turn resolves the transcript card through the runner that already owns the session.
  assert.equal(await host.readNativeImage(session.id, selector), 'data:image/png;base64,YWJj')
  assert.equal(session.status, 'running', 'on-demand attachment reads preserve the active turn')
  assert.equal(await host.readNativeImage(session.id, { ...selector, eventSeq: 10 }), null)
  assert.equal(await host.readNativeImage(session.id, { eventSeq: 9, blockIndex: 1 }), null)
  assert.equal(await host.readNativeImage('other-session', selector), null)
  // Kimi/Grok runners reject native-image selectors: that must be a miss, not a rejected IPC.
  ;(host as any).protocolRunners.set(session.id, { readNativeImage: () => { throw new Error('unsupported') } })
  assert.equal(await host.readNativeImage(session.id, selector), null)
  ;(host as any).protocolRunners.set(session.id, liveRunner)
  // Child-session images stay unsupported and never reach the runner.
  session.subagents = [{ agentThreadId: 'owned-child', status: 'completed', parentThreadId: session.nativeSessionId }]
  const readsBeforeChild = reads
  assert.equal(await host.readNativeImage(session.id, { ...selector, childSessionId: 'owned-child' }), null)
  assert.equal(reads, readsBeforeChild, 'child selectors never delegate to the runner')
  assert.equal(await host.readNativeImage(session.id, { ...selector, childSessionId: 'foreign-child' }), null)
  ;(host as any).rewinding.add(session.id)
  assert.equal(await host.readNativeImage(session.id, selector), null)

  // Restored history has no live runner: the shared Host connection reads the same block.
  const calls: Array<{ method: string; params: any }> = []
  const blocks = [
    { type: 'text', text: 'image/jpeg 2558x1639' },
    { type: 'image', attachment: { attachmentId: 'sha256:recorded' } }
  ]
  const fakeClient = { call: async (method: string, params: any) => {
    calls.push({ method, params })
    if (method === 'session/page') return { records: params.request.throughSeq === 9
      ? [{ type: 'event', event: { seq: 9, type: 'tool/result', data: { message: { content: blocks } } } }] : [] }
    if (method === 'session/attachment') {
      assert.equal(params.request.sessionId, 'native-image')
      assert.equal(params.request.attachmentId, 'sha256:recorded')
      return { attachment: { mediaType: 'image/jpeg' }, data: 'YWJj' }
    }
    throw new Error('unexpected ' + method)
  } }
  assert.equal(await loadDeepSeekHostImage('native-image', { eventSeq: 9, blockIndex: 1, toolResult: true }, fakeClient as any),
    'data:image/jpeg;base64,YWJj', 'a restored session resolves the recorded image block')
  assert.equal(await loadDeepSeekHostImage('native-image', { eventSeq: 10, blockIndex: 1, toolResult: true }, fakeClient as any), null)
  assert.equal(await loadDeepSeekHostImage('native-image', { eventSeq: 9, blockIndex: 0, toolResult: true }, fakeClient as any), null)
  assert.equal(await loadDeepSeekHostImage('native-image', { eventSeq: 9, blockIndex: 1 }, fakeClient as any), null,
    'assistant selectors never read tool results')
  assert.equal(await loadDeepSeekHostImage('native-image', { eventSeq: -1, blockIndex: 1 }, fakeClient as any), null)
  assert.ok(calls.every(call => ['session/page', 'session/attachment'].includes(call.method)),
    'image reads never create, resume or steer a native session')

  const markup = renderToStaticMarkup(createElement(EventStream, { events, status: 'idle' }))
  assert.match(markup, /generated-image-card/)
  assert.match(markup, /正在加载图片/)
  assert.doesNotMatch(markup, /nativeImage|eventSeq|blockIndex/)

  // A tool-returned image previews inside its own call row instead of becoming a
  // standalone card in the middle of the timeline.
  const readImageCall: UAEvent[] = [
    { sessionId: session.id, seq: 0, ts: 1, type: 'turn_started', payload: { id: 'turn-read', turnId: '1' } },
    { sessionId: session.id, seq: 1, ts: 2, type: 'tool_call', state: 'success', payload: {
      id: 'read-image', name: 'read_image', turnId: '1',
      input: { file_path: '/repo/docs/token-usage-hourly-mockup.png' },
      result: { output: 'image/jpeg 2201x1905', content: [{ type: 'text', text: 'image/jpeg 2201x1905' }, { type: 'image', attachment: { attachmentId: 'sha256:row' } }] },
      nativeImages: [{ eventSeq: 1265, blockIndex: 1, toolResult: true }]
    } }
  ]
  const rowMarkup = renderToStaticMarkup(createElement(EventStream, { events: readImageCall, status: 'running' }))
  assert.match(rowMarkup, /class="step-call-row step-call-image-row"/)
  assert.match(rowMarkup, /step-call-name">read_image</)
  assert.match(rowMarkup, /class="tool-image-thumbnail tool-image-placeholder"/, 'the row previews the native image')
  assert.match(rowMarkup, /file_path: &quot;\/repo\/docs\/token-usage-hourly-mockup.png&quot;/, 'read_image shows a short parameter, not raw JSON')
  assert.doesNotMatch(rowMarkup, /generated-image-card/, 'a tool image never renders a standalone card')
  assert.doesNotMatch(rowMarkup, /nativeImages|eventSeq|blockIndex/, 'selectors never leak into the row markup')

  // Restored turns still carry the old standalone image event; it is adopted back
  // onto the call that produced it so the reader sees the same row preview.
  const turnStart: UAEvent = { sessionId: session.id, seq: 0, ts: 1, type: 'turn_started', payload: { id: 'turn-legacy', turnId: '1' } }
  const legacyCall: UAEvent = { sessionId: session.id, seq: 1, ts: 2, type: 'tool_call', state: 'success', payload: {
    id: 'legacy-read', name: 'read_image', turnId: '1', nativeEventSeq: 1265,
    input: { file_path: '/repo/docs/token-usage-hourly-mockup.png' }, result: { output: 'image/jpeg 2201x1905' } } }
  const legacyImage: UAEvent = { sessionId: session.id, seq: 2, ts: 3, type: 'tool_call', state: 'success', payload: {
    id: 'deepseek-image-1265-1', name: 'image_generation', turnId: '1', nativeEventSeq: 1265,
    result: { status: 'completed', attachment: { attachmentId: 'sha256:legacy' },
      nativeImage: { eventSeq: 1265, blockIndex: 1, toolResult: true } } } }
  const legacyMarkup = renderToStaticMarkup(createElement(EventStream, { events: [turnStart, legacyCall, legacyImage], status: 'running' }))
  assert.match(legacyMarkup, /class="tool-image-thumbnail tool-image-placeholder"/, 'a restored tool image previews in its call row')
  assert.doesNotMatch(legacyMarkup, /generated-image-card/, 'a restored tool image no longer splits the timeline')
  const orphanMarkup = renderToStaticMarkup(createElement(EventStream, { events: [turnStart, {
    ...legacyImage, payload: { ...legacyImage.payload, nativeEventSeq: 9999,
      result: { ...legacyImage.payload.result, nativeImage: { eventSeq: 9999, blockIndex: 1, toolResult: true } } } }], status: 'running' }))
  assert.match(orphanMarkup, /generated-image-card/, 'an image whose call is gone keeps the fallback card')

  const completed:UAEvent[]=[
    {sessionId:session.id,seq:0,ts:1,type:'turn_started',payload:{id:'turn-images'}},
    {sessionId:session.id,seq:1,ts:2,type:'agent_message',state:'success',payload:{id:'final-text',text:'Native final reply'}},
    {...events[0],seq:2,ts:3,payload:{...events[0].payload,id:'assistant-image-after-text'}},
    {sessionId:session.id,seq:4,ts:5,type:'turn_completed',state:'success',payload:{id:'turn-images'}}
  ]
  const completedMarkup=renderToStaticMarkup(createElement(EventStream,{events:completed,status:'idle'}))
  assert.equal((completedMarkup.match(/class="card generated-image-card /g)||[]).length,1,'assistant images after final text remain visible')
  assert.equal(toolCallDetail({ input: { path: 'a.ts' }, result: 'File contents' }, 'success'), 'File contents')
} finally { await rm(root, { recursive: true, force: true }) }
console.log('DeepSeek native images: live runner delegation, restored-session reads and selector boundaries passed')
