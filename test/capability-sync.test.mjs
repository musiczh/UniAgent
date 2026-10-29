import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { buildPlan, diffInventories, semanticHash } from '../src/main/capability-sync/planner.ts'
import { assertSafeDestination, discoverProvider, parseMcpBlocks } from '../src/main/capability-sync/provider.ts'
import { CapabilitySyncService, CapabilitySyncSimulatedCrash, mergeMarkdown } from '../src/main/capability-sync/service.ts'
import { compareCapabilitySyncJobs } from '../src/renderer/capabilitySyncJobOrder.ts'
import { listCapabilityInventories, managedInventoryId } from '../src/main/capability-sync/inventory.ts'
import { removeAgentToolSkill } from '../src/main/agentToolInventory.ts'

let passed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`✓ ${name}`) } catch (e) { console.error(`✗ ${name}`, e); process.exitCode = 1 } }
const cap = (id, hash, kind = 'skill') => ({ id: `${kind}:${id}`, kind, name: id, owner: 'user', fingerprint: hash, compatible: true, privateRef: `/private/${id}` })
const terminal = new Set(['completed','failed_no_change','rolled_back','rollback_failed','cancelled'])
const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
async function waitForTerminal(svc, id, timeout = 5000) { const end=Date.now()+timeout; while(Date.now()<end){ const job=svc.getJob(id); if(job&&terminal.has(job.state)) return job; await pause() } throw new Error('job_timeout') }
async function waitFor(fn, timeout = 5000) { const end=Date.now()+timeout; while(Date.now()<end){ const value=await fn(); if(value) return value; await pause() } throw new Error('condition_timeout') }
async function waitForOperationUnlock(dataRoot) { await waitFor(() => !existsSync(join(dataRoot,'operation.lock'))) }
const executeRequest = plan => ({planId:plan.id,expectedSourceRevision:plan.sourceRevision,expectedTargetRevision:plan.targetRevision})
const emptyPluginRunner = async (bin, args) => ({ stdout: bin === 'traecli'
  ? args.includes('marketplace') ? 'Found 0 plugins:\n' : 'Plugins:\n'
  : JSON.stringify({ installed: [], available: [] }) })
const listInventory = home => listCapabilityInventories(home, emptyPluginRunner)
const toolOptions = home => ({ home, pluginRunner: emptyPluginRunner, agents: ['codex','traex','claude'].map(id => ({id,name:id,adapter:id,bin:id,installed:true})) })
async function readJournal(dataRoot, id) { return JSON.parse(await readFile(join(dataRoot,'transactions',id,'journal.json'),'utf8')) }
const transactionArtifact = (target, kind, transactionId, index) => join(dirname(target),`.ua-${kind}-${basename(target)}-${transactionId}-${index}`)
async function transactionDigest(path) {
  const hash=createHash('sha256')
  async function walk(current,root){const info=await lstat(current),rel=relative(root,current);hash.update(info.isDirectory()?'d':info.isSymbolicLink()?'l':'f').update(rel).update('\0').update(String(info.mode&0o777)).update('\0');if(info.isSymbolicLink()){hash.update(await readlink(current)).update('\0');return}if(info.isDirectory()){for(const name of (await readdir(current)).sort())await walk(join(current,name),root);return}hash.update(await readFile(current)).update('\0')}
  await walk(path,path);return hash.digest('hex')
}
function canonical(value){if(value===null)return'null';if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;return JSON.stringify(value)}

await test('planner classifies same/add/conflict/target-only and defaults safely', () => {
  const items = diffInventories({ revision: 's', items: [cap('a','1'), cap('b','2'), cap('c','3')], layoutKnown:true }, { revision: 't', items: [cap('a','1'), cap('b','x'), cap('d','4')], layoutKnown:true })
  assert.deepEqual(Object.fromEntries(items.map(x => [x.name, x.status])), { a:'same', b:'conflict', c:'add', d:'target-only' })
  assert.equal(items.find(x => x.name === 'b').defaultSelected, false)
  const merge = buildPlan({ id:'p', scanId:'s', source:'codex', target:'traex', sourceRevision:'s', targetRevision:'t', mode:'merge', cloneCategories:[], items, selections:['skill:c'], resolutions:{} })
  assert.equal(merge.operations.find(x => x.name === 'd').action, 'noop')
  const clone = buildPlan({ id:'p2', scanId:'s', source:'codex', target:'traex', sourceRevision:'s', targetRevision:'t', mode:'clone-supported-scope', cloneCategories:['skill'], items, selections:['skill:c'], resolutions:{} })
  assert.equal(clone.operations.find(x => x.name === 'd').action, 'noop')
  assert.equal(clone.blockedReasons.includes('clone_requires_complete_category'), true)
})

await test('path traversal is rejected while a top-level Skill symlink remains non-copyable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ua-sync-safe-')); const root = join(home,'.codex/skills'); await mkdir(root,{recursive:true}); await symlink(tmpdir(), join(root,'escape'))
  assert.throws(() => assertSafeDestination(join(root,'../../outside'), root), /path_traversal/)
  const inv = await discoverProvider('codex', home), escaped = inv.items.find(x => x.name === 'escape'); assert.equal(escaped.compatible, false); assert.equal(escaped.linked, true)
})

await test('MCP fingerprint/redaction never includes literal secret', () => {
  const token = 'SUPER_SECRET_123'; const blocks = parseMcpBlocks(`[mcp_servers.demo]\ncommand = "node"\nenv.API_TOKEN = "${token}"\n`)
  assert.equal(blocks[0].secretShape.length, 1); assert.equal(blocks[0].body.includes(token), false)
})

await test('Markdown merge is deterministic and idempotent', () => {
  const once = mergeMarkdown('# A\none\n', '# B\ntwo\n'); assert.equal(mergeMarkdown(once, '# B\ntwo\n'), once)
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ua-sync-fixture-'))
  for (const p of ['.codex/skills/alpha','.trae/cli/skills','.agents']) await mkdir(join(home,p),{recursive:true})
  await writeFile(join(home,'.codex/skills/alpha/SKILL.md'),'# Alpha\n')
  await writeFile(join(home,'.codex/config.toml'),'model = "gpt-source"\n[mcp_servers.demo]\ncommand = "node"\nenv.API_TOKEN = "SOURCE_SECRET"\n')
  await writeFile(join(home,'.trae/cli/config.toml'),'model = "gpt-target"\n[mcp_servers.demo]\ncommand = "old"\nenv.API_TOKEN = "TARGET_SECRET"\n')
  await writeFile(join(home,'.codex/AGENTS.md'),'# Codex\nA\n'); await writeFile(join(home,'.trae/cli/AGENTS.md'),'# TraeX\nB\n')
  return {home,dataRoot:join(home,'.data')}
}

async function twoTargetFixture() {
  const fx=await fixture(); const {home}=fx
  await mkdir(join(home,'.codex/skills/beta'),{recursive:true}); await writeFile(join(home,'.codex/skills/beta/SKILL.md'),'# Beta\n')
  return fx
}

async function hybridFixture() {
  const home = await mkdtemp(join(tmpdir(), 'ua-sync-hybrid-'))
  for (const path of ['.codex/skills/alpha', '.trae/skills', '.trae/cli', '.agents']) await mkdir(join(home, path), { recursive: true })
  await writeFile(join(home, '.codex/skills/alpha/SKILL.md'), '# Alpha\n')
  await writeFile(join(home, '.codex/config.toml'), 'model="gpt-source"\n')
  await writeFile(join(home, '.trae/cli/config.toml'), 'model="gpt-target"\n')
  return { home, dataRoot: join(home, '.data') }
}

async function planSkills(svc, ids=['skill:alpha']) {
  const scan=await svc.scan({source:'codex',target:'traex'})
  const selected = new Set(ids)
  const resolutions = Object.fromEntries(scan.items
    .filter(item => selected.has(item.id) && item.status === 'conflict' && item.kind !== 'global-instructions')
    .map(item => [item.id, 'source']))
  return svc.plan({scanId:scan.id,mode:'merge',cloneCategories:[],selections:ids,resolutions})
}

await test('skill migration recursively excludes exact rename anchors but preserves significant lookalikes', async () => {
  const {home,dataRoot}=await fixture(),source=join(home,'.codex/skills/alpha'),nested=join(source,'nested')
  await mkdir(nested,{recursive:true})
  const exact='.ua-rn-v1-'+'a'.repeat(32),lookalike='.ua-rn-v1-'+'b'.repeat(31)+'z'
  await writeFile(join(nested,exact),'must not migrate\n');await writeFile(join(nested,lookalike),'must migrate\n')
  const svc=new CapabilitySyncService(home,dataRoot),plan=await planSkills(svc),done=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  const target=join(home,'.trae/cli/skills/alpha/nested')
  assert.equal(done.state,'completed');assert.equal(existsSync(join(target,exact)),false);assert.equal(await readFile(join(target,lookalike),'utf8'),'must migrate\n')
  await writeFile(join(target,lookalike),'changed\n')
  const rescan=await svc.scan({source:'codex',target:'traex'});assert.equal(rescan.items.find(item=>item.id==='skill:alpha').status,'conflict')
})

for(const [boundary,wantedHit] of [['after-rename-intent-preparation_to_transaction',1],['after-rename-intent-preparation_to_transaction',2],['after-rename-published-preparation_to_transaction',1],['after-rename-published-preparation_to_transaction',2]]) await test(`startup preserves sealed preparation rename evidence at ${boundary} #${wantedHit}`, async () => {
  const {home,dataRoot}=await fixture();let hits=0
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage===boundary&&++hits===wantedHit)throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  const transactions=join(dataRoot,'transactions');await waitFor(async()=>{try{return (await readdir(transactions)).some(candidate=>candidate.startsWith('.ua-transaction-seed-')||candidate.startsWith('.ua-transaction-preparation-')||/^[0-9a-f-]{36}$/.test(candidate))}catch{return false}})
  await waitForOperationUnlock(dataRoot);const name=(await readdir(transactions)).find(candidate=>existsSync(join(transactions,candidate,'journal.json'))),journal=JSON.parse(await readFile(join(transactions,name,'journal.json'),'utf8'))
  assert.equal(journal.version,4);assert.equal(journal.renameIntent.leg,'preparation_to_transaction');assert.equal(journal.renameIntent.entryIndex,undefined);assert.match(journal.renameIntent.anchorName,/^\.ua-rn-v1-[a-f0-9]{32}$/);assert.equal(journal.renameIntent.anchorName.length,42)
  const before=await readdir(transactions),recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover();assert.deepEqual((await readdir(transactions)).sort(),before.sort());assert.equal((await recovered.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required');assert.equal(recovered.getJobSnapshot().rollbackCandidate,undefined);assert.equal(started.id,journal.job.id)
})

for(const [leg,boundary] of [['target_to_slot','after-rename-intent-target_to_slot-0'],['stage_to_target','after-rename-intent-stage_to_target-0'],['target_to_post','after-rename-intent-target_to_post-0'],['slot_to_target','after-rename-intent-slot_to_target-0']]) await test(`journal v4 seals and preserves ${leg} intent`, async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha')
  await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{
    if((leg==='target_to_post'||leg==='slot_to_target')&&stage==='after-commit-0')throw new Error('force rollback')
    if(stage===boundary)throw new CapabilitySyncSimulatedCrash()
  }),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  const journal=await waitFor(async()=>{const job=svc.getJob(started.id);if(!job?.transactionId)return;try{const value=await readJournal(dataRoot,job.transactionId);return value.renameIntent?.leg===leg?value:undefined}catch{return}})
  await waitForOperationUnlock(dataRoot);assert.equal(journal.version,4);assert.equal(journal.renameIntent.version,1);assert.equal(journal.renameIntent.entryIndex,0);assert.match(journal.renameIntent.anchorName,/^\.ua-rn-v1-[a-f0-9]{32}$/);assert.equal(journal.renameIntent.anchorName.length,42);assert.deepEqual(Object.keys(journal.renameIntent.expectedSource).sort(),['dev','ino','type'])
  const parent=dirname(target),before=(await readdir(parent)).sort(),recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover();assert.deepEqual((await readdir(parent)).sort(),before);assert.equal((await recovered.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required');assert.equal(recovered.getJobSnapshot().rollbackCandidate,undefined)
})

await test('exact rename anchor residue is preserved and blocks recovery while lookalikes do not', async () => {
  const {home,dataRoot}=await fixture(),parent=join(home,'.trae/cli/skills'),anchor='.ua-rn-v1-'+'c'.repeat(32),lookalike='.ua-rn-v1-'+'d'.repeat(31)+'z'
  await mkdir(dataRoot,{recursive:true});await writeFile(join(parent,anchor),'evidence\n');await writeFile(join(parent,lookalike),'ordinary\n')
  const svc=new CapabilitySyncService(home,dataRoot);await svc.recover();assert.equal(await readFile(join(parent,anchor),'utf8'),'evidence\n');assert.equal(await readFile(join(parent,lookalike),'utf8'),'ordinary\n');assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
  await rm(join(parent,anchor));const open=new CapabilitySyncService(home,dataRoot);await open.recover();assert.notEqual((await open.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
})

await test('raw own non-null renameIntent blocks before operation-lock mutation even when unsealed', async () => {
  const {home,dataRoot}=await fixture(),transactions=join(dataRoot,'transactions'),id=randomUUID(),dir=join(transactions,id),lock=join(dataRoot,'operation.lock')
  await mkdir(dir,{recursive:true,mode:0o700});await writeFile(join(dir,'journal.json'),JSON.stringify({renameIntent:{attacker:'opaque'}}),{mode:0o600})
  const before=await readFile(join(dir,'journal.json'),'utf8'),svc=new CapabilitySyncService(home,dataRoot);await svc.recover()
  assert.equal(await readFile(join(dir,'journal.json'),'utf8'),before);assert.equal(existsSync(lock),false);assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
})

await test('failed durable intent clear leaves the live intent intact and transaction recovery-blocked', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot),plan=await planSkills(svc),persist=svc.persistJournalAt.bind(svc);let injected=false
  svc.persistJournalAt=async(path,journal)=>{if(!injected&&journal.transactionLocation==='canonical'&&!journal.renameIntent&&existsSync(join(home,'.trae/cli/skills/alpha'))){injected=true;throw new Error('clear failed')}return persist(path,journal)}
  const started=svc.execute(executeRequest(plan)),journal=await waitFor(async()=>{const job=svc.getJob(started.id);if(!job?.transactionId)return;try{const value=await readJournal(dataRoot,job.transactionId);return value.renameIntent?.leg==='stage_to_target'?value:undefined}catch{return}})
  await waitForOperationUnlock(dataRoot);assert.equal(journal.renameIntent.leg,'stage_to_target');assert.equal(svc.getJob(started.id).state,'committing');assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
})

await test('service source has no exclusive or inverse rename escape hatch', async () => {
  const source=await readFile(new URL('../src/main/capability-sync/service.ts',import.meta.url),'utf8')
  assert.doesNotMatch(source,/atomicRenameExclusiveSync|tryAtomicMoveBack|atomicRenameAppliedSync/)
  assert.match(source,/atomicRenameAnchoredSync/)
  assert.equal(source.includes('const RENAME_ANCHOR_ARTIFACT = /^\\.ua-rn-v1-[a-f0-9]{32}$/'),true)
})

await test('service rejects stale plan with zero writes', async () => {
  const {home,dataRoot} = await fixture(), svc = new CapabilitySyncService(home, dataRoot); const scan = await svc.scan({source:'codex',target:'traex'}); const item = scan.items.find(x=>x.id==='skill:alpha')
  const plan = svc.plan({scanId:scan.id,mode:'merge',cloneCategories:[],selections:[item.id],resolutions:{}}); await writeFile(join(home,'.trae/cli/MEMORY.md'),'external')
  const job=svc.execute(executeRequest(plan)), done=await waitForTerminal(svc,job.id); assert.equal(done.errorCode,'stale_plan')
  assert.equal(await readFile(join(home,'.codex/skills/alpha/SKILL.md'),'utf8'),'# Alpha\n')
})

await test('service executes skill merge and preserves target MCP secret', async () => {
  const {home,dataRoot} = await fixture(), svc = new CapabilitySyncService(home,dataRoot); const scan = await svc.scan({source:'codex',target:'traex'}); const mcp=scan.items.find(x=>x.kind==='mcp');assert.ok(mcp);assert.equal(mcp.id,'mcp:demo');assert.equal(mcp.name,'demo');const ids=['skill:alpha',mcp.id]; const plan=svc.plan({scanId:scan.id,mode:'merge',cloneCategories:[],selections:ids,resolutions:{[mcp.id]:'source'}}); const started=svc.execute(executeRequest(plan)); const job=await waitForTerminal(svc,started.id)
  assert.equal(job.state,'completed'); assert.equal(await readFile(join(home,'.trae/cli/skills/alpha/SKILL.md'),'utf8'),'# Alpha\n'); assert.equal(job.result.verified,2); assert.equal(job.result.manualRequired,0)
  const cfg=await readFile(join(home,'.trae/cli/config.toml'),'utf8'); assert.equal(cfg.includes('SOURCE_SECRET'),false); assert.equal(cfg.includes('TARGET_SECRET'),true)
  assert.equal(cfg.includes('command = "node"'),true); assert.equal(cfg.includes('<redacted>'),false)
  assert.equal(JSON.stringify(scan).includes(home),false); assert.equal(JSON.stringify(scan).includes('SOURCE_SECRET'),false)
})

await test('AGENTS preview exposes only a content-free summary to renderer callers', async () => {
  const {home,dataRoot}=await fixture();await writeFile(join(home,'.codex/AGENTS.md'),'# Private\nTOKEN=SUPER_SECRET\n/Users/private/project\n')
  const svc=new CapabilitySyncService(home,dataRoot),scan=await svc.scan({source:'codex',target:'traex'}),preview=await svc.getMarkdownPreview(scan.id,'global-instructions:agents','keep-codex')
  assert.deepEqual(Object.keys(preview).sort(),['byteCount','headingCount','itemId','lineCount']);assert.equal(preview.itemId,'global-instructions:agents');assert.equal(preview.headingCount,1)
  assert.equal(JSON.stringify(preview).includes('SUPER_SECRET'),false);assert.equal(JSON.stringify(preview).includes('/Users/private'),false)
})

await test('equal-timestamp job ordering never regresses a terminal state', () => {
  const base={id:randomUUID(),planId:randomUUID(),updatedAt:100,progress:{completed:1,total:1}},completed={...base,state:'completed'},running={...base,state:'committing'}
  assert.equal(compareCapabilitySyncJobs(running,completed)<0,true);assert.equal(compareCapabilitySyncJobs(completed,running)>0,true)
})

await test('reverse direction scans current TraeX layout', async () => { const {home,dataRoot}=await fixture(); const old=join(home,'.trae/cli/config.toml'), current=join(home,'.trae/traecli.toml'); await writeFile(current,await readFile(old)); await rm(join(home,'.trae/cli'),{recursive:true}); const scan=await new CapabilitySyncService(home,dataRoot).scan({source:'traex',target:'codex'}); assert.equal(scan.sourceAvailable,true); assert.equal(scan.executionSupported,true); const mcp=scan.items.find(x=>x.kind==='mcp');assert.ok(mcp);assert.equal(mcp.id,'mcp:demo');assert.equal(mcp.name,'demo') })

await test('service writes the scanner-compatible TraeX hybrid skills root', async () => {
  const {home,dataRoot}=await hybridFixture(),svc=new CapabilitySyncService(home,dataRoot),scan=await svc.scan({source:'codex',target:'traex'})
  assert.equal(scan.executionSupported,true)
  const plan=svc.plan({scanId:scan.id,mode:'merge',cloneCategories:[],selections:['skill:alpha'],resolutions:{}})
  const done=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(done.state,'completed')
  assert.equal(await readFile(join(home,'.trae/skills/alpha/SKILL.md'),'utf8'),'# Alpha\n')
  assert.equal(existsSync(join(home,'.trae/cli/skills/alpha')),false)
})

await test('Markdown equal heading conflict is blocked', () => { assert.throws(() => mergeMarkdown('# Rules\none\n','# Rules\ntwo\n'),/markdown_conflict/) })

await test('clone requires a complete selected category', () => { const items=diffInventories({revision:'s',items:[cap('a','1'),cap('b','2')],layoutKnown:true},{revision:'t',items:[],layoutKnown:true}); const p=buildPlan({id:'p',scanId:'s',source:'codex',target:'traex',sourceRevision:'s',targetRevision:'t',mode:'clone-supported-scope',cloneCategories:['skill'],items,selections:['skill:a'],resolutions:{}}); assert.equal(p.blockedReasons.includes('clone_requires_complete_category'),true) })

await test('service clone deletes an empty-source category from the target', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/MEMORY.md')
  await writeFile(target,'target only\n')
  const svc=new CapabilitySyncService(home,dataRoot),scan=await svc.scan({source:'codex',target:'traex'})
  assert.equal(scan.items.find(item=>item.kind==='memory')?.status,'target-only')
  const plan=svc.plan({scanId:scan.id,mode:'clone-supported-scope',cloneCategories:['memory'],selections:[],resolutions:{}})
  assert.equal(plan.operations.find(operation=>operation.kind==='memory')?.action,'delete')
  const done=await waitForTerminal(svc,svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex'}}).id)
  assert.equal(done.state,'completed');assert.equal(existsSync(target),false)
})

await test('service clone removes target-only skills when common skills are all same', async () => {
  const {home,dataRoot}=await fixture(),same=join(home,'.trae/cli/skills/alpha'),extra=join(home,'.trae/cli/skills/extra')
  await mkdir(same,{recursive:true});await writeFile(join(same,'SKILL.md'),'# Alpha\n')
  await mkdir(extra,{recursive:true});await writeFile(join(extra,'SKILL.md'),'# Extra\n')
  const svc=new CapabilitySyncService(home,dataRoot),scan=await svc.scan({source:'codex',target:'traex'})
  assert.equal(scan.items.find(item=>item.id==='skill:alpha')?.status,'same')
  assert.equal(scan.items.find(item=>item.id==='skill:extra')?.status,'target-only')
  const plan=svc.plan({scanId:scan.id,mode:'clone-supported-scope',cloneCategories:['skill'],selections:[],resolutions:{}})
  assert.equal(plan.operations.find(operation=>operation.itemId==='skill:extra')?.action,'delete')
  const done=await waitForTerminal(svc,svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex'}}).id)
  assert.equal(done.state,'completed');assert.equal(existsSync(extra),false);assert.equal(await readFile(join(same,'SKILL.md'),'utf8'),'# Alpha\n')
})

await test('explicit remove-selected deletes only selected user Skill/MCP in one transaction', async () => {
  const {home,dataRoot}=await fixture(),skill=join(home,'.trae/cli/skills/remove-me')
  await mkdir(skill,{recursive:true});await writeFile(join(skill,'SKILL.md'),'# Remove me\n')
  await writeFile(join(home,'.trae/cli/config.toml'),'model="gpt-target"\n[mcp_servers.remove_me]\ncommand="node"\n[mcp_servers.keep_me]\ncommand="keep"\n')
  const svc=new CapabilitySyncService(home,dataRoot),plan=await svc.planRemoval('traex',[managedInventoryId('traex','skill:remove-me'),managedInventoryId('traex','mcp:remove_me')])
  assert.equal(plan.mode,'remove-selected');assert.equal(plan.destructiveCount,2);assert.equal(plan.operations.filter(item=>['skill:remove-me','mcp:remove_me'].includes(item.itemId)).every(item=>item.action==='delete'),true)
  assert.throws(()=>svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex',deleteCount:1}}),/confirmation_required/)
  const done=await waitForTerminal(svc,svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex',deleteCount:2}}).id)
  assert.equal(done.state,'completed');assert.equal(existsSync(skill),false)
  const config=await readFile(join(home,'.trae/cli/config.toml'),'utf8');assert.equal(config.includes('remove_me'),false);assert.equal(config.includes('keep_me'),true)
})

await test('single-provider edition removes and restores Codex capabilities without reading a disabled provider', async () => {
  const {home,dataRoot}=await fixture(),skill=join(home,'.codex/skills/alpha')
  await rm(join(home,'.trae'),{recursive:true})
  await writeFile(join(home,'.trae'),'disabled provider must never be traversed')
  const svc=new CapabilitySyncService(home,dataRoot,undefined,['codex'])
  await svc.recover()
  await assert.rejects(svc.scan({source:'traex',target:'codex'}),/capability_provider_unavailable/)
  await assert.rejects(svc.planRemoval('traex',['skill:alpha']),/capability_provider_unavailable/)
  const plan=await svc.planRemoval('codex',[managedInventoryId('codex','skill:alpha')])
  assert.deepEqual(plan.blockedReasons,[])
  const done=await waitForTerminal(svc,svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'codex',deleteCount:1}}).id)
  assert.equal(done.state,'completed');assert.equal(existsSync(skill),false)
  await waitForOperationUnlock(dataRoot)
  const restarted=new CapabilitySyncService(home,dataRoot,undefined,['codex'])
  await restarted.recover()
  const restored=await restarted.rollback(done.transactionId)
  assert.equal(restored.state,'rolled_back')
  assert.equal(await readFile(join(skill,'SKILL.md'),'utf8'),'# Alpha\n')
  assert.equal(await readFile(join(home,'.trae'),'utf8'),'disabled provider must never be traversed')
})

await test('completed removal survives a startup device-id change and remains rollbackable', async () => {
  const {home,dataRoot}=await fixture(),skill=join(home,'.trae/cli/skills/remove-after-restart')
  await mkdir(skill,{recursive:true});await writeFile(join(skill,'SKILL.md'),'# Remove after restart\n')
  const svc=new CapabilitySyncService(home,dataRoot),plan=await svc.planRemoval('traex',[managedInventoryId('traex','skill:remove-after-restart')])
  const done=await waitForTerminal(svc,svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex',deleteCount:1}}).id)
  await waitForOperationUnlock(dataRoot);assert.equal(done.state,'completed');assert.equal(existsSync(skill),false)
  const journalPath=join(dataRoot,'transactions',done.transactionId,'journal.json'),journal=JSON.parse(await readFile(journalPath,'utf8')),oldDev=String(BigInt(journal.transactionRootIdentity.dev)+1n)
  journal.transactionRootIdentity.dev=oldDev;journal.transactionRootIdentity.parentDev=oldDev
  for(const entry of journal.entries){for(const parent of entry.parentChain||[])parent.dev=oldDev;if(entry.expectedPreState.exists)entry.expectedPreState.dev=oldDev;if(entry.expectedPostState?.exists)entry.expectedPostState.dev=oldDev;if(entry.stageIdentity){entry.stageIdentity.dev=oldDev;entry.stageIdentity.parentDev=oldDev}}
  const key=await readFile(join(dataRoot,'journal-seal.key'));journal.seal=createHmac('sha256',key).update(canonical({...journal,seal:''})).digest('hex');await writeFile(journalPath,JSON.stringify(journal,null,2),{mode:0o600})
  const restarted=new CapabilitySyncService(home,dataRoot);await restarted.recover()
  assert.notEqual((await restarted.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
  const rolled=await restarted.rollback(done.transactionId);assert.equal(rolled.state,'rolled_back');assert.equal(await readFile(join(skill,'SKILL.md'),'utf8'),'# Remove after restart\n')
})

await test('remove-selected unlinks top-level Skill symlinks without touching their targets', async () => {
  const {home,dataRoot}=await fixture(),source=await mkdtemp(join(tmpdir(),'ua-cadk-source-')),live=join(home,'.trae/cli/skills/cadk-link'),broken=join(home,'.trae/cli/skills/broken-link')
  await writeFile(join(source,'SKILL.md'),'# Managed by CADK\n')
  const missing=join(source,'missing');await symlink(source,live);await symlink(missing,broken)
  const inventory=(await listInventory(home)).inventories.find(item=>item.agentId==='traex')
  const links=inventory.items.filter(item=>['cadk-link','broken-link'].includes(item.name))
  assert.equal(links.length,2);assert.equal(links.every(item=>item.manageable&&item.linked&&!item.copyable),true)
  assert.equal(links.find(item=>item.name==='cadk-link').status,'available')
  assert.equal(links.find(item=>item.name==='broken-link').status,'invalid')
  assert.equal(links.find(item=>item.name==='broken-link').issueCode,'unsafe_skill_entry')
  const svc=new CapabilitySyncService(home,dataRoot),plan=await svc.planRemoval('traex',links.map(item=>item.id))
  const done=await waitForTerminal(svc,svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex',deleteCount:2}}).id)
  assert.equal(done.state,'completed');await assert.rejects(lstat(live),{code:'ENOENT'});await assert.rejects(lstat(broken),{code:'ENOENT'})
  assert.equal(await readFile(join(source,'SKILL.md'),'utf8'),'# Managed by CADK\n')
  const rolled=await svc.rollback(done.transactionId);assert.equal(rolled.state,'rolled_back');assert.equal(await readlink(live),source);assert.equal(await readlink(broken),missing)
})

await test('remove-selected rejects non-user kinds and rolls back the whole batch on failure', async () => {
  const {home,dataRoot}=await fixture(),one=join(home,'.trae/cli/skills/one'),two=join(home,'.trae/cli/skills/two')
  for(const path of [one,two]){await mkdir(path,{recursive:true});await writeFile(join(path,'SKILL.md'),`# ${basename(path)}\n`)}
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0')throw new Error('fail batch')})
  await assert.rejects(()=>svc.planRemoval('traex',['memory:MEMORY.md']),/invalid_selection/)
  const plan=await svc.planRemoval('traex',[managedInventoryId('traex','skill:one'),managedInventoryId('traex','skill:two')])
  const done=await waitForTerminal(svc,svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex',deleteCount:2}}).id)
  assert.equal(done.state,'rolled_back');assert.equal(existsSync(one),true);assert.equal(existsSync(two),true)
})

await test('unified inventory exposes shared Skills only to Codex and TraeX', async () => {
  const {home}=await fixture()
  await mkdir(join(home,'.claude/skills/local'),{recursive:true});await writeFile(join(home,'.claude/skills/local/SKILL.md'),'# Local\n')
  await writeFile(join(home,'.claude.json'),JSON.stringify({mcpServers:{claude_mcp:{command:'node'}}}),{mode:0o600})
  await mkdir(join(home,'.agents/skills/shared-one'),{recursive:true});await writeFile(join(home,'.agents/skills/shared-one/SKILL.md'),'# Shared\n')
  const result=await listInventory(home);assert.deepEqual(result.inventories.map(item=>item.agentId),['codex','traex','claude'])
  const claude=result.inventories.find(item=>item.agentId==='claude');assert.equal(claude.writable,true);assert.equal(claude.items.find(item=>item.name==='local').manageable,true)
  assert.equal(claude.items.find(item=>item.name==='local').removal,'skill')
  assert.equal(claude.items.some(item=>item.name==='shared-one'),false)
  assert.equal(claude.items.find(item=>item.name==='claude_mcp').kind,'mcp');assert.equal(claude.items.find(item=>item.name==='claude_mcp').copyable,false)
  const codex=result.inventories.find(item=>item.agentId==='codex');assert.equal(codex.items.find(item=>item.name==='alpha').manageable,true)
  assert.equal(codex.items.find(item=>item.name==='alpha').id.includes('alpha'),false)
  assert.equal(codex.items.find(item=>item.name==='shared-one').scope,'shared');assert.equal(codex.items.find(item=>item.name==='shared-one').manageable,true)
  assert.equal(codex.items.some(item=>item.kind==='plugin'),false)
  assert.equal(codex.items.some(item=>item.kind==='command'),true)
  assert.deepEqual(codex.items.filter(item=>item.kind==='tool').map(item=>item.name).sort(),['send_to_feishu','uniagent_query','uniagent_task'])
  for(const item of codex.items) for(const key of ['id','agentId','kind','name','scope','origin','owner','fingerprint','manageable','copyable','status']) assert.equal(key in item,true)
  // 管理页刻意展示读取入口与原始文件位置；其余字段仍不能附带账户目录或凭据。
  const withoutLocations={...result,inventories:result.inventories.map(inv=>({...inv,items:inv.items.map(({location,entryPath,manifestPath,...rest})=>rest)}))}
  assert.equal(JSON.stringify(withoutLocations).includes(home),false)
  assert.equal(codex.items.find(item=>item.name==='shared-one').location.includes(join(home,'.agents/skills/shared-one')),true)
  assert.equal(codex.items.find(item=>item.name==='shared-one').entryPath,join(home,'.agents/skills/shared-one'))
  assert.equal(codex.items.find(item=>item.name==='shared-one').manifestPath,join(home,'.agents/skills/shared-one/SKILL.md'))
})

await test('inventory keeps child scan failures local without reading outside home', async () => {
  const home=await mkdtemp(join(tmpdir(),'ua-inventory-safe-')),outside=await mkdtemp(join(tmpdir(),'ua-inventory-outside-'))
  await mkdir(join(home,'.codex'),{recursive:true});await writeFile(join(home,'.codex/config.toml'),'model=\"safe\"\n')
  await mkdir(join(outside,'skills/escaped'),{recursive:true});await writeFile(join(outside,'skills/escaped/SKILL.md'),'# OUTSIDE_CANARY\n')
  await symlink(outside,join(home,'.agents'))
  await mkdir(join(home,'.claude/skills/linked'),{recursive:true});await symlink(join(outside,'skills/escaped/SKILL.md'),join(home,'.claude/skills/linked/SKILL.md'))
  const result=await listInventory(home),codex=result.inventories.find(item=>item.agentId==='codex'),claude=result.inventories.find(item=>item.agentId==='claude')
  assert.equal(codex.status,'available');assert.equal(codex.items.some(item=>item.name==='escaped'),false)
  assert.equal(codex.items.some(item=>item.issueCode==='unsafe_skill_root'),true)
  assert.equal(claude.status,'available');assert.equal(claude.items.some(item=>item.name==='linked'&&item.status==='available'),false)
  assert.equal(JSON.stringify(result).includes('OUTSIDE_CANARY'),false)
})

await test('inventory accepts writable manifests while retaining size validation', async () => {
  const home=await mkdtemp(join(tmpdir(),'ua-inventory-manifest-'))
  await mkdir(join(home,'.codex'),{recursive:true});await writeFile(join(home,'.codex/config.toml'),'model=\"safe\"\n')
  for(const name of ['writable','oversized'])await mkdir(join(home,'.agents/skills',name),{recursive:true})
  await writeFile(join(home,'.agents/skills/writable/SKILL.md'),'# writable\n',{mode:0o666})
  await chmod(join(home,'.agents/skills/writable/SKILL.md'),0o666)
  await writeFile(join(home,'.agents/skills/oversized/SKILL.md'),Buffer.alloc(5*1024*1024+1,65),{mode:0o600})
  const codex=(await listInventory(home)).inventories.find(item=>item.agentId==='codex')
  assert.equal(codex.status,'available')
  assert.equal(codex.items.find(item=>item.name==='writable')?.status,'available')
  assert.equal(codex.items.find(item=>item.name==='oversized')?.issueCode,'skill_file_too_large')
  assert.equal(codex.items.find(item=>item.name==='oversized')?.status,'invalid')
})

await test('inventory ignores harmless files and accepts writable skill directory chains', async () => {
  const {home}=await fixture(),sharedRoot=join(home,'.agents/skills')
  await mkdir(sharedRoot,{recursive:true});await writeFile(join(sharedRoot,'README.md'),'documentation only\n')
  let codex=(await listInventory(home)).inventories.find(item=>item.agentId==='codex')
  assert.equal(codex.status,'available');assert.equal(codex.items.some(item=>item.name==='README.md'),false)
  const unsafe=join(sharedRoot,'unsafe-parent');await mkdir(join(unsafe,'nested'),{recursive:true})
  await writeFile(join(unsafe,'nested/SKILL.md'),'# unsafe\n',{mode:0o600});await chmod(unsafe,0o777)
  codex=(await listInventory(home)).inventories.find(item=>item.agentId==='codex')
  assert.equal(codex.status,'available')
  assert.equal(codex.items.find(item=>item.name==='nested')?.status,'available')
})

await test('Claude discovers HOME-contained Skill links and ignores non-Skill entries', async () => {
  const {home}=await fixture(),target=join(home,'.agents/skills/lark-doc'),root=join(home,'.claude/skills')
  await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'# Lark doc\n')
  await mkdir(root,{recursive:true});await symlink('../../.agents/skills/lark-doc',join(root,'lark-doc'))
  await writeFile(join(root,'backup.zip'),'not a skill');await mkdir(join(root,'empty'))
  const claude=(await listInventory(home)).inventories.find(item=>item.agentId==='claude')
  const linked=claude.items.find(item=>item.scope==='agent'&&item.name==='lark-doc')
  assert.equal(linked?.linked,true);assert.equal(linked?.status,'available')
  assert.equal(claude.items.some(item=>item.name==='backup.zip'||item.name==='empty'),false)
})

await test('Skill link removal supports Codex without touching the target', async () => {
  const {home}=await fixture(),target=join(home,'.agents/skills/lark-doc')
  await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'# Lark doc\n')
  const codexLink=join(home,'.codex/skills/cadk-apply');await symlink(target,codexLink)
  const codex=(await listInventory(home)).inventories.find(item=>item.agentId==='codex'),codexLinked=codex.items.find(item=>item.name==='cadk-apply')
  assert.equal(codexLinked?.linked,true);await removeAgentToolSkill(codexLinked.id,'codex',codexLinked.fingerprint,toolOptions(home))
  assert.equal(existsSync(codexLink),false);assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'# Lark doc\n')
})

await test('shared Skill removal cleans every dependent Agent link before deleting the source', async () => {
  const {home}=await fixture(),target=join(home,'.agents/skills/shared-tool'),other=join(home,'.agents/skills/other-tool')
  await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'# Shared tool\n')
  await mkdir(other,{recursive:true});await writeFile(join(other,'SKILL.md'),'# Other tool\n')
  const links=[join(home,'.codex/skills/shared-tool'),join(home,'.trae/skills/shared-alias'),join(home,'.trae/cli/skills/shared-tool'),join(home,'.claude/skills/shared-tool')]
  await mkdir(join(home,'.trae/skills'),{recursive:true});await mkdir(join(home,'.claude/skills'),{recursive:true})
  for(const link of links)await symlink(target,link)
  const unrelated=join(home,'.codex/skills/other-tool');await symlink(other,unrelated)
  const codex=(await listInventory(home)).inventories.find(item=>item.agentId==='codex')
  const shared=codex.items.find(item=>item.scope==='shared'&&item.name==='shared-tool')
  assert.equal(shared.manageable,true);assert.deepEqual(shared.dependentAgents,['codex','traex','claude'])
  await removeAgentToolSkill(shared.id,'codex',shared.fingerprint,toolOptions(home))
  assert.equal(existsSync(target),false);assert.equal(existsSync(unrelated),true)
  assert.equal(links.some(existsSync),false);assert.equal(await realpath(unrelated),await realpath(other))
})

await test('Claude reports broken and HOME-escaping Skill links without poisoning Agent status', async () => {
  const {home}=await fixture(),outside=await mkdtemp(join(tmpdir(),'ua-claude-link-outside-')),root=join(home,'.claude/skills')
  await mkdir(join(outside,'skill'),{recursive:true});await writeFile(join(outside,'skill/SKILL.md'),'# Outside\n')
  await mkdir(root,{recursive:true});await symlink(join(root,'missing'),join(root,'broken'));await symlink(join(outside,'skill'),join(root,'escaped'))
  const claude=(await listInventory(home)).inventories.find(item=>item.agentId==='claude')
  assert.equal(claude.status,'available')
  assert.equal(claude.items.find(item=>item.name==='broken')?.issueCode,'unsafe_skill_entry')
  assert.equal(claude.items.find(item=>item.name==='escaped')?.issueCode,'unsafe_skill_entry')
})

await test('plugin cache content alone is not inventory and is not expanded into Skills', async () => {
  const {home}=await fixture(),skill=join(home,'.codex/plugins/cache/source/demo/v1/skills/plugin-one')
  await mkdir(skill,{recursive:true});await writeFile(join(skill,'SKILL.md'),'# Plugin\n')
  const codex=(await listInventory(home)).inventories.find(item=>item.agentId==='codex')
  assert.equal(codex.items.some(item=>item.name==='plugin-one'),false)
  assert.equal(codex.items.some(item=>item.kind==='plugin'),false)
})

await test('inventory revision includes stable identity metadata and ignores enumeration order', async () => {
  const {home}=await fixture(),shared=join(home,'.agents/skills/identity')
  await mkdir(shared,{recursive:true});await writeFile(join(shared,'SKILL.md'),'# same content\n')
  const before=(await listInventory(home)).inventories.find(item=>item.agentId==='codex'),beforeItem=before.items.find(item=>item.scope==='shared'&&item.name==='identity')
  await rename(shared,join(home,'.agents/skills/renamed'))
  const after=(await listInventory(home)).inventories.find(item=>item.agentId==='codex'),afterItem=after.items.find(item=>item.scope==='shared'&&item.name==='renamed')
  assert.notEqual(after.revision,before.revision);assert.notEqual(afterItem.id,beforeItem.id)
  const stable=(await listInventory(home)).inventories.find(item=>item.agentId==='codex')
  assert.equal(stable.revision,after.revision);assert.deepEqual(stable.items.map(item=>item.id),after.items.map(item=>item.id))
})

await test('inventory selection preparation maps only the requested source capabilities', async () => {
  const {home,dataRoot}=await twoTargetFixture(),svc=new CapabilitySyncService(home,dataRoot)
  const inventory=(await listInventory(home)).inventories.find(item=>item.agentId==='codex'),alpha=inventory.items.find(item=>item.name==='alpha'&&item.copyable),beta=inventory.items.find(item=>item.name==='beta'&&item.copyable)
  const prepared=await svc.prepareInventorySelection({source:'codex',target:'traex',selections:[beta.id]})
  assert.equal(prepared.scan.source,'codex');assert.equal(prepared.scan.target,'traex');assert.deepEqual(prepared.selections,['skill:beta'])
  assert.equal(prepared.selections.includes('skill:alpha'),false)
  const originalScan=svc.scan.bind(svc)
  svc.scan=async(request)=>{await rm(join(home,'.codex/skills/beta'),{recursive:true,force:true});return originalScan(request)}
  await assert.rejects(()=>svc.prepareInventorySelection({source:'codex',target:'traex',selections:[beta.id]}),/stale_plan/)
  await assert.rejects(()=>svc.prepareInventorySelection({source:'traex',target:'codex',selections:[beta.id]}),/invalid_selection/)
  await assert.rejects(()=>svc.prepareInventorySelection({source:'codex',target:'traex',selections:[]}),/invalid_selection/)
})

await test('failure after a commit point restores original target', async () => {
  const {home,dataRoot} = await fixture(), target = join(home,'.trae/cli/skills/alpha'); await mkdir(target,{recursive:true}); await writeFile(join(target,'SKILL.md'),'original\n')
  const svc = new CapabilitySyncService(home, dataRoot, (stage) => { if (stage === 'after-commit-0') throw new Error('injected_failure') })
  const scan = await svc.scan({source:'codex',target:'traex'}), plan = svc.plan({scanId:scan.id,mode:'merge',cloneCategories:[],selections:['skill:alpha'],resolutions:{'skill:alpha':'source'}})
  const job = await waitForTerminal(svc,svc.execute(executeRequest(plan)).id); assert.equal(job.state,'rolled_back'); assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'original\n')
})

await test('execute returns immediately and reserves both provider locks', async () => {
  const {home,dataRoot}=await fixture(), svc=new CapabilitySyncService(home,dataRoot), plan=await planSkills(svc)
  const target=join(home,'.trae/cli/skills/alpha'), events=[]; svc.on('progress',job=>events.push(job))
  const job=svc.execute(executeRequest(plan)); assert.equal(typeof job.then,'undefined'); assert.equal(job.state,'backing_up'); assert.equal(job.transactionId,undefined); assert.equal(existsSync(target),false)
  assert.throws(()=>svc.execute(executeRequest(plan)),/sync_in_progress/)
  const done=await waitForTerminal(svc,job.id); assert.equal(done.state,'completed'); assert.equal(done.result.manualRequired,0); assert.equal(done.result.residualDifferences,0)
  for(const state of ['backing_up','staging','committing','verifying','completed']) assert.equal(events.some(event=>event.state===state),true)
})

await test('operation lock rejects live V2 owners and cleans released and reclaimed tombstones', async () => {
  const {home,dataRoot}=await fixture(),first=new CapabilitySyncService(home,dataRoot),firstPlan=await planSkills(first)
  let release;const gate=new Promise(resolve=>{release=resolve}),run=first.runTransaction.bind(first);first.runTransaction=async(...args)=>{await gate;return run(...args)}
  const started=first.execute(executeRequest(firstPlan)),lock=join(dataRoot,'operation.lock')
  const liveRecord=await waitFor(async()=>{try{return JSON.parse(await readFile(lock,'utf8'))}catch{return}})
  assert.deepEqual(Object.keys(liveRecord).sort(),['createdAt','pid','processStartToken','token','version']);assert.equal(liveRecord.version,2);assert.equal(liveRecord.pid,process.pid);assert.match(liveRecord.token,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.match(liveRecord.processStartToken,/^[a-f0-9]{64}$/)
  const second=new CapabilitySyncService(home,dataRoot),secondPlan=await planSkills(second)
  assert.throws(()=>second.execute(executeRequest(secondPlan)),/sync_in_progress/);await assert.rejects(()=>second.recover(),/sync_in_progress/)
  release();assert.equal((await waitForTerminal(first,started.id)).state,'completed');await waitForOperationUnlock(dataRoot)

  assert.equal(existsSync(lock),false);assert.deepEqual((await readdir(dataRoot)).filter(name=>name.startsWith('.ua-operation-lock-released-')),[])
  const liveFixture={...liveRecord,token:randomUUID(),createdAt:Date.now()};await writeFile(lock,JSON.stringify(liveFixture),{mode:0o600})
  await assert.rejects(()=>second.recover(),/sync_in_progress/);assert.equal(existsSync(lock),true);await rm(lock)

  const deadToken=randomUUID(),deadRecord={version:2,pid:2147483647,token:deadToken,processStartToken:'a'.repeat(64),createdAt:Date.now()};await writeFile(lock,JSON.stringify(deadRecord),{mode:0o600})
  await second.recover();assert.equal(existsSync(lock),false)
  let names=await readdir(dataRoot);assert.deepEqual(names.filter(name=>name.startsWith(`.ua-operation-lock-stale-${deadToken}-`)),[])

  const reusedToken=randomUUID(),wrongStart=`${liveRecord.processStartToken[0]==='0'?'1':'0'}${liveRecord.processStartToken.slice(1)}`
  await writeFile(lock,JSON.stringify({version:2,pid:process.pid,token:reusedToken,processStartToken:wrongStart,createdAt:Date.now()}),{mode:0o600})
  await second.recover();assert.equal(existsSync(lock),false)
  names=await readdir(dataRoot);assert.deepEqual(names.filter(name=>name.startsWith('.ua-operation-lock-stale-')||name.startsWith('.ua-operation-lock-released-')),[]);assert.equal(existsSync(lock),false)
})

await test('operation lock contention leaves no pending inode and release collision remains recoverable', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot)
  const liveToken=randomUUID(),processStartToken=svc.operationProcessStartToken(process.pid),lockPath=join(dataRoot,'operation.lock')
  await mkdir(dataRoot,{recursive:true,mode:0o700})
  await writeFile(lockPath,JSON.stringify({version:2,pid:process.pid,token:liveToken,processStartToken,createdAt:Date.now()}),{mode:0o600})
  for(let index=0;index<12;index++) assert.throws(()=>new CapabilitySyncService(home,dataRoot).acquireOperationLock(),/sync_in_progress/)
  assert.deepEqual((await readdir(dataRoot)).filter(name=>name.startsWith('.ua-operation-lock-pending-')),[])
  await rm(lockPath)

  const owned=svc.acquireOperationLock(),deterministicTombstone=join(dataRoot,`.ua-operation-lock-released-${owned.token}`)
  await writeFile(deterministicTombstone,'collision',{mode:0o600})
  svc.releaseOperationLock(owned)
  assert.equal(existsSync(lockPath),false)
  assert.equal(await readFile(deterministicTombstone,'utf8'),'collision')
  const next=svc.acquireOperationLock();svc.releaseOperationLock(next)
})

await test('dataRoot replacement after lock acquisition fails closed before provider or replacement metadata writes', async () => {
  const {home,dataRoot}=await fixture(),displaced=join(home,'.data-displaced'),provider=join(home,'.trae/cli/skills/alpha')
  let swapped=false
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{
    if(stage!=='after-operation-lock-acquired'||swapped)return
    swapped=true;renameSync(dataRoot,displaced);mkdirSync(dataRoot,{mode:0o700});mkdirSync(join(dataRoot,'transactions'),{mode:0o700});writeFileSync(join(dataRoot,'canary'),'replacement must survive\n',{mode:0o600})
  })
  const plan=await planSkills(svc),started=svc.execute(executeRequest(plan));await waitFor(()=>swapped)
  assert.equal(svc.getJob(started.id).state,'backing_up');assert.equal(existsSync(provider),false)
  assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
  assert.equal(await readFile(join(dataRoot,'canary'),'utf8'),'replacement must survive\n')
  assert.deepEqual((await readdir(dataRoot)).sort(),['canary','transactions'])
  assert.equal(existsSync(join(displaced,'operation.lock')),true)
  assert.throws(()=>new CapabilitySyncService(home,dataRoot).acquireOperationLock(),/sync_in_progress/)
  svc.releaseOperationLock(svc.operationLock)
  assert.equal(existsSync(join(displaced,'operation.lock')),true)
  assert.deepEqual((await readdir(dataRoot)).sort(),['canary','transactions'])
})

await test('transactions replacement before transaction setup fails closed without writing or deleting unknown inodes', async () => {
  const {home,dataRoot}=await fixture(),transactions=join(dataRoot,'transactions'),displaced=join(dataRoot,'transactions-displaced'),provider=join(home,'.trae/cli/skills/alpha')
  let swapped=false
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{
    if(stage!=='before-transaction-root-setup'||swapped)return
    swapped=true;renameSync(transactions,displaced);mkdirSync(transactions,{mode:0o700});writeFileSync(join(transactions,'canary'),'unknown inode must survive\n',{mode:0o600})
  })
  const plan=await planSkills(svc),started=svc.execute(executeRequest(plan));await waitFor(()=>swapped)
  assert.equal(svc.getJob(started.id).state,'backing_up');assert.equal(existsSync(provider),false)
  assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
  assert.equal(await readFile(join(transactions,'canary'),'utf8'),'unknown inode must survive\n')
  assert.deepEqual((await readdir(transactions)).sort(),['canary'])
  assert.equal(existsSync(join(displaced,'operation.lock')),false)
  assert.throws(()=>new CapabilitySyncService(home,dataRoot).acquireOperationLock(),/sync_in_progress/)
  svc.releaseOperationLock(svc.operationLock)
  assert.equal(await readFile(join(transactions,'canary'),'utf8'),'unknown inode must survive\n')
})

await test('partial backup failure remains schema-valid and recoverable across restarts', async () => {
  const {home,dataRoot}=await twoTargetFixture()
  for(const name of ['alpha','beta']){const target=join(home,'.trae/cli/skills',name);await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),`original ${name}\n`)}
  const svc=new CapabilitySyncService(home,dataRoot),originalBackup=svc.backupOne.bind(svc);let calls=0
  svc.backupOne=async(...args)=>{await originalBackup(...args);calls++;if(calls===2)throw new Error('injected_partial_backup_failure')}
  const plan=await planSkills(svc,['skill:alpha','skill:beta']),failed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(failed.state,'failed_no_change');assert.equal(failed.errorCode,'backup_failed')
  const firstJournal=await readJournal(dataRoot,failed.transactionId);assert.equal(firstJournal.state,'aborted');assert.equal(firstJournal.entries.some(entry=>!entry.backedUp),true)
  // A terminal progress event is emitted just before startExecution's finally
  // releases the process-wide operation lock. Model an actual restart only
  // after that durability/ownership boundary has drained.
  await waitForOperationUnlock(dataRoot)
  for(let restart=0;restart<2;restart++){const recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover();const snapshot=recovered.getJobSnapshot();assert.equal(snapshot.active,undefined);assert.equal(snapshot.latest.state,'failed_no_change');assert.equal((await recovered.scan({source:'codex',target:'traex'})).executionSupported,true)}
})

await test('durable unpublished transaction is identity-cleaned on startup', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-transaction-journal-durable')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  await waitFor(async()=>{try{const names=await readdir(join(dataRoot,'transactions'));return names.find(name=>name.startsWith('.ua-transaction-preparation-'))}catch(error){if(error?.code==='ENOENT')return;throw error}})
  await waitForOperationUnlock(dataRoot)
  const recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover()
  assert.deepEqual((await readdir(join(dataRoot,'transactions'))).filter(name=>name.startsWith('.ua-transaction-preparation-')),[])
  assert.equal((await recovered.scan({source:'codex',target:'traex'})).executionSupported,true)
  const job=recovered.getJob(started.id);assert.equal(job.state,'failed_no_change');assert.equal(job.errorCode,'startup_recovery');assert.equal(job.transactionId,undefined)
})

await test('authenticated pre-journal preparation is bounded and repeated recovery remains open', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-transaction-preparation-created')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  const transactions=join(dataRoot,'transactions');await waitFor(async()=>{try{return (await readdir(transactions)).some(name=>name.startsWith('.ua-transaction-preparation-'))}catch{return false}});await waitForOperationUnlock(dataRoot)
  for(let restart=0;restart<2;restart++){const recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover();assert.deepEqual((await readdir(transactions)).filter(name=>name.startsWith('.ua-transaction-preparation-')),[]);assert.equal((await recovered.scan({source:'codex',target:'traex'})).executionSupported,true);assert.equal(recovered.getJob(started.id).state,'failed_no_change')}
})

await test('unpublished seed scratch survives repeated recovery without blocking a later transaction', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-transaction-seed-created')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  const transactions=join(dataRoot,'transactions'),seedName=await waitFor(async()=>{try{return (await readdir(transactions)).find(name=>name.startsWith('.ua-transaction-seed-'))}catch{return}});await waitForOperationUnlock(dataRoot)
  const seed=join(transactions,seedName),canary=join(seed,'canary');await writeFile(canary,'seed residue must survive\n',{mode:0o600})
  let recovered
  for(let restart=0;restart<2;restart++){recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover();assert.equal(await readFile(canary,'utf8'),'seed residue must survive\n');assert.equal((await recovered.scan({source:'codex',target:'traex'})).executionSupported,true);assert.equal(recovered.getJob(started.id).state,'failed_no_change')}
  const completed=await waitForTerminal(recovered,recovered.execute(executeRequest(await planSkills(recovered))).id);await waitForOperationUnlock(dataRoot)
  assert.equal(completed.state,'completed');assert.equal(await readFile(canary,'utf8'),'seed residue must survive\n')
})

await test('startup preserves a same-name preparation replacement and fails recovery closed', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-transaction-preparation-created')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  const transactions=join(dataRoot,'transactions'),name=await waitFor(async()=>{try{return (await readdir(transactions)).find(candidate=>candidate.startsWith('.ua-transaction-preparation-'))}catch{return}})
  await waitForOperationUnlock(dataRoot)
  const preparation=join(transactions,name),displaced=join(dataRoot,'displaced-preparation')
  renameSync(preparation,displaced);mkdirSync(preparation,{mode:0o700});writeFileSync(join(preparation,'canary'),'replacement must survive\n',{mode:0o600})

  const recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover()
  assert.equal(await readFile(join(preparation,'canary'),'utf8'),'replacement must survive\n');assert.equal(existsSync(displaced),true)
  const scan=await recovered.scan({source:'codex',target:'traex'});assert.equal(scan.executionSupported,false);assert.equal(scan.blockedReason,'recovery_required')
  assert.equal(recovered.getJob(started.id).state,'failed_no_change')
})

await test('startup preserves a same-name legacy pending replacement and fails recovery closed', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-transaction-publish')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc);svc.execute(executeRequest(plan))
  const transactions=join(dataRoot,'transactions'),transactionId=await waitFor(async()=>{try{return (await readdir(transactions)).find(name=>/^[0-9a-f-]{36}$/.test(name))}catch{return}})
  await waitForOperationUnlock(dataRoot)
  const canonicalDir=join(transactions,transactionId),pending=join(transactions,`.ua-transaction-pending-${transactionId}`),displaced=join(dataRoot,'displaced-legacy-pending')
  renameSync(canonicalDir,displaced);cpSync(displaced,pending,{recursive:true});await chmod(pending,0o700);writeFileSync(join(pending,'canary'),'replacement must survive\n',{mode:0o600})
  const copiedJournal=JSON.parse(await readFile(join(pending,'journal.json'),'utf8'));assert.match(copiedJournal.seal,/^[a-f0-9]{64}$/)

  const recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover()
  assert.equal(await readFile(join(pending,'canary'),'utf8'),'replacement must survive\n');assert.equal(existsSync(displaced),true)
  const scan=await recovered.scan({source:'codex',target:'traex'});assert.equal(scan.executionSupported,false);assert.equal(scan.blockedReason,'recovery_required')
})

await test('precommit startup recovery closes both durable and in-memory job state', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-staging')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  const crashed=await waitFor(async()=>{const job=svc.getJob(started.id);if(!job?.transactionId)return;const journal=await readJournal(dataRoot,job.transactionId);return journal.state==='staging'?journal:undefined})
  await waitForOperationUnlock(dataRoot)
  const recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover();const snapshot=recovered.getJobSnapshot(),job=recovered.getJob(crashed.job.id)
  assert.equal(job.state,'failed_no_change');assert.equal(job.errorCode,'startup_recovery');assert.equal(snapshot.active,undefined);assert.equal(snapshot.latest.id,job.id);assert.equal(snapshot.latest.state,'failed_no_change')
  assert.deepEqual(JSON.parse(await readFile(join(dataRoot,'latest-job.json'),'utf8')),job)
})

await test('source TOCTOU fails before commit and retains every sealed sibling stage', async () => {
  const {home,dataRoot}=await twoTargetFixture(); let changed=false
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{ if(stage==='after-staging'&&!changed){changed=true;writeFileSync(join(home,'.codex/skills/alpha/SKILL.md'),'# Changed\n')} })
  const plan=await planSkills(svc,['skill:alpha','skill:beta']), done=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(done.state,'failed_no_change'); assert.equal(done.errorCode,'stale_plan'); assert.equal(existsSync(join(home,'.trae/cli/skills/alpha')),false)
  const journal=await readJournal(dataRoot,done.transactionId); assert.equal(journal.commitIndex,0); assert.equal(journal.state,'aborted')
  for(const [index,entry] of journal.entries.entries()){const target=join(home,entry.targetRel);assert.equal(existsSync(transactionArtifact(target,'stage',journal.id,index)),false);assert.equal(existsSync(transactionArtifact(target,'rollback',journal.id,index)),false)}
  const after=await svc.scan({source:'codex',target:'traex'});assert.equal(after.targetRevision,plan.targetRevision);assert.equal(after.items.some(item=>item.name.startsWith('.ua-')),false);assert.equal(after.items.filter(item=>item.kind==='skill').every(item=>item.status==='add'),true)
})

await test('stage failure retains sealed sibling stages with a closed stage_failed code', async () => {
  const {home,dataRoot}=await twoTargetFixture(); const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-staging')throw new Error('private path must not escape')})
  const plan=await planSkills(svc,['skill:alpha','skill:beta']), done=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(done.state,'failed_no_change'); assert.equal(done.errorCode,'stage_failed'); assert.equal(JSON.stringify(done).includes(home),false)
  const journal=await readJournal(dataRoot,done.transactionId);assert.equal(journal.commitIndex,0);assert.equal(journal.state,'aborted')
  for(const [index,entry] of journal.entries.entries()){const target=join(home,entry.targetRel);assert.equal(existsSync(transactionArtifact(target,'stage',journal.id,index)),false);assert.equal(existsSync(target),false)}
  const after=await svc.scan({source:'codex',target:'traex'});assert.equal(after.targetRevision,plan.targetRevision);assert.equal(after.items.some(item=>item.name.startsWith('.ua-')),false);assert.equal(after.items.filter(item=>item.kind==='skill').every(item=>item.status==='add'),true)
})

await test('multi-stage creation crash records each visible root and repeated recovery clears all artifacts', async () => {
  const {home,dataRoot}=await twoTargetFixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-stage-owned-1')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc,['skill:alpha','skill:beta']),started=svc.execute(executeRequest(plan))
  const crashed=await waitFor(async()=>{const job=svc.getJob(started.id);if(!job?.transactionId)return;const journal=await readJournal(dataRoot,job.transactionId);return journal.entries.filter(entry=>entry.stageIdentity).length===2?journal:undefined});await waitForOperationUnlock(dataRoot)
  for(let restart=0;restart<2;restart++){const recovered=new CapabilitySyncService(home,dataRoot);await recovered.recover();assert.equal((await recovered.scan({source:'codex',target:'traex'})).executionSupported,true);const journal=await readJournal(dataRoot,crashed.id);assert.equal(journal.state,'aborted');for(const [index,entry] of journal.entries.entries())assert.equal(existsSync(transactionArtifact(join(home,entry.targetRel),'stage',journal.id,index)),false)}
})

await test('cancellation after a commit invokes rollback and restores all targets', async () => {
  const {home,dataRoot}=await twoTargetFixture(); for(const name of ['alpha','beta']){const dir=join(home,'.trae/cli/skills',name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'SKILL.md'),`original ${name}\n`)}
  let started; const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0')svc.cancel(started.id)}), plan=await planSkills(svc,['skill:alpha','skill:beta'])
  started=svc.execute(executeRequest(plan)); const done=await waitForTerminal(svc,started.id)
  assert.equal(done.state,'cancelled'); assert.equal(done.errorCode,'cancelled'); assert.equal(done.stage,'rollback_completed'); assert.equal(done.result.rolledBack,1)
  for(const name of ['alpha','beta'])assert.equal(await readFile(join(home,'.trae/cli/skills',name,'SKILL.md'),'utf8'),`original ${name}\n`)
  const journal=await readJournal(dataRoot,done.transactionId); assert.equal(journal.commitIndex,1); assert.equal(journal.rollbackIndex,1); assert.equal(journal.state,'rolled_back')
})

await test('backup digest blocks a corrupted manual rollback', async () => {
  const {home,dataRoot}=await fixture(), target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot), plan=await planSkills(svc), done=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id), journal=await readJournal(dataRoot,done.transactionId)
  const entry=journal.entries[0]; assert.match(entry.digest,/^[a-f0-9]{64}$/); await writeFile(join(dataRoot,'transactions',done.transactionId,'backup',entry.backupName,'SKILL.md'),'tampered\n')
  await assert.rejects(()=>svc.rollback(done.transactionId),/invalid_journal/); assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'# Alpha\n')
})

await test('manual rollback durably reaches rolled_back and stays terminal after restart', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot),plan=await planSkills(svc),completed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  const rolledBack=await svc.rollback(completed.transactionId);assert.equal(rolledBack.state,'rolled_back');assert.equal(rolledBack.errorCode,undefined);assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'original\n')
  let journal=await readJournal(dataRoot,completed.transactionId);assert.equal(journal.state,'rolled_back');assert.equal(journal.job.state,'rolled_back');assert.equal(journal.rollbackIndex,journal.commitIndex)
  const restarted=new CapabilitySyncService(home,dataRoot);await restarted.recover();const recovered=restarted.getJob(rolledBack.id);assert.equal(recovered.state,'rolled_back');assert.equal(recovered.errorCode,undefined)
  journal=await readJournal(dataRoot,completed.transactionId);assert.equal(journal.state,'rolled_back');assert.equal(journal.job.errorCode,undefined)
})

await test('snapshot keeps one narrow completed rollback candidate across restart and later failure', async () => {
  const {home,dataRoot}=await twoTargetFixture()
  const svc=new CapabilitySyncService(home,dataRoot),firstPlan=await planSkills(svc,['skill:alpha'])
  const completed=await waitForTerminal(svc,svc.execute(executeRequest(firstPlan)).id)
  const firstSnapshot=svc.getJobSnapshot()
  assert.equal(firstSnapshot.rollbackCandidate.state,'completed')
  assert.match(firstSnapshot.rollbackCandidate.transactionId,/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(firstSnapshot.rollbackCandidate.transactionId,completed.transactionId)

  await waitForOperationUnlock(dataRoot)
  const restarted=new CapabilitySyncService(home,dataRoot)
  await restarted.recover()
  assert.equal(restarted.getJobSnapshot().rollbackCandidate.transactionId,completed.transactionId)

  const laterPlan=await planSkills(restarted,['skill:beta'])
  await writeFile(join(home,'.codex/skills/beta/SKILL.md'),'# Changed after plan\n')
  const failed=await waitForTerminal(restarted,restarted.execute(executeRequest(laterPlan)).id)
  const afterFailure=restarted.getJobSnapshot()
  assert.equal(failed.state,'failed_no_change')
  assert.equal(afterFailure.latest.id,failed.id)
  assert.equal(afterFailure.rollbackCandidate.transactionId,completed.transactionId)

  const rolledBack=await restarted.rollback(completed.transactionId)
  assert.equal(rolledBack.state,'rolled_back')
  assert.equal(restarted.getJobSnapshot().rollbackCandidate,undefined)
})

await test('durable transaction order enforces global LIFO with equal and backward clocks', async () => {
  const realNow=Date.now,{home,dataRoot}=await twoTargetFixture(),svc=new CapabilitySyncService(home,dataRoot);let tick=10_000;Date.now=()=>tick
  try{
    const first=await waitForTerminal(svc,svc.execute(executeRequest(await planSkills(svc,['skill:alpha']))).id);await waitForOperationUnlock(dataRoot);tick=9_000
    const second=await waitForTerminal(svc,svc.execute(executeRequest(await planSkills(svc,['skill:beta']))).id);await waitForOperationUnlock(dataRoot)
    const one=await readJournal(dataRoot,first.transactionId),two=await readJournal(dataRoot,second.transactionId);assert.equal(one.version,4);assert.equal(one.transactionRootIdentity.type,'directory');assert.equal(two.transactionOrder,one.transactionOrder+1);assert.equal(svc.getJobSnapshot().rollbackCandidate.transactionId,second.transactionId)
    await assert.rejects(()=>svc.rollback(first.transactionId),/transaction_not_rollbackable/);assert.equal((await svc.rollback(second.transactionId)).state,'rolled_back');assert.equal(svc.getJobSnapshot().rollbackCandidate.transactionId,first.transactionId)
    const restarted=new CapabilitySyncService(home,dataRoot);await restarted.recover();assert.equal(restarted.getJobSnapshot().rollbackCandidate.transactionId,first.transactionId)
  }finally{Date.now=realNow}
})

await test('manual rollback failure is published and blocks same-process execution until recovery', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot),plan=await planSkills(svc),completed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  svc.restore=async()=>{throw new Error('injected_restore_failure')}
  const failed=await svc.rollback(completed.transactionId);assert.equal(failed.state,'rollback_failed');assert.equal(failed.errorCode,'rollback_failed');assert.equal(failed.stage,'recovery_required');assert.equal(svc.getJob(failed.id).state,'rollback_failed')
  let journal=await readJournal(dataRoot,completed.transactionId);assert.equal(journal.state,'rolling_back');assert.equal(journal.job.state,'rollback_failed')
  const blockedScan=await svc.scan({source:'codex',target:'traex'});assert.equal(blockedScan.executionSupported,false);assert.equal(blockedScan.blockedReason,'recovery_required')
  assert.throws(()=>svc.execute(executeRequest(plan)),/recovery_required/)
  const restarted=new CapabilitySyncService(home,dataRoot);await restarted.recover();assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'original\n')
  journal=await readJournal(dataRoot,completed.transactionId);assert.equal(journal.state,'rolled_back');assert.equal(journal.job.state,'rolled_back');assert.equal(journal.job.errorCode,'startup_recovery')
  assert.equal((await restarted.scan({source:'codex',target:'traex'})).executionSupported,true)
})

await test('automatic rollback failure immediately blocks same-process execution until recovery', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0')throw new Error('force_automatic_rollback')});svc.restore=async()=>{throw new Error('injected_restore_failure')}
  const plan=await planSkills(svc),failed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id);assert.equal(failed.state,'rollback_failed');assert.equal(failed.errorCode,'rollback_failed');assert.equal(failed.stage,'recovery_required')
  assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required');assert.equal(svc.getJobSnapshot().rollbackCandidate,undefined);assert.throws(()=>svc.execute(executeRequest(plan)),/recovery_required/)
})

await test('automatic rollback refuses to overwrite a post-commit external edit', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0'){writeFileSync(join(target,'SKILL.md'),'external during rollback window\n');throw new Error('force_automatic_rollback')}}),plan=await planSkills(svc)
  const failed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(failed.state,'rollback_failed');assert.equal(failed.errorCode,'rollback_failed');assert.equal(failed.stage,'recovery_required');assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'external during rollback window\n')
  const blocked=await svc.scan({source:'codex',target:'traex'});assert.equal(blocked.executionSupported,false);assert.equal(blocked.blockedReason,'recovery_required');assert.throws(()=>svc.execute(executeRequest(plan)),/recovery_required/)
})

await test('manual rollback refuses to overwrite a post-completion external edit', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot),plan=await planSkills(svc),completed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  await writeFile(join(target,'SKILL.md'),'external after completion\n')
  await assert.rejects(()=>svc.rollback(completed.transactionId),/target_changed_since_commit/);assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'external after completion\n')
  const journal=await readJournal(dataRoot,completed.transactionId);assert.equal(journal.state,'completed');assert.equal(journal.job.state,'completed');assert.equal(journal.rollbackIndex,0)
})

await test('journal HMAC rejects combined backup digest and target tampering without the external key', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot),plan=await planSkills(svc),completed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id),journal=await readJournal(dataRoot,completed.transactionId)
  const entry=journal.entries[0],backupRoot=join(dataRoot,'transactions',completed.transactionId,'backup',entry.backupName),backup=join(backupRoot,'SKILL.md');await writeFile(backup,'attacker backup\n')
  entry.digest=await transactionDigest(backupRoot);entry.targetRel='.trae/cli/config.toml';await writeFile(join(dataRoot,'transactions',completed.transactionId,'journal.json'),JSON.stringify(journal),{mode:0o600})
  await assert.rejects(()=>svc.rollback(completed.transactionId),/invalid_journal/);assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'# Alpha\n')
  const restarted=new CapabilitySyncService(home,dataRoot);await restarted.recover();assert.equal((await restarted.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
})

await test('journal HMAC accepts the canonical persisted seal and keeps its key private outside transactions', async () => {
  const {createHmac}=await import('node:crypto'),{home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot),plan=await planSkills(svc),completed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id),journal=await readJournal(dataRoot,completed.transactionId)
  const keyPath=join(dataRoot,'journal-seal.key'),keyInfo=await stat(keyPath),key=await readFile(keyPath),expected=createHmac('sha256',key).update(canonical({...journal,seal:''})).digest('hex')
  assert.equal(keyInfo.mode&0o077,0);assert.equal(key.length,32);assert.equal(expected,journal.seal);assert.equal(existsSync(join(dataRoot,'transactions',completed.transactionId,'journal-seal.key')),false)
})

await test('commit window target mutation is rejected before rename with no overwrite', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n');let mutated=false
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='before-commit-0'&&!mutated){mutated=true;writeFileSync(join(target,'SKILL.md'),'external in commit window\n')}}),plan=await planSkills(svc),done=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(done.state,'failed_no_change');assert.equal(done.errorCode,'stale_plan');assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'external in commit window\n')
  const journal=await readJournal(dataRoot,done.transactionId);assert.equal(journal.commitIndex,0);assert.equal(journal.state,'rolled_back')
})

await test('commit install refuses a target created after the original moved to rollback slot', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='before-install-0'){mkdirSync(target,{recursive:true});writeFileSync(join(target,'SKILL.md'),'external after slot\n')}}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan));await waitForOperationUnlock(dataRoot)
  assert.equal(svc.getJob(started.id).state,'committing');assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'external after slot\n')
  assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required');assert.throws(()=>svc.execute(executeRequest(plan)),/recovery_required/)
})

await test('commit install rejects a same-name stage replacement without inverse-moving the rollback slot', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  let displacedStage,replacementStage,started
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='before-install-0'){const job=svc.getJob(started.id);replacementStage=transactionArtifact(target,'stage',job.transactionId,0);displacedStage=replacementStage+'-sealed';renameSync(replacementStage,displacedStage);mkdirSync(replacementStage,{mode:0o700});writeFileSync(join(replacementStage,'SKILL.md'),'replacement must not install\n',{mode:0o600})}}),plan=await planSkills(svc);started=svc.execute(executeRequest(plan));await waitForOperationUnlock(dataRoot);const failed=svc.getJob(started.id)
  assert.equal(failed.state,'committing')
  assert.equal(existsSync(target),false);assert.equal(await readFile(join(replacementStage,'SKILL.md'),'utf8'),'replacement must not install\n');assert.equal(await readFile(join(displacedStage,'SKILL.md'),'utf8'),'# Alpha\n')
  const journal=await readJournal(dataRoot,failed.transactionId),slot=transactionArtifact(target,'rollback',journal.id,0);assert.equal(journal.commitIndex,1);assert.equal(journal.rollbackIndex,0);assert.equal(await readFile(join(slot,'SKILL.md'),'utf8'),'original\n');assert.equal(journal.renameIntent.leg,'stage_to_target')
  assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
})

await test('commit window parent replacement is rejected without writing through the swapped path', async () => {
  const {home,dataRoot}=await fixture(),skills=join(home,'.trae/cli/skills'),moved=join(home,'.trae/cli/skills-original'),outside=join(home,'outside-skills');await mkdir(outside,{recursive:true});let swapped=false
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='before-commit-0'&&!swapped){swapped=true;writeFileSync(join(outside,'canary'),'safe\n');renameSync(skills,moved);symlinkSync(outside,skills)}}),plan=await planSkills(svc),done=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(done.state,'failed_no_change');assert.equal(done.errorCode,'stale_plan');assert.equal(await readFile(join(outside,'canary'),'utf8'),'safe\n');assert.equal(existsSync(join(outside,'alpha')),false)
  const journal=await readJournal(dataRoot,done.transactionId);assert.equal(journal.commitIndex,0);assert.equal(journal.state,'rolled_back')
})

await test('rollback preserves a target created after quarantine and fails closed', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  let injected=false
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0')throw new Error('force_rollback');if(stage==='after-restore-quarantine-0'&&!injected){injected=true;mkdirSync(target,{recursive:true});writeFileSync(join(target,'SKILL.md'),'external after quarantine\n')}}),plan=await planSkills(svc),failed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(failed.state,'rollback_failed');assert.equal(failed.errorCode,'rollback_failed');assert.equal(failed.stage,'recovery_required');assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'external after quarantine\n')
  const journal=await readJournal(dataRoot,failed.transactionId),slot=transactionArtifact(target,'rollback',journal.id,0),post=transactionArtifact(target,'post',journal.id,0)
  assert.equal(journal.state,'rolling_back');assert.equal(journal.rollbackIndex,0);assert.equal(await readFile(join(slot,'SKILL.md'),'utf8'),'original\n');assert.equal(await readFile(join(post,'SKILL.md'),'utf8'),'# Alpha\n');assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
})

await test('rollback parent replacement writes nothing into the replacement or outside tree', async () => {
  const {home,dataRoot}=await fixture(),skills=join(home,'.trae/cli/skills'),moved=join(home,'.trae/cli/skills-before-rollback'),outside=join(home,'outside-rollback'),target=join(skills,'alpha')
  await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n');await mkdir(outside,{recursive:true});await writeFile(join(outside,'canary'),'safe\n')
  let swapped=false
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0')throw new Error('force_rollback');if(stage==='after-restore-quarantine-0'&&!swapped){swapped=true;renameSync(skills,moved);symlinkSync(outside,skills)}}),plan=await planSkills(svc),failed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id)
  assert.equal(failed.state,'rollback_failed');assert.equal(failed.errorCode,'rollback_failed');assert.equal(failed.stage,'recovery_required');assert.equal(await readFile(join(outside,'canary'),'utf8'),'safe\n');assert.deepEqual((await readdir(outside)).sort(),['canary']);assert.equal((await lstat(skills)).isSymbolicLink(),true)
  const journal=await readJournal(dataRoot,failed.transactionId),movedTarget=join(moved,'alpha');assert.equal(journal.state,'rolling_back');assert.equal(journal.rollbackIndex,0);assert.equal(existsSync(movedTarget),false);assert.equal(await readFile(join(transactionArtifact(movedTarget,'rollback',journal.id,0),'SKILL.md'),'utf8'),'original\n');assert.equal(await readFile(join(transactionArtifact(movedTarget,'post',journal.id,0),'SKILL.md'),'utf8'),'# Alpha\n')
})

await test('preexisting post-quarantine collision is preserved and blocks rollback', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  let collision
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0'){const job=svc.getJob(started.id);collision=transactionArtifact(target,'post',job.transactionId,0);mkdirSync(collision,{recursive:true});writeFileSync(join(collision,'canary'),'collision must survive\n');throw new Error('force_rollback')}}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan)),failed=await waitForTerminal(svc,started.id)
  assert.equal(failed.state,'rollback_failed');assert.equal(failed.errorCode,'rollback_failed');assert.equal(failed.stage,'recovery_required');assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'# Alpha\n');assert.equal(await readFile(join(collision,'canary'),'utf8'),'collision must survive\n')
  const journal=await readJournal(dataRoot,failed.transactionId);assert.equal(journal.state,'rolling_back');assert.equal(journal.rollbackIndex,0);assert.equal(await readFile(join(transactionArtifact(target,'rollback',journal.id,0),'SKILL.md'),'utf8'),'original\n')
})

await test('cleanup consumes the identity validated before deletion and preserves a replacement', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-staging')throw new Error('force_cleanup')}),plan=await planSkills(svc)
  const remove=svc.removeOwnedPath.bind(svc);let replacement,moved,swapped=false;svc.removeOwnedPath=(path,identity)=>{if(path.includes('.ua-stage-')&&!swapped){swapped=true;moved=path+'-original';replacement=path;renameSync(path,moved);mkdirSync(path,{recursive:true});writeFileSync(join(path,'canary'),'replacement\n')}return remove(path,identity)}
  const failed=await waitForTerminal(svc,svc.execute(executeRequest(plan)).id);assert.equal(failed.state,'failed_no_change');assert.equal(await readFile(join(replacement,'canary'),'utf8'),'replacement\n');assert.equal(existsSync(moved),true);assert.equal((await svc.scan({source:'codex',target:'traex'})).blockedReason,'recovery_required')
})

await test('runtime terminal maintenance retains at most eight transactions without restart', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot),transactions=join(dataRoot,'transactions')
  for(let index=0;index<10;index++){await writeFile(join(home,'.codex/skills/alpha/SKILL.md'),`# Alpha ${index}\n`);const done=await waitForTerminal(svc,svc.execute(executeRequest(await planSkills(svc))).id);assert.equal(done.state,'completed');await waitForOperationUnlock(dataRoot);await waitFor(async()=>{const names=(await readdir(transactions)).filter(name=>/^[0-9a-f-]{36}$/.test(name));return names.length<=8})}
  const names=(await readdir(transactions)).filter(name=>/^[0-9a-f-]{36}$/.test(name));assert.equal(names.length,8);assert.equal(names.includes(svc.getJobSnapshot().rollbackCandidate.transactionId),true)
})

await test('runtime terminal maintenance prunes repeated aborts without restart', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-staging')throw new Error('abort_before_commit')}),transactions=join(dataRoot,'transactions')
  for(let index=0;index<10;index++){const done=await waitForTerminal(svc,svc.execute(executeRequest(await planSkills(svc))).id);assert.equal(done.state,'failed_no_change');await waitForOperationUnlock(dataRoot);await waitFor(async()=>((await readdir(transactions)).filter(name=>/^[0-9a-f-]{36}$/.test(name)).length<=8))}
  assert.equal((await readdir(transactions)).filter(name=>/^[0-9a-f-]{36}$/.test(name)).length,8)
})

await test('terminal retention preserves a same-name transaction-root replacement and fails closed', async () => {
  const {home,dataRoot}=await fixture(),svc=new CapabilitySyncService(home,dataRoot),transactions=join(dataRoot,'transactions')
  const prune=svc.pruneTerminalArtifacts.bind(svc);svc.pruneTerminalArtifacts=async()=>{};let oldestId
  for(let index=0;index<9;index++){await writeFile(join(home,'.codex/skills/alpha/SKILL.md'),`# Alpha retention ${index}\n`);const done=await waitForTerminal(svc,svc.execute(executeRequest(await planSkills(svc))).id);assert.equal(done.state,'completed');oldestId||=done.transactionId;await waitForOperationUnlock(dataRoot)}
  svc.pruneTerminalArtifacts=prune
  const oldest=join(transactions,oldestId),displaced=join(dataRoot,'displaced-terminal-transaction')
  renameSync(oldest,displaced);cpSync(displaced,oldest,{recursive:true});await chmod(oldest,0o700);writeFileSync(join(oldest,'canary'),'replacement must survive\n',{mode:0o600})
  await svc.runTerminalMaintenance(false)
  assert.equal(await readFile(join(oldest,'canary'),'utf8'),'replacement must survive\n');assert.equal(existsSync(displaced),true)
  const scan=await svc.scan({source:'codex',target:'traex'});assert.equal(scan.executionSupported,false);assert.equal(scan.blockedReason,'recovery_required')
})

await test('malicious journals are rejected without touching external canaries', async () => {
  for(const mutate of [j=>{j.entries[0].targetRel='../outside'},j=>{j.entries[0].targetRel='.trae/cli/../cli/config.toml'},j=>{j.entries[0].targetRel='.codex/config.toml'},j=>{j.entries[0].backupName='../x'},j=>{j.job.errorCode='/private/secret'}]){
    const {home,dataRoot}=await fixture(), canary=join(home,'outside');await writeFile(canary,'safe\n');const id=randomUUID(),dir=join(dataRoot,'transactions',id);await mkdir(join(dir,'backup'),{recursive:true,mode:0o700});await chmod(dir,0o700);const now=Date.now(),planId=randomUUID()
    const journal={version:1,id,provider:'traex',sharedAgents:false,planId,state:'backing_up',commitIndex:0,rollbackIndex:0,createdAt:now,updatedAt:now,entries:[{targetRel:'.trae/cli/config.toml',backupName:'0',existed:false,backedUp:false}],job:{id:randomUUID(),planId,transactionId:id,state:'backing_up',stage:'backing_up',progress:{completed:0,total:1},updatedAt:now}}
    mutate(journal);await writeFile(join(dir,'journal.json'),JSON.stringify(journal),{mode:0o600});const svc=new CapabilitySyncService(home,dataRoot);await svc.recover();assert.equal(await readFile(canary,'utf8'),'safe\n');const scan=await svc.scan({source:'codex',target:'traex'});assert.equal(scan.blockedReason,'recovery_required');await assert.rejects(()=>svc.rollback(id),/invalid_journal/)
  }
})

await test('durable per-target crash progress is recovered on startup', async () => {
  const {home,dataRoot}=await twoTargetFixture();for(const name of ['alpha','beta']){const dir=join(home,'.trae/cli/skills',name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'SKILL.md'),`original ${name}\n`)}
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc,['skill:alpha','skill:beta']),started=svc.execute(executeRequest(plan))
  const crashed=await waitFor(async()=>{const job=svc.getJob(started.id);if(!job?.transactionId)return;try{const j=await readJournal(dataRoot,job.transactionId);return j.commitIndex===1&&!j.renameIntent?j:undefined}catch{return}});assert.equal(crashed.state,'committing');assert.equal(crashed.job.progress.total,2)
  await waitForOperationUnlock(dataRoot)
  const recoveredSvc=new CapabilitySyncService(home,dataRoot);await recoveredSvc.recover();const recovered=recoveredSvc.getJob(crashed.job.id);assert.equal(recovered.state,'rolled_back');assert.equal(recovered.errorCode,'startup_recovery')
  for(const name of ['alpha','beta'])assert.equal(await readFile(join(home,'.trae/cli/skills',name,'SKILL.md'),'utf8'),`original ${name}\n`)
  const journal=await readJournal(dataRoot,crashed.id);assert.equal(journal.commitIndex,1);assert.equal(journal.rollbackIndex,1);assert.equal((await recoveredSvc.scan({source:'codex',target:'traex'})).executionSupported,true)
})

for(const crashStage of ['after-restore-quarantine-0','after-restore-install-0','after-restore-0']) await test(`startup captures transaction-owned rollback progress at ${crashStage}`, async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),'original\n')
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0')throw new Error('force_rollback');if(stage===crashStage)throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  const crashed=await waitFor(async()=>{const job=svc.getJob(started.id);if(!job?.transactionId)return;const journal=await readJournal(dataRoot,job.transactionId);return journal.state==='rolling_back'&&journal.rollbackIndex===0?journal:undefined})
  await waitForOperationUnlock(dataRoot)
  const recoveredSvc=new CapabilitySyncService(home,dataRoot);await recoveredSvc.recover();const recovered=recoveredSvc.getJob(crashed.job.id)
  assert.equal(recovered.state,'rolled_back');assert.equal(recovered.errorCode,'startup_recovery');assert.equal(await readFile(join(target,'SKILL.md'),'utf8'),'original\n')
  const journal=await readJournal(dataRoot,crashed.id);assert.equal(journal.rollbackIndex,1);assert.equal(journal.commitIndex,1);assert.equal(journal.state,'rolled_back')
})

await test('startup captures an originally absent target removed before rollback progress persisted', async () => {
  const {home,dataRoot}=await fixture(),target=join(home,'.trae/cli/skills/alpha');assert.equal(existsSync(target),false)
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-0')throw new Error('force_rollback');if(stage==='after-restore-quarantine-0')throw new CapabilitySyncSimulatedCrash()}),plan=await planSkills(svc),started=svc.execute(executeRequest(plan))
  const crashed=await waitFor(async()=>{const job=svc.getJob(started.id);if(!job?.transactionId)return;const journal=await readJournal(dataRoot,job.transactionId);return journal.state==='rolling_back'&&journal.rollbackIndex===0?journal:undefined})
  await waitForOperationUnlock(dataRoot)
  assert.equal(existsSync(target),false)
  const recoveredSvc=new CapabilitySyncService(home,dataRoot);await recoveredSvc.recover();const recovered=recoveredSvc.getJob(crashed.job.id)
  assert.equal(recovered.state,'rolled_back');assert.equal(recovered.errorCode,'startup_recovery');assert.equal(existsSync(target),false)
  const journal=await readJournal(dataRoot,crashed.id);assert.equal(journal.rollbackIndex,1);assert.equal(journal.commitIndex,1);assert.equal(journal.state,'rolled_back')
})

await test('startup resumes a symlink restore artifact left between removal and rename', async () => {
  const {home,dataRoot}=await fixture(),shared=join(home,'.agents/AGENTS.md'),target=join(home,'.trae/cli/AGENTS.md');await writeFile(shared,'# Shared\nOriginal\n');await rm(target);await symlink(shared,target)
  const svc=new CapabilitySyncService(home,dataRoot,stage=>{if(stage==='after-commit-2')throw new Error('force_rollback');if(stage==='after-restore-quarantine-2')throw new CapabilitySyncSimulatedCrash()})
  const scan=await svc.scan({source:'codex',target:'traex'}),plan=svc.plan({scanId:scan.id,mode:'merge',cloneCategories:[],selections:['global-instructions:agents'],resolutions:{},agentsStrategy:'keep-codex'}),started=svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex'}})
  const crashed=await waitFor(async()=>{const job=svc.getJob(started.id);if(!job?.transactionId)return;const journal=await readJournal(dataRoot,job.transactionId);return journal.state==='rolling_back'&&journal.rollbackIndex===0?journal:undefined})
  await waitForOperationUnlock(dataRoot)
  assert.equal(existsSync(target),false);assert.equal((await lstat(transactionArtifact(target,'post',crashed.id,2))).isSymbolicLink(),true)
  const recoveredSvc=new CapabilitySyncService(home,dataRoot);await recoveredSvc.recover();const recovered=recoveredSvc.getJob(crashed.job.id)
  assert.equal(recovered.state,'rolled_back');assert.equal(recovered.errorCode,'startup_recovery');assert.equal((await lstat(target)).isSymbolicLink(),true);assert.equal(await readFile(target,'utf8'),'# Shared\nOriginal\n')
  const journal=await readJournal(dataRoot,crashed.id);assert.equal(journal.rollbackIndex,3);assert.equal(journal.commitIndex,3);assert.equal(journal.state,'rolled_back')
})

for (const strategy of ['keep-codex','keep-traex','merge']) await test(`AGENTS shared source ${strategy}, inode and no-op`, async () => {
  const {home,dataRoot}=await fixture(), svc=new CapabilitySyncService(home,dataRoot); const scan=await svc.scan({source:'codex',target:'traex'}); const plan=svc.plan({scanId:scan.id,mode:'merge',cloneCategories:[],selections:['global-instructions:agents'],resolutions:{},agentsStrategy:strategy}); const started=svc.execute({...executeRequest(plan),confirmation:{acknowledged:true,targetName:'traex'}}); const job=await waitForTerminal(svc,started.id); assert.equal(job.state,'completed')
  const shared=join(home,'.agents/AGENTS.md'), codex=join(home,'.codex/AGENTS.md'), trae=join(home,'.trae/cli/AGENTS.md'); assert.equal(await realpath(codex),await realpath(shared)); assert.equal(await realpath(trae),await realpath(shared)); assert.equal((await stat(codex)).ino,(await stat(trae)).ino)
  const scan2=await svc.scan({source:'codex',target:'traex'}); assert.equal(scan2.items.find(x=>x.id==='global-instructions:agents').status,'same')
})

console.log(`${passed} capability-sync tests passed`)

// Req3 UI/IPC contract checks are intentionally appended so the core service
// scenarios above remain independently editable by the other sync agents.
await test('capability sync IPC trusts only the main window main frame at the configured origin', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(source, /sender !== window\.webContents/)
  assert.match(source, /frame !== window\.webContents\.mainFrame/)
  assert.match(source, /actual\.origin !== expected\.origin/)
  assert.match(source, /actual\.host !== expected\.host/)
  assert.match(source, /pathToFileURL\(resolveUiPath\('renderer\/index\.html'\)\)/)
  assert.match(source, /publicCapabilitySyncError/)
  assert.match(source, /target_changed_since_commit/)
  assert.match(source, /invalid_journal/)
  assert.match(source, /publicCapabilityScan/)
  assert.match(source, /publicCapabilityPlan/)
  assert.match(source, /publicCapabilitySyncJob/)
  assert.match(source, /publicCapabilityRollbackCandidate/)
  assert.match(source, /const safe = publicCapabilitySyncJob\(job\)/)
  assert.match(source, /safe\.state !== 'completed' \|\| !safe\.transactionId/)
  assert.match(source, /rollbackCandidate: publicCapabilityRollbackCandidate\(snapshot\.rollbackCandidate\)/)
  assert.match(source, /isTrustedCapabilitySyncRenderer\(window\.webContents, window\.webContents\.mainFrame\)/)
  assert.match(source, /capability_sync_failed/)
  assert.doesNotMatch(source, /url\.startsWith\('file:'\)/)
})

await test('capability sync IPC validates UUID operations and AGENTS-only preview', async () => {
  const shared = await import('../src/shared/capabilitySync.ts')
  const uuid = '123e4567-e89b-42d3-a456-426614174000'
  assert.deepEqual(shared.parseCapabilityPreviewRequest(uuid, 'global-instructions:agents', 'keep-shared'), {
    scanId: uuid, itemId: 'global-instructions:agents', strategy: 'keep-shared'
  })
  assert.throws(() => shared.parseCapabilityPreviewRequest(uuid, 'memory:agents', 'merge'), /invalid_preview_request/)
  assert.throws(() => shared.parseCapabilityPreviewRequest('../scan', 'global-instructions:agents', 'merge'), /invalid_preview_request/)
  const job = { id: uuid, planId: uuid, transactionId: uuid, state: 'completed', updatedAt: 1 }
  assert.equal(shared.isPublicCapabilityRollbackCandidate(job), true)
  assert.equal(shared.isPublicCapabilityRollbackCandidate({ ...job, state: 'failed_no_change' }), false)
  assert.equal(shared.isPublicCapabilityRollbackCandidate({ ...job, transactionId: '../transaction' }), false)
  assert.equal(shared.isPublicCapabilityRollbackCandidate({ ...job, journalPath: '/private/secret' }), false)
  assert.deepEqual(shared.parseCapabilityPluginActionRequest({ id: 'opaque-plugin-id', action: 'migrate', targetAgentId: 'traex' }), {
    id: 'opaque-plugin-id', action: 'migrate', targetAgentId: 'traex'
  })
  assert.deepEqual(shared.parseCapabilityPluginActionRequest({ id: 'opaque-plugin-id', action: 'uninstall' }), {
    id: 'opaque-plugin-id', action: 'uninstall', targetAgentId: undefined
  })
  assert.throws(() => shared.parseCapabilityPluginActionRequest({ id: 'opaque-plugin-id', action: 'migrate' }), /invalid_capability_plugin_action/)
  assert.throws(() => shared.parseCapabilityPluginActionRequest({ id: 'opaque-plugin-id', action: 'uninstall', targetAgentId: 'codex' }), /invalid_capability_plugin_action/)
  assert.throws(() => shared.parseCapabilityPluginActionRequest({ id: 'opaque-plugin-id', action: 'migrate', targetAgentId: 'codex', extra: true }), /invalid_capability_plugin_action/)

  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(source, /parseCapabilityJobRequest[\s\S]*isUuid\(dto\.jobId\)/)
  assert.match(source, /parseCapabilityCancelRequest[\s\S]*isUuid\(dto\.jobId\)/)
  assert.match(source, /parseCapabilityRollbackRequest[\s\S]*isUuid\(dto\.transactionId\)/)
  assert.match(source, /parseCapabilityPreviewRequest\(dto\.scanId, dto\.itemId, dto\.strategy\)/)
  assert.match(source, /parseCapabilityPluginActionRequest\(value\)/)
  assert.doesNotMatch(source, /strategy as any/)
})

await test('capability sync UI invalidates stale plans, gates async replies, and recovers one tracked job', async () => {
  const panel = await readFile(new URL('../src/renderer/components/CapabilitySyncPanel.tsx', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  assert.match(panel, /planInputGeneration\.current \+= 1/)
  assert.match(panel, /generation !== scanGeneration\.current/)
  assert.match(panel, /inputGeneration !== planInputGeneration\.current/)
  assert.match(panel, /requestGeneration !== planRequestGeneration\.current/)
  assert.match(panel, /generation === previewGeneration\.current/)
  assert.match(panel, /expectedSourceRevision: immutablePlan\.sourceRevision/)
  assert.match(panel, /expectedTargetRevision: immutablePlan\.targetRevision/)
  assert.match(panel, /executeInFlight\.current/)
  assert.match(panel, /candidate\.operation === 'remove-selected'/)
  assert.match(panel, /snapshot\.rollbackCandidate\?\.operation !== 'remove-selected'/)
  assert.match(panel, /recoveryProgress/)
  assert.match(panel, /compareCapabilitySyncJobs\(candidate, latest\) > 0/)
  assert.match(panel, /compareCapabilitySyncJobs\(candidate, current\) <= 0/)
  assert.match(panel, /sameTrackedJob\(tracking, candidate\)/)
  assert.match(panel, /sameTrackedJob\(tracking, recovered\)/)
  assert.match(panel, /const transactionId = rollbackCandidate\.transactionId/)
  assert.doesNotMatch(panel, /job\.transactionId\)\)/)
  assert.match(panel, /rollbackCandidate && <button/)
  assert.match(panel, /plan\.source} → {plan\.target/)
  assert.match(panel, /value="keep-shared"/)
  assert.match(preload, /capabilitySyncGetJobSnapshot/)
})

await test('capability center exposes top-level navigation, filters, safe removal, and refresh hooks', async () => {
  const app=await readFile(new URL('../src/renderer/App.tsx',import.meta.url),'utf8')
  const settings=await readFile(new URL('../src/renderer/components/SettingsPanel.tsx',import.meta.url),'utf8')
  const panel=await readFile(new URL('../src/renderer/components/AgentCapabilitiesPanel.tsx',import.meta.url),'utf8')
  const preload=await readFile(new URL('../src/preload/index.ts',import.meta.url),'utf8')
  // 工具能力 moved from a standalone sidebar entry into the 设置页 category nav.
  assert.match(settings,/工具能力/);assert.match(app,/panel === 'capabilities'/)
  assert.match(panel,/搜索工具能力/);assert.match(panel,/能力类型筛选/);assert.match(panel,/AGENT_NAMES/);assert.match(panel,/capabilityMutationPlanRemove/)
  assert.match(panel,/Plugin/);assert.match(panel,/移除链接/);assert.match(panel,/卸载插件/);assert.match(panel,/capabilityPluginAction/)
  assert.match(panel,/async function removeItem/);assert.match(panel,/void removeItem\(item\)/)
  assert.match(panel,/deleteCount: immutablePlan.destructiveCount/);assert.match(panel,/请重启目标 Agent/);assert.match(panel,/item.manageable/)
  assert.match(panel,/next.operation !== 'remove-selected'/);assert.match(panel,/snapshot.active\?\.operation === 'remove-selected'/);assert.match(panel,/onCapabilityInventoryChanged/)
  assert.match(preload,/capabilityInventoryList/);assert.match(preload,/capabilityPluginAction/);assert.match(preload,/capabilitySkillLinkRemove/);assert.match(preload,/onCapabilityInventoryChanged/)
})

await test('capability compare only selects source-only additions when execution is supported', async () => {
  const panel=await readFile(new URL('../src/renderer/components/AgentCapabilitiesPanel.tsx',import.meta.url),'utf8')
  assert.match(panel,/const compareExecutionSupported = writablePair && compareScan\?\.executionSupported === true/)
  assert.match(panel,/syncSelectable: !invalid && item\.status === 'add' && item\.selectable/)
  assert.match(panel,/syncSelectable: compareExecutionSupported && row\.syncSelectable && !!opaque/)
  assert.match(panel,/if \(!compareExecutionSupported\) return/)
  assert.match(panel,/compareSelected\.has\(row\.id\) && row\.syncSelectable && row\.status === 'add' && row\.opaque/)
  assert.match(panel,/disabled={!compareExecutionSupported \|\| compareSyncCount === 0 \|\| jobActive}/)
})

await test('capability compare settles loading before same-agent and read-only early returns', async () => {
  const panel=await readFile(new URL('../src/renderer/components/AgentCapabilitiesPanel.tsx',import.meta.url),'utf8')
  const start=panel.indexOf('const loadCompare = useCallback(async () => {')
  const end=panel.indexOf("useEffect(() => { if (view === 'compare')",start)
  assert.ok(start >= 0 && end > start)
  const loadCompare=panel.slice(start,end)
  const generation=loadCompare.indexOf('const generation = ++compareGeneration.current')
  const settle=loadCompare.indexOf('setCompareLoading(false)')
  const sameAgent=loadCompare.indexOf('if (leftAgent === rightAgent)')
  const readOnly=loadCompare.indexOf('if (!writablePair) return')
  const scanStart=loadCompare.indexOf('setCompareLoading(true)')
  assert.ok(generation >= 0 && generation < settle)
  assert.ok(settle < sameAgent && settle < readOnly)
  assert.ok(readOnly < scanStart)
  assert.match(loadCompare,/generation === compareGeneration\.current[\s\S]*setCompareLoading\(false\)/)
})

console.log(`${passed} capability-sync tests passed after UI/IPC contracts`)
