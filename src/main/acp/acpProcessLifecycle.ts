import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export interface ProcessIdentity {
  pid: number
  ppid: number
  uid: number
  pgid: number
  startTime: string
}
export type ProcessInspection = { ok: true; process?: ProcessIdentity } | { ok: false; error: unknown }

export function parsePsProcess(line: string): ProcessIdentity | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line)
  if (!match) return undefined
  const [pid, ppid, uid, pgid] = match.slice(1, 5).map(Number)
  if (![pid, ppid, uid, pgid].every(Number.isSafeInteger) || pid <= 0 || ppid < 0 || uid < 0 || pgid <= 0) return undefined
  return { pid, ppid, uid, pgid, startTime: `${match[5]} ${match[6]} ${match[7]} ${match[8]} ${match[9]}` }
}

export function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.uid === right.uid && left.startTime === right.startTime
}

export function inspectACPProcess(pid: number): Promise<ProcessInspection> {
  return new Promise(resolve => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,pgid=,lstart='], {
      encoding: 'utf8', env: { LC_ALL: 'C' }, maxBuffer: 64 * 1024, timeout: 500
    }, (error, stdout) => {
      if (error) {
        resolve((error as Error & { code?: string | number }).code === 1 && !stdout.trim()
          ? { ok: true } : { ok: false, error })
        return
      }
      let found: ProcessIdentity | undefined
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const parsed = parsePsProcess(line)
        if (!parsed) { resolve({ ok: false, error: new Error('无法解析 ACP 进程身份') }); return }
        if (parsed.pid === pid) found = parsed
      }
      resolve({ ok: true, process: found })
    })
  })
}

/** Signal only an immediately revalidated same-user identity, never the host. */
export function signalACPProcess(expected: ProcessIdentity, inspected: ProcessInspection | undefined, signal: NodeJS.Signals): boolean {
  if (!inspected?.ok || !inspected.process || inspected.process.pid === process.pid ||
    inspected.process.uid !== process.getuid?.() || !sameProcessIdentity(expected, inspected.process)) return false
  try { process.kill(inspected.process.pid, signal); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

type Connection = { closeAndWait(): Promise<void> }
type ProcessRecord = { version: 1; owner: ProcessIdentity; root: ProcessIdentity; processes: ProcessIdentity[] }
const connections = new Set<Connection>()
const saved = new Map<string, string>()
let directory: string | undefined
let owner: ProcessIdentity | undefined
let recovery: Promise<void> | undefined
let recovering = false
let recoveryStarted = false
let shuttingDown = false
let closing: Promise<void> | undefined
let writes = Promise.resolve()

export function assertACPStartAllowed(): void {
  if (shuttingDown) throw new Error('UniAgent 正在退出，不能新建 ACP 连接')
  if (recovering) throw new Error('ACP 遗留进程仍在恢复')
}

export async function awaitACPStartup(): Promise<void> {
  if (shuttingDown) assertACPStartAllowed()
  await recovery
  assertACPStartAllowed()
}

export function registerACPConnection(connection: Connection): void { assertACPStartAllowed(); connections.add(connection) }
export function unregisterACPConnection(connection: Connection): void { connections.delete(connection) }

/** Defer disk/process recovery until the first UI document is visible. */
export function prepareACPConnections(path: string, ready: Promise<unknown> = Promise.resolve()): Promise<void> {
  if (recovery) return recovery
  recovering = true
  recovery = ready.then(async () => {
    if (shuttingDown) return
    recoveryStarted = true
    if (process.platform === 'win32') return
    await mkdir(path, { recursive: true, mode: 0o700 })
    const inspected = await inspectACPProcess(process.pid)
    if (!inspected.ok || !inspected.process) throw new Error('无法确认 UniAgent 进程身份')
    for (const file of await readdir(path)) {
      if (!/^\d+-\d+\.json$/.test(file)) continue
      let value: ProcessRecord
      try { value = JSON.parse(await readFile(join(path, file), 'utf8')) }
      catch { throw new Error('ACP 进程归属记录无法读取') }
      if (!validRecord(value) || file !== `${value.owner.pid}-${value.root.pid}.json`) throw new Error('ACP 进程归属记录无效')
      await recoverRecord(join(path, file), value)
    }
    owner = inspected.process
    directory = path
  }).finally(() => { recovering = false })
  void recovery.catch(() => {})
  return recovery
}

export function rememberACPProcesses(root: ProcessIdentity, processes: ProcessIdentity[]): void {
  if (!directory || !owner) return
  const file = join(directory, `${owner.pid}-${root.pid}.json`)
  const text = JSON.stringify({ version: 1, owner, root, processes } satisfies ProcessRecord)
  if (saved.get(file) === text) return
  saved.set(file, text)
  queueWrite(async () => {
    try {
      await writeFile(file + '.tmp', text, { mode: 0o600 })
      await rename(file + '.tmp', file)
    } catch (error) { saved.delete(file); throw error }
  })
}

export function forgetACPProcesses(root: ProcessIdentity): void {
  if (!directory || !owner) return
  const file = join(directory, `${owner.pid}-${root.pid}.json`)
  saved.delete(file)
  queueWrite(() => removeRecord(file))
}

function queueWrite(write: () => Promise<void>): void {
  writes = writes.catch(() => {}).then(write)
  void writes.catch(() => {})
}

export function flushACPProcessRecords(): Promise<void> { return writes }

/** Covers sessions, probes and quota queries, including already-closing transports. */
export function closeACPConnections(): Promise<void> {
  if (closing) return closing
  shuttingDown = true
  closing = (async () => {
    const results = await Promise.allSettled([...connections].map(connection => connection.closeAndWait()))
    if (recoveryStarted) await recovery
    await writes
    if (results.some(result => result.status === 'rejected')) throw new Error('部分 ACP 连接未完成关闭，启动时将重新清理')
  })()
  return closing
}

function validIdentity(value: ProcessIdentity): boolean {
  return !!value && [value.pid, value.ppid, value.uid, value.pgid].every(Number.isSafeInteger) &&
    value.pid > 0 && value.ppid >= 0 && value.uid === process.getuid?.() && value.pgid > 0 &&
    typeof value.startTime === 'string' && /^\S+ \S+ \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value.startTime)
}

function validRecord(value: ProcessRecord): boolean {
  return value?.version === 1 && validIdentity(value.owner) && validIdentity(value.root) &&
    value.root.ppid === value.owner.pid && value.root.pgid === value.root.pid && value.root.pid !== value.owner.pid &&
    Array.isArray(value.processes) && value.processes.every(entry => validIdentity(entry) && entry.pid !== value.owner.pid)
}

async function checkedIdentity(expected: ProcessIdentity): Promise<ProcessIdentity | undefined> {
  const inspected = await inspectACPProcess(expected.pid)
  if (!inspected.ok) throw new Error('ACP 遗留进程身份检查失败')
  return inspected.process && sameProcessIdentity(expected, inspected.process) ? inspected.process : undefined
}

async function recoverRecord(file: string, record: ProcessRecord): Promise<void> {
  // A second live instance owns its own records; PID reuse is not ownership.
  if (await checkedIdentity(record.owner)) return
  await stopACPProcessGroup(record.root, record.processes, record.owner.pid)
  await removeRecord(file)
}

/** Shared by ACP transports and owned Kimi web hosts; every signal rechecks identity. */
export async function stopACPProcessGroup(root: ProcessIdentity, processes: ProcessIdentity[], ownerPid = process.pid): Promise<void> {
  if (!validIdentity(root) || root.uid !== process.getuid?.() || root.pid === process.pid || root.ppid !== ownerPid || root.pgid !== root.pid) throw new Error('进程归属无法确认')
  const identities = new Map([...processes, root].map(entry => [entry.pid, entry]))
  for (const [signal, graceMs] of [['SIGTERM', 500], ['SIGKILL', 1500]] as const) {
    // Capture children born just before the previous host died, while a recorded
    // identity still proves that this private group has not been reused.
    const live = await Promise.all([...identities.values()].map(checkedIdentity))
    const anchor = live.find(identity => identity?.pgid === root.pgid)
    if (anchor) {
      const group = await inspectACPProcessGroup(root.pgid)
      if ((await checkedIdentity(anchor))?.pgid === root.pgid) {
        for (const identity of group) {
          if (identity.uid === root.uid && identity.pid !== ownerPid && identity.pid !== process.pid) identities.set(identity.pid, identity)
        }
      }
    }
    const targets = [...identities.values()].filter(identity => identity.pid !== root.pid)
    for (const identity of [...targets, root]) {
      const live = await checkedIdentity(identity)
      if (!live) continue
      if (identity.pid === root.pid && live.pgid === root.pgid) {
        try { process.kill(-live.pgid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('ACP 遗留进程关闭失败') }
      } else signalACPProcess(identity, { ok: true, process: live }, signal)
    }
    const deadline = Date.now() + graceMs
    do {
      if ((await Promise.all([...identities.values()].map(checkedIdentity))).every(identity => !identity)) return
      await delay(50)
    } while (Date.now() < deadline)
  }
  throw new Error('ACP 遗留进程仍未关闭，请重试检测')
}

export function inspectACPProcessGroup(pgid: number): Promise<ProcessIdentity[]> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,uid=,pgid=,lstart='], {
      encoding: 'utf8', env: { LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: 1000
    }, (error, stdout) => {
      if (error) { reject(new Error('ACP 遗留进程组检查失败')); return }
      const group: ProcessIdentity[] = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const identity = parsePsProcess(line)
        if (!identity) { reject(new Error('ACP 遗留进程组信息无效')); return }
        if (identity.pgid === pgid) group.push(identity)
      }
      resolve(group)
    })
  })
}

async function removeRecord(file: string): Promise<void> {
  await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
}
