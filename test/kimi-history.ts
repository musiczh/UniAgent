import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadKimiSessionEvents } from '../src/main/grokACPRunner.ts'
import { hydrateSubmittedUserMessages, submittedTextHash } from '../src/main/submittedUserMessages.ts'
import type { UAEvent } from '../src/shared/types.ts'
import { EventStream } from '../src/renderer/components/EventStream'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const root = await mkdtemp(join(tmpdir(), 'uniagent-kimi-history-'))
const bin = join(root, 'kimi')
const log = join(root, 'requests.jsonl')
const fixtureFile = join(root, 'history.json')
const env = { KIMI_CODE_HOME: root, KIMI_HISTORY_FIXTURE: fixtureFile, FAKE_KIMI_LOG: log }
await writeFile(bin, `#!/usr/bin/env node\nrequire(${JSON.stringify(resolve('test/fixtures/fake-kimi-history.cjs'))})\n`)
await chmod(bin, 0o755)
const date = (seconds: number) => new Date(1_790_000_000_000 + seconds * 1000).toISOString()
const turn = (id: string, prompt: string, frames: any[] = [], extra: any = {}) => ({
  kind: 'turn', turnId: id, origin: { kind: 'user' }, prompt, state: 'completed',
  startedAt: date(0), endedAt: date(12),
  steps: [{ stepId: id + '.1', state: 'completed', startedAt: date(1), endedAt: date(11), frames }], ...extra
})
const text = (id: string, value: string) => ({ kind: 'text', role: 'assistant', frameId: id, text: value })
/** Mirrors the caption Kimi folds into `turn.prompt` for every compressed image. */
const imageCaption = (name: string) => `<system>Image compressed to fit model limits: original 2560x1640 image/png (469 KB) -> sent 2000x1281 image/png (524 KB). Fine detail may be lost. The uncompressed original is saved at "/tmp/${name}.png"; if you need fine detail (e.g. small text), call ReadMediaFile on that path with the region parameter (original-pixel coordinates) to view a crop at full fidelity.</system>`
const page = (items: any[], more = false) => ({ agent_id: 'main', items, has_more: more, meta: { agent: { model: 'kimi-code/k3-256k', thinkingEffort: 'high' } } })
const fixture = {
  session: { id: 'kimi-existing', metadata: { cwd: root }, agent_config: { model: '' } },
  pages: {
    latest: page([
      turn('t2', '<notification>Background process completed</notification>', [
        text('t2.reply', 'Read the background result'),
        { kind: 'notice', frameId: 't2.error', level: 'error', message: 'quota exceeded' }
      ], { origin: { kind: 'task', taskId: 'bash-1' }, state: 'failed', error: 'quota exceeded' }),
      turn('t3', '继续', [text('t3.reply', 'Continuing')], { state: 'running', endedAt: undefined }),
      turn('t4', imageCaption('queued'), [], { state: 'queued', endedAt: undefined, attachmentIds: ['image-1'] })
    ], true),
    t2: page([
      turn('t1', '确认', [
        { kind: 'thinking', frameId: 't1.think', text: 'Before compaction' },
        { kind: 'tool', frameId: 't1.tool', toolCallId: 'read-1', name: 'Read', state: 'done', input: { path: '/fixture' }, output: 'file contents' },
        { kind: 'text', role: 'user', frameId: 't1.task', taskId: 'bash-1', text: '<notification>internal result</notification>' },
        { kind: 'text', role: 'user', frameId: 't1.steer', origin: { kind: 'user' }, text: '补充说明' + imageCaption('steered') },
        text('t1.reply', 'Answer before compaction')
      ]),
      { kind: 'marker', marker: 'compaction', markerId: 'm1', at: date(12), payload: { summary: 'INTERNAL COMPACTION SUMMARY' } },
      { kind: 'marker', marker: 'injection', markerId: 'm2', payload: { text: '<system-reminder>internal reminder</system-reminder>' } }
    ], true),
    t1: page([turn('t0', '请解释 <system-reminder> 这个标签' + imageCaption('first'), [], { state: 'cancelled' })])
  } as Record<string, any>
}
const readLog = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
const load = async (value: any = fixture) => {
  await writeFile(fixtureFile, JSON.stringify(value))
  return loadKimiSessionEvents('kimi-existing', bin, root, env)
}
try {
  const loaded = await load()
  const users = loaded.events.filter(event => event.type === 'user_message')
  assert.deepEqual(users.map(event => event.payload.text), ['请解释 <system-reminder> 这个标签', '确认', '补充说明', '继续', ''], 'restore real user inputs individually, never internal context or task prompts')
  assert.ok(users.every(event => !String(event.payload.text).includes('Image compressed to fit model limits')), 'image compression captions are model-only and never become user text')
  assert.equal(users[2].payload.appendedToTurn, true, 'steered user text remains inside its native turn')
  // The local submission record is keyed by the visible text hash. Once the
  // caption is removed, that record re-attaches the pasted image on restart.
  const firstIndex = loaded.events.indexOf(users[0])
  const steeredIndex = loaded.events.indexOf(users[2])
  const image = { kind: 'image' as const, path: join(root, 'first.png'), name: 'first.png', mime: 'image/png' }
  const steeredImage = { kind: 'image' as const, path: join(root, 'steered.png'), name: 'steered.png', mime: 'image/png' }
  const hydrated = hydrateSubmittedUserMessages(loaded.events as UAEvent[], [{
    type: 'user_message', userOrdinal: 0, textHash: submittedTextHash(users[0].payload.text), acceptedAt: users[0].ts, attachments: [image]
  }, {
    type: 'user_message', userOrdinal: 2, textHash: submittedTextHash(users[2].payload.text), acceptedAt: users[2].ts, attachments: [steeredImage]
  }])
  assert.deepEqual(hydrated[firstIndex].payload.attachments, [image], 'a restored image message re-hydrates its local attachment')
  assert.equal(hydrated[firstIndex].payload.text, '请解释 <system-reminder> 这个标签', 'the caption never survives into the re-hydrated bubble')
  assert.deepEqual(hydrated[steeredIndex].payload.attachments, [steeredImage], 'a steered image inside a running turn also re-hydrates')
  assert.equal(hydrated[steeredIndex].payload.text, '补充说明', 'the caption is stripped from steered user frames too')
  assert.ok(loaded.events.some(event => event.type === 'agent_message' && event.payload.text === 'Answer before compaction'))
  assert.ok(loaded.events.some(event => event.type === 'reasoning' && event.payload.text === 'Before compaction'))
  assert.equal(loaded.events.find(event => event.type === 'tool_call')?.payload.output, 'file contents')
  const ends = loaded.events.filter(event => event.type === 'turn_completed')
  assert.deepEqual(ends.map(event => event.state), ['cancelled', 'success', 'failed'], 'running and queued turns must not be fabricated as complete')
  assert.equal(ends[0].ts - users[0].ts, 12_000, 'native elapsed time survives restore')
  assert.equal(loaded.events.filter(event => event.type === 'error').length, 1, 'native error is not duplicated by turn.error')
  assert.equal(new Set(loaded.events.map(event => event.type + ':' + event.payload.id)).size, loaded.events.length)
  assert.deepEqual(loaded.events.map(event => event.seq), loaded.events.map((_, index) => index))
  assert.equal(loaded.cwd, root)
  assert.equal(loaded.model, 'kimi-code/k3-256k')
  assert.equal(loaded.kimiThinking, 'high')
  const markup = renderToStaticMarkup(createElement(EventStream, { sessionId: 'restored', status: 'idle', events: loaded.events }))
  assert.match(markup, /processed-fold closed/, 'completed work defaults to collapsed after history restore')
  assert.match(markup, /Answer before compaction/, 'pre-compaction reply remains visible')
  assert.doesNotMatch(markup, /INTERNAL COMPACTION SUMMARY|internal reminder|internal result|Background process completed|Image compressed to fit model limits/, 'internal context never leaks into the rendered conversation')
  const requests = (await readLog()).filter(row => row.kind === 'web-request')
  assert.ok(requests.every(row => row.method === 'GET'), 'history must not resume, prompt or reconfigure the native session')
  assert.deepEqual(requests.filter(row => row.path.endsWith('/transcript')).map(row => row.before), [null, 't2', 't1'])
  assert.ok(!(await readLog()).some(row => row.kind === 'acp-request'), 'history no longer uses lossy ACP session/load')

  assert.deepEqual((await load({ ...fixture, pages: { latest: page([]) } })).events, [])
  await assert.rejects(loadKimiSessionEvents('', bin, root, env), /sessionId 无效/)
  await assert.rejects(loadKimiSessionEvents('bad\0id', bin, root, env), /sessionId 无效/)
  await assert.rejects(load({ ...fixture, pages: { latest: { ...page([]), items: null } } }), /transcript_invalid/)
  await assert.rejects(load({ ...fixture, pages: { latest: { ...page([]), agent_id: 'foreign' } } }), /transcript_invalid/)
  await assert.rejects(load({ ...fixture, pages: { latest: page([], true) } }), /transcript_cursor/)
  await assert.rejects(load({ ...fixture, pages: { latest: page([turn('t1', 'one')], true), t1: page([turn('t1', 'one')], true) } }), /transcript_cursor/)
  await assert.rejects(load({ ...fixture, pages: { latest: page([turn('t1', 'one')], true), t1: { code: 50001 } } }), /kimi_web_/)
  await assert.rejects(load({ ...fixture, session: { ...fixture.session, id: 'foreign' } }), /session_identity/)
  for (const row of (await readLog()).filter(row => row.kind === 'web-start')) {
    assert.throws(() => process.kill(row.pid, 0), /ESRCH/, 'every history server exits even after invalid pages')
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log('kimi-history: full transcript, origins, pagination, native boundaries and read-only lifecycle passed')
