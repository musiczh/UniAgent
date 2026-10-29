import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLifecycleService, lifecycleCommandWhitelist } from '../src/main/agentLifecycleService.ts'
import { AppSettingsStore } from '../src/main/appSettingsStore.ts'

const base = {
  id: 'codex', name: 'Codex', bin: '/safe/codex', adapter: 'codex', icon: '', builtin: true,
  installed: true, version: 'codex-cli 1.2.3', models: [],
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] }
}

const grokBase = {
  id: 'grok', name: 'Grok', bin: '/safe/grok', adapter: 'grok', icon: '', builtin: true,
  installed: true, version: 'grok 1.0.13 (5e9a58528b76)', models: [
    { id: 'grok-4.6', label: 'Grok 4.6', efforts: ['xhigh', 'high', 'medium', 'low'], defaultEffort: 'high', contextWindow: 500000 }
  ], defaultModel: 'grok-4.6',
  capabilities: {
    modelSelect: true, reasoningEffort: true, permissionModes: [
      { id: 'read-only', label: '只读' },
      { id: 'ask', label: '请求批准' },
      { id: 'approve-for-me', label: '帮我批准' },
      { id: 'full-access', label: '完全访问' }
    ], streaming: true, protocol: 'acp', imageAttachments: false, fileAttachments: true,
    sessionList: true, sessionLoad: true, sessionResume: true, sessionFork: false
  }
}

const kimiBase = {
  ...base, id: 'kimi', name: 'Kimi Code', bin: '/safe/kimi', adapter: 'kimi', version: '2.0.2',
  capabilities: { ...base.capabilities, streaming: true, protocol: 'acp' }
}

test('authentication service errors retain the installed program and are not a login requirement', async () => {
  for (const stderr of ['network timeout', 'EACCES permission denied', 'configuration parse error']) {
    const service = new AgentLifecycleService({ detect: async () => [base], runner: async (_bin, spec) => spec.args[0] === '--version'
      ? { code: 0, stdout: '1.2.3', stderr: '' } : { code: 1, stdout: '', stderr } })
    const [agent] = await service.detectAll(true)
    assert.equal(agent.installed, true)
    assert.equal(agent.lifecycle.availability, 'unhealthy')
    assert.equal(agent.lifecycle.auth, 'unknown')
    assert.equal(agent.lifecycle.detectionStatus, 'failed')
  }
})

test('Claude configured third-party models work without an official account and still require a healthy CLI', async () => {
  const claude = { ...base, id: 'claude', adapter: 'claude', version: '2.1.300',
    models: [{ id: 'uniagent-model:third-party:kimi:k3', label: 'k3', efforts: [], modelSource: { kind: 'third-party', sourceId: 'kimi' } }] }
  for (const healthy of [true, false]) {
    const service = new AgentLifecycleService({ detect: async () => [claude], runner: async (_bin, spec) => spec.args[0] === '--version'
      ? { code: healthy ? 0 : 1, stdout: healthy ? '2.1.300 (Claude Code)' : '', stderr: '' }
      : { code: 1, stdout: '', stderr: 'not logged in' } })
    const [result] = await service.detectAll(true)
    assert.equal(result.lifecycle.availability, healthy ? 'available' : 'unhealthy')
    assert.equal(result.lifecycle.auth, 'unknown', 'configured API Key is not a verified official subscription')
  }
  const service = new AgentLifecycleService({ detect: async () => [{ ...claude, models: [] }],
    runner: async (_bin, spec) => ({ code: spec.args[0] === '--version' ? 0 : 1, stdout: spec.args[0] === '--version' ? '2.1.300' : '{"loggedIn":false}', stderr: '' }) })
  assert.equal((await service.detectAll(true))[0].lifecycle.availability, 'needs-auth')
})

test('Codex reuses an external Provider or a checked local model without requiring an OpenAI login', async () => {
  for (const source of ['third-party', 'local', 'native-provider']) {
    const codex = { ...base, ...(source === 'native-provider' ? { authenticationRequired: false } : {}),
      models: [{ id: 'external-model', label: 'external-model', efforts: [], ...(source !== 'native-provider' ? { modelSource: { kind: source, sourceId: 'existing' } } : {}) }] }
    const service = new AgentLifecycleService({ detect: async () => [codex], runner: async (_bin, spec) => spec.args[0] === '--version'
      ? { code: 0, stdout: '1.2.3', stderr: '' } : { code: 1, stdout: '', stderr: 'not logged in' } })
    const [detected] = await service.detectAll(true)
    assert.equal(detected.lifecycle.availability, 'available', source)
    assert.equal(detected.lifecycle.auth, 'unknown')
  }
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('cold startup exposes pending builtin rows before any CLI is launched', () => {
  const service = new AgentLifecycleService()
  const pending = service.snapshot()
  assert.ok(pending.length > 0)
  assert.ok(pending.every(agent => agent.lifecycle.detectionStatus === 'detecting'))
  assert.ok(pending.every(agent => agent.lifecycle.detectionPhase === 'preparing'))
  assert.ok(pending.every(agent => agent.lifecycle.availability !== 'available'))
  assert.ok(pending.every(agent => !agent.lifecycle.detectionError))
})

test('availability refreshes preserve completed update checks without checking versions again', async () => {
  for (const status of ['current', 'available', 'failed']) {
    let updateChecks = 0
    const service = new AgentLifecycleService({
      detect: async (scope) => scope === 'protocol' ? [] : [base],
      runner: async (_bin, spec) => {
        if (spec.args[0] === 'view') {
          updateChecks++
          return status === 'failed' ? { code: 1, stdout: '', stderr: 'registry timeout' }
            : { code: 0, stdout: JSON.stringify(status === 'available' ? '1.2.4' : '1.2.3'), stderr: '' }
        }
        return { code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' }
      }
    })
    await service.detectAll(true)
    assert.equal(updateChecks, 0)
    const checked = await service.checkUpdate('codex')
    assert.equal(checked.lifecycle.updateStatus, status)
    const verifyRetained = () => {
      const lifecycle = service.snapshot()[0].lifecycle
      assert.equal(lifecycle.updateStatus, status)
      assert.equal(lifecycle.availableVersion, checked.lifecycle.availableVersion)
      if (status === 'failed') assert.equal(lifecycle.message, checked.lifecycle.message)
      assert.equal(updateChecks, 1, '只有显式检查更新才查询版本')
    }
    await service.detectAll(true); verifyRetained()
    await service.detectOne('codex'); verifyRetained()
    const startup = service.detectStartup()
    await startup.protocol; verifyRetained()
  }
})

test('a changed executable or version invalidates previous update results without starting a check', async () => {
  for (const change of ['version', 'path', 'uninstalled']) {
    let changed = false, updateChecks = 0
    const service = new AgentLifecycleService({
      detect: async () => [{ ...base, ...(changed ? change === 'path' ? { bin: '/other/codex' }
        : change === 'uninstalled' ? { installed: false } : { version: '2.0.0' } : {}) }],
      runner: async (_bin, spec) => {
        if (spec.args[0] === 'view') { updateChecks++; return { code: 0, stdout: '"1.2.4"', stderr: '' } }
        return { code: 0, stdout: spec.args[0] === '--version' ? changed && change === 'version' ? '2.0.0' : '1.2.3' : 'Logged in', stderr: '' }
      }
    })
    await service.detectAll(true)
    assert.equal((await service.checkUpdate('codex')).lifecycle.updateStatus, 'available')
    changed = true
    const [refreshed] = await service.detectAll(true)
    assert.equal(refreshed.lifecycle.updateStatus, 'idle', change)
    assert.equal(refreshed.lifecycle.availableVersion, undefined, change)
    assert.equal(updateChecks, 1)
  }
})

test('full detection replaces old errors with progress and publishes ready siblings independently', async () => {
  const finish = deferred(), sibling = deferred()
  let attempts = 0
  const oldFailure = { ...kimiBase, incompatible: true, lifecycle: {
    availability: 'unhealthy', auth: 'unknown', health: 'unhealthy', updateStatus: 'idle',
    detectionStatus: 'failed', detectionError: 'old process cleanup error', checkedAt: 1
  } }
  const service = new AgentLifecycleService({
    detect: async (_scope, _id, onDetected) => {
      if (++attempts === 1) return [base, oldFailure, grokBase]
      await onDetected(grokBase)
      sibling.resolve()
      await finish.promise
      return [base, { ...kimiBase, incompatible: true, unavailableReason: 'final connection failure' }, grokBase]
    },
    runner: async (_bin, spec) => ({ code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' })
  })
  await service.detectAll(true)
  const events = []
  service.on('progress', event => events.push(event))
  const pending = service.detectAll(true)
  try {
    const waiting = service.snapshot().find(agent => agent.id === 'kimi')
    assert.equal(waiting.lifecycle.detectionStatus, 'detecting')
    assert.equal(waiting.lifecycle.detectionPhase, 'recovering')
    assert.equal(waiting.lifecycle.detectionError, undefined)
    await sibling.promise
    assert.equal(service.snapshot().find(agent => agent.id === 'grok').lifecycle.detectionStatus, undefined)
    assert.equal(service.snapshot().find(agent => agent.id === 'grok').lifecycle.availability, 'available')
    assert.equal(service.snapshot().find(agent => agent.id === 'kimi').lifecycle.detectionStatus, 'detecting')
    assert.ok(!events.some(event => event.phase === 'failed'), 'a pending recovery cannot publish a terminal failure')
  } finally { finish.resolve(); await pending }
  const failure = service.snapshot().find(agent => agent.id === 'kimi')
  assert.equal(failure.lifecycle.detectionStatus, 'failed')
  assert.equal(failure.lifecycle.detectionError, 'final connection failure')
  assert.equal(events.filter(event => event.agentId === 'kimi' && event.phase === 'failed').length, 1)
})

test('a rejected detector settles pending rows instead of leaving an endless loading state', async () => {
  let attempts = 0
  const failure = deferred()
  const service = new AgentLifecycleService({
    detect: async () => ++attempts === 1 ? [base] : failure.promise,
    runner: async (_bin, spec) => ({ code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' })
  })
  await service.detectAll(true)
  const pending = service.detectAll(true)
  assert.equal(service.snapshot()[0].lifecycle.detectionStatus, 'detecting')
  failure.reject(new Error('detector timeout'))
  await assert.rejects(pending, /detector timeout/)
  assert.equal(service.snapshot()[0].lifecycle.detectionStatus, 'failed')
  assert.equal(service.snapshot()[0].lifecycle.detectionError, 'detector timeout')
})

test('detect is single-flight and requires auth plus health before available', async () => {
  let detects = 0
  const calls = []
  const service = new AgentLifecycleService({
    detect: async () => { detects += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return [base] },
    runner: async (bin, spec) => { calls.push([bin, [...spec.args]]); return { code: 0, stdout: spec.args[0] === '--version' ? 'codex-cli 1.2.3' : 'Logged in', stderr: '' } }
  })
  const [left, right] = await Promise.all([service.detectAll(true), service.detectAll(true)])
  assert.equal(detects, 1)
  assert.equal(left[0].lifecycle.availability, 'available')
  assert.deepEqual(left, right)
  assert.ok(calls.every(([bin]) => bin === '/safe/codex'))
})

test('startup detection publishes core agents before protocol providers settle and merges Grok later', async () => {
  const protocol = deferred()
  const scopes = []
  let runnerCalls = 0
  const service = new AgentLifecycleService({
    detect: async (scope = 'all') => {
      scopes.push(scope)
      if (scope === 'core') return [base]
      if (scope === 'protocol') return protocol.promise
      return [base, grokBase]
    },
    runner: async (_bin, spec) => {
      runnerCalls += 1
      return { code: 0, stdout: spec.args[0] === '--version' ? 'codex-cli 1.2.3' : 'Logged in', stderr: '' }
    }
  })

  const startup = service.detectStartup()
  const core = await Promise.race([
    startup.core,
    new Promise((_, reject) => setTimeout(() => reject(new Error('core detection waited for protocol providers')), 100))
  ])
  assert.deepEqual(core.map((agent) => agent.id), ['codex'])
  assert.equal(core[0].lifecycle.availability, 'available')
  assert.deepEqual(service.snapshot().map((agent) => agent.id), ['codex'])

  protocol.resolve([grokBase])
  const complete = await startup.protocol
  assert.deepEqual(complete.map((agent) => agent.id), ['codex', 'grok'])
  assert.deepEqual(scopes.sort(), ['core', 'protocol'])
  assert.equal(complete[1].lifecycle.availability, 'available')
  assert.equal(complete[1].lifecycle.selfUpdateSupported, true)
  assert.equal(complete[1].capabilities.sessionResume, true)
  assert.equal(runnerCalls, 2, 'only Codex auth and health use the generic lifecycle runner')
})

test('protocol-provider startup failure preserves the ready core lifecycle snapshot', async () => {
  const protocol = deferred()
  const service = new AgentLifecycleService({
    detect: async (scope = 'all') => {
      if (scope === 'core') return [base]
      if (scope === 'protocol') return protocol.promise
      return [base, grokBase]
    },
    runner: async (_bin, spec) => ({
      code: 0, stdout: spec.args[0] === '--version' ? 'codex-cli 1.2.3' : 'Logged in', stderr: ''
    })
  })

  const startup = service.detectStartup()
  await startup.core
  protocol.reject(new Error('probe failed'))
  await assert.rejects(startup.protocol, /probe failed/)
  assert.deepEqual(service.snapshot().map((agent) => agent.id), ['codex'])
  assert.equal(service.snapshot()[0].lifecycle.availability, 'available')
})

test('verification exceptions retain the failed agent and do not discard healthy siblings', async () => {
  const service = new AgentLifecycleService({
    detect: async () => [base, kimiBase, grokBase],
    runner: async (bin, spec) => {
      if (bin === kimiBase.bin) throw new Error('Kimi CLI 检测超时')
      return { code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' }
    }
  })
  const agents = await service.detectAll(true)
  assert.deepEqual(agents.map(agent => agent.id), ['codex', 'kimi', 'grok'])
  assert.equal(agents[1].lifecycle.detectionStatus, 'failed')
  assert.equal(agents[1].lifecycle.detectionError, 'Kimi CLI 检测超时')
  assert.equal(agents[0].lifecycle.availability, 'available')
  assert.equal(agents[2].lifecycle.availability, 'available')
})

test('single-agent retry is single-flight, clears failure and preserves other agents', async () => {
  const retry = deferred()
  const calls = []
  const failed = { ...kimiBase, lifecycle: { availability: 'unhealthy', auth: 'unknown', health: 'unhealthy', updateStatus: 'idle', detectionStatus: 'failed', detectionError: '检测超时', checkedAt: 1 } }
  const service = new AgentLifecycleService({
    detect: async (scope, id) => { calls.push([scope, id]); return id ? retry.promise : [base, failed, grokBase] },
    runner: async (_bin, spec) => ({ code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' })
  })
  await service.detectAll(true)
  const before = service.snapshot()
  const events = []
  service.on('progress', progress => events.push(progress))
  const first = service.detectOne('kimi')
  assert.equal(service.detectOne('kimi'), first)
  assert.equal(service.snapshot()[1].lifecycle.detectionStatus, 'detecting')
  retry.resolve([kimiBase])
  const result = await first
  assert.equal(result.id, 'kimi')
  assert.equal(result.lifecycle.availability, 'available')
  assert.equal(result.lifecycle.detectionStatus, undefined)
  assert.equal(service.snapshot()[0], before[0])
  assert.equal(service.snapshot()[2], before[2])
  assert.deepEqual(calls, [['all', undefined], ['all', 'kimi']])
  assert.deepEqual(events.map(event => event.phase), ['detecting', 'completed'])
  const count = calls.length
  await assert.rejects(service.detectOne('unknown'), /unknown_agent/)
  assert.equal(calls.length, count)
})

test('retry failure remains visible with its new reason and a later retry can recover', async () => {
  let attempts = 0
  const service = new AgentLifecycleService({
    detect: async (_scope, id) => {
      if (!id) return [base, kimiBase]
      if (++attempts === 1) throw new Error('Kimi Web 服务连接超时')
      return [kimiBase]
    },
    runner: async (_bin, spec) => ({ code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' })
  })
  await service.detectAll(true)
  const failed = await service.detectOne('kimi')
  assert.equal(failed.lifecycle.detectionStatus, 'failed')
  assert.equal(failed.lifecycle.detectionError, 'Kimi Web 服务连接超时')
  assert.ok(failed.lifecycle.lastReadyAt, 'failed refresh retains the last confirmed detail state')
  assert.equal(service.snapshot().length, 2)
  assert.equal((await service.detectOne('kimi')).lifecycle.availability, 'available')
})

test('an older full detection cannot overwrite a newer single-agent retry', async () => {
  const full = deferred()
  let detections = 0
  const service = new AgentLifecycleService({
    detect: async (_scope, id) => id ? [{ ...kimiBase, version: '9.0.0' }] : ++detections === 1 ? [base, kimiBase] : full.promise,
    runner: async (_bin, spec) => ({ code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' })
  })
  await service.detectAll(true)
  const pending = service.detectAll(true)
  await service.detectOne('kimi')
  full.resolve([{ ...base, name: 'Refreshed Codex' }, kimiBase])
  await pending
  assert.equal(service.snapshot().find(agent => agent.id === 'kimi').version, '9.0.0')
  assert.equal(service.snapshot().find(agent => agent.id === 'codex').name, 'Refreshed Codex')
})

test('startup verification failure keeps the failed protocol provider and its healthy siblings', async () => {
  const service = new AgentLifecycleService({
    detect: async scope => scope === 'core' ? [base] : [kimiBase, grokBase],
    runner: async (bin, spec) => {
      if (bin === kimiBase.bin) throw new Error('Kimi CLI 检测超时')
      return { code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' }
    }
  })
  const startup = service.detectStartup()
  await startup.core
  const complete = await startup.protocol
  assert.deepEqual(complete.map(agent => agent.id), ['codex', 'kimi', 'grok'])
  assert.equal(complete[1].lifecycle.detectionStatus, 'failed')
  assert.equal(complete[2].lifecycle.availability, 'available')
})

test('update checks cannot overwrite a retry or preserve its transient detecting state', async () => {
  for (const duringRetry of [false, true]) {
    const retry = deferred(), update = deferred()
    let checks = 0
    const service = new AgentLifecycleService({
      detect: async (_scope, id) => id ? retry.promise : [base],
      runner: async (_bin, spec) => {
        if (spec.args[0] === 'view') { checks++; return update.promise }
        return { code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' }
      }
    })
    await service.detectAll(true)
    const before = duringRetry ? undefined : service.checkUpdate('codex')
    const pending = service.detectOne('codex')
    const checking = before || service.checkUpdate('codex')
    if (duringRetry) assert.equal(checks, 0, 'checking must wait for the current agent probe')
    await assert.rejects(service.updateOne('codex', () => false), /agent_detection_in_progress/)
    retry.resolve([{ ...base, name: 'Codex re-detected' }])
    await pending
    update.resolve({ code: 0, stdout: '"1.2.3"', stderr: '' })
    await checking
    assert.equal(service.snapshot()[0].name, 'Codex re-detected')
    assert.equal(service.snapshot()[0].lifecycle.detectionStatus, undefined)
  }
})

test('a DeepSeek update check preserves a detection failure reason', async () => {
  const service = new AgentLifecycleService({
    detect: async () => [{ ...base, id: 'deepseek', adapter: 'deepseek', incompatible: true, unavailableReason: 'Host 协议检查失败' }],
    runner: async () => ({ code: 0, stdout: '"0.2.1-rc.2"', stderr: '' })
  })
  await service.detectAll(true)
  await service.checkAllUpdates()
  assert.equal(service.snapshot()[0].lifecycle.detectionStatus, 'failed')
  assert.equal(service.snapshot()[0].lifecycle.detectionError, 'Host 协议检查失败')
})

test('startup detection is single-flight while either scope is pending', async () => {
  const core = deferred()
  const protocol = deferred()
  const scopes = []
  const service = new AgentLifecycleService({
    detect: async (scope = 'all') => {
      scopes.push(scope)
      if (scope === 'core') return core.promise
      if (scope === 'protocol') return protocol.promise
      return [base, grokBase]
    },
    runner: async (_bin, spec) => ({
      code: 0, stdout: spec.args[0] === '--version' ? 'codex-cli 1.2.3' : 'Logged in', stderr: ''
    })
  })

  const first = service.detectStartup()
  const second = service.detectStartup()
  assert.equal(first, second)
  assert.equal(first.core, second.core)
  assert.equal(first.protocol, second.protocol)
  assert.deepEqual(scopes.sort(), ['core', 'protocol'])

  core.resolve([base])
  await first.core
  assert.equal(service.detectStartup(), first, 'protocol providers still pending keep the startup flight active')
  protocol.resolve([grokBase])
  await first.protocol
})

test('a stale startup protocol result cannot overwrite a newer forced full detection', async () => {
  const protocol = deferred()
  const refreshed = { ...base, name: 'Codex refreshed', version: 'codex-cli 2.0.0' }
  let allDetections = 0
  const service = new AgentLifecycleService({
    detect: async (scope = 'all') => {
      if (scope === 'core') return [base]
      if (scope === 'protocol') return protocol.promise
      allDetections += 1
      return [refreshed]
    },
    runner: async (_bin, spec) => ({
      code: 0, stdout: spec.args[0] === '--version' ? 'codex-cli 2.0.0' : 'Logged in', stderr: ''
    })
  })

  const startup = service.detectStartup()
  await startup.core
  const latest = await service.detectAll(true)
  assert.equal(allDetections, 1)
  assert.deepEqual(latest.map((agent) => agent.name), ['Codex refreshed'])

  protocol.resolve([grokBase])
  const staleCompletion = await startup.protocol
  assert.deepEqual(staleCompletion.map((agent) => agent.name), ['Codex refreshed'])
  assert.deepEqual(service.snapshot().map((agent) => agent.name), ['Codex refreshed'])
  assert.equal(service.snapshot().some((agent) => agent.id === 'grok'), false, 'the stale protocol result must not leak into the newer snapshot')
})

test('late protocol merge preserves newer core lifecycle state from the same startup generation', async () => {
  const protocol = deferred()
  const service = new AgentLifecycleService({
    detect: async (scope = 'all') => {
      if (scope === 'core') return [base]
      if (scope === 'protocol') return protocol.promise
      return [base, grokBase]
    },
    runner: async (_bin, spec) => ({
      code: 0, stdout: spec.args[0] === '--version' ? 'codex-cli 1.2.3' : 'Logged in', stderr: ''
    })
  })

  const startup = service.detectStartup()
  await startup.core
  await service.checkUpdate('codex')
  assert.equal(service.snapshot()[0].lifecycle.updateStatus, 'failed')

  protocol.resolve([grokBase])
  const merged = await startup.protocol
  assert.equal(merged.find((agent) => agent.id === 'codex').lifecycle.updateStatus, 'failed')
  assert.equal(merged.some((agent) => agent.id === 'grok'), true)
})

test('installed but logged out is not available', async () => {
  const service = new AgentLifecycleService({
    detect: async () => [base],
    runner: async (_bin, spec) => spec.args[0] === '--version'
      ? { code: 0, stdout: '1.2.3', stderr: '' }
      : { code: 1, stdout: '', stderr: 'not logged in' }
  })
  const agents = await service.detectAll(true)
  assert.equal(agents[0].lifecycle.availability, 'needs-auth')
})

test('updates use fixed argv and active sessions are rejected', async () => {
  const calls = []
  const service = new AgentLifecycleService({
    detect: async () => [base],
    runner: async (bin, spec) => { calls.push([bin, [...spec.args]]); return { code: 0, stdout: '1.2.3', stderr: '' } }
  })
  await service.detectAll(true)
  await assert.rejects(() => service.updateOne('codex', () => true), /agent_has_active_session/)
  await service.updateOne('codex', () => false)
  assert.ok(calls.some(([, args]) => args.length === 1 && args[0] === 'update'))
  assert.deepEqual(lifecycleCommandWhitelist().codex.update.args, ['update'])
})

test('Codex updates the detected shared executable even when it is outside PATH', async () => {
  const calls = []
  const service = new AgentLifecycleService({
    detect: async () => [{ ...base, bin: '/safe/shared/bin/codex' }],
    runner: async (bin, spec) => {
      calls.push([bin, [...spec.args]])
      return { code: 0, stdout: 'codex-cli 1.2.3', stderr: '' }
    }
  })

  await service.detectAll(true)
  await service.updateOne('codex', () => false)

  assert.ok(calls.some(([bin, args]) => bin === '/safe/shared/bin/codex' && args[0] === 'update'))
  assert.equal(calls.some(([bin, args]) => bin === 'codex' && args[0] === 'update'), false)
})

test('a successful update command still fails when the installed version stays old', async () => {
  const service = new AgentLifecycleService({
    detect: async () => [base],
    runner: async (_bin, spec) => ({
      code: 0,
      stdout: spec.args[0] === 'view' ? '"1.2.4"' : 'codex-cli 1.2.3',
      stderr: ''
    })
  })

  await service.detectAll(true)
  await service.checkUpdate('codex')
  await assert.rejects(() => service.updateOne('codex', () => false), /当前版本仍为 1\.2\.3/)
  assert.equal(service.snapshot()[0].lifecycle.updateStatus, 'failed')
})

test('npm-global Claude updates the checked version in its own install prefix', async () => {
  const claude = {
    ...base, id: 'claude', name: 'Claude Code', bin: '/safe/bin/claude', adapter: 'claude',
    version: '2.1.233 (Claude Code)'
  }
  const calls = []
  const moves = []
  let installCalls = 0
  const service = new AgentLifecycleService({
    detect: async () => [claude],
    resolveExecutable: async () => '/safe/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    moveFile: async (source, destination) => { moves.push([source, destination]) },
    runner: async (bin, spec) => {
      calls.push([bin, [...spec.args]])
      if (spec.args[0] === '--version') return { code: 0, stdout: '2.1.233 (Claude Code)', stderr: '' }
      if (spec.args[0] === 'view') return { code: 0, stdout: '"2.1.266"', stderr: '' }
      if (spec.args[0] === 'install' && ++installCalls === 1) return {
        code: 1,
        stdout: '',
        stderr: [
          'npm error code ENOTEMPTY',
          'npm error dest /safe/lib/node_modules/@anthropic-ai/.claude-code-AbC123'
        ].join('\n')
      }
      return { code: 0, stdout: 'ok', stderr: '' }
    }
  })

  await service.detectAll(true)
  await service.checkUpdate('claude')
  await service.updateOne('claude', () => false)

  assert.ok(calls.some(([bin, args]) =>
    bin === '/safe/bin/npm' &&
    JSON.stringify(args) === JSON.stringify([
      'install', '--global', '--prefix', '/safe', '@anthropic-ai/claude-code@2.1.266'
    ])
  ))
  assert.equal(calls.some(([bin, args]) => bin === '/safe/bin/claude' && args[0] === 'update'), false)
  assert.equal(installCalls, 2)
  assert.equal(moves.length, 1)
  assert.equal(moves[0][0], '/safe/lib/node_modules/@anthropic-ai/.claude-code-AbC123')
  assert.match(moves[0][1], /^\/safe\/lib\/node_modules\/@anthropic-ai\/\.claude-code-AbC123\.uniagent-stale-\d+$/)
})

test('native Claude installations keep using the CLI updater', async () => {
  const claude = {
    ...base, id: 'claude', name: 'Claude Code', bin: '/safe/bin/claude', adapter: 'claude',
    version: '2.1.233 (Claude Code)'
  }
  const calls = []
  const service = new AgentLifecycleService({
    detect: async () => [claude],
    resolveExecutable: async () => '/safe/share/claude/versions/2.1.233',
    runner: async (bin, spec) => {
      calls.push([bin, [...spec.args]])
      return { code: 0, stdout: spec.args[0] === '--version' ? '2.1.233 (Claude Code)' : 'ok', stderr: '' }
    }
  })

  await service.detectAll(true)
  await service.updateOne('claude', () => false)

  assert.ok(calls.some(([bin, args]) => bin === '/safe/bin/claude' && args[0] === 'update'))
})

test('updating Claude verifies only Claude and preserves the other agents and their completed checks', async () => {
  const traex = {
    ...base, id: 'traex', name: 'TraeX', bin: '/safe/bin/traecli', adapter: 'traex',
    version: 'traecli 1.2.3'
  }
  const claude = {
    ...base, id: 'claude', name: 'Claude Code', bin: '/safe/bin/claude', adapter: 'claude',
    version: '2.1.233 (Claude Code)'
  }
  let claudeUpdated = false
  const detections = []
  const service = new AgentLifecycleService({
    detect: async (scope, id) => {
      detections.push([scope, id])
      return [base, traex, claude, { ...kimiBase, installed: !claudeUpdated }].filter(agent => !id || agent.id === id)
    },
    resolveExecutable: async () => '/safe/share/claude/versions/2.1.233',
    runner: async (bin, spec) => {
      if (spec.args[0] === '--version') {
        if (bin === claude.bin) return { code: 0, stdout: claudeUpdated ? '2.1.234 (Claude Code)' : claude.version, stderr: '' }
        return { code: 0, stdout: '1.2.3', stderr: '' }
      }
      if (spec.args[0] === 'view') {
        return { code: 0, stdout: spec.args.includes('@anthropic-ai/claude-code') ? '"2.1.234"' : '"1.2.3"', stderr: '' }
      }
      if (bin === traex.bin && spec.args[0] === 'update') {
        return { code: 0, stdout: 'Latest TraeCode CLI version: 1.2.4', stderr: '' }
      }
      if (bin === kimiBase.bin) return { code: 0, stdout: 'Options: --yes', stderr: '' }
      if (bin === claude.bin && spec.args[0] === 'update') claudeUpdated = true
      return { code: 0, stdout: 'Logged in', stderr: '' }
    }
  })

  await service.detectAll(true)
  await service.checkUpdate('codex')
  await service.checkUpdate('traex')
  await service.checkUpdate('claude')
  const unchanged = service.snapshot().filter(agent => agent.id !== 'claude')
  const before = new Map(service.snapshot().map((agent) => [agent.id, agent.lifecycle]))

  await service.updateOne('claude', () => false)

  const after = new Map(service.snapshot().map((agent) => [agent.id, agent.lifecycle]))
  assert.equal(after.get('codex').updateStatus, 'current')
  assert.equal(after.get('codex').checkedAt, before.get('codex').checkedAt)
  assert.equal(after.get('traex').updateStatus, 'available')
  assert.equal(after.get('traex').availableVersion, '1.2.4')
  assert.equal(after.get('traex').checkedAt, before.get('traex').checkedAt)
  assert.equal(after.get('claude').updateStatus, 'current')
  assert.equal(after.get('claude').currentVersion, '2.1.234')
  for (const agent of unchanged) assert.equal(service.snapshot().find(item => item.id === agent.id), agent)
  assert.deepEqual(detections, [['all', undefined], ['all', 'claude']])
})

test('updating an agent preserves another agent pending update check and its eventual result', async (t) => {
  for (const code of [0, 1]) await t.test(code === 0 ? 'available update' : 'failed check', async () => {
    const traex = { ...base, id: 'traex', bin: '/safe/traecli', adapter: 'traex' }
    const check = deferred()
    const service = new AgentLifecycleService({
      detect: async (_scope, id) => [base, traex].filter(agent => !id || agent.id === id),
      runner: async (bin, spec) => {
        if (bin === traex.bin && spec.args[0] === 'update') return check.promise
        return { code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' }
      }
    })
    await service.detectAll(true)
    const pending = service.checkUpdate('traex')
    const checking = service.snapshot().find(agent => agent.id === 'traex')
    let afterUpdate
    try {
      await service.updateOne('codex', () => false)
      afterUpdate = service.snapshot().find(agent => agent.id === 'traex')
    } finally { check.resolve({ code, stdout: code === 0 ? 'Latest TraeCode CLI version: 1.2.4' : '', stderr: code === 1 ? 'network error' : '' }) }
    const result = await pending
    assert.equal(afterUpdate, checking)
    assert.equal(result.lifecycle.updateStatus, code === 0 ? 'available' : 'failed')
    assert.equal(result.lifecycle.availableVersion, code === 0 ? '1.2.4' : undefined)
    assert.equal(service.snapshot().find(agent => agent.id === 'traex'), result)
  })
})

test('parallel updates keep Kimi installed while its executable is being replaced', async () => {
  const started = deferred(), installed = deferred()
  let replacing = false, kimiVersion = '2.2.0'
  const detections = []
  const service = new AgentLifecycleService({
    detect: async (scope, id) => {
      detections.push([scope, id])
      return [base, { ...kimiBase, installed: !replacing, version: kimiVersion }].filter(agent => !id || agent.id === id)
    },
    runner: async (bin, spec) => {
      if (bin !== kimiBase.bin) return { code: 0, stdout: spec.args[0] === '--version' ? '1.2.3' : 'Logged in', stderr: '' }
      if (spec.args.includes('--help')) return { code: 0, stdout: 'Options: --yes', stderr: '' }
      if (spec.args.includes('--yes')) {
        replacing = true
        started.resolve()
        await installed.promise
        replacing = false
        kimiVersion = '2.3.0'
      }
      return { code: 0, stdout: spec.args[0] === '--version' ? kimiVersion : 'A newer version of @moonshot-ai/kimi-code is available (2.2.0 -> 2.3.0).\nDetected install source: npm-global', stderr: '' }
    }
  })
  await service.detectAll(true)
  const kimiUpdate = service.updateOne('kimi', () => false)
  await started.promise
  const updating = service.snapshot().find(agent => agent.id === 'kimi')
  let duringReplacement
  try {
    await assert.rejects(service.detectOne('kimi'), /agent_update_in_progress/)
    await service.updateOne('codex', () => false)
    duringReplacement = service.snapshot().find(agent => agent.id === 'kimi')
  } finally { installed.resolve(); await kimiUpdate }
  assert.equal(duringReplacement, updating)
  assert.equal(duringReplacement.installed, true)
  assert.equal(duringReplacement.lifecycle.updateStatus, 'updating')
  assert.deepEqual(detections, [['all', undefined], ['all', 'codex'], ['all', 'kimi']])
  assert.deepEqual(service.snapshot().map(agent => [agent.id, agent.installed, agent.lifecycle.updateStatus]), [
    ['codex', true, 'current'], ['kimi', true, 'current']
  ])
  assert.equal(service.snapshot().find(agent => agent.id === 'kimi').lifecycle.currentVersion, '2.3.0')
})

test('a full refresh waits for running updates before probing executables', async () => {
  const started = deferred(), finish = deferred()
  let installed = false
  const detections = []
  const service = new AgentLifecycleService({
    detect: async (scope, id) => { detections.push([scope, id]); return [base] },
    runner: async (_bin, spec) => {
      if (spec.args[0] === 'update') { started.resolve(); await finish.promise; installed = true }
      return { code: 0, stdout: spec.args[0] === '--version' ? installed ? '1.2.4' : '1.2.3' : 'Logged in', stderr: '' }
    }
  })
  await service.detectAll(true)
  const update = service.updateOne('codex', () => false)
  await started.promise
  const updating = service.snapshot()[0]
  const refresh = service.detectAll(true)
  let duringUpdate, probes
  try {
    await new Promise(resolve => setImmediate(resolve))
    duringUpdate = service.snapshot()[0]
    probes = detections.length
  } finally { finish.resolve(); await Promise.all([update, refresh]) }
  assert.equal(duringUpdate, updating)
  assert.equal(probes, 1, 'full refresh must not probe a CLI while its updater is running')
  assert.deepEqual(detections, [['all', undefined], ['all', 'codex'], ['all', undefined]])
  assert.equal(service.snapshot()[0].lifecycle.currentVersion, '1.2.4')
})

test('an earlier full refresh cannot overwrite an agent whose executable is being updated', async () => {
  const full = deferred(), started = deferred(), finish = deferred()
  let detections = 0, installed = false
  const service = new AgentLifecycleService({
    detect: async (_scope, id) => id ? [{ ...base, version: '1.2.4' }] : ++detections === 1 ? [base] : full.promise,
    runner: async (_bin, spec) => {
      if (spec.args[0] === 'update') { started.resolve(); await finish.promise; installed = true }
      return { code: 0, stdout: spec.args[0] === '--version' ? installed ? '1.2.4' : '1.2.3' : 'Logged in', stderr: '' }
    }
  })
  await service.detectAll(true)
  const refresh = service.detectAll(true)
  const update = service.updateOne('codex', () => false)
  await started.promise
  const updating = service.snapshot()[0]
  let duringUpdate
  try {
    full.resolve([{ ...base, installed: false }])
    await refresh
    duringUpdate = service.snapshot()[0]
  } finally { finish.resolve(); await update }
  assert.equal(duringUpdate, updating)
  assert.equal(service.snapshot()[0].lifecycle.currentVersion, '1.2.4')
  assert.equal(service.snapshot()[0].lifecycle.updateStatus, 'current')
})

test('whitelist matches real CLIs and Codex checks npm without invoking its updater', async () => {
  const whitelist = lifecycleCommandWhitelist()
  assert.deepEqual(Object.keys(whitelist).sort(), ['claude', 'codex', 'deepseek', 'grok', 'kimi', 'mcode', 'traex'])
  assert.deepEqual(whitelist.codex.auth.args, ['login', 'status'])
  assert.deepEqual(whitelist.codex.checkUpdate.args, ['view', '@openai/codex', 'version', '--json'])
  assert.deepEqual(whitelist.codex.update.args, ['update'])
  assert.deepEqual(whitelist.traex.auth.args, ['login', 'status'])
  assert.deepEqual(whitelist.traex.checkUpdate.args, ['update', 'check'])
  assert.deepEqual(whitelist.traex.update.args, ['update'])
  assert.deepEqual(whitelist.claude.auth.args, ['auth', 'status'])
  assert.deepEqual(whitelist.claude.checkUpdate.args, ['view', '@anthropic-ai/claude-code', 'version', '--json'])
  assert.deepEqual(whitelist.claude.update.args, ['update'])
  assert.deepEqual(whitelist.grok.auth.args, ['login'])
  assert.deepEqual(whitelist.grok.health.args, ['--version'])
  assert.deepEqual(whitelist.grok.checkUpdate.args, ['update', '--check', '--json'])
  assert.deepEqual(whitelist.grok.update.args, ['update'])
  assert.deepEqual(whitelist.kimi.checkUpdate.args, ['upgrade'])
  assert.deepEqual(whitelist.kimi.update.args, ['upgrade', '--yes'])
  // Update checks are read-only; updates use the same external mcode executable.
  assert.deepEqual(whitelist.mcode.health.args, ['--version'])
  assert.deepEqual(whitelist.mcode.checkUpdate.args, ['view', '@minimax-ai/code', 'version', '--json', '--registry=https://registry.npmjs.org'])
  assert.deepEqual(whitelist.mcode.update.args, ['update'])

  let updateCalls = 0
  const calls = []
  const service = new AgentLifecycleService({
    detect: async () => [base],
    runner: async (bin, spec) => {
      calls.push([bin, [...spec.args]])
      if (spec.args[0] === 'update') updateCalls += 1
      return { code: 0, stdout: spec.args[0] === 'view' ? '"1.2.4"' : '1.2.3', stderr: '' }
    }
  })
  await service.detectAll(true)
  const checked = await service.checkUpdate('codex')
  assert.equal(checked.lifecycle.updateStatus, 'available')
  assert.equal(checked.lifecycle.availableVersion, '1.2.4')
  assert.ok(calls.some(([bin, args]) => /npm(?:\.cmd)?$/.test(bin) && args[0] === 'view'))
  assert.equal(updateCalls, 0, 'read-only check must never invoke codex update')
})

test('Grok probe status is authoritative for authentication and does not run a fake login status command', async () => {
  let runnerCalls = 0
  const readyService = new AgentLifecycleService({
    detect: async () => [grokBase],
    runner: async () => { runnerCalls += 1; return { code: 1, stdout: '', stderr: 'must not run' } }
  })
  const [ready] = await readyService.detectAll(true)
  assert.equal(ready.lifecycle.availability, 'available')
  assert.equal(ready.lifecycle.auth, 'authenticated')
  assert.equal(ready.lifecycle.health, 'healthy')
  assert.equal(ready.lifecycle.currentVersion, '1.0.13')
  assert.equal(runnerCalls, 0)

  const needsAuthService = new AgentLifecycleService({
    detect: async () => [{
      ...grokBase, authenticationRequired: true, unavailableReason: 'Authentication required'
    }],
    runner: async () => { runnerCalls += 1; return { code: 1, stdout: '', stderr: 'must not run' } }
  })
  const [needsAuth] = await needsAuthService.detectAll(true)
  assert.equal(needsAuth.lifecycle.availability, 'needs-auth')
  assert.equal(needsAuth.lifecycle.auth, 'required')
  assert.equal(needsAuth.lifecycle.health, 'healthy')
  assert.equal(needsAuth.lifecycle.message, 'Authentication required')
  assert.equal(runnerCalls, 0)
})

test('Grok update check accepts its current JSON contract and the legacy aliases', async (t) => {
  const cases = [
    ['new release', JSON.stringify({ currentVersion: '1.0.13', latestVersion: '1.1.0', channel: 'stable', updateAvailable: true }), 'available', '1.1.0'],
    ['legacy aliases', JSON.stringify({ current: '1.0.13', latest: '1.0.13', channel: 'stable', updateAvailable: false }), 'current', '1.0.13'],
    ['human text is rejected', 'latest version: 9.9.9', 'failed', undefined],
    ['malformed JSON is rejected', '{"latest":', 'failed', undefined],
    ['wrong field types are rejected', JSON.stringify({ current: '1.0.13', latest: 2, channel: 'stable' }), 'failed', undefined]
  ]

  for (const [name, output, expectedStatus, expectedAvailable] of cases) {
    await t.test(name, async () => {
      const service = new AgentLifecycleService({
        detect: async () => [grokBase],
        runner: async (_bin, spec) => {
          assert.deepEqual(spec.args, ['update', '--check', '--json'])
          return { code: 0, stdout: output, stderr: '' }
        }
      })
      const [detected] = await service.detectAll(true)
      assert.equal(detected.lifecycle.availability, 'available')
      const checked = await service.checkUpdate('grok')
      assert.equal(checked.lifecycle.currentVersion, '1.0.13')
      assert.equal(checked.lifecycle.availableVersion, expectedAvailable)
      assert.equal(checked.lifecycle.updateStatus, expectedStatus)
    })
  }
})

function kimiUpdater({ source = 'native installer', updateResult, apply = true, incompatible = false, output, help = 'Options: -y, --yes', installedVersion, healthCode = 0 } = {}) {
  let version = '2.2.0', updated = false
  const calls = []
  const service = new AgentLifecycleService({
    detect: async () => [{ ...kimiBase, version, incompatible: updated && incompatible }],
    runner: async (bin, spec) => {
      assert.equal(bin, kimiBase.bin)
      assert.equal(spec.cwd, tmpdir())
      calls.push([...spec.args])
      if (spec.args.includes('--help')) return { code: 0, stdout: help, stderr: '' }
      if (spec.args[0] === '--version') return { code: healthCode, stdout: installedVersion || version, stderr: '' }
      if (spec.args.includes('--yes')) {
        updated = true
        if (apply) version = '2.3.0'
        return updateResult || { code: 0, stdout: 'Updated @moonshot-ai/kimi-code to 2.3.0. Restart the CLI to use the new version.', stderr: '' }
      }
      assert.deepEqual(spec.args, ['upgrade'])
      return { code: 0, stderr: '', stdout: output ?? (version === '2.3.0'
        ? 'Kimi Code is already up to date (v2.3.0).'
        : `A newer version of @moonshot-ai/kimi-code is available (2.2.0 -> 2.3.0).\nDetected install source: ${source}\nTo update manually, run: ignored`) }
    }
  })
  return { service, calls }
}

test('Kimi supports official update sources, rechecks before updating and reports the actual new version', async () => {
  for (const source of ['native installer', 'npm-global', 'pnpm-global', 'yarn-global', 'bun-global']) {
    const { service, calls } = kimiUpdater({ source })
    assert.equal((await service.detectAll(true))[0].lifecycle.selfUpdateSupported, true)
    assert.equal((await service.checkAllUpdates())[0].lifecycle.updateStatus, 'available')
    const result = await service.updateOne('kimi', () => false)
    assert.equal(result.lifecycle.currentVersion, '2.3.0')
    assert.equal(result.lifecycle.updateStatus, 'current')
    assert.equal(calls.filter(args => args[0] === 'upgrade' && args.length === 1).length, 2, 'refresh source and target before mutation')
    assert.equal(calls.filter(args => args.includes('--yes')).length, 1)
  }
})

test('Kimi refuses unsupported sources and malformed checks even when update is requested without a prior check', async () => {
  for (const options of [{ source: 'homebrew' }, { source: 'unsupported package manager or layout.' }, { output: 'unexpected output' }, { help: 'Options: --help' }]) {
    const { service, calls } = kimiUpdater(options)
    await service.detectAll(true)
    await assert.rejects(service.updateOne('kimi', () => false))
    assert.ok(!calls.some(args => args.includes('--yes')))
  }
})

test('Kimi update handles current versions, active sessions, failed installs and stale or incompatible services', async () => {
  const current = kimiUpdater({ output: 'Kimi Code is already up to date (v2.2.0).' })
  await current.service.detectAll(true)
  assert.equal((await current.service.updateOne('kimi', () => false)).lifecycle.updateStatus, 'current')
  assert.ok(!current.calls.some(args => args.includes('--yes')))
  const active = kimiUpdater()
  await active.service.detectAll(true)
  await assert.rejects(active.service.updateOne('kimi', () => true), /agent_has_active_session/)
  assert.ok(!active.calls.some(args => args.includes('--yes')))
  for (const options of [{ apply: false }, { installedVersion: '2.4.0' }, { healthCode: 1 }, { incompatible: true }, { updateResult: { code: 1, stdout: '', stderr: 'network error' } }, { updateResult: { code: 1, stdout: '', stderr: '', timedOut: true } }]) {
    const { service } = kimiUpdater(options)
    await service.detectAll(true)
    await assert.rejects(service.updateOne('kimi', () => false))
    assert.equal(service.snapshot()[0].lifecycle.updateStatus, 'failed')
  }
})

test('TraeX update check only offers a strictly newer explicit latest semver', async (t) => {
  const current = '0.201.6-alpha.4'
  const cases = [
    ['same prerelease', `Latest TraeCode CLI version: ${current}`, 'current', current],
    ['older prerelease', 'Latest TraeCode CLI version: 0.201.6-alpha.3', 'current', '0.201.6-alpha.3'],
    ['newer prerelease', 'Latest TraeCode CLI version: 0.201.6-alpha.5', 'available', '0.201.6-alpha.5'],
    ['newer stable release', 'Latest TraeCode CLI version: 0.201.6', 'available', '0.201.6'],
    ['no latest field', `Current TraeCode CLI version: ${current}\nStatus: up to date`, 'current', undefined]
  ]

  for (const [name, output, expectedStatus, expectedAvailable] of cases) {
    await t.test(name, async () => {
      const traex = {
        ...base, id: 'traex', name: 'TraeX', bin: '/safe/traecli', adapter: 'traex',
        version: `traecli ${current}(internal edition)`
      }
      const service = new AgentLifecycleService({
        detect: async () => [traex],
        runner: async (_bin, spec) => {
          if (spec.args[0] === '--version') {
            return { code: 0, stdout: `traecli ${current}(internal edition)`, stderr: '' }
          }
          if (spec.args[0] === 'update') return { code: 0, stdout: output, stderr: '' }
          return { code: 0, stdout: 'Logged in', stderr: '' }
        }
      })

      const [detected] = await service.detectAll(true)
      assert.equal(detected.lifecycle.currentVersion, current)
      const checked = await service.checkUpdate('traex')
      assert.equal(checked.lifecycle.currentVersion, current)
      assert.equal(checked.lifecycle.availableVersion, expectedAvailable)
      assert.equal(checked.lifecycle.updateStatus, expectedStatus)
    })
  }
})

test('app settings are versioned and expose complete application defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ua-settings-'))
  try {
    const store = new AppSettingsStore(dir)
    assert.deepEqual(store.get(), {
      schemaVersion: 1,
      autoUpdateAgentsOnLaunch: false,
      autoUpdateAgentsWhenIdle: false,
      autoCheckUpdate: true,
      theme: 'system',
      notificationMode: 'unfocused',
      coverSidebar: false,
      preventSleep: false,
      requirementsEnabled: false,
      sidebarShortcuts: ['history', 'agent', 'tokens'],
      enabledAgentIds: INTERNAL_DISTRIBUTION ? ['codex', 'traex'] : ['codex']
    })
    assert.equal(store.set({ autoUpdateAgentsOnLaunch: true }).autoUpdateAgentsOnLaunch, true)
    assert.equal(store.set({ autoUpdateAgentsWhenIdle: true }).autoUpdateAgentsWhenIdle, true)
    assert.equal(new AppSettingsStore(dir).get().autoUpdateAgentsWhenIdle, true)
    assert.equal(store.set({ autoUpdateAgentsOnLaunch: false }).autoUpdateAgentsWhenIdle, true)
    assert.equal(store.set({ autoUpdateAgentsWhenIdle: false }).autoUpdateAgentsWhenIdle, false)
    writeFileSync(join(dir, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: true }))
    assert.equal(store.get().autoUpdateAgentsWhenIdle, false, 'legacy settings keep idle updates disabled')
    writeFileSync(join(dir, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: true, autoUpdateAgentsWhenIdle: 'true' }))
    assert.equal(store.get().autoUpdateAgentsWhenIdle, false, 'invalid values cannot enable automatic updates')
    assert.equal(store.get().schemaVersion, 1)
    const job = store.beginInitialization('traex')
    store.attachInitialization(job, 'session-1')
    assert.equal(store.pendingInitialization('session-1').id, job)
    assert.equal(store.settleInitialization(job, true), true)
    assert.equal(store.settleInitialization(job, true), false, 'settlement is idempotent')
    assert.equal(store.metrics().initializationAttempts, 1)
    assert.equal(store.metrics().initializationSuccesses, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('different agents have independent update flights', async () => {
  const traex = { ...base, id: 'traex', name: 'TraeX', bin: '/safe/traecli', adapter: 'traex' }
  const service = new AgentLifecycleService({
    detect: async () => [base, traex],
    runner: async (_bin, spec) => {
      if (spec.args[0] === 'update') await new Promise((resolve) => setTimeout(resolve, 5))
      return { code: 0, stdout: '1.2.3', stderr: '' }
    }
  })
  await service.detectAll(true)
  const [codex, tx] = await Promise.all([service.updateOne('codex', () => false), service.updateOne('traex', () => false)])
  assert.equal(codex.id, 'codex')
  assert.equal(tx.id, 'traex')
})

const deepseekBase = {
  ...base, id: 'deepseek', name: 'DeepSeek Harness', bin: '/safe/dsh', adapter: 'deepseek', version: '0.2.1-rc.2',
  capabilities: { ...base.capabilities, streaming: true, protocol: 'acp' }
}
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

test('DeepSeek Harness checks the qualified registry version and supports in-app update', async (t) => {
  const cases = [
    ['qualified release pending', '0.2.0-rc.2', '"0.2.1-rc.2"', 'available', '0.2.1-rc.2'],
    ['already current', '0.2.1-rc.2', '"0.2.1-rc.2"', 'current', '0.2.1-rc.2'],
    ['detected version ahead of the qualified release', '0.2.2', '"0.2.1-rc.2"', 'current', '0.2.1-rc.2']
  ]
  for (const [name, current, output, expectedStatus, expectedVersion] of cases) {
    await t.test(name, async () => {
      const service = new AgentLifecycleService({
        detect: async () => [{ ...deepseekBase, version: current }],
        runner: async (bin, spec) => {
          assert.equal(bin, npmBin)
          assert.deepEqual(spec.args.slice(0, 2), ['view', '@deepseek-ai/dsh@0.2.1-rc.2'],
            'the check asks for the qualified release, never the latest dist-tag')
          return { code: 0, stdout: output, stderr: '' }
        }
      })
      const [detected] = await service.detectAll(true)
      assert.equal(detected.lifecycle.availability, 'available')
      assert.equal(detected.lifecycle.selfUpdateSupported, true, 'managed runtime is updated by UniAgent itself')
      const checked = await service.checkUpdate('deepseek')
      assert.equal(checked.lifecycle.currentVersion, current)
      assert.equal(checked.lifecycle.availableVersion, expectedVersion)
      assert.equal(checked.lifecycle.updateStatus, expectedStatus)
    })
  }
})

test('DeepSeek Harness update reinstalls the managed runtime at the checked version', async () => {
  let installed = false
  const service = new AgentLifecycleService({
    detect: async () => [{ ...deepseekBase, incompatible: !installed, version: installed ? '0.2.1-rc.2' : '0.2.0-rc.2' }],
    runner: async () => ({ code: 0, stdout: '"0.2.1-rc.2"', stderr: '' }),
    deepseekUpdate: async (version) => {
      assert.equal(version, '0.2.1-rc.2', 'update installs the qualified registry version')
      installed = true
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  await service.detectAll(true)
  await service.checkAllUpdates()
  assert.equal(service.snapshot()[0].lifecycle.updateStatus, 'available', 'incompatible installed runtimes remain discoverable for update')
  await assert.rejects(service.updateOne('deepseek', () => true), /agent_has_active_session/)
  const updated = await service.updateOne('deepseek', () => false)
  assert.equal(updated.lifecycle.currentVersion, '0.2.1-rc.2')
  assert.equal(updated.lifecycle.updateStatus, 'current')
  assert.equal(updated.lifecycle.availableVersion, undefined)
  assert.equal(updated.lifecycle.availability, 'available')
})

test('DeepSeek post-update validation reports the actual failure and allows a retry', async () => {
  let attempts = 0
  const service = new AgentLifecycleService({
    detect: async () => [{ ...deepseekBase, incompatible: attempts === 1, unavailableReason: attempts === 1 ? '模型目录加载失败' : undefined }],
    runner: async () => ({ code: 0, stdout: '"0.2.1-rc.2"', stderr: '' }),
    deepseekUpdate: async () => { attempts++; return { code: 0, stdout: '', stderr: '' } }
  })
  await service.detectAll(true)
  await assert.rejects(service.updateOne('deepseek', () => false), /模型目录加载失败/)
  assert.equal(service.snapshot()[0].lifecycle.updateStatus, 'failed')
  const updated = await service.updateOne('deepseek', () => false)
  assert.equal(updated.lifecycle.availability, 'available')
  assert.equal(updated.lifecycle.updateStatus, 'current')
})

test('DeepSeek offers the qualified runtime when an incompatible version is newer or unknown', async () => {
  for (const version of ['0.3.0', '']) {
    const service = new AgentLifecycleService({
      detect: async () => [{ ...deepseekBase, version, incompatible: true }],
      runner: async () => ({ code: 0, stdout: '"0.2.1-rc.2"', stderr: '' })
    })
    await service.detectAll(true)
    const checked = await service.checkUpdate('deepseek')
    assert.equal(checked.lifecycle.updateStatus, 'available')
    assert.equal(checked.lifecycle.availableVersion, '0.2.1-rc.2')
  }
})

test('DeepSeek Harness update surfaces the managed install failure reason', async () => {
  const service = new AgentLifecycleService({
    detect: async () => [{ ...deepseekBase, version: '0.2.0-rc.2' }],
    runner: async () => ({ code: 0, stdout: '"0.2.1-rc.2"', stderr: '' }),
    deepseekUpdate: async () => ({ code: 1, stdout: '', stderr: 'DeepSeek Harness 需要 Node.js 22.19+ 或 24+，请先升级 Node.js' })
  })
  await service.detectAll(true)
  await service.checkUpdate('deepseek')
  await assert.rejects(service.updateOne('deepseek', () => false), /Node\.js 22\.19/)
  const lifecycle = service.snapshot()[0].lifecycle
  assert.equal(lifecycle.updateStatus, 'failed')
  assert.match(lifecycle.message, /Node\.js 22\.19/)
})

test('MiniMax updates the detected external executable instead of provisioning another runtime', async () => {
  let updated = false
  const calls = []
  const native = { ...base, id: 'mcode', name: 'MiniMax Code', adapter: 'mcode', bin: '/external/bin/mcode', version: '0.6.12' }
  const service = new AgentLifecycleService({
    detect: async () => [{ ...native, version: updated ? '0.6.13' : '0.6.12' }],
    runner: async (bin, spec) => {
      calls.push([bin, [...spec.args]])
      if (spec.args[0] === 'view') return { code: 0, stdout: '"0.6.13"', stderr: '' }
      if (spec.args[0] === 'update') { assert.equal(bin, native.bin); updated = true }
      return { code: 0, stdout: updated ? '0.6.13' : '0.6.12', stderr: '' }
    }
  })
  await service.detectAll(true)
  await service.checkUpdate('mcode')
  const result = await service.updateOne('mcode', () => false)
  assert.equal(result.lifecycle.currentVersion, '0.6.13')
  assert.deepEqual(calls.filter(([, args]) => args[0] === 'update'), [[native.bin, ['update']]])
  assert.ok(!calls.some(([, args]) => args[0] === 'install'))
})
