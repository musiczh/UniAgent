import { open, readFile } from 'node:fs/promises'
import type { HistoryLoadProgress } from '../shared/types'

export type HistoryProgressCallback = (progress: HistoryLoadProgress) => void

/** Throttle intermediate updates to 50 ms and yield so IPC and other work can run. */
export function trackHistoryWork(
  phase: HistoryLoadProgress['phase'],
  total: number,
  onProgress?: HistoryProgressCallback
): (completed: number) => Promise<void> | undefined {
  let lastReportedAt = 0
  return (completed) => {
    const now = Date.now()
    if (completed !== 0 && completed !== total && now - lastReportedAt < 50) return
    lastReportedAt = now
    onProgress?.({ phase, completed, total })
    return new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** Bound the read to the opened file's size; later appended turns are a new snapshot. */
export async function readHistoryFile(
  file: string,
  onProgress?: HistoryProgressCallback,
  phase: 'reading' | 'reading-parent' = 'reading'
): Promise<Buffer> {
  if (!onProgress) return readFile(file)
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const report = trackHistoryWork(phase, size, onProgress)
    const buffer = Buffer.allocUnsafe(size)
    let completed = 0
    await report(0)
    while (completed < size) {
      const { bytesRead } = await handle.read(buffer, completed, Math.min(256 * 1024, size - completed), completed)
      if (!bytesRead) throw new Error('会话历史文件在读取期间发生变化，请重新打开')
      completed += bytesRead
      const pending = report(completed)
      if (pending) await pending
    }
    return buffer
  } finally {
    await handle.close()
  }
}
