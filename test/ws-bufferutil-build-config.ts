import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'electron.vite.config.ts'), 'utf8')
assert.match(
  source,
  /main:\s*\{[\s\S]*?define:\s*\{[\s\S]*?['"]process\.env\.WS_NO_BUFFER_UTIL['"]:\s*JSON\.stringify\(['"]1['"]\)/,
  'the packaged main process must force ws to use its built-in JavaScript masker'
)

console.log('ws bufferutil build config: ok')
