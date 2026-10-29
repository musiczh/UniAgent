import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { query, forkSession, deleteSession, listSessions, getSessionMessages, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeSdkLaunch } from './claudeSdk.ts'

const port = parentPort!
const launch = workerData as ClaudeSdkLaunch
const queue: SDKUserMessage[] = []
let wake: (() => void) | undefined
let closing = false
let inputWrites = Promise.resolve()
let child: ChildProcessWithoutNullStreams | undefined
const approvals = new Map<string, (value: any) => void>()
const replays = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
const commands = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
const post = (type: string, value: unknown): void => port.postMessage({ type, value })

async function* input(): AsyncGenerator<SDKUserMessage> {
  while (!closing) {
    if (queue.length) yield queue.shift()!
    else await new Promise<void>(resolve => { wake = resolve })
  }
}

function ask(value: Record<string, unknown>, signal: AbortSignal): Promise<any> {
  const requestId = randomUUID()
  return new Promise(resolve => {
    const cancel = () => {
      if (!approvals.delete(requestId)) return
      post('approvalCancelled', requestId)
      resolve(value.kind === 'elicitation' ? { action: 'cancel' } : { behavior: 'deny', message: '请求已中断' })
    }
    approvals.set(requestId, response => {
      signal.removeEventListener('abort', cancel)
      resolve(response ?? (value.kind === 'elicitation' ? { action: 'cancel' } : { behavior: 'deny', message: '会话已关闭' }))
    })
    if (signal.aborted) { cancel(); return }
    signal.addEventListener('abort', cancel, { once: true })
    post('approval', { ...value, requestId })
  })
}

function deniedTool(name: string, input: Record<string, unknown>): boolean {
  const role = launch.role
  return !!role && (
    role.skills !== undefined && (['Agent', 'Task'].includes(name) || name === 'Skill' && !role.skills.includes(String(input.skill))) ||
    role.toolPolicy?.mode === 'allow-only' && !role.toolPolicy.tools.includes(name) ||
    role.toolPolicy?.mode === 'deny-only' && role.toolPolicy.tools.includes(name)
  )
}

const options: Options = {
  ...launch.options,
  canUseTool: (toolName, input, context) => ask({ kind: 'tool', toolName, input, suggestions: context.suggestions }, context.signal),
  onElicitation: (request, context) => ask({ kind: 'elicitation', input: request }, context.signal),
  spawnClaudeCodeProcess: spec => {
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] })
    post('process', child.pid)
    child.stderr.on('data', data => post('stderr', String(data)))
    spec.signal.addEventListener('abort', () => {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }, { once: true })
    return child
  },
  ...(launch.role?.skills !== undefined || launch.role?.toolPolicy ? { hooks: {
    PreToolUse: [{ hooks: [async event => {
      if (event?.hook_event_name !== 'PreToolUse' || typeof event.tool_name !== 'string' || !event.tool_input || typeof event.tool_input !== 'object' || Array.isArray(event.tool_input)) {
        port.postMessage({ type: 'fatal', error: 'Claude 角色钩子格式无效，已停止执行' })
        await close()
        throw new Error('Claude 角色钩子格式无效')
      }
      return deniedTool(event.tool_name, event.tool_input as Record<string, unknown>) ? { hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '此工具或技能不在当前角色允许范围内'
      } } : {}
    }] }],
    ...(launch.role?.skills === undefined ? {} : { SubagentStart: [{ hooks: [async () => {
      // SubagentStart cannot deny a spawn. Stop our owned CLI immediately;
      // the SDK's graceful close gives the child time to load disallowed skills.
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      port.postMessage({ type: 'fatal', error: '技能白名单不能继承自定义子代理的预加载技能，已阻止子代理启动' })
      await close()
      throw new Error('Claude 角色禁止未授权的子代理预加载')
    }] }] })
  } } : {})
}
const session = query({ prompt: input(), options })
function validateCommands(commands: Array<{name:string;builtin?:boolean;aliases?:string[]}>): void {
  for (const skill of launch.role?.skills || []) {
    const matches = commands.filter(command => command.builtin !== true && [command.name, ...(command.aliases || [])]
      .some(name => name === skill || name.endsWith(`:${skill}`)))
    if (matches.length > 1 || matches.some(command => command.name !== skill || (command.aliases || []).some(name => name !== skill && name.endsWith(`:${skill}`)))) {
      throw new Error(`技能 ${skill} 与原生目录中的其它技能名称重叠，请使用无歧义的完整名称`)
    }
  }
}
const initialized = session.initializationResult().then(result => {
  if (options.hooks && result.hooks_applied !== true) throw new Error('Claude 初始化未确认角色限制生效')
  validateCommands(result.commands)
  return result
})
void initialized.catch(error => { port.postMessage({ type: 'fatal', error: String(error.message || error) }); void close() })

async function close(): Promise<void> {
  if (closing) return
  closing = true
  queue.length = 0
  wake?.()
  for (const resolve of approvals.values()) resolve(undefined)
  approvals.clear()
  for (const pending of replays.values()) pending.reject(new Error('Claude SDK 会话已关闭'))
  replays.clear()
  for (const pending of commands.values()) pending.reject(new Error('Claude SDK 会话已关闭'))
  commands.clear()
  session.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const owned = child
    await new Promise<void>(resolveExit => {
      const timer = setTimeout(() => { if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL') }, 2_500)
      owned.once('close', () => { clearTimeout(timer); resolveExit() })
    })
  }
  port.close()
}

port.on('message', async ({ id, method, args }) => {
  if (method === 'close') { await close(); return }
  if (method === 'respond') {
    const respond = approvals.get(args.requestId)
    approvals.delete(args.requestId)
    respond?.(args.response)
    return
  }
  try {
    const result = await initialized
    let value: unknown
    if (method === 'initialize') value = result
    else if (method === 'command') {
      const uuid = randomUUID()
      const done = new Promise((resolve, reject) => commands.set(uuid, { resolve, reject }))
      void done.catch(() => {})
      await inputWrites
      if (closing) throw new Error('Claude SDK 会话已关闭')
      queue.push({ type: 'user', uuid, message: { role: 'user', content: args }, parent_tool_use_id: null })
      wake?.(); wake = undefined
      value = await done
    }
    else if (method === 'send') {
      let replay: Promise<void> | undefined
      const write = inputWrites.then(async () => {
        let content = args.content
        if (args.attachments?.length) {
          const blocks: any[] = [{ type: 'text', text: content }]
          for (const attachment of args.attachments) {
            if (attachment.kind === 'image') {
              const mime = /\.jpe?g$/i.test(attachment.path) ? 'image/jpeg' : /\.webp$/i.test(attachment.path) ? 'image/webp' : /\.gif$/i.test(attachment.path) ? 'image/gif' : 'image/png'
              blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: await readFile(attachment.path, 'base64') } })
            } else blocks.push({ type: 'text', text: `附件文件: ${attachment.path}` })
          }
          content = blocks
        }
        if (closing) throw new Error('Claude SDK 会话已关闭')
        const message: SDKUserMessage = { type: 'user', uuid: args.uuid, message: { role: 'user', content }, parent_tool_use_id: null }
        replay = args.waitForReplay ? new Promise<void>((resolve, reject) => replays.set(args.uuid, { resolve, reject })) : undefined
        queue.push(message); wake?.(); wake = undefined
      })
      inputWrites = write.catch(() => {})
      await write
      await replay
    } else if (method === 'interrupt') value = await session.interrupt()
    else if (method === 'setPermissionMode') value = await session.setPermissionMode(args)
    else if (method === 'setModel') value = await session.setModel(args)
    else if (method === 'context') value = await session.getContextUsage({ detail: 'summary' })
    else if (method === 'usage') value = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    else if (method === 'models') value = await session.supportedModels()
    else if (method === 'commands') value = await session.supportedCommands()
    else if (method === 'mcp') value = { mcpServers: await session.mcpServerStatus() }
    else if (method === 'stopTask') value = await session.stopTask(args)
    else if (method === 'reloadPlugins') {
      const reloaded = await session.reloadPlugins()
      validateCommands(reloaded.commands)
      value = reloaded
    }
    else if (method === 'reloadSkills') value = await session.reloadSkills()
    else if (method === 'rewindFiles') value = await session.rewindFiles(args.uuid, { dryRun: args.dryRun })
    else if (method === 'forkSession') value = await forkSession(args.sessionId, { dir: launch.options.cwd, upToMessageId: args.messageId })
    else if (method === 'deleteSession') value = await deleteSession(args, { dir: launch.options.cwd })
    else if (method === 'listSessions') value = await listSessions({ dir: args?.dir })
    else if (method === 'history') value = await getSessionMessages(args, { dir: launch.options.cwd, includeSystemMessages: true })
    else throw new Error(`不支持的 Claude SDK 操作：${method}`)
    port.postMessage({ id, value })
  } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
})

void (async () => {
  try {
    for await (const message of session) {
      if ((message as {type:string}).type === 'active_goal' && commands.size) continue
      if (message.type === 'result') {
        const uuid = message.user_message_uuid
        const pending = uuid && commands.get(uuid)
        if (pending) { commands.delete(uuid); pending.resolve(message); continue }
      }
      if (message.type === 'user' && message.uuid && commands.has(message.uuid)) continue
      if (message.type === 'user' && 'isReplay' in message && message.isReplay && message.uuid) {
        replays.get(message.uuid)?.resolve(); replays.delete(message.uuid)
      }
      post('message', message)
    }
    if (!closing) { post('ended', undefined); await close() }
  } catch (error) {
    if (!closing) port.postMessage({ type: 'fatal', error: error instanceof Error ? error.message : String(error) })
    await close()
  }
})()
