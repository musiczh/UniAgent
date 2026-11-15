import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import { configureRequirementRuntime, requirementCaller, setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { RequirementContextRequest, RequirementDocumentInput } from '../src/shared/requirementTypes'
import type { Session, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'requirement-validation-'))
let child: ReturnType<typeof spawn> | undefined, stop: (() => void) | undefined
try {
  setRequirementsEnabled(true)
  const store = new RequirementStore(root), requirement = await store.create({ name: '校验诊断' })
  const events: UAEvent[] = [
    { sessionId: 'caller', seq: 1, ts: 1, type: 'user_message', payload: { displayText: '用户确认保留原登录态。', text: '内部协议内容' } },
    { sessionId: 'caller', seq: 2, ts: 2, type: 'command_exec', payload: { output: '回归测试通过。' } }
  ]
  store.configureContext({ events: async () => events, requirementId: id => id === 'caller' ? requirement.id : undefined })
  const user = { kind: 'user' as const, sessionId: 'caller', seq: 1, quote: '保留原登录态' }
  const tool = { kind: 'tool' as const, sessionId: 'caller', seq: 2, quote: '回归测试通过' }
  const spec = (id: string, dependencies: string[] = []): RequirementDocumentInput => ({ id, kind: 'spec', title: id, content: '保留已确认规则。', sources: [user], dependencies })
  const before = await store.context(requirement.id, 'caller', { action: 'check' })
  const files = async () => ({
    manifest: await readFile(join(requirement.dir, '.uniagent/manifest.json'), 'utf8'),
    revisions: await readdir(join(requirement.dir, '.uniagent/checkpoints')),
    bodies: await readdir(join(requirement.dir, '.uniagent/bodies')).catch(() => [])
  })
  const disk = await files()
  const documents: RequirementDocumentInput[] = [
    { id: 'core', kind: 'core', title: '目标', content: '保留原登录态。', summary: 7 as any,
      sources: [{ ...user, quote: '未说过的内容' }, { ...user, seq: 999 }], dependencies: ['missing-a', 'missing-b', 'constructor'] },
    { id: 'artifact', kind: 'artifact', title: '证据', content: '验证记录', sources: [{ kind: 'reference', uri: './report.md' }] },
    { ...spec('metadata'), projectIds: ['', 7] as any, sources: [{ ...user, seq: 2, quote: '回归测试通过' }] },
    { ...spec('reference'), sources: [{ kind: 'reference', uri: 'report.md' }, { kind: 'tool', sessionId: 'foreign', seq: -1, quote: '' }] },
    spec('cycle-a', ['cycle-b']), spec('cycle-b', ['cycle-a']),
    spec('cycle-c', ['cycle-d']), spec('cycle-d', ['cycle-c']),
    { id: 'valid', kind: 'knowledge', title: '正确事实', content: '回归已通过。', sources: [tool] }
  ]
  const request: RequirementContextRequest = { action: 'commit', expectedRevision: before.revision, operationId: 'validation-batch', documents }
  const capture = async (input: RequirementContextRequest) => {
    try { await store.context(requirement.id, 'caller', input) } catch (error) { return error as Error & { details: any } }
    throw new Error('invalid request was accepted')
  }
  const error = await capture(request)
  assert.match(error.message, /校验未通过/)
  assert.equal(error.details.code, 'requirement_validation_failed')
  const issues = error.details.issues
  for (const path of [
    'documents[0].summary', 'documents[0].sources[0].quote', 'documents[0].sources[1].seq',
    'documents[0].dependencies[0]', 'documents[0].dependencies[1]', 'documents[0].dependencies[2]', 'documents[1].sources',
    'documents[2].projectIds[0]', 'documents[2].projectIds[1]', 'documents[2].sources[0].kind',
    'documents[3].sources[0].uri', 'documents[3].sources[1].sessionId',
    'documents[3].sources[1].seq', 'documents[3].sources[1].quote'
  ]) assert.ok(issues.some((issue: any) => issue.path === path), 'missing diagnostic: ' + path)
  assert.ok(issues.some((issue: any) => issue.code === 'source_quote_mismatch' && issue.documentId === 'core'))
  assert.match(issues.find((issue: any) => issue.code === 'source_quote_mismatch').hint, /payload\.displayText/)
  assert.ok(issues.some((issue: any) => issue.code === 'source_event_not_found'))
  assert.equal(issues.filter((issue: any) => issue.code === 'dependency_cycle').length, 2)
  assert.ok(issues.every((issue: any) => issue.code && issue.message && issue.hint))
  assert.deepEqual(await files(), disk, 'even the valid document must not be partially written')
  console.log('PASS batch reports all source, metadata, evidence and dependency errors without writing')

  const secret = 'sk-' + 'fixture'.repeat(4)
  const protectedError = await capture({ ...request, documents: [
    { ...spec('secret'), content: secret, sources: [{ kind: 'reference', uri: 'https://example.com/?token=' + secret }] },
    { id: 'bad-fields', kind: 'spec', title: '', content: null as any, sources: [user, null as any] },
    spec('duplicate'), spec('duplicate'), null as any
  ] })
  assert.ok(protectedError.details.issues.some((issue: any) => issue.code === 'credentials_detected'))
  assert.ok(protectedError.details.issues.some((issue: any) => issue.path === 'documents[1].title'))
  assert.ok(protectedError.details.issues.some((issue: any) => issue.path === 'documents[1].content'))
  assert.ok(protectedError.details.issues.some((issue: any) => issue.path === 'documents[1].sources[1]'))
  assert.ok(protectedError.details.issues.some((issue: any) => issue.path === 'documents[4]'))
  assert.ok(protectedError.details.issues.some((issue: any) => issue.code === 'duplicate_document_id'))
  assert.equal(JSON.stringify(protectedError.details).includes(secret), false)
  assert.equal(protectedError.message.includes(secret), false)
  assert.deepEqual(await files(), disk)
  console.log('PASS invalid fields and duplicates are aggregated without exposing credentials')

  const proposalError = await capture({ ...request, action: 'propose', operationId: 'invalid-proposal', documents: [
    { ...spec('proposal-one'), sources: [{ ...user, quote: '没有说过' }] },
    { ...spec('proposal-two'), title: '', sources: [{ ...user, seq: 999 }] }
  ] })
  for (const path of ['documents[0].sources[0].quote', 'documents[1].title', 'documents[1].sources[0].seq']) {
    assert.ok(proposalError.details.issues.some((issue: any) => issue.path === path))
  }
  assert.deepEqual(await files(), disk)
  console.log('PASS propose reports all problems and remains atomic')

  const repaired = [
    { id: 'core', kind: 'core', title: '目标', content: '保留原登录态。', sources: [user] } as RequirementDocumentInput,
    { id: 'artifact', kind: 'artifact', title: '证据', content: '验证记录', sources: [tool] } as RequirementDocumentInput,
    spec('metadata'), spec('reference'), spec('cycle-a', ['cycle-b']), spec('cycle-b'),
    spec('cycle-c', ['cycle-d']), spec('cycle-d'), documents[8]
  ]
  const success = await store.context(requirement.id, 'caller', { ...request, documents: repaired })
  assert.equal(success.ok, true)
  assert.notEqual(success.revision, before.revision)
  assert.equal((await store.context(requirement.id, 'caller', { ...request, documents: repaired })).duplicate, true)
  console.log('PASS corrected batch can retry the original operation and retain idempotency')

  process.env.UNIAGENT_USER_DATA = root
  const session = { id: 'caller', config: { agentId: 'codex', requirementId: requirement.id } } as Session
  configureRequirementRuntime(id => id === session.id ? session : undefined)
  const handoff = await import('../src/main/handoff')
  const env = Object.fromEntries(handoff.handoffMcpServers(session.id)[0].env.map(pair => [pair.name, pair.value]))
  stop = handoff.watchRequirementInbox(async req => {
    requirementCaller(req.sessionId, req.token)
    return store.context(requirement.id, req.sessionId, req.args)
  })
  child = spawn(process.execPath, [handoff.ensureHandoffServer()], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', sequence = 0
  const pending = new Map<number, (message: any) => void>()
  child.stdout!.on('data', chunk => {
    buffer += chunk.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      pending.get(message.id)?.(message)
    }
  })
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timed out')) }, 5000)
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message) })
    child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'requirement-validation', version: '1' } })
  const response = await rpc('tools/call', { name: 'requirement_context', arguments: { ...request, operationId: 'mcp-invalid-batch', expectedRevision: success.revision } })
  assert.equal(response.result.isError, true)
  const diagnostic = JSON.parse(response.result.content[0].text)
  assert.equal(diagnostic.details.code, 'requirement_validation_failed')
  assert.deepEqual(diagnostic.details.issues.map((issue: any) => issue.path), issues.map((issue: any) => issue.path))
  assert.match(diagnostic.error, /校验未通过/)
  assert.ok(diagnostic.error.length < 200, 'MCP summary stays short; full diagnostics are returned once in issues')
  console.log('PASS real requirement MCP preserves all structured errors and repair instructions')
} finally {
  stop?.()
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child!.once('exit', resolve))
    child.kill('SIGTERM'); await exited
  }
  configureRequirementRuntime(undefined)
  await rm(root, { recursive: true, force: true })
}
