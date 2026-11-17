import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { createServer } from 'vite'

const directory = await mkdtemp(join(tmpdir(), 'ua-compressed-history-'))
const previousHome = process.env.HOME
const previousUserData = process.env.UNIAGENT_USER_DATA
const previousNode = process.env.UNIAGENT_TOKEN_NODE_BIN
const previousTemps = (await readdir(tmpdir())).filter(name => name.startsWith('ua-history-decode-'))
process.env.HOME = directory
process.env.UNIAGENT_USER_DATA = join(directory, 'user-data')
process.env.UNIAGENT_TOKEN_NODE_BIN = process.execPath
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } })
const hosts = []
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const line = (type, payload, ordinal) => JSON.stringify({ type, payload, ordinal, timestamp: '2026-11-03T04:17:39.000Z' }) + '\n'
function transcript(nativeId, text = '请梳理 server 链路', extra = {}) {
  return line('session_meta', { id: nativeId, cwd: directory, ...extra }, 0)
    + line('turn_context', { turn_id: 'turn-1', model: 'gpt-6.1-sol', effort: 'xhigh' }, 1)
    + line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, 2)
    + line('event_msg', { type: 'agent_reasoning', text: '正在核对 server 入口' }, 3)
    + line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'cmd-1', command: 'rg server', aggregated_output: 'server.ts:42', exit_code: 0 } }, 4)
    + line('response_item', { type: 'function_call', call_id: 'call-1', name: 'inspect_server', arguments: '{}' }, 5)
    + line('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'server entry confirmed' }, 6)
    + line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '链路已梳理完成' }] }, 7)
    + line('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 8)
}
async function rollout(agentId, nativeId, text, suffix = '.zst', archived = false) {
  const root = join(directory, agentId === 'codex' ? '.codex' : '.trae/cli', archived ? 'archived_sessions' : 'sessions/2026/11/03')
  await mkdir(root, { recursive: true })
  const path = join(root, `rollout-2026-11-03T12-17-39-${nativeId}.jsonl${suffix}`)
  await writeFile(path, suffix ? zstdCompressSync(Buffer.from(text)) : text)
  return path
}
function assertTranscript(events, prompt = '请梳理 server 链路') {
  assert.deepEqual(events.filter(e => e.type === 'user_message').map(e => e.payload.text), [prompt])
  assert.deepEqual(events.filter(e => e.type === 'agent_message').map(e => e.payload.text), ['链路已梳理完成'])
  assert.ok(events.some(e => e.type === 'reasoning' && e.payload.text.includes('正在核对 server 入口')))
  assert.ok(events.some(e => e.type === 'command_exec' && e.payload.command === 'rg server' && e.payload.output.includes('server.ts:42')))
  assert.ok(events.some(e => e.type === 'tool_call' && e.payload.name === 'inspect_server' && e.payload.result === 'server entry confirmed' && e.state === 'success'))
  assert.ok(events.some(e => e.type === 'turn_completed' && e.payload.turnId === 'turn-1'))
}

try {
  const { loadSessionEvents, resolveNativeSessionFile, forkSameSession, rolloutGenerationEndTimestamp } = await server.ssrLoadModule('/src/main/history.ts')
  const { readHistoryFile } = await server.ssrLoadModule('/src/main/historyProgress.ts')
  const { Orchestrator } = await server.ssrLoadModule('/src/main/orchestrator.ts')
  const { SessionStore } = await server.ssrLoadModule('/src/main/sessionStore.ts')

  for (const agentId of ['codex', 'traex']) {
    for (const [index, suffix, archived] of [[1, '.zst', false], [2, '.zstd', true], [3, '', false]]) {
      const nativeId = id(index + (agentId === 'traex' ? 10 : 0))
      const text = transcript(nativeId)
      const path = await rollout(agentId, nativeId, text, suffix, archived)
      const original = await readFile(path)
      assert.equal(await resolveNativeSessionFile(agentId, nativeId), path, 'compressed and archived rollouts resolve by exact native ID')
      if (agentId === 'codex' && index === 1) {
        process.env.UNIAGENT_TOKEN_NODE_BIN = join(directory, 'missing-node')
        await assert.rejects(readHistoryFile(path), /decoder_unavailable/, 'an unavailable decoder is an explicit, retryable failure')
        process.env.UNIAGENT_TOKEN_NODE_BIN = process.execPath
      }
      const ticks = []
      assert.equal((await readHistoryFile(path, tick => ticks.push(tick))).toString(), text)
      assert.equal(ticks.at(-1).completed, Buffer.byteLength(text), 'progress counts decoded JSONL bytes')
      const restored = await loadSessionEvents(agentId, nativeId)
      assertTranscript(restored.events)
      assert.equal(restored.cwd, directory)
      assert.equal(restored.model, 'gpt-6.1-sol')
      assert.equal(await rolloutGenerationEndTimestamp(path), Date.parse('2026-11-03T04:17:39.000Z'))
      assert.deepEqual(await readFile(path), original, 'viewing history preserves the compressed source')

      const store = new SessionStore(join(directory, `store-${nativeId}`, 'sessions.json'))
      const session = { id: `task-${nativeId}`, title: '作者server链路梳理', status: 'completed', archived, origin: 'created',
        createdAt: 1, nativeSessionId: nativeId, config: { agentId, workdir: directory, permissionMode: 'full-access' } }
      store.saveOrThrow([session])
      const agent = { id: agentId, name: agentId, adapter: agentId, bin: '/usr/bin/true', installed: true, models: [], capabilities: {} }
      const host = new Orchestrator(() => agent, store)
      hosts.push(host)
      await host.loadPersisted()
      const [a, b] = await Promise.all([host.getEvents(session.id), host.getEvents(session.id)])
      assertTranscript(a)
      assert.deepEqual(a, b, 'concurrent readers share a complete history')
      assert.ok(a.every(e => e.sessionId === session.id))
      assert.equal(new Set(a.map(e => e.seq)).size, a.length)
      assertTranscript(await host.getEvents(session.id))
    }
  }

  const parentId = id(20), childId = id(21)
  const parentPrefix = transcript(parentId, '父会话的原始提问')
  await rollout('codex', parentId, parentPrefix + line('event_msg', { type: 'user_message', message: '分叉之后的父会话消息' }, 9), '.zstd', true)
  await rollout('codex', childId, line('session_meta', { id: childId, history_base: { thread_id: parentId, end_byte_offset: Buffer.byteLength(parentPrefix) } }, 0), '.zst')
  assertTranscript((await loadSessionEvents('codex', childId)).events, '父会话的原始提问')
  const source = await resolveNativeSessionFile('codex', id(1))
  const artifacts = source.replace(/\.jsonl\.zst$/, '.artifacts')
  await mkdir(artifacts)
  await writeFile(join(artifacts, 'result.txt'), 'large tool output')
  const fork = await forkSameSession('codex', id(1))
  assert.ok(fork, 'forking compressed history produces a valid native thread')
  assertTranscript((await loadSessionEvents('codex', fork.nativeId)).events)
  const forkFile = await resolveNativeSessionFile('codex', fork.nativeId)
  assert.equal(await readFile(join(forkFile.replace(/\.jsonl$/, '.artifacts'), 'result.txt'), 'utf8'), 'large tool output')

  const taskId = id(30), subId = id(31), base = Date.parse('2026-11-03T04:17:39.000Z')
  const timed = (payload, offset) => JSON.stringify({ type: 'event_msg', timestamp: new Date(base + offset).toISOString(), payload }) + '\n'
  await rollout('codex', subId, line('session_meta', { id: subId, agent_nickname: 'Dalton', source: { subagent: { thread_spawn: { parent_thread_id: taskId } } } }, 0)
    + timed({ type: 'task_complete' }, 500), '.zstd', true)
  await rollout('codex', taskId, line('session_meta', { id: taskId }, 0)
    + timed({ type: 'sub_agent_activity', agent_thread_id: subId, kind: 'started', event_id: 'dispatch' }, 0)
    + timed({ type: 'task_complete' }, 1000))
  const agents = (await loadSessionEvents('codex', taskId)).events.filter(e => e.type === 'subagent').flatMap(e => e.payload.agents)
  assert.equal(agents.at(-1).endedAt, base + 500, 'compressed child history bounds the generation before the parent ends')
  assert.ok(agents.every(agent => agent.name === 'Dalton'), 'compressed child metadata restores the original nickname')

  const duplicateId = id(40)
  await rollout('codex', duplicateId, transcript(duplicateId, '旧压缩消息'))
  const plaintext = await rollout('codex', duplicateId, transcript(duplicateId, '新明文消息'), '')
  assert.equal(await resolveNativeSessionFile('codex', duplicateId), plaintext, 'a current plaintext rollout takes precedence over its compressed copy')
  assertTranscript((await loadSessionEvents('codex', duplicateId)).events, '新明文消息')

  const framedId = id(22), framedText = transcript(framedId)
  const framedPath = await rollout('codex', framedId, '', '.zst')
  const split = framedText.indexOf('\n') + 1
  await writeFile(framedPath, Buffer.concat([zstdCompressSync(Buffer.from(framedText.slice(0, split))), zstdCompressSync(Buffer.from(framedText.slice(split)))]))
  assertTranscript((await loadSessionEvents('codex', framedId)).events)

  assert.equal(await resolveNativeSessionFile('codex', '../invalid'), null)
  assert.equal(await resolveNativeSessionFile('codex', id(999)), null)
  const brokenId = id(23), brokenPath = await rollout('codex', brokenId, transcript(brokenId))
  const valid = await readFile(brokenPath)
  const brokenStore = new SessionStore(join(directory, 'broken-store', 'sessions.json'))
  const brokenSession = { id: 'broken-task', title: '损坏压缩历史', status: 'completed', createdAt: 1, nativeSessionId: brokenId,
    config: { agentId: 'codex', workdir: directory, permissionMode: 'full-access' } }
  brokenStore.saveOrThrow([brokenSession])
  const brokenHost = new Orchestrator(() => ({ id: 'codex', adapter: 'codex', bin: '/usr/bin/true', installed: true, models: [], capabilities: {} }), brokenStore)
  hosts.push(brokenHost)
  await brokenHost.loadPersisted()
  await writeFile(brokenPath, valid.subarray(0, valid.length - 1))
  await assert.rejects(loadSessionEvents('codex', brokenId), /decode|Zstandard|压缩|frame/, 'truncated history must fail rather than appear empty or complete')
  await assert.rejects(brokenHost.getEvents(brokenSession.id), /decode|Zstandard|压缩|frame/)
  await writeFile(brokenPath, Buffer.from('invalid compressed history'))
  await assert.rejects(loadSessionEvents('codex', brokenId), /decode|Zstandard|压缩|frame/)
  await writeFile(brokenPath, valid)
  assertTranscript((await loadSessionEvents('codex', brokenId)).events)
  assertTranscript(await brokenHost.getEvents(brokenSession.id))

  const { withDecodedHistoryFile } = await server.ssrLoadModule('/src/main/historyCompression.ts')
  let temporary
  await assert.rejects(withDecodedHistoryFile(brokenPath, async path => { temporary = path; throw Error('fixture parse failed') }), /fixture parse failed/)
  await assert.rejects(readFile(temporary), { code: 'ENOENT' }, 'temporary decoded history is removed after parser failure')
  const tempRoots = (await readdir(tmpdir())).filter(name => name.startsWith('ua-history-decode-'))
  assert.deepEqual(tempRoots.sort(), previousTemps.sort(), 'success and decode failure clean up temporary histories')
  console.log('compressed session history: plaintext, zst, zstd, archive, completed tasks, concurrency, lineage, fork, frames, corruption, retry and cleanup passed')
} finally {
  for (const host of hosts) { host.disposeAll(); await host.closeSessionLogs() }
  await server.close()
  for (const [key, value] of [['HOME', previousHome], ['UNIAGENT_USER_DATA', previousUserData], ['UNIAGENT_TOKEN_NODE_BIN', previousNode]]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(directory, { recursive: true, force: true })
}
