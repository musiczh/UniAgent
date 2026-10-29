// Installed official CLI contract test against isolated local providers; no paid calls.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const cli = process.env.UNIAGENT_CLAUDE_REAL_BIN || join(homedir(), '.local/bin/claude')
const fixture = await mkdtemp(join(tmpdir(), 'ua-claude-source-cli-'))
process.env.UNIAGENT_USER_DATA = join(fixture, 'data')
const bundle = resolve('.test-build/claude-source-runtime-test.mjs')
await build({ entryPoints: ['src/main/claudeSourceRuntime.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { createClaudeSourceRuntime } = await import(pathToFileURL(bundle).href)
const requests = []
let trapCalls = 0
const trap = createServer((_req, res) => { trapCalls++; res.writeHead(500); res.end() })
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (req.url.includes('count_tokens')) { res.end('{"input_tokens":32}'); return }
  if (!req.url.includes('/messages')) { res.end('{}'); return }
  const key = req.headers['x-api-key'] || req.headers.authorization
  requests.push({ model: body.model, key, path: req.url, effort: body.output_config?.effort, thinking: body.thinking, messages: body.messages })
  const result = { id: `msg_fixture_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'SOURCE_OK' }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 32, output_tokens: 4 } }
  if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return }
  res.setHeader('content-type', 'text/event-stream')
  for (const frame of [
    { type: 'message_start', message: { ...result, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SOURCE_OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' }
  ]) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
  res.end()
})
const children = new Set()
async function run(preset, resume, effort = 'high', sessionHome = preset) {
  const model = preset === 'kimi-code' ? 'k3' : 'deepseek-flash'
  const apiKey = preset === 'kimi-code' ? 'fixture-kimi-key' : 'fixture-deepseek-key'
  const runtime = await createClaudeSourceRuntime({ preset, model, apiKey, baseUrl: `http://127.0.0.1:${server.address().port}/${preset}` }, effort)
  const home = join(fixture, sessionHome), workdir = join(home, 'workspace')
  await mkdir(join(home, '.claude'), { recursive: true }); await mkdir(join(workdir, '.claude'), { recursive: true })
  const polluted = { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${trap.address().port}`, ANTHROPIC_AUTH_TOKEN: 'wrong-project-token', ANTHROPIC_API_KEY: 'wrong-project-key', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'wrong-model', CLAUDE_CODE_EFFORT_LEVEL: 'max' }, apiKeyHelper: 'echo wrong-helper-key' }
  await writeFile(join(home, '.claude/settings.json'), JSON.stringify(polluted))
  await writeFile(join(workdir, '.claude/settings.local.json'), JSON.stringify(polluted))
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--model', model,
    '--effort', effort, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...runtime.args, ...(resume ? ['--resume', resume] : []), '--', 'Return SOURCE_OK.']
  assert.ok(!args.join(' ').includes(apiKey))
  try {
    const child = spawn(cli, args, { cwd: workdir, env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CLAUDE_CODE_OAUTH_TOKEN: 'wrong-inherited-oauth', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_EFFORT_LEVEL: 'max', ...runtime.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000)
    const [code] = await once(child, 'close'); clearTimeout(timer); children.delete(child)
    assert.equal(code, 0, runtime.redact(stderr + stdout).slice(-2000))
    const events = stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const result = events.find(event => event.type === 'result')
    assert.equal(result?.is_error, false, runtime.redact(JSON.stringify(result)))
    assert.match(result?.result || '', /SOURCE_OK/)
    assert.equal(await readFile(join(home, '.claude/settings.json'), 'utf8'), JSON.stringify(polluted))
    assert.equal(await readFile(join(workdir, '.claude/settings.local.json'), 'utf8'), JSON.stringify(polluted))
    assert.equal(requests.findLast(request => request.path.startsWith('/' + preset + '/'))?.effort, effort, 'CLI must send selected output_config.effort')
    if (resume) {
      assert.equal(result.session_id, resume, 'switch must retain the native session')
      assert.ok(requests.findLast(request => request.path.startsWith('/' + preset + '/')).messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('SOURCE_OK')), 'resumed request must include previous assistant history')
    }
    return result.session_id
  } finally { await runtime.dispose(); await assert.rejects(stat(runtime.args[1]), { code: 'ENOENT' }) }
}
try {
  trap.listen(0, '127.0.0.1'); server.listen(0, '127.0.0.1')
  await Promise.all([once(trap, 'listening'), once(server, 'listening')])
  const sessions = await Promise.all([run('kimi-code'), run('deepseek')])
  assert.ok(sessions.every(Boolean))
  for (const effort of ['low', 'high', 'max']) {
    await Promise.all([run('kimi-code', sessions[0], effort), run('deepseek', sessions[1], effort)])
  }
  await run('deepseek', sessions[0], 'low', 'kimi-code')
  await run('kimi-code', sessions[0], 'max', 'kimi-code')
  await run('kimi-code', sessions[1], 'low', 'deepseek')
  await run('deepseek', sessions[1], 'max', 'deepseek')
  assert.equal(trapCalls, 0)
  for (const request of requests) {
    if (request.path.startsWith('/kimi-code/')) { assert.equal(request.model, 'k3'); assert.equal(request.key, 'fixture-kimi-key') }
    else { assert.equal(request.model, 'deepseek-flash'); assert.equal(request.key, 'Bearer fixture-deepseek-key') }
  }
  assert.ok(requests.some(request => request.model === 'k3') && requests.some(request => request.model === 'deepseek-flash'))
  console.log('claude source CLI: concurrent Kimi/DeepSeek, project/user/env override, SSE, resume, auth headers and cleanup passed')
} finally {
  for (const child of children) { child.kill('SIGKILL'); await once(child, 'close').catch(() => {}) }
  server.closeAllConnections(); trap.closeAllConnections()
  await Promise.all([new Promise(done => server.close(done)), new Promise(done => trap.close(done))])
  await rm(fixture, { recursive: true, force: true })
}
