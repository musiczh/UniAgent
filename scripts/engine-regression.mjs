import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineCases } from '../test/regression/catalog.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const current = () => ({
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
})

export function validateEngineResult(report, plan, evidenceRoot) {
  assert.equal(report.schemaVersion, 1)
  for (const key of ['runId', 'revision', 'version']) assert.equal(report[key], plan[key], 'stale or mismatched ' + key)
  assert.ok(Number.isFinite(Date.parse(report.startedAt)))
  assert.ok(Date.parse(report.startedAt) >= Date.parse(plan.createdAt), 'result predates this execution plan')
  assert.ok(Array.isArray(report.results))
  assert.deepEqual(report.results.map(r => r.id).sort(), plan.cases.map(r => r.id).sort(), 'missing, duplicate or unknown cases')
  const base = realpathSync(evidenceRoot)
  for (const result of report.results) {
    assert.ok(['passed', 'failed', 'blocked', 'not-run'].includes(result.status))
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0)
    assert.equal(typeof result.actual, 'string')
    assert.equal(typeof result.expected, 'string')
    assert.ok(result.actual.trim() && result.expected.trim(), 'record actual/expected, including blocked reasons')
    assert.ok(Array.isArray(result.evidence))
    if (result.status === 'passed') assert.ok(result.evidence.length, result.id + ' passed without evidence')
    for (const file of result.evidence) {
      assert.equal(typeof file, 'string')
      const path = realpathSync(resolve(base, file))
      const rel = relative(base, path)
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'evidence must stay inside this execution directory')
      assert.ok(statSync(path).isFile() && statSync(path).size > 0, 'evidence must be a nonempty file')
    }
  }
  return report.results.every(result => result.status === 'passed')
}

function main() {
  const [mode = 'prepare', argument, ...extra] = process.argv.slice(2).filter(arg => arg !== '--')
  assert.ok(!extra.length && ['prepare', 'check'].includes(mode), 'use prepare | check <result.json>')
  const output = join(root, 'out/test-results')
  const planPath = join(output, 'engine-plan.json')
  if (mode === 'check') {
    assert.ok(argument, 'pass the engine result JSON')
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    const { revision, version } = current()
    assert.deepEqual(plan.cases.map(c => c.id), engineCases.map(c => c.id), 'acceptance catalog changed; prepare a fresh run')
    assert.equal(plan.revision, revision, 'HEAD changed; prepare a fresh engine run')
    assert.equal(plan.version, version, 'version changed; prepare a fresh engine run')
    const report = JSON.parse(readFileSync(resolve(argument), 'utf8'))
    const ok = validateEngineResult(report, plan, join(output, plan.runId))
    console.log(JSON.stringify({ scope: 'engine-acceptance', status: ok ? 'passed' : 'incomplete', results: report.results }, null, 2))
    process.exitCode = ok ? 0 : 1
    return
  }
  assert.equal(argument, undefined, 'prepare takes no arguments')
  const plan = { schemaVersion: 1, runId: 'engine-' + randomUUID(), ...current(), createdAt: new Date().toISOString(), cases: engineCases }
  const directory = join(output, plan.runId)
  mkdirSync(directory, { recursive: true })
  // ponytail: one pending engine plan; use separate run workspaces if concurrent acceptance is needed.
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n')
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
  const template = { schemaVersion: 1, runId: plan.runId, revision: plan.revision, version: plan.version, startedAt: plan.createdAt,
    results: engineCases.map(({ id, title }) => ({ id, status: 'not-run', durationMs: 0, expected: title, actual: '尚未执行', evidence: [] })) }
  writeFileSync(join(directory, 'result-template.json'), JSON.stringify(template, null, 2) + '\n')
  const instructions = [
    '# 引擎回归任务',
    '按下面规范执行全部 12 组验收。未执行、缺少账号或工具必须如实填写 not-run/blocked。',
    '不要启动子 Agent、不要操作生产账号，不得终止 /Applications/UniAgent.app。',
    '使用同目录 result-template.json；证据保存到本目录，evidence 填相对本目录的路径。',
    '将结果另存为 out/test-results/engine-result.json，然后执行 pnpm run test:engine:check -- out/test-results/engine-result.json。',
    '工作区含未提交内容：' + String(plan.dirty) + '；验证期间代码不得改变，改变后重新 prepare。',
    '本任务 revision=' + plan.revision + ' version=' + plan.version + ' runId=' + plan.runId,
    readFileSync(join(root, 'docs/testing/engine-cases.md'), 'utf8')
  ].join('\n\n')
  writeFileSync(join(directory, 'task.md'), instructions)
  console.log('Execution packet: ' + join(directory, 'task.md'))
  console.log('No engine has been started; all acceptance cases are not-run.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error); process.exitCode = 1 }
}
