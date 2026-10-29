import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ZCodeWireAssembler, zcodeCrc32 } from '../src/main/zcode/wireAssembler'
import { applyZCodeFrame, projectZCodeEvents, findObservedCommand } from '../src/main/zcode/projection'
import { ZCodeConnection } from '../src/main/zcode/connection'
import { zcodePayloadHash, sanitizeZCodeState } from '../src/main/zcode/store'
import type { ZCodeAssembledFrame, ZCodeSnapshot } from '../src/main/zcode/protocol'

const read = (name: string) => JSON.parse(readFileSync(join('test/fixtures/zcode', name), 'utf8'))
const initial: ZCodeAssembledFrame = read('native/snapshot.logical.json')
const assembler = new ZCodeWireAssembler()
const physical = read('local-contract/physical-frames.json')
const snapshots = new Map<string, ZCodeSnapshot>()
let assembledCount = 0
for (const notification of physical) {
  for (const event of assembler.accept(notification.params)) {
    assert.equal(event.kind, 'frame', JSON.stringify(event))
    if (event.kind !== 'frame') continue
    assembledCount++
    const result = applyZCodeFrame(snapshots.get(event.frame.topic), event)
    assert.notEqual(result.kind, 'resync', JSON.stringify(result))
    if (result.kind !== 'resync') snapshots.set(event.frame.topic, result.state)
  }
}
assert.ok(assembledCount > 10)
assert.ok([...snapshots.values()].some(state => state.rows.window.some(row => row.kind === 'turnHeader' && row.state === 'completedInterrupted')))

const wire = (delivery: ZCodeAssembledFrame) => ({ wireVersion: 3, kind: 'complete', topic: delivery.frame.topic,
  subscriptionId: delivery.frame.subscriptionId, ...delivery })
const fragment = (delivery: ZCodeAssembledFrame) => {
  const bytes = Buffer.from(JSON.stringify(delivery.frame))
  const half = Math.floor(bytes.length / 2)
  return [bytes.subarray(0, half), bytes.subarray(half)].map((part, index) => ({ ...wire(delivery), kind: 'fragment', frame: undefined,
    fragmentCount: 2, fragmentIndex: index, logicalBytes: bytes.length, checksum: { algorithm: 'crc32', value: zcodeCrc32(bytes) }, dataBase64: part.toString('base64') }))
}
const reorder = new ZCodeWireAssembler()
const parts = fragment(initial)
assert.deepEqual(reorder.accept(parts[1]), [])
assert.deepEqual(reorder.accept(parts[1]), [])
assert.equal(reorder.accept(parts[0])[0]?.kind, 'frame')
assert.deepEqual(reorder.accept(parts[0]), [])
const replace = new ZCodeWireAssembler()
replace.accept(parts[0], 0)
const recovery = { ...initial, deliveryKind: 'recovery' as const, logicalFrameId: 'recovery', logicalFrameOrdinal: 2 }
assert.equal(replace.accept(wire(recovery), 1)[0]?.kind, 'frame')
assert.deepEqual(replace.accept(parts[1], 2), [])
const corrupt = new ZCodeWireAssembler()
corrupt.accept(parts[0])
assert.equal(corrupt.accept({ ...parts[1], dataBase64: Buffer.from('bad').toString('base64') })[0]?.kind, 'fault')
assert.equal(corrupt.accept(wire(recovery))[0]?.kind, 'frame')
const expiry = new ZCodeWireAssembler()
expiry.accept(parts[0], 0)
assert.equal(expiry.expire(30_000)[0]?.reason, 'assembly_timeout')

const state = structuredClone(initial.frame.payload.kind === 'snapshot' ? initial.frame.payload.snapshot : snapshots.values().next().value!)
state.seq = 5
assert.equal(applyZCodeFrame(state, recovery).kind, 'applied')
const delta = (fromSeq: number, toSeq: number, deltas: any[]): ZCodeAssembledFrame => ({ ...recovery,
  frame: { ...initial.frame, fromSeq, toSeq, payload: { kind: 'deltas', deltas } } })
assert.equal(applyZCodeFrame(state, delta(6, 7, [])).kind, 'resync')
assert.equal(applyZCodeFrame(state, delta(4, 5, [])).kind, 'duplicate')
const row = { rowId: 1, turnId: 'turn', createdAt: 1, createdAtSeq: 6, kind: 'assistantText', text: '中', state: 'streaming' }
const updated = applyZCodeFrame(state, delta(5, 6, [{ op: 'row.appended', row }, { op: 'row.delta', rowId: 1, path: 'text', append: '文' }]))
assert.equal(updated.kind, 'applied')
if (updated.kind === 'applied') {
  assert.equal(updated.state.rows.window[0].text, '中文')
  assert.equal(state.rows.window.length, 0)
  let sequence = 0
  assert.equal(projectZCodeEvents(updated.state, { sessionId: 'local', generation: 1, nextSeq: () => ++sequence })[0].payload.text, '中文')
  assert.equal(applyZCodeFrame(updated.state, delta(6, 7, [{ op: 'state.updated', patch: { config: { mode: 'yolo' } } }])).kind, 'applied')
}
assert.equal(findObservedCommand(state, 'unknown'), undefined)
const longState = structuredClone(state)
longState.rows = { firstRowId: 1, totalCount: 1000, window: Array.from({ length: 1000 }, (_, index) => ({
  ...row, rowId: index + 1, state: 'complete' })) }
const bounded = applyZCodeFrame(longState, delta(5, 6, [{ op: 'row.appended', row: { ...row, rowId: 1001 } }]))
assert.equal(bounded.kind, 'applied')
if (bounded.kind === 'applied') {
  assert.equal(bounded.state.rows.window.length, 1000); assert.equal(bounded.state.rows.window[0].rowId, 2)
  assert.equal(bounded.state.rows.firstRowId, 1); assert.equal(bounded.state.rows.totalCount, 1001); assert.equal(bounded.state.seq, 6)
}
const submission = { text: 'hello', modelSelection: { providerId: 'fixture', modelId: 'fixture' }, mode: 'build', planEnabled: false }
const receipt = { schemaVersion: 1, dataRootId: 'data', workspaceKey: 'workspace', runtimeFingerprint: 'runtime', deliveries: [{
  queueItemId: 'queue', commandId: 'command', phase: 'uncertain', payloadHash: zcodePayloadHash(submission), issuedAt: 1, submission }] }
assert.equal(sanitizeZCodeState(receipt)?.deliveries[0].phase, 'uncertain')
assert.equal(sanitizeZCodeState({ ...receipt, deliveries: [{ ...receipt.deliveries[0], submission: { ...submission, text: 'tampered' } }] }), undefined)

// This child is a local fixture server; no ZCode runtime, account or model is used.
const root = mkdtempSync(join(tmpdir(), 'uzc-adapter-'))
try {
  const fixture = join(root, 'server.cjs')
  const startup = JSON.stringify({ method: 'startup/storageState', params: { phase: 'ready' } })
  const snapshotWire = JSON.stringify({ method: 'v4/conversation/frame', params: wire(initial) })
  writeFileSync(fixture, `const readline = require('node:readline'); process.stdout.write(${JSON.stringify(startup + '\n')});
readline.createInterface({input:process.stdin}).on('line', line => { const m = JSON.parse(line);
 if (m.method === 'subscribe') { const bytes = Buffer.from(JSON.stringify({id:m.id,result:{text:'中文'}})+'\\n'+${JSON.stringify(snapshotWire + '\n')});
 const split = bytes.indexOf(Buffer.from('中'))+1; process.stdout.write(bytes.subarray(0,split)); setImmediate(()=>process.stdout.write(bytes.subarray(split))); }
 else if (m.method === 'callback') { process.stdout.write(JSON.stringify({id:'reverse',method:'preferences',params:{scope:'runtime-materialization'}})+'\\n'); }
 else if(m.id==='reverse')process.stdout.write(JSON.stringify({id:'ua-zcode-2',result:m.result})+'\\n');
}); process.stdin.on('end',()=>process.exit(0));`)
  const connection = new ZCodeConnection({ executable: process.execPath, args: [fixture], cwd: root, env: { PATH: process.env.PATH } })
  connection.on('request', (id, method) => { assert.equal(method, 'preferences'); connection.respond(id, { ready: true }) })
  await connection.start()
  try {
    assert.deepEqual(await connection.request('subscribe', {}), { text: '中文' })
    // The promise continuation runs after all complete lines in the chunk have been dispatched.
    assert.equal(connection.drainFrames(initial.frame.topic, initial.frame.subscriptionId).length, 1)
    assert.deepEqual(await connection.request('callback', {}), { ready: true })
  } finally { await connection.close() }
} finally { rmSync(root, { recursive: true, force: true }) }
console.log(JSON.stringify({ result: 'zcode-adapter-check-passed', assembledCount, nativeSessions: snapshots.size }))
