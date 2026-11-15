import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { AgentDef, SessionConfig } from '../shared/types'
import type { ForkContext, ForkJob, ForkPreflight, ForkRequest, ForkStage } from '../shared/sessionFork'
import { forkContextWork } from './forkContextClient'

export interface ForkPreparation {
  source: AgentDef
  target: AgentDef
  sourceConfig: SessionConfig
  targetConfig: SessionConfig
  sourceCache?: ForkJob['sourceCache']
  sourceSessionId?: string
  contextWindow: number
  modelLabel: string
}
export interface ForkJobDependencies {
  prepare: (request: ForkRequest) => Promise<ForkPreparation>
  snapshot: (job: ForkJob) => Promise<string>
  compact: (job: ForkJob) => Promise<void>
  handoff: (job: ForkJob) => Promise<string>
  validate: (job: ForkJob, bytes: number) => Promise<void>
  create: (job: ForkJob) => Promise<string>
  findCreated: (job: ForkJob) => string | undefined
  retarget?: (job: ForkJob, model: string) => SessionConfig
}

/** One persisted job owns its native snapshot, export directory and eventual public branch. */
export class SessionForkJobs {
  private jobs = new Map<string, ForkJob>()
  private plans = new Map<string, { preview: ForkPreflight; preparation: ForkPreparation }>()
  private running = new Map<string, Promise<void>>()
  private writes = new Map<string, Promise<void>>()
  private initialized?: Promise<void>
  constructor(private root: string, private deps: ForkJobDependencies, private home = homedir()) {}

  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      for (const name of await readdir(this.root)) {
        if (!/^[\w-]+$/.test(name)) continue
        let job: ForkJob
        try { job = JSON.parse(await readFile(join(this.root, name, 'job.json'), 'utf8')) } catch { continue }
        if (job.id !== name || job.archivePath !== join(this.root, name)) continue
        const created = this.deps.findCreated(job)
        if (created) { job.targetSessionId = created; job.status = 'completed'; job.stage = 'completed'; job.detail = '分支已创建' }
        else if (['running','stopping'].includes(job.status)) {
          job.status = 'failed'; job.error = '应用上次退出时分叉尚未确认完成。已保留资料，请检查后重试，不会自动重复调用模型。'
        }
        this.jobs.set(job.id, job)
      }
    })()
  }

  private save(job: ForkJob): Promise<void> {
    job.seq++; job.updatedAt = Date.now()
    const body = JSON.stringify(job), seq = job.seq
    const write = (this.writes.get(job.id) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(job.archivePath, { recursive: true, mode: 0o700 })
      const temp = join(job.archivePath, `job-${seq}.tmp`)
      await writeFile(temp, body, { mode: 0o600 })
      await rename(temp, join(job.archivePath, 'job.json'))
    })
    this.writes.set(job.id, write)
    return write
  }

  async preflight(request: ForkRequest): Promise<ForkPreflight> {
    await this.initialize()
    if (!request || !['codex','traex','claude'].includes(request.sourceAgentId) || !['codex','traex','claude'].includes(request.targetAgentId)) throw new Error('当前 Agent 暂不支持压缩后导出')
    const preparation = await this.deps.prepare(request)
    const context = await forkContextWork<ForkContext>('read', { home: this.home, agentId: request.sourceAgentId,
      nativeId: request.nativeId, point: request.point, summaryOnly: true })
    const preview: ForkPreflight = { planId: randomUUID(), request: structuredClone(request), sourceRevision: context.revision,
      reusable: context.reusable, contextWindow: preparation.contextWindow, modelLabel: preparation.modelLabel }
    this.plans.set(preview.planId, { preview, preparation })
    if (this.plans.size > 100) this.plans.delete(this.plans.keys().next().value!)
    return preview
  }

  async start(planId: string): Promise<ForkJob> {
    await this.initialize()
    const existing = this.jobs.get(planId)
    if (existing) return structuredClone(existing)
    const plan = this.plans.get(planId)
    if (!plan) throw new Error('分叉预检已过期，请刷新检查')
    const { preview, preparation } = plan
    if ([...this.jobs.values()].some(job => ['running','stopping'].includes(job.status) && job.request.sourceAgentId === preview.request.sourceAgentId && job.request.nativeId === preview.request.nativeId)) throw new Error('此来源已有分叉任务正在执行')
    const now = Date.now()
    const job: ForkJob = { id: planId, seq: 0, request: preview.request, sourceRevision: preview.sourceRevision,
      sourceSessionId: preparation.sourceSessionId, stage: 'preparing', status: 'running', detail: '正在冻结分叉位置',
      createdAt: now, updatedAt: now, reusedCompaction: preview.reusable, targetNativeId: randomUUID(),
      archivePath: join(this.root, planId), sourceConfig: preparation.sourceConfig, targetConfig: preparation.targetConfig, sourceCache: preparation.sourceCache }
    this.jobs.set(job.id, job)
    try { await this.save(job) } catch (error) { this.jobs.delete(job.id); throw error }
    this.launch(job)
    return structuredClone(job)
  }

  async get(id: string): Promise<ForkJob | undefined> { await this.initialize(); const job = this.jobs.get(id); return job && structuredClone(job) }
  async wait(id: string): Promise<ForkJob> {
    await this.running.get(id)
    const job = await this.get(id)
    if (!job || job.status !== 'completed') throw new Error(job?.error || job?.detail || '分叉任务不存在')
    return job
  }
  async list(): Promise<ForkJob[]> { await this.initialize(); return [...this.jobs.values()].map(job => structuredClone(job)) }
  async cancel(id: string): Promise<ForkJob> {
    await this.initialize()
    const job = this.jobs.get(id)
    if (!job) throw new Error('分叉任务不存在')
    if (job.status === 'running') {
      job.status = 'stopping'; job.detail = '正在停止，等待当前原生操作结束'; await this.save(job)
    }
    return structuredClone(job)
  }
  async retry(id: string, allowMissing = false, targetModel?: string): Promise<ForkJob> {
    await this.initialize()
    const job = this.jobs.get(id)
    if (!job || !['failed','cancelled'].includes(job.status) || this.running.has(id)) throw new Error('当前任务不可重试')
    const created = this.deps.findCreated(job)
    if (created) { job.targetSessionId = created; job.status = 'completed'; job.stage = 'completed'; await this.save(job); return structuredClone(job) }
    if (targetModel && targetModel !== job.request.targetModel) {
      if (!this.deps.retarget) throw new Error('当前任务不支持更换模型')
      job.targetConfig = this.deps.retarget(job, targetModel)
      job.request = { ...job.request, targetModel }; job.targetNativeId = randomUUID(); job.capacity = undefined
    }
    if (allowMissing) job.allowMissing = true
    job.status = 'running'; job.error = undefined
    await this.save(job); this.launch(job)
    return structuredClone(job)
  }
  private launch(job: ForkJob): void {
    const flight = this.run(job).finally(() => this.running.delete(job.id))
    this.running.set(job.id, flight)
    // A disk failure is retained in memory and reported by polling; never publish a false success.
    void flight.catch(error => { job.status = 'failed'; job.error = error.message || String(error) })
  }
  private check(job: ForkJob): void { if (job.status === 'stopping') throw new Error('FORK_CANCELLED') }
  private async stage(job: ForkJob, stage: ForkStage, detail: string): Promise<void> {
    this.check(job); job.stage = stage; job.detail = detail; await this.save(job)
    this.check(job)
  }
  private async read(job: ForkJob, nativeId: string, archive?: string): Promise<ForkContext> {
    return forkContextWork('read', { home: this.home, agentId: job.request.sourceAgentId, nativeId, archive, summaryOnly: true })
  }
  private async run(job: ForkJob): Promise<void> {
    try {
      if (!job.stagingNativeId) {
        await this.stage(job, 'preparing', '正在冻结分叉位置')
        const fresh = await this.preflight(job.request)
        if (fresh.sourceRevision !== job.sourceRevision) throw new Error('来源上下文已变化，请关闭后重新确认分叉位置')
        // Archive exactly the approved prefix before compaction changes the private native fork.
        const frozen = await forkContextWork<ForkContext>('read', { home: this.home, agentId: job.request.sourceAgentId,
          nativeId: job.request.nativeId, point: job.request.point, archive: job.archivePath, sourceCache: job.sourceCache, summaryOnly: true })
        if (frozen.revision !== job.sourceRevision) throw new Error('来源上下文在准备期间发生变化，请重新确认')
        job.missing = frozen.missing
        this.check(job)
        job.stagingNativeId = await this.deps.snapshot(job)
        const staged = await this.read(job, job.stagingNativeId)
        if (staged.contextFingerprint !== frozen.contextFingerprint) throw new Error('来源在原生分叉期间发生变化，请关闭后重新确认')
        job.snapshotVerified = true
        await this.save(job)
      }
      if (!job.snapshotVerified) throw new Error('来源快照尚未通过一致性检查，请关闭后重新分叉')
      if (!job.compacted) {
        const before = await this.read(job, job.stagingNativeId)
        if (!before.reusable) {
          job.reusedCompaction = false
          await this.stage(job, 'compacting', '正在由来源 Agent 压缩上下文')
          await this.deps.compact(job)
        } else job.reusedCompaction = true
        const context = await this.read(job, job.stagingNativeId)
        if (!context.checkpoint || !context.reusable || !job.reusedCompaction && context.checkpoint === before.checkpoint) throw new Error('原生压缩没有产生可验证的新上下文，未创建分支')
        job.compacted = true; job.compactedRevision = context.revision
        await this.save(job)
      }
      await this.stage(job, 'exporting', '正在提取有效上下文')
      if (!job.contextSaved) {
        if (!job.preparedHash) {
          const prepared = await forkContextWork<{ hash: string; needsHandoff: boolean }>('prepare', { home: this.home,
            agentId: job.request.sourceAgentId, nativeId: job.stagingNativeId, archive: job.archivePath, revision: job.compactedRevision })
          job.preparedHash = prepared.hash; job.needsHandoff = prepared.needsHandoff
          await this.save(job)
        }
        let handoff: string | undefined
        if (job.needsHandoff) {
          await this.stage(job, 'exporting', '正在由来源模型整理交接说明')
          try { handoff = await readFile(join(job.archivePath, 'handoff.md'), 'utf8') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          if (!handoff) handoff = await this.deps.handoff(job)
        }
        const exported = await forkContextWork<{ hash: string }>('finish', { archive: job.archivePath, hash: job.preparedHash, handoff })
        job.contextHash = exported.hash; job.contextSaved = true; await this.save(job)
      }
      if (job.missing?.length && !job.allowMissing) throw new Error('部分历史资料无法保存，请查看缺失列表后选择是否继续')
      await this.stage(job, 'validating', '正在检查目标容量')
      const bytes = await forkContextWork<number>('measure', { archive: job.archivePath, hash: job.contextHash })
      await this.deps.validate(job, bytes)
      await this.stage(job, 'creating', '正在创建并加载新分支')
      job.targetSessionId = await this.deps.create(job)
      // A committed target wins the cancel race; it is never deleted on renderer navigation.
      job.stage = 'completed'; job.status = 'completed'; job.detail = '分支已创建'; await this.save(job)
    } catch (error) {
      const created = this.deps.findCreated(job)
      if (created) { job.targetSessionId = created; job.stage = 'completed'; job.status = 'completed'; job.detail = '分支已创建' }
      else {
        const message = error instanceof Error ? error.message : String(error)
        const stopping = job.status === 'stopping'
        job.status = message === 'FORK_CANCELLED' ? 'cancelled' : 'failed'
        job.error = job.status === 'cancelled' ? undefined : `${stopping ? '停止尚未确认：' : ''}${message}`
        job.detail = job.status === 'cancelled' ? '分叉已停止' : job.compacted ? '导出未完成，压缩结果已保留' : '分叉未完成，原会话保留'
      }
      await this.save(job)
    }
  }
}
