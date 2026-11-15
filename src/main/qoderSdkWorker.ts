import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { snapshotFileChange } from './turnFileChanges.ts'
import type { SDKUserMessage, Query } from '@qoder-ai/qoder-agent-sdk'
import type { QoderSdkLaunch } from './qoderSdk.ts'
import { initializeQoderQuery, qoderAuth, qoderDaemonRequest, qoderToolCall } from './qoderSdk.ts'

const port = parentPort!
const launch = workerData as QoderSdkLaunch
if (launch.options.cwd) launch.options.cwd = await realpath(launch.options.cwd)
const sdk = await (launch.region === 'cn' ? import('@qodercn-ai/qodercn-agent-sdk') : import('@qoder-ai/qoder-agent-sdk'))
const queue: SDKUserMessage[] = []
let wake: (() => void) | undefined
let closing = false
let session: Query | undefined
const approvals = new Map<string, (value: any) => void>()
const receipts = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
const commands = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
const fileSnapshots = new Map<string, { path: string; before?: string }>()
const post = (type: string, value: unknown): void => port.postMessage({ type, value })

async function* input(): AsyncGenerator<SDKUserMessage> {
  while (!closing) {
    if (queue.length) yield queue.shift()!
    else await new Promise<void>(resolve => { wake = resolve })
  }
}

function deniedTool(name: string, input: Record<string, unknown>): boolean {
  name = qoderToolCall(name, input).name
  const role = launch.role
  return !!role && (role.skills !== undefined && (['Task', 'Agent'].includes(name) || name === 'Skill' && !role.skills.includes(String(input.skill))) ||
    role.toolPolicy?.mode === 'allow-only' && !role.toolPolicy.tools.includes(name) ||
    role.toolPolicy?.mode === 'deny-only' && role.toolPolicy.tools.includes(name))
}

function ask(value: Record<string, unknown>, signal: AbortSignal): Promise<any> {
  const requestId = randomUUID()
  return new Promise(resolve => {
    const cancel = () => { if (approvals.delete(requestId)) { post('approvalCancelled', requestId); resolve(value.kind === 'elicitation' ? { action: 'cancel' } : { behavior: 'deny', message: '请求已中断' }) } }
    approvals.set(requestId, answer => { signal.removeEventListener('abort', cancel); resolve(answer ?? (value.kind === 'elicitation' ? { action: 'cancel' } : { behavior: 'deny', message: '会话已关闭' })) })
    if (signal.aborted) { cancel(); return }
    signal.addEventListener('abort', cancel, { once: true })
    post('approval', { ...value, requestId })
  })
}

// Each worker explicitly owns its daemon. Closing a Query cannot stop another worker's sessions.
const daemon = await sdk.startDaemon({ pathToQoderCLIExecutable: launch.options.pathToQoderCLIExecutable,
  launchMode: 'process', env: launch.options.env, auth: qoderAuth(sdk, launch.options.env || process.env), initializeTimeoutMs: launch.initializeTimeoutMs,
  business: { product: 'uniagent' } })
daemon.onFailure(error => { post('failure', error.message); void close() })
const initialized = (async () => {
  if (launch.operationOnly) return { daemonReady: true }
  const { pathToQoderCLIExecutable: _path, env: _env, auth: _auth, transport: _transport, mcpServers,
    executable: _executable, executableArgs: _executableArgs, proxy: _proxy, vpcEndpoint: _vpc, ...sessionOptions } = launch.options
  session = sdk.query({ prompt: input(), options: {
    ...sessionOptions, mcpServers, daemon,
    canUseTool: (toolName, input, context) => deniedTool(toolName, input)
      ? Promise.resolve({ behavior: 'deny', message: '此工具或技能不在当前角色允许范围内' })
      : ask({ kind: 'tool', toolName, input, suggestions: context.suggestions }, context.signal),
    onElicitation: (request, context) => ask({ kind: 'elicitation', input: request }, context.signal),
    hooks: { PreToolUse: [{ hooks: [async (event, toolUseId) => {
      if (event.hook_event_name !== 'PreToolUse') return {}
      if (deniedTool(event.tool_name, event.tool_input as Record<string, unknown>)) return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '此工具或技能不在当前角色允许范围内' }
      }
      const suppliedPath = (event.tool_input as any)?.file_path
      if (toolUseId && ['Write', 'Edit', 'MultiEdit'].includes(event.tool_name) && typeof suppliedPath === 'string') {
        const path = resolve(launch.options.cwd || process.cwd(), suppliedPath)
        try { if ((await stat(path)).size <= 1.5 * 1024 * 1024) fileSnapshots.set(toolUseId, { path, before: await readFile(path, 'utf8') }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fileSnapshots.set(toolUseId, { path }) }
      }
      return {}
    }] }], PostToolUse: [{ hooks: [async (_event, toolUseId) => {
      const snapshot = toolUseId && fileSnapshots.get(toolUseId)
      if (toolUseId) fileSnapshots.delete(toolUseId)
      if (snapshot) {
        const after = await stat(snapshot.path).then(info => info.size <= 1.5 * 1024 * 1024 ? readFile(snapshot.path, 'utf8') : undefined).catch(() => undefined)
        if (after !== undefined) {
          const change = await snapshotFileChange(snapshot.path, snapshot.before, after)
          if (change) {
            const localPath = relative(launch.options.cwd || process.cwd(), snapshot.path)
            if (localPath && localPath !== '..' && !localPath.startsWith('..' + sep)) change.path = localPath
            post('fileChange', { id: toolUseId, changes: [change] })
          }
        }
      }
      return {}
    }] }], PostToolUseFailure: [{ hooks: [async (_event, toolUseId) => { if (toolUseId) fileSnapshots.delete(toolUseId); return {} }] }] }
  } })
  const result = await initializeQoderQuery(session, launch.options.model, mcpServers, launch.options.strictMcpConfig)
  void consume()
  return result
})()
void initialized.catch(error => { port.postMessage({ type: 'fatal', error: error.message }); void close() })

async function close(): Promise<void> {
  if (closing) return
  closing = true
  queue.length = 0; wake?.()
  for (const respond of approvals.values()) respond(undefined)
  approvals.clear()
  for (const pending of [...receipts.values(), ...commands.values()]) pending.reject(new Error('Qoder SDK 会话已关闭'))
  receipts.clear(); commands.clear()
  fileSnapshots.clear()
  try { await session?.close() }
  finally { try { await daemon.stop() } finally { port.close() } }
}

async function send(args: any): Promise<void> {
  let content: SDKUserMessage['message']['content'] = args.content
  if (args.attachments?.length) {
    const blocks: any[] = [{ type: 'text', text: content }]
    for (const attachment of args.attachments) {
      if (attachment.kind === 'image') {
        const media_type = /\.jpe?g$/i.test(attachment.path) ? 'image/jpeg' : /\.webp$/i.test(attachment.path) ? 'image/webp' : /\.gif$/i.test(attachment.path) ? 'image/gif' : 'image/png'
        blocks.push({ type: 'image', source: { type: 'base64', media_type, data: await readFile(attachment.path, 'base64') } })
      } else blocks.push({ type: 'text', text: `附件文件：${attachment.path}` })
    }
    content = blocks
  }
  if (closing || !session) throw new Error('Qoder SDK 会话已关闭')
  const receipt = args.waitForReplay ? new Promise<void>((resolve, reject) => receipts.set(args.uuid, { resolve, reject })) : undefined
  queue.push({ type: 'user', uuid: args.uuid, message: { role: 'user', content }, parent_tool_use_id: null, priority: args.priority || 'next' })
  wake?.(); wake = undefined
  await receipt
}

port.on('message', async ({ id, method, args }: { id: string; method: string; args: any }) => {
  if (method === 'close') { await close(); return }
  if (method === 'respond') { const respond = approvals.get(args.requestId); approvals.delete(args.requestId); respond?.(args.response); return }
  try {
    const result = await initialized
    let value: unknown
    const cwd = launch.options.cwd
    const pluginOptions = { cwd, cliPath: launch.options.pathToQoderCLIExecutable, scope: args?.scope }
    if (method === 'initialize') value = result
    else if (['auth', 'account', 'models', 'usage'].includes(method) || method.startsWith('byok.')) value = await qoderDaemonRequest(daemon, method, args)
    else if (method === 'listSessions') value = await sdk.listSessions(args)
    else if (method === 'history') value = await sdk.getSessionMessages(args.sessionId, { view: args.view || 'historical', includeSystemMessages: true })
    else if (method === 'subagentHistory') value = await sdk.getSubagentMessages(args.sessionId, args.agentId)
    else if (method === 'subagents') value = await sdk.listSubagents(args.sessionId)
    else if (method === 'forkSession') value = await sdk.forkSession(args.sessionId, { upToMessageId: args.messageId })
    else if (method === 'deleteSession') value = await sdk.deleteSession(args.sessionId)
    else if (method === 'plugins.list') value = await sdk.listPlugins(pluginOptions)
    else if (method === 'plugins.install') value = await sdk.installPlugin(args.source, pluginOptions)
    else if (method === 'plugins.enable') value = await sdk.enablePlugin(args.id, pluginOptions)
    else if (method === 'plugins.disable') value = await sdk.disablePlugin(args.id, pluginOptions)
    else if (method === 'plugins.uninstall') value = await sdk.uninstallPlugin(args.id, { ...pluginOptions, keepData: true })
    else {
      if (!session) throw new Error('Qoder 操作需要已初始化的会话')
      if (method === 'send') value = await send(args)
      else if (method === 'command') {
        const uuid = randomUUID()
        const done = new Promise((resolve, reject) => commands.set(uuid, { resolve, reject })); void done.catch(() => {})
        await send({ uuid, content: args }); value = await done
      } else if (method === 'interrupt') value = await session.interrupt()
      else if (method === 'cancelInput') value = await session.cancelAsyncMessage(args)
      else if (method === 'context') value = await session.getContextUsage()
      else if (method === 'commands') value = await session.supportedCommands()
      else if (method === 'agents') value = await session.supportedAgents()
      else if (method === 'mcp') value = { mcpServers: await session.mcpServerStatus() }
      else if (method === 'setModel') value = await session.setModel(args)
      else if (method === 'setPermissionMode') value = await session.setPermissionMode(args)
      else if (method === 'setPlanMode' || method === 'getPlanMode' || method === 'setGoal' || method === 'getGoal' || method === 'resumeGoal' || method === 'clearGoal' || method === 'setGoalMaxTurns') {
        if (!session[method]) throw new Error(`当前 Qoder CLI 不支持 ${method}`)
        switch (method) {
          case 'setPlanMode': value = await session.setPlanMode!(args); break
          case 'getPlanMode': value = await session.getPlanMode!(); break
          case 'setGoal': value = await session.setGoal!(args); break
          case 'getGoal': value = await session.getGoal!(); break
          case 'resumeGoal': value = await session.resumeGoal!(); break
          case 'clearGoal': value = await session.clearGoal!(); break
          case 'setGoalMaxTurns': value = await session.setGoalMaxTurns!(args); break
        }
      }
      else if (method === 'stopTask') value = await session.stopTask(args)
      else if (method === 'addDirectories') value = await session.addDirectories(args)
      else if (method === 'reloadPlugins') value = await session.reloadPlugins()
      else if (method === 'reloadSkills') value = await session.reloadSkills()
      else if (method === 'mcp.auth') value = await session.mcpAuthenticate(args.name)
      else if (method === 'mcp.callback') value = await session.mcpSubmitOAuthCallbackUrl(args.name, args.url)
      else throw new Error(`不支持的 Qoder SDK 操作：${method}`)
    }
    port.postMessage({ id, value })
  } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
})

async function consume(): Promise<void> {
  try {
    for await (const message of session!) {
      if (message.type === 'user' && 'isReplay' in message && message.isReplay && message.uuid) {
        receipts.get(message.uuid)?.resolve(); receipts.delete(message.uuid)
      }
      if (message.type === 'result' && commands.size) {
        const [uuid, pending] = commands.entries().next().value!
        commands.delete(uuid); pending.resolve(message); continue
      }
      if (message.type === 'user' && message.uuid && commands.has(message.uuid)) continue
      post('message', message)
    }
    if (!closing) post('ended', undefined)
  } catch (error) { if (!closing) port.postMessage({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }) }
}
