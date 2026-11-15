import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequirementStore } from '../src/main/requirementStore'
import type { Session } from '../src/shared/types'

const home = mkdtempSync(join(tmpdir(), 'ua-ownership-'))
try {
  const store = new RequirementStore(home)
  const r = await store.create({ name: '跨空间需求' })
  const sessions: Session[] = ['a', 'b', 'b'].map((projectId, i) => ({ id: 's' + i, title: '历史任务', status: 'idle', createdAt: i, nativeSessionId: 'native' + i,
    config: { agentId: 'codex', workdir: '/original/' + projectId, projectId, requirementId: r.id } }))
  const beforeSessions = JSON.stringify(sessions)
  const beforeIndex = readFileSync(join(home, 'requirements.json'), 'utf8')
  const beforeContext = readFileSync(r.docPath, 'utf8')
  await Promise.all([store.migrateProjectBindings(sessions, new Set(['a', 'b'])), store.migrateProjectBindings(sessions, new Set(['a', 'b']))])
  assert.equal(store.get(r.id)?.projectId, 'b')
  assert.equal(readFileSync(join(home, 'requirements-before-ownership-v1.json'), 'utf8'), beforeIndex)
  assert.equal(JSON.stringify(sessions), beforeSessions, 'migration does not mutate existing execution environments')
  await store.update(r.id, { projectId: 'a' })
  assert.equal(readFileSync(r.docPath, 'utf8'), beforeContext, 'rebinding does not rewrite requirement context')
  const reopened = new RequirementStore(home)
  await reopened.migrateProjectBindings(sessions, new Set(['a', 'b']))
  assert.equal(reopened.get(r.id)?.projectId, 'a', 'manual ownership survives restart and a different usage majority')
  assert.equal(readFileSync(join(home, 'requirements-before-ownership-v1.json'), 'utf8'), beforeIndex, 'the original backup is never replaced')
  assert.equal(JSON.stringify(sessions), beforeSessions)
  const fresh = await reopened.create({ name: '新建需求', projectId: 'b' })
  await reopened.migrateProjectBindings([{ ...sessions[0], config: { ...sessions[0].config, requirementId: fresh.id } }], new Set(['a', 'b']))
  assert.equal(reopened.get(fresh.id)?.projectId, 'b', 'explicit creation ownership remains fixed')
  const unbound = await reopened.create({ name: '没有有效空间' })
  await reopened.migrateProjectBindings([{ ...sessions[0], config: { ...sessions[0].config, requirementId: unbound.id, projectId: 'deleted' } }], new Set(['a', 'b']))
  assert.equal(reopened.get(unbound.id)?.projectId, undefined)
  const corrupt = '[null]'
  writeFileSync(join(home, 'requirements.json'), corrupt)
  await assert.rejects(reopened.migrateProjectBindings([], new Set()), /无效记录/)
  assert.equal(readFileSync(join(home, 'requirements.json'), 'utf8'), corrupt)
  console.log('PASS Requirement ownership migration, backup, concurrent restart, explicit rebinding and session/context preservation')
} finally { rmSync(home, { recursive: true, force: true }) }
