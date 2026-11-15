import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { PERFORMANCE_SAMPLE_MS, PerformanceResourceCollector } from './performanceResources'
import { PerformanceRecorder } from './performanceRecorder'
import { monitorPerformancePayload } from '../shared/cloudMonitor'

const port = parentPort!
const collector = new PerformanceResourceCollector(workerData.pid)
const recorder = new PerformanceRecorder(workerData.root, { appVersion: workerData.appVersion, pid: workerData.pid,
  platform: process.platform, arch: process.arch, nodeVersion: process.versions.node })
let main: Record<string, unknown> | undefined
let heartbeat = performance.now()
let lastTick = performance.now()
let suspended = false, stopped = false
let generation = 0
let flight: Promise<void> | undefined
let timer: ReturnType<typeof setTimeout>
let lastCloudSample = 0

function cloudSample(code: string, data: Record<string, unknown>, at = Date.now()): void {
  if (!workerData.cloudMonitor) return
  const payload = monitorPerformancePayload(data)
  if (Object.keys(payload).length) port.postMessage({ kind: 'cloud_sample', code, data: payload, at })
}

function reset(reason: string): void {
  generation++
  collector.reset()
  recorder.reset(reason)
  main = undefined
  heartbeat = performance.now()
}

async function tick(): Promise<void> {
  const now = performance.now()
  if (now - lastTick > PERFORMANCE_SAMPLE_MS * 4) reset('sampling_gap')
  lastTick = now
  const current = generation
  if (!suspended && !stopped) {
    const sample = await collector.collect()
    if (current === generation && !suspended && !stopped) {
      const types = new Map((main?.processes as { pid: number; type: string }[] | undefined)?.map(row => [row.pid, row.type]))
      if (sample.tree) for (const row of sample.tree.processes) row.type = types.get(row.pid) || 'ChildProcess'
      recorder.sample({ ...sample, mainHeartbeatAgeMs: Math.round(performance.now() - heartbeat), main })
      if (sample.at - lastCloudSample >= 60_000) {
        cloudSample('resource_sample', { ...sample, mainHeartbeatAgeMs: Math.round(performance.now() - heartbeat), main }, sample.at)
        lastCloudSample = sample.at
      }
    } else collector.reset()
  }
}

function schedule(): void {
  timer = setTimeout(() => {
    flight = tick().catch(() => { recorder.event('collection_failed', { errors: ['worker:unavailable'] }) })
      .finally(() => { if (!stopped) schedule() })
  }, PERFORMANCE_SAMPLE_MS)
}

port.on('message', (message) => {
  if (stopped) return
  if (message.kind === 'main_sample') { main = { ...message.data, at: Date.now() }; heartbeat = performance.now() }
  else if (message.kind === 'suspend' || message.kind === 'resume') {
    suspended = message.kind === 'suspend'
    reset(message.kind)
  } else if (message.kind === 'close') {
    stopped = true
    clearTimeout(timer)
    void Promise.resolve(flight).then(() => recorder.close()).finally(() => port.close())
  } else {
    recorder.event(message.kind, message.data)
    if (['startup','startup-ui','main_stall','renderer_stall','renderer_unresponsive','renderer_gone','frame_stalled'].includes(message.kind)) cloudSample(message.kind, message.data)
  }
})
schedule()
