import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from './sessionStore'
import type { RecoverySnapshot } from './sessionRecovery'

export class SessionRecoveryStore {
  constructor(private readonly file: string) {}

  async load(): Promise<RecoverySnapshot> {
    let text: string
    try { text = await readFile(this.file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, errors: [], records: [] }; throw error }
    const value = JSON.parse(text)
    if (value?.version !== 1 || !Array.isArray(value.errors) || !Array.isArray(value.records) ||
      value.errors.length > 200 || value.records.length > 10000) throw new Error('自动恢复记录格式无效，未启动自动恢复')
    const short = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max
    const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0
    for (const row of value.errors) {
      if (!row || !short(row.key, 200) || !short(row.agentId, 100) || !short(row.label, 100) || !short(row.message, 2000) ||
        !integer(row.count) || !integer(row.firstSeenAt) || !integer(row.lastSeenAt)) throw new Error('自动恢复错误类型记录无效')
    }
    for (const row of value.records) {
      if (!row || !short(row.sessionId, 200) || !short(row.chainId, 100) ||
        !['judging', 'waiting', 'retrying', 'stopped'].includes(row.phase) || !integer(row.attempts) || row.attempts > 10 ||
        !integer(row.maxRetries) || row.maxRetries < 1 || row.maxRetries > 10 || !short(row.reason, 1000) || !integer(row.updatedAt) ||
        !Array.isArray(row.failureIds) || row.failureIds.length > 12 || !row.failureIds.every((id: unknown) => short(id, 200)) ||
        !Array.isArray(row.matchedRuleIds) || row.matchedRuleIds.length > 50 || !row.matchedRuleIds.every((id: unknown) => short(id, 100)) ||
        !Array.isArray(row.history) || row.history.length > 10 || !row.history.every((item: any) => item && short(item.message, 2000) && short(item.reason, 500))) {
        throw new Error('自动恢复次数记录无效，未重置已有次数')
      }
    }
    return value
  }

  async save(snapshot: RecoverySnapshot): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    await atomicWriteFile(this.file, JSON.stringify(snapshot))
  }
}
