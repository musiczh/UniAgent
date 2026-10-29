const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const mode = path.basename(process.env.DSH_HOME)
const failureFile = path.join(process.env.DSH_HOME, 'fixture-host-failure')
const failure = fs.existsSync(failureFile) ? fs.readFileSync(failureFile, 'utf8') : ''
if (mode === 'exit' || failure === 'exit') process.exit(3)
if (mode === 'timeout') { setInterval(() => {}, 1000); return }
const server = http.createServer(async (req, res) => {
  if (req.url === '/?token=fixture-token') {
    res.writeHead(303, { 'Set-Cookie': 'dsh=fixture-cookie; HttpOnly; SameSite=Strict', Location: '/' }); res.end(); return
  }
  if (req.headers.cookie !== 'dsh=fixture-cookie') { res.writeHead(401); res.end(); return }
  let raw = ''; for await (const chunk of req) raw += chunk
  const message = JSON.parse(raw)
  const correct = message.method === 'session/list' && message.payload.args._request || message.method === 'session/modelCatalog' || message.method === 'account/getState' || message.method === 'permissionPresets/catalog'
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId,
    result: correct ? { ok: true, value: mode === 'bad-baseline' ? {} : message.method === 'permissionPresets/catalog' ? { options: ['workspace-write', 'danger-full-access'].map(value => ({ value, name: value })) } : message.method === 'account/getState' ? { status: 'signed-out', attempt: null } : message.method === 'session/modelCatalog' ? { groups: process.env.DEEPSEEK_API_KEY && failure !== 'empty-catalog' ? [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', name: 'Flash' }] }] : [] } : { items: [] } }
      : { ok: false, error: { code: 'gateway/arguments-invalid', message: 'wrong request', details: {} } } }))
})
const ws = new WebSocketServer({ server, path: '/api/remote.mux' })
ws.on('connection', socket => socket.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.type === 'open') socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'baseline', value: { projections: {} } } }))
}))
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(process.env.DSH_HOME, 'fixture-process.json'), JSON.stringify({ pid: process.pid,
    keyInherited: !!process.env.CODEX_API_KEY, nodeOptionsInherited: !!process.env.NODE_OPTIONS,
    home: process.env.HOME, cwd: process.cwd(), args: process.argv.slice(2) }))
  // Split the token to make sure stdout chunk boundaries cannot truncate credentials.
  process.stdout.write(`dsh web: http://127.0.0.1:${server.address().port}/?token=fixture-`)
  setTimeout(() => process.stdout.write('token\n'), 20)
})
process.on('SIGTERM', () => { for (const socket of ws.clients) socket.terminate(); server.close(() => process.exit(0)) })
