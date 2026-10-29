import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { AsyncLocalStorage } from 'node:async_hooks'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'

export const name = 'uniagent-role'
export const inject = ['agents', 'systemPrompt', 'tools', 'skills', 'sandboxPolicy', 'planMode']
const READ_ONLY_TOOLS = new Set(['read', 'read_file', 'read_image', 'list_directory', 'glob', 'grep', 'search_files', 'search_content', 'web_search', 'web_fetch', 'skill', 'bash', 'pwsh', 'list_agents', 'wait_agent', 'exit_plan_mode'])
const blockedInvocation = { modelInvocable: false, userInvocable: false }
export function filterDeepSeekTools(schemas, { roleSnapshot: role, permissionMode, planning = false } = {}) {
  const names = new Set(role?.toolPolicy?.tools)
  const permission = role?.permissionMode || permissionMode
  const readonly = permission === 'read-only' || permission === 'plan' || planning
  return schemas.filter(tool => {
    if (role?.toolPolicy && (role.toolPolicy.mode === 'allow-only' ? !names.has(tool.name) : names.has(tool.name))) return false
    if (tool.name === 'skill' && role?.skills?.length === 0) return false
    return !readonly || READ_ONLY_TOOLS.has(tool.name)
  })
}

export function apply(ctx, config = {}) {
  const role = config.roleSnapshot
  const toolPolicy = role?.toolPolicy
  const skillAllow = role?.skills === undefined ? undefined : new Set(role.skills)
  const toolNames = new Set(toolPolicy?.tools)
  const permissionMode = role?.permissionMode || config.permissionMode || 'ask'
  const readonly = permissionMode === 'read-only' || permissionMode === 'plan'
  const initialized = new WeakSet()
  const deniedByRole = (name) => toolPolicy && (toolPolicy.mode === 'allow-only' ? !toolNames.has(name) : toolNames.has(name))
  const isPlanning = (agent) => {
    const state = ctx.planMode.get(agent)
    return state.pending ?? state.active
  }
  const denial = (exec) => {
    if (deniedByRole(exec.name)) return `UniAgent role ${role.id} forbids tool ${exec.name}`
    if (skillAllow && exec.name === 'skill' && !skillAllow.has(exec.arguments?.name)) return `UniAgent role ${role.id} forbids skill ${exec.arguments?.name}`
    if (readonly || (exec.agent && isPlanning(exec.agent))) {
      if (!READ_ONLY_TOOLS.has(exec.name)) return `UniAgent read-only policy forbids tool ${exec.name}`
      const args = exec.arguments
      if (args && typeof args === 'object' && ['sandbox_permissions', 'sandboxMode', 'mode'].some(key => args[key] !== undefined && args[key] !== 'read-only')) return 'UniAgent read-only policy forbids sandbox escalation'
    }
  }
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (initialized.has(agent)) return
    initialized.add(agent)
    const cwd = agent.session.header.cwd
    if (toolPolicy?.mode === 'allow-only') {
      const available = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
      const unknown = [...toolNames].filter(name => !available.has(name))
      if (unknown.length) throw new Error(`DeepSeek role ${role.id} has unknown tools: ${unknown.join(', ')}`)
    }
    await agent.ctx.inject(inject, async (scoped) => {
      if (skillAllow) {
        const catalog = await ctx.skills.list({ scope: agent, cwd, signal })
        const unknown = [...skillAllow].filter(name => !catalog.some(skill => skill.name === name && (skill.invocation.modelInvocable || skill.invocation.userInvocable)))
        if (unknown.length) throw new Error(`DeepSeek role ${role.id} has unknown or disabled skills: ${unknown.join(', ')}`)
        // Reentrant discovery reads the unmasked scope without caching that view.
        // This also masks late scoped providers, not only the host catalog.
        const collecting = new AsyncLocalStorage()
        const unmaskedScope = () => {
          const view = {}
          bindScopeParent(view, agent)
          return view
        }
        const provider = `uniagent-role-${role.id}`
        scoped.skills.registerProvider(() => ({
          name: provider,
          async list(options) {
            if (collecting.getStore()) return { candidates: [], complete: false }
            return collecting.run(true, async () => {
              const lookup = { cwd: options.cwd, signal: options.signal }
              const all = await ctx.skills.list({ ...lookup, scope: unmaskedScope() })
              return all.map(skill => ({ ...skill, provider, rank: -Number.MAX_VALUE, locator: { name: skill.name }, invocation: skillAllow.has(skill.name) ? skill.invocation : blockedInvocation }))
            })
          },
          async get(candidate, options) {
            if (!skillAllow.has(candidate.name)) return undefined
            const skill = await collecting.run(true, () => ctx.skills.get(candidate.locator.name, { cwd: options.cwd, signal: options.signal, scope: unmaskedScope() }))
            return skill ? { ...skill, provider } : undefined
          }
        }))
      }
      if (role?.instructions) scoped.systemPrompt.section({ name: 'uniagent:role', text: role.instructions, order: 10210, interpolate: false })
      scoped.tools.guard(exec => {
        if (exec.agent) {
          const mode = readonly || isPlanning(exec.agent) ? 'read-only' : 'danger-full-access'
          if (ctx.sandboxPolicy.overrideOf(exec.agent.session) !== mode) setSandboxMode(exec.agent.session, mode)
        }
        return denial(exec)
      })
      if (toolPolicy) {
        const global = ctx.tools.schemas().map(tool => tool.name).filter(name => name !== 'run_code')
        if (toolPolicy.mode === 'allow-only') scoped.tools.restrict({ allow: global.filter(name => toolNames.has(name)) })
        else {
          const denied = global.filter(name => toolNames.has(name))
          if (denied.length) scoped.tools.restrict({ deny: denied })
        }
      }
      if (skillAllow?.size === 0 && ctx.tools.get('skill')) scoped.tools.restrict({ deny: ['skill'] })
      scoped.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next()
        assembly.tools = filterDeepSeekTools(assembly.tools, { ...config, planning: isPlanning(context.agent || agent) })
        return assembly
      })
      if (config.collaborationMode !== undefined) ctx.planMode.set(agent, config.collaborationMode === 'plan')
      setSandboxMode(agent.session, readonly || isPlanning(agent) ? 'read-only' : 'danger-full-access')
    })
  })
}
