import { randomUUID } from 'node:crypto'

const methods = new Set(['_uniagent/goal_get', '_uniagent/goal_set', '_uniagent/goal_update', '_uniagent/plugin_action'])
const error = (message, code = -32602) => Object.assign(new Error(message), { code })
const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw error(`${field} must be a non-empty string`)
  return value
}
const optionsFor = (options, fields) => {
  if (options === undefined) return {}
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !fields.includes(key))) throw error('Unknown or invalid plugin options')
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw error('enabled must be boolean')
  if (options.approvedBuilds !== undefined && (!Array.isArray(options.approvedBuilds) || options.approvedBuilds.some(name => typeof name !== 'string' || !name.trim()))) throw error('approvedBuilds must be package names')
  if (options.registry !== undefined && options.registry !== null) {
    let url
    try { url = new URL(options.registry) } catch { throw error('registry must be an HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw error('registry must be an HTTP(S) URL without credentials')
  }
  return options
}
export const protectedEntry = row => row.patchId === 'acp' || row.patchId?.startsWith('uniagent-') || /deepseek(?:Role|Bridge|Control)Plugin\.mjs|uniagent-tool-approval\.mjs/.test(row.moduleName)

/** Public controls keep native goal continuation and profile mutations owned by DSH. */
export function createDeepSeekControls(ctx, notify) {
  const subscriptions = []
  const rounds = new WeakMap()
  const goalEvents = new WeakMap()
  const roundErrors = new WeakMap()
  const installs = new Map()
  let disposed = false
  const root = sessionId => {
    const agent = ctx.agents.get(text(sessionId, 'sessionId'))
    if (!agent || !ctx.agents.roots().includes(agent)) throw error('Unknown active root session')
    return agent
  }
  const isRoot = agent => agent && ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent)
  const usage = agent => ctx.sessionProjections.snapshot(agent.session).values.tokenUsage
  const view = agent => {
    const goal = ctx.goals.get(agent) || null
    return {
      goal,
      autonomous: goal?.phase === 'active' && goal.activation === 'armed',
      continuation: 'native',
      limit: { kind: 'rounds', ...(goal ? { maxRounds: goal.maxGoalRounds, roundsStarted: goal.roundsStarted } : {}) },
      usage: usage(agent) || null
    }
  }
  const publish = (agent, extra = {}) => {
    if (!disposed && isRoot(agent)) notify({ sessionId: agent.id, kind: 'goal', ...view(agent), ...extra })
  }
  subscriptions.push(ctx.on('agent/created', ({ agent }) => {
    if (isRoot(agent) && ctx.goals.get(agent)) publish(agent)
  }))
  subscriptions.push(ctx.on('agent/error', ({ agent, error: failure }) => {
    if (!disposed && isRoot(agent) && ctx.goals.get(agent)) {
      ctx.goals.disarm(agent)
      const round = rounds.get(agent.session)
      if (round?.round) roundErrors.set(agent.session, failure)
      else notify({ sessionId: agent.id, kind: 'goal_turn', state: 'error', output: 'native-events', error: failure, ...view(agent) })
    }
  }))
  subscriptions.push(ctx.on('goal/changed', ({ agent, change }) => publish(agent, { operation: change.operation })))
  subscriptions.push(ctx.on('goal/activation-changed', ({ sessionId }) => {
    const agent = ctx.agents.get(sessionId)
    if (isRoot(agent)) publish(agent)
  }))
  subscriptions.push(ctx.sessionProjections.onChanged((session, key) => {
    if (!['goal', 'tokenUsage'].includes(key)) return
    const agent = ctx.agents.get(session.id)
    if (isRoot(agent) && agent.session === session && ctx.goals.get(agent)) publish(agent)
  }))
  subscriptions.push(ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id)
    if (disposed || !isRoot(agent) || agent.session !== session) return
    if (event.type === 'turn/start') { rounds.set(session, { turn: event.data.turn }); roundErrors.delete(session) }
    if (event.type === 'user/message' && event.data.source?.kind === 'goal' && event.data.source.round > 0) {
      const round = { ...rounds.get(session), round: event.data.source.round, goalId: event.data.source.goalId }
      rounds.set(session, round)
      notify({ sessionId: agent.id, kind: 'goal_turn', state: 'running', output: 'native-events', ...round, ...view(agent) })
    }
    const round = rounds.get(session)
    if (round?.round) {
      goalEvents.set(event, round)
      notify({ sessionId: agent.id, kind: 'event', goalRound: round, event })
    }
    if (event.type === 'turn/end') {
      if (round?.round) notify({ sessionId: agent.id, kind: 'goal_turn', state: event.data.reason.kind === 'completed' ? 'success' : event.data.reason.kind === 'aborted' ? 'interrupted' : 'error', output: 'native-events', ...round, ...(roundErrors.has(session) ? { error: roundErrors.get(session) } : {}), reason: event.data.reason, ...view(agent) })
      rounds.delete(session)
      roundErrors.delete(session)
    }
  }))
  subscriptions.push(ctx.on('plugin-manager/install-state', progress => {
    const sessionId = installs.get(progress.requestId)
    if (sessionId && !disposed) notify({ sessionId, kind: 'plugin_action', progress })
  }))

  const goalRequest = params => {
    if (params.tokenBudget !== undefined || params.token_budget !== undefined) throw error('DeepSeek native goals do not support an exact token budget; maxRounds is a separate round limit')
    if (params.maxRounds !== undefined && (!Number.isSafeInteger(params.maxRounds) || params.maxRounds < 1)) throw error('maxRounds must be a positive safe integer')
    return { ...(params.objective !== undefined ? { objective: text(params.objective, 'objective') } : {}), ...(params.maxRounds !== undefined ? { maxGoalRounds: params.maxRounds } : {}) }
  }
  const mutateGoal = (agent, params) => {
    goalRequest(params)
    const current = ctx.goals.get(agent)
    if (!current) throw error('No current goal')
    const ref = params.ref || { id: current.id, revision: current.revision }
    if (typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw error('Invalid goal ref')
    switch (params.action) {
      case 'edit': ctx.goals.edit(agent, ref, goalRequest(params)); break
      case 'pause': ctx.goals.pause(agent, ref); break
      case 'resume': ctx.goals.resume(agent, ref); break
      case 'complete': ctx.goals.complete(agent, ref); break
      case 'block': ctx.goals.block(agent, ref, params.reason); break
      case 'clear': ctx.goals.clear(agent, ref); break
      case 'disarm': ctx.goals.disarm(agent); break
      default: throw error('Unknown goal action')
    }
    return view(agent)
  }
  async function pluginAction(agent, params, signal) {
    const manager = ctx.get('pluginManager')
    if (!manager) throw error('Native plugin management is unavailable in this profile', -32601)
    const action = params.action
    if (action === 'list') {
      const [plugins, bundles] = await Promise.all([manager.listPlugins(), manager.listBundles()])
      signal?.throwIfAborted()
      return { plugins: plugins.map(row => protectedEntry(row) ? { ...row, readOnlyReason: 'management-required' } : row), bundles }
    }
    if (action === 'inspect') return manager.inspect(text(params.spec, 'spec'), optionsFor(params.options, ['registry']), signal)
    let result
    if (action === 'enable' || action === 'disable') {
      optionsFor(params.options, [])
      if (params.target === 'bundle') result = await manager.setBundleEnabled(text(params.name, 'name'), action === 'enable')
      else if (params.target === 'entry' || params.target === undefined) {
        const id = text(params.id, 'id')
        const row = (await manager.listPlugins()).find(row => row.entryId === id)
        signal?.throwIfAborted()
        if (row && protectedEntry(row)) throw error('UniAgent transport and role enforcement plugins are required')
        result = await manager.setPluginEnabled(id, action === 'enable')
      } else throw error('target must be entry or bundle')
    } else if (action === 'install') {
      const spec = text(params.spec, 'spec')
      const options = optionsFor(params.options, ['enabled', 'registry', 'approvedBuilds'])
      const requestId = `uniagent-${randomUUID()}`
      installs.set(requestId, agent.id)
      let cancellation
      const cancel = () => { cancellation = manager.cancelInstall(requestId) }
      try {
        const operation = manager.installBundle(spec, { ...options, requestId })
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
        result = await operation
        if (cancellation) await cancellation
      } finally {
        signal?.removeEventListener('abort', cancel)
        installs.delete(requestId)
      }
    } else if (action === 'remove') {
      optionsFor(params.options, [])
      result = await manager.removeBundle(text(params.name, 'name'))
    } else throw error('Unknown plugin action')
    const restartRequired = result.application === 'restart-required'
    const output = { ...result, restartRequired, ...(restartRequired ? { message: 'Saved native plugin configuration; restart the session runtime to apply it.' } : result.error?.code === 'stop-profile' ? { message: 'Stop this session runtime before removing its active bundle.' } : {}) }
    if (!disposed) notify({ sessionId: agent.id, kind: 'plugin_action', action, result: output })
    return output
  }
  return {
    goalEvent: event => goalEvents.get(event),
    flags: { get nativeGoal() { return !!ctx.get('goals') }, get pluginManagement() { return !!ctx.get('pluginManager') }, tokenBudget: false },
    handles: method => methods.has(method),
    async dispatch(method, params = {}, signal) {
      if (disposed) throw error('DeepSeek controls disposed', -32603)
      if (!methods.has(method)) throw error('Unknown native control method', -32601)
      signal?.throwIfAborted()
      const agent = root(params.sessionId)
      if (method === '_uniagent/plugin_action') return pluginAction(agent, params, signal)
      if (!ctx.get('goals')) throw error('Native goals are unavailable', -32601)
      if (method === '_uniagent/goal_get') return view(agent)
      if (method === '_uniagent/goal_set') {
        const request = goalRequest(params)
        if (!request.objective) throw error('objective is required')
        ctx.goals.create(agent, request)
        return view(agent)
      }
      return mutateGoal(agent, params)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
    }
  }
}
