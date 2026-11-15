import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as TOML from '@iarna/toml'
import { ACPConnection, type ACPConnectionOptions } from './acp/acpConnection'
import { acpLaunchArgs, acpOption, acpSelectValues } from './acp/acpProvider'
import { buildGrokSessionMeta } from './grokRoleConfig'
import { loadNativeCredentials, nativeCredentialEnv } from './agentSetupCredentials'
import type { AgentDef, Attachment, TaskTitleGeneratorRef } from '../shared/types'
import { buildTextPromptBlocks } from './acp/acpPromptBlocks'
import { taskTitleImageBlocks } from './taskTitleImages'
import { TRAEX_NATIVE_TOOLS } from './traexToolPolicy'

type TitleConnection = Pick<ACPConnection, 'initialize' | 'request' | 'on' | 'notify' | 'respondErrorAndFail' | 'protocolViolation' | 'closeAndWait'>
export interface TaskTitleAcpDependencies {
  systemPrompt?: string
  maxOutputChars?: number
  createAcp?: (options: ACPConnectionOptions) => TitleConnection
  timeoutMs?: number
  traexHome?: string
}

async function copyCredential(source: string, destination: string): Promise<void> {
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
  try { await copyFile(source, destination) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

export async function generateAcpTitle(agent: AgentDef, config: TaskTitleGeneratorRef, prompt: string, signal: AbortSignal,
  deps: TaskTitleAcpDependencies, usage: (input: unknown, output: unknown) => void, images: Attachment[] = []): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `uniagent-title-${agent.adapter}-`))
  let connection: TitleConnection | undefined, abort: (() => void) | undefined
  try {
    signal.throwIfAborted()
    const home = join(directory, 'native')
    await mkdir(home, { mode: 0o700 })
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
    for (const key of Object.keys(env)) if (key.startsWith('UNIAGENT_')) delete env[key]
    delete env.ELECTRON_RUN_AS_NODE
    let args: string[], meta: Record<string, unknown> | undefined
    if (agent.adapter === 'traex') {
      if (!deps.traexHome) throw new Error('TraeX 标题连接配置不可用')
      env.TRAE_HOME = deps.traexHome
      args = ['-c', 'model=' + JSON.stringify(config.model), '-c', 'default_permissions=":read-only"',
        ...(deps.systemPrompt ? ['-c', 'developer_instructions=' + JSON.stringify(deps.systemPrompt)] : []),
        ...['hooks', 'plugins', 'apps', 'memories', 'goals', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'unified_exec', 'code_mode', 'code_mode_only', 'browser_use',
          'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode_host', 'skill_search', 'task_v2', 'workspace_dependencies',
          'workspace_undo', 'codex_git_commit'].flatMap(feature => ['-c', `features.${feature}=false`]),
        '-c', 'web_search="disabled"', ...(config.effort ? ['-c', 'model_reasoning_effort=' + JSON.stringify(config.effort)] : []),
        'acp', 'serve', ...[...TRAEX_NATIVE_TOOLS, 'multi_agent_v1', 'tool_search'].flatMap(tool => ['--disallowed-tool', tool]),
        '--disabled-tool', 'AskUserQuestion', '--disabled-tool', 'request_user_input']
    } else if (agent.adapter === 'grok') {
      await loadNativeCredentials()
      Object.assign(env, nativeCredentialEnv('grok'))
      const native = process.env.GROK_HOME || join(homedir(), '.grok')
      await copyCredential(join(native, 'auth.json'), join(home, 'auth.json'))
      await copyCredential(join(native, 'models_cache.json'), join(home, 'models_cache.json'))
      let raw: Record<string, any> = {}
      try { raw = TOML.parse(await readFile(join(native, 'config.toml'), 'utf8')) as Record<string, any> }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await writeFile(join(home, 'config.toml'), TOML.stringify({ cli: { auto_update: false, use_leader: false },
        features: { managed_config: false, feedback: false, telemetry: false }, managed_mcps: { enabled: false },
        models: { default: config.model }, ...(raw.model?.[config.model] ? { model: { [config.model]: raw.model[config.model] } } : {}),
        ...(raw.endpoints ? { endpoints: raw.endpoints } : {}) }), { mode: 0o600 })
      env.GROK_HOME = home
      args = acpLaunchArgs('grok', { agentId: agent.id, workdir: directory })
      meta = buildGrokSessionMeta({ agentId: agent.id, workdir: directory,
        roleSnapshot: { id: 'uniagent-title', name: '任务标题', agentId: agent.id, permissionMode: 'ask', instructions: deps.systemPrompt || '', toolPolicy: { mode: 'allow-only', tools: [] } } })
    } else {
      const native = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')
      const raw = TOML.parse(await readFile(join(native, 'config.toml'), 'utf8')) as Record<string, any>
      const model = raw.models?.[config.model], provider = model && raw.providers?.[model.provider]
      if (!model || !provider) throw new Error('Kimi 标题模型原生配置不可用')
      await writeFile(join(home, 'config.toml'), TOML.stringify({ default_model: config.model,
        models: { [config.model]: model }, providers: { [model.provider]: provider } }), { mode: 0o600 })
      for (const file of ['credentials/kimi-code.json', 'oauth/kimi-code', 'device_id']) {
        await copyCredential(join(native, file), join(home, file))
      }
      const profile = join(directory, 'title-agent.md')
      await writeFile(profile, '---\nname: uniagent-title\ndescription: Task title generation\ntools: []\n---\n' + (deps.systemPrompt || 'Return only the JSON requested in the current prompt.') + '\n', { mode: 0o600 })
      env.KIMI_CODE_HOME = home
      args = ['--agent-file', profile, 'acp']
    }
    signal.throwIfAborted()
    let imageInput = false
    connection = (deps.createAcp || (options => new ACPConnection(options)))({ bin: agent.bin, args, cwd: directory, env,
      providerLabel: agent.name, validateInitialize: value => {
        if (value?.protocolVersion !== 1 || !value.agentCapabilities) throw new Error('标题 Agent ACP 协议不兼容')
        imageInput = value.agentCapabilities.promptCapabilities?.image === true
      } })
    const client = connection
    let sessionId = '', response = ''
    abort = () => { if (sessionId) client.notify('session/cancel', { sessionId }); void client.closeAndWait().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    client.on('request', (message: any) => client.respondErrorAndFail(message.id, -32000, '标题生成不允许工具或交互', new Error('标题生成出现未授权工具调用')))
    client.on('notification', (message: any) => {
      if (message.method !== 'session/update' || !sessionId || message.params?.sessionId !== sessionId) return
      const update = message.params.update
      if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) client.protocolViolation(new Error('标题生成出现未授权工具调用'))
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        response += update.content.text || ''
        if (response.length > (deps.maxOutputChars ?? 4096)) client.protocolViolation(new Error('标题输出过长'))
      }
    })
    await client.initialize(deps.timeoutMs ?? 20_000)
    signal.throwIfAborted()
    let state = await client.request('session/new', { cwd: directory, mcpServers: [], ...(meta ? { _meta: meta } : {}) }, deps.timeoutMs ?? 20_000)
    if (typeof state?.sessionId !== 'string' || !state.sessionId) throw new Error('标题 Agent 未返回独立会话标识')
    sessionId = state.sessionId
    const combinedTraexModel = agent.adapter === 'traex' && config.effort && !acpOption(state, 'thought_level')
    if (combinedTraexModel) {
      const modelId = `${config.model}/${config.effort}`
      if (!state.models?.availableModels?.some((row: any) => row.modelId === modelId)) throw new Error('标题 Agent 未声明所选模型或思考参数')
      // The native ACP session model selector applies the advertised combined
      // variant. Its response is an empty object, not configOptions.
      const applied = await client.request('session/set_model', { sessionId, modelId }, deps.timeoutMs ?? 20_000)
      if (!applied || typeof applied !== 'object' || Array.isArray(applied)) throw new Error('标题 Agent 未确认所选模型或思考参数')
      signal.throwIfAborted()
    }
    for (const [category, value] of combinedTraexModel ? [] : [['model', config.model], ['thought_level', agent.adapter === 'kimi' ? config.kimiThinking : config.effort]] as const) {
      if (!value) continue
      const option = acpOption(state, category)
      if (!option || !acpSelectValues(option.options).some(row => row.value === value)) throw new Error('标题 Agent 未声明所选模型或思考参数')
      if (option.currentValue !== value) {
        state = await client.request('session/set_config_option', { sessionId, configId: option.id, value }, deps.timeoutMs ?? 20_000)
        if (acpOption(state, category)?.currentValue !== value) throw new Error('标题 Agent 未确认所选模型或思考参数')
      }
      signal.throwIfAborted()
    }
    if (images.length && !imageInput) throw new Error('所选 Agent 实际协议不支持图片输入')
    const supportedImages = images
    const blocks = agent.adapter === 'grok' && supportedImages.length
      ? await buildTextPromptBlocks(prompt, supportedImages, { provider: 'grok', imageAttachments: true, fileAttachments: false, env })
      : [{ type: 'text', text: prompt }, ...await taskTitleImageBlocks(supportedImages, signal)]
    signal.throwIfAborted()
    const result = await client.request('session/prompt', { sessionId, prompt: blocks }, deps.timeoutMs ?? 20_000)
    signal.throwIfAborted()
    if (result?.stopReason !== 'end_turn' || !response.trim()) throw new Error('标题 Agent 回合未成功完成')
    const tokens = result._meta?.usage
    if (tokens) usage(tokens.inputTokens, tokens.outputTokens)
    return response
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    await connection?.closeAndWait()
    await rm(directory, { recursive: true, force: true })
  }
}
