import { APP_NAME, INTERNAL_DISTRIBUTION } from './distribution'
import { QUOTA_QUERY_TEMPLATES } from './modelSourceQuota'
import { COLOR_THEMES } from './colorThemes'
import { ALL_EFFORTS, DEFAULT_ENABLED_AGENT_IDS } from './types'
import { DEFAULT_ROUTER_CONFIG } from './router'
import { DISTRIBUTION_SETTINGS_CATEGORIES, DEFAULT_SIDEBAR_SHORTCUTS, MAX_SIDEBAR_SHORTCUTS } from './settingsNavigation'

export interface SettingSchema {
  type: 'boolean' | 'string' | 'integer' | 'array' | 'object'
  description?: string
  enum?: readonly (string | number)[]
  enumLabels?: Record<string,string>
  minimum?: number; maximum?: number; maxLength?: number; maxItems?: number
  items?: SettingSchema; properties?: Record<string, SettingSchema>; required?: string[]
  uniqueItems?: boolean; nullable?: boolean
  options?: 'agents' | 'models' | 'efforts' | 'permissions' | 'errors' | 'thinking'
}
export interface SettingField extends SettingSchema {
  label: string; description: string; default?: unknown
  readOnly?: boolean; sensitive?: boolean
  confirmation?: 'always' | 'enable'
}
export interface SettingsSection {
  path: string; title: string; description?: string
  store: 'app' | 'assistant' | 'model-sources'
  persistence?: 'native'
  /** Object-valued settings expose their properties as the section's fields. */
  key?: string
  fields: Record<string, SettingField>
}
const flag = (label: string, description: string, value: boolean): SettingField => ({ type: 'boolean', label, description, default: value })
const string = (label: string, description = '', extra: Partial<SettingField> = {}): SettingField => ({ type: 'string', maxLength: 4000, label, description, ...extra })
const agent = (): SettingField => string('Agent', '使用当前 Agent 目录中的稳定 ID。', { options: 'agents' })
const model = (): SettingField => string('模型', '使用当前 Agent 的模型 ID；更换 Agent 时同时选择模型。', { options: 'models' })
const effort = (): SettingField => string('思考强度', '使用所选模型支持的思考强度。', { options: 'efforts', enum:ALL_EFFORTS, nullable: true })
const feishuFields = (): Record<string,SettingField> => ({
  enabled: flag('启用飞书连接', '使用已完成授权的机器人连接。', false),
  appId: { ...string('App ID', '在飞书专用配置流程中绑定。', {default:''}), readOnly:true },
  appSecret: { ...string('App Secret', '仅显示是否已配置；通过飞书专用流程填写或重新授权。', {default:''}), readOnly:true, sensitive:true },
  notifyOnlyWhenLocked: flag('仅锁屏时通知', '锁屏时通过飞书通知任务进展。', true),
  idleThresholdSec: {type:'integer',label:'空闲通知阈值',description:'0 表示关闭空闲提醒；其余允许 10～3600 秒。',minimum:0,maximum:3600,default:300},
  autoRouteNewConversations: flag('自动归属新对话', '新飞书对话通过 RouterAgent 判断归属。', false),
  defaultAgentId: { ...agent(), nullable:true }, defaultModel: { ...model(), nullable:true }, defaultEffort: { ...effort(), nullable:true },
  defaultPermissionMode: { ...string('默认权限', '飞书新对话的执行权限。', {options:'permissions',nullable:true}), confirmation:'always' },
  defaultProjectId: string('默认空间', '现有空间的稳定 ID。', {nullable:true}), defaultWorkdir: string('默认工作目录', '由默认空间管理的目录。', {readOnly:true}),
  botName: {...string('机器人名称'),readOnly:true}, notifyChatId:{...string('通知对话'),readOnly:true}, notifyChatType:{...string('通知对话类型'),readOnly:true}, notifyChatName:{...string('通知对话名称'),readOnly:true}
})

/** Source of truth for settings discovery, controls, validation and editing. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { path: '/codex-sources/configuration', title: '模型数据源与生效范围', store: 'model-sources', fields: {
    sources: { type: 'array', label: '数据源', description: '来源数组整体替换；保留稳定 ID。凭据通过专用密码表单保存，地址变更也使用专用流程。', default: [], maxItems: 100, items: { type: 'object', required: ['id','name','preset','enabled','endpoints','models'], properties: {
      id: { type: 'string', maxLength: 100 }, name: { type: 'string', maxLength: 100 }, preset: { type: 'string', enum: ['deepseek','glm','mimo','ark-coding-plan','custom','kimi'] }, plan: { type: 'string', maxLength: 100 }, enabled: { type: 'boolean' },
      consoleUrl: { type: 'string', maxLength: 2000, description: '查看来源额度的 HTTPS 控制台地址；不得包含用户名、密码或凭据参数。留空使用官方入口。' },
      quotaQuery: { type: 'object', description: '额度查询配置；默认自动识别。查询凭据仅通过专用表单加密保存。', required: ['template'], properties: { template: { type: 'string', enum: QUOTA_QUERY_TEMPLATES.map(item => item.id) }, userId: { type: 'string', maxLength: 30, description: 'New API 用户 ID' }, unit: { type: 'string', enum: ['quota', 'USD', 'CNY'], description: '默认原始额度；金额单位需要站点换算比例。' }, quotaPerUnit: { type: 'integer', minimum: 1, maximum: 1000000000000000, description: '站点每单位金额对应的原始额度' } } },
      endpoints: { type: 'array', maxItems: 10, items: { type: 'object', required: ['id','protocol','baseUrl','auth'], properties: { id: { type: 'string', maxLength: 100 }, protocol: { type: 'string', enum: ['openai-chat','openai-responses','anthropic-messages'] }, baseUrl: { type: 'string', maxLength: 2000 }, auth: { type: 'string', enum: ['bearer','x-api-key','none'] } } } },
      models: { type: 'array', maxItems: 100, items: { type: 'object', required: ['id','label','routes'], properties: { id: { type: 'string', maxLength: 200 }, label: { type: 'string', maxLength: 200 }, maxContextWindow: { type: 'integer', minimum: 1, maximum: 10000000 }, routes: { type: 'array', maxItems: 10, items: { type: 'object', required: ['endpointId','upstreamModel'], properties: { endpointId: { type: 'string', maxLength: 100 }, upstreamModel: { type: 'string', maxLength: 200 } } } }, capabilities: { type: 'object', properties: { contextWindow: { type: 'integer', minimum: 1, maximum: 10000000 }, imageInput: { type: 'boolean' }, efforts: { type: 'array', maxItems: 20, items: { type: 'string', enum: ALL_EFFORTS } }, defaultEffort: { type: 'string', enum: ALL_EFFORTS }, thinkingOptions: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 100 } } } } } } }
    } } },
    quotaCredentialStatus: { type: 'array', label: '额度查询凭据状态', description: '只读；按来源返回凭据类型与是否已配置，不返回凭据内容。AK/SK 和访问令牌通过专用表单管理。', readOnly: true, items: { type: 'object', properties: { sourceId: { type: 'string' }, type: { type: 'string', enum: ['ak-sk', 'access-token', 'source-key'] }, configured: { type: 'boolean' } } } },
    bindings: { type: 'array', label: 'Agent 生效范围', description: '绑定数组整体替换；各 Agent 独立应用，模型与协议必须属于对应数据源。', default: [], maxItems: 3000, items: { type: 'object', required: ['sourceId','agentId','enabled','endpointId','modelIds'], properties: { sourceId: { type: 'string', maxLength: 100 }, agentId: { type: 'string', options: 'agents', maxLength: 100 }, enabled: { type: 'boolean' }, endpointId: { type: 'string', maxLength: 100 }, modelIds: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 200 } } } } }
  } },
  { path: '/general/updates', title: '应用更新', store: 'app', fields: {
    autoCheckUpdate: flag('自动检查更新', '启动时后台检查' + (INTERNAL_DISTRIBUTION ? ' Bits 版本目录' : ' GitHub 公开版本'), true)
  } },
  { path: '/general/appearance', title: '颜色风格', store: 'app', fields: {
    theme: string('界面配色', '选择喜欢的颜色风格，应用到整个工作台。', { default: 'system', enum: ['system','dark','light',...COLOR_THEMES.map(theme => theme.id)] })
  } },
  { path: '/general/worktree', title: '工作树', store: 'app', fields: {
    defaultTaskWorktree: flag('新任务默认使用工作树', '在 Git 仓库中新建任务时，自动勾选工作树，来源默认为仓库当前分支。', false),
    autoSyncWorktree: flag('提交后自动同步回源分支', '将工作树中的新提交合并回本机源分支；有未提交改动或冲突时暂停并提示。', false)
  } },
  { path: '/general/notifications', title: '通知', store: 'app', fields: {
    notificationMode: string('桌面通知', '任务完成、失败、提问或等待批准时发送 macOS 通知', { default: 'unfocused', enum: ['unfocused','always','off'], enumLabels:{unfocused:`离开 ${APP_NAME} 时通知`,always:'始终通知',off:'关闭通知'} })
  } },
  { path: '/general/power', title: '电源', store: 'app', fields: {
    preventSleep: flag('防止电脑休眠', `${APP_NAME} 运行期间阻止电脑自动休眠，屏幕仍可熄灭；关闭开关或退出应用后恢复。`, false)
  } },
  { path: '/general/files', title: '文件浏览与审查', store: 'app', fields: {
    coverSidebar: flag('默认覆盖左侧侧栏', '打开文件浏览器或代码审查时是否直接铺满整个窗口；关闭则保留左侧会话侧栏。可在标题栏按钮随时切换。', false)
  } },
  { path: '/general/sidebar', title: '侧栏样式', store: 'app', fields: {
    spaceRequirementSidebar: flag('按项目和需求组织侧栏', '开启后只显示项目与需求；关闭后恢复现有会话列表。', true),
    sidebarShortcuts: { type: 'array', label: '侧栏快捷入口', description: '按设置菜单顺序显示；空数组隐藏全部快捷入口。', default: [...DEFAULT_SIDEBAR_SHORTCUTS], maxItems: MAX_SIDEBAR_SHORTCUTS, uniqueItems: true,
      items: { type: 'string', enum: DISTRIBUTION_SETTINGS_CATEGORIES.map(category => category.id) } }
  } },
  { path: '/general/recovery', title: '会话错误恢复', store: 'app', key: 'sessionRecovery', persistence:'native', fields: {
    enabled: flag('自动恢复失败会话', '发生错误后判断是否值得重试；仅对投递状态明确且支持接续的会话恢复。', false),
    agentId: { ...agent(), default: '', maxLength: 100 }, model: { ...model(), default: '', maxLength: 1000 },
    maxRetries: { type: 'integer', label: '最多重试次数', description: '每次恢复链路的重试上限。', minimum: 1, maximum: 10, default: 3 },
    initialDelaySeconds: { type: 'integer', label: '初始等待秒数', description: '重试间隔按已有退避策略递增。', minimum: 5, maximum: 120, default: 30 },
    selectedErrors: { type: 'array', label: '已选择的错误类型', description: '错误类型稳定 ID；运行时获取已出现的错误目录。', maxItems: 100, uniqueItems: true, default: [], items: { type: 'string', maxLength: 200, options: 'errors' } },
    rules: { type: 'array', label: '自然语言规则', description: '数组整体替换；同时命中时“不重试”优先。', maxItems: 50, default: [], items: { type: 'object', required: ['id','effect','description','enabled'], properties: {
      id: { type: 'string', maxLength: 100 }, effect: { type: 'string', enum: ['retry','no-retry'] }, description: { type: 'string', maxLength: 2000 }, enabled: { type: 'boolean' }
    } } }
  } },
  { path: '/requirements/preferences', title: '需求', store: 'app', fields: {
    requirementsEnabled: flag('启用需求', '关闭后不再使用需求功能：新建任务不再显示需求选择，会话不再同步需求上下文；已有需求数据与会话关联完整保留。', false)
  } },
  { path: '/agent/preferences', title: 'Agent', store: 'app', fields: {
    enabledAgentIds: { type: 'array', label: '启用的 Agent', description: '新任务执行方菜单中显示的 Agent。', default: [...DEFAULT_ENABLED_AGENT_IDS], uniqueItems: true, items: { type: 'string', options: 'agents' } },
    autoUpdateAgentsOnLaunch: { ...flag('启动时自动更新 Agent', '启动后检查并更新 Agent。', false), confirmation: 'enable' },
    autoUpdateAgentsWhenIdle: { ...flag('空闲时自动更新 Agent', '没有待处理或运行任务五分钟后更新启用的 Agent。', false), confirmation: 'enable' }
  } },
  { path: '/requirement-tasks/title', title: '任务标题', store: 'app', key: 'taskTitleGeneration', persistence:'native', fields: {
    enabled: flag('自动生成任务标题', '使用所选模型生成任务标题与精简描述。', false), agentId: { ...agent(), nullable: true }, model: { ...model(), nullable: true }, effort: effort(),
    kimiThinking: string('Thinking', 'Kimi 模型的原生 Thinking 选项。', { options: 'thinking', nullable: true }),
    modelSource: { type: 'object', label: '模型来源', description: '模型目录返回的来源标识；null 清除选择。', nullable: true, required: ['kind'], properties: {
      kind: { type: 'string', enum: ['native','third-party','local'] }, sourceId: { type: 'string', maxLength: 200 }
    } }
  } },
  { path: '/requirement-tasks/replies', title: '快捷回复', store: 'app', fields: {
    quickRepliesEnabled: flag('快捷回复', '使用任务标题模型生成后续回复建议。', false)
  } },
  { path: '/requirement-tasks/curation', title: '需求后台整理', store: 'app', key: 'requirementCuration', persistence:'native', fields: {
    enabled: flag('启用后台整理', '每个需求复用一个整理 Session，多个事件依次排队；关闭时保留队列。', false),
    agentId: { ...agent(), nullable: true }, model: { ...model(), nullable: true }, effort: effort(),
    kimiThinking: string('Thinking', '所选模型的原生 Thinking 选项。', { options: 'thinking', nullable: true }),
    modelSource: { type: 'object', label: '模型来源', description: '使用所选模型来源；保存后从下一整理项生效。', nullable: true, required: ['kind'], properties: {
      kind: { type: 'string', enum: ['native','third-party','local'] }, sourceId: { type: 'string', maxLength: 200 }
    } }
  } },
  { path: '/requirement-tasks/router', title: 'RouterAgent', store: 'app', key: 'router', persistence:'native', fields: {
    enabled: flag('启用 RouterAgent', '默认关闭；启用后，新输入进入同一段 Router 对话排队。', false),
    agentId: { ...agent(), default: DEFAULT_ROUTER_CONFIG.agentId }, model: { ...model(), default: DEFAULT_ROUTER_CONFIG.model }, effort: { ...effort(), default: DEFAULT_ROUTER_CONFIG.effort },
    version: { type: 'integer', label: '配置版本', description: '由 Router 保存服务递增。', readOnly: true, default: 1 }
  } },
  { path: '/assistants/preferences', title: '个人助手', store: 'assistant', fields: {
    enabled: flag('启用个人助手', '启用助手身份、记忆与管理能力。', false), defaultAgentId: agent(),
    defaultModel: { ...model(), nullable: true }, defaultPermissionMode: { ...string('默认权限', '新助手会话的执行权限。', { options: 'permissions', nullable: true }), confirmation: 'always' },
    defaultWorkdir: string('默认工作目录', '绝对路径；null 恢复默认目录。', { nullable: true }),
    autoReviewEnabled: flag('自动复盘', '空闲后通过受限任务维护长期记忆。', false),
    reviewRuntime: { type: 'object', label: '复盘执行方', description: 'null 沿用前台执行方；由实际支持受限复盘的 Agent 执行。', nullable: true, required: ['agentId'], properties: {
      agentId: { type: 'string', options: 'agents' }, model: { type: 'string', options: 'models' }
    } }
  } },
  { path: '/assistants/feishu', title: '飞书远程控制', store: 'app', key:'feishu', persistence:'native', fields:feishuFields() },
  { path: '/assistants/assistant-feishu', title: '个人助手机器人', store: 'app', key:'assistantFeishu', persistence:'native', fields:feishuFields() }
]

export function settingSection(path: string): SettingsSection {
  const section = SETTINGS_SECTIONS.find(section => section.path === path)
  if (!section) throw new Error('settings_path_not_found: ' + path)
  return section
}
export function settingsObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function validateSetting(schema: SettingSchema, value: unknown, path: string, partial = false): void {
  const fail = (reason: string): never => { throw new Error(`invalid_${path}: ${reason}`) }
  if (value === null && schema.nullable) return
  if (schema.enum && !schema.enum.includes(value as string)) fail('不在可选值中')
  if (schema.type === 'boolean' && typeof value !== 'boolean') fail('需要 boolean')
  if (schema.type === 'string' && (typeof value !== 'string' || value.includes('\0') || value.length > (schema.maxLength ?? 4000))) fail('文本无效或过长')
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || Number(value) < (schema.minimum ?? -Infinity) || Number(value) > (schema.maximum ?? Infinity))) fail('整数超出范围')
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 1000)) fail('数组无效或过长')
    const items = value as unknown[]
    if (schema.uniqueItems && new Set(items.map(item => JSON.stringify(item))).size !== items.length) fail('包含重复项')
    items.forEach((item, index) => { if (schema.items) validateSetting(schema.items, item, `${path}[${index}]`) })
  }
  if (schema.type === 'object') {
    if (!settingsObject(value)) fail('需要 object')
    const object = value as Record<string, unknown>
    if (!partial && schema.required?.some(key => object[key] === undefined)) fail('缺少必填字段')
    for (const [key, child] of Object.entries(object)) {
      if (!Object.hasOwn(schema.properties || {}, key)) fail('未知字段 ' + key)
      validateSetting(schema.properties![key], child, path + '.' + key, partial)
    }
  }
}

export function validateSettingsFields(fields: Record<string,SettingField>, patch: Record<string,unknown>, path: string, internal = false): void {
  if (!Object.keys(patch).length) throw new Error('invalid_settings_patch: 不能提交空修改')
  for (const [key,value] of Object.entries(patch)) {
    const field = Object.hasOwn(fields,key) ? fields[key] : undefined
    if (!field || !internal && (field.readOnly || field.sensitive)) throw new Error('settings_field_not_writable: '+path+'/'+key)
    if (value === undefined && field.nullable && internal) continue
    validateSetting(field,value,key,true)
  }
}

/** Both UI writes and MCP edits use the registered field constraints. */
export function validateDefinedAppPatch(patch: Record<string,unknown>): void {
  for (const [key,value] of Object.entries(patch)) {
    const section = SETTINGS_SECTIONS.find(section => section.store === 'app' && (section.key === key || !section.key && Object.hasOwn(section.fields,key)))
    if (!section) throw new Error('settings_field_not_writable: '+key)
    if (section.key && value === null && ['taskTitleGeneration','requirementCuration','feishu','assistantFeishu'].includes(key)) continue
    if (section.key && !settingsObject(value)) throw new Error('invalid_'+key)
    validateSettingsFields(section.fields,section.key ? value as Record<string,unknown> : {[key]:value},section.path,true)
  }
}

export function mergeSettingValue(current: unknown, patch: unknown): unknown {
  if (!settingsObject(patch)) return patch
  const result = { ...(settingsObject(current) ? current : {}) }
  for (const [key,value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = settingsObject(value) ? mergeSettingValue(result[key],value) : value
  }
  return result
}

/** Registered JSON fields persist automatically; native domains retain their services. */
export function definedAppValues(value: Record<string, unknown>, fallback: Record<string, unknown> = {}): Record<string, unknown> & {autoUpdateAgentsOnLaunch:boolean;autoCheckUpdate:boolean} {
  const fields = SETTINGS_SECTIONS.filter(section => section.store === 'app' && section.persistence !== 'native').flatMap<[string,SettingField]>(section =>
    section.key ? [[section.key,{type:'object',properties:section.fields,label:section.title,description:section.description || '',
      default:Object.fromEntries(Object.entries(section.fields).filter(([,field]) => field.default !== undefined).map(([key,field]) => [key,field.default]))}]]
      : Object.entries(section.fields))
  return Object.fromEntries(fields.map(([key,field]) => {
    const incoming = settingsObject(value[key]) ? mergeSettingValue(fallback[key] ?? field.default,value[key]) : value[key]
    for (const candidate of [incoming,fallback[key],field.default]) {
      try { validateSetting(field,candidate,key); return [key,structuredClone(candidate)] } catch { /* Read legacy values using defaults. */ }
    }
    return [key,undefined]
  })) as Record<string,unknown> & {autoUpdateAgentsOnLaunch:boolean;autoCheckUpdate:boolean}
}

export const SETTINGS_TOOL = {
  name: 'uniagent_settings',
  description: '设置页统一入口，只有 action 和 params 两个参数。read 从 path="/" 的目录逐层读取，再按返回路径读取字段说明、当前值、默认值、约束、动态可选值和 revision；不要猜字段。update 的 params={path,patch,expectedRevision,operationId}，patch 为 JSON 局部修改，数组整体替换；先读取，使用稳定 UUID，重复请求沿用同一 ID。结果返回实际值或宿主确认卡片；确认后 read(params={operationId}) 读取回执。凭据与授权使用目录注明的专用流程，查询信息不是授权。',
  inputSchema: { type: 'object', properties: { action: { enum: ['read','update'] }, params: { type: 'object' } }, required: ['action','params'], additionalProperties: false }
}
