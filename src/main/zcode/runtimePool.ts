import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveUserDataHome } from '../userData'
import { ZCodeConnection, ZCodeRpcError } from './connection'
import { zcodeRuntimeArgs, type ZCodeRuntime } from './runtime'
import { bindZCodeHostCallbacks, type ZCodeOwner } from './account'
import { scrubZCodeDiagnostic } from './protocol'

interface PoolEntry { key: string; workspaceKey: string; dataRootId: string; connection: ZCodeConnection; generation: number; refs: number;
  temporary: string; owners: Map<string, ZCodeOwner>; independentPlanState: boolean; unbind(): void; timer?: ReturnType<typeof setTimeout> }
export interface ZCodeLease {
  connection: ZCodeConnection; generation: number; workspaceKey: string; owners: Map<string, ZCodeOwner>
  independentPlanState: boolean
  release(): Promise<void>
}
export class ZCodeRuntimePool {
  private entries = new Map<string, PoolEntry>()
  private starts = new Map<string, Promise<PoolEntry>>()
  private generation = 0
  private closed = false
  get hasActiveLeases(): boolean { return [...this.entries.values()].some(entry => entry.refs > 0) || this.starts.size > 0 }
  async acquire(runtime: ZCodeRuntime, workdir: string, storageWorkspaceKey?: string): Promise<ZCodeLease> {
    if (this.closed) throw new Error('ZCode runtime pool is closed')
    const cwd = await realpath(workdir)
    if (this.closed) throw new Error('ZCode runtime pool is closed')
    const cwdKey = createHash('sha256').update(cwd).digest('hex')
    if (storageWorkspaceKey !== undefined && !/^[a-f0-9]{64}$/.test(storageWorkspaceKey)) throw new Error('ZCode 会话存储身份无效')
    // Native history keeps its storage identity when its execution cwd moves.
    const workspaceKey = storageWorkspaceKey || cwdKey
    const key = `${runtime.fingerprint}:${runtime.config.dataRootId}:${workspaceKey}${workspaceKey === cwdKey ? '' : ':' + cwdKey}`
    for (const existing of this.entries.values()) if (existing.key !== key && existing.workspaceKey === workspaceKey && existing.dataRootId === runtime.config.dataRootId) {
      if (existing.refs > 0 || this.starts.has(existing.key)) throw new Error('ZCode 运行时已变化，当前工作区仍有旧引擎会话；请关闭相关会话或重启应用后恢复')
      await this.remove(existing)
    }
    const pendingStart = this.starts.get(key)
    let entry = pendingStart ? await pendingStart : this.entries.get(key)
    if (entry && !entry.connection.connected) { await this.remove(entry); entry = undefined }
    if (this.closed) throw new Error('ZCode runtime pool is closed')
    if (!entry) {
      let starting = this.starts.get(key)
      if (!starting) {
        starting = this.start(runtime, cwd, workspaceKey, key)
        this.starts.set(key, starting)
        void starting.finally(() => { if (this.starts.get(key) === starting) this.starts.delete(key) }).catch(() => undefined)
      }
      entry = await starting
    }
    if (this.closed || !entry.connection.connected) throw new Error('ZCode runtime closed during acquisition')
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined }
    entry.refs++
    let released = false
    const leaseEntry = entry
    return { connection: entry.connection, generation: entry.generation, workspaceKey: entry.workspaceKey, owners: entry.owners, independentPlanState: entry.independentPlanState,
      release: async () => {
        if (released) return
        released = true; leaseEntry.refs--
        if (leaseEntry.refs === 0 && !this.closed) {
          leaseEntry.timer = setTimeout(() => { void this.remove(leaseEntry).catch(() => undefined) }, 60_000)
          leaseEntry.timer.unref()
        }
      } }
  }
  private async start(runtime: ZCodeRuntime, cwd: string, workspaceKey: string, key: string): Promise<PoolEntry> {
    const root = join(resolveUserDataHome(), 'zcode', 'data', runtime.config.dataRootId, workspaceKey)
    // macOS tmpdir() is too long for ZCode's znr-<uuid>.sock Unix socket.
    const home = join(root, 'home')
    const resources = join(root, 'resources')
    const storage = join(root, 'storage')
    for (const directory of [root, home, resources, storage]) await mkdir(directory, { recursive: true, mode: 0o700 })
    // Expose only user skill directories; account files and the native session store remain isolated.
    for (const relative of ['.zcode/skills', '.agents/skills']) {
      const source = join(homedir(), relative)
      const target = join(home, relative)
      try {
        if (!(await stat(source)).isDirectory()) continue
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await symlink(source, target, 'dir')
      } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error }
    }
    const temporary = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'uzc-'))
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL,
      HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, NODE_ENV: 'production',
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'),
      ZCODE_SESSION_DB_PATH: join(root, 'session.sqlite'), ZCODE_DATA_BASE_DIR: resources, ZCODE_STORAGE_DIR: storage,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: runtime.config.personalProviderConfigPath, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: runtime.builtinProviderPath }
    const connection = new ZCodeConnection({ executable: runtime.config.executable,
      args: zcodeRuntimeArgs(runtime.config, ['app-server', '--stdio']), cwd, env })
    const owners = new Map<string, ZCodeOwner>()
    const entry: PoolEntry = { key, workspaceKey, dataRootId: runtime.config.dataRootId, connection, generation: ++this.generation, refs: 0, temporary, owners, independentPlanState: false, unbind: () => undefined }
    entry.unbind = bindZCodeHostCallbacks(connection, owners, () => !this.closed && this.entries.get(key) === entry)
    this.entries.set(key, entry)
    try {
      await connection.start()
      try {
        const capabilities = await connection.request<any>('runtime/capabilities', {})
        entry.independentPlanState = capabilities?.independentPlanState === true
      } catch (error) { if (!(error instanceof ZCodeRpcError && error.code === -32601)) throw error }
      return entry
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ZCode startup failed'
      const diagnostic = connection.stderrTail
      await this.remove(entry)
      throw new Error(scrubZCodeDiagnostic(`${message}${diagnostic ? `: ${diagnostic}` : ''}`))
    }
  }
  private async remove(entry: PoolEntry): Promise<void> {
    if (entry.timer) clearTimeout(entry.timer)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    entry.unbind(); entry.owners.clear()
    try { await entry.connection.close() } finally { await rm(entry.temporary, { recursive: true, force: true }) }
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.starts.values())
    const results = await Promise.allSettled([...this.entries.values()].map(entry => this.remove(entry)))
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
  }
}
