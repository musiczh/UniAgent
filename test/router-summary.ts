import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterDatabase } from '../src/main/router/database'
import { RouterSummaryService } from '../src/main/router/summary'
import { DEFAULT_ROUTER_CONFIG, type RouterObject } from '../src/shared/router'
import type { RouterStore } from '../src/main/router/store'

const directory = await mkdtemp(join(tmpdir(), 'ua-router-summary-')), db = new RouterDatabase(join(directory, 'router.sqlite'))
const store = new Proxy({} as RouterStore, { get(_, key: string) { return async (...args: unknown[]) => (db[key as keyof RouterDatabase] as Function).apply(db, args) } })
let row: RouterObject = { id: 'task', kind: 'task', title: '任务', summary: '已确定的方案，继续完成未完工作', version: '1', lastBusinessUpdatedAt: 10,
  sources: [{ ref: 'input:1', title: '用户目标', text: '继续已确定方案的未完工作。', at: 10 }] }
const errors: unknown[] = []
let generate!: () => void, started = false
const waiting = new Promise<void>(resolve => { generate = resolve })
const service = new RouterSummaryService({ store, config: () => ({ ...DEFAULT_ROUTER_CONFIG, enabled: true }), busy: () => false, refresh: async () => db.index([row]),
  generate: async () => { started = true; await waiting; return JSON.stringify({ description: '继续已确定方案，完成剩余工作。', sourceRefs: ['input:1'] }) }, error: error => errors.push(error) })
try {
  await db.index([row])
  const initial = db.object(row.id)
  const description = await db.saveDescription(row.id, initial.sourceRevision!, { description: '持续完成已有方案。', sourceRefs: ['input:1'] })
  assert.equal(description.freshness, 'ready')
  await db.index([row]); assert.equal(db.object(row.id).description!.generatedAt, description.generatedAt, 'unchanged sources retain the generated description')
  row = { ...row, summary: '新的目标，需要重新确认方案', version: '2', lastBusinessUpdatedAt: 20 }
  await db.index([row]); assert.equal(db.object(row.id).description!.freshness, 'stale')
  assert.equal(db.object(row.id).lastBusinessUpdatedAt, 20)
  await assert.rejects(db.saveDescription(row.id, initial.sourceRevision!, { description: '迟到结果', sourceRefs: ['input:1'] }), /object_revision_changed/)
  await assert.rejects(db.saveDescription(row.id, db.object(row.id).sourceRevision!, { description: '编造目标', sourceRefs: ['unknown'] }), /invalid_router_description/)
  await assert.rejects(db.saveDescription(row.id, db.object(row.id).sourceRevision!, { description: '任务 '.repeat(1000), sourceRefs: ['input:1'] }), /invalid_router_description/)
  service.schedule()
  for (let index = 0; index < 300 && !started; index++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(started, true)
  row = { ...row, version: '3', summary: '第三版目标' }
  generate()
  for (let index = 0; index < 300 && !errors.length; index++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(String(errors[0]), /object_revision_changed/)
  assert.notEqual(db.object(row.id).description!.sourceRevision, db.object(row.id).sourceRevision, 'late model output cannot replace newer sources')
  assert.equal(db.object(row.id).lastBusinessUpdatedAt, 20)
  console.log('PASS Router summary: source versions, retained stale descriptions, real token/source validation and late output rejection')
} finally { await service.close(); db.close() }
