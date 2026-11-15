import { SdkWorkerClient } from './sdkWorkerClient'
import { homedir } from 'node:os'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentRole, SessionConfig } from '../shared/types'
import type { NativeReviewDraft, GoalState, ResolvedNativeTurnContext } from '../shared/nativeCapabilities'

export interface ClaudeSdkLaunch {
  options: Omit<Options, 'canUseTool' | 'hooks' | 'onElicitation' | 'onUserDialog' | 'spawnClaudeCodeProcess'>
  role?: Pick<AgentRole, 'skills' | 'toolPolicy'>
  initializeTimeoutMs?: number
}

const initializationFlights = new Map<string, Promise<any>>()
export function initializeClaudeSdk(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<any> {
  const key = JSON.stringify([bin, env])
  const existing = initializationFlights.get(key)
  if (existing) return existing
  const flight = (async () => {
    const client = new ClaudeSdkClient({ options: { pathToClaudeCodeExecutable: bin, cwd: homedir(), env,
      includePartialMessages: true, forwardSubagentText: true, extraArgs: { 'replay-user-messages': null },
      persistSession: false, settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {}, permissionMode: 'default' }, initializeTimeoutMs: timeoutMs })
    try { return await client.ready } finally { await client.close() }
  })().finally(() => { if (initializationFlights.get(key) === flight) initializationFlights.delete(key) })
  initializationFlights.set(key, flight)
  return flight
}

export class ClaudeSdkClient extends SdkWorkerClient {
  constructor(launch: ClaudeSdkLaunch) { super(launch, 'Claude', 'claudeSdkWorker') }
}

export async function claudeSdkSessionOperation(bin: string, cwd: string, method: 'forkSession' | 'deleteSession' | 'listSessions' | 'history', args: unknown, env: NodeJS.ProcessEnv = process.env): Promise<any> {
  const client = new ClaudeSdkClient({ options: { pathToClaudeCodeExecutable: bin, cwd, env,
    persistSession: false, settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {}, permissionMode: 'default' } })
  try { await client.ready; return await client.request(method, args) } finally { await client.close() }
}

export function claudeReviewPrompt(draft: NativeReviewDraft, config?: SessionConfig): string {
  if (config?.roleSnapshot?.skills !== undefined) throw new Error('当前角色的技能白名单禁止原生 Review 启动内部子代理，请在不限制技能的会话中使用 Review')
  const instructions = draft.instructions?.trim()
  let target = ''
  if (draft.scope.type === 'custom') {
    if (!instructions) throw new Error('自定义 Review 必须填写要求')
    target = '按以下要求审查当前工作区。'
  } else if (draft.scope.type === 'uncommittedChanges') target = '仅审查当前工作区的未提交改动，包含暂存、未暂存和未跟踪文件，不包含已经提交的分支提交。'
  else if (draft.scope.type === 'baseBranch') {
    if (!draft.scope.branch.trim()) throw new Error('Review base branch 不能为空')
    target = `${draft.scope.branch.trim()}...HEAD`
  } else {
    if (!draft.scope.sha.trim()) throw new Error('Review commit sha 不能为空')
    const sha = draft.scope.sha.trim()
    target = `${sha}^..${sha}`
  }
  if (target.startsWith('-') || /[\r\n]/.test(target)) throw new Error('Review 目标不能包含命令选项或换行')
  if (/(?:^|\s)--(?:fix|comment|post)(?=\s|=|$)/.test(`${target}\n${instructions || ''}`)) throw new Error('Review 只生成报告，不能传入自动修复或发布评论的命令选项')
  return `/code-review ${target}${instructions ? `\n\n补充要求：\n${instructions}` : ''}`
}

export function claudeTurnPrompt(prompt: string, context?: ResolvedNativeTurnContext): string {
  const selected = [
    ...(context?.skills || []).map(skill => `使用原生技能：${skill.name}（${skill.path}）`),
    ...(context?.mcpServers || []).map(server => `使用 MCP Server：${server.name}`)
  ]
  return selected.length ? `${prompt}\n\n用户选择的原生上下文：\n${selected.join('\n')}` : prompt
}

export function claudeGoal(objective: string, tokenBudget?: number, maxRounds?: number): GoalState {
  if (!objective.trim()) throw new Error('Goal 目标不能为空')
  if (tokenBudget !== undefined || maxRounds !== undefined) throw new Error('Claude 原生 Goal 没有公开 Token 预算或轮数限制接口')
  const now = Date.now()
  return { objective: objective.trim(), status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
    createdAt: now, updatedAt: now, continuation: 'native', autonomous: false }
}

/** Preserve the existing launch policy while moving execution and control to SDK APIs. */
export function claudeSdkLaunch(bin: string, cwd: string, args: string[], env: NodeJS.ProcessEnv, role?: AgentRole): ClaudeSdkLaunch {
  const options: ClaudeSdkLaunch['options'] = {
    pathToClaudeCodeExecutable: bin, cwd, env,
    includePartialMessages: true, forwardSubagentText: true,
    settingSources: ['user', 'project', 'local'],
    extraArgs: { 'replay-user-messages': null },
    enableFileCheckpointing: true
  }
  const extra = options.extraArgs!
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (['--print', '-p', '--verbose', '--include-partial-messages', '--forward-subagent-text'].includes(flag)) continue
    if (['--output-format', '--input-format', '--permission-prompt-tool'].includes(flag)) { index++; continue }
    if (flag === '--replay-user-messages') continue
    if (flag === '--model') options.model = args[++index]
    else if (flag === '--effort') {
      const effort = args[++index]
      if (effort === 'off') options.thinking = { type: 'disabled' }
      else if (effort !== 'auto') options.effort = effort as Options['effort']
    }
    else if (flag === '--permission-mode') options.permissionMode = (args[++index] === 'manual' ? 'default' : args[index]) as Options['permissionMode']
    else if (flag === '--append-system-prompt') options.systemPrompt = { type: 'preset', preset: 'claude_code', append: args[++index] }
    else if (flag === '--tools') options.tools = args[++index].split(',').filter(Boolean)
    else if (flag === '--disallowedTools') options.disallowedTools = args[++index].split(',').filter(Boolean)
    else if (flag === '--allowedTools') options.allowedTools = args[++index].split(',').filter(Boolean)
    else if (flag === '--settings') options.settings = args[++index]
    else if (flag === '--resume') options.resume = args[++index]
    else if (flag === '--fork-session') options.forkSession = true
    else if (flag === '--resume-session-at') options.resumeSessionAt = args[++index]
    else if (flag === '--no-session-persistence') options.persistSession = false
    else if (flag === '--strict-mcp-config') options.strictMcpConfig = true
    else if (flag === '--add-dir') {
      options.additionalDirectories ??= []
      while (args[index + 1] && !args[index + 1].startsWith('--')) options.additionalDirectories.push(args[++index])
    } else if (flag === '--mcp-config') {
      const value = JSON.parse(args[++index])
      options.mcpServers = { ...options.mcpServers, ...value.mcpServers }
    } else if (flag === '--setting-sources') options.settingSources = args[++index].split(',').filter(Boolean) as Options['settingSources']
    else if (flag.startsWith('--')) {
      const value = args[index + 1]
      extra[flag.slice(2)] = value && !value.startsWith('--') ? args[++index] : null
    } else throw new Error(`Claude SDK 启动参数无法识别：${flag}`)
  }
  if (options.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true
  if (role?.skills !== undefined) options.skills = role.skills
  return { options, ...(role ? { role: { skills: role.skills, toolPolicy: role.toolPolicy } } : {}) }
}
