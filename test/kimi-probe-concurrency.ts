import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokACPRunner, probeKimiACP } from '../src/main/grokACPRunner.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-kimi-probe-concurrency-'))
const bin = join(root, 'kimi')
const pending: ServerResponse[] = [], created: string[] = [], deleted: string[] = []
let firstNew!: () => void, secondNew!: () => void
const firstArrival = new Promise<void>(resolve => { firstNew = resolve })
const secondArrival = new Promise<void>(resolve => { secondNew = resolve })
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/new') {
    created.push(url.searchParams.get('id')!); pending.push(res)
    if (created.length === 1) firstNew(); if (created.length === 2) secondNew()
  } else { deleted.push(url.searchParams.get('id')!); res.end('ok') }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
await writeFile(bin, `#!${process.execPath}
const readline = require('node:readline');
if(process.argv.includes('--version')) { process.stdout.write('2.0.2\\n'); process.exit(0); }
const respond=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const response={configOptions:[],modes:{currentModeId:'default',availableModes:[{id:'default'}]}};
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const {id,method,params={}}=JSON.parse(line);
 if(method==='initialize') return respond(id,{protocolVersion:1,agentInfo:{name:'kimi',version:'2.0.2'},agentCapabilities:{sessionCapabilities:{resume:{},delete:{}}}});
 if(method==='session/new') {const sessionId='session_probe_'+process.pid; await fetch(${JSON.stringify(origin)}+'/new?id='+sessionId); return respond(id,{...response,sessionId});}
 if(method==='session/resume') return respond(id,{...response,sessionId:params.sessionId});
 if(method==='session/delete') await fetch(${JSON.stringify(origin)}+'/delete?id='+params.sessionId);
 return respond(id,{});
});
`, { mode: 0o700 })
const env = { HOME: root, KIMI_CODE_HOME: join(root, 'home'), UNIAGENT_USER_DATA: join(root, 'userdata') }
const release = () => { for (const response of pending.splice(0)) response.end('ok') }
let first: ReturnType<typeof probeKimiACP> | undefined, second: ReturnType<typeof probeKimiACP> | undefined
let timeout: ReturnType<typeof setTimeout> | undefined
try {
  first = probeKimiACP(bin, root, env)
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('probe concurrency fixture did not reach session/new')), 5000) })
  await Promise.race([firstArrival, deadline])
  second = probeKimiACP(bin, root, env)
  // Both new-session requests must coexist. Before the fix, the second probe
  // settles incompatible while the first still holds its pre-session lease.
  await Promise.race([secondArrival, second.then(() => {}), deadline])
  release()
  const results = await Promise.all([first, second])
  assert.deepEqual(results.map(result => result.status), ['ready', 'ready'], JSON.stringify(results))
  assert.equal(new Set(created).size, 2)
  assert.deepEqual([...deleted].sort(), [...created].sort(), 'each probe must delete only its own created native session')
  const agent: any = { id: 'kimi', name: 'Kimi', adapter: 'kimi', bin, capabilities: {}, models: [] }
  const owner = new GrokACPRunner('probe-owner-a', { n: 0 }, agent, { agentId: 'kimi', workdir: root }, 'same-native-session', env)
  const contender = new GrokACPRunner('probe-owner-b', { n: 0 }, agent, { agentId: 'kimi', workdir: root }, 'same-native-session', env)
  try {
    await owner.probeSession(false)
    await assert.rejects(contender.probeSession(false), /kimi_runtime_already_owned/)
  } finally { await contender.disposeAndWait(); await owner.disposeAndWait() }
} finally {
  if (timeout) clearTimeout(timeout)
  release()
  await Promise.allSettled([first, second])
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
console.log('Kimi probe concurrency: independent probes coexist, clean up exact native IDs and preserve single-writer sessions')
