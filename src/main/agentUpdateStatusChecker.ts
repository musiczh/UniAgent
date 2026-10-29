import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentDef } from '../shared/types.ts'
import type { AgentLifecycleService } from './agentLifecycleService.ts'

const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000

/**
 * 后台更新状态检查。
 *
 * 外部 Agent 列表只暴露「可用 / 异常 / 可更新」三种稳态，因此更新状态必须
 * 在后台保持真实，不能依赖用户手动点「重新探测」。本检查只在启动就绪后触发，
 * 按间隔节流，避免每次启动都访问各家注册表；检查本身是静默的，不打断任何界面。
 */
export class AgentUpdateStatusChecker {
  private flight?: Promise<void>

  constructor(private readonly options: {
    /** 记录上次检查时间的文件。 */
    file: string
    lifecycle: Pick<AgentLifecycleService, 'checkAllUpdates'>
    onUpdated: (agents: AgentDef[]) => void
    /** 两次检查之间的最小间隔，默认 6 小时。 */
    intervalMs?: number
    now?: () => number
  }) {}

  run(): Promise<void> {
    if (this.flight) return this.flight
    const flight = this.perform().finally(() => {
      if (this.flight === flight) this.flight = undefined
    })
    this.flight = flight
    return flight
  }

  private get now(): number { return (this.options.now || Date.now)() }
  private get intervalMs(): number { return this.options.intervalMs ?? DEFAULT_INTERVAL_MS }

  private async perform(): Promise<void> {
    const lastCheckedAt = await this.readLastCheckedAt()
    if (lastCheckedAt > 0 && this.now - lastCheckedAt < this.intervalMs) return
    try {
      const agents = await this.options.lifecycle.checkAllUpdates()
      this.options.onUpdated(agents)
    } finally {
      // 记录检查时间，保证下次启动不会立刻重复请求（进程中途退出时同样落盘）。
      await this.writeLastCheckedAt(this.now)
    }
  }

  private async readLastCheckedAt(): Promise<number> {
    try {
      const raw = JSON.parse(await readFile(this.options.file, 'utf8')) as { lastCheckedAt?: unknown }
      return typeof raw?.lastCheckedAt === 'number' && Number.isFinite(raw.lastCheckedAt) ? raw.lastCheckedAt : 0
    } catch {
      return 0
    }
  }

  private async writeLastCheckedAt(at: number): Promise<void> {
    try {
      await mkdir(dirname(this.options.file), { recursive: true })
      await writeFile(this.options.file, JSON.stringify({ lastCheckedAt: at }), 'utf8')
    } catch {
      // 节流文件写入失败不应影响检查本身。
    }
  }
}
