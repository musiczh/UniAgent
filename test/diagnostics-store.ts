import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticsStore, runtimeDiagnosticSample } from '../src/main/diagnostics.ts'

const root = mkdtempSync(join(tmpdir(), 'uniagent-diagnostics-'))

try {
  const store = new DiagnosticsStore(join(root, 'diagnostics.jsonl'))
  const imported = store.record({
    category: 'session_import',
    level: 'error',
    source: 'session-import',
    agentId: 'codex',
    sessionId: 'native-1',
    code: 'operation_failed',
    message: '导入失败',
    sample: { message: 'broken history' }
  })
  store.record({
    category: 'session_import',
    level: 'error',
    source: 'session-import',
    agentId: 'codex',
    sessionId: 'native-1',
    code: 'operation_failed',
    message: '导入失败'
  })
  const runtime = store.record({
    category: 'app_runtime',
    level: 'warn',
    source: 'renderer',
    agentId: 'app',
    code: 'operation_failed',
    message: '渲染警告 token=secret-token'
  })

  assert.deepEqual(
    store.list().map(({ category, source, count }) => ({ category, source, count })),
    [
      { category: 'app_runtime', source: 'renderer', count: 1 },
      { category: 'session_import', source: 'session-import', count: 2 }
    ],
    'category must participate in deduplication and repeated entries must still collapse'
  )

  const selectedReport = store.formatReport([runtime.id])
  assert.match(selectedReport, /App 运行错误日志/)
  assert.match(selectedReport, /运行环境: .*Node /)
  assert.match(selectedReport, /渲染警告/)
  assert.doesNotMatch(selectedReport, /secret-token/, 'copied diagnostics must redact credentials')
  assert.doesNotMatch(selectedReport, /导入失败/)
  assert.ok(
    store.record({
      category: 'app_runtime',
      level: 'error',
      source: 'renderer',
      agentId: 'app',
      code: 'oversized',
      message: 'x'.repeat(100_000)
    }).message.length <= 12_001,
    'one runtime error must not grow the bounded log without limit'
  )

  store.remove([runtime.id])
  store.remove(store.list().filter(({ code }) => code === 'oversized').map(({ id }) => id))
  assert.deepEqual(store.list().map(({ id }) => id), [imported.id])

  store.remove([imported.id])
  assert.deepEqual(store.list(), [])

  const reconnects = new DiagnosticsStore(join(root, 'reconnects.jsonl'))
  let reconnectEmits = 0
  reconnects.on('diagnostic', () => { reconnectEmits += 1 })
  reconnects.record({
    category: 'app_runtime',
    level: 'error',
    source: 'agent',
    agentId: 'traex',
    code: 'agent_run_error',
    message: 'Reconnecting… 1/5'
  })
  reconnects.record({
    category: 'app_runtime',
    level: 'error',
    source: 'agent',
    agentId: 'traex',
    code: 'agent_run_error',
    message: 'stream disconnected before completion: Transport error: network error: error decoding response body'
  })
  reconnects.record({
    category: 'app_runtime',
    level: 'error',
    source: 'agent',
    agentId: 'traex',
    code: 'agent_run_error',
    message: "stream disconnected before completion: We're sorry, the param is invalid."
  })
  assert.deepEqual(
    reconnects.list().map(({ message }) => message),
    ["stream disconnected before completion: We're sorry, the param is invalid."],
    'transient reconnect progress must not enter runtime diagnostics'
  )
  assert.doesNotMatch(reconnects.formatReport(), /Reconnecting/)
  assert.equal(reconnectEmits, 1, 'filtered reconnect progress must not raise a diagnostic badge')
  assert.doesNotMatch(readFileSync(join(root, 'reconnects.jsonl'), 'utf8'), /Reconnecting/)

  const expectedNoise = new DiagnosticsStore(join(root, 'expected-noise.jsonl'))
  let expectedNoiseEmits = 0
  expectedNoise.on('diagnostic', () => { expectedNoiseEmits += 1 })
  for (const field of [
    'notification:account/updated:unsupported_method',
    'notification:hook/started:unsupported_method',
    'notification:hook/completed:unsupported_method',
    'notification:turn/started:unsupported_method',
    'notification:thread/status/changed:unsupported_method',
    'notification:thread/inboxStatus/updated:unsupported_method',
    'notification:thread/started:unsupported_method',
    'notification:remoteControl/status/changed:unsupported_method',
    'notification:account/rateLimits/updated:unsupported_method',
    'notification:account/rateLimits/updated:missing_rate_limits',
    'notification:thread/worktreeSession/entered:unsupported_method',
    'notification:thread/worktreeSession/updated:unsupported_method',
    'notification:item/commandExecution/terminalInteraction:unsupported_method',
    'item:taskNotification:started',
    'item:taskNotification:completed'
  ]) {
    expectedNoise.record({
      category: 'app_runtime', level: 'warn', source: 'traex-app-server',
      agentId: 'traex', code: 'ignored_provider_event', field, message: field
    })
  }
  expectedNoise.record({
    category: 'app_runtime', level: 'error', source: 'session:refreshNative',
    agentId: 'app', code: 'ipc_rejected',
    message: "Error invoking remote method 'session:refreshNative': Error: 当前会话正在运行，无法刷新"
  })
  expectedNoise.record({
    category: 'app_runtime', level: 'error', source: 'session:refreshNative',
    agentId: 'app', code: 'ipc_rejected',
    message: "Error invoking remote method 'session:refreshNative': Error: 会话状态已变化，请稍后刷新"
  })
  for (const phase of ['started', 'completed']) {
    expectedNoise.record({
      category: 'app_runtime', level: 'warn', source: 'traex-app-server',
      agentId: 'traex', code: 'ignored_provider_event',
      field: `item:collabAgentToolCall:${phase}:missing_subagent_state`,
      message: `item:collabAgentToolCall:${phase}:missing_subagent_state`,
      sample: { type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: [], agentsStates: {} }
    })
  }
  const conversationHints = [
    'Skill descriptions were shortened to fit the 2% skills context budget. TraeCode can still see every skill.',
    'Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible.',
    'This session was recorded with model `gpt-6-astra` but is resuming with `gpt-5.6-sol`. Consider switching back to `gpt-6-astra` as it may affect Codex performance.'
  ]
  for (const code of ['agent_run_warning', 'side_run_warning']) {
    for (const message of conversationHints) {
      expectedNoise.record({
        category: 'app_runtime', level: 'warn', source: code === 'agent_run_warning' ? 'agent' : 'side-agent',
        agentId: 'traex', code, message
      })
    }
  }
  for (const code of ['agent_run_warning', 'side_run_warning']) {
    expectedNoise.record({
      category: 'app_runtime', level: 'warn', source: code === 'agent_run_warning' ? 'agent' : 'side-agent',
      agentId: 'codex', code,
      message: 'Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted.'
    })
  }
  for (const code of ['agent_run_warning', 'side_run_warning']) {
    expectedNoise.record({
      category: 'app_runtime', level: 'warn', source: code === 'agent_run_warning' ? 'agent' : 'side-agent',
      agentId: 'codex', code,
      message: 'Model metadata for `k3-256k` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'
    })
  }
  for (const code of ['uncaught_exception', 'console_error']) {
    expectedNoise.record({
      category: 'app_runtime', level: 'error', source: code === 'uncaught_exception' ? 'renderer' : 'renderer-console',
      agentId: 'app', code,
      message: 'ResizeObserver loop completed with undelivered notifications.'
    })
  }
  expectedNoise.record({
    category: 'app_runtime', level: 'error', source: 'feishu', agentId: 'app',
    code: 'outbound_message_failed', message: '文件不在当前工作目录内：handoff-done.png'
  })
  assert.deepEqual(expectedNoise.list(), [], 'handled provider status and expected refresh conflicts are not diagnostics')
  assert.equal(expectedNoiseEmits, 0)

  const reviewed = new DiagnosticsStore(join(root, 'reviewed-runtime.jsonl'))
  const warning = 'TRAE CLI is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n  user: `desktop` is ignored.'
  assert.equal(reviewed.record({ category: 'app_runtime', source: 'agent', agentId: 'traex', level: 'warn', code: 'agent_run_warning', message: warning }), undefined)
  for (const feishuCode of [230072, 230075]) {
    assert.equal(reviewed.record({ category: 'app_runtime', source: 'feishu', agentId: 'app', level: 'error', code: 'feishu_title_sync_failed', message: 'HTTP 400', sample: { context: { feishuCode } } }), undefined)
  }
  for (const [source, code, message] of [
    ['agent', 'agent_run_warning', warning.replace('`desktop`', '`model`')],
    ['agent', 'agent_run_warning', warning + '\n  user: `model` is ignored.'],
    ['agent', 'agent_run_error', 'Unable to read usage limit configuration.'],
    ['agents:update', 'ipc_rejected', "Error invoking remote method 'agents:update': Error: agent_verification_failed"],
    ['feishu', 'feishu_title_sync_failed', 'update_thread_title timeout'],
    ['feishu', 'progress_card_update_failed', 'HTTP 400']
  ]) assert.ok(reviewed.record({ category: 'app_runtime', source, agentId: 'app', level: 'error', code, message }))
  assert.equal(reviewed.list().length, 6, 'unknown config, real failures and progress errors remain visible')

  const quotaFile = join(root, 'quota-filter.jsonl')
  const quota = new DiagnosticsStore(quotaFile)
  const quotaMessages = [
    'You’ve hit your usage limit. Upgrade or try again later.',
    "unexpected status 403 Forbidden: You've reached your 5-hour usage limit. Your quota will reset.",
    'You exceeded your current usage limit.',
    'Quota exhausted',
    '请求失败（HTTP 403），额度或用量已达上限，请等待重置或检查套餐'
  ]
  let quotaEmits = 0
  quota.on('diagnostic', () => { quotaEmits += 1 })
  for (const message of quotaMessages) {
    for (const [source, code] of [['agent', 'agent_run_error'], ['side-agent', 'side_run_error'], ['codex-sources', 'codex_source_http_error']]) {
      assert.equal(quota.record({ category: 'app_runtime', level: 'error', source, code, agentId: 'codex', message }), undefined)
    }
  }
  assert.equal(quota.record({ category: 'app_runtime', level: 'error', source: 'agent', code: 'agent_run_error', agentId: 'codex', message: 'Provider refused',
    sample: { context: { provider: { providerError: { codexErrorInfo: 'usageLimitExceeded' } } } } }), undefined)
  assert.equal(quotaEmits, 0)
  for (const message of [
    '请求失败（HTTP 403），请检查 API Key',
    '请求失败（HTTP 429），请检查额度或稍后重试',
    'Quota service unavailable',
    'Rate limited',
    'stream disconnected before completion: stream closed before response.completed',
    'unsupported_persisted_item_context',
    'Falling back from WebSockets to HTTPS transport. unexpected status 404 Not Found: Item not found.'
  ]) assert.ok(quota.record({ category: 'app_runtime', level: 'error', source: 'agent', code: 'agent_run_error', agentId: 'codex', message }))
  assert.ok(quota.record({ category: 'app_runtime', level: 'error', source: 'renderer', code: 'console_error', agentId: 'app', message: quotaMessages[0] }))
  assert.ok(quota.record({ category: 'session_import', level: 'error', source: 'session-import', code: 'operation_failed', agentId: 'codex', message: quotaMessages[0] }))
  assert.ok(quota.record({ category: 'app_runtime', level: 'error', source: 'agent', code: 'agent_run_error', agentId: 'codex', message: 'unknown error',
    sample: { context: { prompt: quotaMessages[0] } } }))
  const visibleCount = quota.list().length
  writeFileSync(quotaFile, readFileSync(quotaFile, 'utf8') + quotaMessages.map((message, i) => JSON.stringify({
    id: `historical-quota-${i}`, ts: Date.now(), count: 1, category: 'app_runtime', level: 'error', source: 'agent', code: 'agent_run_error', agentId: 'codex', message
  })).join('\n') + '\n')
  const reloadedQuota = new DiagnosticsStore(quotaFile)
  assert.equal(reloadedQuota.list().length, visibleCount, 'persisted quota rows also disappear without clearing unrelated diagnostics')
  assert.doesNotMatch(reloadedQuota.formatReport(), /historical-quota-/)

  const titleNoise = new DiagnosticsStore(join(root, 'title-noise.jsonl'))
  for (const sample of [{ name: '' }, JSON.stringify({ name: '  ' })]) {
    assert.equal(titleNoise.record({ category: 'app_runtime', level: 'warn', source: 'traex-app-server', agentId: 'traex', code: 'ignored_provider_event',
      field: 'notification:thread/name/generated:missing_thread_name', message: 'empty title', sample }), undefined)
  }
  for (const sample of [{}, { name: null }, '{malformed']) {
    assert.ok(titleNoise.record({ category: 'app_runtime', level: 'warn', source: 'traex-app-server', agentId: 'traex', code: 'ignored_provider_event',
      field: 'notification:thread/name/generated:missing_thread_name', message: 'malformed title', sample }))
  }

  const historicalFixedFile = join(root, 'historical-fixed-runtime.jsonl')
  const cutoff = Date.parse('2026-10-08T06:30:59.139Z')
  writeFileSync(historicalFixedFile, [cutoff, cutoff + 1].map((ts, index) => JSON.stringify({
    id: `grok-${index}`, ts, category: 'app_runtime', source: 'agent', agentId: 'grok', level: 'error', code: 'agent_run_error',
    message: 'Grok ACP 运行失败：Grok ACP 返回了未知 JSON-RPC 响应 id', count: 1
  })).join('\n'))
  const historicalFixed = new DiagnosticsStore(historicalFixedFile)
  assert.deepEqual(historicalFixed.list().map(entry => entry.id), ['grok-1'], 'future recurrences of fixed errors must remain visible')

  const hintsFile = join(root, 'historical-conversation-hints.jsonl')
  writeFileSync(hintsFile, ['agent_run_warning', 'side_run_warning'].flatMap((code) =>
    [...conversationHints, 'Unable to connect to provider'].map((message, index) => ({
      id: `${code}-${index}`, ts: Date.now(), level: 'warn', category: 'app_runtime',
      source: code === 'agent_run_warning' ? 'agent' : 'side-agent', agentId: 'traex', code, message, count: 1
    }))
  ).map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const historicalHints = new DiagnosticsStore(hintsFile)
  assert.deepEqual(historicalHints.list().map(({ message }) => message), [
    'Unable to connect to provider', 'Unable to connect to provider'
  ])
  assert.doesNotMatch(historicalHints.formatReport(), /Long threads|Skill descriptions|recorded with model/)

  expectedNoise.record({
    category: 'app_runtime', level: 'error', source: 'feishu', agentId: 'app',
    code: 'outbound_message_failed', message: '图片上传失败：report.png'
  })
  assert.deepEqual(
    expectedNoise.list().map(({ message }) => message),
    ['图片上传失败：report.png'],
    'real Feishu API failures must remain actionable'
  )
  expectedNoise.clear()

  expectedNoise.record({
    category: 'app_runtime', level: 'warn', source: 'traex-app-server',
    agentId: 'traex', code: 'ignored_provider_event',
    field: 'item:collabAgentToolCall:started:missing_subagent_state',
    message: 'non-wait collaboration item has no target',
    sample: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [], agentsStates: {} }
  })
  assert.equal(expectedNoise.list().length, 1, 'only empty wait snapshots are expected collaboration noise')
  expectedNoise.clear()

  const rich = expectedNoise.record({
    category: 'app_runtime', level: 'error', source: 'session:refreshNative',
    agentId: 'app', code: 'ipc_rejected', message: 'unexpected refresh failure',
    sample: { channel: 'session:refreshNative', error: { name: 'Error', stack: 'trace', token: 'secret-token' } }
  })!
  assert.match(rich.sample || '', /session:refreshNative/)
  assert.match(rich.sample || '', /trace/)
  assert.doesNotMatch(rich.sample || '', /secret-token/)

  const cause = new Error('socket closed')
  const outer = new Error('request failed', { cause }) as Error & { code?: string }
  outer.code = 'ECONNRESET'
  const errorSample = JSON.stringify(runtimeDiagnosticSample(outer, { channel: 'agent:send' }))
  assert.match(errorSample, /ECONNRESET/)
  assert.match(errorSample, /socket closed/)
  assert.match(errorSample, /agent:send/)
  assert.match(errorSample, /runtime/)

  const historicalFile = join(root, 'historical-reconnect.jsonl')
  writeFileSync(historicalFile, JSON.stringify({
    id: 'old-reconnect', ts: Date.now(), level: 'error', category: 'app_runtime',
    source: 'agent', agentId: 'traex', code: 'agent_run_error',
    message: 'Reconnecting... 2/5', count: 4
  }) + '\n')
  const historical = new DiagnosticsStore(historicalFile)
  assert.deepEqual(historical.list(), [], 'persisted reconnect progress must stay hidden after upgrade')
  assert.doesNotMatch(historical.formatReport(), /Reconnecting/)

  const historicalRuntimeFile = join(root, 'historical-runtime-fixes.jsonl')
  const oldRuntimeTs = Date.parse('2026-09-14T12:50:00.000Z')
  const currentRuntimeTs = Date.parse('2026-09-15T00:00:00.000Z')
  writeFileSync(historicalRuntimeFile, [
    {
      id: 'old-killed', ts: oldRuntimeTs, level: 'error', category: 'app_runtime',
      source: 'renderer', agentId: 'app', code: 'render_process_gone', message: 'killed', count: 1
    },
    {
      id: 'old-csp', ts: oldRuntimeTs, level: 'error', category: 'app_runtime',
      source: 'renderer-console', agentId: 'app', code: 'console_error',
      message: "The Content Security Policy 'default-src none' was delivered via a <meta> element outside the document's <head>, which is disallowed.",
      count: 1
    },
    {
      id: 'new-killed', ts: currentRuntimeTs, level: 'error', category: 'app_runtime',
      source: 'renderer', agentId: 'app', code: 'render_process_gone', message: 'killed', count: 1
    }
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const historicalRuntime = new DiagnosticsStore(historicalRuntimeFile)
  assert.deepEqual(
    historicalRuntime.list().map(({ id }) => id),
    ['new-killed'],
    'only report-era renderer failures fixed by this build are retired'
  )

  const historicalConsumedFile = join(root, 'historical-consumed.jsonl')
  writeFileSync(historicalConsumedFile, [
    {
      id: 'old-empty-wait', ts: Date.now(), level: 'warn', category: 'app_runtime',
      source: 'traex-app-server', agentId: 'traex', code: 'ignored_provider_event',
      field: 'item:collabAgentToolCall:completed:missing_subagent_state',
      message: 'empty wait',
      sample: JSON.stringify({ type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: [], agentsStates: {} }),
      count: 2
    },
    {
      id: 'old-broken-spawn', ts: Date.now(), level: 'warn', category: 'app_runtime',
      source: 'traex-app-server', agentId: 'traex', code: 'ignored_provider_event',
      field: 'item:collabAgentToolCall:completed:missing_subagent_state',
      message: 'broken spawn',
      sample: JSON.stringify({ type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [], agentsStates: {} }),
      count: 1
    }
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const historicalConsumed = new DiagnosticsStore(historicalConsumedFile)
  assert.deepEqual(
    historicalConsumed.list().map(({ id }) => id),
    ['old-broken-spawn'],
    'persisted empty wait noise must be hidden without masking malformed collaboration actions'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('diagnostics-store: ok')
