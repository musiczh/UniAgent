import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentDef, Session } from '../src/shared/types'
import { APP_NAME, INTERNAL_DISTRIBUTION } from '../src/shared/distribution'
import { formatSessionInfo, sessionInfoRevealPath, sessionInfoSnapshot } from '../src/shared/sessionInfo'

const root = await mkdtemp(join(tmpdir(), 'uniagent-session-info-'))
const previousHome = process.env.HOME
process.env.HOME = root
const session = (agentId: string, nativeSessionId: string | undefined = 'native-session'): Session => ({
  id: 'local-session', title: '信息测试', status: 'idle', createdAt: 1, nativeSessionId,
  config: { agentId, workdir: root, permissionMode: 'ask' }
})
async function file(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  // Metadata lookup must not depend on parsing a provider's conversation contents.
  await writeFile(path, 'not a transcript')
  return path
}

try {
  const { readSessionInfo } = await import('../src/main/sessionInfo')
  const { resolveNativeSessionFile } = await import('../src/main/history')
  const nativeFiles = {
    codex: await file(join(root, '.codex/sessions/2026/11/03/rollout-example-native-session.jsonl')),
    traex: await file(join(root, '.trae/cli/archived_sessions/rollout-example-native-session.jsonl')),
    claude: await file(join(root, '.claude/projects/example/native-session.jsonl'))
  }
  const log = await file(join(root, 'custom-logs/local-session.jsonl'))
  for (const agentId of ['codex', 'traex', 'claude', 'kimi', 'grok', 'mcode', 'deepseek', 'nika', 'zcode']) {
    const info = await readSessionInfo(session(agentId), log)
    assert.equal(info.native.find(field => field.id === 'nativeSessionId')?.value, 'native-session', agentId)
    assert.equal(info.local.find(field => field.id === 'sessionId')?.value, 'local-session', agentId)
    assert.equal(sessionInfoRevealPath(info, 'workdir'), root)
    assert.equal(sessionInfoRevealPath(info, 'diagnosticLog'), log)
    const expectedFile = nativeFiles[agentId as keyof typeof nativeFiles]
    assert.equal(info.native.find(field => field.id === 'sessionFile')?.value, expectedFile, `${agentId}: only confirmed provider files are shown`)
    assert.equal(info.native.find(field => field.id === 'sessionFile')?.path, expectedFile)
    assert.deepEqual(info.errors, [])
    assert.equal(info.native.some(field => field.id === 'logId'), false, 'do not fabricate a universal Log ID')
    assert.throws(() => sessionInfoRevealPath(info, 'nativeSessionId'), /当前不可用/)
    assert.throws(() => sessionInfoRevealPath(info, log), /当前不可用/, 'a renderer-supplied path is not a field identity')
  }

  const draft = session('codex')
  delete draft.nativeSessionId
  const draftInfo = await readSessionInfo(draft, join(root, 'missing.jsonl'))
  assert.deepEqual(draftInfo.native.map(field => field.id), ['workdir'])
  assert.deepEqual(draftInfo.local.map(field => field.id), ['sessionId'])
  assert.deepEqual(draftInfo.errors, [], 'unavailable files are omitted without error placeholders')
  assert.equal((await readSessionInfo(session('codex', 'not-created'))).native.some(field => field.id === 'sessionFile'), false)
  assert.equal(await resolveNativeSessionFile('claude', '../private', true), null, 'unsafe native IDs cannot escape the provider store')

  const kimi = session('kimi')
  kimi.config.kimiDataHome = join(root, 'kimi-home')
  await mkdir(kimi.config.kimiDataHome)
  assert.equal(sessionInfoRevealPath(await readSessionInfo(kimi), 'kimiDataHome'), kimi.config.kimiDataHome)
  if (INTERNAL_DISTRIBUTION) {
    const nika = session('nika')
    nika.config.nikaBinding = { home: root, portBase: 12000 }
    assert.equal(sessionInfoRevealPath(await readSessionInfo(nika), 'nikaHome'), root)
  }
  const zcode = session('zcode')
  zcode.zcodeState = { schemaVersion: 1, workspaceKey: 'workspace-known', dataRootId: 'root-known', runtimeFingerprint: 'runtime-known', deliveries: [] }
  assert.deepEqual(sessionInfoSnapshot(zcode).native.slice(2).map(field => field.value), ['workspace-known', 'root-known'])
  ;(zcode.config as any).apiKey = 'secret-must-not-appear'
  assert.ok(!JSON.stringify(await readSessionInfo(zcode)).includes('secret-must-not-appear'), 'only selected metadata crosses IPC')

  const unavailable = session('grok')
  unavailable.config.workdir = join(root, 'removed-workdir')
  const unavailableInfo = await readSessionInfo(unavailable)
  assert.equal(unavailableInfo.native.find(field => field.id === 'workdir')?.value, unavailable.config.workdir)
  assert.throws(() => sessionInfoRevealPath(unavailableInfo, 'workdir'), /当前不可用/)
  const loopLog = join(root, 'loop-log')
  await symlink(loopLog, loopLog)
  const partial = await readSessionInfo(session('codex'), loopLog)
  assert.deepEqual(partial.errors, [{ label: '诊断日志', message: '读取失败' }])
  assert.equal(partial.native.find(field => field.id === 'sessionFile')?.value, nativeFiles.codex, 'failed log lookup preserves native metadata')
  const loopNative = join(root, '.codex/sessions/rollout-loop-unreadable.jsonl')
  await symlink(loopNative, loopNative)
  const nativeFailure = await readSessionInfo(session('codex', 'unreadable'), log)
  assert.deepEqual(nativeFailure.errors, [{ label: '会话文件', message: '读取失败' }])
  assert.equal(sessionInfoRevealPath(nativeFailure, 'diagnosticLog'), log)
  assert.equal(formatSessionInfo(partial, 'Codex'), [
    'Codex', 'Session ID: native-session', `工作目录: ${root}`, `会话文件: ${nativeFiles.codex}`,
    '', APP_NAME, '会话 ID: local-session'
  ].join('\n'), 'copy all preserves exact values and excludes error placeholders')
  assert.equal(formatSessionInfo(partial, 'Codex', { title: '任务名称', description: '第一段\n第二段' }),
    ['任务信息', '任务名称: 任务名称', '任务描述: 第一段\n第二段', '', formatSessionInfo(partial, 'Codex')].join('\n'),
    'task information is prepended without changing native metadata or truncating descriptions')

  const { SessionStore } = await import('../src/main/sessionStore')
  const { SessionLogStore } = await import('../src/main/sessionLogStore')
  const { Orchestrator } = await import('../src/main/orchestrator')
  const logs = new SessionLogStore(join(root, 'path-contract'))
  logs.append('with/slash', 'example', {})
  assert.equal(logs.filePath('with/slash'), join(root, 'path-contract/with_slash.jsonl'))
  assert.equal(new SessionLogStore(undefined).filePath('s'), undefined)
  const agent = { id: 'info-test', adapter: 'claude', name: 'Fixture', models: [], capabilities: { permissionModes: [{ id: 'ask', label: '请求批准', hint: '' }] } } as unknown as AgentDef
  const orchestrator = new Orchestrator(id => id === agent.id ? agent : undefined,
    new SessionStore(join(root, 'store/sessions.json')), undefined, join(root, 'separate-logs'))
  try {
    const record = orchestrator.createSessionRecord({ agentId: agent.id, workdir: root, permissionMode: 'ask' }, '只读信息').session
    ;(orchestrator as any).getEvents = () => { throw new Error('must not replay history') }
    await orchestrator.flushSessionLogs()
    assert.equal(sessionInfoRevealPath(await orchestrator.getSessionInfo(record.id), 'diagnosticLog'), join(root, 'separate-logs', record.id + '.jsonl'))
    assert.equal(orchestrator.getSessionById(record.id)?.nativeSessionId, undefined, 'viewing metadata must not create a native session')
    await assert.rejects(orchestrator.getSessionInfo('missing'), /会话不存在/)
  } finally { await orchestrator.closeSessionLogs() }
} finally {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(root, { recursive: true, force: true })
}
console.log('session-info: provider metadata, real paths, omission, errors, copy, reveal and read-only orchestration passed')
