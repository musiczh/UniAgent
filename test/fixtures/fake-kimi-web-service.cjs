const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const home = process.env.KIMI_CODE_HOME
const file = name => path.join(home, name)
const read = name => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) } catch { return {} } }
const save = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value))
const boots = [...(read('boots.json').items || []), process.pid]
save('boots.json', { items: boots })
if (read('control.json').failStart && boots.length > 1) process.exit(19)
if (read('control.json').spawnChild) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' })
  save('child.json', { pid: child.pid })
}
fs.mkdirSync(file('server/instances'), { recursive: true })
fs.writeFileSync(file('server.token'), 'fixture-token', { mode: 0o600 })
const paths = {
  '/api/v1/sessions/{session_id}/goal': { get: {} }, '/api/v1/sessions/{session_id}/profile': { post: {} },
  '/api/v1/sessions/{session_id}/prompts': { post: {} }, '/api/v1/sessions/{session_id}/prompts/{tail}': { post: {} }
}
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); return res.end() }
  const control = read('control.json')
  if (req.url === '/test/slow') return
  if (req.url === '/test/unauthorized') { res.writeHead(401); return res.end() }
  let text = ''; for await (const chunk of req) text += chunk
  const body = text ? JSON.parse(text) : undefined
  let data = {}
  if (req.url === '/api/v1/meta') data = { server_version: '2.3.0', backend: 'v2', dangerous_bypass_auth: false, pid: process.pid }
  else if (req.url === '/openapi.json') return res.end(JSON.stringify({ paths }))
  else if (req.url === '/asyncapi.json') return res.end(JSON.stringify({ asyncapi: '3.0.0' }))
  else if (req.url === '/api/v1/auth') data = { models_ready: true }
  else if (req.url === '/api/v1/models') data = { items: [{ model: 'local' }] }
  else if (req.url === '/api/v1/config') data = { default_model: 'local' }
  else if (req.url === '/api/v1/sessions?busy=true&page_size=100') data = { items: [{ id: 'native-session' }], has_more: false }
  else if (req.url === '/api/v1/sessions' && req.method === 'POST') {
    const state = read('session.json'); save('session.json', { ...state, created: (state.created || 0) + 1 }); data = { id: 'native-session' }
  } else if (req.url.endsWith('/status')) data = { busy: false, model: 'local', permission: 'manual', plan_mode: false, swarm_mode: false }
  else if (req.url.endsWith('/profile') || req.url.endsWith('/runtime')) data = { id: 'native-session' }
  else if (req.url.endsWith('/snapshot')) data = { as_of_seq: 1, epoch: 'saved', session: { id: 'native-session', marker: read('session.json').marker }, pending_approvals: [], pending_questions: [], in_flight_turn: null }
  else if (req.url.endsWith('/prompts') && req.method === 'POST') {
    const state = read('session.json'); save('session.json', { ...state, prompts: (state.prompts || 0) + 1, prompt: body })
    if (control.stopAfterPrompt) process.kill(process.pid, 'SIGSTOP')
    data = { prompt_id: body.prompt_id, status: 'running' }
  }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data }))
})
const wss = new WebSocketServer({ server })
wss.on('connection', socket => socket.send(JSON.stringify({ type: 'server_hello', payload: { protocol_version: 2 } })))
server.listen(0, '127.0.0.1', () => {
  save('server/instances/fixture-' + process.pid + '.json', { server_id: 'fixture-' + process.pid, pid: process.pid, host: '127.0.0.1', port: server.address().port })
  console.log('Kimi server: http://127.0.0.1:' + server.address().port + '/')
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
