import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ClaudeSdkClient, claudeSdkLaunch } from '../src/main/claudeSdk'

const directory = await mkdtemp(join(tmpdir(), 'ua-sdk-contract-'))
const bin = join(directory, 'claude.cjs')
const log = join(directory, 'wire.jsonl')
await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const value=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
 if(value.type==='control_request') {
   const request=value.request;
   send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:
     request.subtype==='initialize'?{commands:[],models:[{value:'fixture',displayName:'Fixture'}],hooks_applied:true}:
     request.subtype==='mcp_status'?{mcpServers:[]}:
     request.subtype==='get_context_usage'?{totalTokens:42}: {}}});
 }
 if(value.type==='user') {
   send({type:'system',subtype:'init',session_id:'sdk-session',model:'fixture',tools:[],mcp_servers:[],slash_commands:[],permissionMode:'default'});
   send({...value,isReplay:true,session_id:'sdk-session'});
   if(value.message.content==='approval')send({type:'control_request',request_id:'approve-read',request:{subtype:'can_use_tool',tool_name:'Read',input:{file_path:'/fixture'}}});
   else send({type:'result',subtype:'success',is_error:false,result:'ok',session_id:'sdk-session',uuid:'result-'+value.uuid,usage:{input_tokens:1,output_tokens:1}});
 }
 if(value.type==='control_response' && value.response.request_id==='approve-read')send({type:'result',subtype:'success',is_error:false,result:value.response.response.behavior,session_id:'sdk-session',uuid:'approval-result',usage:{input_tokens:1,output_tokens:1}});
});
`, { mode: 0o700 })

const launch = claudeSdkLaunch(bin, directory, ['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--permission-mode','manual'], { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory,'.claude') })
assert.equal(launch.options.permissionMode, 'default')
assert.equal(launch.options.pathToClaudeCodeExecutable, bin)
const client = new ClaudeSdkClient(launch)
const messages: any[] = []
client.on('message', message => messages.push(message))
const waitResult = async (count: number) => {
  const end = Date.now() + 5000
  while (messages.filter(message => message.type === 'result').length < count) {
    assert.ok(Date.now() < end, 'SDK must deliver every result')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
try {
  assert.equal((await client.ready).hooks_applied, true)
  assert.equal((await client.request('models'))[0].value, 'fixture')
  assert.deepEqual(await client.request('context'), { totalTokens: 42 })
  await client.request('send', { uuid:'first', content:'first', waitForReplay:true })
  await waitResult(1)
  await client.request('send', { uuid:'second', content:'second', waitForReplay:true })
  await waitResult(2)
  const approval = once(client, 'approval')
  await client.request('send', { uuid:'third', content:'approval' })
  const [request] = await approval
  assert.equal(request.toolName, 'Read')
  client.respond(request.requestId, { behavior:'deny', message:'fixture denied' })
  await waitResult(3)
  assert.equal(messages.filter(message => message.type==='result').at(-1).result, 'deny')
  assert.deepEqual(await client.request('mcp'), { mcpServers:[] })
  const wire = (await readFile(log,'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(wire.filter(value=>value.type==='control_request' && value.request.subtype==='initialize').length, 1, 'multiple turns reuse the same initialized SDK process')
  assert.equal(wire.filter(value=>value.type==='user').length, 3)
  await client.close()
  await assert.rejects(client.request('models'), /关闭/)
  console.log('Claude SDK: official SDK handshake, persistent turns, typed controls, replay and approvals passed')
} finally {
  await client.close()
  await rm(directory, {recursive:true,force:true})
}
