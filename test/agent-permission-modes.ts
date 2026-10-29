import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_AGENTS } from '../src/main/agents.ts'
import { profileFromConfig } from '../src/main/kimiWebRuntime.ts'
import { assertKimiWebConfig } from '../src/main/kimiRoleConfig.ts'
import { kimiWebContract } from '../src/main/kimiWebContract.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { RoleStore } from '../src/main/roleStore.ts'
import { zcodeSessionContract } from '../src/main/zcode/catalog.ts'
import { deepseekHostPermissionModes } from '../src/main/deepseekHostContract.ts'
import { AppSettingsStore } from '../src/main/appSettingsStore.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import type { PermissionMode, Session, SessionConfig } from '../src/shared/types.ts'

const kimi = BUILTIN_AGENTS.find(agent => agent.id === 'kimi')!
assert.deepEqual(kimi.capabilities.permissionModes.map(mode => mode.id), ['ask', 'full-access', 'unattended'])
for (const [mode, native] of [['ask', 'manual'], ['full-access', 'yolo'], ['unattended', 'auto']] as const) {
  const config = { agentId: 'kimi', permissionMode: mode, collaborationMode: 'plan' } as SessionConfig
  assert.doesNotThrow(() => assertKimiWebConfig(config))
  assert.equal(profileFromConfig(config).permission_mode, native)
  assert.equal(profileFromConfig(config).plan_mode, true, 'permissions must not remove Plan')
  assert.equal(kimiWebContract([], { permission: native }, { agentId: 'kimi', permissionMode: 'ask' }).currentPermissionMode, mode,
    'the displayed mode must follow the native status, not stale saved config')
}
assert.throws(() => assertKimiWebConfig({ agentId: 'kimi', permissionMode: 'deny-unapproved' } as SessionConfig), /权限|模式|批准/)
assert.throws(() => profileFromConfig({ agentId: 'kimi', permissionMode: 'invalid' } as unknown as SessionConfig), /权限|模式|permission/)
assert.throws(() => kimiWebContract([], { permission: 'unknown' }), /权限|模式|permission/)

const claude = BUILTIN_AGENTS.find(agent => agent.id === 'claude')!
assert.ok(claude.capabilities.permissionModes.some(mode => mode.id === 'deny-unapproved'))
const grok = BUILTIN_AGENTS.find(agent => agent.id === 'grok')!
assert.equal(grok.capabilities.permissionModes.find(mode => mode.id === 'full-access')?.label, '自动代批')
assert.equal(grok.capabilities.permissionModes.some(mode => mode.id === 'approve-for-me'), false,
  'Grok must not advertise a native Auto mode absent from the ACP contract')
assert.deepEqual(deepseekHostPermissionModes({ options: [{ value: 'auto' }, { value: 'read-only' }, { value: 'workspace-write' }] }).map(mode => mode.id), ['approve-for-me', 'read-only', 'ask'])
assert.throws(() => deepseekHostPermissionModes({ options: [] }), /权限/)
assert.throws(() => deepseekHostPermissionModes({ options: [{ value: 'unknown-preset' }] }), /权限/)
const zcode = BUILTIN_AGENTS.find(agent => agent.id === 'zcode')!
assert.deepEqual(zcode.capabilities.permissionModes.map(mode => mode.id), ['ask', 'auto-edit', 'guarded', 'full-access'])
for (const [native, mode] of [['build', 'ask'], ['edit', 'auto-edit'], ['guarded', 'guarded'], ['yolo', 'full-access']] as const) {
  assert.equal(zcodeSessionContract({ config: { mode: native } } as any, { providerId: 'p', modelId: 'm' }).currentPermissionMode, mode)
}

const directory = await mkdtemp(join(tmpdir(), 'ua-permission-modes-'))
try {
  const cases: Array<[string, PermissionMode]> = [['kimi', 'unattended'], ['claude', 'deny-unapproved'], ['zcode', 'guarded'], ['kimi', 'full-access']]
  const sessions: Session[] = cases.map(([agentId, permissionMode], index) => ({
    id: `permission-${index}`, title: 'Permission', status: 'idle', createdAt: index + 1,
    config: { agentId, workdir: directory, permissionMode }
  }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  sessions[0].agentContract = kimiWebContract([], { permission: 'auto' })
  store.save(sessions)
  assert.deepEqual(store.load().map(session => session.config.permissionMode), cases.map(([, mode]) => mode),
    'new modes and the existing Kimi yolo mode must survive restart')
  assert.equal(store.load()[0].agentContract?.currentPermissionMode, 'unattended')
  assert.deepEqual(store.load()[0].agentContract?.permissionModes.map(mode => mode.id), ['ask', 'full-access', 'unattended'])
  const stale = { ...sessions[0], config: { ...sessions[0].config, permissionMode: 'full-access' as const },
    agentContract: { ...sessions[0].agentContract!, currentPermissionMode: 'full-access' as const,
      permissionModes: sessions[0].agentContract!.permissionModes.filter(mode => mode.id !== 'unattended').map(mode => ({ ...mode, label: '旧权限名称' })) } }
  store.save([stale])
  const restored = new Orchestrator(id => BUILTIN_AGENTS.find(agent => agent.id === id), store, join(directory, 'artifacts'))
  await restored.loadPersisted()
  restored.reconcileAgentConfigs()
  assert.deepEqual(restored.getSessionById(stale.id)?.agentContract?.permissionModes.map(mode => mode.id), ['ask', 'full-access', 'unattended'],
    'existing idle sessions must show the updated permission catalog before their next turn')
  assert.equal(restored.getSessionById(stale.id)?.config.permissionMode, 'full-access', 'refreshing labels must not increase existing permissions')
  assert.equal(restored.reconcileAgentConfigs(), false, 'permission reconciliation must settle after one refresh')
  await restored.closeSessionLogs()
  const roles = new RoleStore(join(directory, 'roles.json'))
  for (const [index, [agentId, permissionMode]] of cases.entries()) roles.save({ id: `role-${index}`, name: 'Role', agentId, permissionMode })
  assert.deepEqual(roles.list().map(role => role.permissionMode), cases.map(([, mode]) => mode))
  const settings = new AppSettingsStore(directory)
  for (const [, mode] of cases) {
    settings.set({ feishu: { enabled: false, appId: '', appSecret: '', defaultPermissionMode: mode } })
    assert.equal(new AppSettingsStore(directory).get().feishu?.defaultPermissionMode, mode,
      'bot defaults must retain the same permission selection as local sessions')
  }
} finally { await rm(directory, { recursive: true, force: true }) }
console.log('PASS permission catalog, native mapping, effective state and persisted sessions/roles')
