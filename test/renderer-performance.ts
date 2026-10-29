import assert from 'node:assert/strict'
import { monitorRendererPerformance } from '../src/renderer/performanceMonitor'

const originals = Object.fromEntries(['window', 'document', 'performance', 'PerformanceObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let tick: () => void = () => {}
let observe: (entries: { getEntries(): { duration: number }[] }) => void = () => {}
let now = 0, hidden = false, cleared = false, disconnected = false
const reports: any[] = []
try {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { setInterval: (callback: () => void) => { tick = callback; return 1 },
      clearInterval: () => { cleared = true }, uniagent: { reportDiagnostic: async (issue: unknown) => { reports.push(issue) } } } },
    document: { configurable: true, value: { get hidden() { return hidden }, getElementsByTagName: (name: string) => ({ length: name === '*' ? 200 : 3 }) } },
    performance: { configurable: true, value: { now: () => now, memory: { usedJSHeapSize: 800 * 1024 ** 2 } } },
    PerformanceObserver: { configurable: true, value: class {
      static supportedEntryTypes = ['longtask']
      constructor(callback: typeof observe) { observe = callback }
      observe() {}
      disconnect() { disconnected = true }
    } }
  })
  const stop = monitorRendererPerformance()
  now = 30_000; tick()
  assert.equal(reports.length, 1, 'a growing heap must be recorded even without a long task')
  assert.equal(reports[0].code, 'renderer_performance_snapshot')
  assert.equal(reports[0].sample.heapBytes, 800 * 1024 ** 2)
  assert.equal(reports[0].sample.domNodes, 200)
  now = 40_000; tick()
  assert.equal(reports.length, 1, 'healthy snapshots are limited to once per 30 seconds')
  observe({ getEntries: () => [{ duration: 250 }] })
  now = 50_000; tick()
  assert.equal(reports[1].code, 'renderer_long_tasks')
  assert.equal(reports[1].sample.longestMs, 250)
  assert.equal(reports[1].sample.count, 1)
  hidden = true
  now = 80_000; tick()
  assert.equal(reports[2].sample.visible, false, 'hidden windows still report memory trends')
  stop()
  assert.ok(cleared && disconnected, 'page teardown must release the timer and observer')
} finally {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
}
console.log('renderer-performance: ok')
