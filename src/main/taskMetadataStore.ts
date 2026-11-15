import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { atomicWriteFile, sessionStoreWriteCommitted } from './sessionStore'
import { titleMetadata } from '../shared/taskTitle'
import type { Session, TaskTitleMetadata } from '../shared/types'
import { TaskTitleContextStore } from './taskTitleContext'

const MAX_METADATA_FILE_BYTES = 64 * 1024

function clone<T>(value: T): T {
  return structuredClone(value)
}

function project(metadata: TaskTitleMetadata | undefined): TaskTitleMetadata | undefined {
  if (!metadata) return undefined
  const { seed, ...summary } = metadata
  return clone(summary as TaskTitleMetadata)
}

export class TaskMetadataStore {
  readonly contexts: TaskTitleContextStore
  private readonly records = new Map<string, TaskTitleMetadata>()
  private readonly errors = new Map<string, Error>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly sessions = new Map<string, Session>()
  private directoryReady?: Promise<void>

  constructor(private readonly directory: string, private readonly write = atomicWriteFile) {
    this.contexts = new TaskTitleContextStore(directory)
  }

  private ensureDirectory(): Promise<void> {
    this.directoryReady ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined)
    return this.directoryReady
  }

  private path(id: string): string {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('无效 Task ID')
    return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json')
  }

  private publish(session: Session | undefined, metadata: TaskTitleMetadata | undefined): void {
    if (!session) return
    session.taskMetadata = project(metadata)
  }

  private parse(id: string, value: unknown): TaskTitleMetadata {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务标题元数据格式错误')
    const row = value as Record<string, any>
    if (row.formatVersion !== 1 || row.taskId !== id || !Number.isSafeInteger(row.version) || row.version < 0) throw new Error('任务标题元数据格式错误')
    if (!Number.isSafeInteger(row.configVersion) || row.configVersion < 0) throw new Error('任务标题元数据格式错误')
    if (!['fallback', 'generated', 'manual', 'legacy-preserved'].includes(row.source)) throw new Error('任务标题元数据格式错误')
    if (!['pending', 'running', 'ready', 'needs-context', 'deferred', 'failed'].includes(row.generationState)) throw new Error('任务标题元数据格式错误')
    if (!Number.isSafeInteger(row.contextGeneration) || row.contextGeneration < 0 || !Number.isSafeInteger(row.clarificationCount) || row.clarificationCount < 0 || !Number.isSafeInteger(row.attempts) || row.attempts < 0) throw new Error('任务标题元数据格式错误')
    if (row.title !== undefined && typeof row.title !== 'string') throw new Error('任务标题元数据格式错误')
    if (row.description !== undefined && typeof row.description !== 'string') throw new Error('任务描述元数据格式错误')
    if (row.conversationId !== undefined && typeof row.conversationId !== 'string') throw new Error('任务生成会话标识格式错误')
    if (row.generatedInputId !== undefined && typeof row.generatedInputId !== 'string') throw new Error('任务生成输入标识格式错误')
    if (row.seed !== undefined && (!row.seed || typeof row.seed !== 'object' || typeof row.seed.primaryIntent !== 'string')) throw new Error('任务标题元数据格式错误')
    if (row.seed?.assistantResponse !== undefined && typeof row.seed.assistantResponse !== 'string') throw new Error('任务标题元数据格式错误')
    for (const key of ['inputId', 'currentInput', 'previousAssistantResponse']) {
      if (row.seed?.[key] !== undefined && typeof row.seed[key] !== 'string') throw new Error('任务标题元数据格式错误')
    }
    if (row.seed?.images !== undefined && (!Array.isArray(row.seed.images) || row.seed.images.some((image: any) => image?.kind !== 'image'
      || typeof image.path !== 'string' || typeof image.name !== 'string'))) throw new Error('任务标题元数据格式错误')
    return row as TaskTitleMetadata
  }

  initialize(session: Session, legacy: boolean): TaskTitleMetadata {
    this.sessions.set(session.id, session)
    if (!this.records.has(session.id)) this.records.set(session.id, titleMetadata(session, legacy))
    const metadata = this.records.get(session.id)!
    this.publish(session, metadata)
    return clone(metadata)
  }

  current(session: Session): TaskTitleMetadata {
    this.sessions.set(session.id, session)
    const error = this.errors.get(session.id)
    if (error) throw error
    const metadata = this.records.get(session.id) || titleMetadata(session, !!session.titleLocked)
    if (!this.records.has(session.id)) this.records.set(session.id, metadata)
    this.publish(session, metadata)
    return clone(metadata)
  }

  async hydrate(sessions: Session[]): Promise<void> {
    const names = new Set(await readdir(this.directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }))
    for (const session of sessions) {
      this.sessions.set(session.id, session)
      const file = basename(this.path(session.id))
      if (!names.has(file)) {
        this.publish(session, this.records.get(session.id))
        continue
      }
      try {
        const info = await stat(this.path(session.id))
        if (info.size > MAX_METADATA_FILE_BYTES) throw new Error('任务标题元数据过大')
        const record = this.parse(session.id, JSON.parse(await readFile(this.path(session.id), 'utf8')))
        this.records.set(session.id, record)
        this.errors.delete(session.id)
        this.publish(session, record)
      } catch (error) {
        this.errors.set(session.id, new Error('任务标题元数据无法读取，请保留数据并重试', { cause: error }))
        this.publish(session, undefined)
      }
    }
  }

  change(session: Session, expectedVersion: number, mutate: (metadata: TaskTitleMetadata) => void | false): Promise<TaskTitleMetadata> {
    return this.enqueue(session, current => {
      if (current.version !== expectedVersion) throw new Error('任务标题元数据已变化，请刷新后重试')
      return mutate(current)
    })
  }

  update(session: Session, mutate: (metadata: TaskTitleMetadata) => void | false): Promise<TaskTitleMetadata> {
    return this.enqueue(session, mutate)
  }

  private enqueue(session: Session, mutate: (metadata: TaskTitleMetadata) => void | false): Promise<TaskTitleMetadata> {
    this.sessions.set(session.id, session)
    const prior = this.tails.get(session.id) || Promise.resolve()
    const operation = prior.catch(() => {}).then(async () => {
      const current = this.current(session)
      const next = clone(current)
      if (mutate(next) === false) return current
      next.version++
      const bytes = JSON.stringify(next)
      await this.ensureDirectory()
      try {
        await this.write(this.path(session.id), bytes)
      } catch (error) {
        if (sessionStoreWriteCommitted(error)) {
          const observed = await readFile(this.path(session.id), 'utf8').catch(() => '')
          if (observed === bytes) {
            this.records.set(session.id, next)
            this.errors.delete(session.id)
            this.publish(this.sessions.get(session.id), next)
          } else {
            this.errors.set(session.id, new Error('任务标题保存结果待确认，请重启后核对', { cause: error }))
          }
        }
        throw error
      }
      this.records.set(session.id, next)
      this.errors.delete(session.id)
      this.publish(this.sessions.get(session.id), next)
      return clone(next)
    })
    this.tails.set(session.id, operation)
    void operation.finally(() => {
      if (this.tails.get(session.id) === operation) this.tails.delete(session.id)
    }).catch(() => {})
    return operation
  }

  remove(id: string): Promise<void> {
    const prior = this.tails.get(id) || Promise.resolve()
    const operation = prior.catch(() => {}).then(async () => {
      await rm(this.path(id), { force: true }).catch(() => {})
      await this.contexts.remove(id)
      this.records.delete(id)
      this.errors.delete(id)
      this.publish(this.sessions.get(id), undefined)
    })
    this.tails.set(id, operation)
    void operation.finally(() => {
      if (this.tails.get(id) === operation) this.tails.delete(id)
    }).catch(() => {})
    return operation.then(() => undefined)
  }

  async flush(): Promise<void> {
    await this.contexts.flush()
    while (this.tails.size) await Promise.allSettled([...this.tails.values()])
  }
}
