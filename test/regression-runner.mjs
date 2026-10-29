import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { validateEngineResult } from '../scripts/engine-regression.mjs'
import { discoverTests, engineCases } from './regression/catalog.mjs'
import { isolatedEnvironment, runCase, runSuite } from '../scripts/run-regression.mjs'

const dir = mkdtempSync(join(tmpdir(), 'regression-self-check-'))
try {
  const options = { logDir: dir, timeoutMs: 3_000 }
  const oldToken = process.env.ANTHROPIC_API_KEY
  const oldOptions = process.env.NODE_OPTIONS
  try {
    process.env.ANTHROPIC_API_KEY = 'must-not-leak'
    process.env.NODE_OPTIONS = '--trace-warnings'
    const isolated = isolatedEnvironment(join(dir, 'env'))
    assert.equal(isolated.ANTHROPIC_API_KEY, undefined)
    assert.equal(isolated.NODE_OPTIONS, undefined)
  } finally {
    if (oldToken === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldToken
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = oldOptions
  }
  const entry = (id, code) => ({ id, args: ['-e', code] })
  const results = await runSuite([
    entry('pass', 'console.log(JSON.stringify({home:process.env.HOME, data:process.env.UNIAGENT_USER_DATA, token:process.env.ANTHROPIC_API_KEY, injected:process.env.NODE_OPTIONS}))'),
    entry('fail', 'require("node:assert/strict").equal(1, 2)'),
    entry('after-failure', 'console.log("still ran")'),
    entry('skipped', 'console.log("ok 1 - unavailable # SKIP")')
  ], { ...options, jobs: 2, budgetMs: 10_000 })
  assert.deepEqual(results.map(r => r.status), ['passed', 'failed', 'passed', 'incomplete'])
  const env = JSON.parse(readFileSync(results[0].log, 'utf8'))
  assert.notEqual(env.home, process.env.HOME)
  assert.notEqual(env.data, process.env.UNIAGENT_USER_DATA)
  assert.equal(env.token, undefined)
  assert.equal(env.injected, undefined)
  assert.equal(existsSync(env.home), false, 'fixture homes cleaned after completion')
  const timeout = await runCase(entry('timeout', 'setInterval(() => {}, 1000)'), { ...options, timeoutMs: 200 })
  assert.equal(timeout.status, 'timed-out')
  assert.equal(existsSync(JSON.parse(readFileSync(results[0].log, 'utf8')).home), false)
  const invalid = await runSuite([{ id: 'invalid-spawn', args: null }], { ...options, jobs: 1 })
  assert.equal(invalid[0].status, 'failed', 'runner failures still produce a case result')
  const interrupt = await runCase(entry('signal', 'process.kill(process.ppid, "SIGTERM"); setInterval(() => {}, 1000)'), options)
  assert.equal(interrupt.status, 'cancelled', 'standalone/setup signal follows cleanup instead of abandoning its child')

  const budget = await runSuite([
    entry('budget', 'setInterval(() => {}, 1000)'), entry('unstarted', '')
  ], { ...options, jobs: 1, budgetMs: 200 })
  assert.deepEqual(budget.map(r => r.status), ['cancelled', 'not-run'])
  const noMatch = spawnSync(process.execPath, ['scripts/run-regression.mjs', '--filter', 'NO_SUCH_TEST'], { encoding: 'utf8' })
  assert.notEqual(noMatch.status, 0, 'empty selection cannot succeed')
  const catalog = discoverTests()
  assert.ok(catalog.filter(t => !t.reason).length > 100)
  assert.ok(catalog.find(t => t.file === 'test/headless.ts').reason)
  assert.ok(catalog.find(t => t.file === 'test/cdp-verify-goal.mjs').reason)
  const plan = { runId: 'one', revision: 'head', version: '1', createdAt: new Date().toISOString(), cases: [{ id: 'one' }] }
  writeFileSync(join(dir, 'evidence.json'), '{"observed":true}')
  const report = { schemaVersion: 1, ...plan, startedAt: plan.createdAt, results: [{ id: 'one', status: 'passed', durationMs: 1, expected: 'true', actual: 'true', evidence: ['evidence.json'] }] }
  assert.equal(validateEngineResult(report, plan, dir), true)
  assert.throws(() => validateEngineResult({ ...report, revision: 'old' }, plan, dir))
  assert.throws(() => validateEngineResult({ ...report, results: [] }, plan, dir))
  assert.throws(() => validateEngineResult({ ...report, results: [report.results[0], report.results[0]] }, plan, dir))
  assert.throws(() => validateEngineResult({ ...report, results: [{ ...report.results[0], evidence: [] }] }, plan, dir))
  assert.throws(() => validateEngineResult({ ...report, results: [{ ...report.results[0], evidence: [join(process.cwd(), 'package.json')] }] }, plan, dir))
  assert.equal(validateEngineResult({ ...report, results: [{ ...report.results[0], status: 'blocked' }] }, plan, dir), false)
  const specs = readFileSync('docs/testing/engine-cases.md', 'utf8')
  for (const item of engineCases) assert.ok(specs.includes('id="' + item.id + '"'), 'missing engine case: ' + item.id)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('regression runner: discovery, failures, isolation, timeout, budget and exclusions ok')
