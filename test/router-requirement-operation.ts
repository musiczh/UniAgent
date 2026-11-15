import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { RequirementStore } from '../src/main/requirementStore'

const root = await mkdtemp(join(tmpdir(), 'ua-router-requirement-'))
const store = new RequirementStore(root), operationId = randomUUID()
const input = { name: '稳定需求', projectId: 'space' }
const created = await Promise.all(Array.from({ length: 6 }, () => store.createForOperation(operationId, input)))
assert.equal(new Set(created.map(row => row.id)).size, 1)
assert.equal(store.list().length, 1)
assert.equal((await new RequirementStore(root).createForOperation(operationId, input)).dir, created[0].dir)
await assert.rejects(store.createForOperation(operationId, { ...input, name: '另一个目标' }), /operation_conflict/)
await assert.rejects(store.createForOperation(randomUUID(), { name: '有效', projectId: '' }), /有效空间/)
await assert.rejects(store.createForOperation('../invalid', input), /invalid_requirement/)
const id = randomUUID(), name = '未完成创建', dir = join(root, 'requirements', name + '-' + id.slice(0, 8))
const requirement = { id, name, dir, docPath: join(dir, 'context.md'), status: 'active', createdAt: 1, updatedAt: 1, projectId: 'space', ownershipVersion: 1 }
const fingerprint = createHash('sha256').update(JSON.stringify({ name, projectId: 'space' })).digest('hex')
await writeFile(join(root, 'requirement-operations', id + '.json'), JSON.stringify({ fingerprint, requirement }))
await mkdir(dir)
const resumed = await new RequirementStore(root).createForOperation(id, { name, projectId: 'space' })
assert.equal(resumed.id, id)
assert.ok((await readFile(resumed.docPath, 'utf8')).length)
assert.equal(store.list().length, 2)
const linkId = randomUUID(), linked = { ...requirement, id: linkId, dir: join(root, 'requirements', '链接-' + linkId.slice(0, 8)) }
await symlink(dir, linked.dir)
await writeFile(join(root, 'requirement-operations', linkId + '.json'), JSON.stringify({ fingerprint, requirement: linked }))
await assert.rejects(store.createForOperation(linkId, { name, projectId: 'space' }), /directory_conflict/)
assert.equal(store.list().length, 2)
console.log('PASS Router requirement operation: fixed identity, concurrent/restart retries, payload conflicts, partial creation and symlink boundary')
