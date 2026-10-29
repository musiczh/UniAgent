import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

// Regression: Claude replay used to stop at 4000 events, so a long session
// reopened without its newest user turns and replies. The cap kept the oldest
// prefix and silently dropped everything after it.
const home = await mkdtemp(join(tmpdir(), 'ua-claude-retention-'))
const priorHome = process.env.HOME
process.env.HOME = home
const sessionId = '33333333-3333-4333-8333-333333333333'
const project = join(home, '.claude', 'projects', '-repo')
await mkdir(project, { recursive: true })
const messageCount = 4_100
await writeFile(join(project, `${sessionId}.jsonl`), Array.from({ length: messageCount }, (_, index) =>
  JSON.stringify({
    type: 'user',
    uuid: `user-${index}`,
    cwd: '/repo',
    message: { content: `claude-message-${index}` }
  })
).join('\n'))

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})
try {
  const { loadSessionEvents } = await server.ssrLoadModule('/src/main/history.ts')
  const history = await loadSessionEvents('claude', sessionId)
  const users = history.events.filter((event) => event.type === 'user_message')
  assert.equal(users.length, messageCount, 'Claude replay must retain every user message beyond the legacy prefix')
  assert.equal(
    users.at(-1)?.payload.text,
    `claude-message-${messageCount - 1}`,
    'Claude replay must keep the newest user message instead of stopping at an arbitrary prefix'
  )
  console.log('claude history retention: ok')
} finally {
  await server.close()
  process.env.HOME = priorHome
  await rm(home, { recursive: true, force: true })
}
