import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'

const directory = await mkdtemp(join(tmpdir(), 'ua-history-hydration-'))
const previousHome = process.env.HOME
process.env.HOME = directory
const hosts = []
const nativeId = '12345678-1234-4234-8234-123456789abc'
const warning = '需求后台整理未完成，已保留同步缺口；请检查模型状态与来源资料后重试。'
const server = await createServer({ root: process.cwd(), resolve: { alias: { '@shared': resolve('src/shared') } },
  optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })

try {
  const nativeDirectory = join(directory, '.codex', 'sessions', '2026', '11', '09')
  await mkdir(nativeDirectory, { recursive: true })
  await writeFile(join(nativeDirectory, `rollout-2026-11-09T00-00-00-${nativeId}.jsonl`), [
    { type: 'session_meta', payload: { id: nativeId, cwd: directory } },
    { type: 'event_msg', payload: { type: 'user_message', message: '已保存的提问' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '已保存的回复' } }
  ].map(JSON.stringify).join('\n') + '\n')
  const [{ Orchestrator }, { SessionStore }, { submittedTextHash }] = await Promise.all([
    server.ssrLoadModule('/src/main/orchestrator.ts'), server.ssrLoadModule('/src/main/sessionStore.ts'),
    server.ssrLoadModule('/src/main/submittedUserMessages.ts')
  ])
  const agent = { id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', installed: true, models: [],
    capabilities: { sessionLoad: true, sessionResume: true, permissionModes: [{ id: 'ask', label: '询问' }] } }
  async function fixture(name, submittedUserMessages) {
    const store = new SessionStore(join(directory, name, 'sessions.json'))
    const session = { id: name, title: name, status: 'idle', createdAt: 1, nativeSessionId: nativeId,
      config: { agentId: 'codex', workdir: directory, permissionMode: 'ask' },
      ...(submittedUserMessages ? { submittedUserMessages } : {}) }
    store.saveOrThrow([session])
    const host = new Orchestrator(() => agent, store)
    hosts.push(host)
    await host.loadPersisted()
    return { host, session }
  }
  function assertRestored(events) {
    assert.equal(events.filter(event => event.type === 'user_message' && event.payload.text === '已保存的提问').length, 1)
    assert.equal(events.filter(event => event.type === 'agent_message' && event.payload.text === '已保存的回复').length, 1)
    assert.equal(events.filter(event => event.payload.text === warning).length, 1, 'the real background warning stays visible once')
    assert.equal(new Set(events.map(event => event.seq)).size, events.length, 'live and restored event coordinates are distinct')
  }

  {
    const { host, session } = await fixture('warning-before-read')
    host.reportRequirementSyncError(session.id, warning)
    const events = await host.getEvents(session.id)
    assertRestored(events)
    assertRestored(await host.getEvents(session.id))
  }
  {
    const { host, session } = await fixture('warning-during-read')
    const flush = host.sessionLogs.flush.bind(host.sessionLogs)
    let release, entered, reads = 0
    const gate = new Promise(resolveGate => { release = resolveGate })
    const started = new Promise(resolveStarted => { entered = resolveStarted })
    host.sessionLogs.flush = async () => { reads++; entered(); await gate; await flush() }
    try {
      const first = host.getEvents(session.id)
      await started
      host.reportRequirementSyncError(session.id, warning)
      let secondSettled = false
      const second = host.getEvents(session.id).then(events => { secondSettled = true; return events })
      await new Promise(resolveTick => setTimeout(resolveTick, 20))
      assert.equal(secondSettled, false, 'a concurrent reader cannot return the warning while history is still loading')
      release()
      const [a, b] = await Promise.all([first, second])
      assertRestored(a)
      assertRestored(b)
      assert.equal(reads, 1, 'concurrent requests share one native history read')
    } finally {
      release()
      host.sessionLogs.flush = flush
    }
  }
  {
    const { host, session } = await fixture('failed-read-retry')
    const flush = host.sessionLogs.flush.bind(host.sessionLogs)
    let attempts = 0
    host.sessionLogs.flush = async () => { if (++attempts === 1) throw Error('fixture history read failed'); await flush() }
    try {
      await assert.rejects(host.getEvents(session.id), /fixture history read failed/, 'a failed restore is not a successful empty transcript')
      host.reportRequirementSyncError(session.id, warning)
      assertRestored(await host.getEvents(session.id))
      assert.equal(attempts, 2, 'failed history reads can retry')
    } finally { host.sessionLogs.flush = flush }
  }
  {
    const { host, session } = await fixture('refresh-before-first-open')
    host.reportRequirementSyncError(session.id, warning)
    await host.refreshNativeSession(session.id)
    const events = await host.getEvents(session.id)
    assert.equal(events.filter(event => event.type === 'user_message').length, 1, 'explicit refresh resolves pending restoration without replaying twice')
    assert.equal(events.filter(event => event.type === 'agent_message').length, 1)
  }
  {
    const text = '这里的复制图片是假的，无法复制'
    const nativeText = `[uniagent_global_memory_context]\n全局记忆\n\n当前用户输入：\n[uniagent_requirement_context]\n需求资料\n\n当前用户输入：\n${text}`
    const image = { kind: 'image', name: 'clip.png', path: join(directory, 'clip.png'), mime: 'image/png' }
    await writeFile(join(nativeDirectory, `rollout-2026-11-09T00-00-00-${nativeId}.jsonl`), [
      { type: 'session_meta', payload: { id: nativeId, cwd: directory } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: nativeText }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: '已保存的回复' } }
    ].map(JSON.stringify).join('\n') + '\n')
    const { host, session } = await fixture('ordinary-session-attachments', [
      { type: 'user_message', userOrdinal: 0, textHash: submittedTextHash(text), acceptedAt: 1, attachments: [image] }
    ])
    const assertAttachmentRestored = events => {
      const messages = events.filter(event => event.type === 'user_message')
      assert.equal(messages.length, 1, 'the restarted session restores one user message')
      assert.equal(messages[0].payload.text, text, 'host context stays out of the restored bubble')
      assert.deepEqual(messages[0].payload.attachments, [image], 'persisted image metadata reattaches to the native message')
    }
    assertAttachmentRestored(await host.getEvents(session.id))
    await host.refreshNativeSession(session.id)
    assertAttachmentRestored(await host.getEvents(session.id))
  }
  console.log('session history hydration: warning-first, concurrent reads, late notices, failure retry, refresh and ordinary-session attachments passed')
} finally {
  for (const host of hosts) { host.disposeAll(); await host.closeSessionLogs() }
  await server.close()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(directory, { recursive: true, force: true })
}
