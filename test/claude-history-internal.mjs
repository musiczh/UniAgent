import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

// Claude keeps harness-only records in its project transcript: the /compact
// summary plus continuation prompt (`isCompactSummary`) and meta notes such as
// image-size annotations (`isMeta`). Replaying them as user bubbles fabricated
// conversation turns after restart; this fixture reproduces that shape.
const home = await mkdtemp(join(tmpdir(), 'ua-claude-internal-'))
const priorHome = process.env.HOME
process.env.HOME = home
const sessionId = '22222222-2222-4222-8222-222222222222'
const project = join(home, '.claude', 'projects', '-repo')
await mkdir(project, { recursive: true })
const summary = 'This session is being continued from a previous conversation that ran out of context. INTERNAL COMPACTION SUMMARY'
await writeFile(join(project, `${sessionId}.jsonl`), [
  // A meta note can precede the first real prompt; it must never title the session.
  { type: 'user', isMeta: true, message: { content: '[Image: original 2560x1640, displayed at 2000x1281.]' } },
  { type: 'user', cwd: '/repo', message: { content: '第一轮真实消息' } },
  { type: 'assistant', message: { id: 'reply-1', stop_reason: 'end_turn', content: [{ type: 'text', text: '压缩前的回复' }] } },
  { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary-1' },
  { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: summary } },
  { type: 'user', message: { content: '第二轮真实消息' } },
  { type: 'assistant', message: { id: 'reply-2', stop_reason: 'end_turn', content: [{ type: 'text', text: '压缩后的回复' }] } },
  { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary-2' },
  { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: summary } }
].map((item) => JSON.stringify(item)).join('\n'))

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { listAgentHistory, loadSessionEvents } = await server.ssrLoadModule('/src/main/history.ts')

  const history = await loadSessionEvents('claude', sessionId)
  const users = history.events.filter((event) => event.type === 'user_message')
  assert.deepEqual(
    users.map((event) => event.payload.text),
    ['第一轮真实消息', '第二轮真实消息'],
    'only the human turns replay; compact summaries and meta notes are transcript bookkeeping'
  )
  const payloads = JSON.stringify(history.events.map((event) => event.payload))
  assert.doesNotMatch(payloads, /INTERNAL COMPACTION SUMMARY|Image: original/, 'internal records never reach the rendered conversation')
  const compactions = history.events.filter((event) => event.type === 'context_compaction')
  assert.deepEqual(compactions.map((event) => event.state), ['success', 'success'], 'before/after compaction replies stay visible')
  assert.deepEqual(compactions.map((event) => event.payload.id), ['claude-compact-compact-boundary-1', 'claude-compact-compact-boundary-2'])
  assert.ok(history.events.some((event) => event.type === 'agent_message' && event.payload.text === '压缩前的回复'))
  assert.ok(history.events.some((event) => event.type === 'agent_message' && event.payload.text === '压缩后的回复'))

  const listed = (await listAgentHistory('claude')).find((item) => item.id === sessionId)
  assert.equal(listed?.title, '第一轮真实消息', 'a meta note cannot title a session')
  console.log('claude history internal records: ok')
} finally {
  await server.close()
  process.env.HOME = priorHome
  await rm(home, { recursive: true, force: true })
}
