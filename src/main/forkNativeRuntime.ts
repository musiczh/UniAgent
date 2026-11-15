import { randomUUID } from 'node:crypto'
import type { AgentDef, SessionConfig, UAEvent } from '../shared/types'
import { AppServerRunner } from './appServerAdapter'
import { ClaudeSdkClient, claudeSdkLaunch } from './claudeSdk'
import { buildCommand } from './adapter'
import { prepareClaudeSourceRuntime } from './claudeSourceRuntime'
import { nativeCredentialEnv } from './agentSetupCredentials'
import { QoderSdkClient, qoderLaunch, qoderRegionForBin } from './qoderSdk'
import type { SdkWorkerClient } from './sdkWorkerClient'

const handoffFields = ['goal','constraints','facts','decisions','completed','artifacts','failedAttempts','pending','nextSteps','historyReferences']
const handoffSchema = { type: 'object', additionalProperties: false, required: handoffFields,
  properties: Object.fromEntries(handoffFields.map(key => [key, { type: 'string' }])) }
export const FORK_HANDOFF_PROMPT = `这是会话导出步骤，不继续原任务，不调用工具，不执行代码，不联系他人。请仅依据当前原生压缩后的上下文，输出一个 JSON 对象，字段必须包括 ${handoffFields.join(', ')}，每项使用字符串或字符串数组；未知内容明确写未知，不猜测，不重建隐藏推理。保留用户最新修正、约束、验收条件、决策理由、已完成工作、文件路径、失败尝试及待办。historyReferences 仅列上下文中已有的回合或文件引用。目标 Agent 将按需查阅另存的历史资料。只输出 JSON，不输出 Markdown 围栏。`

export function validateForkHandoff(text: string): string {
  let value: Record<string, unknown>
  try { value = JSON.parse(text) } catch { throw new Error('来源 Agent 的交接说明不是有效 JSON，未创建分支') }
  if (!value || typeof value !== 'object' || handoffFields.some(key => typeof value[key] !== 'string' && !(Array.isArray(value[key]) && value[key].every(item => typeof item === 'string')))) throw new Error('来源 Agent 的交接说明缺少必需字段，未创建分支')
  return handoffFields.map(key => `## ${key}\n\n${Array.isArray(value[key]) ? (value[key] as string[]).map(item => `- ${item}`).join('\n') : value[key]}`).join('\n\n')
}

/** Never sends a business prompt; initialization, /compact and a tool-free handoff only. */
export async function withForkClaude<T>(agent: AgentDef, config: SessionConfig, nativeId: string | undefined,
  restricted: boolean, action: (client: ClaudeSdkClient) => Promise<T>): Promise<T> {
  const runtime = await prepareClaudeSourceRuntime(config)
  let client: ClaudeSdkClient | undefined
  try {
    const launch = buildCommand(agent, { ...config, ...(runtime ? { model: runtime.model } : {}) }, '', nativeId, undefined, undefined, undefined, true)
    const sdkLaunch = claudeSdkLaunch(agent.bin, config.workdir, [...launch.args, ...(runtime?.args || [])],
      { ...process.env, ...launch.env, ...nativeCredentialEnv('claude'), ...runtime?.env })
    client = new ClaudeSdkClient({ options: { ...sdkLaunch.options,
      ...(restricted ? { tools: [], strictMcpConfig: true, mcpServers: {}, maxTurns: 1 } : {}),
      settings: { ...runtime?.settings, disableAllHooks: true },
      additionalDirectories: config.additionalDirectories,
      includePartialMessages: false, forwardSubagentText: false,
      ...(restricted ? { persistSession: true } : {}) } })
    client.on('approval', value => client?.respond(value.requestId, { behavior: 'deny', message: '会话分叉准备阶段禁止执行工具' }))
    await client.ready; return await action(client)
  }
  catch (error) { throw new Error(runtime?.redact(error instanceof Error ? error.message : String(error)) ?? String(error)) }
  finally { await client?.close(); await runtime?.dispose() }
}

export function forkClaudeTurn(client: SdkWorkerClient, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const texts = new Map<string, string>()
    let compactDone = false
    const finish = (error?: Error): void => {
      clearTimeout(timer); client.removeListener('message', message); client.removeListener('failure', failure)
      error ? reject(error) : resolve([...texts.values()].join('\n'))
    }
    const failure = (error: Error): void => finish(error)
    const message = (row: any): void => {
      if (row.type === 'system' && row.subtype === 'compact_boundary') compactDone = true
      if (row.type === 'assistant') texts.set(row.message?.id || row.uuid, (row.message?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'))
      if (row.type === 'result') finish(row.is_error || row.subtype !== 'success' ? new Error('来源 Claude 执行失败，未创建分支')
        : prompt === '/compact' && !compactDone ? new Error('Claude 未报告压缩完成') : undefined)
    }
    const timer = setTimeout(() => finish(new Error('等待来源 Claude 完成超时')), 5 * 60_000)
    client.on('message', message); client.on('failure', failure)
    void client.request('send', { uuid: randomUUID(), content: prompt }).catch(failure)
  })
}

export async function withForkQoder<T>(agent: AgentDef, config: SessionConfig, nativeId: string, action: (client: QoderSdkClient) => Promise<T>): Promise<T> {
  const launch = qoderLaunch(agent.bin, { ...config, roleSnapshot: undefined }, '仅导出已有会话上下文，不执行任务。', {}, nativeId,
    nativeCredentialEnv(qoderRegionForBin(agent.bin) === 'cn' ? 'qoder-cn' : 'qoder'))
  const client = new QoderSdkClient({ ...launch, options: { ...launch.options, tools: [], strictMcpConfig: true, mcpServers: {}, settingSources: [] } })
  client.on('approval', request => client.respond(request.requestId, { behavior: 'deny', message: '会话分叉准备阶段禁止执行工具' }))
  try { await client.ready; return await action(client) } finally { await client.close() }
}

export async function forkCodexHandoff(runner: AppServerRunner): Promise<string> {
  await runner.restrictToHandoffExport(handoffSchema)
  return new Promise((resolve, reject) => {
    let text = '', error: string | undefined
    const event = (event: UAEvent): void => {
      if (event.type === 'agent_message' && event.payload.text) text = event.payload.text
      if (event.type === 'error') error = event.payload.message
      if (event.type === 'approval_request') runner.respond(event.payload.requestId, { decision: 'decline' })
    }
    const finish = (result: any): void => {
      clearTimeout(timer); runner.removeListener('event', event); runner.removeListener('done', finish)
      if (result?.failed || result?.interrupted || error) reject(new Error(error || '来源 Agent 导出交接说明失败'))
      else { try { resolve(validateForkHandoff(text)) } catch (failure) { reject(failure) } }
    }
    const timer = setTimeout(() => finish({ failed: true }), 5 * 60_000)
    runner.on('event', event); runner.once('done', finish)
    void runner.startTurn(FORK_HANDOFF_PROMPT).catch(error => finish({ failed: true, error }))
  })
}
