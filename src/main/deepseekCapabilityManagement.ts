import { isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ACPConnection } from './acp/acpConnection.ts'
import { projectDeepSeekInventory, resolveDeepSeekPluginEntryId } from './deepseekInventory.ts'
import { parseDeepSeekCapabilityManageRequest, type CapabilityAgentInventory, type DeepSeekCapabilityManageResult } from '../shared/capabilitySync.ts'

type JsonRecord = Record<string, any>
export interface DeepSeekCapabilityConnection {
  initialize(): Promise<any>
  request(method: string, params?: any, timeoutMs?: number): Promise<any>
  close(): void
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}
export interface DeepSeekCapabilityManagementOptions {
  bin: string
  cwd: string
  /** Main supplies the persistent shared profile's environment once, reused for verification boots. */
  env: NodeJS.ProcessEnv
  /** Main-only transport fixture; never part of a renderer request. */
  connectionFactory?: () => DeepSeekCapabilityConnection
}
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'
const SAFE_ERRORS = new Set(['invalid_capability_inventory_manage_request', 'capability_inventory_stale',
  'capability_inventory_read_only', 'capability_inventory_action_unsupported', 'capability_inventory_already_exists',
  'capability_inventory_unavailable', 'capability_inventory_invalid_config', 'capability_inventory_manage_failed'])
const queues = new Map<string, Promise<unknown>>()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const packageName = (value: unknown): value is string => typeof value === 'string' && value.length <= 214 &&
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value)
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)
function fail(code = 'capability_inventory_manage_failed'): never { throw new Error(code) }
const protectedPlugin = (row: JsonRecord): boolean => row.readOnlyReason !== undefined || row.manageable === false ||
  row.patchId === 'acp' || (typeof row.patchId === 'string' && row.patchId.startsWith('uniagent-')) ||
  row.moduleName === '@deepseek-ai/dsh-acp' ||
  (typeof row.moduleName === 'string' && /deepseek(?:Role|Bridge|Control)Plugin\.mjs|uniagent-tool-approval\.mjs/.test(row.moduleName))

async function serial<T>(options: DeepSeekCapabilityManagementOptions, work: (options: DeepSeekCapabilityManagementOptions) => Promise<T>): Promise<T> {
  const dshHome = options.env.DSH_HOME
  if (!dshHome || !isAbsolute(dshHome)) fail('capability_inventory_unavailable')
  const key = resolve(dshHome), env = { ...process.env, ...options.env }
  const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => work({ ...options, env }))
  queues.set(key, pending)
  try { return await pending } catch (error) {
    const code = error instanceof Error ? error.message : ''
    return fail(SAFE_ERRORS.has(code) ? code : 'capability_inventory_manage_failed')
  } finally { if (queues.get(key) === pending) queues.delete(key) }
}

async function withSession<T>(options: DeepSeekCapabilityManagementOptions, work: (connection: DeepSeekCapabilityConnection, sessionId: string) => Promise<T>): Promise<T> {
  const connection = options.connectionFactory?.() || new ACPConnection({ bin: options.bin, args: ['--profile', 'acp'],
    cwd: options.cwd, env: options.env, providerLabel: 'DeepSeek Harness' })
  let closed = false, sessionId: string | undefined
  connection.on('close', () => { closed = true })
  connection.on('error', () => {})
  connection.on('request', message => {
    if (message.id !== undefined && connection instanceof ACPConnection) connection.respondError(message.id, -32601, 'Plugin management does not accept model requests')
  })
  try {
    const handshake = await connection.initialize()
    if (handshake?._meta?.['uniagent/bridge']?.version !== 1) fail('capability_inventory_unavailable')
    const session = await connection.request('session/new', { cwd: options.cwd, mcpServers: [] })
    if (typeof session?.sessionId !== 'string' || !session.sessionId) fail('capability_inventory_unavailable')
    sessionId = session.sessionId
    return await work(connection, sessionId!)
  } finally {
    if (sessionId && !closed) await connection.request('session/close', { sessionId }, 5_000).catch(() => {})
    if (connection instanceof ACPConnection) await connection.closeAndWait()
    else if (!closed) await new Promise<void>((resolveClose, rejectClose) => {
      const finish = () => { clearTimeout(timer); connection.removeListener('close', finish); resolveClose() }
      const timer = setTimeout(() => { connection.removeListener('close', finish); rejectClose(new Error('capability_inventory_manage_failed')) }, 3_000)
      connection.once('close', finish)
      connection.close()
    })
  }
}

type ManagedList = { plugins: JsonRecord[]; bundles: JsonRecord[] }
async function current(connection: DeepSeekCapabilityConnection, sessionId: string): Promise<{ raw: unknown; inventory: CapabilityAgentInventory; managed?: ManagedList }> {
  const raw = await connection.request('_uniagent/inventory', { sessionId })
  const inventory = projectDeepSeekInventory(raw)
  if (inventory.status !== 'available') fail('capability_inventory_invalid_config')
  const list = inventory.managementSupported === true ? await managedList(connection, sessionId) : undefined
  if (list) {
    for (const item of inventory.items) {
      if (item.kind !== 'plugin') continue
      const entryId = resolveDeepSeekPluginEntryId(item.id, raw)
      if (!entryId) continue
      const rows = list.plugins.filter(row => row.entryId === entryId)
      const bundles = list.bundles.filter(bundle => Array.isArray(bundle.rows) && bundle.rows.some((row: JsonRecord) => row.entryId === entryId))
      if (bundles.length === 1 && typeof bundles[0].version === 'string') item.version = bundles[0].version
      // Version and native source identities stay inside the digest; public labels do not expose paths.
      item.fingerprint = digest({ previous: item.fingerprint, rows: rows.map(row => ({ moduleName: row.moduleName, patchId: row.patchId,
        enabled: row.enabled, readOnlyReason: row.readOnlyReason })), bundles: bundles.map(bundle => ({ name: bundle.name,
        version: bundle.version, enabled: bundle.enabled, installed: bundle.installed, removable: bundle.removable,
        readOnlyReason: bundle.readOnlyReason, error: bundle.error?.code, rows: bundle.rows, overrides: bundle.overrides })) })
    }
    inventory.revision = digest(inventory.items)
  }
  return { raw, inventory, managed: list }
}
async function managedList(connection: DeepSeekCapabilityConnection, sessionId: string): Promise<ManagedList> {
  const result = await connection.request('_uniagent/plugin_action', { sessionId, action: 'list' })
  if (!record(result) || !Array.isArray(result.plugins) || !result.plugins.every(record) ||
      !Array.isArray(result.bundles) || !result.bundles.every(record)) fail('capability_inventory_invalid_config')
  return result as ManagedList
}
async function nativeAction(connection: DeepSeekCapabilityConnection, sessionId: string, params: JsonRecord): Promise<JsonRecord> {
  const result = await connection.request('_uniagent/plugin_action', { sessionId, ...params }, params.action === 'install' ? 300_000 : 60_000)
  if (!record(result) || !['applied', 'restart-required'].includes(result.application) || result.error !== undefined) fail()
  return result
}

/** Each scan uses the shared native profile and disposes its owned runtime before returning. */
export async function inspectDeepSeekCapabilityInventory(options: DeepSeekCapabilityManagementOptions): Promise<CapabilityAgentInventory> {
  return serial(options, settings => withSession(settings, async (connection, sessionId) => (await current(connection, sessionId)).inventory))
}

/** Resolve opaque IDs in a fresh native inventory, mutate via public SDK controls, then verify a fresh boot. */
export async function manageDeepSeekCapabilityInventory(value: unknown, options: DeepSeekCapabilityManagementOptions): Promise<DeepSeekCapabilityManageResult> {
  const request = parseDeepSeekCapabilityManageRequest(value)
  return serial(options, async settings => {
    let entryId: string | undefined, bundleName: string | undefined, moduleName: string | undefined, patchId: string | undefined, disabledBundle = false
    let requestedVersion: string | undefined, previousEnabled: boolean | undefined
    let previousBundleEnabled: boolean | undefined, previousBundles: string | undefined
    await withSession(settings, async (connection, sessionId) => {
      const before = await current(connection, sessionId)
      if (before.inventory.managementSupported !== true) fail('capability_inventory_read_only')
      if (request.action === 'plugin-install') {
        const inspection = await connection.request('_uniagent/plugin_action', { sessionId, action: 'inspect', spec: request.spec, options: { registry: PUBLIC_REGISTRY } }, 60_000)
        if (inspection?.status === 'refused' && inspection.problem === 'already-installed') fail('capability_inventory_already_exists')
        if (inspection?.status !== 'accepted' || inspection.kind !== 'registry' || inspection.bundle !== true ||
            typeof inspection.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(inspection.name)) fail('capability_inventory_invalid_config')
        bundleName = inspection.name
        const result = await nativeAction(connection, sessionId, { action: 'install', spec: request.spec, options: { registry: PUBLIC_REGISTRY } })
        if (result.bundle !== bundleName) fail()
        return
      }
      const item = before.inventory.items.find(item => item.id === request.id)
      if (!item) fail('capability_inventory_stale')
      if (!item.manageable) fail('capability_inventory_read_only')
      if (item.fingerprint !== request.expectedFingerprint) fail('capability_inventory_stale')
      entryId = resolveDeepSeekPluginEntryId(request.id, before.raw)
      if (!entryId) fail('capability_inventory_read_only')
      const list = before.managed!, rows = list.plugins.filter(row => row.entryId === entryId)
      if (rows.length !== 1 || protectedPlugin(rows[0])) fail('capability_inventory_read_only')
      moduleName = rows[0].moduleName; patchId = rows[0].patchId
      if (request.action !== 'plugin-remove' && request.action !== 'plugin-update') {
        await nativeAction(connection, sessionId, { action: request.action === 'plugin-enable' ? 'enable' : 'disable', target: 'entry', id: entryId })
        return
      }
      const bundles = list.bundles.filter(bundle => Array.isArray(bundle.rows) && bundle.rows.some((row: any) => row?.entryId === entryId))
      if (bundles.length !== 1) fail('capability_inventory_action_unsupported')
      const bundle = bundles[0]
      if (bundle.installed !== true || bundle.removable !== true || bundle.readOnlyReason !== undefined || bundle.error !== undefined) fail('capability_inventory_read_only')
      if (bundle.rows.length !== 1 || bundle.rows[0].moduleName !== moduleName || bundle.rows[0].rowId !== patchId ||
          !Array.isArray(bundle.overrides) || bundle.overrides.length !== 0 || typeof bundle.name !== 'string') fail('capability_inventory_action_unsupported')
      bundleName = bundle.name
      if (request.action === 'plugin-update') {
        if (list.bundles.filter(value => value.name === bundleName).length !== 1) fail('capability_inventory_action_unsupported')
        if (!packageName(bundleName) || typeof bundle.version !== 'string' || !bundle.version ||
            typeof rows[0].enabled !== 'boolean' || typeof bundle.enabled !== 'boolean') fail('capability_inventory_action_unsupported')
        const spec = request.spec ?? `${bundleName}@latest`
        const at = spec.indexOf('@', 1)
        if (spec.slice(0, at) !== bundleName) fail('capability_inventory_invalid_config')
        requestedVersion = request.spec === undefined ? undefined : spec.slice(at + 1)
        previousEnabled = rows[0].enabled; previousBundleEnabled = bundle.enabled
        previousBundles = digest(list.bundles.filter(value => value.name !== bundleName))
        // Existing dependencies are the official upgrade path; enabled=false preserves bundle selection.
        const result = await nativeAction(connection, sessionId, { action: 'install', spec, options: { registry: PUBLIC_REGISTRY, enabled: false } })
        if (result.bundle !== bundleName || result.application !== 'restart-required') fail()
        return
      }
      // Startup-only SDK removal requires the bundle to be absent from the next runtime's active composition.
      if (bundle.enabled) {
        await nativeAction(connection, sessionId, { action: 'disable', target: 'bundle', name: bundleName })
        disabledBundle = true
      }
    })
    if (request.action === 'plugin-remove') {
      try { await withSession(settings, async (connection, sessionId) => {
        const list = await managedList(connection, sessionId), bundle = list.bundles.find(bundle => bundle.name === bundleName)
        if (!bundle || bundle.enabled !== false || bundle.removable !== true || bundle.readOnlyReason !== undefined ||
            bundle.error !== undefined || !Array.isArray(bundle.rows) || bundle.rows.length !== 1 ||
            bundle.rows[0].moduleName !== moduleName || bundle.rows[0].rowId !== patchId ||
            !Array.isArray(bundle.overrides) || bundle.overrides.length !== 0 ||
            list.plugins.some(row => row.patchId === patchId && row.moduleName === moduleName)) fail('capability_inventory_action_unsupported')
        await nativeAction(connection, sessionId, { action: 'remove', name: bundleName })
      }) } catch (error) {
        // Keep a failed removal discoverable for retry when the native dependency still exists.
        if (disabledBundle) await withSession(settings, async (connection, sessionId) => {
          const list = await managedList(connection, sessionId)
          if (list.bundles.some(bundle => bundle.name === bundleName && bundle.installed === true && bundle.enabled === false)) {
            await nativeAction(connection, sessionId, { action: 'enable', target: 'bundle', name: bundleName })
          }
        }).catch(() => {})
        throw error
      }
    }
    return withSession(settings, async (connection, sessionId) => {
      const after = await current(connection, sessionId), list = after.managed
      if (!list) fail()
      if (request.action === 'plugin-install') {
        if (!list.bundles.some(bundle => bundle.name === bundleName && bundle.installed === true && bundle.enabled === true && bundle.error === undefined)) fail()
      } else if (request.action === 'plugin-update') {
        const bundles = list.bundles.filter(bundle => bundle.name === bundleName)
        const bundle = bundles[0]
        if (bundles.length !== 1 || bundle.installed !== true || bundle.removable !== true || bundle.readOnlyReason !== undefined ||
            bundle.error !== undefined || bundle.enabled !== previousBundleEnabled || !Array.isArray(bundle.rows) || bundle.rows.length !== 1 ||
            bundle.rows[0].rowId !== patchId || bundle.rows[0].moduleName !== moduleName ||
            !Array.isArray(bundle.overrides) || bundle.overrides.length !== 0 || typeof bundle.version !== 'string' ||
            (requestedVersion !== undefined ? bundle.version !== requestedVersion : !bundle.version) ||
            digest(list.bundles.filter(value => value.name !== bundleName)) !== previousBundles) fail()
        const rows = list.plugins.filter(row => row.patchId === patchId && row.moduleName === moduleName)
        if (rows.length !== 1 || protectedPlugin(rows[0]) || rows[0].enabled !== previousEnabled || rows[0].entryId !== bundle.rows[0].entryId) fail()
      } else if (request.action === 'plugin-remove') {
        if (list.bundles.some(bundle => bundle.name === bundleName) || list.plugins.some(row => row.patchId === patchId && row.moduleName === moduleName)) fail()
      } else {
        const rows = list.plugins.filter(row => row.patchId === patchId && row.moduleName === moduleName)
        if (rows.length !== 1 || rows[0].enabled !== (request.action === 'plugin-enable')) fail()
      }
      return after.inventory
    })
  })
}
