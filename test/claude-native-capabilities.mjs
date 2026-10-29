import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { normalizeClaudeNativeSnapshot } = await server.ssrLoadModule('/src/main/nativeCapabilityService.ts')
  const snapshot = normalizeClaudeNativeSnapshot('claude', '/repo', {
    commands: [
      { name: 'compact', description: 'Compact context' },
      { name: 'android-cli', description: 'Android skill' },
      { name: '../../bad' }
    ]
  }, { mcpServers: [
    { name: 'docs', status: 'connected' },
    { name: 'slow', status: 'pending' },
    { name: 'uniagent', status: 'connected' }
  ] })
  assert.deepEqual(snapshot.candidates.map((item) => item.id), [
    'command:compact', 'command:android-cli', 'mcp:docs', 'mcp:slow'
  ])
  assert.equal(snapshot.candidates[2].startupStatus, 'ready')
  assert.equal(snapshot.candidates[3].startupStatus, 'starting')
  console.log('claude native capabilities: ok')
} finally {
  await server.close()
}
