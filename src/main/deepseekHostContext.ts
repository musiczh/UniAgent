import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DeepSeekHostClient, DeepSeekHostError } from './deepseekHostClient.ts'
import { deepseekHostTitlePlugin } from './taskTitleDeepSeek.ts'
import { ROUTER_SYSTEM_PROMPT } from '../shared/router'

export interface DeepSeekMcpServer {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}
const command = 'uniagent-bind-context'
const contexts = new WeakMap<DeepSeekHostClient, {
  home: string; servers: (sessionId: string) => DeepSeekMcpServer[] | Promise<DeepSeekMcpServer[]>
}>()

// Runs inside the official Host through its public Cordis/commands/MCP extension
// points. Configuration stays in the private home, never in command history.
export const deepseekHostContextPlugin = String.raw`
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
export const name = 'uniagent-session-context'
export const inject = ['commands', 'loader']
export async function apply(ctx, config) {
  // Use the Host module graph: native import() would create a second copy of
  // dsh-scope under Cordis's custom loader and silently make tools global.
  const mcp = await ctx.loader.import('@deepseek-ai/dsh-mcp-client')
  const bindings = new WeakMap()
  ctx.commands.register({
    name: 'uniagent-bind-context', description: 'Bind the owned UniAgent session context', recordInput: false,
    handler: async ({ agent, rawInput }) => {
      if (rawInput.trim()) return { kind: 'error', text: 'This command takes no arguments' }
      return agent.runMaintenance(async () => {
        const file = createHash('sha256').update(agent.session.id).digest('hex') + '.json'
        const raw = await readFile(join(config.directory, file), 'utf8')
        const binding = JSON.parse(raw)
        if (binding.nativeId !== agent.session.id || !Array.isArray(binding.servers)) throw new Error('Invalid session context')
        const previous = bindings.get(agent)
        if (previous?.raw === raw) return { kind: 'success' }
        bindings.delete(agent)
        for (const fiber of previous?.fibers || []) await fiber.dispose()
        const fibers = []
        try {
          if (binding.systemPrompt) {
            const policy = agent.ctx.plugin({ name: 'uniagent-session-policy', inject: ['systemPrompt'], apply(scoped) {
              scoped.systemPrompt.section({ name: 'uniagent-session', text: binding.systemPrompt, order: 10210, interpolate: false })
            } })
            fibers.push(policy)
            await policy
          }
          for (const server of binding.servers) {
            const fiber = agent.ctx.plugin(mcp, server)
            fibers.push(fiber)
            await fiber
          }
        } catch (error) {
          for (const fiber of fibers) await fiber.dispose()
          throw error
        }
        bindings.set(agent, { raw, fibers })
        return { kind: 'success' }
      })
    }
  })
}
`

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, contents, { mode: 0o600 })
  await rename(temporary, file)
}

// Reuses the Harness's public DeepSeek transport for independently named source routes.
export const deepseekSourceProviderPlugin = String.raw`
import z from '@deepseek-ai/schemastery'
export const name = 'uniagent-deepseek-model-sources'
export const inject = ['llm', 'loader', 'credentials']
export const Config = z.object({ providers: z.dict(z.any()).default({}).volatile() })
export async function apply(ctx, config) {
  let native
  try { native = await ctx.loader.import('@deepseek-ai/dsh-llm-deepseek') } catch { return }
  if (!native.registerDeepSeekProvider) return
  const launch = await ctx.loader.import('@deepseek-ai/dsh-launch-environment')
  const routes = new Map()
  const sync = () => {
    const profiles = config.providers.get()
    for (const [id, fiber] of routes) if (!profiles[id]) { fiber.dispose(); routes.delete(id) }
    for (const id of Object.keys(profiles)) if (!routes.has(id)) {
      const fiber = ctx.plugin({ name: 'uniagent-deepseek-source-route', inject: ['llm', 'credentials'], apply(child) {
        const options = () => {
          const { apiKeyEnv, displayName, ...transport } = config.providers.get()[id]
          return native.resolveAdapterOptions(native.plainOptions(native.Config(transport)), launch.launchEnvironmentOf(ctx))
        }
        native.registerDeepSeekProvider(child, id, {
          options, providerName: profiles[id].displayName || id,
          resolveAuth: async () => {
            const credential = await child.credentials.resolve(config.providers.get()[id].apiKeyEnv)
            if (!credential?.value) throw new Error('Source credential unavailable')
            return { headers: { 'x-api-key': credential.value } }
          },
          discoverModels: async provider => options().models.map(model => native.catalogModelInfo(provider, model))
        })
      } })
      routes.set(id, fiber)
    }
  }
  sync()
  ctx.on('loader/volatile-update', sync)
}
`

export async function prepareDeepSeekHostContext(home: string, options: { modelSources?: boolean; multiProvider?: boolean } = {}): Promise<string> {
  const directory = join(home, 'uniagent-context')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const plugin = join(directory, 'plugin.mjs'), patch = join(directory, 'patch.json')
  const title = join(directory, 'title.mjs')
  const sourceProvider = join(directory, 'source-provider.mjs')
  await atomicWrite(plugin, deepseekHostContextPlugin)
  await atomicWrite(title, deepseekHostTitlePlugin)
  await atomicWrite(sourceProvider, deepseekSourceProviderPlugin)
  await atomicWrite(patch, JSON.stringify([{ insert: [{ id: 'uniagent-session-context', name: pathToFileURL(plugin).href,
    config: { directory } }, { id: 'uniagent-title', name: pathToFileURL(title).href },
    ...(options.modelSources && options.multiProvider ? [{ id: 'uniagent-model-sources', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } }] : []),
    ...(options.modelSources ? [{ id: 'uniagent-deepseek-model-sources', name: pathToFileURL(sourceProvider).href, config: { providers: {} } }] : [])] }]))
  return patch
}

export function registerDeepSeekHostContext(client: DeepSeekHostClient, home: string,
  servers: (sessionId: string) => DeepSeekMcpServer[] | Promise<DeepSeekMcpServer[]>): void {
  contexts.set(client, { home, servers })
}

export async function bindDeepSeekHostContext(client: DeepSeekHostClient, nativeId: string, sessionId: string, cwd: string, signal?: AbortSignal, systemPrompt?: string): Promise<boolean> {
  signal?.throwIfAborted()
  const context = contexts.get(client)
  if (!context) return false // Standalone Host clients have no UniAgent tools to mount.
  const servers = (await context.servers(sessionId)).map(server => ({ transport: 'stdio', serverName: server.name,
    command: server.command, args: server.args, env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])),
    cwd, failOnStartupError: true, toolCallTimeoutMs: 600_000 }))
  const file = join(context.home, 'uniagent-context', createHash('sha256').update(nativeId).digest('hex') + '.json')
  signal?.throwIfAborted()
  await atomicWrite(file, JSON.stringify({ nativeId, sessionId, servers,
    ...(systemPrompt ? { systemPrompt } : servers.some(server => server.serverName === 'uniagent-router') ? { systemPrompt: ROUTER_SYSTEM_PROMPT } : {}) }))
  signal?.throwIfAborted()
  const response = await client.call<any>('commands/execute', { agentId: nativeId, line: '/' + command, submittedAttachments: [] }, signal)
  if (response?.result?.kind !== 'success') throw new DeepSeekHostError('session-context-unavailable')
  return true
}
