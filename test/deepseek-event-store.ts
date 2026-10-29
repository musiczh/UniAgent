import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekEventStore } from '../src/main/deepseekEventStore.ts'
const dir = await mkdtemp(join(tmpdir(), 'ua-dsh-events-'))
const stores: DeepSeekEventStore[] = []
const open = (directory = dir, limit?: number) => {
  const store = new DeepSeekEventStore(directory, undefined, limit)
  stores.push(store)
  return store
}
try {
  const store = open()
  const base:any = { sessionId:'s_fixture', seq:1, ts:1, type:'agent_message', state:'running', payload:{id:'reply',text:'part'} }
  store.append('s_fixture',base)
  store.append('s_fixture',{...base,seq:2,state:'success',payload:{id:'reply',text:'complete'}})
  store.append('s_fixture',{...base,seq:3,type:'user_message',payload:{id:'question',text:'next'}})
  store.append('s_fixture',{...base,seq:4,type:'approval_request',state:'pending',payload:{requestId:'approval',kind:'command',params:{rawInput:{command:'pwd'}}}})
  store.append('s_fixture',{...base,seq:5,type:'approval_request',state:'success',payload:{requestId:'approval',resolved:true,submittedAnswer:{optionId:'allow-once'}}})
  store.append('s_fixture',{...base,seq:6,type:'approval_request',state:'pending',payload:{requestId:'orphan',kind:'command'}})
  await store.flush()
  await appendFile(join(dir,'s_fixture.jsonl'), 'null\n{"truncated":\n')
  const restored = await open().load('s_fixture')
  assert.deepEqual(restored.filter(e=>e.type!=='approval_request').map(e=>e.payload.text),['complete','next'])
  const approval = restored.find(e=>e.type==='approval_request')!
  assert.equal(approval.payload.kind,'command')
  assert.equal(approval.payload.params.rawInput.command,'pwd')
  assert.equal(approval.payload.submittedAnswer.optionId,'allow-once')
  const orphan = restored.find(e=>e.payload.requestId==='orphan')!
  assert.equal(orphan.state,'cancelled')
  assert.equal(orphan.payload.interactionExpired,true)
  await store.delete('s_fixture'); assert.deepEqual(await store.load('s_fixture'),[])
  for (let seq = 0; seq < 20_000; seq++) store.append('s_fixture', { ...base, seq, payload: { id: 'reply', text: 'x'.repeat(1000) + seq } })
  assert.ok(store.stats().historyQueuedBytes < 64 * 1024, 'pending cumulative snapshots stay bounded')
  const completed = await store.load('s_fixture')
  assert.equal(completed.length, 1)
  assert.equal(completed[0].seq, 19_999, 'disk snapshots retain the latest sequence watermark')
  assert.ok(completed[0].payload.text.endsWith('19999'))
  // A replace/delete is ordered after every pending append; old writes cannot resurrect history.
  store.append('s_fixture', base)
  await store.replace('s_fixture', [{ ...base, seq: 100, payload: { id: 'replacement', text: 'replaced' } }])
  assert.deepEqual((await store.load('s_fixture')).map(e => e.payload.text), ['replaced'])
  store.append('s_fixture', base)
  await store.delete('s_fixture')
  assert.deepEqual(await store.load('s_fixture'), [])
  assert.throws(() => store.append('../escape', base), /invalid_session_id/)
  const saturated = open(join(dir, 'saturated'), 100)
  saturated.append('s_fixture', base)
  await assert.rejects(saturated.flush(), /history_write_queue_full/)
  assert.equal(saturated.stats().historyQueuedBytes, 0, 'failed queues release retained data and surface failure')
  const blocked = join(dir,'blocked')
  await writeFile(blocked,'not a directory')
  const unavailable = open(blocked)
  assert.doesNotThrow(()=>unavailable.append('s_fixture',base))
  await assert.rejects(unavailable.flush())
  await assert.rejects(unavailable.load('s_fixture'), 'a failed history must not be reported as empty')
  const closing = open(join(dir, 'closing'))
  closing.append('s_fixture', base)
  const closed = closing.close()
  closing.append('s_fixture', { ...base, payload: { id: 'late', text: 'must not enter a closing store' } })
  assert.equal(closing.close(), closed, 'concurrent closes join the same flush')
  await closed
  assert.deepEqual((await open(join(dir, 'closing')).load('s_fixture')).map(e => e.payload.text), ['part'])
} finally { await Promise.allSettled(stores.map(store => store.close())); await rm(dir,{recursive:true,force:true}) }
console.log('deepseek-event-store: persisted conversation survives restart without duplicate chunks')
