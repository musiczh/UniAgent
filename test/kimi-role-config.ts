import assert from 'node:assert/strict'
import { assertKimiWebConfig, kimiSessionRuntimeEnv, kimiRoleUnavailableReason } from '../src/main/kimiRoleConfig.ts'
const config = { agentId:'kimi', workdir:'/tmp', permissionMode:'ask' as const }
assert.deepEqual(kimiSessionRuntimeEnv('preset', { ...config, roleSnapshot:{ id:'preset', name:'Preset', agentId:'kimi', permissionMode:'ask', model:'native-model' } }), {})
for (const role of [
  { instructions:'literal system instruction' },
  { skills:[] },
  { toolPolicy:{ mode:'allow-only' as const, tools:['Read'] } }
]) {
 const snapshot = { id:'restricted', name:'Restricted', agentId:'kimi', permissionMode:'ask' as const, ...role }
 assert.match(kimiRoleUnavailableReason(snapshot) || '', /Kimi Web/)
 assert.throws(() => assertKimiWebConfig({ ...config, roleSnapshot:snapshot }), /Kimi Web/)
 assert.deepEqual(kimiSessionRuntimeEnv('restricted', { ...config, roleSnapshot:snapshot }), {}, 'read-only history never applies unsupported role instructions')
}
console.log('kimi-role-config: native config unchanged; unsupported role policies fail closed')
