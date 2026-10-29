import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { buildPlan, diffInventories } from '../src/main/capability-sync/planner.ts'
import {
  discoverProvider, mergeMcpCredentialSafe, parseMcpBlocks, parseToml, providerPaths,
  rootPreference, setMcpServer, setRootPreference, stringifyToml
} from '../src/main/capability-sync/provider.ts'
import { isPublicCapabilityJob, parseCapabilityExecuteRequest, parseCapabilityPlanRequest, parseCapabilityPreviewRequest } from '../src/shared/capabilitySync.ts'

let passed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log('✓ ' + name) }
  catch (error) { console.error('✗ ' + name, error); process.exitCode = 1 }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ua-cap-provider-'))
  await mkdir(join(home, '.codex/skills'), { recursive: true, mode: 0o700 })
  await mkdir(join(home, '.trae/cli/skills'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, '.codex/config.toml'), 'model = "gpt"\n', { mode: 0o600 })
  await writeFile(join(home, '.trae/cli/config.toml'), 'model = "gpt"\n', { mode: 0o600 })
  return home
}

const inventory = (items) => ({ revision: 'a'.repeat(64), items, layoutKnown: true })
const cap = (id, extra = {}) => ({ id: 'skill:' + id, kind: 'skill', name: id, owner: 'user', fingerprint: id, compatible: true, privateRef: '/private/' + id, ...extra })

await test('execute parser accepts a bounded delete confirmation count and rejects unknown confirmation keys', () => {
  const request={planId:randomUUID(),expectedSourceRevision:'a'.repeat(64),expectedTargetRevision:'b'.repeat(64),confirmation:{acknowledged:true,targetName:'traex',deleteCount:2}}
  assert.equal(parseCapabilityExecuteRequest(request).confirmation.deleteCount,2)
  assert.throws(()=>parseCapabilityExecuteRequest({...request,confirmation:{...request.confirmation,path:'/private'}}),/invalid_capability_execute_request/)
  assert.throws(()=>parseCapabilityExecuteRequest({...request,confirmation:{...request.confirmation,deleteCount:-1}}),/invalid_capability_execute_request/)
})

await test('TOML object mutation respects arbitrary table boundaries and round trips', () => {
  const original = [
    'model = "root-model"',
    '[mcp_servers.alpha]',
    'command = "node"',
    '[mcp_servers.alpha.env]',
    'API_TOKEN = "target"',
    '[unrelated.deep]',
    'model = "nested-model"',
    'answer = 42',
    ''
  ].join('\n')
  const config = parseToml(original)
  setRootPreference(config, 'model', 'new-root')
  setMcpServer(config, 'alpha', undefined)
  const reparsed = parseToml(stringifyToml(config))
  assert.equal(rootPreference(reparsed, 'model'), 'new-root')
  assert.equal(reparsed.unrelated.deep.model, 'nested-model')
  assert.equal(reparsed.unrelated.deep.answer, 42)
  assert.deepEqual(reparsed.mcp_servers, undefined)
})

await test('MCP parsing stops structurally at arbitrary sibling tables', () => {
  const blocks = parseMcpBlocks('[mcp_servers.one]\ncommand="one"\n[unrelated]\ncommand="do-not-capture"\n[mcp_servers.two]\ncommand="two"\n')
  assert.deepEqual(blocks.map((block) => block.privateKey), ['one', 'two'])
  assert.deepEqual(blocks.map((block) => block.name), ['one', 'two'])
  assert.equal(blocks[0].body.includes('do-not-capture'), false)
})

await test('conventional MCP identifiers retain friendly public names and ids', async () => {
  const home = await fixture()
  await writeFile(join(home, '.codex/config.toml'), '[mcp_servers.demo-server_v2]\ncommand="node"\n', { mode: 0o600 })
  const item = (await discoverProvider('codex', home)).items.find((candidate) => candidate.kind === 'mcp')
  assert.ok(item)
  assert.equal(item.name, 'demo-server_v2')
  assert.equal(item.id, 'mcp:demo-server_v2')
  assert.equal(item.privateKey, 'demo-server_v2')
})

await test('inline env/header/Authorization/args credentials never migrate and target values survive', () => {
  const source = parseMcpBlocks('[mcp_servers.demo]\ncommand = "node"\nargs = ["--token", "SOURCE_ARG_SECRET"]\nenv = { SAFE = "SOURCE_SAFE", API_TOKEN = "SOURCE_TOKEN" }\nheaders = { Authorization = "Bearer SOURCE_AUTH", X_API_KEY = "SOURCE_KEY" }\n')[0]
  const target = parseMcpBlocks('[mcp_servers.demo]\ncommand = "old"\nargs = ["--token", "TARGET_ARG_SECRET"]\nenv = { SAFE = "TARGET_SAFE", API_TOKEN = "TARGET_TOKEN", TARGET_ONLY_SECRET = "TARGET_EXTRA" }\nheaders = { Authorization = "Bearer TARGET_AUTH", X_API_KEY = "TARGET_KEY" }\n')[0]
  assert.equal(source.body.includes('SOURCE_TOKEN'), false)
  assert.equal(source.body.includes('SOURCE_AUTH'), false)
  assert.equal(source.body.includes('SOURCE_ARG_SECRET'), false)
  const merged = mergeMcpCredentialSafe(source.value, target.value)
  assert.equal(merged.credentialRequired, false)
  const text = stringifyToml({ mcp_servers: { demo: merged.value } })
  for (const value of ['TARGET_ARG_SECRET', 'TARGET_TOKEN', 'TARGET_SAFE', 'TARGET_AUTH', 'TARGET_KEY', 'TARGET_EXTRA']) assert.equal(text.includes(value), true)
  for (const value of ['SOURCE_ARG_SECRET', 'SOURCE_TOKEN', 'SOURCE_SAFE', 'SOURCE_AUTH', 'SOURCE_KEY']) assert.equal(text.includes(value), false)
  assert.equal(text.includes('command = "node"'), true)
})

await test('all MCP args remain target-owned even when no secret pattern is recognizable', () => {
  const source = parseMcpBlocks('[mcp_servers.demo]\ncommand="new"\nargs=["opaque-source-value"]\n')[0]
  const target = parseMcpBlocks('[mcp_servers.demo]\ncommand="old"\nargs=["opaque-target-value"]\n')[0]
  const merged = mergeMcpCredentialSafe(source.value, target.value)
  assert.equal(merged.credentialRequired, false)
  assert.deepEqual(merged.value.args, ['opaque-target-value'])
  assert.equal(mergeMcpCredentialSafe(source.value, undefined).credentialRequired, true)
})

await test('credentials nested in TOML arrays are redacted and excluded from fingerprints', () => {
  const source='[mcp_servers.demo]\ncommand = "node"\nitems = [{ name = "x", token = "SOURCE_ARRAY_SECRET" }]\n'
  const target='[mcp_servers.demo]\ncommand = "node"\nitems = [{ name = "x", token = "TARGET_ARRAY_SECRET" }]\n'
  const [sourceBlock]=parseMcpBlocks(source),[targetBlock]=parseMcpBlocks(target)
  assert.equal(sourceBlock.body.includes('SOURCE_ARRAY_SECRET'),false);assert.equal(sourceBlock.rawBody.includes('SOURCE_ARRAY_SECRET'),false)
  assert.equal(targetBlock.body.includes('TARGET_ARRAY_SECRET'),false);assert.equal(sourceBlock.body,targetBlock.body)
  assert.deepEqual(sourceBlock.secretShape,['["items",0,"token"]'])
})

await test('reordered MCP array-of-table credentials require input and leave the target untouched', () => {
  const source = parseMcpBlocks([
    '[mcp_servers.demo]', 'command = "new"',
    '[[mcp_servers.demo.accounts]]', 'name = "alice"', 'token = "SOURCE_ALICE"',
    '[[mcp_servers.demo.accounts]]', 'name = "bob"', 'token = "SOURCE_BOB"', ''
  ].join('\n'))[0]
  const target = parseMcpBlocks([
    '[mcp_servers.demo]', 'command = "old"',
    '[[mcp_servers.demo.accounts]]', 'name = "bob"', 'token = "TARGET_BOB"',
    '[[mcp_servers.demo.accounts]]', 'name = "alice"', 'token = "TARGET_ALICE"', ''
  ].join('\n'))[0]
  const targetBefore = stringifyToml(target.value)
  const merged = mergeMcpCredentialSafe(source.value, target.value)
  assert.equal(merged.credentialRequired, true)
  assert.equal(merged.value, undefined)
  assert.equal(stringifyToml(target.value), targetBefore)
})

await test('reordered MCP inline-table array credentials require input and leave the target untouched', () => {
  const source = parseMcpBlocks('[mcp_servers.demo]\ncommand="new"\naccounts=[{ name="alice", headers={ Authorization="Bearer SOURCE_ALICE" } }, { name="bob", headers={ Authorization="Bearer SOURCE_BOB" } }]\n')[0]
  const target = parseMcpBlocks('[mcp_servers.demo]\ncommand="old"\naccounts=[{ name="bob", headers={ Authorization="Bearer TARGET_BOB" } }, { name="alice", headers={ Authorization="Bearer TARGET_ALICE" } }]\n')[0]
  const targetBefore = stringifyToml(target.value)
  const merged = mergeMcpCredentialSafe(source.value, target.value)
  assert.equal(merged.credentialRequired, true)
  assert.equal(merged.value, undefined)
  assert.equal(stringifyToml(target.value), targetBefore)
})

await test('target-only credential-bearing array indices fail closed without synthesizing partial elements', () => {
  const source = parseMcpBlocks('[mcp_servers.demo]\ncommand="new"\naccounts=[{ name="alice" }]\n')[0]
  const target = parseMcpBlocks('[mcp_servers.demo]\ncommand="old"\naccounts=[{ name="alice", token="TARGET_ALICE" }, { name="bob", token="TARGET_ONLY_BOB" }]\n')[0]
  const targetBefore = stringifyToml(target.value)
  const merged = mergeMcpCredentialSafe(source.value, target.value)
  assert.equal(merged.credentialRequired, true)
  assert.equal(merged.value, undefined)
  assert.equal(stringifyToml(target.value), targetBefore)
})

await test('credential keys containing dots are preserved without path aliasing', () => {
  const source = parseMcpBlocks('[mcp_servers.demo]\ncommand="new"\nheaders={ "X.API.KEY"="source" }\n')[0]
  const target = parseMcpBlocks('[mcp_servers.demo]\ncommand="old"\nheaders={ "X.API.KEY"="target" }\n')[0]
  const merged = mergeMcpCredentialSafe(source.value, target.value)
  assert.equal(merged.credentialRequired, false)
  assert.equal(merged.value.headers['X.API.KEY'], 'target')
})

await test('MCP migration blocks when credential mapping cannot be proven', () => {
  const source = parseMcpBlocks('[mcp_servers.demo]\ncommand="x"\nenv={ API_TOKEN="SOURCE" }\n')[0]
  const target = parseMcpBlocks('[mcp_servers.demo]\ncommand="old"\n')[0]
  assert.equal(mergeMcpCredentialSafe(source.value, target.value).credentialRequired, true)
  assert.equal(mergeMcpCredentialSafe(source.value, undefined).credentialRequired, true)
})

await test('MCP inline-table and datetime values remain loadable after a round trip', () => {
  const original = 'when = 1979-05-27T07:32:00\n[mcp_servers.demo]\ncommand="x"\nmeta={ retries=2, enabled=true }\n'
  const output = stringifyToml(parseToml(original))
  const reparsed = parseToml(output)
  assert.equal(reparsed.mcp_servers.demo.meta.retries, 2)
  assert.equal(reparsed.mcp_servers.demo.meta.enabled, true)
  assert.equal(reparsed.when instanceof Date, true)
})

await test('arbitrary MCP keys stay private behind stable opaque public identities', async () => {
  const home = await fixture()
  const rawNames = ['/Users/victim/.ssh/id_ed25519', 'api-key=sk-live-DO-NOT-RENDER', 'access-token']
  const sourceServers = Object.fromEntries(rawNames.map((name, index) => [name, { command: `source-${index}` }]))
  const targetServers = Object.fromEntries(rawNames.map((name, index) => [name, { command: `target-${index}` }]))
  await writeFile(join(home, '.codex/config.toml'), stringifyToml({ mcp_servers: sourceServers }), { mode: 0o600 })
  await writeFile(join(home, '.trae/cli/config.toml'), stringifyToml({ mcp_servers: targetServers }), { mode: 0o600 })

  const source = await discoverProvider('codex', home)
  const target = await discoverProvider('traex', home)
  const repeatedSource = await discoverProvider('codex', home)
  const privateItems = source.items.filter((item) => item.kind === 'mcp')
  assert.deepEqual(privateItems.map((item) => item.privateKey).sort(), [...rawNames].sort())
  assert.deepEqual(
    repeatedSource.items.filter((item) => item.kind === 'mcp').map((item) => item.id).sort(),
    privateItems.map((item) => item.id).sort()
  )

  const items = diffInventories(source, target)
  const publicItems = items.filter((item) => item.kind === 'mcp')
  assert.equal(publicItems.length, rawNames.length)
  assert.equal(new Set(publicItems.map((item) => item.id)).size, rawNames.length)
  assert.equal(new Set(publicItems.map((item) => item.name)).size, rawNames.length)
  for (const item of publicItems) {
    assert.match(item.id, /^mcp:opaque:[a-f0-9]{64}$/)
    assert.match(item.name, /^MCP server #[a-f0-9]{64}$/)
    assert.equal(item.status, 'conflict')
  }
  assert.deepEqual(
    source.items.filter((item) => item.kind === 'mcp').map((item) => item.id).sort(),
    target.items.filter((item) => item.kind === 'mcp').map((item) => item.id).sort()
  )

  const resolutions = Object.fromEntries(publicItems.map((item) => [item.id, 'source']))
  const plan = buildPlan({
    id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex',
    sourceRevision: source.revision, targetRevision: target.revision, mode: 'merge', items,
    cloneCategories: [], selections: publicItems.map((item) => item.id), resolutions
  })
  const mcpOperations = plan.operations.filter((operation) => operation.kind === 'mcp')
  assert.equal(mcpOperations.every((operation) => operation.action === 'write'), true)
  assert.deepEqual(mcpOperations.map((operation) => operation.itemId).sort(), publicItems.map((item) => item.id).sort())
  const publicJson = JSON.stringify({ scan: { sourceRevision: source.revision, targetRevision: target.revision, items }, plan })
  for (const rawName of rawNames) {
    for (const leaked of [
      rawName, encodeURIComponent(rawName), Buffer.from(rawName).toString('base64'),
      Buffer.from(rawName).toString('base64url'), Buffer.from(rawName).toString('hex')
    ]) assert.equal(publicJson.includes(leaked), false)
    // A fixed public digest would let a renderer validate arbitrary guesses.
    // The process-private HMAC identity must differ from known unsalted forms.
    for (const domain of ['uniagent:mcp-key:v1\0', 'UniAgent/capability-sync/mcp-id/v2\0']) {
      const guessable = createHash('sha256').update(domain).update(rawName).digest('hex')
      assert.equal(publicJson.includes(guessable), false)
    }
  }

  const deletionConfig = parseToml(stringifyToml({ mcp_servers: targetServers }))
  for (const item of publicItems) setMcpServer(deletionConfig, item.name, undefined)
  assert.equal(deletionConfig.mcp_servers, undefined)
})

await test('TraeX scanner hybrid layout selects config and skills independently', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ua-cap-hybrid-'))
  await mkdir(join(home, '.trae/cli'), { recursive: true, mode: 0o700 })
  await mkdir(join(home, '.trae/skills/hybrid'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, '.trae/cli/config.toml'), 'model="gpt"\n', { mode: 0o600 })
  await writeFile(join(home, '.trae/skills/hybrid/SKILL.md'), '# Hybrid\n', { mode: 0o600 })
  const paths = providerPaths('traex', home)
  assert.equal(paths.config, join(home, '.trae/cli/config.toml'))
  assert.equal(paths.skills, join(home, '.trae/skills'))
  assert.equal(paths.layoutKnown, true)
  const discovered = await discoverProvider('traex', home)
  assert.equal(discovered.layoutKnown, true)
  assert.equal(discovered.items.find((item) => item.id === 'skill:hybrid')?.compatible, true)
})

await test('TraeX dual config resolves to traecli.toml while skills/AGENTS ambiguity fail closed', async () => {
  // 需求4: the authoritative traecli.toml plus a stale legacy cli/config.toml both
  // exist on real machines. Config layout is now KNOWN (traecli.toml wins); only a
  // second live candidate in the SKILLS or AGENTS category still fails closed.
  const configHome = await mkdtemp(join(tmpdir(), 'ua-cap-config-dual-'))
  await mkdir(join(configHome, '.trae/cli'), { recursive: true, mode: 0o700 })
  await mkdir(join(configHome, '.trae/skills'), { recursive: true, mode: 0o700 })
  await writeFile(join(configHome, '.trae/cli/config.toml'), 'model="legacy"\n', { mode: 0o600 })
  await writeFile(join(configHome, '.trae/traecli.toml'), 'model="current"\n', { mode: 0o600 })
  const dual = providerPaths('traex', configHome)
  assert.equal(dual.config, join(configHome, '.trae/traecli.toml'))
  assert.equal(dual.layoutKnown, true)

  const skillsHome = await mkdtemp(join(tmpdir(), 'ua-cap-skills-ambiguous-'))
  await mkdir(join(skillsHome, '.trae/cli/skills'), { recursive: true, mode: 0o700 })
  await mkdir(join(skillsHome, '.trae/skills'), { recursive: true, mode: 0o700 })
  await writeFile(join(skillsHome, '.trae/cli/config.toml'), 'model="legacy"\n', { mode: 0o600 })
  assert.equal(providerPaths('traex', skillsHome).layoutKnown, false)

  const independentHome = await mkdtemp(join(tmpdir(), 'ua-cap-independent-roots-'))
  await mkdir(join(independentHome, '.trae/cli/skills'), { recursive: true, mode: 0o700 })
  await writeFile(join(independentHome, '.trae/traecli.toml'), 'model="current"\n', { mode: 0o600 })
  const independent = providerPaths('traex', independentHome)
  assert.equal(independent.config, join(independentHome, '.trae/traecli.toml'))
  assert.equal(independent.skills, join(independentHome, '.trae/cli/skills'))
  assert.equal(independent.layoutKnown, true)
})

await test('top-level Skill symlinks are unlinkable but non-copyable and leak no paths', async () => {
  const home = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'ua-cap-outside-'))
  await mkdir(join(outside, 'evil'), { recursive: true })
  await writeFile(join(outside, 'evil/SKILL.md'), '# stolen')
  await symlink(join(outside, 'evil'), join(home, '.codex/skills/escape'))
  const inv = await discoverProvider('codex', home)
  const item = inv.items.find((candidate) => candidate.name === 'escape')
  assert.equal(item.compatible, false)
  assert.equal(item.linked, true)
  assert.equal(item.issueCode, undefined)
  const serialized = JSON.stringify(diffInventories(inv, inventory([])))
  assert.equal(serialized.includes(home), false)
  assert.equal(serialized.includes(outside), false)
})

await test('invalid Skill link targets stay removable and invalidate either side of a comparison', async () => {
  const home = await fixture()
  const root = join(home, '.codex/skills')
  const source = join(home, 'external')
  await mkdir(join(source, 'missing-manifest'), { recursive: true })
  await mkdir(join(source, 'directory-manifest/SKILL.md'), { recursive: true })
  await writeFile(join(source, 'file-target'), 'not a skill directory')
  for (const name of ['missing-target', 'missing-manifest', 'directory-manifest', 'file-target']) {
    await symlink(join(source, name), join(root, name))
  }
  await symlink(join(root, 'cycle'), join(root, 'cycle'))
  const result = await discoverProvider('codex', home)
  assert.equal(result.layoutKnown, true)
  for (const name of ['missing-target', 'missing-manifest', 'directory-manifest', 'file-target', 'cycle']) {
    const item = result.items.find((candidate) => candidate.name === name)
    assert.equal(item.linked, true)
    assert.equal(item.compatible, false)
    assert.equal(item.issueCode, 'unsafe_skill_entry')
    const validLink = { ...item, issueCode: undefined }
    for (const [sourceItem, targetItem, status] of [
      [item, validLink, 'incompatible'], [validLink, item, 'invalid']
    ]) {
      const [compared] = diffInventories(inventory([sourceItem]), inventory([targetItem]))
      assert.equal(compared.status, status)
      assert.equal(compared.compatible, false)
      assert.equal(compared.selectable, false)
      assert.equal(compared.cloneSafe, false)
      assert.equal(compared.issueCode, 'unsafe_skill_entry')
    }
  }
})

await test('symlinked provider root is read-only blocked', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ua-cap-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'ua-cap-root-outside-'))
  await mkdir(join(outside, 'skills'), { recursive: true })
  await writeFile(join(outside, 'config.toml'), 'model="x"\n')
  await symlink(outside, join(home, '.codex'))
  const inv = await discoverProvider('codex', home)
  assert.equal(inv.layoutKnown, false)
})

await test('world-writable skill content remains discoverable on a single-user Mac', async () => {
  const home = await fixture(), dir = join(home, '.codex/skills/open')
  await mkdir(dir, { mode: 0o700 })
  await writeFile(join(dir, 'SKILL.md'), '# open', { mode: 0o666 })
  await chmod(join(dir, 'SKILL.md'), 0o666)
  const inv = await discoverProvider('codex', home)
  assert.equal(inv.items.find((item) => item.name === 'open')?.compatible, true)
})

await test('provider discovery ignores files and manifest-less directories', async () => {
  const home = await fixture(), root = join(home, '.codex/skills')
  await writeFile(join(root, 'backup.zip'), 'not a skill')
  await mkdir(join(root, 'empty'))
  const inv = await discoverProvider('codex', home)
  assert.equal(inv.items.some((item) => item.name === 'backup.zip' || item.name === 'empty'), false)
})

await test('unknown and ambiguous provider layouts remain discoverable but not writable', async () => {
  // 需求4: dual config no longer fails closed; a second live SKILLS candidate does.
  const home = await fixture()
  await mkdir(join(home, '.trae/skills'), { recursive: true, mode: 0o700 })
  assert.equal(providerPaths('traex', home).layoutKnown, false)
  assert.equal((await discoverProvider('traex', home)).layoutKnown, false)
})

await test('post-commit quarantine artifacts do not change provider revision', async () => {
  const home = await fixture()
  const before = await discoverProvider('codex', home)
  const artifact = join(home, '.codex/skills', `.ua-post-alpha-${randomUUID()}-0`)
  await mkdir(artifact, { mode: 0o700 })
  await writeFile(join(artifact, 'SKILL.md'), 'transaction-owned\n', { mode: 0o600 })
  const after = await discoverProvider('codex', home)
  assert.equal(after.revision, before.revision)
  assert.deepEqual(after.items.map((item) => item.id), before.items.map((item) => item.id))
})

await test('strict anchored rename residue is absent from top-level inventory and recursive revisions', async () => {
  const home = await fixture()
  const skills = join(home, '.codex/skills')
  const skill = join(skills, 'visible')
  await mkdir(join(skill, 'nested'), { recursive: true, mode: 0o700 })
  await writeFile(join(skill, 'SKILL.md'), '# Visible\n', { mode: 0o600 })
  const before = await discoverProvider('codex', home)
  const beforeSkill = before.items.find((item) => item.id === 'skill:visible')
  assert.ok(beforeSkill)

  const topAnchor = `.ua-rn-v1-${'a'.repeat(32)}`
  const nestedAnchor = `.ua-rn-v1-${'b'.repeat(32)}`
  await mkdir(join(skills, topAnchor), { mode: 0o700 })
  await writeFile(join(skills, topAnchor, 'SKILL.md'), '# Transaction residue\n', { mode: 0o600 })
  await mkdir(join(skill, 'nested', nestedAnchor), { mode: 0o700 })
  await writeFile(join(skill, 'nested', nestedAnchor, 'payload'), 'transaction residue\n', { mode: 0o600 })

  const after = await discoverProvider('codex', home)
  assert.equal(after.revision, before.revision)
  assert.deepEqual(after.items, before.items)
  assert.equal(after.items.find((item) => item.id === 'skill:visible')?.fingerprint, beforeSkill.fingerprint)
  assert.equal(after.items.some((item) => item.name === topAnchor), false)
})

await test('anchored rename lookalikes remain revision-significant at every depth', async () => {
  for (const name of [
    `.ua-rn-v1-${'a'.repeat(31)}`,
    `.ua-rn-v1-${'A'.repeat(32)}`,
    `.ua-rn-v1-${'g'.repeat(32)}`,
    `.ua-rn-v1-${'c'.repeat(32)}-extra`,
    `.UA-RN-V1-${'d'.repeat(32)}`,
    `.ua-rn-v1-${'e'.repeat(32)}\n`
  ]) {
    const home = await fixture()
    const skills = join(home, '.codex/skills')
    const skill = join(skills, 'visible')
    await mkdir(join(skill, 'nested'), { recursive: true, mode: 0o700 })
    await writeFile(join(skill, 'SKILL.md'), '# Visible\n', { mode: 0o600 })
    const before = await discoverProvider('codex', home)

    await mkdir(join(skills, name), { mode: 0o700 })
    await writeFile(join(skills, name, 'SKILL.md'), `${name}\n`, { mode: 0o600 })
    const topLevel = await discoverProvider('codex', home)
    assert.equal(topLevel.items.some((item) => item.name === name), false)
    assert.notEqual(topLevel.revision, before.revision, `top-level ${name}`)
    assert.equal(
      topLevel.items.find((item) => item.id === 'skill:visible')?.fingerprint,
      before.items.find((item) => item.id === 'skill:visible')?.fingerprint,
      `top-level ${name}`
    )

    await mkdir(join(skill, 'nested', name), { mode: 0o700 })
    await writeFile(join(skill, 'nested', name, 'payload'), `${name}\n`, { mode: 0o600 })
    const nested = await discoverProvider('codex', home)
    assert.notEqual(nested.revision, topLevel.revision, `nested ${name}`)
    assert.notEqual(
      nested.items.find((item) => item.id === 'skill:visible')?.fingerprint,
      topLevel.items.find((item) => item.id === 'skill:visible')?.fingerprint,
      `nested ${name}`
    )
  }
})

await test('ordinary dot skills follow the existing hidden-inventory but revision-significant contract', async () => {
  const home = await fixture()
  const skills = join(home, '.codex/skills')
  const before = await discoverProvider('codex', home)
  await mkdir(join(skills, '.ordinary'), { mode: 0o700 })
  await writeFile(join(skills, '.ordinary', 'SKILL.md'), '# Ordinary dot skill\n', { mode: 0o600 })
  const after = await discoverProvider('codex', home)
  assert.equal(after.items.some((item) => item.name === '.ordinary'), false)
  assert.notEqual(after.revision, before.revision)
})

await test('a rename-anchor lookalike without the leading dot remains a normal skill', async () => {
  const home = await fixture()
  const name = `ua-rn-v1-${'e'.repeat(32)}`
  const dir = join(home, '.codex/skills', name)
  await mkdir(dir, { mode: 0o700 })
  await writeFile(join(dir, 'SKILL.md'), '# Normal skill\n', { mode: 0o600 })
  const discovered = await discoverProvider('codex', home)
  const skill = discovered.items.find((item) => item.name === name)
  assert.ok(skill)
  assert.equal(skill.compatible, true)
})

await test('root preference never reads or overwrites a nested table field', () => {
  const config = parseToml('[mcp_servers.demo]\nmodel="nested"\n')
  assert.equal(rootPreference(config, 'model'), undefined)
  setRootPreference(config, 'model', 'root')
  const roundtrip = parseToml(stringifyToml(config))
  assert.equal(roundtrip.model, 'root')
  assert.equal(roundtrip.mcp_servers.demo.model, 'nested')
})

await test('clone blocker in any selected category produces zero deletes', () => {
  const sourceItems = [cap('good'), cap('bad', { compatible: false, issueCode: 'unsafe_skill_entry' })]
  const targetItems = [cap('old')]
  const items = diffInventories(inventory(sourceItems), inventory(targetItems))
  const plan = buildPlan({ id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex', sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'clone-supported-scope', cloneCategories: ['skill'], items, selections: ['skill:good'], resolutions: {} })
  assert.equal(plan.blockedReasons.includes('clone_category_unsafe'), true)
  assert.equal(plan.operations.some((operation) => operation.action === 'delete'), false)
  assert.equal(plan.operations.every((operation) => operation.verification === 'V1'), true)
})

await test('clone treats an invalid target-only item as a category-wide blocker', () => {
  const sourceItems = [cap('good')]
  const targetItems = [cap('old'), cap('poison', { compatible: false, issueCode: 'unsafe_skill_entry' })]
  const items = diffInventories(inventory(sourceItems), inventory(targetItems))
  const plan = buildPlan({ id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex', sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'clone-supported-scope', cloneCategories: ['skill'], items, selections: ['skill:good'], resolutions: {} })
  assert.equal(plan.blockedReasons.includes('clone_category_unsafe'), true)
  assert.equal(plan.operations.filter((operation) => operation.action === 'delete').length, 0)
})

await test('invalid selections and unsupported conflict resolutions are blocked', () => {
  const items = diffInventories(inventory([cap('conflict')]), inventory([cap('conflict', { fingerprint: 'other' })]))
  const mergePlan = buildPlan({ id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex', sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'merge', cloneCategories: [], items, selections: ['skill:conflict'], resolutions: { 'skill:conflict': 'merge' } })
  assert.equal(mergePlan.blockedReasons.includes('invalid_selection'), true)
  const forged = buildPlan({ id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex', sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'merge', cloneCategories: [], items, selections: ['skill:missing'], resolutions: {} })
  assert.equal(forged.blockedReasons.includes('invalid_selection'), true)
  const addItems = diffInventories(inventory([cap('add')]), inventory([]))
  const extraneous = buildPlan({ id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex', sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'merge', cloneCategories: [], items: addItems, selections: ['skill:add'], resolutions: { 'skill:add': 'skip' } })
  assert.equal(extraneous.blockedReasons.includes('invalid_selection'), true)
  assert.equal(extraneous.operations.find((operation) => operation.itemId === 'skill:add')?.action, 'write')
})

await test('clone category selection deletes target-only items with an empty source category', () => {
  const items = diffInventories(inventory([]), inventory([cap('target-only')]))
  const plan = buildPlan({
    id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex',
    sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'clone-supported-scope',
    cloneCategories: ['skill'], items, selections: [], resolutions: {}
  })
  assert.deepEqual(plan.blockedReasons, [])
  assert.equal(plan.operations.find((operation) => operation.itemId === 'skill:target-only')?.action, 'delete')
})

await test('clone category selection deletes target-only items when all common items are same', () => {
  const same = cap('same')
  const items = diffInventories(inventory([same]), inventory([same, cap('target-only')]))
  const plan = buildPlan({
    id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex',
    sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'clone-supported-scope',
    cloneCategories: ['skill'], items, selections: [], resolutions: {}
  })
  assert.deepEqual(plan.blockedReasons, [])
  assert.equal(plan.operations.find((operation) => operation.itemId === 'skill:same')?.action, 'noop')
  assert.equal(plan.operations.find((operation) => operation.itemId === 'skill:target-only')?.action, 'delete')
})

await test('clone accepts an explicitly selected category absent from both inventories as a no-op', () => {
  const plan = buildPlan({
    id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex',
    sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'clone-supported-scope',
    cloneCategories: ['memory'], items: [], selections: [], resolutions: {}
  })
  assert.deepEqual(plan.blockedReasons, [])
  assert.deepEqual(plan.operations, [])
})

await test('planner rejects clone categories in merge mode and selections outside clone scope', () => {
  const items = diffInventories(inventory([cap('one')]), inventory([]))
  const merge = buildPlan({
    id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex',
    sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'merge',
    cloneCategories: ['skill'], items, selections: ['skill:one'], resolutions: {}
  })
  assert.equal(merge.blockedReasons.includes('invalid_selection'), true)
  const clone = buildPlan({
    id: randomUUID(), scanId: randomUUID(), source: 'codex', target: 'traex',
    sourceRevision: 'a'.repeat(64), targetRevision: 'b'.repeat(64), mode: 'clone-supported-scope',
    cloneCategories: ['memory'], items, selections: ['skill:one'], resolutions: {}
  })
  assert.equal(clone.blockedReasons.includes('invalid_selection'), true)
})

await test('shared request parsers reject injection and preview is AGENTS-only', () => {
  const scanId = randomUUID(), planId = randomUUID()
  assert.deepEqual(parseCapabilityPlanRequest({ scanId, mode: 'merge', cloneCategories: [], selections: [], resolutions: {} }).cloneCategories, [])
  assert.deepEqual(parseCapabilityPlanRequest({ scanId, mode: 'clone-supported-scope', cloneCategories: ['skill'], selections: [], resolutions: {} }).cloneCategories, ['skill'])
  assert.throws(() => parseCapabilityPlanRequest({ scanId, mode: 'merge', selections: [], resolutions: {} }), /invalid_capability_plan_request/)
  assert.throws(() => parseCapabilityPlanRequest({ scanId, mode: 'merge', cloneCategories: ['skill'], selections: [], resolutions: {} }), /invalid_capability_plan_request/)
  assert.throws(() => parseCapabilityPlanRequest({ scanId, mode: 'clone-supported-scope', cloneCategories: [], selections: [], resolutions: {} }), /invalid_capability_plan_request/)
  assert.throws(() => parseCapabilityPlanRequest({ scanId, mode: 'clone-supported-scope', cloneCategories: ['skill', 'skill'], selections: [], resolutions: {} }), /invalid_capability_plan_request/)
  assert.throws(() => parseCapabilityPlanRequest({ scanId, mode: 'clone-supported-scope', cloneCategories: ['private-path'], selections: [], resolutions: {} }), /invalid_capability_plan_request/)
  assert.throws(() => parseCapabilityPlanRequest({ scanId, mode: 'merge', cloneCategories: [], selections: ['skill:x\nboom'], resolutions: {} }), /invalid_capability_plan_request/)
  assert.throws(() => parseCapabilityPlanRequest({ scanId, mode: 'merge', cloneCategories: [], selections: [], resolutions: {}, injected: true }), /invalid_capability_plan_request/)
  assert.throws(() => parseCapabilityExecuteRequest({ planId: '../../escape', expectedSourceRevision: 'a'.repeat(64), expectedTargetRevision: 'b'.repeat(64) }), /invalid_capability_execute_request/)
  assert.throws(() => parseCapabilityExecuteRequest({ planId, expectedSourceRevision: 'a'.repeat(64), expectedTargetRevision: 'b'.repeat(64), extra: true }), /invalid_capability_execute_request/)
  assert.deepEqual(parseCapabilityExecuteRequest({ planId, expectedSourceRevision: 'a'.repeat(64), expectedTargetRevision: 'b'.repeat(64) }).planId, planId)
  assert.throws(() => parseCapabilityPreviewRequest(scanId, 'memory:MEMORY.md', 'merge'), /invalid_preview_request/)
  assert.deepEqual(parseCapabilityPreviewRequest(scanId, 'global-instructions:agents', 'keep-shared').strategy, 'keep-shared')
})

await test('persisted/public jobs reject unknown keys, paths, and invalid progress', () => {
  const base = { id: randomUUID(), planId: randomUUID(), state: 'staging', updatedAt: Date.now() }
  assert.equal(isPublicCapabilityJob(base), true)
  assert.equal(isPublicCapabilityJob({ ...base, leakedPath: '/private/secret' }), false)
  assert.equal(isPublicCapabilityJob({ ...base, errorCode: '/private/secret' }), false)
  assert.equal(isPublicCapabilityJob({ ...base, progress: { completed: 2, total: 1 } }), false)
})

await test('provider tests never point at a real user capability root', async () => {
  const source = await readFile(new URL(import.meta.url), 'utf8')
  assert.match(source, /import \{ tmpdir \} from 'node:os'/)
  assert.equal(source.includes(['home', 'dir', '()'].join('')), false)
  assert.equal(source.includes(['process', '.env', '.HOME'].join('')), false)
})

console.log(passed + ' capability-sync provider/planner tests passed')
