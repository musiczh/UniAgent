import assert from 'node:assert/strict'
import { forkBetaSession } from '../src/main/betaSessionFork.ts'
import { forkDeepSeekSession } from '../src/main/grokACPRunner.ts'
for (const provider of ['kimi'] as const) {
  await assert.rejects(forkBetaSession(provider, 'existing-id', '/must-never-launch', '/tmp'), /UNSTABLE/)
}
await assert.rejects(forkBetaSession('grok','../foreign','/must-never-launch','/tmp'),/无效/)
await assert.rejects(forkDeepSeekSession('existing-id', '/must-never-launch', '/tmp'), /稳定 ACP/)
console.log('beta-session-fork: unstable fork rejected before process creation')
