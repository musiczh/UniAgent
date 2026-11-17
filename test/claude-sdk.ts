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
let held, batch=[];
const result=(uuid,error=false)=>send({type:'result',subtype:error?'error_during_execution':'success',is_error:error,result:error?'':'ok',errors:error?['fixture model failed']:[],session_id:'sdk-session',uuid:'result-'+uuid,user_message_uuid:uuid,usage:{input_tokens:1,output_tokens:1}});
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
   const mode=value.message.content;
   if(mode==='release'){if(held){result(held);held=undefined;}return;}
   if(typeof mode==='string' && mode.startsWith('fallback-')){
     held=value.uuid;
     const frame=mode.slice(9);
     if(frame==='result'||frame==='error'){result(value.uuid,frame==='error');held=undefined;return;}
     if(frame==='user'){send({...value,session_id:'sdk-session'});return;}
     const row={type:frame,parent_tool_use_id:null,uuid:'response-id',session_id:'sdk-session',user_message_uuid:value.uuid,
       message:{role:'assistant',model:'fixture',content:[{type:'text',text:'still working'}]},event:{type:'message_start',message:{id:'response-id',role:'assistant',model:'fixture',content:[]}},estimated_tokens_delta:1};
     send(row);return;
   }
   if(mode==='batch'){
     batch.push(value.uuid);if(batch.length===2){send({type:'assistant',parent_tool_use_id:null,uuid:'batch-response',session_id:'sdk-session',user_message_uuid:batch[1],user_message_uuids:batch,message:{role:'assistant',model:'fixture',content:[{type:'text',text:'batch consumed'}]}});held=batch[1];batch=[];}return;
   }
   if(mode==='unconfirmed'){
     held=value.uuid;
     send({type:'assistant',parent_tool_use_id:'child-tool',uuid:'child',user_message_uuid:value.uuid,message:{content:[{type:'text',text:'child output'}]}});
     send({type:'assistant',parent_tool_use_id:null,uuid:'foreign',user_message_uuid:'other-input',message:{content:[{type:'text',text:'other turn'}]}});
     send({type:'assistant',parent_tool_use_id:null,uuid:'unlabelled',message:{content:[{type:'text',text:'unlabelled output'}]}});return;
   }
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

  let resultCount = 3
  for (const frame of ['user', 'stream_event', 'assistant', 'thinking_tokens', 'result', 'error']) {
    const uuid = 'fallback-' + frame
    const before = messages.length
    await client.request('send', { uuid, content: uuid, waitForReplay: true }, 250)
    assert.equal(messages.slice(before).some(message => message.isReplay === true), false, `${frame} must confirm delivery without replay`)
    if (frame !== 'result' && frame !== 'error') {
      assert.equal(messages.slice(before).some(message => message.type === 'result'), false, 'input acceptance must not wait for execution to finish')
      await new Promise(resolve => setTimeout(resolve, 300))
      await client.request('send', { uuid: 'release-' + frame, content: 'release' })
    }
    await waitResult(++resultCount)
    if (frame === 'error') {
      const result = messages.filter(message => message.type === 'result').at(-1)
      assert.equal(result.is_error, true, 'delivery acceptance must retain a native model failure')
      assert.deepEqual(result.errors, ['fixture model failed'])
    }
  }
  await Promise.all(['batch-first', 'batch-second'].map(uuid => client.request('send', { uuid, content: 'batch', waitForReplay: true }, 250)))
  await client.request('send', { uuid: 'release-batch', content: 'release' })
  await waitResult(++resultCount)
  await assert.rejects(client.request('send', { uuid: 'unconfirmed', content: 'unconfirmed', waitForReplay: true }, 100), /Claude SDK send 超时/,
    'child, foreign and unlabelled replies must not acknowledge an unrelated input')
  await client.request('send', { uuid: 'release-unconfirmed', content: 'release' })
  await waitResult(++resultCount)
  const finalWire = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const frame of ['user', 'stream_event', 'assistant', 'thinking_tokens', 'result', 'error']) {
    assert.equal(finalWire.filter(message => message.type === 'user' && message.uuid === 'fallback-' + frame).length, 1, 'fallback confirmation must not resubmit model input')
  }
  await client.close()
  await assert.rejects(client.request('models'), /关闭/)
  console.log('Claude SDK: handshake, persistent turns, replay, correlated fallback, batches, receipt isolation and approvals passed')
} finally {
  await client.close()
  await rm(directory, {recursive:true,force:true})
}
