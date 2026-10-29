import assert from 'node:assert/strict'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekEventStore } from '../src/main/deepseekEventStore'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'

const directory = await mkdtemp(join(tmpdir(), 'ua-history-performance-'))
const store = new SessionStore(join(directory, 'sessions.json'))
const history = new DeepSeekEventStore(join(directory, 'deepseek', 'events'))
const host = new Orchestrator(() => undefined, store)
let timer: ReturnType<typeof setInterval> | undefined
try {
  // Exercise legacy, uncoalesced files. Fixture generation is outside the measured load.
  await history.replace('s_fixture', [])
  const file = await open(join(directory, 'deepseek', 'events', 's_fixture.jsonl'), 'a')
  try {
    for (let seq = 0; seq < 4096; seq++) await file.write(JSON.stringify({ sessionId: 's_fixture', seq, ts: seq,
      type: 'agent_message', state: 'running', payload: { id: 'reply', text: 'x'.repeat(8192) + seq } }) + '\n')
  } finally { await file.close() }
  let ticks = 0
  timer = setInterval(() => { ticks++ }, 1)
  const loaded = await history.load('s_fixture')
  clearInterval(timer)
  assert.ok(ticks > 0, 'legacy JSON parsing must allow the main event loop to keep responding')
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].seq, 4095)
  store.saveOrThrow([{ id: 's_fixture', title: 'fixture', config: { agentId: 'deepseek', workdir: directory },
    status: 'idle', createdAt: 1, updatedAt: 1, archived: true }])
  await host.loadPersisted()
  assert.deepEqual((host as any).events.get('s_fixture'), [], 'archived startup history is not retained in the main cache')
  assert.equal((host as any).seqRefs.get('s_fixture').n, 4096, 'discarding a cache must preserve the sequence watermark')
  assert.equal((await host.getEvents('s_fixture'))[0].seq, 4095)
  host.setArchived('s_fixture', true)
  await host.flushSessionLogs()
  assert.deepEqual((host as any).events.get('s_fixture'), [], 'archive releases only after pending persistence is flushed')
  host.setArchived('s_fixture', false)
  assert.equal((await host.getEvents('s_fixture'))[0].payload.text, loaded[0].payload.text)
  ;(host as any).record('s_fixture', { type: 'system_notice', payload: { text: 'after resume' } })
  assert.equal((await host.getEvents('s_fixture')).at(-1)!.seq, 4096)
  await host.flushSessionLogs()
  assert.equal((await history.load('s_fixture')).at(-1)!.payload.text, 'after resume')
  const cached = (host as any).events.get('s_fixture')
  host.setArchived('s_fixture', true)
  host.setArchived('s_fixture', false)
  await host.flushSessionLogs()
  assert.equal((host as any).events.get('s_fixture'), cached, 'a fast restore cancels the deferred archive eviction')
  host.setArchived('s_fixture', true)
  await host.flushSessionLogs()
  const reading = host.getEvents('s_fixture')
  await host.deleteSession('s_fixture')
  assert.deepEqual(await reading, [], 'a late history read cannot resurrect a deleted session')
  assert.equal((host as any).events.has('s_fixture'), false)
} finally {
  if (timer) clearInterval(timer)
  await Promise.allSettled([history.close(), host.closeSessionLogs()])
  await rm(directory, { recursive: true, force: true })
}
console.log('deepseek-history-performance: background legacy parsing, archived cache release and sequence-safe restore passed')
