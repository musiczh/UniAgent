import assert from 'node:assert/strict'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = resolve('src/main/deepseekRolePlugin.mjs')
assert.ok(existsSync(source), 'DeepSeek role plugin must exist')
// The managed runtime is no longer pinned: resolve the newest installed runtime-<version> dir.
function resolveInstalledDeepSeekRuntime(): string {
  const root = join(process.env.HOME!, 'Library/Application Support/UniAgent/deepseek')
  const installed = existsSync(root) ? readdirSync(root).filter((name) => /^runtime-.+/.test(name)) : []
  installed.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
  return join(root, installed[0] || 'runtime-0.2.1-rc.2')
}
const runtime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME || resolveInstalledDeepSeekRuntime()
const directory = await mkdtemp(join(tmpdir(), 'ua-dsh-role-'))
const sdk = async (name: string) => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const { Context } = await sdk('cordis')
const { SystemPrompt, renderPrompt } = await sdk('dsh-system-prompt')
const { ToolRuntime, defineTool } = await sdk('dsh-tools')
const { SkillRegistry } = await sdk('dsh-skill')
const { createScope, scopeTarget } = await sdk('dsh-scope')
await symlink(join(runtime, 'node_modules'), join(directory, 'node_modules'), 'dir')
await cp(source, join(directory, 'role.mjs'))
const { apply } = await import(pathToFileURL(join(directory, 'role.mjs')).href)
const ctx = new Context()
new SystemPrompt(ctx, {})
new ToolRuntime(ctx)
new SkillRegistry(ctx)
const planning = new WeakMap<object, boolean>()
ctx.provide('planMode', { get(agent: object) { return { active: planning.get(agent) || false } }, set(agent: object, active: boolean) { planning.set(agent, active) } })
ctx.provide('agents', {})
ctx.provide('sandboxPolicy', { overrideOf(agentSession: any) { return agentSession.events?.at(-1)?.data.mode } })
const scopes: any[] = []
let executions = 0
function tool(context: any, name: string, execute = async () => { executions++; return 'executed' }) {
  return context.tools.register(defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_args: any, value: string) => [{ type: 'text', text: value }] }, execute }))
}
for (const name of ['read_file', 'write_file', 'bash', 'skill', 'spawn_agent']) tool(ctx, name)
const skills = ['alpha', 'beta'].map(name => ({ name, description: `${name} skill`, source: 'custom', provider: 'fixture', invocation: { modelInvocable: true, userInvocable: true }, content: `${name} body`, resourceBase: { kind: 'directory', path: join(directory, name) } }))
ctx.skills.registerProvider(() => ({ name: 'fixture', list: async () => skills.map(skill => ({ ...skill, rank: 600, locator: skill.name })), get: async (candidate: any) => skills.find(skill => skill.name === candidate.name) }))
async function agent(role: any, parent?: any, permissionMode = 'full-access') {
  const value: any = { id: `agent-${scopes.length}`, session: { header: { cwd: directory }, append(type: string, data: any) { value.events.push({ type, data }) } }, events: [] }
  const scope = createScope(ctx, value, parent ? { parent } : {})
  value.ctx = scope.ctx
  value.session.events = value.events
  scopes.push(scope)
  if (!parent) apply(scope.ctx, { roleSnapshot: role, permissionMode })
  await ctx.serial(scopeTarget(value, value), 'agent/created', { agent: value, source: 'new' })
  return value
}
const call = (agent: any, name: string, args = {}, parent?: symbol) => ctx.tools.execute({ agent, name, arguments: args, callId: `${name}-call`, parent, signal: new AbortController().signal })
try {
  const a = await agent({ id: 'a', instructions: 'Literal {{not_a_variable}} and {json}', skills: ['alpha'], toolPolicy: { mode: 'deny-only', tools: ['write_file'] } })
  const b = await agent({ id: 'b', instructions: 'Role B only', skills: ['beta'], toolPolicy: { mode: 'allow-only', tools: ['read_file', 'skill'] } })
  assert.ok((await ctx.systemPrompt.assemble({ scope: b, agent: b })).tools.some((tool: any) => tool.name === 'skill'), 'selected skills keep their native loader visible')
  assert.ok(renderPrompt(await ctx.systemPrompt.assemble({ scope: a, agent: a })).includes('Literal {{not_a_variable}} and {json}'))
  assert.equal(renderPrompt(await ctx.systemPrompt.assemble({ scope: b, agent: b })).includes('Literal'), false)
  assert.equal((await call(a, 'read_file')).isError, false)
  assert.equal((await call(a, 'write_file')).isError, true)
  assert.equal((await call(b, 'bash')).isError, true)
  tool(a.ctx, 'write_file')
  assert.equal((await call(a, 'write_file')).isError, true, 'scope-local tool cannot bypass deny policy')
  tool(ctx, 'mcp__new__write')
  assert.equal((await call(b, 'mcp__new__write')).isError, true, 'new MCP tools cannot bypass allow policy')
  assert.equal((await call(b, 'skill', { name: 'alpha' })).isError, true)
  assert.equal((await call(b, 'skill', { name: 'beta' })).isError, false)
  const names = async (value: any, surface: 'modelInvocable' | 'userInvocable') => (await ctx.skills.list({ scope: value, cwd: directory })).filter((s: any) => s.invocation[surface]).map((s: any) => s.name)
  assert.deepEqual(await names(a, 'modelInvocable'), ['alpha'])
  assert.deepEqual(await names(b, 'userInvocable'), ['beta'])
  assert.equal((await ctx.skills.get('alpha', { scope: a, cwd: directory })).content, 'alpha body')
  assert.equal(await ctx.skills.get('beta', { scope: a, cwd: directory }), undefined, 'blocked body cannot be loaded directly')
  skills.push({ ...skills[0], name: 'gamma', content: 'new body' })
  tool(ctx, 'new_tool')
  ctx.skills.register({ name: 'delta', description: 'new runtime skill', source: 'runtime', content: 'delta' })
  assert.deepEqual(await names(a, 'modelInvocable'), ['alpha'], 'late runtime skill is masked')
  a.ctx.skills.register({ name: 'alpha', description: 'scoped override', source: 'runtime', content: 'scoped alpha' })
  a.ctx.skills.register({ name: 'epsilon', description: 'scoped extra skill', source: 'runtime', content: 'epsilon' })
  assert.deepEqual(await Promise.all([names(a, 'modelInvocable'), names(a, 'userInvocable')]), [['alpha'], ['alpha']], 'concurrent discovery cannot temporarily bypass the mask')
  assert.equal((await ctx.skills.get('alpha', { scope: a, cwd: directory })).content, 'scoped alpha', 'allowed scoped skill retains its real body')
  assert.equal(await ctx.skills.get('epsilon', { scope: a, cwd: directory }), undefined)
  a.ctx.skills.registerProvider(() => ({ name: 'late-plugin', list: async () => [{ ...skills[0], name:'zeta',provider:'late-plugin',rank:-1,locator:'zeta' }], get: async () => ({ ...skills[0],name:'zeta',provider:'late-plugin',content:'zeta body' }) }))
  assert.deepEqual(await names(a, 'modelInvocable'), ['alpha'], 'provider precedence cannot bypass the mask')
  const child = await agent(undefined, a)
  const grandchild = await agent(undefined, child)
  assert.deepEqual(await names(grandchild, 'userInvocable'), ['alpha'])
  tool(grandchild.ctx, 'write_file')
  assert.equal((await call(grandchild, 'write_file')).isError, true)
  const none = await agent({ id: 'none', skills: [], toolPolicy: { mode: 'allow-only', tools: [] } })
  ctx.provide('ptcRuntime', { language: 'typescript', run() { throw new Error('denied run_code must not reach runtime') } })
  none.ctx.tools.presentAs('both')
  assert.deepEqual((await ctx.systemPrompt.assemble({ scope: none, agent: none })).tools, [])
  assert.deepEqual(await names(none, 'userInvocable'), [])
  assert.equal((await call(none, 'read_file')).isError, true)
  assert.equal((await call(none, 'run_code', { code: 'return await tools.read_file({})' })).isError, true, 'reserved transport obeys execution policy')
  await assert.rejects(agent({ id: 'missing', skills: ['absent-skill'] }), /absent-skill/)
  await assert.rejects(agent({ id: 'missing-tool', toolPolicy: { mode: 'allow-only', tools: ['absent-tool'] } }), /absent-tool/)
  const ro = await agent(undefined, undefined, 'read-only')
  assert.equal(ro.events.at(-1).data.mode, 'read-only')
  assert.equal((await call(ro, 'read_file')).isError, false)
  assert.equal((await call(ro, 'write_file')).isError, true)
  assert.equal((await call(ro, 'mcp__new__write')).isError, true)
  assert.equal((await call(ro, 'bash', { sandbox_permissions: 'danger-full-access', justification: 'try escalation' })).isError, true)
  planning.set(a, true)
  assert.equal((await call(a, 'new_tool')).isError, true, 'Plan enforces a dynamic read-only boundary')
  assert.equal((await call(a, 'bash')).isError, false)
  assert.equal(a.events.at(-1).data.mode, 'read-only', 'native Plan commands also synchronize bash sandbox')
  planning.set(a, false)
  assert.equal((await call(a, 'new_tool')).isError, false)
  assert.equal((await call(a, 'bash')).isError, false)
  assert.equal(a.events.at(-1).data.mode, 'danger-full-access')
  let outerToken: symbol | undefined
  tool(ctx, 'nested', async (_args: any, exec: any) => { outerToken = exec.token; return (await call(exec.agent, 'write_file', {}, exec.token)).isError ? 'blocked' : 'escaped' })
  const nested = await call(a, 'nested')
  assert.ok(outerToken)
  assert.equal(nested.value, 'blocked')
  assert.ok(executions > 0)
} finally {
  for (const scope of scopes.reverse()) await scope.dispose()
  await rm(directory, { recursive: true, force: true })
}
console.log('deepseek-role: official SDK scopes, literal prompts, tool guards, skills masking and read-only passed')
