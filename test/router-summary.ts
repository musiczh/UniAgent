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
  for (const [kind, limit] of [['space', 200], ['requirement', 500], ['task', 300]] as const) {
    const bounded = { id: kind + '-budget', kind, title: '预算', summary: ' a'.repeat(limit), version: '1',
      sources: [{ ref: kind + ':goal', title: '目标', text: ' a'.repeat(limit), at: 0 }] }
    await db.index([bounded], false)
    const indexed = db.object(bounded.id)
    assert.equal(indexed.description?.tokens, limit, 'source excerpt uses the object-specific limit')
    for (const count of [limit - 1, limit]) {
      const saved = await db.saveDescription(bounded.id, indexed.sourceRevision!, { description: ' a'.repeat(count), sourceRefs: [kind + ':goal'] })
      assert.equal(saved.tokens, count)
    }
    await assert.rejects(db.saveDescription(bounded.id, indexed.sourceRevision!, { description: ' a'.repeat(limit + 1), sourceRefs: [kind + ':goal'] }), /invalid_router_description/)
  }
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
  await service.close()
  const requirement: RouterObject = { id: 'routed-requirement', kind: 'requirement', title: '结算需求', summary: '总体目标：结算工作流与结果反馈。', version: '1', lastBusinessUpdatedAt: 100,
    routing: { status: 'ready', sourceRevision: 'core-v1' }, sources: [
      { ref: 'requirement:core', title: '目标与范围', at: 100, text: '总体目标：结算工作流与结果反馈，不承载库存盘点。' },
      ...Array.from({ length: 8 }, (_, i) => ({ ref: `reference:${i}`, title: '未读草稿入口', at: 100, text: '{"status":"draft","uris":["https://fixture.invalid/article"]}' })),
      { ref: 'requirement:feature', title: '功能边界', at: 100, text: '承载结算批次、异常处理与反馈。' }
    ] }
  await db.index([requirement], false)
  const job = (await db.descriptionJobs()).find(job => job.id === requirement.id)!
  assert.ok(job, 'a ready routing view still needs a semantic description instead of a prefix of its features')
  assert.equal(job.maxTokens, 500)
  assert.equal(job.sources[0].ref, 'requirement:core')
  assert.ok(job.sources.some(source => source.ref === 'requirement:feature'), 'material directories cannot displace effective scope from the description input')
  assert.equal(job.sources.some(source => source.ref.startsWith('reference:')), false, 'unread material links are lookup metadata rather than description facts')
  const requirementService = new RouterSummaryService({ store, config: () => ({ ...DEFAULT_ROUTER_CONFIG, enabled: true }), busy: () => false,
    refresh: async () => db.index([requirement], false), error: error => errors.push(error), generate: async (_config, prompt) => {
      const input = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1))
      assert.equal(input.id, requirement.id)
      assert.equal(input.sources[0].text, requirement.sources![0].text)
      return JSON.stringify({ description: '承载结算批次、异常处理与结果反馈；库存盘点不在范围内。', sourceRefs: ['requirement:core','requirement:feature'] })
    } })
  try {
    requirementService.schedule()
    for (let i = 0; i < 300 && db.object(requirement.id).description?.freshness !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(db.object(requirement.id).description?.freshness, 'ready', JSON.stringify(errors.map(String)))
    assert.equal(db.object(requirement.id).lastBusinessUpdatedAt, 100)
    assert.equal((await db.descriptionJobs()).some(job => job.id === requirement.id), false)
  } finally { await requirementService.close() }
  console.log('PASS Router summary: source versions, retained stale descriptions, real token/source validation and late output rejection')
} finally { await service.close(); db.close() }
