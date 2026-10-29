import { randomUUID } from 'node:crypto'
import type { DiagnosticInput } from '../diagnostics'
import type { ZCodeModelService } from '../../shared/zcode'

export type ZCodeSetupReporter = (entry: DiagnosticInput) => void
export type ZCodeSetupFailure = 'invalid_input' | 'busy' | 'cancelled' | 'configuration' | 'runtime' | 'auth' | 'rate_limit'
  | 'http' | 'network' | 'timeout' | 'invalid_json' | 'invalid_models' | 'empty_list' | 'response_too_large' | 'business' | 'unknown'
export interface ZCodeRequestDiagnostic { httpStatus?: number; responseBytes?: number; reason: ZCodeSetupFailure }

const networkCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ZCODE_INSTALL_TIMEOUT', 'ZCODE_INSTALL_EXIT'])

/** Only allowlisted metadata is persisted; errors, credentials, bodies and process output stay out. */
export class ZCodeSetupTrace {
  private readonly startedAt = Date.now()
  private readonly operationId = randomUUID()
  private stages: { stage: string; elapsedMs: number }[] = []
  constructor(private operation: 'configuration' | 'installation', private report?: ZCodeSetupReporter,
    private service?: ZCodeModelService) { this.stage('preparing') }
  stage(stage: string): void { this.stages.push({ stage, elapsedMs: Date.now() - this.startedAt }) }
  fail(reason: ZCodeSetupFailure, error?: unknown, request?: ZCodeRequestDiagnostic): void {
    const stage = this.stages.at(-1)!.stage
    let errorCode: string | undefined
    let exitCode: number | undefined
    let cause = error
    for (let i = 0; i < 4 && cause instanceof Error; i++, cause = cause.cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (typeof code === 'string' && networkCodes.has(code)) {
        errorCode = code
        const exit = (cause as Error & { exitCode?: number }).exitCode
        if (typeof exit === 'number' && Number.isSafeInteger(exit) && exit >= 0 && exit <= 255) exitCode = exit
        break
      }
    }
    if (errorCode === 'ZCODE_INSTALL_TIMEOUT') reason = 'timeout'
    try {
      this.report?.({ category: 'app_runtime', agentId: 'zcode', source: `zcode-${this.operation}`,
        code: `zcode_${this.operation}_${reason}`, field: stage, level: reason === 'cancelled' || reason === 'busy' ? 'warn' : 'error',
        message: this.operation === 'configuration' ? 'ZCode 配置检测未完成' : 'ZCode 安装未完成',
        sample: { operationId: this.operationId, service: this.service, stage, stages: this.stages,
          elapsedMs: Date.now() - this.startedAt, reason, errorCode, exitCode,
          ...(request?.httpStatus !== undefined ? { httpStatus: request.httpStatus } : {}),
          ...(request?.responseBytes !== undefined ? { responseBytes: request.responseBytes } : {}) } })
    } catch { /* A diagnostic sink must never change installation or authorization results. */ }
  }
}
