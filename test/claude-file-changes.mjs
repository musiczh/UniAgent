import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const home = await mkdtemp(join(tmpdir(), 'ua-claude-changes-'))
const priorHome = process.env.HOME
process.env.HOME = home
const sessionId = '11111111-1111-4111-8111-111111111111'
const project = join(home, '.claude', 'projects', '-repo')
await mkdir(project, { recursive: true })
const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]
await writeFile(join(project, `${sessionId}.jsonl`), [
  { type: 'user', cwd: '/repo', message: { content: '编辑文件' } },
  { type: 'assistant', uuid: 'edit-call', message: { content: [
    { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/repo/a.txt', old_string: 'old', new_string: 'new' } }
  ] } },
  { type: 'user', sourceToolAssistantUUID: 'edit-call', message: { content: [
    { type: 'tool_result', tool_use_id: 'edit-1', content: 'Updated', is_error: false }
  ] }, toolUseResult: { filePath: '/repo/a.txt', structuredPatch: patch } }
].map((item) => JSON.stringify(item)).join('\n'))

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { TurnRunner } = await server.ssrLoadModule('/src/main/adapter.ts')
  const { loadSessionEvents } = await server.ssrLoadModule('/src/main/history.ts')
  const { filesFromTurnChanges } = await server.ssrLoadModule('/src/main/turnFileChanges.ts')

  const events = []
  const runner = new TurnRunner('live', { n: 0 })
  runner.on('event', (event) => events.push(event))
  runner.onLine('claude', JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/repo/a.txt', old_string: 'old', new_string: 'new' } }
  ] } }))
  runner.onLine('claude', JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'edit-1', content: 'Updated', is_error: false }
  ] }, tool_use_result: { filePath: '/repo/a.txt', structuredPatch: patch } }))
  assert.equal(events.find(({ type }) => type === 'tool_call')?.state, 'running')
  assert.equal(events.findLast(({ type }) => type === 'tool_call')?.state, 'success')
  const liveChange = events.find(({ type }) => type === 'file_change')
  assert.deepEqual(liveChange?.payload.changes, [{ path: '/repo/a.txt', kind: 'modify', diff: '@@ -1,1 +1,1 @@\n-old\n+new\n' }])
  const liveFiles = await filesFromTurnChanges(events, '/repo')
  assert.equal(liveFiles[0]?.path, 'a.txt')
  assert.match(liveFiles[0]?.unifiedDiff || '', /-old\n\+new/)

  const history = await loadSessionEvents('claude', sessionId)
  assert.deepEqual(history.events.find(({ type }) => type === 'file_change')?.payload.changes, liveChange.payload.changes)
  assert.match(history.events.find(({ type }) => type === 'diff_update')?.payload.diff || '', /-old\n\+new/)

  const failed = []
  const failedRunner = new TurnRunner('failed', { n: 0 })
  failedRunner.on('event', (event) => failed.push(event))
  failedRunner.onLine('claude', JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: '/repo/new.txt', content: 'data' } }
  ] } }))
  failedRunner.onLine('claude', JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'write-1', content: 'Denied', is_error: true }
  ] }, tool_use_result: { type: 'create', filePath: '/repo/new.txt', content: 'data' } }))
  assert.equal(failed.some(({ type }) => type === 'file_change'), false)
  console.log('claude file changes: ok')
} finally {
  await server.close()
  process.env.HOME = priorHome
  await rm(home, { recursive: true, force: true })
}
