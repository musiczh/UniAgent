import type { AgentRole, ModelDef, ReasoningEffort, SessionConfig } from '../shared/types.ts'

// Verified with Grok 1.0.50's native registry. Unknown registry IDs fail session/new.
const TOOL_ALIASES: Record<string, string> = {
  Read: 'read_file', read_file: 'read_file',
  Bash: 'run_terminal_cmd', bash: 'run_terminal_cmd', shell: 'run_terminal_cmd',
  run_terminal_cmd: 'run_terminal_cmd', run_terminal_command: 'run_terminal_cmd',
  Edit: 'search_replace', Write: 'search_replace', MultiEdit: 'search_replace', search_replace: 'search_replace',
  Grep: 'grep', grep: 'grep', grep_search: 'grep',
  Glob: 'list_dir', ListDir: 'list_dir', list_dir: 'list_dir',
  WebSearch: 'web_search', web_search: 'web_search', WebFetch: 'web_fetch', web_fetch: 'web_fetch',
  todo_write: 'todo_write', ask_user_question: 'ask_user_question', send_feedback: 'send_feedback',
  image_gen: 'image_gen'
}
const DELEGATION_ALIASES: Record<string, string> = {
  Agent: 'Agent', Task: 'Agent', task: 'Agent', spawn_subagent: 'Agent',
  workflow: 'workflow', scheduler_create: 'scheduler_create', monitor: 'monitor',
  search_tool: 'search_tool', use_tool: 'use_tool'
}
const DELEGATION_TOOLS = ['search_tool', 'use_tool', 'Agent', 'workflow', 'scheduler_create', 'monitor']
// Native write is injected into the default profile but has no public ToolConfig registry entry.
const DENY_ONLY_ALIASES: Record<string, string[]> = { Write: ['search_replace', 'write'], write: ['write'] }
const EFFORTS = new Set<ReasoningEffort>(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Checks profile fields only; installation, models and permission modes remain caller-owned. */
export function grokRoleUnavailableReason(role: AgentRole): string | undefined {
  // Disabling discovery alone still injects a Skill after read_file reads its SKILL.md.
  if (role.skills !== undefined) return 'role_skills_unsupported'
  const policy = role.toolPolicy
  if (!policy) return undefined
  if (!['allow-only', 'deny-only'].includes(policy.mode) || !Array.isArray(policy.tools)) {
    return 'role_tool_policy_invalid'
  }
  if (policy.mode === 'deny-only' && policy.tools.length === 0) return undefined
  if (!role.id?.trim() || !role.name?.trim()) return 'role_profile_invalid'
  for (const name of policy.tools) {
    if (typeof name !== 'string') return 'role_tool_policy_invalid'
    if (Object.hasOwn(DELEGATION_ALIASES, name)) {
      if (policy.mode === 'allow-only') return `role_tool_delegation_unsupported: ${name}`
    } else if (policy.mode === 'deny-only' && Object.hasOwn(DENY_ONLY_ALIASES, name)) {
      continue
    } else if (!Object.hasOwn(TOOL_ALIASES, name)) return `role_tool_unsupported: ${name}`
  }
  return undefined
}

/** Native session/new metadata; never rewrite role instructions into a user prompt. */
export function buildGrokSessionMeta(config: SessionConfig): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {}
  if (config.permissionMode === 'approve-for-me') meta.autoMode = true
  if (config.permissionMode === 'full-access') meta.yoloMode = true
  const role = config.roleSnapshot
  if (role) {
    const reason = grokRoleUnavailableReason(role)
    if (reason) throw new Error(reason)
    if (role.instructions?.trim()) meta.rules = role.instructions
    const policy = role.toolPolicy
    if (policy && (policy.mode === 'allow-only' || policy.tools.length > 0)) {
      const tools = [...new Set(policy.tools.map(name => TOOL_ALIASES[name] || DELEGATION_ALIASES[name]))]
      const profile: Record<string, unknown> = {
        name: role.id, description: role.name, promptMode: 'extend'
      }
      if (policy.mode === 'allow-only') {
        // Native tools: [] restores the full toolset; build one valid tool, then remove it.
        const selected = tools.length ? tools : ['read_file']
        profile.injectDefaultTools = false
        profile.toolConfig = { tools: selected.map(name => ({
          id: `GrokBuild:${name}`,
          ...(name === 'run_terminal_cmd' ? { params: { enabled_background: false } } : {}),
          ...(name === 'search_replace' ? { params: { skip_read_before_edit: true } } : {})
        })) }
        // MCP bridges are injected even into curated toolsets; strip delegation before dispatch.
        profile.disallowedTools = [...DELEGATION_TOOLS, ...(tools.length ? [] : ['read_file'])]
      } else {
        profile.disallowedTools = [...new Set([
          ...policy.tools.flatMap(name => DENY_ONLY_ALIASES[name] || [TOOL_ALIASES[name] || DELEGATION_ALIASES[name]]),
          ...DELEGATION_TOOLS
        ])]
      }
      meta.agentProfile = profile
    }
  }
  return Object.keys(meta).length ? meta : undefined
}

function selectOption(response: unknown, id: string): Record<string, any> | undefined {
  if (!record(response) || !Array.isArray(response.configOptions)) return undefined
  return response.configOptions.find((entry: unknown) => record(entry) && entry.id === id && entry.type === 'select')
}

function selectValues(value: unknown): Record<string, any>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    if (!record(entry)) return []
    if (Array.isArray(entry.options)) return selectValues(entry.options)
    return typeof entry.value === 'string' && entry.value ? [entry] : []
  })
}

export function supportsGrokConfigOptions(response: unknown): boolean {
  return !!selectOption(response, 'model') || !!selectOption(response, 'reasoning_effort')
}

/** Projects the advertised native options instead of a hard-coded model/effort list. */
export function projectGrokConfigOptions(response: unknown): {
  models: ModelDef[]
  currentModelId?: string
  currentEffort?: ReasoningEffort
} {
  const model = selectOption(response, 'model')
  const effort = selectOption(response, 'reasoning_effort')
  const efforts = [...new Set(selectValues(effort?.options)
    .map(entry => entry.value)
    .filter((value): value is ReasoningEffort => EFFORTS.has(value)))]
  const currentEffort = efforts.includes(effort?.currentValue) ? effort!.currentValue as ReasoningEffort : undefined
  const seen = new Set<string>()
  const models: ModelDef[] = selectValues(model?.options).filter(entry => {
    if (seen.has(entry.value)) return false
    seen.add(entry.value)
    return true
  }).map(entry => ({
    id: entry.value,
    label: typeof entry.name === 'string' && entry.name ? entry.name : entry.value,
    efforts: [...efforts],
    ...(currentEffort ? { defaultEffort: currentEffort } : {})
  }))
  return {
    models,
    ...(typeof model?.currentValue === 'string' && model.currentValue ? { currentModelId: model.currentValue } : {}),
    ...(currentEffort ? { currentEffort } : {})
  }
}
