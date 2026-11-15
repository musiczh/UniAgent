import { join } from 'node:path'
import type { AppServerRpc } from './appServerTransport.ts'
import type { CapabilityMcpCatalog, CapabilityMcpTool } from '../shared/capabilitySync.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 8000): string | undefined => typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined

export function normalizeMcpCatalog(value: Record<string, unknown>): CapabilityMcpCatalog {
  const info = record(value.serverInfo) ? value.serverInfo : {}
  const tools = Object.entries(record(value.tools) ? value.tools : {}).slice(0, 1000).flatMap(([key, entry]): CapabilityMcpTool[] => {
    if (!record(entry)) return []
    const schema = record(entry.inputSchema) ? entry.inputSchema : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    return [{ name: text(entry.name, 300) || key.slice(0, 300), title: text(entry.title, 300), description: text(entry.description),
      parameters: Object.entries(record(schema.properties) ? schema.properties : {}).slice(0, 100).map(([name, raw]) => {
        const parameter = record(raw) ? raw : {}
        const types = Array.isArray(parameter.type) ? parameter.type : [parameter.type]
        return { name: name.slice(0, 300), type: types.filter(value => ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(String(value))).join(' | ') || '未指定',
          description: text(parameter.description), required: required.includes(name) }
      })
    }]
  }).sort((a, b) => a.name.localeCompare(b.name))
  const connectionStatus = value.authStatus === 'notLoggedIn' ? 'authenticationRequired' : ['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'].includes(String(value.runtimeStatus))
    ? value.runtimeStatus as CapabilityMcpCatalog['connectionStatus'] : undefined
  const authStatus = ['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(String(value.authStatus))
    ? value.authStatus as CapabilityMcpCatalog['authStatus'] : undefined
  return { status: value.toolsError ? 'failed' : 'loaded', serverName: text(info.title, 300) || text(info.name, 300), version: text(info.version, 300),
    description: text(info.description), connectionStatus, authStatus, tools }
}

/** Discover one configured server's descriptors; never submit a turn or call a tool. */
export async function readMcpToolCatalog(bin: string, home: string, serverName: string, agentId: 'codex' | 'traex', client?: AppServerRpc): Promise<CapabilityMcpCatalog> {
  try {
    client ||= new (await import('./appServerTransport.ts')).AppServerRpcClient({ bin, args: ['app-server'], cwd: home,
      timeoutMs: 15_000, env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
        ...(agentId === 'traex' ? { TRAE_HOME: join(home, '.trae') } : {}) } })
    await client.start()
    await client.request('initialize', { clientInfo: { name: 'uniagent-mcp-catalog', version: '1.0.0' }, capabilities: { experimentalApi: true } })
    client.notify('initialized', {})
    let cursor: string | null = null, catalog: CapabilityMcpCatalog | undefined
    const seen = new Set<string>()
    do {
      const page: { data?: unknown[]; nextCursor?: string | null } = await client.request('mcpServerStatus/list', {
        serverName, detail: 'toolsAndAuthOnly', cursor, limit: 100
      })
      for (const server of page.data || []) if (record(server) && server.name === serverName) {
        const next = normalizeMcpCatalog(server)
        catalog = catalog ? { ...next, tools: [...catalog.tools, ...next.tools].slice(0, 1000) } : next
      }
      cursor = page.nextCursor || null
      if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new Error('invalid_mcp_pagination')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return catalog || { status: 'not-found', tools: [] }
  } catch { return { status: 'failed', tools: [] } }
  finally { await client?.dispose() }
}
