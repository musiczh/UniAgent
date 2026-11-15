import assert from 'node:assert/strict'
import { TASK_EXECUTION_LABELS } from '../src/shared/task'
import { resolveTaskCreationScope } from '../src/main/taskScope'
import { requirementOwnerByUsage } from '../src/shared/requirementOwnership'
import type { Requirement } from '../src/shared/requirementTypes'
import type { Session } from '../src/shared/types'

const session: Session = { id: 's', title: '任务', status: 'idle', createdAt: 1, config: { agentId: 'codex', projectId: 'a', workdir: '/old/a', requirementId: 'r' } }
const requirement: Requirement = { id: 'r', name: '需求', projectId: 'b', dir: '/req', docPath: '/req/context.md', status: 'active', createdAt: 1, updatedAt: 1 }
const lookup = (id: string) => id === requirement.id ? requirement : undefined
const exists = (id: string) => ['a', 'b'].includes(id)
assert.equal(TASK_EXECUTION_LABELS.completed, '本轮已结束')
assert.equal(TASK_EXECUTION_LABELS.idle, '等待继续')
const selected = resolveTaskCreationScope({ ...session.config, projectId: 'b', taskScope: { kind: 'requirement', requirementId: 'r' } }, lookup, exists)
assert.equal(selected.projectId, 'b'); assert.equal(selected.requirementId, 'r'); assert.equal(selected.taskScope, undefined)
const space = resolveTaskCreationScope({ ...session.config, taskScope: { kind: 'space', projectId: 'b' } }, lookup, exists)
assert.equal(space.projectId, 'b'); assert.equal(space.requirementId, undefined)
assert.deepEqual(resolveTaskCreationScope(session.config, lookup, exists), session.config, 'legacy cross-space sessions are never rebound')
assert.equal(session.config.workdir, '/old/a')
assert.throws(() => resolveTaskCreationScope({ ...session.config, taskScope: { kind: 'requirement', requirementId: 'r' } }, lookup, exists), /主空间已变更/)
assert.throws(() => resolveTaskCreationScope({ ...session.config, taskScope: { kind: 'space', projectId: 'deleted' } }, lookup, exists), /有效/)
assert.throws(() => resolveTaskCreationScope({ ...session.config, taskScope: { kind: 'requirement', requirementId: 'r' } }, () => ({ ...requirement, projectId: undefined }), exists), /尚未绑定/)
assert.throws(() => resolveTaskCreationScope({ ...session.config, taskScope: { kind: 'requirement', requirementId: 'r' } }, () => ({ ...requirement, status: 'archived' }), exists), /不可用/)
const make = (id: string, projectId: string): Session => ({ ...session, id, config: { ...session.config, projectId } })
const ids = new Set(['a', 'b'])
assert.equal(requirementOwnerByUsage({ id: 'r', projectId: 'b' }, [make('1', 'a'), make('2', 'a'), make('3', 'b')], ids), 'a')
assert.equal(requirementOwnerByUsage({ id: 'r', projectId: 'b' }, [make('1', 'a'), make('2', 'b')], ids), 'b')
assert.equal(requirementOwnerByUsage({ id: 'r' }, [make('1', 'b'), make('2', 'a')], ids), 'a')
assert.equal(requirementOwnerByUsage({ id: 'r' }, [make('1', 'a'), make('1', 'a'), make('2', 'b'), make('3', 'b')], ids), 'b')
assert.equal(requirementOwnerByUsage({ id: 'r', projectId: 'deleted' }, [make('1', 'deleted')], ids), undefined)
console.log('PASS Task execution labels, scope exclusivity, stale ownership and deterministic usage counts')
