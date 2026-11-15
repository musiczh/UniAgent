import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import * as TOML from '@iarna/toml'
import { appServerTransportConfig, parseCodexConfig } from './codexSourceConfig'
import { AppServerRpcClient, type AppServerRpcFactory } from './appServerTransport'
import { codexAppServerArgs, titleGenerationConfig } from './appServerAdapter'
import { codexSessionProvider, codexWireModel } from '../shared/codexModelIdentity'
import type { AgentDef, Attachment, ReasoningEffort, SessionConfig } from '../shared/types'

export function requirementExtractionUnsupported(agent?: Pick<AgentDef, 'adapter' | 'installed' | 'incompatible' | 'lifecycle'>): string | undefined {
  if (!agent || agent.installed === false || agent.incompatible || agent.lifecycle && agent.lifecycle.availability !== 'available') return '当前执行方不可用，保留待整理状态'
  if (agent.adapter !== 'codex') return '当前执行方尚无已验证的无工具后台提取能力；本轮 Agent 可按维护规范提交，未自动切换其他模型'
}

/** Reuses the Codex app-server protocol with a tool-free model catalog. */
export async function extractRequirementText(agent: AgentDef, config: SessionConfig, prompt: string, signal: AbortSignal,
  factory: AppServerRpcFactory = options => new AppServerRpcClient(options),
  options: { timeoutMs?: number; outputSchema?: Record<string, unknown>; maxOutputChars?: number; label?: string; systemPrompt?: string; effort?: ReasoningEffort; modelProvider?: string; images?: Attachment[]; onUsage?: (usage: Record<string, any>) => void; retainDirectory?: (path: string, cleanup: () => Promise<void>) => Promise<void>; session?: { directory: string; threadId?: string; onThread: (id: string) => Promise<void> } } = {}): Promise<string> {
  if (requirementExtractionUnsupported(agent)) throw new Error('requirement_extraction_unsupported')
  const directory = options.session?.directory || await mkdtemp(join(tmpdir(), 'uniagent-requirement-extract-'))
  let rpc: ReturnType<AppServerRpcFactory> | undefined
  try {
    if (signal.aborted) throw new Error('requirement_extraction_cancelled')
    const home = join(directory, 'codex')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const nativeHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    const nativeConfig = parseCodexConfig(await readFile(join(nativeHome,'config.toml'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error}))
    const nativeProvider = !config.modelSource || config.modelSource.kind === 'native' ? nativeConfig.model_provider : undefined
    await writeFile(join(home,'config.toml'),TOML.stringify(appServerTransportConfig(nativeConfig,nativeProvider)),{mode:0o600})
    await copyFile(join(nativeHome, 'auth.json'), join(home, 'auth.json')).catch(error=>{if(error.code!=='ENOENT')throw error})
    const args = codexAppServerArgs(agent, config)
    const override = args.find(arg => arg.startsWith('model_catalog_json='))
    const catalogPath = override ? JSON.parse(override.slice('model_catalog_json='.length)) : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json')
    let catalog = await readFile(catalogPath, 'utf8').then(JSON.parse).catch(error => { if (!override && error.code === 'ENOENT') return { models: [] }; throw error })
    let model = (catalog.models || []).find((entry: any) => entry.slug === codexWireModel(config))
    if (!model && !override && !codexSessionProvider(config.modelSource)) {
      // The global cache can belong to another account/provider. Query the exact
      // native account into the isolated home; never switch the selected model.
      const probe = factory({ bin: agent.bin, args: ['app-server', ...args], cwd: directory, env: { ...process.env, CODEX_HOME: home }, timeoutMs: 20000 })
      try {
        await probe.start()
        await probe.request('initialize', { clientInfo: { name: 'uniagent-requirement-catalog', version: '1.0.0' }, capabilities: { experimentalApi: true } })
        probe.notify('initialized', {})
        await probe.request('model/list', {})
        catalog = JSON.parse(await readFile(join(home, 'models_cache.json'), 'utf8'))
        model = (catalog.models || []).find((entry: any) => entry.slug === codexWireModel(config))
      } finally { await probe.dispose() }
    }
    if (!model) throw new Error('所选模型缺少受限能力目录，未启动后台提取')
    const { apply_patch_tool_type, ...entry } = model
    const restrictedCatalog = join(directory, 'models.json')
    await writeFile(restrictedCatalog, JSON.stringify({ models: [{ ...entry, shell_type: 'disabled', experimental_supported_tools: [], additional_tools: [], supports_search_tool: false }] }), { mode: 0o600 })
    const restrictions: Record<string, unknown> = { ...titleGenerationConfig([]), model_catalog_json: restrictedCatalog,
      ...(options.session ? { model_auto_compact_token_limit: 16000 } : {}),
      'agents.enabled': false, 'features.skills': false, 'features.orchestrator_mcp': false, 'features.cloud_skill': false,
      'features.stable_environment_tools': false, 'features.context_management': false, 'features.remote_plugin': false,
      'features.sleep_tool': false, 'features.token_budget': false, 'features.send_message_to_user_async': false }
    rpc = factory({ bin: agent.bin, args: ['app-server', ...args, ...Object.entries(restrictions).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)])], cwd: directory,
      env: { ...process.env, CODEX_HOME: home }, timeoutMs: 20000 })
    const client = rpc
    let threadId: string | undefined
    const messages = new Map<string, string>()
    let resolve!: (text: string) => void, reject!: (error: Error) => void
    const done = new Promise<string>((ok, fail) => { resolve = ok; reject = fail })
    void done.catch(() => {})
    const abort = () => { reject(new Error('requirement_extraction_cancelled')); void client.dispose() }
    const fail = (message: string) => { reject(new Error(message)); void client.dispose() }
    const label = options.label || '需求后台提取'
    const timer = setTimeout(() => fail(label + '超时'), options.timeoutMs ?? 120000)
    timer.unref?.()
    signal.addEventListener('abort', abort, { once: true })
    client.on('disconnect', () => reject(new Error(label + '进程提前退出')))
    client.on('serverRequest', message => {
      client.respond(message.id, { decision: 'decline', success: false })
      fail('后台提取请求了未授权工具或交互')
    })
    client.on('notification', (method: string, params: any) => {
      if (threadId && params?.threadId && params.threadId !== threadId) return
      if (method === 'thread/tokenUsage/updated' && params?.tokenUsage?.last) {
        options.onUsage?.(params.tokenUsage.last)
      }
      if (method === 'error' && params?.willRetry !== true) fail(label + '模型执行失败')
      if (method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(params?.item?.type)) fail('后台提取出现未授权工具')
      if (method === 'item/agentMessage/delta') messages.set(params.itemId || 'last', (messages.get(params.itemId || 'last') || '') + (params.delta || ''))
      if (method === 'item/completed' && params?.item?.type === 'agentMessage') messages.set(params.item.id || 'last', params.item.text || '')
      if (options.maxOutputChars && [...messages.values()].reduce((size, text) => size + text.length, 0) > options.maxOutputChars) fail(label + '输出过长')
      if (method === 'turn/completed') params?.turn?.status === 'completed' ? resolve([...messages.values()].at(-1) || '') : fail(label + '未完成')
    })
    try {
      await client.start()
      if (signal.aborted) throw new Error('requirement_extraction_cancelled')
      await client.request('initialize', { clientInfo: { name: 'uniagent-requirement-extract', version: '1.0.0' }, capabilities: { experimentalApi: true } })
      client.notify('initialized', {})
      const started = await client.request<any>(options.session?.threadId ? 'thread/resume' : 'thread/start', { ...(options.session?.threadId ? { threadId: options.session.threadId } : {}), cwd: directory, model: codexWireModel(config),
        ...((options.modelProvider || codexSessionProvider(config.modelSource)) ? { modelProvider: options.modelProvider || codexSessionProvider(config.modelSource) } : {}),
        approvalPolicy: 'never', sandbox: 'read-only', ...(options.systemPrompt ? { developerInstructions: options.systemPrompt } : {}), ...(options.session?.threadId ? {} : { ephemeral: !options.session }), threadSource: 'system', environments: [], selectedCapabilityRoots: [], dynamicTools: [], config: restrictions })
      threadId = started?.thread?.id
      if (!threadId || signal.aborted) throw new Error('requirement_extraction_cancelled')
      if (options.session) await options.session.onThread(threadId)
      if (options.images?.length && Array.isArray(model.input_modalities) && !model.input_modalities.includes('image')) throw new Error('所选模型原生目录不支持图片输入')
      const images = options.images || []
      await client.request('turn/start', { threadId, environments: [], input: [{ type: 'text', text: prompt, text_elements: [] }, ...images.map(image => ({ type: 'localImage', path: image.path }))],
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}), ...(options.effort ? { effort: options.effort } : {}) })
      return await done
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  } finally {
    await rpc?.dispose()
    if (!options.session) {
      const cleanup = () => rm(directory, { recursive: true, force: true })
      if (options.retainDirectory) await options.retainDirectory(directory, cleanup)
      else await cleanup()
    }
  }
}
