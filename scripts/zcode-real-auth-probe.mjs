import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { ProbeConnection, uuid7 } from './zcode-probe.mjs'

// Explicit opt-in only: executes two real read-only model turns in an empty sandbox.
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--runtime-config', '--provider-config', '--output'].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error('Expected --runtime-config, --provider-config, --output')
  options[process.argv[i].slice(2)] = process.argv[i + 1]
}
if (!options.output || !isAbsolute(options['runtime-config'] ?? '') || !isAbsolute(options['provider-config'] ?? '')) throw new Error('Absolute runtime and provider config paths are required')
const config = JSON.parse(await readFile(options['runtime-config'], 'utf8'))
const providerPath = await realpath(options['provider-config'])
// The secret-bearing provider document is never retained or included in diagnostics.
const providerDocument = JSON.parse(await readFile(providerPath, 'utf8'))
const configuredSelection = providerDocument.config?.defaultModelSelection
const rule = providerDocument.config?.providerConfigRules?.providerRules?.find(item => item.providerId === configuredSelection?.providerId)
if (!configuredSelection || typeof configuredSelection.providerId !== 'string' || typeof configuredSelection.modelId !== 'string'
  || configuredSelection.providerId.startsWith('account:') || !rule || rule.enabled === false
  || !['api-key', 'zhipu-coding-plan-api-key'].includes(rule.config?.access?.type)) throw new Error('An enabled Personal API defaultModelSelection is required; OAuth Account Host is not implemented')
let selection = { providerId: configuredSelection.providerId, modelId: configuredSelection.modelId }
if (typeof configuredSelection.options?.reasoningLevel === 'string') selection.options = { reasoningLevel: configuredSelection.options.reasoningLevel }
const root = await mkdtemp('/tmp/uza-')
const workspace = join(root, 'workspace')
const output = resolve(options.output)
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), ZCODE_DATA_BASE_DIR: join(root, 'data'), ZCODE_STORAGE_DIR: join(root, 'storage'), ZCODE_SESSION_DB_PATH: join(root, 'db.sqlite'), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerPath, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(config.resourceRoot, 'provider/zcode-builtin.json'), NODE_ENV: 'production' }
const manifest = { scope: 'real-provider-two-read-only-turns', checkedAt: new Date().toISOString(), checks: {}, modelSelection: selection,
  runtime: { bundleSha256: createHash('sha256').update(await readFile(config.bundlePath)).digest('hex') },
  unverified: ['real-file-edit-approval', 'real-handoff-mcp', 'packaged-uniagent-integration'] }
let connection
function failureDiagnostics(value) {
  const statuses = new Set()
  const categories = new Set()
  const rules = [
    ['authentication', /invalid.{0,12}(?:key|token)|unauthori[sz]ed|authentication|鉴权|无效.{0,6}(?:密钥|令牌)/i],
    ['quota', /quota|balance|insufficient|余额|额度|套餐.{0,8}(?:不足|耗尽|过期)/i],
    ['modelUnavailable', /model.{0,30}(?:not found|not exist|not support|unavailable)|模型.{0,12}(?:不存在|不支持|不可用)/i],
    ['rateLimited', /rate.limit|too many requests|限流|并发|频率/i],
    ['network', /fetch failed|ENOTFOUND|ECONN|TLS|certificate|timed?.out|timeout|网络|超时/i],
    ['requestInvalid', /invalid.request|bad.request|invalid.{0,8}(?:parameter|argument)|参数/i],
  ]
  function visit(item, key = '') {
    if (typeof item === 'number' && /^(statusCode|responseStatus|httpStatus)$/.test(key) && item >= 100 && item <= 599) statuses.add(item)
    if (typeof item === 'string' && /^(errorMessage|message|reason|stderr)$/.test(key)) {
      for (const [category, pattern] of rules) if (pattern.test(item)) categories.add(category)
    }
    if (Array.isArray(item)) item.forEach(child => visit(child))
    else if (item && typeof item === 'object') for (const [name, child] of Object.entries(item)) visit(child, name)
  }
  visit(value)
  return { httpStatuses: [...statuses], categories: [...categories] }
}
try {
  for (const path of [workspace, env.HOME, env.TMPDIR, env.ZCODE_DATA_BASE_DIR, env.ZCODE_STORAGE_DIR, output]) await mkdir(path, { recursive: true, mode: 0o700 })
  connection = new ProbeConnection(config, workspace, env, { deferredCallbackMethods: ['interaction/requestPermission', 'interaction/requestUserInput'] })
  await connection.waitFor(() => connection.notifications.some(n => n.method === 'startup/storageState' && n.params?.phase === 'ready') ? true : undefined)
  await connection.request('runtime/capabilities', {})
  const clientId = uuid7()
  const command = (type, sessionId, payload) => connection.request('v4/command', { commandId: uuid7(), clientId, sessionId, type, payload, issuedAt: Date.now() })
  const created = await command('createSession', null, { workspaceId: workspace, config: { mode: 'build', planEnabled: true, modelSelection: selection } })
  if (created.status !== 'accepted') throw new Error('create_not_accepted')
  const sessionId = created.result.sessionId
  const current = (await connection.request('session/read', { sessionId, deliveryKind: 'desktop-continuous', messageLimit: 1 })).settings?.model?.current
  if (!current || current.providerId !== selection.providerId || current.modelId !== selection.modelId) throw new Error('model_selection_unresolved')
  const confirmedLevel = current.options?.reasoningLevel ?? selection.options?.reasoningLevel
  selection = { providerId: current.providerId, modelId: current.modelId,
    ...(confirmedLevel ? { options: { reasoningLevel: confirmedLevel } } : {}) }
  manifest.modelSelection = selection
  const ack = await connection.request('v4/conversation/subscribe', { topic: `conversation/${sessionId}`, connectionId: uuid7(), clientMode: 'desktop-continuous', workspace: { workspacePath: workspace, workspaceKey: workspace } })
  await connection.waitFor(() => connection.frames.some(f => f.frame.subscriptionId === ack.ack.subscriptionId) ? true : undefined)
  for (let turn = 1; turn <= 2; turn++) {
    const before = connection.frames.length
    const sent = await command('sendText', sessionId, { text: `This is an authentication probe in an empty sandbox. Do not use any tools. Reply with exactly ZCODE_AUTH_OK_${turn}.`, modelSelection: selection, mode: 'build', planEnabled: true })
    if (sent.status !== 'accepted') throw new Error('send_not_accepted')
    await connection.waitFor(() => {
      const deltas = connection.frames.slice(before).filter(f => f.frame.topic === `conversation/${sessionId}`).flatMap(f => f.frame.payload.deltas ?? [])
      const interaction = deltas.flatMap(d => d.patch?.pendingInteractions ?? []).find(i => i.kind === 'permission' || i.kind === 'userInput')
      if (interaction) throw new Error('unexpected_interaction')
      const terminal = deltas.findLast(d => d.row?.kind === 'turnHeader' && d.row.sourceCommandId === sent.commandId && ['completedSuccess', 'completedInterrupted', 'failed'].includes(d.row.state))
      if (!terminal) return undefined
      if (terminal.row.state !== 'completedSuccess') throw new Error('model_turn_failed')
      const answer = deltas.findLast(d => d.row?.kind === 'assistantText' && d.row.turnId === terminal.row.turnId && d.row.state === 'complete')
      if (!answer?.row.text?.includes(`ZCODE_AUTH_OK_${turn}`)) throw new Error('model_answer_mismatch')
      return true
    }, 180000)
    manifest.checks[`readOnlyTurn${turn}`] = true
  }
  manifest.result = 'real-auth-passed'
} catch (error) {
  manifest.result = 'real-auth-failed'
  // RPC/provider errors may quote headers or URLs; report only stable failure classes.
  manifest.error = /^(model_selection_unresolved|create_not_accepted|send_not_accepted|model_turn_failed|model_answer_mismatch|unexpected_interaction|probe_wait_timeout|protocol_eof|engine_exit|incompatible_wire)$/.test(error.message) ? error.message : (error.code ?? 'provider_or_protocol_error')
  if (connection) {
    manifest.failureDiagnostics = failureDiagnostics({ frames: connection.frames, callbacks: connection.callbacks, stderr: connection.stderr })
    const deltas = connection.frames.flatMap(f => f.frame.payload.deltas ?? [])
    const allowedKinds = new Set(['turnHeader', 'assistantText', 'reasoning', 'userInput', 'toolCall'])
    manifest.failureDiagnostics.observedRows = deltas.filter(d => allowedKinds.has(d.row?.kind)).map(d => ({ kind: d.row.kind,
      ...( ['running', 'complete', 'completedSuccess', 'completedInterrupted', 'failed', 'pendingApproval', 'success', 'error'].includes(d.row.state ?? d.row.status) ? { state: d.row.state ?? d.row.status } : {}) })).slice(-20)
    manifest.failureDiagnostics.frameCount = connection.frames.length
  }
} finally {
  if (connection) {
    manifest.cleanup = await connection.close().catch(error => ({ exited: false, error: error.code ?? 'cleanup_error' }))
    if (!manifest.cleanup.exited) manifest.result = 'real-auth-failed'
  }
  if (!connection || manifest.cleanup?.exited) await rm(root, { recursive: true, force: true })
  await mkdir(output, { recursive: true, mode: 0o700 })
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
}
process.stdout.write(JSON.stringify(manifest) + '\n')
process.exitCode = manifest.result === 'real-auth-passed' ? 0 : 1
