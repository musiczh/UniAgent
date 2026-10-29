const fs = require('node:fs')
const http = require('node:http')
if (process.argv.includes('--version')) { console.log('2.2.0'); process.exit(0) }

if (!process.argv.includes('web')) {
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const { id, method } = JSON.parse(line)
    fs.appendFileSync(process.env.FAKE_KIMI_LOG, JSON.stringify({ kind: 'acp-request', method }) + '\n')
    if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    else if (method === 'session/list') send({ id, result: { sessions: [{ sessionId: 'kimi-existing', cwd: process.cwd() }] } })
    else if (method === 'session/load') {
      // ACP 2.2 replays compacted context and discards each message's origin.
      for (const text of ['确认', 'INTERNAL COMPACTION SUMMARY', '<system-reminder>internal reminder</system-reminder>', '<notification>Background process completed</notification>']) {
        send({ method: 'session/update', params: { sessionId: 'kimi-existing', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } } })
      }
      send({ id, result: {} })
    } else send({ id, result: {} })
  })
} else {
  const fixture = JSON.parse(fs.readFileSync(process.env.KIMI_HISTORY_FIXTURE, 'utf8'))
  const log = value => fs.appendFileSync(process.env.FAKE_KIMI_LOG, JSON.stringify(value) + '\n')
  log({ kind: 'web-start', pid: process.pid })
  fs.writeFileSync(process.env.KIMI_CODE_HOME + '/server.token', 'history-fixture-token', { mode: 0o600 })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    log({ kind: 'web-request', method: req.method, path: url.pathname, before: url.searchParams.get('before_turn') })
    let data
    let code = 0
    if (req.headers.authorization !== 'Bearer history-fixture-token') code = 40101
    else if (req.method !== 'GET') code = 40001
    else if (url.pathname === '/api/v1/meta') data = { dangerous_bypass_auth: false, backend: 'v2', server_version: '2.2.0' }
    else if (url.pathname === '/openapi.json') return res.end(JSON.stringify({ paths: { '/api/v1/sessions/{session_id}/goal': {get:{}}, '/api/v1/sessions/{session_id}/profile': {post:{}}, '/api/v1/sessions/{session_id}/prompts': {post:{}}, '/api/v1/sessions/{session_id}/prompts/{tail}': {post:{}} } }))
    else if (url.pathname === '/asyncapi.json') return res.end(JSON.stringify({ asyncapi: '3.0.0' }))
    else if (url.pathname === '/api/v1/sessions') data = { items: [], has_more: false }
    else if (url.pathname === '/api/v1/sessions/kimi-existing') data = fixture.session
    else if (url.pathname === '/api/v1/sessions/kimi-existing/transcript') {
      const page = fixture.pages[url.searchParams.get('before_turn') || 'latest']
      if (page?.code) code = page.code
      else data = page
    } else code = 40401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code, data }))
  })
  server.listen(0, '127.0.0.1', () => process.stdout.write('Kimi server: http://127.0.0.1:' + server.address().port + '\n'))
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
