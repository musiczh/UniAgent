import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProcessTable, parseSwapUsage, parseVmStat, PerformanceResourceCollector, summarizeProcesses, type ResourceSample } from '../src/main/performanceResources'
import { PerformanceRecorder } from '../src/main/performanceRecorder'

const MiB = 1024 ** 2
const rows = parseProcessTable([
  '10 1 2048 0:10.50 Wed Oct 21 12:00:00 2026 UniAgent',
  '30 20 1024 01:00:01 Wed Oct 21 12:00:01 2026 /usr/bin/tool',
  '20 10 4096 1-02:03:04.50 Wed Oct 21 12:00:00 2026 Agent Helper',
  '40 1 1024 0:00.00 Wed Oct 21 12:00:01 2026 unrelated', 'invalid'
].join('\n'))
assert.equal(rows.length, 4)
assert.equal(rows[0].cpuTimeMs, 10_500)
assert.equal(rows[1].cpuTimeMs, 3_601_000)
assert.equal(rows[2].cpuTimeMs, 93_784_500)
assert.equal(rows[1].name, 'tool', 'the executable directory must not enter logs')
assert.equal(rows[2].name, 'Agent Helper', 'names containing spaces must survive parsing')
assert.throws(() => parseProcessTable('garbage'))
const current = rows.map(row => ({ ...row, cpuTimeMs: row.cpuTimeMs + 5000 }))
const summary = summarizeProcesses(current, rows, 5000, 10)
assert.equal(summary.tree?.processCount, 3, 'include grandchildren even when listed before their parent')
assert.equal(summary.tree?.cpuPercent, 300, '100% represents one core; multi-process usage can exceed 100%')
assert.equal(summary.tree?.rssSumBytes, 7 * MiB)
assert.equal(summary.tree?.processes.some(row => row.pid === 40), false, 'unrelated apps are outside the app total')
assert.equal(summarizeProcesses(current, [], 5000, 10).tree?.cpuPercent, null, 'the first reading is a warmup, not zero CPU')
const reused = current.map(row => row.pid === 10 ? { ...row, startedAt: 'new process' } : row)
assert.equal(summarizeProcesses(reused, rows, 5000, 10).tree?.cpuPercent, null, 'PID reuse must discard the old CPU baseline')
assert.equal(summarizeProcesses(current, rows, 0, 10).tree?.cpuPercent, null)
assert.equal(summarizeProcesses(current, rows, 5000, 99).tree, undefined)
const many = Array.from({ length: 100 }, (_, i) => ({ ...rows[0], pid: i + 11, ppid: 10 }))
const bounded = summarizeProcesses([rows[0], ...many], [], 0, 10).tree!
assert.equal(bounded.processes.length, 40)
assert.equal(bounded.omittedProcesses, 61)
assert.equal(bounded.processCount, 101, 'log truncation must not truncate aggregate resource accounting')
assert.deepEqual(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 100.\nSwapouts: 200.'),
  { compressedBytes: 1_638_400, swapOutBytes: 3_276_800 })
assert.equal(parseSwapUsage('total = 2048.00M used = 1024.50M free = 1023.50M (encrypted)'), 1024.5 * MiB)
assert.equal(parseSwapUsage('used = 2G'), 2048 * MiB)
for (const text of ['', 'used = NaNM', 'used = 1']) assert.throws(() => parseSwapUsage(text))
assert.throws(() => parseVmStat('page size of 4096 bytes\nSwapouts: 1.'))

const root = mkdtempSync(join(tmpdir(), 'uniagent-performance-'))
function records(directory: string, stream = 'incidents'): any[] {
  return ['.1', ''].flatMap(suffix => {
    try { return readFileSync(join(directory, stream + '.jsonl' + suffix), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  })
}
function sample(at: number, overrides: Partial<ResourceSample> = {}) {
  return { at, intervalMs: 5000, collectionMs: 5, systemCpuPercent: 10,
    memory: { totalBytes: 16 * 1024 * MiB, freeBytes: 4 * 1024 * MiB, pressureLevel: 1, swapUsedBytes: 4 * 1024 * MiB, swapOutBytes: 0 },
    tree: { processCount: 1, rssSumBytes: 100 * MiB, cpuPercent: 10, maxProcessRssBytes: 100 * MiB,
      maxProcessCpuPercent: 10, omittedProcesses: 0, processes: [] },
    topCpu: [], topMemory: [], errors: [], mainHeartbeatAgeMs: 100, ...overrides }
}

try {
  const cpuDir = join(root, 'cpu')
  const cpu = new PerformanceRecorder(cpuDir, { appVersion: 'test' })
  for (let at = 5000; at <= 15_000; at += 5000) cpu.sample(sample(at))
  const highCpu = (at: number) => sample(at, { systemCpuPercent: 95,
    tree: { ...sample(at).tree, cpuPercent: 200, maxProcessCpuPercent: 100 } })
  cpu.sample(highCpu(20_000)); cpu.sample(highCpu(25_000))
  assert.equal(records(cpuDir).length, 0, 'short CPU bursts must not start an incident')
  cpu.sample(highCpu(30_000))
  const started = records(cpuDir).find(row => row.kind === 'incident_started')
  assert.deepEqual(started.data.reasons, ['system_cpu_high', 'app_cpu_high'])
  assert.equal(started.data.environment.appVersion, 'test', 'incidents retain version metadata even after the startup log rotates')
  assert.equal(started.data.startedAt, 20_000, 'duration starts at the first abnormal observation, before the sustained threshold')
  assert.equal(records(cpuDir).filter(row => row.kind === 'incident_context').length, 5)
  for (let at = 35_000; at <= 65_000; at += 5000) cpu.sample(highCpu(at))
  assert.equal(records(cpuDir).filter(row => row.kind === 'incident_update').length, 1, 'ongoing detail is limited to once per 30 seconds')
  cpu.sample(sample(70_000)); cpu.sample(sample(75_000))
  const recovered = records(cpuDir).at(-1)
  assert.equal(recovered.kind, 'incident_recovered')
  assert.equal(recovered.data.id, started.data.id)
  assert.equal(recovered.data.environment.runId, started.data.environment.runId)
  assert.equal(recovered.data.peak.treeCpuPercent, 200)
  assert.equal(records(cpuDir, 'app').filter(row => row.kind === 'snapshot').length, 3)
  await cpu.close()

  const memoryDir = join(root, 'memory')
  const memory = new PerformanceRecorder(memoryDir, {})
  const highMemory = (at: number) => sample(at, { tree: { ...sample(at).tree, rssSumBytes: 1600 * MiB, maxProcessRssBytes: 1600 * MiB } })
  memory.sample(highMemory(5000)); memory.sample(highMemory(10_000))
  assert.deepEqual(records(memoryDir)[0].data.reasons, ['app_memory_high'])
  for (const at of [15_000, 20_000]) memory.sample(sample(at, { tree: undefined, errors: ['processes:unavailable'] }))
  assert.equal(records(memoryDir).some(row => row.kind === 'incident_recovered'), false, 'missing measurements must never report recovery')
  memory.sample(sample(25_000)); memory.sample(sample(30_000))
  assert.equal(records(memoryDir).at(-1).kind, 'incident_recovered')
  assert.deepEqual(records(memoryDir, 'app').filter(row => row.kind.startsWith('collection_')).map(row => row.kind),
    ['collection_failed', 'collection_recovered'], 'identical collection failures are deduplicated')
  await memory.close()

  const growthDir = join(root, 'growth')
  const growth = new PerformanceRecorder(growthDir, {})
  growth.event('renderer_snapshot', { heapBytes: 600 * MiB, visible: false }, 5000)
  for (let at = 5000; at <= 65_000; at += 5000) growth.sample(sample(at, { tree: { ...sample(at).tree,
    rssSumBytes: (100 + (at - 5000) / 60_000 * 600) * MiB } }))
  assert.deepEqual(records(growthDir).find(row => row.kind === 'incident_started').data.reasons, ['app_memory_growth'])
  assert.equal(records(growthDir).find(row => row.kind === 'incident_started').data.sample.renderer.data.heapBytes, 600 * MiB)
  growth.reset('resume')
  growth.sample(sample(90_000))
  assert.equal(records(growthDir).filter(row => row.kind === 'incident_started').length, 1, 'resume clears stale growth history')
  assert.equal(records(growthDir).at(-1).kind, 'incident_interrupted', 'sleep does not imply recovery')
  await growth.close()

  const heapDir = join(root, 'heap')
  const heap = new PerformanceRecorder(heapDir, {})
  for (let at = 5000; at <= 65_000; at += 5000) {
    heap.event('renderer_snapshot', { heapBytes: (800 + (at - 5000) / 60_000 * 600) * MiB }, at)
    heap.sample(sample(at))
  }
  const heapRecords = records(heapDir)
  assert.deepEqual(heapRecords.find(row => row.kind === 'incident_started').data.reasons, ['js_heap_high'])
  assert.ok(heapRecords.some(row => row.data.reasons?.includes('js_heap_growth')), 'JS growth remains detectable when compressed/swapped pages hide RSS growth')
  assert.equal(heapRecords.at(-1).data.peak.heapBytes, 1400 * MiB)
  await heap.close()

  const pressureDir = join(root, 'pressure')
  const pressure = new PerformanceRecorder(pressureDir, {})
  for (const at of [5000, 10_000, 15_000]) pressure.sample(sample(at, { memory: { ...sample(at).memory,
    freeBytes: 0, swapUsedBytes: 20 * 1024 * MiB } }))
  assert.equal(records(pressureDir).length, 0, 'low free RAM or old swap usage alone must not imply memory pressure')
  for (const at of [20_000, 25_000]) pressure.sample(sample(at, { memory: { ...sample(at).memory, pressureLevel: 2,
    swapOutBytes: (at - 15_000) / 1000 * 2 * MiB } }))
  const pressureStart = records(pressureDir).find(row => row.kind === 'incident_started')
  assert.deepEqual(pressureStart.data.reasons, ['system_memory_pressure', 'system_swap_thrashing'])
  await pressure.close()

  const stallDir = join(root, 'stall')
  const stall = new PerformanceRecorder(stallDir, {})
  stall.sample(sample(5000))
  stall.sample({ ...sample(10_000), mainHeartbeatAgeMs: 13_000 })
  assert.deepEqual(records(stallDir).find(row => row.kind === 'incident_started').data.reasons, ['main_unresponsive'])
  stall.reset('suspend')
  stall.event('renderer_stall', { longestMs: 250 }, 20_000)
  assert.equal(records(stallDir).filter(row => row.kind === 'incident_started').length, 2)
  assert.equal(records(stallDir).at(-1).data.longestMs, 250)
  await stall.close()

  const rotationDir = join(root, 'rotation')
  const rotation = new PerformanceRecorder(rotationDir, {})
  for (let i = 0; i < 300; i++) rotation.event('renderer_stall', { longestMs: 250, testPadding: 'x'.repeat(60 * 1024) })
  await rotation.close()
  const files = readdirSync(rotationDir)
  assert.deepEqual(files.sort(), ['app.jsonl', 'app.jsonl.1', 'incidents.jsonl', 'incidents.jsonl.1'])
  assert.ok(files.reduce((sum, file) => sum + statSync(join(rotationDir, file)).size, 0) <= 32 * MiB)
  assert.ok(records(rotationDir).every(row => row.truncated !== true), 'normal incident events must remain structured JSON')

  const collector = new PerformanceResourceCollector(process.pid)
  const live = await collector.collect()
  assert.ok(live.memory.totalBytes > 0)
  if (process.platform === 'darwin' || process.platform === 'linux') {
    assert.ok(live.tree?.processCount, 'actual OS output must include the monitoring process')
    assert.ok(live.tree.rssSumBytes > 0)
    assert.equal(live.tree.cpuPercent, null)
    assert.deepEqual(live.errors, [])
    assert.ok(live.topMemory.every(row => !row.name.includes('/')))
  }
  if (process.platform === 'darwin') {
    assert.ok(live.memory.compressedBytes! >= 0)
    assert.ok(live.memory.swapUsedBytes! >= 0)
    assert.ok([1, 2, 4].includes(live.memory.pressureLevel!))
  }
  const missing = await new PerformanceResourceCollector(-1).collect()
  assert.equal(missing.tree, undefined)
  assert.ok(missing.errors.some(error => error.startsWith('processes:')), 'a missing process tree must be marked unavailable')
} finally { rmSync(root, { recursive: true, force: true }) }

console.log('performance-monitor: ok; process tree, CPU, memory, stalls, failures, resume and log bounds')
