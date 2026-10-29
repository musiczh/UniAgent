import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { discoverTests, engineCases } from '../test/regression/catalog.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export function isolatedEnvironment(directory) {
  // Do not inherit real account homes, auth tokens, Node injection or Git overrides.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'LANG', 'LC_ALL', 'TZ', 'NODE_INCLUDE_DIR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  for (const [key, path] of Object.entries({
    HOME: 'home', USERPROFILE: 'home', UNIAGENT_USER_DATA: 'user-data',
    CODEX_HOME: 'home/.codex', TRAE_HOME: 'home/.trae', CLAUDE_CONFIG_DIR: 'home/.claude',
    XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state', XDG_RUNTIME_DIR: 'runtime', TMPDIR: 'tmp', TMP: 'tmp', TEMP: 'tmp'
  })) {
    env[key] = join(directory, path)
    mkdirSync(env[key], { recursive: true, mode: 0o700 })
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
  env.npm_config_userconfig = join(directory, 'npmrc')
  env.npm_config_cache = join(directory, 'npm-cache')
  env.UA_REGRESSION = '1'
  return env
}

export async function runCase(entry, { cwd = root, logDir, timeoutMs = 60_000, signal } = {}) {
  if (!Array.isArray(entry.args) || entry.args.length === 0) throw new Error('test command arguments must be a nonempty array')
  const started = Date.now()
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'uniagent-regression-')))
  const log = join(logDir, entry.id.replace(/[^\w.-]/g, '_') + '.log')
  let child, timer, escalation, status, detail = '', output = ''
  const stop = (reason) => {
    status ||= reason
    if (!child?.pid) return
    const send = (sig) => {
      try {
        // Each child is a new process group; never match or signal installed Apps.
        if (process.platform === 'win32') child.kill(sig)
        else process.kill(-child.pid, sig)
      } catch (error) { if (error.code !== 'ESRCH') detail += String(error) }
    }
    send('SIGTERM')
    escalation ||= setTimeout(() => send('SIGKILL'), 1_000)
  }
  const abort = () => stop('cancelled')
  if (!signal) {
    process.on('SIGINT', abort)
    process.on('SIGTERM', abort)
  }
  try {
    const env = isolatedEnvironment(directory)
    if (signal?.aborted) return { id: entry.id, status: 'cancelled', durationMs: 0 }
    const result = await new Promise(resolveExit => {
      child = spawn(process.execPath, entry.args, {
        cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
      })
      // ponytail: retain the last 1 MiB per file; stream to disk if verbose suites outgrow it.
      const append = chunk => { output = (output + chunk).slice(-1024 * 1024) }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      child.once('error', error => { detail = error.message })
      child.once('close', (code, exitSignal) => resolveExit({ code, exitSignal }))
      timer = setTimeout(() => stop('timed-out'), timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
    })
    // node:test marks skipped/todo tests explicitly. Never label a partial suite green.
    const incomplete = /# (?:SKIP|TODO)\b|# (?:skipped|todo) [1-9]|ℹ (?:skipped|todo) [1-9]/i.test(output)
    status ||= result.code === 0 ? (incomplete ? 'incomplete' : 'passed') : 'failed'
    if (result.code !== 0) detail ||= 'exit ' + (result.code ?? result.exitSignal)
    writeFileSync(log, output + (detail ? '\n' + detail + '\n' : ''), { mode: 0o600 })
    return { id: entry.id, status, durationMs: Date.now() - started, ...result, log, ...(detail ? { detail } : {}) }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
    signal?.removeEventListener('abort', abort)
    if (!signal) {
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
    }
    // Reap same-group fixture subprocesses, including on an assertion failure.
    if (child?.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function runSuite(entries, { jobs = 4, budgetMs = 180_000, ...options }) {
  const controller = new AbortController()
  const results = new Array(entries.length)
  let next = 0
  const abort = () => controller.abort()
  const timer = setTimeout(abort, budgetMs)
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, entries.length) }, async () => {
      while (!controller.signal.aborted && next < entries.length) {
        const index = next++
        try {
          results[index] = await runCase(entries[index], { ...options, signal: controller.signal })
        } catch (error) {
          results[index] = { id: entries[index].id, status: 'failed', durationMs: 0, detail: String(error) }
        }
        options.onResult?.(results[index])
      }
    }))
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  return entries.map((entry, i) => results[i] || { id: entry.id, status: 'not-run', durationMs: 0 })
}

export function testEntry(file) {
  return { id: file, args: /\.tsx?$/.test(file) || /\/(agent-lifecycle|agents-model|manual-context-compaction)\.test\.mjs$/.test(file)
    ? ['scripts/run-ts-test.mjs', file]
    : ['--experimental-transform-types', file] }
}

async function main() {
  const { values } = parseArgs({ options: {
    list: { type: 'boolean' }, filter: { type: 'string' },
    jobs: { type: 'string', default: '4' }, timeout: { type: 'string', default: '300' },
    budget: { type: 'string', default: '360' }
  } })
  const number = (name, max) => {
    const n = Number(values[name])
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('--' + name + ' must be 1..' + max)
    return n
  }
  const jobs = number('jobs', 16), timeoutMs = number('timeout', 600) * 1000, budgetMs = number('budget', 1800) * 1000
  const catalog = discoverTests()
  const files = catalog.filter(test => !test.reason && (!values.filter || test.file.includes(values.filter)))
  if (!files.length) throw new Error('No tests selected (a typo must not produce a green run)')
  if (values.list) {
    console.log(JSON.stringify({ selected: files, excluded: catalog.filter(test => test.reason), engineCases }, null, 2))
    return
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 7)) throw new Error('Regression scripts require Node >=22.7 for existing TS-importing .mjs tests')
  const startedAt = new Date().toISOString()
  const logDir = join(root, 'out/test-results', startedAt.replace(/[:.]/g, '-') + '-' + process.pid)
  mkdirSync(logDir, { recursive: true })
  let revision = 'unknown', dirty = true
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
  } catch { /* report still works outside a Git checkout */ }
  const onResult = result => console.log(result.status.padEnd(10) + ' ' + (result.durationMs / 1000).toFixed(2) + 's ' + result.id)
  // Build the existing native fixture once before workers use it, never in parallel.
  const setup = await runCase({ id: 'native-addon', args: ['scripts/prepare-regression.mjs'] }, { logDir, timeoutMs }).catch(error => ({ id: 'native-addon', status: 'failed', durationMs: 0, detail: String(error) }))
  onResult(setup)
  // The existing release simulation is the longest file; start it before the short tests.
  const results = setup.status === 'passed'
    ? await runSuite([...files].sort((a, b) => Number(b.file.includes('release-workflow')) - Number(a.file.includes('release-workflow'))).map(({ file }) => testEntry(file)), { jobs, timeoutMs, budgetMs, logDir, onResult })
    : files.map(({ file }) => ({ id: file, status: 'not-run', durationMs: 0 }))
  const ok = setup.status === 'passed' && results.every(result => result.status === 'passed')
  const report = {
    schemaVersion: 1, scope: values.filter ? 'filtered' : 'offline-regression', filter: values.filter || null,
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    revision, dirty, node: process.version, platform: process.platform + '-' + process.arch,
    startedAt, durationMs: Date.now() - Date.parse(startedAt), jobs, timeoutMs, budgetMs,
    status: ok ? 'passed' : 'failed', setup,
    summary: { total: results.length, passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status !== 'passed').length },
    results, excluded: catalog.filter(test => test.reason), engineCases
  }
  const reportFile = join(logDir, 'report.json')
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
  const latest = join(root, 'out/test-results/latest.json')
  writeFileSync(latest + '.' + process.pid + '.tmp', JSON.stringify(report, null, 2) + '\n')
  renameSync(latest + '.' + process.pid + '.tmp', latest)
  console.log('\n' + report.summary.passed + '/' + results.length + ' files passed in ' + (report.durationMs / 1000).toFixed(1) + 's; report: ' + reportFile)
  for (const result of [setup, ...results].filter(r => r.status !== 'passed')) console.error(result.id + ': ' + result.status + '; ' + (result.log || 'not executed'))
  process.exitCode = ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
