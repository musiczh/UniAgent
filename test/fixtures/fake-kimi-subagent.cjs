const fs = require('node:fs')
const http = require('node:http')

if (process.argv.includes('--version')) {
  console.log('2.2.0')
  process.exit(0)
}
if (!process.argv.includes('web')) {
  console.error('fake kimi subagent fixture only serves the web API')
  process.exit(2)
}

const home = process.env.KIMI_CODE_HOME
const logPath = process.env.FAKE_KIMI_SUBAGENT_LOG
const scenario = JSON.parse(process.env.FAKE_KIMI_SUBAGENT_SCENARIO || '{}')
const log = (value) => {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\n')
}
fs.writeFileSync(home + '/server.token', 'subagent-fixture-token', { mode: 0o600 })

const sessionId = scenario.sessionId || 'native-parent'
const tasks = scenario.tasks || [{
  id: 'task-1',
  session_id: sessionId,
  kind: 'subagent',
  agent_id: 'child-1',
  status: 'completed',
  description: 'Inspect the repository'
}]
const turns = scenario.turns || [{
  kind: 'turn',
  turnId: 't1',
  origin: { kind: 'user' },
  prompt: 'Inspect the repository',
  state: 'completed',
  startedAt: new Date(1_790_000_000_000).toISOString(),
  endedAt: new Date(1_790_000_012_000).toISOString(),
  steps: [{
    stepId: 't1.1',
    state: 'completed',
    startedAt: new Date(1_790_000_001_000).toISOString(),
    endedAt: new Date(1_790_000_011_000).toISOString(),
    frames: [
      { kind: 'thinking', frameId: 't1.1.f0', text: 'Checking the workspace layout' },
      { kind: 'tool', frameId: 't1.1.f1', toolCallId: 'call-child-1', name: 'Read', state: 'done', input: { path: '/workspace/README.md' }, output: 'README CONTENTS' },
      { kind: 'text', role: 'assistant', frameId: 't1.1.f2', text: 'The child read the README.' }
    ]
  }]
}]

const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  log({ method: req.method, path: url.pathname, agentId: url.searchParams.get('agent_id') })
  if (req.headers.authorization !== 'Bearer subagent-fixture-token') return send(res, 401, { code: 40101, data: null })
  if (req.method !== 'GET') return send(res, 200, { code: 40001, data: null })
  if (url.pathname === '/api/v1/meta') {
    return send(res, 200, { code: 0, data: { dangerous_bypass_auth: false, backend: 'v2', server_version: '2.2.0' } })
  }
  if (url.pathname === '/openapi.json') {
    return send(res, 200, { paths: {
      '/api/v1/sessions/{session_id}/goal': { get: {} },
      '/api/v1/sessions/{session_id}/profile': { post: {} },
      '/api/v1/sessions/{session_id}/prompts': { post: {} },
      '/api/v1/sessions/{session_id}/prompts/{tail}': { post: {} }
    } })
  }
  if (url.pathname === '/asyncapi.json') return send(res, 200, { asyncapi: '3.0.0' })
  if (url.pathname === '/api/v1/sessions') return send(res, 200, { code: 0, data: { items: [], has_more: false } })
  if (url.pathname === `/api/v1/sessions/${sessionId}/tasks`) return send(res, 200, { code: 0, data: { items: tasks } })
  if (url.pathname === `/api/v1/sessions/${sessionId}/transcript`) {
    const agentId = url.searchParams.get('agent_id') || ''
    return send(res, 200, { code: 0, data: { agent_id: agentId, items: turns, has_more: false, meta: {} } })
  }
  return send(res, 404, { code: 40401, data: null })
})
server.listen(0, '127.0.0.1', () => process.stdout.write('Kimi server: http://127.0.0.1:' + server.address().port + '\n'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
