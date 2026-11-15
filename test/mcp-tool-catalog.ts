import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMcpCatalog, readMcpToolCatalog } from '../src/main/mcpToolCatalog.ts'
import { getAgentToolDetail, listAgentToolInventories } from '../src/main/agentToolInventory.ts'
import type { AppServerRpc } from '../src/main/appServerTransport.ts'
import { parseCapabilityInventoryDetailRequest } from '../src/shared/capabilitySync.ts'

assert.deepEqual(parseCapabilityInventoryDetailRequest({ id: 'codex:opaque', loadMcpTools: true }), { id: 'codex:opaque', loadMcpTools: true })
assert.deepEqual(parseCapabilityInventoryDetailRequest({ id: 'codex:opaque' }), { id: 'codex:opaque' })
for (const input of [null, [], { id: '' }, { id: 'x', loadMcpTools: 'true' }, { id: 'x', path: '/arbitrary/config' }, { id: 'x', serverName: 'injected' }]) {
  assert.throws(() => parseCapabilityInventoryDetailRequest(input), /invalid_selection/)
}

const server = { name: 'reader', runtimeStatus: 'connected', authStatus: 'unsupported', serverInfo: { name: 'wechat-reader', version: '1.2.3', description: 'Read WeChat articles.' },
  tools: { read: { name: 'wechat_read_article', description: 'Read an article from its URL.', inputSchema: {
    type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'Article URL.' }, token: { type: ['string', 'null'], default: 'fixture-secret', examples: ['fixture-secret'] } }
  } } } }
const normalized = normalizeMcpCatalog(server)
assert.equal(normalized.version, '1.2.3')
assert.equal(normalized.connectionStatus, 'connected')
assert.equal(normalizeMcpCatalog({ ...server, authStatus: 'notLoggedIn' }).connectionStatus, 'authenticationRequired')
assert.deepEqual(normalized.tools[0].parameters, [{ name: 'url', type: 'string', description: 'Article URL.', required: true }, { name: 'token', type: 'string | null', description: undefined, required: false }])
assert(!JSON.stringify(normalized).includes('fixture-secret'), 'schema default and example values are not exposed')
assert.equal(normalizeMcpCatalog({ tools: { invalid: null, nameOnly: { name: 'nameOnly' } } }).tools.length, 1)
assert.equal(normalizeMcpCatalog({ tools: {}, toolsError: 'secret raw error' }).status, 'failed')

for (const mode of ['success', 'empty', 'failure', 'pagination-cycle']) {
  let disposed = false, page = 0
  const calls: { method: string; params: any }[] = []
  const client = Object.assign(new EventEmitter(), { start: async () => {}, notify: () => {}, dispose: async () => { disposed = true },
    request: async (method: string, params: any) => {
      calls.push({ method, params })
      if (method !== 'mcpServerStatus/list') return {}
      if (mode === 'failure') throw new Error('fixture-secret-native-error')
      page++
      return { data: mode === 'empty' ? [] : page === 1 ? [{ ...server, name: 'unrelated' }] : [server], nextCursor: mode === 'pagination-cycle' || mode === 'success' && page === 1 ? 'next' : null }
    }
  }) as unknown as AppServerRpc
  const result = await readMcpToolCatalog('fixture', '/fixture', 'reader', 'codex', client)
  assert.equal(disposed, true)
  assert.equal(result.status, mode === 'success' ? 'loaded' : mode === 'empty' ? 'not-found' : 'failed')
  assert(!JSON.stringify(result).includes('fixture-secret'))
  assert(calls.filter(call => call.method === 'mcpServerStatus/list').every(call => call.params.serverName === 'reader' && call.params.detail === 'toolsAndAuthOnly'))
  assert(calls.every(call => ['initialize', 'mcpServerStatus/list'].includes(call.method)), 'descriptor discovery never submits a turn or executes a tool')
}

const home = await realpath(await mkdtemp(join(tmpdir(), 'ua-mcp-detail-')))
try {
  await mkdir(join(home, '.codex/skills'), { recursive: true })
  await writeFile(join(home, '.codex/config.toml'), 'model="fixture"\n[mcp_servers.authorization]\ncommand="node"\n')
  let reads = 0
  const options = { home, agents: [{ id: 'codex', name: 'Codex', bin: 'fixture-bin', installed: true, adapter: 'codex' as const }],
    pluginRunner: async (bin: string) => ({ stdout: bin === 'traecli' ? 'Plugins:\n' : '{"installed":[],"available":[]}' }),
    mcpCatalog: async (bin: string, directory: string, name: string) => {
      reads++; assert.equal(bin, 'fixture-bin'); assert.equal(directory, home); assert.equal(name, 'authorization')
      return normalized
    } }
  const item = (await listAgentToolInventories(options)).inventories[0].items.find(item => item.kind === 'mcp' && item.scope === 'agent')!
  assert.notEqual(item.name, 'authorization', 'arbitrary config keys stay behind opaque identities')
  assert.equal((await getAgentToolDetail(item.id, options)).mcp?.catalogSupported, true)
  assert.equal(reads, 0, 'opening details only reads configuration')
  assert.equal((await getAgentToolDetail(item.id, options, true)).mcp?.catalog?.tools[0].name, 'wechat_read_article')
  assert.equal(reads, 1)
  await assert.rejects(getAgentToolDetail('codex:agent:managed:forged', options, true), /invalid_selection/)
  assert.equal(reads, 1)
} finally { await rm(home, { recursive: true, force: true }) }
console.log('mcp-tool-catalog: selected server, parameter metadata, no calls, safe failures, pagination, disposal and opaque IDs passed')
