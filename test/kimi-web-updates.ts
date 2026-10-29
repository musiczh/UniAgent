import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { probeKimiWeb } from '../src/main/kimiWebContract.ts'
import { KimiWebServer } from '../src/main/kimiWebServer.ts'
import { KimiWebError } from '../src/main/kimiWebTransport.ts'

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'uniagent-kimi-update-probe-'))
try {
  for (const [name, options, expected, reason] of [
    ['compatible new version', { version: '2.3.0' }, 'ready'],
    ['compatible future major', { version: '3.0.0' }, 'ready'],
    ['configuration needed', { version: '2.3.0', auth: false }, 'needs-config'],
    ['invalid version', { version: 'not-a-version' }, 'incompatible', 'version_unsupported'],
    ['missing API', { version: '2.3.0', missingApi: true }, 'incompatible', 'official_api_unsupported'],
    ['invalid events spec', { version: '2.3.0', invalidEvents: true }, 'incompatible', 'official_events_unsupported'],
    ['changed WS protocol', { version: '2.3.0', protocol: 3 }, 'incompatible', 'protocol_version'],
    ['unauthenticated server', { version: '2.3.0', bypassAuth: true }, 'incompatible', 'server_identity_invalid']
  ] as const) {
    const home = join(root, name); await mkdir(home)
    const bin = join(home, 'kimi')
    await writeFile(bin, `#!${process.execPath}
const options = ${JSON.stringify(options)};
if(process.argv.includes('--version')) { console.log(options.version); process.exit(0); }
const fs = require('node:fs'), http = require('node:http');
const { WebSocketServer } = require(${JSON.stringify(require.resolve('ws'))});
fs.writeFileSync(process.env.KIMI_CODE_HOME + '/server.token', 'fixture-token', {mode: 0o600});
const server = http.createServer((req,res) => {
 if(req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); return res.end(); }
 let data = {};
 if(req.url === '/api/v1/meta') data = {dangerous_bypass_auth:!!options.bypassAuth,backend:'v2',server_version:options.version};
 else if(req.url === '/openapi.json') return res.end(JSON.stringify({paths: options.missingApi ? {} : {
 '/api/v1/sessions/{session_id}/goal':{get:{}},'/api/v1/sessions/{session_id}/profile':{post:{}},
 '/api/v1/sessions/{session_id}/prompts':{post:{}},'/api/v1/sessions/{session_id}/prompts/{tail}':{post:{}}}}));
 else if(req.url === '/asyncapi.json') return res.end(JSON.stringify({asyncapi: options.invalidEvents ? 3 : '3.0.0'}));
 else if(req.url === '/api/v1/auth') data = {models_ready:options.auth !== false};
 else if(req.url === '/api/v1/models') data = {items:[{model:'alphabetically-first',capabilities:[]},{model:'local',capabilities:[]}]};
 else if(req.url === '/api/v1/config') data = {default_model:'local'};
 else if(req.url === '/api/v1/sessions?busy=true&page_size=100') data = {items:[],has_more:false};
 else { res.writeHead(404); return res.end(); }
 res.end(JSON.stringify({code:0,data}));
});
const wss = new WebSocketServer({server});
wss.on('connection', socket => socket.send(JSON.stringify({type:'server_hello',payload:{protocol_version:options.protocol ?? 2}})));
server.listen(0,'127.0.0.1',() => console.log('Kimi server: http://127.0.0.1:' + server.address().port + '/'));
`, { mode: 0o700 })
    const result = await probeKimiWeb(bin, home, { HOME: home, KIMI_CODE_HOME: home })
    assert.equal(result.status, expected, name + ': ' + result.reason)
    if (expected === 'ready') {
      assert.deepEqual(result.contract?.models.map(model => model.id), ['alphabetically-first', 'local'], name + ': only concrete models are exposed')
      assert.equal(result.contract?.currentModelId, 'local', name + ': the native default is read from configuration instead of catalog order')
    }
    if (expected !== 'incompatible') assert.equal(result.version, options.version, name)
    if (reason) assert.ok(result.reason?.includes(reason), name + ': ' + result.reason)
  }
  const home = join(root, 'compatible new version')
  const bin = join(home, 'kimi')
  const close = KimiWebServer.prototype.closeAndWait
  KimiWebServer.prototype.closeAndWait = async function () {
    await close.call(this)
    throw new KimiWebError('shutdown_inspection')
  }
  try {
    await assert.rejects(probeKimiWeb(bin, home, { HOME: home, KIMI_CODE_HOME: home }), /shutdown_inspection/)
  } finally { KimiWebServer.prototype.closeAndWait = close }
  assert.equal((await probeKimiWeb(bin, home, { HOME: home, KIMI_CODE_HOME: home })).status, 'ready',
    'a failed cleanup lease must not poison later probes for the same executable and home')
} finally { await rm(root, { recursive: true, force: true }) }
console.log('Kimi update protocol gate: actual versions, authentication, API and WebSocket compatibility passed')
