import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DeepSeekHostClient, DeepSeekHostError } from './deepseekHostClient.ts'

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

export async function prepareDeepSeekHostContext(home: string): Promise<string> {
  const directory = join(home, 'uniagent-context')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const plugin = join(directory, 'plugin.mjs'), patch = join(directory, 'patch.json')
  await atomicWrite(plugin, deepseekHostContextPlugin)
  await atomicWrite(patch, JSON.stringify([{ insert: [{ id: 'uniagent-session-context', name: pathToFileURL(plugin).href,
    config: { directory } }] }]))
  return patch
}

export function registerDeepSeekHostContext(client: DeepSeekHostClient, home: string,
  servers: (sessionId: string) => DeepSeekMcpServer[] | Promise<DeepSeekMcpServer[]>): void {
  contexts.set(client, { home, servers })
}

export async function bindDeepSeekHostContext(client: DeepSeekHostClient, nativeId: string, sessionId: string, cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const context = contexts.get(client)
  if (!context) return // Standalone Host clients have no UniAgent tools to mount.
  const servers = (await context.servers(sessionId)).map(server => ({ transport: 'stdio', serverName: server.name,
    command: server.command, args: server.args, env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])),
    cwd, failOnStartupError: true, toolCallTimeoutMs: 600_000 }))
  const file = join(context.home, 'uniagent-context', createHash('sha256').update(nativeId).digest('hex') + '.json')
  signal?.throwIfAborted()
  await atomicWrite(file, JSON.stringify({ nativeId, sessionId, servers }))
  signal?.throwIfAborted()
  const response = await client.call<any>('commands/execute', { agentId: nativeId, line: '/' + command, submittedAttachments: [] }, signal)
  if (response?.result?.kind !== 'success') throw new DeepSeekHostError('session-context-unavailable')
}
