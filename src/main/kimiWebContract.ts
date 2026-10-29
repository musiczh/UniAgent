import type { SessionAgentContract, SessionConfig } from '../shared/types.ts'
import { acquireKimiWebService, kimiWebEnvironment } from './kimiWebService.ts'
import { KimiWebError } from './kimiWebTransport.ts'
import { findKimiExecutable } from './kimiInstallation.ts'
import { KIMI_PERMISSION_VALUES } from './kimiRoleConfig.ts'

export const KIMI_WEB_PERMISSION_MODES = [
  { id: 'ask' as const, label: '请求批准', hint: '使用 Kimi manual 策略，需要确认的工具操作由你批准。' },
  { id: 'full-access' as const, label: '按需询问', hint: '使用 Kimi yolo 策略：普通操作自动执行，危险命令、敏感文件和计划审批仍会询问；问题由你回答。' },
  { id: 'unattended' as const, label: '全部自动', hint: '使用 Kimi auto 策略：工具审批、危险操作、计划退出和用户问题均由 Agent 自动处理。' }
]
export function kimiConnectionStatus(auth: any, rows: any[]): 'needs-auth' | 'needs-config' | 'ready' {
  const missingAuth = auth.managed_provider?.status === 'unauthenticated'
    && rows.every(row => row.provider === auth.managed_provider.name)
  if (missingAuth) return 'needs-auth'
  return auth.models_ready === true && rows.length > 0 ? 'ready' : 'needs-config'
}
export function kimiWebContract(rows: any[], status: any = {}, config?: SessionConfig): SessionAgentContract {
  const permission = status.permission === undefined ? config?.permissionMode || 'ask'
    : (Object.keys(KIMI_PERMISSION_VALUES) as Array<keyof typeof KIMI_PERMISSION_VALUES>).find(mode => KIMI_PERMISSION_VALUES[mode] === status.permission)
  if (!permission) throw new Error('Kimi 返回了不支持的权限模式，无法确认当前权限。')
  const models = rows.filter(row => typeof row.model === 'string').map(row => ({
    id: row.model, label: row.display_name || row.model, efforts: [],
    imageInput: row.capabilities?.includes('image_in') === true,
    contextWindow: row.max_context_size,
    thinkingOptions: row.support_efforts || [], defaultThinking: row.default_effort
  }))
  const current = models.find(model => model.id === status.model) || models[0]
  return {
    models, currentModelId: current?.id, permissionModes: KIMI_WEB_PERMISSION_MODES,
    currentPermissionMode: permission,
    imageAttachments: current?.imageInput ?? models.some(model => model.imageInput), fileAttachments: true,
    sessionList: true, sessionLoad: true, sessionResume: true, steer: true, followup: true,
    sessionFork: true, sessionForkAtTurn: false, crossAgentFork: false, sideChat: false,
    structuredSubagents: true, formElicitation: true, freeTextElicitation: false,
    nativeGoal: true, nativeReview: false, structuredUsage: true, capabilityInventory: false,
    additionalDirectoriesNew: false, additionalDirectoriesResume: false,
    commands: ['compact', 'status', 'usage', 'help', 'tasks', 'mcp'], collaborationModes: ['default', 'plan']
  }
}

/** Probe the host without creating a throwaway writable native session. */
export async function probeKimiWeb(bin = 'kimi', cwd = process.cwd(), extraEnv: NodeJS.ProcessEnv = {}): Promise<{
  status: 'uninstalled' | 'incompatible' | 'needs-auth' | 'needs-config' | 'ready'; path?: string; version?: string; contract?: SessionAgentContract; reason?: string
}> {
  const env = kimiWebEnvironment(extraEnv)
  const path = await findKimiExecutable(bin, env)
  if (!path) return { status: 'uninstalled', reason: '未找到官方 Kimi Code CLI，请打开“配置与安装”。' }
  let lease: Awaited<ReturnType<typeof acquireKimiWebService>> | undefined
  try {
    lease = await acquireKimiWebService({ bin: path, cwd, env })
    await lease.transport.verifyProtocol()
    const [auth, catalog] = await Promise.all([
      lease.transport.request<any>('GET', '/api/v1/auth'), lease.transport.request<any>('GET', '/api/v1/models')
    ])
    if (!Array.isArray(catalog.items)) throw new KimiWebError('model_catalog_invalid')
    const status = kimiConnectionStatus(auth, catalog.items)
    if (status !== 'ready') return { status, path, version: lease.version, reason: status === 'needs-auth'
      ? 'Kimi 账号尚未认证，或现有授权已失效；请登录后重新检测，不需要重复安装。'
      : '默认模型或 Provider 配置未就绪。请检查原生配置，或使用 Platform Key 配置模型连接。' }
    const configuration = await lease.transport.request<{ default_model?: string }>('GET', '/api/v1/config')
    return { status: 'ready', path, version: lease.version, contract: kimiWebContract(catalog.items, { model: configuration.default_model }) }
  } catch (error) {
    if (error instanceof KimiWebError && error.recovered) return probeKimiWeb(bin, cwd, extraEnv)
    return { status: 'incompatible', path, reason: error instanceof KimiWebError ? error.message : 'Kimi Web 服务检测失败' }
  } finally { await lease?.release() }
}
