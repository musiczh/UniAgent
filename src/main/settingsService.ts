import type { AgentDef, AppSettings, AppSettingsPatch, TaskTitleGenerationConfig } from '../shared/types'
import type { AssistantDetail, AssistantInput, PersonalAssistant } from '../shared/assistant'
import { DISTRIBUTION_SETTINGS_CATEGORIES } from '../shared/settingsNavigation'
import { SETTINGS_SECTIONS, settingsObject, mergeSettingValue, validateSettingsFields, type SettingsSection, type SettingField, type SettingSchema } from '../shared/settingsDefinition'
import { parseRecoverySettings } from '../shared/sessionRecovery'
import { resolveTaskTitleConfig } from '../shared/taskTitle'
import { superAgentModels, superAgentUnavailable } from '../shared/superAgent'
import { routerModels, type RouterConfig } from '../shared/router'
import { manageRevision, publicManagementValue } from './assistant/manageValue'

export interface SettingsServiceDeps {
  appSettings(): AppSettings
  patchSettings(patch: AppSettingsPatch): AppSettings
  assistant(): Promise<AssistantDetail>
  saveAssistant(input: AssistantInput, edits: [], expectedConfig?: PersonalAssistant): Promise<AssistantDetail>
  agents(): AgentDef[]
  saveRouter?(config: RouterConfig, expectedVersion: number): Promise<unknown>
  recoveryErrors?(): unknown[] | Promise<unknown[]>
  modelSources?: { read(): Promise<Record<string, unknown>>; update(changes: Record<string, unknown>, expectedRevision: string): Promise<unknown> }
}
type Values = Record<string, unknown>
function record(value: unknown): Values {
  if (!settingsObject(value)) throw new Error('invalid_settings_patch: 需要 JSON 对象')
  return value
}
function resolvePath(path: unknown): { path: string; section?: SettingsSection; keys: string[]; schema?: SettingSchema } {
  if (typeof path !== 'string' || !/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/.test(path) || path.length > 1000) throw new Error('invalid_settings_path')
  const section = SETTINGS_SECTIONS.find(section => path === section.path || path.startsWith(section.path+'/'))
  const keys = section ? path.slice(section.path.length).split('/').filter(Boolean) : []
  let schema: SettingSchema | undefined = section && { type:'object',properties:section.fields }
  for (const key of keys) {
    if (!Object.hasOwn(schema?.properties || {},key)) throw new Error('settings_path_not_found: '+path)
    schema = schema!.properties![key]
  }
  if (!section && path !== '/' && !SETTINGS_SECTIONS.some(section => section.path.startsWith(path+'/')) && !DISTRIBUTION_SETTINGS_CATEGORIES.some(category => '/'+category.id === path)) throw new Error('settings_path_not_found: '+path)
  return { path,section,keys,schema }
}
function sectionValues(section: SettingsSection, source: Values): Values {
  const stored = section.key ? source[section.key] : source
  const value = settingsObject(stored) ? stored : {}
  return Object.fromEntries(Object.entries(section.fields).flatMap(([key,field]) => {
    const current = value[key] === undefined ? field.default : value[key]
    return current === undefined ? [] : [[key,current]]
  }))
}
export class SettingsService {
  constructor(private deps: SettingsServiceDeps) {}
  private async source(section: SettingsSection): Promise<Values> {
    if (section.store === 'model-sources') { if (!this.deps.modelSources) throw new Error('模型数据源服务不可用'); return this.deps.modelSources.read() }
    return section.store === 'app' ? this.deps.appSettings() as unknown as Values : (await this.deps.assistant()).assistant as unknown as Values
  }
  private options(schema: SettingSchema, section: SettingsSection, values: Values, recoveryErrors?: unknown[]): unknown[] | undefined {
    const superAgent = ['router','taskTitleGeneration','requirementCuration'].includes(section.key || '')
    const agents = this.deps.agents().filter(agent => (section.key !== 'sessionRecovery' || ['codex','claude'].includes(agent.adapter)) && (!superAgent || !superAgentUnavailable(agent)))
    const agentId = values.agentId ?? values.defaultAgentId
    const agent = agents.find(agent => agent.id === agentId)
    const models = agent ? section.key === 'router' ? routerModels(agent) : superAgent ? superAgentModels(agent) : agent.models : []
    const model = ['taskTitleGeneration', 'requirementCuration'].includes(section.key || '')
      ? resolveTaskTitleConfig({...values,enabled:true} as unknown as TaskTitleGenerationConfig,agents).modelDef
      : models.find(model => model.id === (values.model ?? values.defaultModel))
    switch (schema.options) {
      case 'agents': return agents.map(agent => ({ value:agent.id,label:agent.name }))
      case 'models': return models.map(model => ({ value:model.id,label:model.label,modelSource:model.modelSource }))
      case 'efforts': return model?.efforts.map(value => ({value})) || []
      case 'permissions': return agent?.capabilities.permissionModes.map(mode => ({value:mode.id,label:mode.label})) || []
      case 'thinking': return model?.thinkingOptions?.map(value => ({value})) || []
      case 'errors': return recoveryErrors || []
    }
  }
  private describe(schema: SettingSchema, section: SettingsSection, values: Values, recoveryErrors?: unknown[]): unknown {
    return { ...schema, choices:this.options(schema,section,values,recoveryErrors),
      ...(schema.type === 'array' ? { updateMode:'replace',items:schema.items && this.describe(schema.items,section,values,recoveryErrors) } : {}),
      ...(schema.properties ? { properties:Object.fromEntries(Object.entries(schema.properties).filter(([,child]) => !(child as SettingField).sensitive).map(([key,child]) =>
        [key,this.describe(child,section,settingsObject(values[key]) ? values[key] as Values : values,recoveryErrors)])) } : {}) }
  }
  async read(path: unknown = '/'): Promise<unknown> {
    const node = resolvePath(path)
    if (!node.section) {
      const prefix = node.path === '/' ? '/' : node.path+'/'
      const children = [...new Set([...(node.path === '/' ? DISTRIBUTION_SETTINGS_CATEGORIES.map(category => '/'+category.id) : []),
        ...SETTINGS_SECTIONS.filter(section => section.path.startsWith(prefix)).map(section => prefix+section.path.slice(prefix.length).split('/')[0])])]
      return { path:node.path,kind:'directory',...(!children.length ? {readOnly:true,description:'此分类使用设置页原有专用管理流程，当前没有通用 JSON 配置项。'} : {}),children:children.map(path => ({ path,kind:SETTINGS_SECTIONS.some(section => section.path === path) ? 'section' : 'directory',
        title:SETTINGS_SECTIONS.find(section => section.path === path)?.title || DISTRIBUTION_SETTINGS_CATEGORIES.find(category => '/'+category.id === path)?.label || path.split('/').at(-1) })) }
    }
    const section = node.section, source = await this.source(section), values = sectionValues(section,source)
    const recoveryErrors = section.key === 'sessionRecovery' ? await this.deps.recoveryErrors?.() : undefined
    let value: unknown = values
    let context = values
    for (const key of node.keys) { if (settingsObject(value)) context = value; value = settingsObject(value) ? value[key] : undefined }
    if ((node.schema as SettingField).sensitive) value = {configured:!!value}
    const revision = manageRevision(values)
    return publicManagementValue({ path:node.path,kind:node.keys.length ? 'field' : 'section',title:section.title,
      revision,value, schema:this.describe(node.schema!,section,context,recoveryErrors),
      updateMode:node.schema!.type === 'object' ? 'merge' : 'replace',
      children:node.schema?.properties ? Object.entries(node.schema.properties).map(([key,field]) => ({path:node.path+'/'+key,title:(field as SettingField).label || key,
        readOnly:!!(field as SettingField).readOnly,sensitive:!!(field as SettingField).sensitive})) : undefined })
  }
  confirmation(path: unknown, patch: unknown): string | undefined {
    const { section,keys } = resolvePath(path)
    if (!section) throw new Error('settings_directory_not_writable')
    const changes = keys.length ? { [keys[0]]:patch } : record(patch)
    return Object.entries(changes).some(([key,value]) => section.fields[key]?.confirmation === 'always' || section.fields[key]?.confirmation === 'enable' && value === true)
      ? '请确认设置中的权限或自动更新变更。' : undefined
  }
  legacyConfirmation(store: unknown, patch: Values): string | undefined {
    for (const section of SETTINGS_SECTIONS.filter(section => section.store === store)) {
      const changes = section.key ? patch[section.key] : patch
      if (settingsObject(changes) && Object.entries(changes).some(([key,value]) => section.fields[key]?.confirmation === 'always' || section.fields[key]?.confirmation === 'enable' && value === true)) return '请确认设置中的权限或自动更新变更。'
    }
  }
  async update(path: unknown, patch: unknown, expectedRevision: unknown): Promise<unknown> {
    const node = resolvePath(path)
    if (!node.section) throw new Error('settings_directory_not_writable')
    const section = node.section
    const wrapped = node.keys.reduceRight<unknown>((value,key) => ({[key]:value}),patch)
    const changes = record(wrapped)
    validateSettingsFields(section.fields,changes,section.path)
    // No await between reading the authoritative values and applying the patch.
    if (section.store === 'model-sources') {
      if (!this.deps.modelSources || typeof expectedRevision !== 'string') throw new Error('模型数据源服务不可用')
      await this.deps.modelSources.update(changes, expectedRevision)
    } else if (section.store === 'app') {
      const current = this.deps.appSettings(), values = sectionValues(section,current as unknown as Values)
      if (typeof expectedRevision !== 'string' || manageRevision(values) !== expectedRevision) throw new Error('revision_conflict: 请重新读取设置')
      const next = mergeSettingValue(values,changes) as Values
      this.validateDomain(section,next,changes)
      if (section.key === 'router') {
        if (!this.deps.saveRouter) throw new Error('Router 设置服务不可用')
        await this.deps.saveRouter(next as unknown as RouterConfig,Number(values.version))
      } else {
        const partial = Object.fromEntries(Object.keys(changes).map(key => [key,changes[key] === null ? undefined : next[key]]))
        const appPatch = section.key ? { [section.key]:partial } : changes
        const stored = this.deps.patchSettings(appPatch as AppSettingsPatch)
        this.verify(section,next,stored as unknown as Values)
      }
    } else {
      const { assistant } = await this.deps.assistant(), values = sectionValues(section,assistant as unknown as Values)
      if (typeof expectedRevision !== 'string' || manageRevision(values) !== expectedRevision) throw new Error('revision_conflict: 请重新读取设置')
      const { id,createdAt,updatedAt,...config } = assistant
      const input = mergeSettingValue(config,changes) as AssistantInput
      this.validateDomain(section,input as unknown as Values,changes)
      const saved = await this.deps.saveAssistant(input,[],assistant)
      this.verify(section,mergeSettingValue(values,changes) as Values,saved.assistant as unknown as Values)
    }
    return this.read(node.path)
  }
  private verify(section: SettingsSection, expected: Values, saved: Values): void {
    const normalized = sectionValues(section,section.key ? {[section.key]:expected} : expected)
    if (manageRevision(sectionValues(section,saved)) !== manageRevision(normalized)) throw new Error('settings_not_applied: 设置未完整应用，请重新读取')
  }
  private validateDomain(section: SettingsSection, next: Values, changes: Values): void {
    const agents = this.deps.agents(), agent = agents.find(agent => agent.id === (next.agentId ?? next.defaultAgentId))
    const selectionChanged = ['agentId','model','modelSource','effort','kimiThinking','defaultAgentId','defaultModel','defaultEffort','defaultPermissionMode'].some(key => Object.hasOwn(changes,key))
    const checkSelection = selectionChanged || changes.enabled === true
    if (section.key === 'sessionRecovery') parseRecoverySettings(next)
    if (section.key === 'sessionRecovery' && next.enabled && checkSelection && !['codex','claude'].includes(agent?.adapter || '')) throw new Error('invalid_agentId: 该 Agent 不支持恢复判断')
    if (['router','taskTitleGeneration','requirementCuration'].includes(section.key || '') && checkSelection && (next.enabled || next.agentId)) {
      const reason = superAgentUnavailable(agent)
      if (reason) throw new Error((agent && (agent.capabilities.startupSystemPrompt || agent.capabilities.auxiliarySystemPrompt) && !superAgentModels(agent).length ? 'invalid_model: ' : 'invalid_agentId: ')+reason)
    }
    const title = ['taskTitleGeneration', 'requirementCuration'].includes(section.key || '') ? resolveTaskTitleConfig({ ...next,enabled:true } as unknown as TaskTitleGenerationConfig,agents) : undefined
    if (title && checkSelection && (next.model || next.enabled) && !title.enabled) throw new Error('invalid_model: '+title.reason)
    const needsAgent = section.store === 'assistant' || checkSelection && !!(next.agentId || next.defaultAgentId)
    if (needsAgent && !agent) throw new Error('invalid_agentId: 所选 Agent 不存在')
    const selectedModel = next.model ?? next.defaultModel
    if (checkSelection && selectedModel && (!agent || !agent.models.some(model => model.id === selectedModel))) throw new Error('invalid_model: 所选模型不存在')
    const model = title?.modelDef ?? agent?.models.find(model => model.id === selectedModel)
    if (checkSelection && next.effort && model && !model.efforts.some(effort => effort === next.effort)) throw new Error('invalid_effort: 模型不支持此思考强度')
    if (checkSelection && next.defaultEffort && model && !model.efforts.some(effort => effort === next.defaultEffort)) throw new Error('invalid_defaultEffort: 模型不支持此思考强度')
    if (next.defaultPermissionMode && !agent?.capabilities.permissionModes.some(mode => mode.id === next.defaultPermissionMode)) throw new Error('invalid_defaultPermissionMode')
    if (section.key === 'feishu' || section.key === 'assistantFeishu') {
      if (next.enabled && (!next.appId || !next.appSecret)) throw new Error('请先在飞书设置中完成机器人授权')
      if (next.idleThresholdSec !== 0 && Number(next.idleThresholdSec) < 10) throw new Error('invalid_idleThresholdSec: 允许 0 或 10～3600 秒')
      if (changes.defaultProjectId !== undefined) delete next.defaultWorkdir
    }
    if (changes.enabledAgentIds && (changes.enabledAgentIds as string[]).some(id => !agents.some(agent => agent.id === id))) throw new Error('invalid_enabledAgentIds')
    if (next.reviewRuntime) {
      const runtime = next.reviewRuntime as Values, executor = agents.find(agent => agent.id === runtime.agentId)
      if (!executor || runtime.model && !executor.models.some(model => model.id === runtime.model)) throw new Error('invalid_reviewRuntime')
    }
  }
  /** Existing callers share the definition instead of retaining a second whitelist. */
  async updateLegacy(store: 'app' | 'assistant', patch: Values, expectedRevision: unknown): Promise<unknown> {
    const source = store === 'app' ? this.deps.appSettings() : (await this.deps.assistant()).assistant
    if (typeof expectedRevision !== 'string' || manageRevision(source) !== expectedRevision) throw new Error('revision_conflict')
    const sections = SETTINGS_SECTIONS.filter(section => section.store === store)
    if (!Object.keys(patch).length) throw new Error('invalid_settings_patch: 不能提交空修改')
    const grouped = new Map<SettingsSection,Values>()
    for (const [key,value] of Object.entries(patch)) {
      const section = sections.find(section => section.key === key || !section.key && Object.hasOwn(section.fields,key))
      if (!section) throw new Error('settings_field_not_writable: '+key)
      grouped.set(section,section.key ? record(value) : {...grouped.get(section),[key]:value})
    }
    for (const [section,changes] of grouped) {
      validateSettingsFields(section.fields,changes,section.path)
      const next = mergeSettingValue(sectionValues(section,source as unknown as Values),changes) as Values
      this.validateDomain(section,next,changes)
    }
    if (store === 'app') {
      if ('router' in patch) throw new Error('Router 配置请使用 /requirement-tasks/router')
      return this.deps.patchSettings(patch as AppSettingsPatch)
    }
    const {id,createdAt,updatedAt,...config} = source as PersonalAssistant
    return this.deps.saveAssistant(mergeSettingValue(config,patch) as AssistantInput,[],source as PersonalAssistant)
  }
}
