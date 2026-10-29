import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { listAgentHistory, loadSessionEvents } from '../src/main/history.ts'
import { EventStream } from '../src/renderer/components/EventStream'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const dir = await mkdtemp(join(tmpdir(), 'uniagent-grok-history-'))
const bin = join(dir, 'grok')
const logPath = join(dir, 'protocol.jsonl')
const statePath = join(dir, 'state.json')
const fixture = resolve(process.cwd(), 'test/fixtures/fake-grok.cjs')

try {
  await writeFile(statePath, JSON.stringify({
    sessions: [{
      sessionId: 'grok-history-1',
      title: 'History from Grok',
      cwd: dir,
      updatedAt: '2026-09-04T12:00:00.000Z',
      transcript: [
        { role: 'user', text: 'Inspect the repository' },
        { role: 'thought', text: 'Reading files' },
        { role: 'assistant', text: 'Repository inspected' }
      ]
    }]
  }), 'utf8')
  await writeFile(
    bin,
    `#!/usr/bin/env node
process.env.FAKE_GROK_LOG = ${JSON.stringify(logPath)}
process.env.FAKE_GROK_STATE = ${JSON.stringify(statePath)}
require(${JSON.stringify(fixture)})
`,
    'utf8'
  )
  await chmod(bin, 0o755)

  // Break caught: Grok is absent from the shared history source used by the
  // resume/import panel even though ACP session/list is available.
  const rows = await listAgentHistory('grok', bin)
  assert.deepEqual(rows, [{
    id: 'grok-history-1',
    title: 'History from Grok',
    cwd: dir,
    updatedAt: Date.parse('2026-09-04T12:00:00.000Z'),
    agentId: 'grok'
  }])

  // Break caught: imported/restored Grok sessions go through the Codex disk
  // parser instead of ACP session/load, producing an empty transcript.
  const loaded = await loadSessionEvents('grok', 'grok-history-1', bin, dir)
  assert.equal(loaded.cwd, dir)
  assert.equal(loaded.model, 'grok-4.6')
  assert.equal(loaded.contextWindow, undefined, 'private model metadata is ignored')
  assert.deepEqual(
    loaded.events.map((event) => [event.type, event.payload.text]),
    [
      ['user_message', 'Inspect the repository'],
      ['reasoning', 'Reading files'],
      ['agent_message', 'Repository inspected']
    ]
  )

  const log = (await readFile(logPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.ok(log.some((entry) => entry.kind === 'inbound' && entry.frame?.method === 'session/list'))
  assert.ok(log.some((entry) => entry.kind === 'inbound' && entry.frame?.method === 'session/load'))

  const historyId = 'grok-completed-history'
  const notification = (method: string, update: Record<string, unknown>, timestamp: number, sessionId = historyId) => ({
    method, params: { sessionId, update, _meta: { agentTimestampMs: timestamp } }
  })
  const chunk = (sessionUpdate: string, text: string, timestamp: number) => notification('session/update', { sessionUpdate, content: { type: 'text', text } }, timestamp)
  const completion = { sessionUpdate: 'turn_completed', prompt_id: 'first-turn', stop_reason: 'end_turn' }
  await writeFile(statePath, JSON.stringify({ sessions: [{ sessionId: historyId, cwd: dir, notifications: [
    chunk('user_message_chunk', 'First question', 1_000),
    chunk('agent_message_chunk', 'Inspecting files', 2_000),
    notification('session/update', { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', kind: 'read', status: 'completed' }, 3_000),
    chunk('agent_message_chunk', 'First final answer', 4_000),
    notification('_x.ai/session/update', completion, 4_500, 'another-session'),
    notification('_x.ai/session/update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Private text must be ignored' } }, 4_500),
    notification('_x.ai/session/update', completion, 5_000),
    notification('_x.ai/session/update', completion, 5_000),
    chunk('user_message_chunk', 'Second question', 6_000),
    chunk('agent_thought_chunk', 'Second reasoning', 7_000),
    chunk('agent_message_chunk', 'Second final answer', 8_000),
    notification('_x.ai/session/update', { ...completion, prompt_id: 'second-turn', stop_reason: 'cancelled' }, 9_000),
    chunk('user_message_chunk', 'Unfinished question', 10_000),
    chunk('agent_message_chunk', 'Unfinished reply', 11_000),
    notification('_x.ai/session/update', { ...completion, prompt_id: 'unfinished-turn', stop_reason: 'unknown' }, 12_000)
  ] }] }), 'utf8')
  const replayed = await loadSessionEvents('grok', historyId, bin, dir)
  assert.deepEqual(replayed.events.filter(event => event.type === 'turn_completed').map(event => [event.state, event.ts]), [
    ['success', 5_000], ['cancelled', 9_000]
  ], 'history retains valid completion boundaries once per prompt and ignores foreign or invalid completions')
  assert.equal(replayed.events[0].ts, 1_000, 'replay preserves the original timestamp for the processed duration')
  assert.ok(!replayed.events.some(event => event.payload.text?.includes('Private text must be ignored')))
  const markup = renderToStaticMarkup(createElement(EventStream, { sessionId: historyId, status: 'idle', events: replayed.events }))
  assert.equal((markup.match(/processed-fold closed/g) || []).length, 2, 'both completed historical turns default to collapsed')
  assert.match(markup, /First final answer/)
  assert.match(markup, /Second final answer/)
  assert.match(markup, /Unfinished reply/, 'a turn without a valid completion remains visible')

  // Break caught: replayed Grok history has only cumulative usage footers, so
  // the context meter restored at 100% for a session that was half full.
  const contextLog = join(dir, 'context-protocol.jsonl')
  const contextState = join(dir, 'context-state.json')
  const contextBin = join(dir, 'grok-context')
  await writeFile(contextState, JSON.stringify({ sessions: [{
    sessionId: 'grok-context-history',
    title: 'Context history',
    cwd: dir,
    updatedAt: '2026-09-04T12:00:00.000Z',
    transcript: [
      { role: 'user', text: 'How full is the context?' },
      { role: 'assistant', text: 'About half.' }
    ]
  }] }), 'utf8')
  await writeFile(contextBin, `#!/usr/bin/env node
process.env.FAKE_GROK_LOG = ${JSON.stringify(contextLog)}
process.env.FAKE_GROK_STATE = ${JSON.stringify(contextState)}
process.env.FAKE_GROK_SCENARIO = ${JSON.stringify(JSON.stringify({ native: true, contextSignals: { contextTokensUsed: 127539, contextWindowTokens: 256000 } }))}
require(${JSON.stringify(fixture)})
`, 'utf8')
  await chmod(contextBin, 0o755)
  const withContext = await loadSessionEvents('grok', 'grok-context-history', contextBin, dir)
  const contextEvent = withContext.events.at(-1)!
  assert.equal(contextEvent.type, 'system_notice')
  assert.equal(contextEvent.payload.kind, 'context')
  assert.deepEqual(contextEvent.payload.usage, {
    contextTokens: 127539,
    contextWindow: 256000,
    modelId: 'grok-4.7'
  }, 'Grok history restores the bounded last-call context from persisted signals, not cumulative usage')
  assert.deepEqual(
    withContext.events.slice(0, 2).map(event => [event.type, event.payload.text]),
    [['user_message', 'How full is the context?'], ['agent_message', 'About half.']],
    'context restoration must not disturb replayed conversation events'
  )
  const contextFrames = (await readFile(contextLog, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(entry => entry.kind === 'inbound')
  assert.ok(
    contextFrames.findIndex(entry => entry.frame?.method === '_x.ai/session/state') >
      contextFrames.findIndex(entry => entry.frame?.method === 'session/load'),
    'context signals must be read after the session is loaded'
  )

  // Break caught: replay metadata (the same bounded counter live updates carry)
  // was ignored, forcing an extra state probe on every history load.
  const replayLog = join(dir, 'replay-protocol.jsonl')
  const replayState = join(dir, 'replay-state.json')
  const replayBin = join(dir, 'grok-replay-context')
  await writeFile(replayState, JSON.stringify({ sessions: [{
    sessionId: 'grok-replay-context',
    title: 'Replay context',
    cwd: dir,
    updatedAt: '2026-09-04T12:00:00.000Z',
    notifications: [{
      method: 'session/update',
      params: {
        sessionId: 'grok-replay-context',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replayed with meta' } },
        _meta: { agentTimestampMs: 1_000, totalTokens: 7777 }
      }
    }]
  }] }), 'utf8')
  await writeFile(replayBin, `#!/usr/bin/env node
process.env.FAKE_GROK_LOG = ${JSON.stringify(replayLog)}
process.env.FAKE_GROK_STATE = ${JSON.stringify(replayState)}
process.env.FAKE_GROK_SCENARIO = ${JSON.stringify(JSON.stringify({ native: true }))}
require(${JSON.stringify(fixture)})
`, 'utf8')
  await chmod(replayBin, 0o755)
  const replayedContext = await loadSessionEvents('grok', 'grok-replay-context', replayBin, dir)
  const replayEvent = replayedContext.events.at(-1)!
  assert.equal(replayEvent.payload.kind, 'context')
  assert.deepEqual(replayEvent.payload.usage, {
    contextTokens: 7777,
    modelId: 'grok-4.7'
  }, 'replayed update metadata restores the bounded context without a state probe')
  const replayFrames = (await readFile(replayLog, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(entry => entry.kind === 'inbound')
  assert.equal(
    replayFrames.some(entry => entry.frame?.method === '_x.ai/session/state'),
    false,
    'replayed metadata must avoid the extra state request'
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('grok-history: ACP list and replay contracts ok')
