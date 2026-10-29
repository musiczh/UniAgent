import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readZCodeConfiguredModels, readZCodeModelCatalog, resolveZCodeSelection, zcodeModelKey, zcodeModel, ZCODE_PERMISSION_MODES } from '../src/main/zcode/catalog'
import { detectZCodeRuntime } from '../src/main/zcode/runtime'
import { readZCodeCapabilities, zcodeContextPrompt } from '../src/main/zcode/capabilities'
import { ZCodeRpcError } from '../src/main/zcode/connection'
import { zcodeAttachmentRefs } from '../src/main/zcode/attachments'
import { agentRoleUnavailableReason, resolveAgentRoleInvocation } from '../src/main/agentRoles'
import { RoleStore } from '../src/main/roleStore'
import type { AgentDef, AgentRole } from '../src/shared/types'

const root = await mkdtemp('/tmp/uzm-')
try {
  const selection = { providerId: 'personal:one', modelId: 'same', options: { reasoningLevel: 'high' } }
  const builtin = join(root, 'provider/zcode-builtin.json')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(root, 'provider'))
  await writeFile(builtin, JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { templateRules: [{ templateId: 'fixture', config: { builtinModelIds: ['same'] } }], providerRules: [] },
    modelConfigRules: { modelRules: [{ modelMatch: '.*', config: { enabled: true, properties: { contextWindow: 1000 }, optionSpecs: { reasoningLevel: { values: ['low', 'high'] } } } }] }
  } }))
  const personal = join(root, 'personal.json')
  await writeFile(personal, JSON.stringify({ schemaVersion: 1, config: {
    defaultModelSelection: selection,
    providerConfigRules: { providerRules: ['one', 'two'].map(id => ({ providerId: `personal:${id}`, templateId: 'fixture', config: { personalModelIds: ['native'] } })) },
    modelConfigRules: { providerModelRules: [{ providerId: 'personal:two', modelId: 'native', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } }] }
  } }), { mode: 0o600 })
  const models = await readZCodeConfiguredModels(personal, builtin, selection)
  assert.equal(models.length, 4)
  assert.equal(new Set(models.map(model => model.id)).size, 4, 'same-name models retain provider identity')
  assert.deepEqual(models.filter(model => model.zcodeSelection?.modelId === 'same').map(model => model.label), ['same · personal:one', 'same · personal:two'])
  assert.equal(zcodeModel({ ref: selection, label: 'UniAgent ZCode / same', providerLabel: 'UniAgent ZCode' })?.label, 'same')
  const native = models.find(model => model.zcodeSelection?.providerId === 'personal:two' && model.zcodeSelection.modelId === 'native')!
  assert.deepEqual(native.thinkingOptions, ['disabled', 'enabled'])
  assert.deepEqual(native.efforts, [], 'native levels are not invented common effort aliases')
  assert.throws(() => resolveZCodeSelection({ model: 'same' }, models, selection), /同名/)
  assert.deepEqual(resolveZCodeSelection({ model: zcodeModelKey(selection), effort: 'low' }, models, selection).options, { reasoningLevel: 'low' })
  assert.throws(() => resolveZCodeSelection({ model: native.id, effort: 'ultra' }, models, selection), /不支持/)
  assert.equal(resolveZCodeSelection({ model: native.id }, models, selection).options?.reasoningLevel, 'enabled')
  const configuredDefault = { ...native.zcodeSelection!, options: { reasoningLevel: 'disabled' } }
  assert.equal(resolveZCodeSelection({}, models, configuredDefault).options?.reasoningLevel, 'disabled')
  const defaultCatalog = await readZCodeConfiguredModels(personal, builtin, configuredDefault)
  assert.equal(defaultCatalog.find(model => model.id === native.id)?.defaultThinking, 'disabled')
  const agent: AgentDef = { id: 'zcode', name: 'ZCode', bin: '/fixture/zcode', adapter: 'zcode', icon: 'zcode', builtin: true, installed: true,
    models, defaultModel: native.id, capabilities: { streaming: true, modelSelect: true, reasoningEffort: true, permissionModes: ZCODE_PERMISSION_MODES } }
  const role: AgentRole = { id: 'zcode-fixture', name: 'Fixture', agentId: agent.id, model: native.id, zcodeThinking: 'disabled', permissionMode: 'ask' }
  const roles = new RoleStore(join(root, 'roles.json'))
  roles.save(role)
  assert.deepEqual(roles.list(), [role], 'native depth survives role persistence')
  const invocation = resolveAgentRoleInvocation({ roleId: role.id, roles: roles.list(), agents: [agent], callerWorkdir: root })
  assert.deepEqual(invocation.config.zcodeModelSelection, configuredDefault)
  const legacyRole = { ...role, model: native.zcodeSelection!.modelId }
  assert.equal(agentRoleUnavailableReason(legacyRole, [agent]), `role_model_unavailable: ${legacyRole.model}`, 'ambiguous legacy role models must be reselected')
  assert.deepEqual(resolveAgentRoleInvocation({ roleId: role.id, roles: [legacyRole], agents: [{ ...agent, models: [native] }], callerWorkdir: root }).config.zcodeModelSelection,
    configuredDefault, 'unique legacy role model IDs remain executable')
  assert.match(agentRoleUnavailableReason({ ...role, zcodeThinking: 'ultra' }, [agent])!, /thinking_unsupported/)
  assert.equal(agentRoleUnavailableReason({ ...role, instructions: 'system override' }, [agent]), 'role_instructions_unsupported')
  assert.equal(zcodeModel({ ref: selection, disabledReason: 'missing provider' }), undefined)
  const result = { settings: { model: { current: selection, available: [] }, thoughtLevel: { current: 'high', defaultLevel: 'high', available: [{ value: 'low' }, { value: 'high' }] } } }
  const catalog = await readZCodeModelCatalog({ request: async () => result } as any, 'session', selection, models)
  assert.equal(catalog.models.length, 4, 'current-only native reads retain the configured catalog')
  assert.equal(catalog.selection.options?.reasoningLevel, 'high')
  const uniqueCatalog = await readZCodeModelCatalog({ request: async () => ({ settings: { ...result.settings,
    model: { current: selection, available: [{ ref: selection, label: 'UniAgent ZCode / same', providerLabel: 'UniAgent ZCode' }] } } }) } as any,
    'session', selection, [models.find(model => model.id === zcodeModelKey(selection))!])
  assert.equal(uniqueCatalog.models[0].label, 'same', 'provider names must not prefix or suffix unique model names')
  await assert.rejects(readZCodeModelCatalog({ request: async () => ({ settings: { model: { current: { ...selection, providerId: 'personal:two' } } } }) } as any, 'session', selection, models), /身份/)
  const capabilities = await readZCodeCapabilities({ request: async (method: string) => method === 'skills/referenceCatalog'
    ? { skills: [{ name: 'fixture', path: '/tmp/fixture/SKILL.md', enabled: true }] } : method === 'mcp/list'
      ? { statuses: { fixture: { status: 'connected' } } } : { slashCommands: [{ name: 'compact' }, { name: 'goal' }] } } as any, root)
  assert.equal(capabilities.actions.goal, true)
  assert.match(zcodeContextPrompt('task', { skills: [{ name: 'fixture', path: '/tmp/fixture/SKILL.md' }], mcpServers: [{ name: 'fixture' }] }, capabilities), /\[\$fixture\]/)
  assert.throws(() => zcodeContextPrompt('task', { skills: [{ name: 'fixture', path: '/wrong/SKILL.md' }], mcpServers: [] }, capabilities), /失效/)
  const old = await readZCodeCapabilities({ request: async () => { throw new ZCodeRpcError(-32601, 'Method not found') } } as any, root)
  assert.equal(old.candidates.length, 0); assert.equal(old.actions.goal, false); assert.ok(old.errors.length)
  const textFile = join(root, 'attachment.txt')
  await writeFile(textFile, 'fixture attachment')
  const refs = await zcodeAttachmentRefs([{ kind: 'file', path: textFile, name: 'attachment.txt' }])
  assert.equal(refs[0].bytes, 18); assert.equal(refs[0].ref, await realpath(textFile))
  await assert.rejects(zcodeAttachmentRefs([{ kind: 'image', path: textFile, name: 'image.png' }]), /不支持/)
  await assert.rejects(zcodeAttachmentRefs([{ kind: 'file', path: root, name: 'directory' }]), /必须是文件/)

  // Different CLI versions and bundle bytes pass the same interface checks. No model request is made.
  for (const version of ['0.16.8', '0.17.0']) {
    const bundle = join(root, `zcode-${version}.cjs`)
    await writeFile(bundle, `if(process.argv.includes('--version'))console.log('${version}');else if(process.argv.includes('--help'))console.log('app-server --stdio');`)
    const runtime = await detectZCodeRuntime({ schemaVersion: 1, source: 'source-build', executable: process.execPath,
      bundlePath: bundle, resourceRoot: root, personalProviderConfigPath: personal, dataRootId: 'fixture' })
    assert.equal(runtime.version, version)
    assert.equal(runtime.models.length, 4)
  }
  console.log('zcode-model-compatibility: catalog, provider identity, native depths, invalid selections and multiple runtime versions passed')
} finally { await rm(root, { recursive: true, force: true }) }
