import assert from 'node:assert/strict'
import { readKimiTranscript } from '../src/main/kimiHistory'
import { KimiWebRunner } from '../src/main/kimiWebRunner'

const turn = (turnId: string, state = 'completed') => ({ kind: 'turn', turnId, state })
async function read(pages: any[][], known = new Set(['t2'])) {
  let requests = 0
  const transport: any = { request: async () => {
    const items = pages[requests++]
    assert.ok(items, 'unexpected extra page')
    return { agent_id: 'main', items, has_more: requests < pages.length }
  } }
  const result = await readKimiTranscript(transport, 's', 'main', known)
  return { ...result, requests }
}
assert.equal((await read([[turn('t2'), turn('t3')], [turn('t1')]])).requests, 1)
const missing = await read([[turn('t4')], [turn('t1')]])
assert.equal(missing.requests, 2, 'missing boundary falls back to the complete transcript')
assert.deepEqual(missing.items.map(item => item.turnId), ['t1', 't4'])
assert.equal((await read([[turn('t2', 'running')], [turn('t1')]])).requests, 2, 'an active turn is not a completed boundary')
assert.equal((await read([[turn('t2'), { kind: 'marker', marker: 'compaction' }], [turn('t1')]])).requests, 2)
const runner: any = new KimiWebRunner('s', { n: 0 }, { id: 'kimi', adapter: 'kimi' } as any, { agentId: 'kimi', workdir: '/tmp' })
const boundaries: any[] = []
runner.runtime = { transcript: async (known: unknown) => { boundaries.push(known); return { items: [] } }, closeAndWait: async () => {} }
runner.baseline.add('t2')
const snapshot: any = { epoch: 'first', in_flight_turn: null, pending_approvals: [], pending_questions: [] }
await runner.recover(snapshot)
assert.ok(boundaries[0].has('t2'))
await runner.recover({ ...snapshot, epoch: 'restarted' })
assert.equal(boundaries[1], undefined, 'a changed server epoch forces full recovery')
await runner.disposeAndWait()
console.log('kimi-history-incremental: known boundary, missing boundary, active turns, compaction and restart passed')
