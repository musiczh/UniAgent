import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findGithubRelease, run, sha256, validateCompatibility, validateCompatibilityBaseline, promoteCompatibility, validateLegacyRefs, verifyDmg, verifyPublishedSite } from '../scripts/release-public.mjs'
import { exportPublic } from '../scripts/export-public.mjs'

const traceEnvironment=Object.fromEntries(['GIT_CURL_VERBOSE','GIT_TRACE_CURL'].map(key=>[key,process.env[key]]))
try {
  process.env.GIT_CURL_VERBOSE='1';process.env.GIT_TRACE_CURL='1'
  assert.deepEqual(JSON.parse(run(process.execPath,['-e','console.log(JSON.stringify([process.env.GIT_CURL_VERBOSE??null,process.env.GIT_TRACE_CURL??null]))'],{capture:true})),[null,null],
    'release subprocesses must not inherit HTTP credential tracing')
} finally {
  for(const [key,value] of Object.entries(traceEnvironment))if(value===undefined)delete process.env[key];else process.env[key]=value
}

const draft={id:42,tag_name:'v1.1.0',draft:true,assets:[]}
const draftRequests=[]
assert.deepEqual(findGithubRelease('v1.1.0',(command,args)=>{
  assert.equal(command,'gh');draftRequests.push(args)
  if(args.some(arg=>arg.includes('/releases/tags/')))throw new Error('gh: Not Found (HTTP 404)')
  assert(args.includes('--paginate'));assert(args.includes('--slurp'))
  return JSON.stringify([[{...draft,id:41,tag_name:'v1.0.1'}],[draft]])
}),draft,'resume must find an existing draft even though the published-tag endpoint returns 404')
assert.equal(draftRequests.length,2)
let publishedRequests=0
assert.deepEqual(findGithubRelease('v1.1.0',()=>{publishedRequests++;return JSON.stringify({...draft,draft:false})}),{...draft,draft:false})
assert.equal(publishedRequests,1,'published releases do not require a list request')
assert.equal(findGithubRelease('v1.2.0',(_command,args)=>{
  if(args.some(arg=>arg.includes('/releases/tags/')))throw new Error('HTTP 404')
  return JSON.stringify([[draft]])
}),undefined,'another tag must not be reused for a new release')
let deniedRequests=0
assert.throws(()=>findGithubRelease('v1.1.0',()=>{deniedRequests++;throw new Error('HTTP 403')}),/403/)
assert.equal(deniedRequests,1,'authentication failures must stop instead of creating a duplicate draft')

const ids=['codex','claude','grok','kimi','deepseek','mcode','zcode','qoder','nika','traex']
const now=Date.parse('2026-10-29T08:00:00Z')
const report={sourceFingerprint:'fixture',checkedAt:new Date(now).toISOString(),agents:ids.map(id=>({id,status:'passed',beforeVersion:'1',latestVersion:'2',afterVersion:'2',latestSource:'https://example.com/versions',protocolSource:'https://example.com/protocol',checks:[{command:'isolated native protocol fixture',exitCode:0}]}))}
validateCompatibility(report,'fixture',true,now)
for(const change of [r=>r.sourceFingerprint='other',r=>r.checkedAt=new Date(now-86400001).toISOString(),r=>r.checkedAt=new Date(now+120000).toISOString(),r=>r.agents.pop(),r=>r.agents[0].afterVersion='1',r=>r.agents[1].checks[0].exitCode=1]) {
  const invalid=structuredClone(report);change(invalid)
  assert.throws(()=>validateCompatibility(invalid,'fixture',true,now),/compatibility/i)
}
validateCompatibility({...report,agents:report.agents.filter(agent=>!['nika','traex'].includes(agent.id))},'fixture',false,now)
assert.throws(()=>validateCompatibility({...report,agents:report.agents.filter(agent=>agent.id!=='nika')},'fixture',true,now),/incomplete: nika/)
assert.throws(()=>validateCompatibility({...report,agents:report.agents.filter(agent=>agent.id!=='qoder')},'fixture',true,now),/incomplete: qoder/)
const baselineRoot=await mkdtemp(join(tmpdir(),'ua-agent-baseline-'))
try {
  const file=join(baselineRoot,'agentCompatibility.json'),original={deepseek:['0.2.2-rc.1'],grok:['1.0.62','1.0.77']}
  await writeFile(file,JSON.stringify(original))
  const current=structuredClone(report)
  for(const agent of current.agents)agent.afterVersion=agent.latestVersion=agent.id==='deepseek'?'0.2.2-rc.4':agent.id==='grok'?'1.0.88':'2.0.0'
  assert.throws(()=>validateCompatibilityBaseline(current,original),/baseline.*deepseek/)
  for(const change of [r=>r.sourceFingerprint='other',r=>r.checkedAt=new Date(now-86400001).toISOString(),r=>r.agents.pop(),r=>r.agents[0].checks[0].exitCode=1,r=>r.agents[4].afterVersion='old',r=>r.agents[1].protocolSource='']) {
    const invalid=structuredClone(current);change(invalid)
    await assert.rejects(promoteCompatibility(invalid,'fixture',file,{now}),/compatibility/i)
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),original,'failed qualification never changes the recorded baseline')
  }
  const malformed=structuredClone(current);malformed.agents.find(a=>a.id==='grok').afterVersion=malformed.agents.find(a=>a.id==='grok').latestVersion='unknown'
  await assert.rejects(promoteCompatibility(malformed,'fixture',file,{now}),/Invalid tested Agent version/)
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),original,'all updates are validated before any write')
  assert.deepEqual(await promoteCompatibility(current,'fixture',file,{now}),['deepseek','grok'])
  const updated=JSON.parse(await readFile(file,'utf8'))
  assert.deepEqual(updated,{deepseek:['0.2.2-rc.1','0.2.2-rc.4'],grok:['1.0.62','1.0.77','1.0.88']})
  validateCompatibilityBaseline(current,updated)
  const saved=await readFile(file,'utf8')
  assert.deepEqual(await promoteCompatibility(current,'fixture',file,{now}),[])
  assert.equal(await readFile(file,'utf8'),saved,'repeat synchronization is a no-op')
  assert.throws(()=>validateCompatibilityBaseline(current,{grok:[]}),/baseline/)
} finally {await rm(baselineRoot,{recursive:true,force:true})}
const syncRoot=await mkdtemp(join(tmpdir(),'ua-agent-sync-cli-'))
try {
  const source=join(syncRoot,'source'),state=join(source,'.git/uniagent-public-release-state/v9.9.9')
  await mkdir(join(source,'scripts'),{recursive:true});await mkdir(join(source,'src/shared'),{recursive:true})
  for(const file of ['release-public.mjs','export-public.mjs','public-website.mjs'])await cp(new URL('../scripts/'+file,import.meta.url),join(source,'scripts',file))
  await symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),join(source,'node_modules'),'dir')
  await writeFile(join(source,'.gitignore'),'node_modules/\n')
  await writeFile(join(source,'package.json'),JSON.stringify({version:'1.0.0',keywords:[],scripts:{},build:{}}))
  await writeFile(join(source,'src/shared/distribution.ts'),'export const INTERNAL_DISTRIBUTION = true\n')
  const baseline=join(source,'src/shared/agentCompatibility.json')
  await writeFile(baseline,JSON.stringify({deepseek:['0.2.2-rc.1'],grok:['1.0.77']}))
  const git=args=>execFileSync('git',args,{cwd:source,encoding:'utf8',stdio:'pipe'})
  git(['init','--initial-branch=master']);git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@example.com','commit','-m','fixture'])
  const fingerprint=async name=>(await exportPublic({sourceRoot:source,destination:join(syncRoot,name),version:'9.9.9'})).fingerprint
  const tested=structuredClone(report);tested.checkedAt=new Date().toISOString();tested.sourceFingerprint=await fingerprint('export-before')
  for(const agent of tested.agents)agent.afterVersion=agent.latestVersion=agent.id==='deepseek'?'0.3.0':agent.id==='grok'?'1.0.78':'2.0.0'
  await mkdir(state,{recursive:true});await writeFile(join(state,'compatibility.json'),JSON.stringify(tested))
  const cli=()=>execFileSync(process.execPath,['scripts/release-public.mjs','--sync-compatibility','--version','9.9.9'],{cwd:source,encoding:'utf8',stdio:'pipe'})
  assert.deepEqual(JSON.parse(cli()).changed,['deepseek','grok'],'the actual CLI verifies the committed source and promotes its tested versions')
  assert.throws(cli,/Commit source changes/,'synchronization cannot overwrite uncommitted source changes')
  git(['add','src/shared/agentCompatibility.json']);git(['-c','user.name=fixture','-c','user.email=fixture@example.com','commit','-m','tested baselines'])
  const saved=await readFile(baseline,'utf8')
  assert.throws(cli,/compatibility report/,'the old report becomes invalid when the baseline changes the source fingerprint')
  tested.sourceFingerprint=await fingerprint('export-final');await writeFile(join(state,'compatibility.json'),JSON.stringify(tested))
  assert.deepEqual(JSON.parse(cli()).changed,[],'a final-source report supports an idempotent repeat')
  assert.equal(await readFile(baseline,'utf8'),saved)
} finally {await rm(syncRoot,{recursive:true,force:true})}
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
