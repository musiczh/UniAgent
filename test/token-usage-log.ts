import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'ua-token-log-'))
const logPath = join(root, 'token-usage.log')
const previous = process.env.UNIAGENT_TOKEN_LOG_PATH
process.env.UNIAGENT_TOKEN_LOG_PATH = logPath

try {
  const { logTokenUsage, flushTokenUsageLog, tokenUsageLogPath } = await import('../src/main/tokenUsageLog.ts')
  assert.equal(tokenUsageLogPath(), logPath)
  logTokenUsage('test', 'entry', {
    a: 1,
    token: 'secret-value',
    nested: { jwt: 'also-secret' },
    huge: 'x'.repeat(5_000),
    list: Array.from({ length: 300 }, (_, index) => index)
  })
  logTokenUsage('renderer', 'load.done', { tokens: 42 })
  await flushTokenUsageLog()

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].scope, 'test')
  assert.equal(lines[0].event, 'entry')
  assert.equal(lines[0].data.a, 1)
  assert.equal(lines[0].data.token, '[redacted]')
  assert.equal(lines[0].data.nested.jwt, '[redacted]')
  assert.ok(lines[0].data.huge.length <= 4_001, 'oversized strings are capped')
  assert.equal(lines[0].data.list.length, 200, 'oversized arrays are capped')
  assert.equal(lines[1].scope, 'renderer')
  assert.equal(lines[1].data.tokens, 42)
} finally {
  if (previous === undefined) delete process.env.UNIAGENT_TOKEN_LOG_PATH
  else process.env.UNIAGENT_TOKEN_LOG_PATH = previous
  await rm(root, { recursive: true, force: true })
}

console.log('token usage log: ok')
