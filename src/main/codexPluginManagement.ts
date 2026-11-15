import { join } from 'node:path'
import type { AppServerRpc } from './appServerTransport.ts'

/** Called only after resolving an installed, local plugin from its opaque inventory ID. */
export async function setCodexPluginEnabled(bin: string, home: string, pluginId: string, enabled: boolean,
  client?: AppServerRpc): Promise<void> {
  client ||= new (await import('./appServerTransport.ts')).AppServerRpcClient({ bin, args: ['app-server'], cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex') } })
  try {
    await client.start()
    await client.request('initialize', { clientInfo: { name: 'uniagent-plugin-management', version: '1.0.0' }, capabilities: { experimentalApi: true } })
    client.notify('initialized', {})
    const config = await client.request<{ layers?: { name: { type: string; file?: string }; version: string }[] }>('config/read', { includeLayers: true, cwd: home })
    const filePath = join(home, '.codex/config.toml')
    const layer = config.layers?.find(layer => layer.name.type === 'user' && layer.name.file === filePath)
    const result = await client.request<{ status: string }>('config/value/write', {
      keyPath: `plugins.${JSON.stringify(pluginId)}.enabled`, value: enabled, mergeStrategy: 'upsert', filePath,
      ...(layer ? { expectedVersion: layer.version } : {})
    })
    if (result.status !== 'ok') throw new Error('capability_inventory_manage_failed')
  } finally { await client.dispose() }
}
