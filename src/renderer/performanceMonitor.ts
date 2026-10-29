/** Aggregate slow tasks; include a heap sample every 30 seconds even without a stall. */
export function monitorRendererPerformance(): () => void {
  let count = 0
  let totalMs = 0
  let longestMs = 0
  let lastReportedAt = performance.now()
  const observer = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
    ? new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) { count++; totalMs += entry.duration; longestMs = Math.max(longestMs, entry.duration) }
    }) : undefined
  observer?.observe({ type: 'longtask', buffered: true })
  const timer = window.setInterval(() => {
    const now = performance.now()
    const stalled = !document.hidden && count > 0 && (longestMs >= 200 || totalMs >= 1000)
    if (!stalled && now - lastReportedAt < 30_000) { count = 0; totalMs = 0; longestMs = 0; return }
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    const sample = { count, totalMs: Math.round(totalMs), longestMs: Math.round(longestMs), visible: !document.hidden,
      domNodes: document.getElementsByTagName('*').length,
      frames: document.getElementsByTagName('iframe').length,
      ...(memory ? { heapBytes: memory.usedJSHeapSize } : {}) }
    count = 0; totalMs = 0; longestMs = 0
    lastReportedAt = now
    void window.uniagent.reportDiagnostic({ source: 'renderer-performance',
      code: stalled ? 'renderer_long_tasks' : 'renderer_performance_snapshot',
      level: 'warn', message: stalled ? '页面出现耗时任务' : '页面性能采样', sample }).catch(() => {})
  }, 10_000)
  return () => { window.clearInterval(timer); observer?.disconnect() }
}
