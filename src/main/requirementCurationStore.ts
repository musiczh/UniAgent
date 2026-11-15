import type { Requirement, RequirementCurationState, RequirementTaskDigest, RequirementTaskSummary } from '../shared/requirementTypes'
import { redactRequirementText, requirementWrite, safeRead } from './requirementSpace'

export async function readCuration(r: Requirement): Promise<RequirementCurationState> {
  const value: RequirementCurationState | undefined = await safeRead(r.dir, '.uniagent/curation.json').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!value) return { sessionId: 'curation-' + r.id, status: 'idle', queue: [], history: [], updatedAt: 0 }
  if (value.sessionId !== 'curation-' + r.id || !Array.isArray(value.queue) || !Array.isArray(value.history)) throw new Error('整理 Session 数据损坏，未重置')
  if (value.failures !== undefined && (!Array.isArray(value.failures) || value.failures.some(item => !item || typeof item.id !== 'string' || typeof item.sessionId !== 'string' || !['task','reading'].includes(item.kind) || typeof item.title !== 'string' || typeof item.error !== 'string' || !Number.isFinite(item.failedAt)))) throw new Error('失败整理记录损坏，未重置')
  return value
}
export async function writeCuration(r: Requirement, value: RequirementCurationState): Promise<void> {
  value.updatedAt = Date.now()
  value.history = value.history.slice(-40)
  await requirementWrite(r.dir, '.uniagent/curation.json', JSON.stringify(value))
}
export async function readTaskDigests(r: Requirement): Promise<Record<string, RequirementTaskDigest>> {
  const value = await safeRead(r.dir, '.uniagent/task-digests.json').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error })
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务摘要数据损坏')
  return value
}
export function validateTaskSummary(task: RequirementTaskSummary): void {
  if (!task || typeof task !== 'object' || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 160 || typeof task.summary !== 'string' || !task.summary.trim() || task.summary.length > 400) throw new Error('任务摘要需要短标题和 400 字以内的简介')
  for (const key of ['work', 'results', 'verification', 'remaining'] as const) {
    if (!Array.isArray(task[key]) || task[key].length > 6 || task[key].some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) throw new Error('任务摘要的工作、结果、验证和未完成项各最多 6 条，每条最多 500 字')
  }
  if (task.sources !== undefined && (!Array.isArray(task.sources) || task.sources.length > 12)) throw new Error('任务摘要来源最多 12 条')
  if (redactRequirementText(JSON.stringify(task)) !== JSON.stringify(task)) throw new Error('任务摘要包含敏感值，请移除后提交')
}
export async function writeTaskDigest(r: Requirement, digest: RequirementTaskDigest): Promise<void> {
  validateTaskSummary(digest)
  const tasks = await readTaskDigests(r)
  const prior = tasks[digest.sessionId]
  if (prior && (prior.throughSeq > digest.throughSeq || prior.throughSeq === digest.throughSeq && prior.origin === 'agent' && digest.origin === 'background')) return
  tasks[digest.sessionId] = digest
  await requirementWrite(r.dir, '.uniagent/task-digests.json', JSON.stringify(tasks))
}
