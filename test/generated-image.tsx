import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentDef, UAEvent } from '../src/shared/types.ts'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import type { AppServerRpc } from '../src/main/appServerTransport.ts'
import * as fileBrowser from '../src/main/fileBrowser.ts'
import { EventStream } from '../src/renderer/components/EventStream.tsx'

const SAVED_PATH = '/Users/test/.codex/generated_images/thread-1/image-1.png'

function codexAgent(): AgentDef {
  return {
    id: 'codex',
    name: 'Codex',
    bin: '/usr/bin/true',
    adapter: 'codex',
    icon: '',
    builtin: true,
    capabilities: {
      modelSelect: false,
      reasoningEffort: false,
      streaming: true,
      permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
    },
    models: [],
    installed: true
  }
}

class ImageTransport extends EventEmitter implements AppServerRpc {
  requests: Array<{ method: string; params: any }> = []

  async start(): Promise<void> {}
  notify(): void {}
  respond(): void {}
  interrupt(): void {}
  async dispose(): Promise<void> {}

  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'initialize') return {} as T
    if (method === 'config/read') return { config: {} } as T
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T
    if (method === 'thread/goal/get') return { goal: null } as T
    if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T
    if (method === 'thread/items/list') {
      return {
        data: [{
          turnId: 'turn-1',
          item: {
            id: 'image-1',
            type: 'imageGeneration',
            status: 'completed',
            revisedPrompt: 'dark path header',
            result: 'large-base64-that-must-not-enter-the-event-log',
            failure: null,
            savedPath: SAVED_PATH
          }
        }],
        nextCursor: null
      } as T
    }
    throw new Error(`unexpected method: ${method}`)
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for generated image reconciliation')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

async function runnerReconcilesGeneratedImage(): Promise<UAEvent> {
  const transport = new ImageTransport()
  const runner = new AppServerRunner(
    'session-1',
    { n: 0 },
    codexAgent(),
    { agentId: 'codex', workdir: '/repo', permissionMode: 'read-only' },
    undefined,
    undefined,
    () => transport
  )
  const events: UAEvent[] = []
  runner.on('event', (event) => events.push(event))

  try {
    await runner.startTurn('生成一张设计稿')
    transport.emit('notification', 'item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'image-1',
        type: 'imageGeneration',
        status: 'in_progress',
        revisedPrompt: null,
        result: ''
      }
    })

    const running = events.find((event) =>
      event.type === 'tool_call' && event.payload?.id === 'image-1'
    )
    assert.equal(running?.state, 'running')
    assert.equal(running?.payload?.name, 'image_generation')

    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], itemsView: 'summary', status: 'completed' }
    })

    await waitFor(() => events.some((event) =>
      event.type === 'tool_call' &&
      event.payload?.id === 'image-1' &&
      event.state === 'success'
    ))
    assert.deepEqual(
      transport.requests.find(({ method }) => method === 'thread/items/list')?.params,
      { threadId: 'thread-1', turnId: 'turn-1', sortDirection: 'asc', limit: 100 }
    )
    const completed = events.findLast((event) =>
      event.type === 'tool_call' && event.payload?.id === 'image-1'
    )!
    assert.equal(completed.payload.result.savedPath, SAVED_PATH)
    assert.equal(JSON.stringify(completed).includes('large-base64'), false)
    return completed
  } finally {
    runner.dispose()
  }
}

const completed = await runnerReconcilesGeneratedImage()
const markup = renderToStaticMarkup(createElement(EventStream, {
  events: [completed],
  status: 'running'
}))
assert.match(markup, /generated-image-card/)
assert.match(markup, /生成图片/)
assert.match(markup, /已完成/)
assert.doesNotMatch(markup, /savedPath|large-base64|工具调用/)

const isRecordedSessionImagePath = (fileBrowser as Record<string, unknown>)
  .isRecordedSessionImagePath
assert.equal(typeof isRecordedSessionImagePath, 'function')
const authorize = isRecordedSessionImagePath as (events: UAEvent[], path: string) => boolean
assert.equal(authorize([completed], SAVED_PATH), true)
assert.equal(authorize([{ ...completed, state: 'failed' }], SAVED_PATH), false)
assert.equal(authorize([completed], '/Users/test/private.png'), false)
assert.equal(authorize([{
  sessionId: 'session-1',
  seq: 2,
  ts: 2,
  type: 'user_message',
  payload: { attachments: [{ kind: 'image', path: '/Users/test/input.png', name: 'input.png' }] }
}], '/Users/test/input.png'), true)

const viewedImage: UAEvent = {
  sessionId: 'session-1', seq: 3, ts: 3, type: 'tool_call', state: 'success',
  payload: { id: 'view-1', name: 'view_image', input: { path: '/Users/test/viewed.png' } }
}
assert.equal(authorize([viewedImage], '/Users/test/viewed.png'), true, 'view_image may preview its recorded image')
assert.equal(authorize([viewedImage], '/Users/test/private.png'), false, 'view_image cannot authorize a different path')
for (const state of ['running', 'failed', 'cancelled'] as const) {
  assert.equal(authorize([{ ...viewedImage, state }], '/Users/test/viewed.png'), false)
}
assert.equal(authorize([{ ...viewedImage, payload: { ...viewedImage.payload, name: 'read_file' } }], '/Users/test/viewed.png'), false)
assert.equal(authorize([{ ...viewedImage, payload: { name: 'view_image', input: { path: null } } }], '/Users/test/viewed.png'), false)
assert.equal(authorize([{ ...viewedImage, payload: { name: 'viewImage', raw: { arguments: '{"path":"/Users/test/viewed.png"}' } } }], '/Users/test/viewed.png'), true)
assert.equal(authorize([{ ...viewedImage, payload: { name: 'view_image', raw: { arguments: '{invalid' } } }], '/Users/test/viewed.png'), false)

console.log('generated-image: ok')
