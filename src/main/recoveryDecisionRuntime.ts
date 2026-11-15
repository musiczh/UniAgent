import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, SessionConfig } from '../shared/types'
import { parseCodexModelKey } from '../shared/codexModelIdentity'
import { ClaudeSdkClient, type ClaudeSdkLaunch } from './claudeSdk'
import { prepareClaudeSourceRuntime } from './claudeSourceRuntime'
import { readClaudeEnv } from './agents'
import { extractRequirementText } from './requirementExtractionRuntime'
import { RECOVERY_OUTPUT_SCHEMA } from './recoveryContext'

export function recoveryJudgeUnsupported(agent?: AgentDef): string | undefined {
  if (!agent || agent.installed === false || agent.incompatible || agent.lifecycle && agent.lifecycle.availability !== 'available') return '判断 Agent 当前不可用，请在设置中检查'
  if (agent.adapter !== 'codex' && agent.adapter !== 'claude') return '判断 Agent 目前支持 Codex 和 Claude Code'
}

export async function runRecoveryDecision(agent: AgentDef, model: string, prompt: string, signal: AbortSignal): Promise<string> {
  const unsupported = recoveryJudgeUnsupported(agent)
  if (unsupported) throw new Error(unsupported)
  if (!model || !agent.models.some(item => item.id === model)) throw new Error('判断模型不可用，请重新选择')
  if (signal.aborted) throw new Error('恢复判断已取消')
  const config: SessionConfig = { agentId: agent.id, workdir: tmpdir(), model, modelSource: parseCodexModelKey(model)?.source }
  if (agent.adapter === 'codex') return extractRequirementText(agent, config, prompt, signal, undefined,
    { label: '恢复判断', timeoutMs: 30000, maxOutputChars: 8192, outputSchema: RECOVERY_OUTPUT_SCHEMA })
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-recovery-judge-'))
  let runtime: Awaited<ReturnType<typeof prepareClaudeSourceRuntime>> = undefined
  try {
    runtime = await prepareClaudeSourceRuntime(config)
    const settings = join(directory, 'settings.json')
    await writeFile(settings, JSON.stringify({ ...runtime?.settings, disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {} }), { mode: 0o600 })
    const authEnv = Object.fromEntries(Object.entries(await readClaudeEnv()).filter(([key]) => /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|MODEL|DEFAULT_(?:OPUS|SONNET|HAIKU)_MODEL)|CLAUDE_CODE_OAUTH_TOKEN)$/.test(key)))
    if (signal.aborted) throw new Error('恢复判断已取消')
    return await runClaudeRecoveryText({ options: { pathToClaudeCodeExecutable: agent.bin, cwd: directory,
      env: { ...process.env, ...authEnv, ...runtime?.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      persistSession: false, strictMcpConfig: true, settingSources: [], settings, tools: [], allowedTools: [],
      mcpServers: {}, permissionMode: 'default', model: runtime?.model || model } }, prompt, signal)
  } catch (error) { throw new Error(runtime?.redact(String(error)) ?? String(error)) }
  finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }) }
}

/** Kept injectable so tool denial, terminal results and cancellation are executable contracts. */
export async function runClaudeRecoveryText(launch: ClaudeSdkLaunch, prompt: string, signal: AbortSignal,
  factory: (launch: ClaudeSdkLaunch) => ClaudeSdkClient = options => new ClaudeSdkClient(options)): Promise<string> {
  if (signal.aborted) throw new Error('恢复判断已取消')
  const client = factory(launch)
  let rejectDone!: (error: Error) => void
  const done = new Promise<string>((resolve, reject) => {
    rejectDone = reject
    let verified = false
    client.on('failure', reject)
    client.on('ended', () => reject(new Error('恢复判断进程提前退出')))
    client.on('approval', request => { client.respond(request.requestId, { behavior: 'deny', message: '恢复判断禁止调用工具或交互' }); reject(new Error('恢复判断请求了未授权工具')) })
    client.on('message', event => {
      if (event.type === 'system' && event.subtype === 'init') {
        verified = Array.isArray(event.tools) && event.tools.length === 0
        if (!verified) reject(new Error('无法确认判断环境已关闭全部工具'))
      }
      if (event.type === 'assistant' && event.message?.content?.some((block: any) => block.type === 'tool_use')) reject(new Error('恢复判断出现未授权工具'))
      if (event.type === 'result') {
        if (event.is_error || event.subtype !== 'success' || !verified) reject(new Error('恢复判断未成功完成'))
        else if (typeof event.result !== 'string' || event.result.length > 8192) reject(new Error('恢复判断结果无效或过长'))
        else resolve(event.result)
      }
    })
  })
  void done.catch(() => {})
  const abort = () => { rejectDone(new Error('恢复判断已取消或超时')); void client.close() }
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 30000)
  try {
    if (signal.aborted) abort()
    const send = async () => {
      await client.ready
      if (signal.aborted) throw new Error('恢复判断已取消')
      await client.request('send', { content: prompt })
      return await done
    }
    return await Promise.race([done, send()])
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await client.close() }
}
