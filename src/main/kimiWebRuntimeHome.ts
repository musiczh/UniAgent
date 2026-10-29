import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveUserDataHome } from './userData.ts'

export interface KimiWebMcpServer { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
const writers = new Map<string, object>()
export function reserveKimiWriter(sourceHome: string, id: string, owner: object): () => void {
  mkdirSync(sourceHome, { recursive: true, mode: 0o700 })
  const storage = join(sourceHome, 'sessions')
  mkdirSync(storage, { recursive: true, mode: 0o700 })
  const key = realpathSync(storage) + '\0' + id
  if (writers.has(key) && writers.get(key) !== owner) throw new Error('kimi_runtime_already_owned')
  writers.set(key, owner)
  return () => { if (writers.get(key) === owner) writers.delete(key) }
}

/** Private per-UniAgent session config; native storage stays in its owner home. */
export function prepareKimiWebHome(sessionId: string, sourceHome: string, servers: KimiWebMcpServer[]): string {
  const source = resolve(sourceHome)
  const hash = createHash('sha256').update(source + '\0' + sessionId).digest('hex')
  const home = join(resolveUserDataHome(), 'kimi', 'web-homes', hash)
  mkdirSync(source, { recursive: true, mode: 0o700 })
  mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700)
  for (const name of ['sessions', 'store', 'blobs', 'credentials']) {
    const target = join(source, name)
    if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 })
    const link = join(home, name)
    if (existsSync(link)) {
      if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(target)) throw new Error('kimi_web_home_storage_conflict')
    } else symlinkSync(realpathSync(target), link, 'dir')
  }
  for (const name of ['config.toml', 'device_id', 'AGENTS.md', 'SYSTEM.md', 'uniagent-base-system.md']) {
    const file = join(source, name)
    if (existsSync(file)) privateWrite(join(home, name), readFileSync(file))
    else if (existsSync(join(home, name))) {
      const stat = lstatSync(join(home, name))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('kimi_web_home_config_conflict')
      unlinkSync(join(home, name))
    }
  }
  for (const name of ['agents', 'skills', 'plugins']) {
    const target = join(source, name), link = join(home, name)
    if (!existsSync(target)) continue
    if (existsSync(link)) {
      if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(target)) throw new Error('kimi_web_home_asset_conflict')
    } else symlinkSync(realpathSync(target), link, 'dir')
  }
  let config: any = { mcpServers: {} }
  const mcpFile = join(source, 'mcp.json')
  if (existsSync(mcpFile)) {
    try { config = JSON.parse(readFileSync(mcpFile, 'utf8')) }
    catch { throw new Error('kimi_web_mcp_config_unreadable') }
    if (!config || typeof config !== 'object' || Array.isArray(config) || !config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) throw new Error('kimi_web_mcp_config_invalid')
  }
  for (const server of servers) {
    if (Object.hasOwn(config.mcpServers, server.name)) throw new Error('kimi_web_mcp_name_conflict')
    config.mcpServers[server.name] = { command: server.command, args: [...server.args], env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }
  }
  privateWrite(join(home, 'mcp.json'), Buffer.from(JSON.stringify(config)))
  return home
}

function privateWrite(file: string, data: Buffer): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('kimi_web_home_config_symlink')
  const temp = file + '.tmp-' + process.pid
  writeFileSync(temp, data, { mode: 0o600 }); renameSync(temp, file); chmodSync(file, 0o600)
}
