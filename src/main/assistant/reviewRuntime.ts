import { prepareClaudeSourceRuntime } from '../claudeSourceRuntime'
import { readClaudeEnv } from '../agents'
import { mkdtemp, mkdir, copyFile, rm, writeFile, readFile, chmod } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeSdkClient } from '../claudeSdk'
import { AppServerRpcClient } from '../appServerTransport'
import { codexAppServerArgs, titleGenerationConfig } from '../appServerAdapter'
import { codexSessionProvider, codexWireModel } from '../../shared/codexModelIdentity'
import { ensureHandoffServer } from '../handoff'
import { ASSISTANT_REVIEW_TOOLS, assistantMcpEnv, type AssistantScope } from './mcp'
import type { AgentDef, SessionConfig } from '../../shared/types'

export function reviewCapability(agent?: Pick<AgentDef, 'adapter' | 'installed' | 'incompatible' | 'lifecycle'>): { supported: boolean; reason?: string } {
  if (!agent || agent.installed === false || agent.incompatible || (agent.lifecycle && agent.lifecycle.availability !== 'available')) return { supported: false, reason: '复盘 Agent 当前不可用，请在设置中检查执行方' }
  if (agent.adapter === 'codex' || agent.adapter === 'claude') return { supported: true }
  return { supported: false, reason: '当前执行方未具备已核实的工具限制，请单独选择 Codex 或 Claude Code 进行复盘' }
}
const overrideArgs = (values: Record<string, unknown>) => Object.entries(values).flatMap(([key,value]) => ['-c', `${key}=${JSON.stringify(value)}`])

export async function runReviewRuntime(agent: AgentDef, config: SessionConfig, prompt: string, scope: AssistantScope, signal: AbortSignal,
  call: (tool: string, args: any) => Promise<unknown>): Promise<void> {
  if (!reviewCapability(agent).supported) throw new Error('review_runtime_unsupported')
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-memory-review-'))
  try {
    if (signal.aborted) throw new Error('stale_review')
    if (agent.adapter === 'codex') {
      const home = join(directory, 'codex')
      await mkdir(home, { mode: 0o700 })
      // Copy only authentication metadata, never user rules, plugins or tools.
      await copyFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), join(home, 'auth.json')).catch(() => {})
      const runtimeArgs = codexAppServerArgs(agent, config)
      const catalog = await restrictedCodexCatalog(runtimeArgs, config, directory)
      if (signal.aborted) throw new Error('stale_review')
      const restrictions = { ...titleGenerationConfig([]), 'model_catalog_json': catalog,
        'features.stable_environment_tools': false, 'features.sleep_tool': false, 'features.token_budget': false,
        'features.context_management': false, 'features.send_message_to_user_async': false, 'features.remote_plugin': false,
        'agents.enabled': false, 'features.skills': false, 'features.orchestrator_mcp': false, 'features.cloud_skill': false, 'features.psp': false, 'features.enable_fanout': false }
      await chmod(join(home, 'auth.json'), 0o600).catch(() => {})
      const rpc = new AppServerRpcClient({ bin: agent.bin, args: ['app-server', ...runtimeArgs, ...overrideArgs(restrictions)], cwd: directory,
        env: { ...process.env, CODEX_HOME: home }, timeoutMs: 20000 })
      let threadId: string | undefined
      let resolveDone!: () => void, rejectDone!: (error: Error) => void
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
      done.catch(() => {})
      const abort = () => { rejectDone(new Error('stale_review')); void rpc.dispose() }
      signal.addEventListener('abort', abort, { once: true })
      rpc.on('disconnect', () => rejectDone(new Error('复盘进程意外退出')))
      rpc.on('serverRequest', message => {
        const name = message.params?.tool
        if (message.method !== 'item/tool/call' || !ASSISTANT_REVIEW_TOOLS.some(t => t.name === name) || signal.aborted) {
          rpc.respond(message.id, { decision: 'decline', success: false, contentItems: [{ type: 'inputText', text: '复盘只允许记忆与搜索工具' }] })
          rejectDone(new Error('review_unexpected_tool')); void rpc.dispose(); return
        }
        void call(name, message.params.arguments).then(value => rpc.respond(message.id, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] }),
          error => rpc.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: String(error) }] }))
      })
      rpc.on('notification', (method, params) => {
        if (threadId && params?.threadId && params.threadId !== threadId) return
        if (method === 'error') rejectDone(new Error(params?.error?.message || '复盘执行失败'))
        if (method === 'turn/completed') params?.turn?.status === 'completed' ? resolveDone() : rejectDone(new Error('复盘回合未成功完成'))
        if (method === 'item/started' && !['userMessage','agentMessage','reasoning','dynamicToolCall'].includes(params?.item?.type)) {
          rejectDone(new Error('review_unexpected_tool')); void rpc.dispose()
        }
      })
      try {
        await rpc.start()
        await rpc.request('initialize', { clientInfo: { name: 'uniagent-memory-review', version: '1.0.0' }, capabilities: { experimentalApi: true } })
        rpc.notify('initialized', {})
        const started = await rpc.request<any>('thread/start', { cwd: directory, model: codexWireModel(config) || agent.defaultModel,
          ...(codexSessionProvider(config.modelSource) ? { modelProvider: codexSessionProvider(config.modelSource) } : {}),
          approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, threadSource: 'system', environments: [], selectedCapabilityRoots: [],
          dynamicTools: ASSISTANT_REVIEW_TOOLS.map(tool => ({ ...tool, type: 'function', deferLoading: false })), config: restrictions })
        threadId = started?.thread?.id
        if (!threadId || signal.aborted) throw new Error('stale_review')
        await rpc.request('turn/start', { threadId, environments: [], input: [{ type: 'text', text: prompt, text_elements: [] }] })
        await done
      } finally { signal.removeEventListener('abort', abort); await rpc.dispose() }
    } else {
      await runClaudeReview(agent, config, prompt, scope, directory, signal)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function restrictedCodexCatalog(args: string[], config: SessionConfig, directory: string): Promise<string> {
  const override = args.find(value => value.startsWith('model_catalog_json='))
  const path = override ? JSON.parse(override.slice('model_catalog_json='.length)) : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json')
  let catalog: any
  try { catalog = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('review_runtime_unsupported: 缺少模型能力目录，请先在 UniAgent 检测 Codex') }
  const modelId = codexWireModel(config)
  const model = (catalog.models || []).find((model: any) => model.slug === modelId)
  if (!model) throw new Error('review_runtime_unsupported: 所选模型缺少受限复盘能力目录，请重新配置')
  const { apply_patch_tool_type, ...entry } = model
  const target = join(directory, 'models.json')
  await writeFile(target, JSON.stringify({ models: [{ ...entry, shell_type: 'disabled', experimental_supported_tools: [], additional_tools: [], supports_search_tool: false }] }), { mode: 0o600 })
  return target
}

async function runClaudeReview(agent: AgentDef, config: SessionConfig, prompt: string, scope: AssistantScope, directory: string, signal: AbortSignal): Promise<void> {
  const runtime = await prepareClaudeSourceRuntime(config)
  let client: ClaudeSdkClient | undefined
  try {
    const allowed = ['mcp__uniagent__assistant_memory', 'mcp__uniagent__session_search']
    const settings = join(directory, 'settings.json')
    await writeFile(settings, JSON.stringify({ ...runtime?.settings, disableAllHooks: true, autoMemoryEnabled: false,
      enabledPlugins: {}, permissions: { allow: allowed } }), { mode: 0o600 })
    const authEnv = Object.fromEntries(Object.entries(await readClaudeEnv()).filter(([key]) => /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|MODEL|DEFAULT_(?:OPUS|SONNET|HAIKU)_MODEL)|CLAUDE_CODE_OAUTH_TOKEN)$/.test(key)))
    client = new ClaudeSdkClient({ options: {
      pathToClaudeCodeExecutable: agent.bin, cwd: directory,
      env: { ...process.env, ...authEnv, ...runtime?.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SIMPLE: '0' },
      persistSession: false, strictMcpConfig: true, settingSources: [], settings, tools: [], skills: [], allowedTools: allowed,
      permissionMode: 'default', ...(config.model ? { model: runtime?.model || config.model } : {}),
      mcpServers: { uniagent: { command: process.execPath, args: [ensureHandoffServer()], env: {
        ELECTRON_RUN_AS_NODE: '1', UNIAGENT_CALLER_SESSION: scope.sessionId, UNIAGENT_ASSISTANT_ONLY: '1', ...assistantMcpEnv(scope.sessionId)
      } } }
    } })
    const sdk = client
    const done = new Promise<void>((resolve, reject) => {
      let verified = false
      sdk.on('failure', reject)
      sdk.on('ended', () => reject(new Error('Claude SDK 复盘进程提前退出')))
      sdk.on('approval', request => sdk.respond(request.requestId, request.kind === 'tool' && allowed.includes(request.toolName) && !signal.aborted
        ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: '复盘工具权限受限' }))
      sdk.on('message', event => {
        if (event.type === 'system' && event.subtype === 'init') {
          verified = Array.isArray(event.tools) && event.tools.every((tool: string) => allowed.includes(tool))
          if (!verified) { reject(new Error('review_unexpected_tool')); void sdk.close() }
        }
        if (event.type === 'assistant' && event.message?.content?.some((block: any) => block.type === 'tool_use' && !allowed.includes(block.name))) {
          reject(new Error('review_unexpected_tool')); void sdk.close()
        }
        if (event.type === 'result') event.is_error !== true && event.subtype === 'success' && verified ? resolve() : reject(new Error('Claude 复盘未成功完成'))
      })
      const abort = () => { reject(new Error('stale_review')); void sdk.close() }
      signal.addEventListener('abort', abort, { once: true })
      sdk.once('closed', () => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
    void done.catch(() => {})
    await sdk.ready
    if (signal.aborted) throw new Error('stale_review')
    await sdk.request('send', { content: prompt })
    await done
  } catch (error) { throw new Error(runtime?.redact(String(error)) ?? String(error)) }
  finally { await client?.close(); await runtime?.dispose() }
}
