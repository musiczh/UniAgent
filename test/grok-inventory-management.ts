import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGrokInventoryDetail, grokInventoryFromOptions, manageGrokInventory } from '../src/main/grokInventory.ts'
import { manageBetaCapabilityInventory } from '../src/main/betaCapabilityManagement.ts'
import type { GrokInventoryCommandRunner, GrokInventoryManageRequest } from '../src/main/grokInventory.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-grok-inventory-management-'))
const home=join(root,'home'),gh=join(home,'.grok'),cwd=join(root,'project'),skill=join(gh,'skills','review')
await mkdir(skill,{recursive:true});await mkdir(cwd,{recursive:true});await mkdir(join(gh,'agents'),{recursive:true})
await writeFile(join(skill,'SKILL.md'),'---\nname: review\ndescription: Review files\n---\nInspect the actual code.\n')
await writeFile(join(gh,'agents','reviewer.md'),'---\nname: reviewer\ndescription: Review agent\n---\nNative role body.\n')
const inspect:any={skills:[{name:'review',source:{type:'user',path:join(skill,'SKILL.md')}}],agents:[{name:'reviewer',source:{type:'user',path:join(gh,'agents','reviewer.md')}}],hooks:[],projectInstructions:[],plugins:[],mcpServers:[]}
const mcps:any[]=[{name:'native',scope:'user',enabled:true,command:'/usr/bin/true',args:[],env:{API_TOKEN:'SECRET_SENTINEL'}}]
const plugins:any[]=[];const mutations:string[][]=[]
const runner:GrokInventoryCommandRunner=async(_bin,args)=>{
 if(args.join(' ')==='inspect --json')return {stdout:JSON.stringify({...inspect,mcpServers:mcps.filter(m=>m.enabled!==false).map(m=>({name:m.name,transport:'stdio',source:{type:'configToml',path:join(gh,'config.toml')}}))})}
 if(args.join(' ')==='mcp list --json')return {stdout:JSON.stringify(mcps)}
 if(args.join(' ')==='plugin list --json')return {stdout:JSON.stringify(plugins)}
 mutations.push([...args])
 if(args[0]==='mcp'&&args[1]==='disable')mcps.find(m=>m.name===args[2]).enabled=false
 if(args[0]==='mcp'&&args[1]==='remove')mcps.splice(mcps.findIndex(m=>m.name===args[args.length-1]),1)
 return {stdout:'success'}
}
const options={cwd,env:{HOME:home,GROK_HOME:gh},runner}
try{
 let inventory=await grokInventoryFromOptions('grok',options)
 const native=inventory.items.find(i=>i.kind==='mcp'&&i.name==='native')!
 assert.equal(native.manageable,true,'only the authoritative native user MCP is manageable')
 assert.equal(inventory.writable,true)
 assert.equal(JSON.stringify(inventory).includes('SECRET_SENTINEL'),false)
 const casServer:any={name:'cas-native',scope:'user',enabled:true,transport:'stdio',command:'/usr/bin/false',args:[],env:{API_TOKEN:'CAS_SECRET_ORIGINAL'}}
 let casMutations=0
 const casRunner:GrokInventoryCommandRunner=async(_bin,args)=>{
  if(args.join(' ')==='inspect --json')return {stdout:JSON.stringify({skills:[],agents:[],hooks:[],projectInstructions:[],plugins:[],mcpServers:[{name:casServer.name,transport:casServer.transport,source:{type:'configToml'}}]})}
  if(args.join(' ')==='mcp list --json')return {stdout:JSON.stringify([casServer])}
  if(args.join(' ')==='plugin list --json')return {stdout:'[]'}
  casMutations++
  if(args[0]==='mcp'&&args[1]==='add'){
   const separator=args.indexOf('--')
   casServer.command=args[separator+1];casServer.args=args.slice(separator+2)
  }
  return {stdout:'success'}
 }
 const casOptions={home,cwd,env:{HOME:home,GROK_HOME:gh},grokBin:'grok',grokRunner:casRunner}
 const casScan=()=>grokInventoryFromOptions('grok',{cwd,env:casOptions.env,runner:casRunner})
 const casBefore=await casScan(),casEntry=casBefore.items.find(i=>i.kind==='mcp')!
 const casEdited=await manageBetaCapabilityInventory({agentId:'grok',action:'mcp-update',id:casEntry.id,expectedFingerprint:casEntry.fingerprint,transport:'stdio',command:'/usr/bin/true',args:[],env:'[redacted]'},casOptions)
 assert.notEqual(casEdited.items.find(i=>i.id===casEntry.id)?.fingerprint,casEntry.fingerprint,'a successful native command edit returns a new fingerprint')
 await assert.rejects(manageBetaCapabilityInventory({agentId:'grok',action:'mcp-disable',id:casEntry.id,expectedFingerprint:casEntry.fingerprint},casOptions),/capability_inventory_stale/)
 assert.equal(casMutations,1,'a stale fingerprint must reject before invoking any native mutation')
 casServer.headers={Authorization:'Bearer CAS_SECRET_HEADER_ORIGINAL'}
 for(const [key,value] of [['args',['CAS_SECRET_ARGUMENT']],['env',{API_TOKEN:'CAS_SECRET_ROTATED'}],['headers',{Authorization:'Bearer CAS_SECRET_HEADER'}]] as const){
  const before=await casScan(),entry=before.items.find(i=>i.id===casEntry.id)!
  casServer[key]=value
  const changed=await casScan()
  assert.notEqual(changed.items.find(i=>i.id===entry.id)?.fingerprint,entry.fingerprint,`changing native MCP ${key} invalidates its fingerprint`)
  assert.notEqual(changed.revision,before.revision,`changing native MCP ${key} invalidates the main-process revision`)
  await assert.rejects(manageBetaCapabilityInventory({agentId:'grok',action:'mcp-disable',id:entry.id,expectedFingerprint:entry.fingerprint},casOptions),/capability_inventory_stale/)
  await assert.rejects(manageGrokInventory('grok',{action:'mcp-disable',id:entry.id,expectedRevision:before.revision},{cwd,env:casOptions.env,runner:casRunner}),/grok_inventory_stale/)
  assert.equal(casMutations,1,`stale ${key} snapshots reject at both mutation boundaries`)
  assert.equal(JSON.stringify(changed).includes('CAS_SECRET'),false,'opaque fingerprints do not expose native configuration')
  const safeCasDetail=await getGrokInventoryDetail('grok',entry.id,{cwd,env:casOptions.env,runner:casRunner})
  assert.equal(safeCasDetail.manifestText?.includes('CAS_SECRET_ROTATED'),false)
  assert.equal(safeCasDetail.manifestText?.includes('CAS_SECRET_HEADER'),false)
 }
 mcps[0].command='node'
 assert.notEqual((await grokInventoryFromOptions('grok',options)).revision,inventory.revision,'changing MCP command invalidates an old edit')
 mcps[0].command='/usr/bin/true'
 const detail=await getGrokInventoryDetail('grok',inventory.items.find(i=>i.kind==='skill')!.id,options)
 assert.equal(detail.manifestText?.includes('Inspect the actual code.'),true)
 assert.equal(detail.manifestFile,'SKILL.md')
 assert.equal(detail.openable,true)
 const profile=await getGrokInventoryDetail('grok',inventory.items.find(i=>i.kind==='agent-profile')!.id,options)
 assert.equal(profile.manifestText?.includes('Native role body.'),true)
 assert.equal((await getGrokInventoryDetail('grok','grok:skill:invalid',options)).openable,false)
 await symlink(join(root,'outside.txt'),join(skill,'outside.txt'))
 await writeFile(join(root,'outside.txt'),'DO_NOT_READ')
 inspect.skills[0].source={type:'user',path:join(root,'outside.txt')}
 assert.equal((await getGrokInventoryDetail('grok',detail.id,options)).manifestText,undefined)
 inspect.skills[0].source={type:'user',path:join(skill,'SKILL.md')}
 inspect.skills[0].source={type:'user',path:join(skill,'outside.txt')}
 assert.equal((await getGrokInventoryDetail('grok',detail.id,options)).manifestText,undefined)
 inspect.skills[0].source={type:'user',path:join(skill,'SKILL.md')}
 const safeDetail=await getGrokInventoryDetail('grok',detail.id,options)
 assert.equal(safeDetail.files?.some(f=>f.relativePath==='outside.txt'),false)
 const mcpDetail=await getGrokInventoryDetail('grok',native.id,options)
 assert.equal(mcpDetail.manifestText?.includes('SECRET_SENTINEL'),false)
 assert.deepEqual(JSON.parse(mcpDetail.manifestText!),{transport:'stdio',enabled:true,command:'/usr/bin/true',args:[],env:'[redacted]'},'native MCP detail is one redacted editable configuration')
 await manageGrokInventory('grok',{action:'mcp-update',id:native.id,transport:'stdio',command:'[redacted]',args:'[redacted]',env:'[redacted]'} as unknown as GrokInventoryManageRequest,options)
 assert.deepEqual(mutations.pop(),['mcp','add','--scope','user','--transport','stdio','native','--env','API_TOKEN=SECRET_SENTINEL','--','/usr/bin/true'])
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-add',name:'redacted-new',transport:'stdio',command:'[redacted]'},options),/invalid/)
 const result=await manageGrokInventory('grok',{action:'mcp-disable',id:native.id,expectedRevision:inventory.revision},options)
 assert.deepEqual(mutations.pop(),['mcp','disable','native'])
 assert.notEqual(result.revision,inventory.revision)
 assert.equal(result.items.find(i=>i.id===native.id)?.manageable,true,'disabled native MCPs are omitted by inspect but remain manageable from mcp list user scope')
 await manageGrokInventory('grok',{action:'mcp-update',id:native.id,transport:'stdio',command:'node',args:['new']},options)
 assert.deepEqual(mutations.pop(),['mcp','disable','native'])
 assert.deepEqual(mutations.pop(),['mcp','add','--scope','user','--transport','stdio','native','--env','API_TOKEN=SECRET_SENTINEL','--','node','new'])
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-remove',id:native.id,expectedRevision:inventory.revision},options),/stale/)
 await manageGrokInventory('grok',{action:'mcp-add',name:'new-mcp',transport:'stdio',scope:'user',command:'node',args:['-e','console.log("ok")']},options)
 assert.deepEqual(mutations.pop(),['mcp','add','--scope','user','--transport','stdio','new-mcp','--','node','-e','console.log("ok")'])
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-add',name:'native',transport:'stdio',command:'node'},options),/already_exists/)
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-add',name:'--debug',transport:'stdio',command:'node'},options),/invalid/)
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-add',name:'new',transport:'http',url:'file:///secret'},options),/invalid/)
 mcps[0].oauth={provider:'example'}
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-update',id:native.id,transport:'stdio',command:'node'},options),/update_unsupported/)
 delete mcps[0].oauth
 mcps.push({name:'native',scope:'project',command:'/usr/bin/true'})
 inventory=await grokInventoryFromOptions('grok',options)
 assert.equal(inventory.items.find(i=>i.kind==='mcp'&&i.name==='native')?.manageable,false)
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-disable',id:native.id},options),/readonly|ambiguous/)
 mcps.splice(1,1)
 inspect.mcpServers.push({name:'compat',vendor:'claude',source:{type:'claude',path:join(home,'.claude.json')}})
 await writeFile(join(gh,'config.toml'),'[plugins]\nenabled=[]\ndisabled=["one"]\n')
 const pluginPath=join(gh,'installed-plugins','same-repo')
 await mkdir(pluginPath,{recursive:true})
 plugins.push({name:'one',repo_key:'same-repo',path:pluginPath,status:'installed'},{name:'two',repo_key:'same-repo',path:pluginPath,status:'installed'})
 inspect.plugins=plugins.map(p=>({...p,scope:'user',enabled:true,provides:{}}))
 inventory=await grokInventoryFromOptions('grok',options)
 const one=inventory.items.find(i=>i.kind==='plugin'&&i.name==='one')!
 assert.equal(one.source,'disabled','native user config overrides stale inspect plugin enabled flag')
 const compatPlugin=join(home,'.claude','plugins','one')
 await mkdir(compatPlugin,{recursive:true})
 inspect.plugins[0].path=compatPlugin
 assert.equal((await grokInventoryFromOptions('grok',options)).items.find(i=>i.id===one.id)?.manageable,false,'inspect user scope cannot authorize a compatible plugin from another native root')
 inspect.plugins[0].path=pluginPath
 const externalInstall=join(root,'external-plugin')
 await mkdir(externalInstall,{recursive:true})
 plugins[0].path=externalInstall;inspect.plugins[0].path=externalInstall
 assert.equal((await grokInventoryFromOptions('grok',options)).items.find(i=>i.id===one.id)?.manageable,false,'custom plugin paths are readonly even when reported installed')
 plugins[0].path=pluginPath;inspect.plugins[0].path=pluginPath
 const fullId='user/'+createHash('sha256').update(await realpath(pluginPath)).digest('hex').slice(0,8)+'/one'
 await writeFile(join(gh,'config.toml'),'[plugins]\nenabled=["one"]\ndisabled=["'+fullId+'"]\n')
 assert.equal((await grokInventoryFromOptions('grok',options)).items.find(i=>i.id===one.id)?.source,'disabled','a native full ID overrides stale inspect enabled state')
 await writeFile(join(gh,'config.toml'),'[plugins]\nenabled=["'+fullId+'"]\ndisabled=[]\n')
 inspect.plugins[0].enabled=false
 assert.equal((await grokInventoryFromOptions('grok',options)).items.find(i=>i.id===one.id)?.source,'enabled','a native full ID also enables its exact canonical plugin')
 inspect.plugins[0].enabled=true
 await writeFile(join(gh,'config.toml'),'[plugins]\nenabled=["one"]\ndisabled=["user/ffffffff/one"]\n')
 assert.equal((await grokInventoryFromOptions('grok',options)).items.find(i=>i.id===one.id)?.source,'enabled','a full ID for another installation must not match only by name')
 const linkedInstall=join(gh,'installed-plugins','linked')
 await symlink(externalInstall,linkedInstall)
 plugins[0].path=linkedInstall;inspect.plugins[0].path=linkedInstall
 assert.equal((await grokInventoryFromOptions('grok',options)).items.find(i=>i.id===one.id)?.manageable,false,'native installation paths cannot escape through symlinks')
 plugins[0].path=pluginPath;inspect.plugins[0].path=pluginPath
 plugins[0].status='available';inspect.plugins[0].scope='cli'
 assert.equal((await grokInventoryFromOptions('grok',options)).items.find(i=>i.name==='one')?.manageable,false)
 plugins[0].status='installed';inspect.plugins[0].scope='user'
 const pluginRevision=(await grokInventoryFromOptions('grok',options)).revision
 plugins[0].repo_key='replacement-repo'
 assert.notEqual((await grokInventoryFromOptions('grok',options)).revision,pluginRevision,'a replaced plugin install invalidates its previous revision')
 plugins[0].repo_key='same-repo'
 plugins[0].repo_key=null
 assert.equal((await grokInventoryFromOptions('grok',options)).items.find(i=>i.id===one.id)?.manageable,false,'redaction must not turn an invalid repo identity into a manageable plugin')
 plugins[0].repo_key='same-repo'
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-update',id:native.id,transport:'stdio',command:'node',env:null} as unknown as GrokInventoryManageRequest,options),/request_invalid/)
 await assert.rejects(manageGrokInventory('grok',{action:'mcp-add',name:'invalid-extra',transport:'stdio',command:'node',url:'https://example.com'} as GrokInventoryManageRequest,options),/request_invalid/)
 await assert.rejects(manageGrokInventory('grok',{action:'plugin-uninstall',id:one.id},options),/multi_plugin/)
 assert.equal(mutations.some(a=>a[0]==='plugin'&&a[1]==='uninstall'),false)
 await assert.rejects(manageGrokInventory('grok',{action:'plugin-update',id:one.id},options),/multi_plugin/)
 await manageGrokInventory('grok',{action:'plugin-disable',id:one.id},options)
 assert.deepEqual(mutations.pop(),['plugin','disable','one'])
 plugins.splice(1,1);inspect.plugins=inspect.plugins.slice(0,1)
 await manageGrokInventory('grok',{action:'plugin-uninstall',id:one.id},options)
 assert.deepEqual(mutations.pop(),['plugin','uninstall','one','--keep-data'])
 await assert.rejects(manageGrokInventory('grok',{action:'plugin-install',source:'--debug'},options),/invalid/)
 await manageGrokInventory('grok',{action:'plugin-install',source:'owner/repo@v1.0'},options)
 assert.deepEqual(mutations.pop(),['plugin','install','owner/repo@v1.0','--trust'])
}finally{await rm(root,{recursive:true,force:true})}
console.log('grok-inventory-management: ok')
