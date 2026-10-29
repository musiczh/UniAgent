import assert from 'node:assert/strict'
import test from 'node:test'
import { agentExternalStatus, agentRuntimeStatus } from '../src/shared/agentStatusView.ts'
import { agentQuotaConsole, quotaRemainingWindow, quotaSummaryText } from '../src/shared/agentQuota.ts'

const base = {
  id: 'codex', name: 'Codex', bin: '/opt/homebrew/bin/codex', adapter: 'codex', icon: '', builtin: true,
  installed: true, version: '0.163.0', models: [],
  capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] }
}

function agent(lifecycle, extra = {}) {
  const availability = lifecycle.availability ?? 'available'
  return {
    ...base, ...extra,
    installed: availability !== 'not-installed',
    lifecycle: { availability, auth: 'authenticated', health: 'healthy', updateStatus: 'idle', checkedAt: 1, ...lifecycle }
  }
}

test('外部状态只暴露可用 / 异常 / 可更新', () => {
  assert.deepEqual(agentExternalStatus(agent({ updateStatus: 'current' })), { label: '可用', tone: 'ok' })
  assert.deepEqual(agentExternalStatus(agent({ updateStatus: 'idle' })), { label: '可用', tone: 'ok' })
  assert.deepEqual(agentExternalStatus(agent({ updateStatus: 'available' })), { label: '可更新', tone: 'warn' })
  assert.deepEqual(agentExternalStatus(agent({ availability: 'unhealthy' })), { label: '异常', tone: 'warn' })
  assert.deepEqual(agentExternalStatus(agent({ availability: 'needs-auth' })), { label: '异常', tone: 'warn' })
  assert.deepEqual(agentExternalStatus(agent({ availability: 'not-installed' })), { label: '异常', tone: 'warn' })
  assert.deepEqual(agentExternalStatus(agent({ detectionStatus: 'failed', availability: 'unhealthy' })), { label: '异常', tone: 'warn' })
  assert.deepEqual(agentExternalStatus(agent({ incompatible: true, availability: 'unhealthy' })), { label: '异常', tone: 'warn' })
})

test('外部状态不把过程态当成稳态结论', () => {
  // 后台检查失败不代表 Agent 不可用，仍然按可用展示。
  assert.deepEqual(agentExternalStatus(agent({ updateStatus: 'failed' })), { label: '可用', tone: 'ok' })
  // 不支持应用内更新的 Agent 不能被误判为可更新。
  assert.deepEqual(agentExternalStatus(agent({ updateStatus: 'available', selfUpdateSupported: false })), { label: '可用', tone: 'ok' })
  // 用户主动发起的更新与检测仍在进行，需要明确反馈。
  assert.deepEqual(agentExternalStatus(agent({ updateStatus: 'updating' })), { label: '更新中', tone: 'warn' })
  assert.deepEqual(agentExternalStatus(agent({ detectionStatus: 'detecting' })), { label: '检测中…', tone: 'off' })
})

test('运行状态仍区分未安装与待登录', () => {
  assert.deepEqual(agentRuntimeStatus(agent({ availability: 'not-installed' })), { label: '未安装', tone: 'off' })
  assert.deepEqual(agentRuntimeStatus(agent({ availability: 'needs-auth' })), { label: '待登录', tone: 'warn' })
  assert.deepEqual(agentRuntimeStatus(agent({ availability: 'available' })), { label: '可用', tone: 'ok' })
})

test('额度摘要取最紧张的窗口或账户余额', () => {
  assert.equal(quotaSummaryText(null), null)
  assert.equal(quotaSummaryText({ status: 'ready', kind: 'windows', windows: [] }), null)
  assert.equal(quotaSummaryText({ status: 'ready', kind: 'windows', windows: [{ label: '5 小时限额', usedPercent: 18 }] }), '剩余 82%')
  assert.equal(quotaSummaryText({
    status: 'ready', kind: 'windows',
    windows: [{ label: '5 小时限额', usedPercent: 18 }, { label: '周限额', usedPercent: 91 }]
  }), '剩余 9%')
  assert.equal(quotaSummaryText({ status: 'ready', kind: 'balance', balances: [{ currency: 'CNY', total: '12.34' }] }), '余额 ¥12.34')
  assert.equal(quotaSummaryText({ status: 'ready', kind: 'balance', balances: [{ currency: 'CNY', total: 'n/a' }] }), '余额 CNY n/a')
})

test('剩余百分比选择最紧张的有效窗口，并处理耗尽、满额与异常输入', () => {
  for (const quota of [null, undefined, { kind: 'balance', balances: [{ currency: 'CNY', total: '12.34' }] }, { kind: 'windows', windows: [] },
    { kind: 'windows', windows: [{ label: '无效', usedPercent: NaN }, { label: '无效', usedPercent: Infinity }] }]) {
    assert.equal(quotaRemainingWindow(quota), null)
  }
  const windows = [{ label: '5 小时限额', usedPercent: 18 }, { label: '无效', usedPercent: NaN }, { label: '周限额', usedPercent: 91 }]
  assert.deepEqual(quotaRemainingWindow({ kind: 'windows', windows }), { label: '周限额', remainPercent: 9 })
  assert.equal(windows[0].label, '5 小时限额', '不能改变缓存窗口顺序')
  for (const [usedPercent, remainPercent] of [[0, 100], [100, 0], [-10, 100], [110, 0], [12.5, 87.5]]) {
    assert.deepEqual(quotaRemainingWindow({ kind: 'windows', windows: [{ label: '额度', usedPercent }] }), { label: '额度', remainPercent })
  }
})

test('额度回退控制台全部走浏览器，Nika、内网 TraeX 与自定义 Agent 不跳转', () => {
  const urls = {
    codex: 'https://chatgpt.com/codex/settings/usage', claude: 'https://claude.ai/settings/usage',
    grok: 'https://console.x.ai/', kimi: 'https://www.kimi.com/code/console', deepseek: 'https://platform.deepseek.com/'
  }
  for (const [adapter, url] of Object.entries(urls)) {
    const target = agentQuotaConsole(agent({}, { adapter, name: adapter }))
    assert.deepEqual(target, { label: '控制台', ariaLabel: `打开 ${adapter} 控制台查看额度`, url })
  }
  const cn = agentQuotaConsole(agent({}, { adapter: 'mcode' }))
  assert.match(String(cn?.url), /^https:\/\/platform\.minimaxi\.com\//)
  const global = agentQuotaConsole(agent({}, { adapter: 'mcode' }), 'global')
  assert.match(String(global?.url), /^https:\/\/platform\.minimax\.io\//)
  assert.equal(agentQuotaConsole(agent({}, { adapter: 'mcode', mcode: { region: 'global' } }))?.url, global?.url)
  for (const adapter of ['nika', 'traex', 'generic']) assert.equal(agentQuotaConsole(agent({}, { adapter })), null)
  const zcode = agent({}, { adapter: 'zcode' })
  assert.equal(agentQuotaConsole(zcode)?.url, 'https://www.bigmodel.cn/coding-plan/personal/usage')
  assert.equal(agentQuotaConsole(zcode, undefined, 'bigmodel-api')?.url, 'https://bigmodel.cn/finance/overview')
  for (const service of ['zai-coding', 'zai-api']) assert.equal(agentQuotaConsole(zcode, undefined, service)?.url, 'https://z.ai/manage-apikey/billing')
})
