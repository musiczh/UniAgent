import { createHmac, randomUUID } from 'node:crypto'
import { monitorMachineKey, monitorPerformancePayload, redactMonitorText, validateMonitorRecord, type MonitorRecord } from '../shared/cloudMonitor'

export interface MonitorFeedback {
  requestId: string; attemptId?: string; revision: number; savedAt: number; matches: boolean; reason?: string
  actualAction?: string; expectedKind?: string
}

export class MonitorRecordFactory {
  constructor(private appVersion: string, private distribution: 'internal' | 'public', private salt: string) {}
  private record(category: MonitorRecord['category'], at: number, code: string, level: MonitorRecord['level'], agent: string, payload: MonitorRecord['payload'], eventId: string = randomUUID()): MonitorRecord | undefined {
    const result: MonitorRecord = { schemaVersion: 1, eventId, category, occurredAt: at, distribution: this.distribution,
      appVersion: this.appVersion, agentId: monitorMachineKey(agent, 'app'), code: monitorMachineKey(code, 'unknown'), level, payload }
    return validateMonitorRecord(result) ? result : undefined
  }
  diagnostic(data: { ts: number; code: string; level: 'warn' | 'error'; agentId: string; source: string; message: string; count: number }): MonitorRecord | undefined {
    return this.record('diagnostic', data.ts, data.code, data.level, data.agentId, {
      message: redactMonitorText(data.message), source: redactMonitorText(data.source, 100), count: data.count
    })
  }
  performance(kind: string, data: Record<string, unknown>, at: number): MonitorRecord | undefined {
    return this.record('performance', at, kind, /stall|unresponsive|gone/.test(kind) ? 'warn' : 'info', 'app', monitorPerformancePayload(data))
  }
  feedback(data: MonitorFeedback): MonitorRecord | undefined {
    const digest = (text: string) => createHmac('sha256', this.salt).update(text).digest('hex')
    const requestKey = digest('request:' + data.requestId), attemptKey = digest('attempt:' + (data.attemptId || 'legacy'))
    const bytes = Buffer.from(digest(requestKey + ':' + attemptKey + ':' + data.revision).slice(0, 32), 'hex')
    bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128
    const hex = bytes.toString('hex')
    const eventId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
    return this.record('router_feedback', data.savedAt, 'router_feedback', 'info', 'app', {
      requestKey, attemptKey, revision: data.revision, matches: data.matches, actualAction: data.actualAction || 'unknown',
      ...(data.reason ? { reason: redactMonitorText(data.reason) } : {}), ...(data.expectedKind ? { expectedKind: data.expectedKind } : {})
    }, eventId)
  }
}
