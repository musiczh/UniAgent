import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, validateCompatibility, validateLegacyRefs, verifyDmg, verifyPublishedSite } from '../scripts/release-public.mjs'

const ids=['codex','claude','grok','kimi','deepseek','mcode','zcode','nika','traex']
const now=Date.parse('2026-10-29T08:00:00Z')
const report={sourceFingerprint:'fixture',checkedAt:new Date(now).toISOString(),agents:ids.map(id=>({id,status:'passed',beforeVersion:'1',latestVersion:'2',afterVersion:'2',latestSource:'https://example.com/versions',protocolSource:'https://example.com/protocol',checks:[{command:'isolated native protocol fixture',exitCode:0}]}))}
validateCompatibility(report,'fixture',true,now)
for(const change of [r=>r.sourceFingerprint='other',r=>r.checkedAt=new Date(now-86400001).toISOString(),r=>r.checkedAt=new Date(now+120000).toISOString(),r=>r.agents.pop(),r=>r.agents[0].afterVersion='1',r=>r.agents[1].checks[0].exitCode=1]) {
  const invalid=structuredClone(report);change(invalid)
  assert.throws(()=>validateCompatibility(invalid,'fixture',true,now),/compatibility/i)
}
validateCompatibility({...report,agents:report.agents.filter(agent=>!['nika','traex'].includes(agent.id))},'fixture',false,now)
assert.throws(()=>validateCompatibility({...report,agents:report.agents.filter(agent=>agent.id!=='nika')},'fixture',true,now),/incomplete: nika/)
validateLegacyRefs({'refs/heads/build-6a7ab81':'saved'},{'refs/heads/build-6a7ab81':'saved'})
validateLegacyRefs({}, {})
assert.throws(()=>validateLegacyRefs({'refs/tags/v1.0.1':'changed'},{'refs/tags/v1.0.1':'saved'}),/changed since backup/)

const webpage='<html>reviewed website</html>',manifest={version:'1.1.0',sha256:'fixture'}
let requests=0,waits=0
await verifyPublishedSite({webSha256:sha256(webpage),manifest},async url=>{
  requests++
  return new Response(url.endsWith('latest.json')?JSON.stringify(manifest):requests<3?'stale website':webpage)
},async()=>{waits++})
assert.equal(waits,1,'publication waits until both live documents match the approved payload')
await assert.rejects(verifyPublishedSite({webSha256:sha256(webpage),manifest},async()=>new Response('missing',{status:404}),async()=>{}),/has not served/)

const root=await mkdtemp(join(tmpdir(),'ua-public-dmg-'))
try {
  const source=join(root,'source'),app=join(source,'release/mac-arm64/UniAgent Public.app'),dmg=join(source,'release/UniAgent-Public-1.1.0-arm64.dmg')
  await mkdir(join(app,'Contents/Resources'),{recursive:true})
  await writeFile(join(app,'Contents/Resources/app.asar'),'current app')
  await writeFile(dmg,'disk image fixture')
  const metadata={version:'1.1.0',size:(await readFile(dmg)).length,sha256:sha256(await readFile(dmg))}
  const calls=[]
  // Populate the mount before the synchronous command boundary, as hdiutil does.
  const command=(name,args)=>{
    calls.push([name,args])
    if(name==='lipo')return 'arm64'
    if(name==='plutil')return ({CFBundleShortVersionString:'1.1.0',CFBundleIdentifier:'com.uniagent.public',CFBundleName:'UniAgent Public',CFBundleExecutable:'UniAgent Public'})[args[1]]
    return ''
  }
  await assert.rejects(verifyDmg(source,{...metadata,sha256:'0'.repeat(64)},command),/checksum/)
  assert.equal(calls.length,0,'bad checksums must fail before executing any platform commands')
  await assert.rejects(verifyDmg(source,metadata,(name,args)=>name==='lipo'?'x86_64':command(name,args)),/only arm64/)
  await assert.rejects(verifyDmg(source,metadata,(name,args)=>name==='plutil'?'1.0.0':command(name,args)),/version mismatch/)
  for(const field of ['CFBundleIdentifier','CFBundleName','CFBundleExecutable']) {
    await assert.rejects(verifyDmg(source,metadata,(name,args)=>name==='plutil'&&args[1]===field?'UniAgent':command(name,args)),/identity mismatch/)
  }
} finally {await rm(root,{recursive:true,force:true})}
console.log('Public release: source-bound compatibility, legacy ref protection, live Pages convergence and DMG rejection gates passed')
