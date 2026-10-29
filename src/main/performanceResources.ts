import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import { basename } from 'node:path'
import { performance } from 'node:perf_hooks'

export const PERFORMANCE_SAMPLE_MS = 5_000
const MiB = 1024 ** 2

export interface ResourceProcess {
  pid: number
  ppid: number
  name: string
  startedAt: string
  cpuTimeMs: number
  rssBytes: number
  cpuPercent: number | null
  type?: string
}

export interface ResourceSample {
  at: number
  intervalMs: number
  collectionMs: number
  systemCpuPercent: number | null
  memory: {
    totalBytes: number
    freeBytes: number
    compressedBytes?: number
    swapUsedBytes?: number
    swapOutBytes?: number
    pressureLevel?: number
  }
  tree?: {
    processCount: number
    rssSumBytes: number
    cpuPercent: number | null
    maxProcessRssBytes: number
    maxProcessCpuPercent: number
    omittedProcesses: number
    processes: ResourceProcess[]
  }
  topCpu: ResourceProcess[]
  topMemory: ResourceProcess[]
  errors: string[]
}

type ProcessRow = Omit<ResourceProcess, 'cpuPercent'>
type CpuTimes = ReturnType<typeof cpus>

/** ps time is cumulative, unlike macOS ps %cpu's decaying average. */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const time = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(match[4])
    if (!time) continue
    const cpuTimeMs = ((Number(time[1] || 0) * 86400) + Number(time[2] || 0) * 3600 + Number(time[3]) * 60 + Number(time[4])) * 1000
    const row = { pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024,
      cpuTimeMs, startedAt: match[5].replace(/\s+/g, ' '), name: basename(match[6]).slice(0, 80) }
    if (Object.values(row).filter(value => typeof value === 'number').every(Number.isFinite)) rows.push(row)
  }
  if (!rows.length) throw new Error('invalid_process_table')
  return rows
}

export function parseVmStat(text: string): Pick<ResourceSample['memory'], 'compressedBytes' | 'swapOutBytes'> {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  const pages = (name: string): number => {
    const value = Number(new RegExp('^' + name + ':\\s+(\\d+)\\.', 'm').exec(text)?.[1])
    if (!Number.isFinite(value)) throw new Error('invalid_vm_stat')
    return value
  }
  if (!pageSize || !Number.isFinite(pageSize)) throw new Error('invalid_vm_stat')
  return { compressedBytes: pages('Pages occupied by compressor') * pageSize, swapOutBytes: pages('Swapouts') * pageSize }
}

export function parseSwapUsage(text: string): number {
  const match = /used\s*=\s*([\d.]+)([KMGT])\b/i.exec(text)
  if (!match || !Number.isFinite(Number(match[1]))) throw new Error('invalid_swap_usage')
  return Math.round(Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2].toUpperCase()) + 1))
}

export function summarizeProcesses(rows: ProcessRow[], previous: ProcessRow[], intervalMs: number, rootPid: number):
  Pick<ResourceSample, 'tree' | 'topCpu' | 'topMemory'> {
  const old = new Map(previous.map(row => [row.pid, row]))
  const processes = rows.map(row => {
    const prior = old.get(row.pid)
    const elapsed = prior && prior.startedAt === row.startedAt && intervalMs > 0 ? row.cpuTimeMs - prior.cpuTimeMs : -1
    return { ...row, cpuPercent: elapsed >= 0 ? Math.round(elapsed / intervalMs * 1000) / 10 : null }
  })
  const children = new Map<number, ResourceProcess[]>()
  for (const row of processes) {
    if (!children.has(row.ppid)) children.set(row.ppid, [])
    children.get(row.ppid)!.push(row)
  }
  const root = processes.find(row => row.pid === rootPid)
  const owned = new Map<number, ResourceProcess>()
  const pending = root ? [root] : []
  while (pending.length) {
    const row = pending.pop()!
    if (owned.has(row.pid)) continue
    owned.set(row.pid, row)
    pending.push(...children.get(row.pid) || [])
  }
  const tree = [...owned.values()]
  const cpuOrder = (a: ResourceProcess, b: ResourceProcess): number => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0)
  return {
    ...(root ? { tree: {
      processCount: tree.length,
      rssSumBytes: tree.reduce((sum, row) => sum + row.rssBytes, 0),
      cpuPercent: root.cpuPercent === null ? null : Math.round(tree.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0) * 10) / 10,
      maxProcessRssBytes: Math.max(...tree.map(row => row.rssBytes)),
      maxProcessCpuPercent: Math.max(...tree.map(row => row.cpuPercent ?? 0)),
      omittedProcesses: Math.max(0, tree.length - 40),
      processes: tree.sort((a, b) => Math.max(b.rssBytes / (1024 * MiB), (b.cpuPercent ?? 0) / 100) -
        Math.max(a.rssBytes / (1024 * MiB), (a.cpuPercent ?? 0) / 100)).slice(0, 40)
    } } : {}),
    topCpu: processes.filter(row => row.cpuPercent !== null).sort(cpuOrder).slice(0, 5),
    topMemory: processes.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5)
  }
}

function systemCpu(current: CpuTimes, previous?: CpuTimes): number | null {
  if (!previous || current.length !== previous.length) return null
  let idle = 0, total = 0
  for (let i = 0; i < current.length; i++) {
    idle += current[i].times.idle - previous[i].times.idle
    for (const field of ['user', 'nice', 'sys', 'idle', 'irq'] as const) total += current[i].times[field] - previous[i].times[field]
  }
  return total > 0 && idle >= 0 ? Math.round(Math.max(0, Math.min(1, 1 - idle / total)) * 1000) / 10 : null
}

/** Run only in the monitoring worker. No shell, command arguments or environment values enter logs. */
export class PerformanceResourceCollector {
  private previousRows: ProcessRow[] = []
  private previousCpu?: CpuTimes
  private previousAt?: number

  constructor(private readonly rootPid: number) {}

  reset(): void { this.previousRows = []; this.previousCpu = undefined; this.previousAt = undefined }

  async collect(): Promise<ResourceSample> {
    const started = performance.now()
    const at = Date.now()
    const intervalMs = this.previousAt === undefined ? 0 : started - this.previousAt
    const cpu = cpus()
    const sample: ResourceSample = { at, intervalMs: Math.round(intervalMs), collectionMs: 0,
      systemCpuPercent: systemCpu(cpu, this.previousCpu), memory: { totalBytes: totalmem(), freeBytes: freemem() },
      topCpu: [], topMemory: [], errors: [] }
    this.previousCpu = cpu
    this.previousAt = started
    const attempt = async (source: string, operation: () => Promise<void>): Promise<void> => {
      try { await operation() } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        sample.errors.push(source + ':' + (typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'unavailable'))
      }
    }
    const tasks: Promise<void>[] = []
    if (process.platform === 'darwin' || process.platform === 'linux') tasks.push(attempt('processes', async () => {
      const result = await command('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart=,' + (process.platform === 'darwin' ? 'ucomm=' : 'comm=')])
      const rows = parseProcessTable(result.stdout).filter(row => row.pid !== result.pid)
      Object.assign(sample, summarizeProcesses(rows, this.previousRows, intervalMs, this.rootPid))
      this.previousRows = rows
      if (!sample.tree) sample.errors.push('processes:root_missing')
    }))
    else sample.errors.push('processes:unsupported_platform')
    if (process.platform === 'darwin') {
      tasks.push(attempt('vm_stat', async () => { Object.assign(sample.memory, parseVmStat((await command('/usr/bin/vm_stat', [])).stdout)) }))
      tasks.push(attempt('swap', async () => { sample.memory.swapUsedBytes = parseSwapUsage((await command('/usr/sbin/sysctl', ['-n', 'vm.swapusage'])).stdout) }))
      tasks.push(attempt('pressure', async () => {
        const value = Number((await command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])).stdout.trim())
        if (![1, 2, 4].includes(value)) throw new Error('invalid_memory_pressure')
        sample.memory.pressureLevel = value
      }))
    }
    await Promise.all(tasks)
    if (sample.errors.some(error => error.startsWith('processes:'))) this.previousRows = []
    sample.collectionMs = Math.round(performance.now() - started)
    return sample
  }
}

function command(file: string, args: string[]): Promise<{ stdout: string; pid?: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 2_000, maxBuffer: 2 * MiB,
      env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout, pid: child.pid })
    })
  })
}
