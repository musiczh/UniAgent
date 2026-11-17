import assert from 'node:assert/strict'
import { routerFixture } from './fixtures/router-quality'
import type { RouterObject } from '../src/shared/router'

const now = Date.now()
const objects: RouterObject[] = [
  { id: 'space', kind: 'space', title: 'UniAgent', summary: '桌面客户端', projectId: 'space', version: '1' },
  { id: 'requirement', kind: 'requirement', title: 'Router', summary: '路由证据链', projectId: 'space', version: '1' },
  { id: 'task', kind: 'task', title: '原任务', summary: '继续原方案', projectId: 'space', requirementId: 'requirement', version: '1', lastBusinessUpdatedAt: now,
    sources: [{ ref: 'input', title: '原目标', text: '继续原任务。', at: now }] }
]
const sent: string[] = []
const f = await routerFixture(objects, { now, send: async (_id, prompt) => { sent.push(prompt) } })
const promptContext = () => JSON.parse(sent.at(-1)!.slice(sent.at(-1)!.indexOf('{')))
try {
  const id = await f.submit({ prompt: '继续原任务，重试时仍使用原输入' })
  const catalog = await f.call('router_query', { requestId: id, mode: 'catalog', kind: 'space' })
  const briefs = await f.call('router_query', { requestId: id, mode: 'task_briefs', selectedScope: { kind: 'requirement', requirementId: 'requirement' } })
  assert.equal(catalog.ok, true)
  assert.equal(briefs.ok, true)
  const oldReading = structuredClone(f.db.request(id)!.context!.reading!)
  const oldRevision = catalog.value.catalogRevision, oldAsOf = catalog.value.asOf
  assert.equal(oldReading.catalogs?.find(row => row.key === 'space:')?.catalogRevision, oldRevision)
  assert.equal(oldReading.catalogs?.find(row => row.key === 'space:')?.asOf, oldAsOf)
  assert.equal(oldReading.scans?.['requirement:requirement']?.catalogRevision, briefs.value.catalogRevision)
  assert.equal(oldReading.scans?.['requirement:requirement']?.asOf, briefs.value.asOf)

  objects.push({ id: 'new-space', kind: 'space', title: '重试期间新增项目', summary: '新的目录事实', projectId: 'new-space', version: '1' })
  await f.db.index(objects)
  assert.notEqual(f.db.catalogRevision(), oldRevision)

  await f.controller.interrupt()
  await f.end()
  const failed = f.db.request(id)!
  assert.equal(failed.state, 'cancelled')
  const beforeRetryPrompts = sent.length
  const queued = await f.controller.retry(id, failed.version)
  assert.equal(queued.state, 'queued')
  for (let i = 0; i < 100 && (f.db.request(id)?.state !== 'routing' || sent.length <= beforeRetryPrompts || !String(sent.at(-1)).includes('"reading"')); i++) await new Promise(resolve => setTimeout(resolve, 10))
  const current = f.db.request(id)!
  assert.equal(current.state, 'routing')
  assert.deepEqual(current.context?.reading, oldReading, 'the same requestId keeps its prior reading as a fast entry')
  const prompt = promptContext()
  assert.equal(prompt.requestId, id)
  assert.equal(prompt.input, '继续原任务，重试时仍使用原输入')
  const newRevision = prompt.catalogRevision
  assert.equal(newRevision, f.db.catalogRevision(), 'the new round is injected with the current catalog revision')
  assert.notEqual(newRevision, oldRevision)
  assert.ok(prompt.asOf >= oldAsOf, 'the new round has a fresh snapshot time')
  assert.deepEqual(prompt.reading, oldReading, 'old reading is carried with its original revision and asOf, never relabeled as the newest catalog')
  assert.equal(prompt.reading.catalogs[0].catalogRevision, oldRevision)
  assert.notEqual(prompt.reading.catalogs[0].catalogRevision, prompt.catalogRevision)

  const refreshed = await f.call('router_query', { requestId: id, mode: 'catalog', kind: 'space' })
  assert.equal(refreshed.value.catalogRevision, newRevision)
  const after = f.db.request(id)!.context!.reading!
  const spaceReading = after.catalogs?.find(row => row.key === 'space:')!
  assert.equal(spaceReading.catalogRevision, newRevision, 'a targeted refresh updates only the queried catalog entry')
  assert.ok(spaceReading.asOf >= oldAsOf)
  assert.equal(after.scans?.['requirement:requirement']?.catalogRevision, oldReading.scans?.['requirement:requirement']?.catalogRevision,
    'refreshing one scope does not rewrite the old scan snapshot')
  await f.end()
  console.log('PASS Router reading retry: same request keeps prior reading, new prompt gets fresh catalogRevision/asOf and a targeted refresh can update it')
} finally { await f.close() }
