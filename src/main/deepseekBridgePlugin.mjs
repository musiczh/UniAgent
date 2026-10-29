import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { apply as applyAcp, inject as acpInject } from '@deepseek-ai/dsh-acp'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { buildForkSeed } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import { isAbsolute } from 'node:path'
import { createDeepSeekControls, protectedEntry } from './deepseekControlPlugin.mjs'
import { filterDeepSeekTools } from './deepseekRolePlugin.mjs'

export const name = 'uniagent-acp-bridge'
export const inject = [...acpInject, 'sessionQuery', 'sessionProjections', 'commands', 'skills', 'tools', 'planMode', 'userQuestions', 'goals']

/** Extend the public ACP transport; the official connection retains Agent ownership and teardown. */
export function apply(ctx, config = {}) {
  const outer = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  const reader = outer.readable.getReader()
  const writer = outer.writable.getWriter()
  const roots = new Map()
  const activations = new Map()
  const questions = new Map()
  const approvals = new Map()
  const operations = new Map()
  const runs = new Map()
  const observedChildren = new Map()
  const internalRequests = new Map()
  const sessionOptions = new Map()
  const activeRoutes = new Map()
  const nativeOutputSources = new Map()
  const configRequests = new Map()
  const initializations = new Set()
  const subscriptions = []
  let input
  let stopped = false
  let imagePromptsEnabled = false
  let outputTail = Promise.resolve()
  const abortError = () => Object.assign(new Error('UniAgent request cancelled'), { code: 'ASK_ABORTED' })
  const send = message => {
    if (stopped) return Promise.reject(abortError())
    const sent = outputTail.then(() => writer.write(message))
    outputTail = sent.catch(() => {})
    return sent
  }
  const notify = params => { void send({ jsonrpc: '2.0', method: '_uniagent/session_update', params }).catch(() => {}) }
  const controls = createDeepSeekControls(ctx, notify)
  const stop = () => {
    if (stopped) return
    stopped = true
    for (const pending of questions.values()) pending.reject(abortError())
    for (const pending of approvals.values()) pending.cancel()
    for (const operation of operations.values()) operation.controller.abort(abortError())
    for (const request of internalRequests.values()) request.reject(abortError())
    questions.clear()
    approvals.clear()
    operations.clear()
    activations.clear()
    internalRequests.clear()
    roots.clear()
    runs.clear()
    observedChildren.clear()
    sessionOptions.clear()
    activeRoutes.clear()
    nativeOutputSources.clear()
    configRequests.clear()
    initializations.clear()
    controls.dispose()
    for (const dispose of subscriptions.splice(0)) dispose()
    // EOF on the inner stream triggers the official ACP connection's quiescent teardown.
    try { input.close() } catch {}
    void reader.cancel().catch(() => {})
    void outputTail.then(() => writer.close()).catch(() => {})
  }
  const liveRoot = agent => !!agent && roots.get(agent.session.id) === agent && ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent)
  const parentOf = agent => ctx.agents.list().find(parent => ctx.agents.isOwnedBy(agent.id, parent))
  const owningRoot = agent => {
    const seen = new Set()
    while (agent && !seen.has(agent)) {
      if (liveRoot(agent)) return agent
      seen.add(agent)
      agent = parentOf(agent)
    }
  }
  const requireRoot = sessionId => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw rpcError(-32602, 'sessionId must be a non-empty string')
    const agent = roots.get(sessionId)
    if (!liveRoot(agent)) throw rpcError(-32602, 'Unknown active ACP session')
    return agent
  }
  const selectedRoute = agent => {
    const value = sessionOptions.get(agent.id)?.configOptions?.find(option => option.id === 'model')?.currentValue
    try {
      const route = JSON.parse(value)
      if (Array.isArray(route) && route.length === 2 && route.every(value => typeof value === 'string' && value)) return { provider: route[0], model: route[1] }
    } catch {}
  }
  const observeRoute = (agent, turn, route) => {
    const active = activeRoutes.get(agent)
    if (!active || active.turn !== turn || typeof route?.provider !== 'string' || !route.provider || typeof route.model !== 'string' || !route.model) return
    if (active.route?.provider !== route.provider || active.route.model !== route.model) activeRoutes.set(agent, { turn, route: pick(route, ['provider', 'model']) })
  }
  const validImageSessionId = value => typeof value === 'string' && !!value.trim() && value === value.trim()
    && !/[\u0000-\u001f\u007f/\\]/.test(value) && value !== '.' && value !== '..'
  const imageHistory = async (ownerSessionId, childSessionId, signal) => {
    if (!validImageSessionId(ownerSessionId)) throw rpcError(-32602, 'sessionId must name an exact native session')
    const read = async id => {
      if (!validImageSessionId(id)) throw rpcError(-32602, 'Invalid native image session identity')
      let snapshot
      try { snapshot = await ctx.sessionQuery.readSession(id) }
      catch { signal.throwIfAborted(); throw rpcError(-32602, 'Unknown native image session') }
      signal.throwIfAborted()
      if (snapshot?.session?.id !== id || !Array.isArray(snapshot.events)) throw rpcError(-32602, 'Invalid native image session history')
      return snapshot
    }
    const owner = await read(ownerSessionId)
    const agent = roots.get(ownerSessionId)
    const activeOwner = liveRoot(agent)
    if (childSessionId === undefined) return owner
    if (!validImageSessionId(childSessionId) || childSessionId === ownerSessionId) throw rpcError(-32602, 'childSessionId must name a native child session')
    const child = await read(childSessionId)
    if (!activeOwner || !observedChildren.get(agent)?.has(childSessionId)) {
      const seen = new Set([ownerSessionId])
      let snapshot = child
      while (true) {
        const { id, parentSession, origin } = snapshot.session
        if (seen.has(id) || origin !== 'subagent' || !validImageSessionId(parentSession)) throw rpcError(-32602, 'Child history is not owned by this ACP root')
        seen.add(id)
        if (parentSession === ownerSessionId) break
        snapshot = await read(parentSession)
      }
    }
    if (activeOwner && !liveRoot(agent)) throw rpcError(-32602, 'Unknown active ACP session')
    return child
  }
  const commandsFor = agent => ctx.commands.list(agent).map(command => pick(command, ['definitionId', 'name', 'description', 'input']))
  const stockRequest = (method, params, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const id = 'uniagent:acp:' + randomUUID()
    const settle = (fn, value) => {
      if (!internalRequests.delete(id)) return
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      input.enqueue({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: id } })
      settle(reject, abortError())
    }
    internalRequests.set(id, { resolve: value => settle(resolve, value), reject: error => settle(reject, error) })
    signal?.addEventListener('abort', onAbort, { once: true })
    route({ jsonrpc: '2.0', id, method, params })
  })
  const sessionOwner = session => {
    const agent = ctx.agents.get(session.id)
    if (agent?.session !== session) return
    const root = owningRoot(agent)
    if (!root) return
    return { sessionId: root.id, ...(agent === root ? {} : { childSessionId: agent.id, parentSessionId: parentOf(agent)?.id }) }
  }
  subscriptions.push(ctx.sessionProjections.onChanged((session, key, value, seq) => {
    if (!['tokenUsage', 'contextPressure', 'contextBreakdown', 'todos', 'plan', 'goal'].includes(key)) return
    const owner = sessionOwner(session)
    if (owner) notify({ ...owner, kind: 'projection', key, value, seq })
  }))
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    const config = await next()
    if (liveRoot(agent)) observeRoute(agent, turn, config)
    return config
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    const owner = sessionOwner(session)
    if (!owner) return
    if (!owner.childSessionId) {
      const agent = roots.get(session.id)
      if (event.type === 'turn/start') activeRoutes.set(agent, { turn: event.data.turn })
      if (event.type === 'request/header' && activeRoutes.has(agent)) observeRoute(agent, activeRoutes.get(agent).turn, event.data.header.config)
      if (event.type === 'turn/end' && activeRoutes.get(agent)?.turn === event.data.turn) activeRoutes.delete(agent)
    }
    const goalRound = controls.goalEvent(event)
    if (!goalRound) notify({ ...owner, kind: 'event', event })
    let sources = nativeOutputSources.get(session.id)
    if (!sources) nativeOutputSources.set(session.id, sources = { messages: new Map(), tools: new Map() })
    const source = { turn: event.data.turn, round: 0, ...goalRound, eventSeq: event.seq }
    if (event.type === 'assistant/message') sources.messages.set(event.data.message.id, source)
    if (event.type === 'tool/call') sources.tools.set(event.data.callId, source)
    if (event.type === 'tool/result') sources.tools.set(event.data.message.toolCallId, source)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    nativeOutputSources.delete(agent.id)
    for (const pending of approvals.values()) if (pending.child === agent || pending.root === agent) pending.cancel()
    if (roots.get(agent.id) === agent) roots.delete(agent.id)
  })
  ctx.on('subagent/start', function (info) {
    const child = ctx.agents.get(info.id)
    const parent = carrierKeyOf(this) ?? (child && parentOf(child))
    const root = parent && owningRoot(parent)
    if (!root) return
    if (child && ctx.agents.isOwnedBy(child.id, parent)) {
      let children = observedChildren.get(root)
      if (!children) observedChildren.set(root, children = new Set())
      // The exact live root retains image access after its observed child is disposed.
      children.add(child.id)
    }
    const owner = { sessionId: root.id, parentSessionId: parent.id }
    runs.set(info.runId, owner)
    notify({ ...owner, kind: 'subagent_start', ...pick(info, ['runId', 'provider', 'id', 'local']) })
  })
  ctx.on('subagent/end', info => {
    const owner = runs.get(info.runId)
    runs.delete(info.runId)
    if (owner) notify({ ...owner, kind: 'subagent_end', ...pick(info, ['runId', 'provider', 'id', 'local', 'stopReason', 'lastAssistantMessage']) })
  })
  ctx.on('approval/request', async (request, next) => {
    const child = request.agent
    if (stopped || !child || ctx.agents.get(child.id) !== child || liveRoot(child) || request.callId === undefined) return next()
    const root = owningRoot(child)
    if (!root) return next()
    if (request.signal?.aborted) return 'cancelled'
    const outcome = await new Promise((resolve, reject) => {
      const id = 'uniagent:' + randomUUID()
      const settle = (fn, value) => {
        if (!approvals.delete(id)) return
        request.signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => settle(resolve, 'cancelled')
      approvals.set(id, {
        sessionId: root.id, root, child, cancel: onAbort,
        resolve: response => {
          const outcome = response?.outcome
          if (outcome?.outcome === 'cancelled') settle(resolve, 'cancelled')
          else if (outcome?.outcome === 'selected' && outcome.optionId === 'allow-once') settle(resolve, 'allowed-once')
          else if (outcome?.outcome === 'selected' && outcome.optionId === 'reject-once') settle(resolve, 'rejected')
          else settle(resolve, 'unavailable')
        },
        reject: error => settle(reject, error)
      })
      request.signal?.addEventListener('abort', onAbort, { once: true })
      void send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
        sessionId: root.id, _meta: { childSessionId: child.id }, toolCall: { toolCallId: request.callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
        ]
      } }).catch(error => settle(reject, error))
    })
    return ctx.agents.get(child.id) === child && owningRoot(child) === root ? outcome : 'cancelled'
  })
  ctx.on('user-questions/request', async (request, next) => {
    if (!liveRoot(request.agent) || stopped) return next()
    request.signal?.throwIfAborted()
    const answer = await new Promise((resolve, reject) => {
      const id = 'uniagent:' + randomUUID()
      const settle = (fn, value) => {
        if (!questions.delete(id)) return
        request.signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => settle(reject, abortError())
      questions.set(id, { sessionId: request.agent.id, resolve: value => settle(resolve, value), reject: error => settle(reject, error) })
      request.signal?.addEventListener('abort', onAbort, { once: true })
      void send({ jsonrpc: '2.0', id, method: '_uniagent/ask_user_question', params: { sessionId: request.agent.id, questions: request.questions } }).catch(error => settle(reject, error))
    })
    validateAnswer(answer, request.questions)
    return answer
  })

  const dispatch = async (method, params, signal) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw rpcError(-32602, 'Parameters must be an object')
    if (method === '_uniagent/read_image') {
      if (!Number.isSafeInteger(params.eventSeq) || params.eventSeq < 0 || !Number.isSafeInteger(params.blockIndex) || params.blockIndex < 0 || params.toolResult !== undefined && typeof params.toolResult !== 'boolean') throw rpcError(-32602, 'Image selector must name an event and content block')
      if (Object.keys(params).some(key => !['sessionId', 'childSessionId', 'eventSeq', 'blockIndex', 'toolResult'].includes(key))) throw rpcError(-32602, 'Image reads accept only a recorded event selector')
      const snapshot = await imageHistory(params.sessionId, params.childSessionId, signal)
      signal.throwIfAborted()
      const event = snapshot.events.find(event => event.seq === params.eventSeq)
      const block = event?.type === (params.toolResult ? 'tool/result' : 'assistant/message') ? event.data.message?.content?.[params.blockIndex] : undefined
      if (block?.type !== 'image' || !block.attachment) throw rpcError(-32602, 'Selector does not name a recorded native image')
      const attachments = ctx.get('attachments')
      if (!attachments) throw rpcError(-32603, 'Native attachment service is unavailable')
      let stored
      try { stored = await attachments.readImage(block.attachment, signal) }
      catch { signal.throwIfAborted(); throw rpcError(-32603, 'Native image attachment is unavailable or corrupt') }
      signal.throwIfAborted()
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(stored.ref.mediaType)) throw rpcError(-32603, 'Native image attachment media type is unsupported')
      return { dataUrl: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` }
    }
    if (controls.handles(method)) {
      requireRoot(params.sessionId)
      return controls.dispatch(method, params, signal)
    }
    if (method === '_uniagent/list_sessions') {
      if (params.cwd !== undefined && (typeof params.cwd !== 'string' || !isAbsolute(params.cwd))) throw rpcError(-32602, 'cwd must be absolute')
      if (params.cursor !== undefined && (typeof params.cursor !== 'string' || !/^\d+$/.test(params.cursor) || !Number.isSafeInteger(Number(params.cursor)))) throw rpcError(-32602, 'cursor must be a page offset')
      const entries = (await ctx.sessionQuery.listSessions(signal)).filter(entry => !params.cwd || entry.header.cwd === params.cwd)
      const offset = params.cursor === undefined ? 0 : Number(params.cursor)
      const limit = config.sessionListPageSize ?? 100
      return {
        sessions: entries.slice(offset, offset + limit).map(entry => ({ sessionId: entry.header.id, cwd: entry.header.cwd, createdAt: entry.header.createdAt, parentSessionId: entry.header.parentSession, isSeeded: entry.header.isSeeded, origin: entry.header.origin, live: entry.live, persisted: entry.persisted })),
        ...(offset + limit < entries.length ? { nextCursor: String(offset + limit) } : {})
      }
    }
    if (method === '_uniagent/history') {
      if (typeof params.sessionId !== 'string' || !params.sessionId.trim()) throw rpcError(-32602, 'sessionId must be a non-empty string')
      return ctx.sessionQuery.readSession(params.sessionId)
    }
    if (method === '_uniagent/fork') {
      if (typeof params.sessionId !== 'string' || !params.sessionId.trim()) throw rpcError(-32602, 'sessionId must be a non-empty string')
      if (params.mcpServers !== undefined && !Array.isArray(params.mcpServers)) throw rpcError(-32602, 'mcpServers must be an ACP server array')
      if (params.configOptions !== undefined && (!Array.isArray(params.configOptions) || params.configOptions.some(option => !option || !['model', 'reasoning_effort'].includes(option.id) || typeof option.currentValue !== 'string' || !option.currentValue))) throw rpcError(-32602, 'configOptions must name native model or reasoning selections')
      if (new Set(params.configOptions?.map(option => option.id)).size !== (params.configOptions?.length ?? 0)) throw rpcError(-32602, 'configOptions must not repeat an option')
      const snapshot = await ctx.sessionQuery.readSession(params.sessionId)
      signal.throwIfAborted()
      const boundary = params.eventSeq ?? snapshot.events.at(-1)?.seq
      if (boundary !== undefined && (!Number.isSafeInteger(boundary) || boundary < 0 || snapshot.events[boundary]?.seq !== boundary)) throw rpcError(-32602, 'eventSeq must name an existing inclusive event boundary')
      const sourceOptions = sessionOptions.get(params.sessionId)
      const sessionId = randomUUID()
      const seed = boundary === undefined ? [] : buildForkSeed(snapshot.events, boundary)
      const routeOptions = seed.findLast(event => event.type === 'request/header')?.data.header.config ?? { provider: config.provider, model: config.model }
      const handle = await ctx.agents.create({
        sessionId, seed, inheritedEventCount: boundary === undefined ? 0 : boundary + 1,
        meta: { cwd: snapshot.session.cwd, parentSession: params.sessionId, isSeeded: true },
        agentOptions: pick(routeOptions, ['provider', 'model', 'reasoningEffort', 'maxTokens']), signal
      })
      try { await ctx.sessions.flush(handle.agent.session) } finally { await handle.dispose() }
      signal.throwIfAborted()
      try {
        let result = await stockRequest('session/resume', { sessionId, cwd: snapshot.session.cwd, mcpServers: params.mcpServers ?? sourceOptions?.mcpServers ?? [] }, signal)
        const selections = new Map((sourceOptions?.configOptions ?? []).map(option => [option.id, option]))
        for (const option of params.configOptions ?? []) selections.set(option.id, option)
        for (const id of ['model', 'reasoning_effort']) {
          const option = selections.get(id)
          if (option?.currentValue === undefined) continue
          result = await stockRequest('session/set_config_option', { sessionId, configId: id, value: option.currentValue }, signal)
          if (result.configOptions?.find(value => value.id === id)?.currentValue !== option.currentValue) throw rpcError(-32603, `Native fork did not confirm ${id}`)
        }
        return { sessionId, cwd: snapshot.session.cwd, ...(result.configOptions ? { configOptions: result.configOptions } : {}) }
      } catch (error) {
        if (!stopped) await stockRequest('session/close', { sessionId }).catch(() => {})
        throw error
      }
    }
    if (!['_uniagent/capabilities', '_uniagent/set_mode', '_uniagent/command', '_uniagent/inventory', '_uniagent/steer', '_uniagent/subagent_cancel'].includes(method)) throw rpcError(-32601, 'Unknown UniAgent method')
    const agent = requireRoot(params.sessionId)
    if (method === '_uniagent/capabilities') {
      const commands = commandsFor(agent)
      return { version: 1, flags: { history: true, planMode: true, commands: true, compaction: commands.some(command => command.name === 'compact'), inventory: true, usage: true, questions: true, subagents: !!ctx.get('subagents'), steer: true, sessionFork: true, sessionForkAtTurn: true, ...controls.flags }, commands }
    }
    if (method === '_uniagent/steer') {
      if (Object.keys(params).some(key => !['sessionId', 'text', 'prompt'].includes(key)) || params.prompt !== undefined && params.text !== undefined) throw rpcError(-32602, 'Steer accepts either text or an ACP prompt')
      const prompt = params.prompt ?? [{ type: 'text', text: params.text }]
      if (!Array.isArray(prompt) || !prompt.length) throw rpcError(-32602, 'prompt must be a non-empty ACP content array')
      const parts = []
      let pendingText = ''
      let meaningful = false
      let hasImages = false
      const flushText = () => {
        if (pendingText) parts.push({ type: 'text', text: pendingText })
        pendingText = ''
      }
      for (const block of prompt) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) throw rpcError(-32602, 'Invalid ACP steer content block')
        if (block.type === 'text') {
          if (typeof block.text !== 'string') throw rpcError(-32602, 'Steer text must be a string')
          meaningful ||= !!block.text.trim()
          pendingText += block.text
        } else if (block.type === 'resource_link') {
          if (typeof block.name !== 'string' || !block.name.trim() || typeof block.uri !== 'string' || !block.uri.trim()) throw rpcError(-32602, 'Steer resource links must name a URI')
          meaningful = true
          pendingText += `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
        } else if (block.type === 'image') {
          if (typeof block.data !== 'string' || !block.data || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.mimeType)) throw rpcError(-32602, 'Steer images require encoded raster bytes and a supported MIME type')
          meaningful = hasImages = true
          flushText()
          parts.push({ type: 'image', mediaType: block.mimeType, data: block.data })
        } else throw rpcError(-32602, 'Unsupported ACP steer content')
      }
      flushText()
      if (!meaningful) throw rpcError(-32602, 'Steer prompt must contain text or an attachment')
      signal.throwIfAborted()
      const active = activeRoutes.get(agent)
      const idleRoute = active ? undefined : selectedRoute(agent)
      const attachments = ctx.get('attachments')
      if (hasImages) {
        if (!imagePromptsEnabled) throw rpcError(-32602, 'Inline image prompts were not advertised by this ACP connection')
        const route = active ? active.route : idleRoute
        const llm = ctx.get('llm')
        if (!attachments || !llm || !route?.provider || !route.model) throw rpcError(-32602, 'The current model route could not be resolved for image input')
        let info
        try { info = await llm.resolveModelInfo(route.provider, route.model, signal) }
        catch { signal.throwIfAborted(); throw rpcError(-32603, 'The current model route could not be verified for image input') }
        if (!info.inputModalities?.includes('image')) throw rpcError(-32602, 'The current model does not declare image input')
      }
      signal.throwIfAborted()
      let content
      try { content = attachments ? await attachments.admitPromptContent(parts) : parts }
      catch (error) {
        signal.throwIfAborted()
        throw rpcError(isImageAdmissionError(error) ? -32602 : -32603, isImageAdmissionError(error) ? error.message : 'Unable to persist steer image content')
      }
      signal.throwIfAborted()
      if (!liveRoot(agent) || activeRoutes.get(agent) !== active) throw rpcError(-32602, 'The active ACP turn changed during steer admission')
      if (hasImages && !active) {
        const currentRoute = selectedRoute(agent)
        if (currentRoute?.provider !== idleRoute?.provider || currentRoute?.model !== idleRoute?.model) throw rpcError(-32602, 'The selected model changed during steer admission')
      }
      agent.steer(createUserMessage({ source: { kind: 'user' }, content }))
      return { accepted: true }
    }
    if (method === '_uniagent/subagent_cancel') {
      if (typeof params.childSessionId !== 'string' || !params.childSessionId.trim()) throw rpcError(-32602, 'childSessionId must be non-empty')
      const child = ctx.agents.get(params.childSessionId)
      if (!child || child === agent || owningRoot(child) !== agent) throw rpcError(-32602, 'Child is not owned by this ACP root')
      signal.throwIfAborted()
      for (const pending of approvals.values()) if (pending.child === child) pending.cancel()
      ctx.get('subagents')?.interrupt(child.id, { kind: 'ancestor', agent })
      child.cancel({ kind: 'user' }, { keepInbox: true })
      return { accepted: true }
    }
    if (method === '_uniagent/set_mode') {
      if (params.mode !== 'default' && params.mode !== 'plan') throw rpcError(-32602, 'mode must be default or plan')
      const change = ctx.planMode.set(agent, params.mode === 'plan')
      const permission = config.roleSnapshot?.permissionMode ?? config.permissionMode
      setSandboxMode(agent.session, params.mode === 'plan' || permission === 'read-only' || permission === 'plan' ? 'read-only' : 'danger-full-access')
      return { mode: params.mode, change, ...ctx.planMode.get(agent) }
    }
    if (method === '_uniagent/command') {
      if (typeof params.line !== 'string' || !params.line.startsWith('/')) throw rpcError(-32602, 'line must be a native slash command')
      const execution = await ctx.commands.execute(agent, params.line, [], signal)
      if (!execution) throw rpcError(-32602, 'Unknown native command')
      return execution
    }
    const [skills, inventory] = await Promise.all([
      ctx.skills.list({ scope: agent, cwd: agent.session.header.cwd, signal }),
      readPluginInventory(ctx)
    ])
    signal.throwIfAborted()
    const managedRows = inventory.managementAvailable === true ? await ctx.get('pluginManager').listPlugins() : []
    const protectedIds = new Set(managedRows.filter(protectedEntry).map(row => row.entryId))
    const pluginRow = row => ({
      ...pick(row, ['entryId', 'moduleName', 'enabled', 'fiberPhase']),
      ...(row.meta ? { meta: publicMeta(row.meta) } : {}),
      ...(protectedIds.has(row.entryId) || protectedEntry(row) || row.moduleName === '@deepseek-ai/dsh-acp' ? { manageable: false, readOnlyReason: 'management-required' } : {})
    })
    const plan = ctx.planMode.get(agent)
    return {
      skills: skills.filter(skill => skill.invocation.modelInvocable || skill.invocation.userInvocable).map(skill => pick(skill, ['name', 'description', 'whenToUse', 'source', 'provider', 'path', 'invocation'])),
      tools: filterDeepSeekTools(ctx.tools.schemas(agent), { ...config, planning: plan.pending ?? plan.active }).map(tool => pick(tool, ['name', 'description', 'parameters'])),
      commands: commandsFor(agent),
      plugins: {
        managementAvailable: inventory.managementAvailable === true,
        entries: inventory.entries.map(pluginRow),
        ...(inventory.agentPresets ? { agentPresets: inventory.agentPresets.map(preset => ({ ...pick(preset, ['id', 'name', 'isDefault', 'broken']), rows: preset.rows.map(pluginRow) })) } : {})
      }
    }
  }
  const route = message => {
    if (typeof message.id === 'string' && message.id.startsWith('uniagent:') && message.method === undefined) {
      const pending = questions.get(message.id) ?? approvals.get(message.id)
      if (pending) message.error ? pending.reject(rpcError(message.error.code, message.error.message)) : pending.resolve(message.result)
      return
    }
    if (typeof message.method === 'string' && message.method.startsWith('_uniagent/')) {
      if (message.id === undefined) return
      if (operations.has(message.id)) { void send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate request id' } }).catch(() => {}); return }
      const operation = { sessionId: message.params?.sessionId, controller: new AbortController() }
      operations.set(message.id, operation)
      void dispatch(message.method, message.params, operation.controller.signal).then(
        result => send({ jsonrpc: '2.0', id: message.id, result }),
        error => send({ jsonrpc: '2.0', id: message.id, error: { code: typeof error?.code === 'number' ? error.code : -32603, message: typeof error?.message === 'string' ? error.message : 'Native extension failed' } })
      ).catch(() => {}).finally(() => { if (operations.get(message.id) === operation) operations.delete(message.id) })
      return
    }
    if (message.method === '$/cancel_request') operations.get(message.params?.requestId)?.controller.abort(abortError())
    if (message.method === 'session/cancel' || message.method === 'session/close') {
      for (const pending of questions.values()) if (pending.sessionId === message.params?.sessionId) pending.reject(abortError())
      for (const pending of approvals.values()) if (pending.sessionId === message.params?.sessionId) pending.cancel()
      for (const operation of operations.values()) if (operation.sessionId === message.params?.sessionId) operation.controller.abort(abortError())
    }
    if (message.method === 'initialize') initializations.add(message.id)
    if (message.method === 'session/set_config_option') configRequests.set(message.id, message.params.sessionId)
    if (message.method === 'session/new' || message.method === 'session/resume') activations.set(message.id, message.params)
    input.enqueue(message)
  }
  const stream = {
    readable: new ReadableStream({ start(controller) { input = controller }, cancel() { stop() } }),
    writable: new WritableStream({ write(message) {
      if (message.method === 'session/update') {
        const params = message.params
        const update = params.update
        const sources = nativeOutputSources.get(params.sessionId)
        const source = update.messageId ? sources?.messages.get(update.messageId) : update.toolCallId ? sources?.tools.get(update.toolCallId) : undefined
        if (source) message = { ...message, params: { ...params, _meta: { ...params._meta, 'uniagent/nativeOutput': source } } }
      }
      if (initializations.delete(message.id) && !message.error) {
        imagePromptsEnabled = message.result?.agentCapabilities?.promptCapabilities?.image === true
        message = { ...message, result: { ...message.result, _meta: { ...message.result?._meta, 'uniagent/bridge': { version: 1 } } } }
      }
      if (configRequests.has(message.id) && message.method === undefined) {
        const sessionId = configRequests.get(message.id)
        configRequests.delete(message.id)
        if (!message.error && sessionOptions.has(sessionId)) sessionOptions.get(sessionId).configOptions = message.result.configOptions
      }
      if (activations.has(message.id) && message.method === undefined) {
        const options = activations.get(message.id)
        const sessionId = message.result?.sessionId ?? options.sessionId
        activations.delete(message.id)
        if (!message.error && sessionId) {
          const agent = ctx.agents.get(sessionId)
          if (agent && ctx.agents.roots().includes(agent)) {
            roots.set(sessionId, agent)
            sessionOptions.set(sessionId, { mcpServers: options.mcpServers ?? [], configOptions: message.result.configOptions })
          }
        }
      }
      if (typeof message.id === 'string' && message.id.startsWith('uniagent:acp:') && message.method === undefined) {
        const pending = internalRequests.get(message.id)
        if (pending) message.error ? pending.reject(rpcError(message.error.code, message.error.message)) : pending.resolve(message.result)
        return
      }
      return send(message)
    }, abort() { stop() } })
  }
  ctx.effect(() => stop, 'uniagent.acp-bridge')
  const persistence = ctx.sessionPersistence
  const admission = new Proxy(persistence, { get(target, key) {
    if (key !== 'stat') return Reflect.get(target, key)
    return async (sessionId, options) => {
      const stat = await persistence.stat(sessionId, options)
      const header = stat?.header
      // Only the ACP admission snapshot changes; the Agent factory restores the actual persisted lineage.
      if (header?.isSeeded && header.parentSession && header.origin !== 'subagent') {
        const { parentSession, ...rootHeader } = header
        return { ...stat, header: rootHeader }
      }
      return stat
    }
  } })
  applyAcp(ctx.extend({ sessionPersistence: admission }), { provider: config.provider, model: config.model, ...(config.sessionListPageSize ? { sessionListPageSize: config.sessionListPageSize } : {}), stream })
  void (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read()
        if (done) break
        route(value)
      }
    } catch {
      // The official adapter observes inner EOF and drains its own sessions.
    } finally { stop() }
  })()
}

function rpcError(code, message) { return Object.assign(new Error(message), { code }) }
function pick(value, keys) { return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) }
function publicMeta(meta) {
  return pick(meta, ['title', 'description', 'icon', 'error'])
}
function validateAnswer(answer, questions) {
  if (!answer || !Array.isArray(answer.answers) || answer.answers.length !== questions.length) throw rpcError(-32602, 'Answer must name every question exactly once')
  const seen = new Set()
  for (const item of answer.answers) {
    const question = questions.find(question => question.id === item?.id)
    if (!question || seen.has(item.id) || !Array.isArray(item.selected) || item.selected.some(value => typeof value !== 'string') || (item.custom !== undefined && typeof item.custom !== 'string')) throw rpcError(-32602, 'Malformed user answer')
    if (!question.multiSelect && item.selected.length > 1) throw rpcError(-32602, 'Question accepts one selection')
    if (item.selected.some(label => !question.options?.some(option => option.label === label))) throw rpcError(-32602, 'Unknown answer option')
    seen.add(item.id)
  }
}
