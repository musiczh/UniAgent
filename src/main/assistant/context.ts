import type { AssistantDocument } from '../../shared/assistant'
import type { Session, SessionConfig } from '../../shared/types'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { MessageChannel, SessionPromptContext } from '../../shared/promptContext'
import { routerInitialRequirementContext } from '../../shared/router'
import { sessionStoreWriteCommitted } from '../sessionStore'
import { splitFeishuContext } from '../../shared/feishuContext'
import { splitWeixinContext } from '../../shared/weixin'
import { initialRequirementSnapshot, stripRequirementContext } from '../requirementRuntime'
import { worktreeInstructions } from '../worktreeService'

const CONTEXT_PREFIX = '[uniagent_personal_assistant_context]'
const INPUT_MARKER = '\n\n当前用户输入：\n'

let load: ((sessionId: string) => Promise<AssistantDocument[]>) | undefined
let loadProjectContext: ((sessionId:string,config:SessionConfig)=>Promise<string>) | undefined
let lookup: (id: string) => Session | undefined = () => undefined
let save: () => void = () => {}
let buildRules: ((config: SessionConfig, sessionId: string) => string) | undefined
export function configureAssistantRules(provider: typeof buildRules): void { buildRules = provider }
export function assistantFixedRules(sessionId?: string): string | undefined { return sessionId ? state(sessionId)?.rules : undefined }
const transient = new Map<string, SessionPromptContext>()
const preparing = new Map<string, Promise<void>>()
const deliveries = new Map<string, Promise<unknown>>()
export function serializeAssistantInput<T>(key: string, run: () => Promise<T>): Promise<T> {
  const result = (deliveries.get(key) || Promise.resolve()).catch(() => {}).then(run)
  deliveries.set(key, result)
  void result.finally(() => { if (deliveries.get(key) === result) deliveries.delete(key) }).catch(() => {})
  return result
}
const inputSource = new AsyncLocalStorage<{ sessionId: string; channel: MessageChannel }>()
export function withAssistantMessageSource<T>(sessionId: string, source: string | undefined, run: () => T): T {
  return inputSource.run({ sessionId, channel: source === 'feishu' || source === 'weixin' ? source : 'app' }, run)
}
export function configureAssistantContextRuntime(resolve: typeof lookup, persist: typeof save): void {
  lookup = resolve; save = persist; transient.clear(); preparing.clear()
}
function state(id: string): SessionPromptContext | undefined { return lookup(id)?.promptContext || transient.get(id) }
function store(id: string, value: SessionPromptContext): void {
  const session = lookup(id)
  if (session) {
    const previous = session.promptContext
    session.promptContext = value
    try { save() } catch (error) { if (!sessionStoreWriteCommitted(error)) session.promptContext = previous; throw error }
  } else transient.set(id, value)
}
function binding(config: SessionConfig): string {
  const worktreePolicy = worktreeInstructions(config)
  // Match the actual thread policy without reloading snapshots for equivalent
  // defaults or Git metadata that does not change the instructions.
  const worktreeBinding = worktreePolicy ? [config.worktree?.id, worktreePolicy] : config.worktree?.id
  return JSON.stringify([config.agentId, config.projectId, config.requirementId, config.workdir, config.additionalDirectories, worktreeBinding, config.roleSnapshot, config.assistantSnapshot])
}
const git = promisify(execFile)
async function workspaceSnapshot(config: SessionConfig): Promise<object> {
  const read = async (args: string[]) => config.workdir ? (await git('git', ['-C', config.workdir, ...args], { timeout: 3000 })).stdout.trim() : undefined
  const [repository, branch, commit] = await Promise.all(['--show-toplevel', '--abbrev-ref', 'HEAD'].map((arg, i) =>
    read(i === 1 ? ['rev-parse', arg, 'HEAD'] : ['rev-parse', arg]).catch(() => undefined)))
  return { workdir: config.workdir, additionalDirectories: config.additionalDirectories || [], repository, branch, commit, worktree: config.worktree }
}
export async function prepareAssistantInitialization(session: Session, config = session.config, current?: () => boolean): Promise<void> {
  let pending = preparing.get(session.id)
  if (pending) return pending
  const previous = state(session.id)
  const sameNative = previous?.agentId === config.agentId && (!previous.nativeSessionId || previous.nativeSessionId === session.nativeSessionId)
  if (sameNative && previous.binding === binding(config) && !previous.rebuild) return
  config = structuredClone(config)
  pending = (async () => {
    const projectContext = config.managedPurpose ? '' : await loadProjectContext?.(session.id, config) || ''
    const documents = config.assistantSnapshot ? await load?.(session.id).catch(() => []) || [] : []
    const requirement = await initialRequirementSnapshot({ ...session, config })
    const memory = documents.filter(d => ['user', 'memory'].includes(d.type) && d.content.trim()).map(d => ({ file: d.type === 'user' ? 'USER.md' : 'MEMORY.md', content: d.content, revision: d.revision }))
    const snapshot = [projectContext,
      requirement ? JSON.stringify({ requirement }) : '',
      session.initialRequirementContext ? routerInitialRequirementContext(session.initialRequirementContext) : '',
      memory.length ? `${CONTEXT_PREFIX}\nUSER.md／MEMORY.md 是冻结的初始化快照；需要最新内容时使用 assistant_memory 读取，写入前核对 revision，尊重用户修改。写入不会即时修改此快照，系统上下文重建时重新加载。\n${JSON.stringify({ documents: memory })}` : ''
    ].filter(Boolean).join('\n\n')
    if (current && !current()) return
    const owned = lookup(session.id)
    if (owned && binding(owned.config) !== binding(config)) throw new Error('initialization_binding_changed')
    store(session.id, { ...(sameNative ? previous : {}), version: 1, agentId: config.agentId, nativeSessionId: session.nativeSessionId, binding: binding(config), snapshot, rules: buildRules?.(config, session.id), rebuild: false,
      fallback: sameNative ? previous!.fallback : session.nativeSessionId ? 'legacy' : 'ready',
      lastChannel: previous?.lastChannel, channelContextPending: true, compactedId: previous?.compactedId })
  })().finally(() => preparing.delete(session.id))
  preparing.set(session.id, pending)
  return pending
}
export function prepareAssistantInitializationForSession(sessionId: string, config: SessionConfig, nativeSessionId?: string): Promise<void> {
  return prepareAssistantInitialization(lookup(sessionId) || { id: sessionId, config, nativeSessionId } as Session, config)
}
export function assistantInitialization(sessionId?: string): string { return sessionId ? state(sessionId)?.snapshot || '' : '' }
export async function currentAssistantContext(sessionId: string): Promise<object> {
  const session = lookup(sessionId)
  if (!session) throw new Error('context_session_not_found')
  const value = state(sessionId)
  return { sessionId, nativeSessionId: session.nativeSessionId, agentId: session.config.agentId,
    roleId: session.config.roleSnapshot?.id, assistantId: session.config.assistantSnapshot?.assistantId, team: session.teamBinding,
    model: session.config.model, permissionMode: session.config.permissionMode, projectId: session.config.projectId, requirementId: session.config.requirementId,
    requirementName: session.config.requirementName, channel: value?.lastChannel || value?.pendingInput?.channel || 'app',
    pendingChannel: value?.pendingInput?.channel,
    time: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workspace: await workspaceSnapshot(session.config) }
}
export function queryAssistantContext(sessionId: string, args: unknown): Promise<object> {
  if (!args || typeof args !== 'object' || (args as { action?: unknown }).action !== 'context' || Object.keys(args).some(key => key !== 'action')) throw new Error('context_only_accepts_action')
  return currentAssistantContext(sessionId)
}
export function assistantContextCompacted(sessionId: string, id: string): void {
  const value = state(sessionId)
  if (!value || !id || value.compactedId === id) return
  // Fallback instructions remain in native history. No extra execution turn is injected.
  store(sessionId, { ...value, compactedId: id, rebuild: true })
}
export interface AssistantMessage {
  userText: string
  text: string
  context?: string
  content: string | Array<{ type: 'text'; text: string }>
  accepted(): void
  failed(knownNotSubmitted?: boolean): void
  bindNativeInput(id: string): void
}
export function reconcileAssistantInput(sessionId: string, nativeInputId: string): void {
  const value = state(sessionId)
  if (!nativeInputId || value?.pendingInput?.nativeInputId !== nativeInputId) return
  const { pendingInput, ...rest } = value
  store(sessionId, { ...rest, lastChannel: pendingInput.channel, acceptedInputOrdinal: rest.inputOrdinal,
    nativeSessionId: lookup(sessionId)?.nativeSessionId || rest.nativeSessionId,
    ...(pendingInput.initialization ? { fallback: 'accepted', channelContextPending: false } : {}) })
}
export function reconcileAssistantText(sessionId: string, text: string, nativeSessionId?: string): void {
  const value = state(sessionId)
  if (!nativeSessionId || value?.nativeSessionId !== nativeSessionId || !value.pendingInput?.initialization ||
    value.pendingInput.inputHash !== createHash('sha256').update(text).digest('hex')) return
  const { pendingInput, ...rest } = value
  store(sessionId, { ...rest, lastChannel: pendingInput.channel, acceptedInputOrdinal: rest.inputOrdinal, fallback: 'accepted', channelContextPending: false })
}
export async function prepareAssistantMessage(sessionId: string, config: SessionConfig, prompt: string, instructions = '', system = true, track = true): Promise<AssistantMessage> {
  if (!track) {
    const text = splitWeixinContext(prompt)?.text ?? splitFeishuContext(prompt)?.text ?? prompt
    return { userText: text, text, content: text, accepted() {}, failed() {}, bindNativeInput() {} }
  }
  const session = lookup(sessionId) || { id: sessionId, config } as Session
  await prepareAssistantInitialization(session, config)
  const feishu = splitFeishuContext(prompt), weixin = splitWeixinContext(prompt)
  const source = inputSource.getStore()
  const channel: MessageChannel = source?.sessionId === sessionId ? source.channel : weixin ? 'weixin' : feishu ? 'feishu' : 'app'
  const text = source?.sessionId === sessionId
    ? channel === 'weixin' ? weixin?.text ?? prompt : channel === 'feishu' ? feishu?.text ?? prompt : prompt
    : weixin?.text ?? feishu?.text ?? prompt
  const current = state(sessionId)!
  if (!system && current.fallback === 'pending') throw new Error('初始化指令的送达结果尚未确认，请先核对原生会话；不会重复注入或发送后续业务输入。')
  const initialization = !system && current.fallback === 'ready' && !text.trimStart().startsWith('/')
  const names = { app: 'UniAgent App', feishu: '飞书', weixin: '微信' }
  const initial = initialization ? `<uniagent_initial_context>\n${instructions}\n${instructions.includes(current.snapshot) ? '' : current.snapshot}\n</uniagent_initial_context>` : ''
  const previousChannel = current.lastChannel || (current.pendingInput?.initialization ? current.pendingInput.channel : undefined)
  const channelContext = current.channelContextPending || previousChannel !== channel ? `<uniagent_channel_context>\n当前消息通道：${previousChannel && previousChannel !== channel ? names[previousChannel] + ' → ' : ''}${names[channel]}\n</uniagent_channel_context>` : ''
  const context = [initial, !system && !text.trimStart().startsWith('/') ? channelContext : ''].filter(Boolean).join('\n\n')
  const userText = context ? `${context}\n\n${text}` : text
  const id = randomUUID()
  const ordinal = (current.inputOrdinal || 0) + 1
  store(sessionId, { ...current, nativeSessionId: lookup(sessionId)?.nativeSessionId || current.nativeSessionId, inputOrdinal: ordinal,
    ...(initialization ? { fallback: 'pending' } : {}), pendingInput: { id, channel, initialization, ...(initialization ? { inputHash: createHash('sha256').update(userText).digest('hex') } : {}) } })
  return { userText: text, text: userText, ...(system && channelContext ? { context: channelContext } : {}),
    content: system && channelContext && !text.trimStart().startsWith('/') ? [{ type: 'text', text: channelContext }, { type: 'text', text }] : userText,
    bindNativeInput(nativeInputId: string) {
      const latest = state(sessionId)!
      if (latest.pendingInput?.id === id) store(sessionId, { ...latest, pendingInput: { ...latest.pendingInput, nativeInputId } })
    },
    accepted() {
      const latest = state(sessionId)
      if (!latest || latest.binding !== current.binding) return
      const channelDelivered = channelContext && (system || !text.trimStart().startsWith('/')) && latest.compactedId === current.compactedId &&
        (latest.pendingInput?.id === id || latest.acceptedInputOrdinal === ordinal)
      const rest = { ...latest }
      if (latest.pendingInput?.id === id) delete rest.pendingInput
      store(sessionId, { ...rest, nativeSessionId: lookup(sessionId)?.nativeSessionId || rest.nativeSessionId,
        ...(channelDelivered ? { channelContextPending: false } : {}),
        ...(ordinal > (rest.acceptedInputOrdinal || 0) ? { lastChannel: channel, acceptedInputOrdinal: ordinal } : {}),
        ...(initialization || system ? { fallback: 'accepted' } : {}) })
    },
    failed(knownNotSubmitted = false) {
      const latest = state(sessionId)
      if (latest?.pendingInput?.id !== id || !knownNotSubmitted) return
      const { pendingInput: _, ...rest } = latest
      store(sessionId, { ...rest, ...(initialization ? { fallback: 'ready' } : {}) })
    }
  }
}
export function configureProjectContext(provider:typeof loadProjectContext):void{loadProjectContext=provider}
export function configureAssistantContext(provider: typeof load): void { load = provider }

export function stripAssistantContext(text: string): string {
  text = stripRequirementContext(text)
  text = text.replace(/^(?:<uniagent_(?:initial|channel)_context>[\s\S]*?<\/uniagent_(?:initial|channel)_context>\n\n)+/, '')
  return stripRequirementContext((text.startsWith(CONTEXT_PREFIX) || text.startsWith('[uniagent_global_memory_context]') || text.startsWith('你是用户在 UniAgent 中的个人助手。')) && text.includes(INPUT_MARKER)
    ? text.slice(text.indexOf(INPUT_MARKER) + INPUT_MARKER.length) : text)
}
