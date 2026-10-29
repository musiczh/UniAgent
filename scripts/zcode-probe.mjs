import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

// This probe creates only empty drafts; model execution and real credentials are excluded.
const LIMIT = { line: 1024 * 1024, logical: 16 * 1024 * 1024, staged: 32 * 1024 * 1024 }
const PREFERENCES = {
  nativeSearchEnhancementsEnabled: false, subagentRuntimeConfigEnabled: false,
  memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false,
  modelContextBudgetStrategy: 'preflight-v1',
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export function uuid7() {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6] & 15) | 0x70
  bytes[8] = (bytes[8] & 63) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}
function scrub(value, probeRoot) {
  if (typeof value === 'string') return value.replaceAll(probeRoot, '/ZCODE_PROBE_ROOT')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|code|secret|ticket)=)[^&\s]+/gi, '$1[REDACTED]')
  if (Array.isArray(value)) return value.map(item => scrub(item, probeRoot))
  if (!object(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:api.?key|secret|password|credential|authorization|access.?token|refresh.?token|requestAuth|headers)$/i.test(key)
      ? '[REDACTED]' : scrub(item, probeRoot)]))
}
function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--runtime-config', '--output'].includes(argv[i]) || !argv[i + 1]) {
      throw new Error('Usage: node scripts/zcode-probe.mjs --runtime-config <absolute JSON path> --output <directory>')
    }
    options[argv[i].slice(2)] = argv[i + 1]
  }
  if (!options['runtime-config'] || !options.output || !isAbsolute(options['runtime-config'])) {
    throw new Error('An absolute runtime config and an output directory are required')
  }
  return options
}

export class ProbeConnection {
  constructor(config, workspace, env, options = {}) {
    this.deferredCallbackMethods = new Set(options.deferredCallbackMethods ?? [])
    const args = [...(config.bundlePath ? [config.bundlePath] : []), 'app-server', '--stdio']
    this.child = spawn(config.executable, args, {
      cwd: workspace, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.pending = new Map()
    this.notifications = []
    this.callbacks = []
    this.frames = []
    this.assemblies = new Map()
    this.ordinal = new Map()
    this.failure = undefined
    this.trace = []
    this.stderr = ''
    this.closed = false
    this.exit = new Promise(resolve => {
      this.child.once('close', (code, signal) => { this.closed = true; resolve({ code, signal }) })
    })
    this.counter = 0
    this.notificationBytes = 0
    let buffered = ''
    const decoder = new StringDecoder('utf8')
    this.child.stdout.on('data', bytes => {
      try {
        buffered += decoder.write(bytes)
        let newline
        while ((newline = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, newline).replace(/\r$/, '')
          buffered = buffered.slice(newline + 1)
          if (Buffer.byteLength(line) > LIMIT.line) throw new Error('protocol_line_too_large')
          if (line) this.receive(JSON.parse(line))
        }
        if (Buffer.byteLength(buffered) > LIMIT.line) throw new Error('protocol_line_too_large')
      } catch (error) { this.fail(error) }
    })
    this.child.stdout.on('end', () => this.fail(new Error('protocol_eof')))
    // This process has an empty isolated home; still scrub diagnostics before saving.
    this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString('utf8')).slice(-8192) })
    this.child.on('error', error => this.fail(error))
    this.child.once('exit', () => this.fail(new Error('engine_exit')))
    this.child.stdin.on('error', error => this.fail(error))
  }
  fail(error) {
    if (this.failure) return
    this.failure = error
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear()
  }
  write(value) {
    if (this.failure) throw this.failure
    const line = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(line) > LIMIT.line) throw new Error('outbound_line_too_large')
    this.child.stdin.write(line)
  }
  request(method, params, timeout = 30000) {
    const id = `probe-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc_timeout:${method}`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  receive(message) {
    if (!object(message)) throw new Error('invalid_rpc_message')
    if (this.trace.length < 512) this.trace.push(message)
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        const params = message.params
        this.callbacks.push({ method: message.method, params })
        if (message.method === 'session/requestRuntimePreferences' && object(params)
          && typeof params.sessionId === 'string' && ['runtime-materialization', 'user-execution'].includes(params.scope)) {
          this.write({ id: message.id, result: PREFERENCES })
        } else if (!this.deferredCallbackMethods.has(message.method)) {
          this.write({ id: message.id, error: { code: -32601, message: 'This isolated probe does not provide credentials or host tools' } })
        }
      } else {
        this.notificationBytes += Buffer.byteLength(JSON.stringify(message))
        if (this.notifications.length >= 4096 || this.notificationBytes > LIMIT.staged) throw new Error('notification_budget_exceeded')
        this.notifications.push(message)
        if (message.method === 'v4/conversation/frame') this.assemble(message.params)
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(`rpc_error:${message.error.code}:${message.error.message}`))
    else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
    else pending.reject(new Error('invalid_rpc_response'))
  }
  assemble(wire) {
    if (!object(wire) || wire.wireVersion !== 3 || !['complete', 'fragment'].includes(wire.kind)
      || typeof wire.topic !== 'string' || typeof wire.subscriptionId !== 'string'
      || typeof wire.logicalFrameId !== 'string' || !integer(wire.logicalFrameOrdinal) || wire.logicalFrameOrdinal === 0) {
      throw new Error('incompatible_wire')
    }
    const route = `${wire.topic}\0${wire.subscriptionId}`
    const previous = this.ordinal.get(route)
    if (previous && wire.logicalFrameOrdinal < previous.ordinal) return
    if (previous && wire.logicalFrameOrdinal === previous.ordinal && wire.logicalFrameId !== previous.id) throw new Error('ordinal_conflict')
    if (previous && wire.logicalFrameOrdinal === previous.ordinal && previous.complete) return
    if (!['initial', 'online', 'recovery'].includes(wire.deliveryKind)) throw new Error('invalid_delivery_kind')
    if (previous && wire.logicalFrameOrdinal > previous.ordinal) {
      if (this.assemblies.has(route) && wire.deliveryKind !== 'recovery') throw new Error('superseded_incomplete_frame')
      this.assemblies.delete(route)
    }
    this.ordinal.set(route, { ordinal: wire.logicalFrameOrdinal, id: wire.logicalFrameId, complete: false })
    let frame = wire.frame
    if (wire.kind === 'fragment') {
      if (!integer(wire.fragmentCount) || wire.fragmentCount < 1 || wire.fragmentCount > 1024
        || !integer(wire.fragmentIndex) || wire.fragmentIndex >= wire.fragmentCount
        || !integer(wire.logicalBytes) || wire.logicalBytes < wire.fragmentCount || wire.logicalBytes > LIMIT.logical
        || wire.checksum?.algorithm !== 'crc32' || !/^[0-9a-f]{8}$/.test(wire.checksum.value)
        || typeof wire.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wire.dataBase64)) {
        throw new Error('invalid_fragment')
      }
      let entry = this.assemblies.get(route)
      const identity = JSON.stringify([wire.logicalFrameId, wire.logicalFrameOrdinal, wire.deliveryKind, wire.fragmentCount, wire.logicalBytes, wire.checksum.value])
      if (!entry) {
        if (this.assemblies.size >= 32) throw new Error('assembly_budget_exceeded')
        entry = { identity, count: wire.fragmentCount, bytes: wire.logicalBytes, checksum: wire.checksum.value, chunks: new Map(), startedAt: Date.now() }
        this.assemblies.set(route, entry)
      }
      if (entry.identity !== identity) throw new Error('fragment_identity_conflict')
      const bytes = Buffer.from(wire.dataBase64, 'base64')
      if (bytes.length === 0 || bytes.length > LIMIT.line || bytes.toString('base64') !== wire.dataBase64) throw new Error('invalid_base64')
      const prior = entry.chunks.get(wire.fragmentIndex)
      if (prior && !prior.equals(bytes)) throw new Error('fragment_content_conflict')
      entry.chunks.set(wire.fragmentIndex, bytes)
      let staged = 0
      for (const assembly of this.assemblies.values()) {
        let size = 0
        for (const chunk of assembly.chunks.values()) size += chunk.length
        if (size > assembly.bytes) throw new Error('declared_size_exceeded')
        staged += size
      }
      if (staged > LIMIT.staged) throw new Error('staged_budget_exceeded')
      if (entry.chunks.size !== entry.count) return
      const logical = Buffer.concat(Array.from({ length: entry.count }, (_, i) => entry.chunks.get(i)))
      if (logical.length !== entry.bytes || crc32(logical) !== entry.checksum) throw new Error('checksum_mismatch')
      frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(logical))
      this.assemblies.delete(route)
    }
    if (!object(frame) || frame.topic !== wire.topic || frame.subscriptionId !== wire.subscriptionId
      || !integer(frame.fromSeq) || !integer(frame.toSeq) || frame.fromSeq > frame.toSeq
      || !['snapshot', 'deltas'].includes(frame.payload?.kind)) throw new Error('invalid_logical_frame')
    if (frame.payload.kind === 'snapshot' && (frame.fromSeq !== 0 || frame.payload.snapshot?.protocolVersion !== 1
      || typeof frame.payload.snapshot.logEpoch !== 'string')) throw new Error('invalid_snapshot_watermark')
    if (frame.payload.kind === 'snapshot' && frame.topic.startsWith('conversation/')
      && frame.payload.snapshot.seq !== frame.toSeq) throw new Error('invalid_conversation_watermark')
    this.ordinal.set(route, { ordinal: wire.logicalFrameOrdinal, id: wire.logicalFrameId, complete: true })
    if (this.frames.length >= 256) throw new Error('frame_budget_exceeded')
    this.frames.push({ frame, deliveryKind: wire.deliveryKind, logicalFrameId: wire.logicalFrameId, logicalFrameOrdinal: wire.logicalFrameOrdinal })
  }
  async waitFor(find, timeout = 30000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = find()
      if (value !== undefined) return value
      if (this.failure) throw this.failure
      for (const assembly of this.assemblies.values()) {
        if (Date.now() - assembly.startedAt > 30000) throw new Error('assembly_timeout')
      }
      await sleep(20)
    }
    throw new Error('probe_wait_timeout')
  }
  async close() {
    const wait = async () => {
      let timer
      const result = await Promise.race([this.exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000) })])
      clearTimeout(timer)
      return result
    }
    if (this.closed) return { exited: true }
    this.child.stdin.end()
    if (await wait()) return { exited: true, via: 'stdin-eof' }
    // Empty-draft probes cannot spawn model tools. Signal only our ChildProcess handle.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { this.child.kill(signal) }
      catch (error) { if (error.code !== 'ESRCH') return { exited: this.closed, error: error.code } }
      if (await wait()) return { exited: true, via: signal }
    }
    return { exited: false, error: 'cleanup_timeout' }
  }
}

export async function runProbe(options) {
  const config = JSON.parse(await readFile(options['runtime-config'], 'utf8'))
  if (!object(config) || !['cli', 'official-app', 'source-build'].includes(config.source)
    || typeof config.executable !== 'string' || !isAbsolute(config.executable)
    || (config.bundlePath !== undefined && (typeof config.bundlePath !== 'string' || !isAbsolute(config.bundlePath)))) throw new Error('invalid_runtime_config')
  config.executable = await realpath(config.executable)
  if (!(await stat(config.executable)).isFile()) throw new Error('executable_must_be_file')
  if (config.bundlePath) {
    config.bundlePath = await realpath(config.bundlePath)
    if (!(await stat(config.bundlePath)).isFile()) throw new Error('bundle_must_be_file')
  }
  const output = resolve(options.output)
  await mkdir(output, { recursive: true, mode: 0o700 })
  // macOS TMPDIR can exceed the Unix socket path limit when the native broker adds its name.
  const probeRoot = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'uzc-'))
  const workspace = join(probeRoot, 'workspace')
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, {
    HOME: join(probeRoot, 'home'), TMPDIR: join(probeRoot, 'tmp'),
    XDG_CONFIG_HOME: join(probeRoot, 'config'), XDG_CACHE_HOME: join(probeRoot, 'cache'), XDG_DATA_HOME: join(probeRoot, 'data'),
    ZCODE_DATA_BASE_DIR: join(probeRoot, 'data'), ZCODE_STORAGE_DIR: join(probeRoot, 'storage'),
    ZCODE_SESSION_DB_PATH: join(probeRoot, 'db.sqlite'), NODE_ENV: 'production',
  })
  if (config.source === 'official-app') env.ELECTRON_RUN_AS_NODE = '1'
  for (const path of [workspace, env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.ZCODE_STORAGE_DIR]) await mkdir(path, { recursive: true })
  const manifest = {
    schemaVersion: 1, checkedAt: new Date().toISOString(), scope: 'isolated-empty-draft-protocol',
    runtime: { source: config.source, executable: config.executable, bundleName: config.bundlePath ? basename(config.bundlePath) : undefined,
      bundleSha256: createHash('sha256').update(await readFile(config.bundlePath ?? config.executable)).digest('hex') },
    checks: {}, unverified: ['real-authentication', 'two-model-turns', 'file-edit-permission-stop', 'durable-cold-resume', 'mcp-caller-cold-resume', 'complete-model-catalog'],
    fixtures: [],
  }
  let connection
  const save = async (name, value) => {
    const bytes = JSON.stringify(scrub(value, probeRoot), null, 2) + '\n'
    await writeFile(join(output, name), bytes, { mode: 0o600 })
    manifest.fixtures.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  try {
    connection = new ProbeConnection(config, workspace, env)
    await connection.waitFor(() => {
      const states = connection.notifications.filter(n => n.method === 'startup/storageState')
      if (states.some(n => n.params?.phase === 'failed')) throw new Error('storage_startup_failed')
      return states.some(n => n.params?.phase === 'ready') ? true : undefined
    }, 60000)
    manifest.checks.storageReady = true
    await save('startup.json', connection.notifications.filter(n => n.method === 'startup/storageState'))
    const capabilities = await connection.request('runtime/capabilities', {})
    manifest.checks.independentPlanState = capabilities?.independentPlanState === true
    await save('capabilities.json', capabilities)
    const clientId = uuid7()
    const connectionId = uuid7()
    const workspaceAck = await connection.request('v4/conversation/subscribe', {
      topic: `workspace-config/${workspace}`, connectionId, clientMode: 'desktop-continuous', visibility: 'foreground',
    })
    const workspaceFrame = await connection.waitFor(() => connection.frames.find(f => f.frame.subscriptionId === workspaceAck?.ack?.subscriptionId && f.frame.payload.kind === 'snapshot'))
    manifest.checks.workspaceConfigSnapshot = true
    await save('workspace-subscribe.json', workspaceAck)
    await save('workspace.logical.json', workspaceFrame)
    const commandId = uuid7()
    const created = await connection.request('v4/command', {
      commandId, clientId, sessionId: null, type: 'createSession',
      payload: { workspaceId: workspace, config: { mode: 'build', planEnabled: false } }, issuedAt: Date.now(),
    })
    await save('create-ack.json', created)
    if (created?.status !== 'accepted' || created.result?.type !== 'createSession' || typeof created.result.sessionId !== 'string') throw new Error('empty_draft_create_failed')
    const sessionId = created.result.sessionId
    manifest.checks.createWithoutFirstInput = true
    const subscribed = await connection.request('v4/conversation/subscribe', {
      topic: `conversation/${sessionId}`, connectionId, clientMode: 'desktop-continuous', visibility: 'foreground',
      workspace: { workspacePath: workspace, workspaceKey: workspace },
    })
    const initial = await connection.waitFor(() => connection.frames.find(f => f.frame.subscriptionId === subscribed?.ack?.subscriptionId && f.frame.payload.kind === 'snapshot'))
    if (initial.frame.payload.snapshot.sessionId !== sessionId || initial.frame.payload.snapshot.logEpoch !== subscribed.ack.logEpoch) throw new Error('snapshot_identity_mismatch')
    manifest.checks.conversationSnapshot = true
    manifest.checks.wireVersion = 3
    await save('conversation-subscribe.json', subscribed)
    await save('snapshot.logical.json', initial)
    const queried = await connection.request('v4/commands/query', { commands: [{ sessionId: null, commandId }] })
    await save('create-query.json', queried)
    const queriedCreate = queried?.results?.find(item => item.key?.commandId === commandId && item.key?.sessionId === null)
    if (queriedCreate?.result?.status !== 'accepted' || queriedCreate.result.result?.sessionId !== sessionId) throw new Error('create_query_identity_mismatch')
    manifest.checks.commandQuery = true
    const beforeRecovery = connection.frames.length
    const recovered = await connection.request('v4/conversation/resync', {
      topic: `conversation/${sessionId}`, connectionId, subscriptionId: subscribed.ack.subscriptionId, base: null, forceSnapshot: true,
    })
    const recovery = await connection.waitFor(() => connection.frames.slice(beforeRecovery).find(f => f.deliveryKind === 'recovery' && f.frame.subscriptionId === subscribed.ack.subscriptionId))
    if (recovery.frame.payload.kind !== 'snapshot' || recovered?.ack?.subscriptionId !== subscribed.ack.subscriptionId
      || recovered.ack.logEpoch !== recovery.frame.payload.snapshot.logEpoch) throw new Error('recovery_identity_mismatch')
    manifest.checks.resyncAckAndFrame = true
    await save('resync-ack.json', recovered)
    await save('recovery.logical.json', recovery)
    try {
      await save('session-read.json', await connection.request('session/read', { sessionId, deliveryKind: 'desktop-continuous', messageLimit: 1 }))
      manifest.checks.sessionRead = true
    } catch (error) { manifest.checks.sessionRead = { passed: false, error: error.message } }
    await save('host-callbacks.json', connection.callbacks)
    manifest.result = 'protocol-checks-passed'
  } catch (error) {
    manifest.result = 'probe-failed'
    manifest.error = { code: error.code, message: scrub(error.message, probeRoot) }
  } finally {
    try {
      if (connection) {
        manifest.cleanup = await connection.close()
        await save('rpc-incoming.json', connection.trace)
        await save('stderr.json', connection.stderr)
      }
      if (!connection || manifest.cleanup?.exited) await rm(probeRoot, { recursive: true, force: true })
      else { manifest.result = 'probe-failed'; manifest.retainedRoot = probeRoot }
    } catch (error) {
      manifest.cleanupError = { code: error.code, message: scrub(error.message, probeRoot) }
      manifest.result = 'probe-failed'
    } finally {
      await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    }
  }
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await runProbe(parseArgs(process.argv.slice(2)))
    process.stdout.write(JSON.stringify({ result: manifest.result, checks: manifest.checks, unverified: manifest.unverified, error: manifest.error }) + '\n')
    process.exitCode = manifest.result === 'protocol-checks-passed' ? 0 : 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
