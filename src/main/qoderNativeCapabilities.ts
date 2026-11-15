import { nativeCredentialEnv } from './agentSetupCredentials'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef } from '../shared/types'
import type { NativeCapabilitySnapshot, NativeCandidate, NativeMcpCandidate } from '../shared/nativeCapabilities'
import type { McpServerStatus } from '@qoder-ai/qoder-agent-sdk'
import { QoderSdkClient, qoderRegionForBin } from './qoderSdk.ts'
import { qoderConfigRoot } from './qoderPaths.ts'

export function projectQoderMcpCandidate(server: McpServerStatus): NativeMcpCandidate {
  return { id: `mcp:${server.name}`, kind: 'mcp', name: server.name,
    authStatus: server.status === 'needs-auth' ? 'notLoggedIn' : 'unknown',
    startupStatus: server.status === 'connected' ? 'ready' : server.status === 'needs-auth' ? 'auth-required' : server.status === 'failed' ? 'failed' : server.status === 'disabled' ? 'cancelled' : 'starting',
    toolNames: (server.tools || []).map(tool => tool.name) }
}

export async function discoverQoderNativeSnapshot(agent: AgentDef, workdir: string): Promise<NativeCapabilitySnapshot> {
  const region = qoderRegionForBin(agent.bin)
  const client = new QoderSdkClient({ region, options: { pathToQoderCLIExecutable: agent.bin, cwd: workdir,
    env: { ...process.env, ...nativeCredentialEnv(region === 'cn' ? 'qoder-cn' : 'qoder') }, permissionMode: 'default', tools: [], persistSession: false,
    settingSources: ['user', 'project', 'local'] }, initializeTimeoutMs: 30_000 })
  try {
    const init: Awaited<ReturnType<import('@qoder-ai/qoder-agent-sdk').Query['initializationResult']>> = await client.ready
    const plugins: Awaited<ReturnType<typeof import('@qoder-ai/qoder-agent-sdk').listPlugins>> = await client.request('plugins.list')
    const candidates: NativeCandidate[] = (init.commands || []).map(command => ({ id: `command:${command.name}`, kind: 'command',
      name: command.name, command: '/' + command.name, description: command.description }))
    for (const skill of init.skills || []) {
      const root = skill.source === 'project' ? join(workdir, '.qoder') : qoderConfigRoot(region, homedir())
      if (skill.name.includes('..') || /[/\\]/.test(skill.name)) continue
      const paths = [join(root, 'skills', skill.name, 'SKILL.md'), join(homedir(), '.agents/skills', skill.name, 'SKILL.md'),
        ...plugins.map(plugin => join(plugin.path, 'skills', skill.name.split(':').at(-1)!, 'SKILL.md'))]
      let path: string | undefined
      for (const candidate of paths) { try { await access(candidate); path = candidate; break } catch {} }
      if (!path) continue
      candidates.push({ id: `skill:${skill.name}`, kind: 'skill', name: skill.name, path, description: skill.description, enabled: true })
    }
    const mcp = await client.request('mcp')
    for (const server of mcp.mcpServers || []) candidates.push(projectQoderMcpCandidate(server))
    return { agentId: agent.id, workdir, source: 'provider-native', candidates, errors: [],
      actions: { goal: init.capabilities?.includes('goal_v1') === true, review: init.commands?.some(command => command.name === 'review') === true,
        plan: init.capabilities?.includes('plan_mode_v1') ? { id: 'plan', name: 'Plan', model: null, reasoningEffort: null } : null } }
  } finally { await client.close() }
}
