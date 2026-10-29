import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const sandbox = await mkdtemp(join(tmpdir(), 'ua-codex-history-'))
const previousHome = process.env.HOME
process.env.HOME = sandbox

const codexDir = join(sandbox, '.codex')
const sessionsDir = join(codexDir, 'sessions', '2026', '08', '31')
await mkdir(sessionsDir, { recursive: true })

const ids = {
  original: '11111111-1111-4111-8111-111111111111',
  nativeForkA: '22222222-2222-4222-8222-222222222222',
  nativeForkB: '33333333-3333-4333-8333-333333333333',
  fallback: '44444444-4444-4444-8444-444444444444',
  uniagentFork: '55555555-5555-4555-8555-555555555555',
  sideBranch: '66666666-6666-4666-8666-666666666666',
  emptyNativeFork: '77777777-7777-4777-8777-777777777777',
  ordinalFork: '88888888-8888-4888-8888-888888888888'
}
const originalPrompt = `original first prompt ${'x'.repeat(80)} searchable tail`

async function writeRollout(id, prompt, marker = {}) {
  const file = join(sessionsDir, `rollout-2026-08-31T00-00-00-${id}.jsonl`)
  await writeFile(file, [
    JSON.stringify({
      ordinal: 0,
      type: 'session_meta',
      payload: {
        id,
        session_id: id,
        cwd: '/repo/UniAgent',
        originator: 'Codex Desktop',
        source: 'vscode',
        ...marker
      }
    }),
    JSON.stringify({
      ordinal: 1,
      type: 'event_msg',
      payload: { type: 'user_message', message: prompt }
    }),
    JSON.stringify({
      ordinal: 2,
      type: 'event_msg',
      payload: { type: 'agent_message', message: `reply for ${id}` }
    })
  ].join('\n') + '\n')
}

await Promise.all([
  writeRollout(ids.original, originalPrompt),
  writeRollout(ids.fallback, 'fallback first prompt'),
  writeRollout(ids.uniagentFork, 'UniAgent fork prompt', {
    originator: 'codex-tui',
    forked_from: ids.original
  }),
  writeRollout(ids.sideBranch, 'side branch prompt', {
    source: 'side',
    ephemeral: true,
    forked_from_id: ids.original
  })
])

const originalFile = join(
  sessionsDir,
  `rollout-2026-08-31T00-00-00-${ids.original}.jsonl`
)
const originalSize = (await stat(originalFile)).size
await Promise.all([
  writeRollout(ids.nativeForkA, 'fork A inherited prompt', {
    forked_from_id: ids.original,
    history_mode: 'paginated',
    history_base: {
      thread_id: ids.original,
      end_ordinal_exclusive: 999,
      end_byte_offset: originalSize
    }
  }),
  writeRollout(ids.nativeForkB, 'fork B inherited prompt', {
    forked_from_id: ids.original,
    history_mode: 'paginated',
    history_base: {
      thread_id: ids.original,
      end_ordinal_exclusive: 999,
      end_byte_offset: originalSize
    }
  })
])
await writeFile(
  join(sessionsDir, `rollout-2026-08-31T00-00-01-${ids.emptyNativeFork}.jsonl`),
  [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: ids.emptyNativeFork,
        session_id: ids.emptyNativeFork,
        cwd: '/repo/UniAgent',
        originator: 'Codex Desktop',
        source: 'vscode',
        forked_from_id: ids.original,
        history_mode: 'paginated',
        history_base: {
          thread_id: ids.original,
          end_ordinal_exclusive: 999,
          end_byte_offset: originalSize
        }
      }
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'thread_settings_applied' }
    })
  ].join('\n') + '\n'
)
await writeFile(
  join(sessionsDir, `rollout-2026-08-31T00-00-02-${ids.ordinalFork}.jsonl`),
  [
    JSON.stringify({
      ordinal: 0,
      type: 'session_meta',
      payload: {
        id: ids.ordinalFork,
        session_id: ids.ordinalFork,
        cwd: '/repo/UniAgent',
        originator: 'Codex Desktop',
        source: 'vscode',
        forked_from_id: ids.original,
        history_mode: 'paginated',
        history_base: {
          thread_id: ids.original,
          end_ordinal_exclusive: 3
        }
      }
    }),
    JSON.stringify({
      ordinal: 1,
      type: 'event_msg',
      payload: { type: 'thread_settings_applied' }
    })
  ].join('\n') + '\n'
)
await appendFile(originalFile, [
  JSON.stringify({
    ordinal: 3,
    type: 'event_msg',
    payload: { type: 'user_message', message: 'parent turn after forks' }
  }),
  JSON.stringify({
    ordinal: 4,
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'late parent reply' }
  }),
  JSON.stringify({
    ordinal: 5,
    type: 'event_msg',
    payload: { type: 'agent_reasoning', text: 'event reasoning' }
  }),
  JSON.stringify({
    ordinal: 6,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id: 'reasoning-native-duplicate',
      summary: [{ type: 'summary_text', text: 'event reasoning' }],
      encrypted_content: 'opaque'
    }
  }),
  JSON.stringify({
    ordinal: 7,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'Reasoning',
        id: 'reasoning-native-import',
        summary_text: ['native reasoning summary'],
        raw_content: ['native raw reasoning']
      }
    }
  }),
  JSON.stringify({
    ordinal: 8,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id: 'reasoning-native-import',
      summary: [{ type: 'summary_text', text: 'native reasoning summary' }],
      encrypted_content: 'opaque'
    }
  }),
  JSON.stringify({
    ordinal: 9,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'command-native-import',
        command: ['bash', '-lc', 'printf 42'],
        aggregated_output: '42',
        exit_code: 0,
        duration: { secs: 1, nanos: 250_000_000 },
        status: 'completed'
      }
    }
  }),
  JSON.stringify({
    ordinal: 10,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'FileChange',
        id: 'files-native-import',
        status: 'completed',
        changes: [{ kind: 'update', path: '/repo/file.ts', diff: '+fixed' }]
      }
    }
  }),
  JSON.stringify({
    ordinal: 11,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'McpToolCall',
        id: 'mcp-native-import',
        status: 'completed',
        server: 'fixture',
        tool: 'lookup',
        arguments: { query: 'native' },
        result: { ok: true },
        duration: 12
      }
    }
  }),
  JSON.stringify({
    ordinal: 12,
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'handoff-history-import',
      invocation: {
        server: 'uniagent', tool: 'create_uniagent_task',
        arguments: { prompt: 'review', wait: true }
      },
      duration: { secs: 3, nanos: 250_000_000 },
      result: { Ok: { content: [{ type: 'text', text: 'done' }] } }
    }
  }),
  JSON.stringify({
    ordinal: 13,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'custom-tool-native-import',
      call_id: 'call-native-import',
      name: 'exec',
      status: 'completed',
      input: 'const answer = 42'
    }
  }),
  JSON.stringify({
    ordinal: 13,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id: 'reasoning-between-tools',
      summary: [{ type: 'summary_text', text: 'between parallel tools' }],
      encrypted_content: 'opaque'
    }
  }),
  JSON.stringify({
    ordinal: 14,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'custom-tool-native-second',
      call_id: 'call-native-second',
      name: 'exec',
      status: 'completed',
      input: 'const answer = 43'
    }
  }),
  JSON.stringify({
    ordinal: 15,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-native-second',
      output: '43'
    }
  }),
  JSON.stringify({
    ordinal: 16,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-native-import',
      output: [
        { type: 'input_text', text: 'Script completed\n' },
        { type: 'input_text', text: 'Output:\n42' }
      ]
    }
  }),
  JSON.stringify({
    ordinal: 17,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'custom-tool-native-failed',
      call_id: 'call-native-failed',
      name: 'exec',
      status: 'completed',
      input: 'throw new Error()'
    }
  }),
  JSON.stringify({
    ordinal: 18,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-native-failed',
      output: [{ type: 'input_text', text: 'Script failed\nError: boom' }]
    }
  }),
  JSON.stringify({
    ordinal: 19,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'custom-tool-native-interrupted',
      call_id: 'call-native-interrupted',
      name: 'exec',
      status: 'completed',
      input: 'await neverReturns()'
    }
  })
].join('\n') + '\n')

await writeFile(join(codexDir, 'session_index.jsonl'), [
  JSON.stringify({ id: ids.original, thread_name: '规划远程仓库与更新路径调整' }),
  JSON.stringify({ id: ids.nativeForkA, thread_name: '规划远程仓库与更新路径调整' }),
  JSON.stringify({ id: ids.nativeForkA, thread_name: '规划远程仓库与更新路径调整 (2)' }),
  JSON.stringify({ id: ids.nativeForkB, thread_name: '规划远程仓库与更新路径调整 (2)' }),
  JSON.stringify({ id: ids.emptyNativeFork, thread_name: '规划远程仓库与更新路径调整 (3)' }),
  JSON.stringify({ id: ids.ordinalFork, thread_name: '规划远程仓库与更新路径调整 (4)' }),
  '{malformed-json'
].join('\n') + '\n')

const server = await createServer({
  root: process.cwd(),
  resolve: {
    alias: {
      '@shared': join(process.cwd(), 'src/shared'),
      '@renderer': join(process.cwd(), 'src/renderer')
    }
  },
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})

try {
  const { listAgentHistory, loadSessionEvents, exportNativeSession, resolveNativeSessionFile } =
    await server.ssrLoadModule('/src/main/history.ts')
  const history = await listAgentHistory('codex')
  const byId = new Map(history.map((item) => [item.id, item]))

  assert.equal(
    byId.get(ids.original)?.title,
    '规划远程仓库与更新路径调整',
    'Codex thread_name must override the rollout first prompt'
  )
  assert.equal(
    byId.get(ids.original)?.firstUserMessage,
    originalPrompt,
    'the rollout first prompt must remain searchable after the display title is overlaid'
  )
  assert.equal(
    byId.get(ids.nativeForkA)?.title,
    '规划远程仓库与更新路径调整 (2)',
    'the latest session-index name must win for a renamed native fork'
  )
  assert.equal(
    byId.get(ids.nativeForkB)?.title,
    '规划远程仓库与更新路径调整 (2)',
    'two native forks with the same name must both remain independently addressable by id'
  )
  assert.equal(
    history.filter((item) => item.title === '规划远程仓库与更新路径调整 (2)').length,
    2,
    'same-title native forks must not be de-duplicated by title'
  )
  assert.equal(
    byId.get(ids.fallback)?.title,
    'fallback first prompt',
    'a rollout missing from the sparse index must retain its first-prompt title'
  )
  assert.equal(
    byId.get(ids.emptyNativeFork)?.title,
    '规划远程仓库与更新路径调整 (3)',
    'an indexed native fork with inherited history but no new turn must remain visible'
  )
  assert.equal(
    byId.get(ids.ordinalFork)?.title,
    '规划远程仓库与更新路径调整 (4)',
    'an ordinal-only inherited fork must remain visible'
  )
  assert.equal(byId.has(ids.uniagentFork), false, 'UniAgent same-agent forks must stay hidden')
  assert.equal(byId.has(ids.sideBranch), false, 'explicit ephemeral side branches must stay hidden')

  const [{ Orchestrator }, { SessionStore }] = await Promise.all([
    server.ssrLoadModule('/src/main/orchestrator.ts'),
    server.ssrLoadModule('/src/main/sessionStore.ts')
  ])
  const codexAgent = {
    id: 'codex',
    name: 'Codex',
    bin: '/usr/bin/true',
    adapter: 'codex',
    icon: '',
    builtin: true,
    installed: true,
    capabilities: {
      modelSelect: false,
      reasoningEffort: false,
      permissionModes: [{ id: 'read-only', label: '只读', hint: '' }],
      sessionList: true,
      sessionLoad: true,
      sessionResume: true
    },
    models: []
  }
  const orchestrator = new Orchestrator(
    (agentId) => agentId === codexAgent.id ? codexAgent : undefined,
    new SessionStore(join(sandbox, 'sessions.json'))
  )
  const direct = await orchestrator.importSession(
    codexAgent.id,
    ids.original,
    'direct',
    '/repo/UniAgent',
    byId.get(ids.original)?.title
  )
  assert.equal(
    direct?.title,
    '规划远程仓库与更新路径调整',
    'direct import must preserve the native history title instead of deriving it from the first prompt'
  )

  const originalPreview = await loadSessionEvents('codex', ids.original)
  assert.deepEqual(
    originalPreview.events
      .filter((event) => event.type === 'reasoning')
      .map((event) => event.payload.text),
    ['event reasoning', 'native reasoning summary\n\nnative raw reasoning', 'between parallel tools'],
    'native reasoning must survive direct import without duplicating response-item copies'
  )
  assert.deepEqual(
    originalPreview.events.find((event) => event.payload.id === 'command-native-import'),
    {
      sessionId: '',
      seq: originalPreview.events.find((event) => event.payload.id === 'command-native-import')?.seq,
      ts: 0,
      type: 'command_exec',
      state: 'success',
      payload: {
        id: 'command-native-import',
        command: 'bash -lc printf 42',
        output: '42',
        exitCode: 0,
        durationMs: 1_250
      }
    },
    'native completed command items must survive direct import'
  )
  assert.deepEqual(
    originalPreview.events.find((event) => event.payload.id === 'files-native-import')?.payload.changes,
    [{ kind: 'update', path: '/repo/file.ts', diff: '+fixed' }],
    'native completed file changes must survive direct import'
  )
  assert.deepEqual(
    originalPreview.events.find((event) => event.payload.id === 'mcp-native-import'),
    {
      sessionId: '',
      seq: originalPreview.events.find((event) => event.payload.id === 'mcp-native-import')?.seq,
      ts: 0,
      type: 'tool_call',
      state: 'success',
      payload: {
        id: 'mcp-native-import',
        provider: 'mcp',
        server: 'fixture',
        name: 'lookup',
        input: { query: 'native' },
        result: { ok: true },
        error: null,
        durationMs: 12
      }
    },
    'native completed MCP calls must survive direct import'
  )
  assert.deepEqual(
    originalPreview.events.find((event) => event.payload.id === 'handoff-history-import')?.payload,
    {
      id: 'handoff-history-import', provider: 'mcp', server: 'uniagent',
      name: 'create_uniagent_task', input: { prompt: 'review', wait: true },
      result: { Ok: { content: [{ type: 'text', text: 'done' }] } },
      durationMs: 3_250,
      raw: {
        server: 'uniagent', tool: 'create_uniagent_task',
        arguments: { prompt: 'review', wait: true }
      }
    },
    'restored blocking handoff must retain exact timing metadata'
  )
  const customTool = originalPreview.events.find(
    (event) => event.type === 'tool_call' && event.payload.id === 'call-native-import'
  )
  assert.deepEqual(
    customTool,
    {
      sessionId: '',
      seq: customTool?.seq,
      ts: 0,
      type: 'tool_call',
      state: 'success',
      payload: {
        id: 'call-native-import',
        name: 'exec',
        input: 'const answer = 42',
        result: [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_text', text: 'Output:\n42' }
        ]
      }
    },
    'native custom tool call input and output must survive direct import'
  )
  assert.deepEqual(
    originalPreview.events
      .filter((event) =>
        event.payload.id === 'call-native-import' ||
        event.payload.id === 'reasoning-between-tools' ||
        event.payload.id === 'call-native-second'
      )
      .map((event) => event.payload.id),
    ['call-native-import', 'reasoning-between-tools', 'call-native-second'],
    'parallel native tools must retain call order rather than completion order'
  )
  const failedTool = originalPreview.events.find(
    (event) => event.type === 'tool_call' && event.payload.id === 'call-native-failed'
  )
  assert.equal(failedTool?.state, 'failed', 'native failed custom tools must retain failure state')
  assert.deepEqual(
    failedTool?.payload.error,
    [{ type: 'input_text', text: 'Script failed\nError: boom' }],
    'native failed custom tool output must remain available as the error detail'
  )
  assert.equal(
    originalPreview.events.find((event) => event.payload.id === 'call-native-interrupted')?.state,
    'cancelled',
    'native tools interrupted before an output must not stay running in history'
  )

  const modernToolsId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  await writeRollout(modernToolsId, 'modern tool import')
  const modernToolsFile = join(sessionsDir, `rollout-2026-08-31T00-00-00-${modernToolsId}.jsonl`)
  const modernCalls = [
    { type: 'CommandExecution', id: 'modern-command', command: 'pwd', exit_code: 0, aggregated_output: '/repo' },
    { type: 'FileChange', id: 'modern-patch', changes: [] },
    { type: 'McpToolCall', id: 'modern-mcp', server: 'fixture', tool: 'lookup', result: { content: [{ type: 'text', text: 'found' }] }, duration: 12 },
    { type: 'DynamicToolCall', id: 'modern-dynamic', tool: 'lookup', content_items: [{ type: 'input_text', text: 'done' }] }
  ]
  await appendFile(modernToolsFile, modernCalls.flatMap((item) => [
    { type: 'response_item', payload: {
      type: 'function_call', call_id: item.id, name: item.tool || 'exec', namespace: 'mcp__fixture',
      arguments: JSON.stringify({ query: item.id })
    } },
    { type: 'event_msg', payload: {
      type: 'item_completed', item: { ...item, status: 'completed', arguments: { query: item.id } }
    } },
    { type: 'response_item', payload: {
      type: 'function_call_output', call_id: item.id, output: 'completed'
    } }
  ]).map((record) => JSON.stringify(record)).join('\n') + '\n')
  const modernPreview = await loadSessionEvents('codex', modernToolsId)
  for (const item of modernCalls) {
    assert.equal(
      modernPreview.events.filter((event) => event.payload.id === item.id).length,
      1,
      `${item.type} completion and its response pair must restore as one call`
    )
  }
  const modernMcp = modernPreview.events.find((event) => event.payload.id === 'modern-mcp')
  assert.equal(modernMcp?.payload.namespace, 'mcp__fixture')
  assert.deepEqual(modernMcp?.payload.result, modernCalls[2].result)
  assert.equal(modernMcp?.payload.durationMs, 12)
  for (const target of ['traex', 'codex']) {
    const exported = await exportNativeSession('codex', modernToolsId, target)
    assert.ok(exported, 'modern completed tools must export')
    const exportedFile = await resolveNativeSessionFile(target, exported.nativeId)
    const records = (await readFile(exportedFile, 'utf8')).trim().split('\n').map(JSON.parse)
    const calls = records.filter((record) => record.type === 'response_item' && record.payload.type === 'function_call')
    assert.deepEqual(calls.map((record) => record.payload.call_id), ['modern-mcp', 'modern-dynamic'])
    assert.equal(new Set(calls.map((record) => record.payload.call_id)).size, calls.length)
    assert.equal(calls.find((record) => record.payload.call_id === 'modern-mcp')?.payload.namespace, 'mcp__fixture')
    for (const call of calls) {
      assert.equal(records.filter((record) => record.type === 'response_item' &&
        record.payload.type === 'function_call_output' && record.payload.call_id === call.payload.call_id).length, 1)
    }
  }

  const nestedToolsId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const nestedToolsDir = join(sandbox, '.trae/cli/sessions/2026/08/31')
  await mkdir(nestedToolsDir, { recursive: true })
  const nestedToolsFile = join(nestedToolsDir, `rollout-2026-08-31T00-00-00-${nestedToolsId}.jsonl`)
  const nestedCallIds = [
    'x'.repeat(64),
    'x'.repeat(65),
    'code-mode-nested:29:call_75heSp3xAwEPwIZNqbOTwVC7:exec-7a99cfd4-afb6-4326-bfd7-e9f49d401b74',
    'code-mode-nested:29:call_75heSp3xAwEPwIZNqbOTwVC7:exec-7a99cfd4-afb6-4326-bfd7-e9f49d401b75'
  ]
  const nestedToolsText = [
    { type: 'session_meta', payload: { id: nestedToolsId, cwd: '/repo/UniAgent' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'nested MCP history' } },
    ...nestedCallIds.map((id) => ({ type: 'event_msg', payload: {
      type: 'item_completed', item: { type: 'McpToolCall', id, server: 'fixture', tool: 'lookup',
        arguments: { query: id }, status: 'completed', result: { text: 'found' } }
    } }))
  ].map((record) => JSON.stringify(record)).join('\n') + '\n'
  await writeFile(nestedToolsFile, nestedToolsText)
  let exportedCallIds
  for (const target of ['codex', 'traex']) {
    const exported = await exportNativeSession('traex', nestedToolsId, target)
    assert.ok(exported, 'nested MCP tools must export without native response pairs')
    const exportedFile = await resolveNativeSessionFile(target, exported.nativeId)
    const records = (await readFile(exportedFile, 'utf8')).trim().split('\n').map(JSON.parse)
    const calls = records.filter((record) => record.type === 'response_item' && record.payload.type === 'function_call')
    assert.equal(calls.length, nestedCallIds.length)
    const callIds = calls.map((record) => record.payload.call_id)
    assert.equal(callIds[0], nestedCallIds[0], '64-character IDs must remain unchanged')
    assert.ok(callIds.every((id) => id.length > 0 && id.length <= 64), 'exported call IDs must fit the API limit')
    assert.equal(new Set(callIds).size, callIds.length, 'long IDs sharing a prefix must remain distinct')
    if (exportedCallIds) assert.deepEqual(callIds, exportedCallIds, 'the same history must produce stable call IDs')
    exportedCallIds = callIds
    for (const call of calls) {
      const outputs = records.filter((record) => record.type === 'response_item' &&
        record.payload.type === 'function_call_output' && record.payload.call_id === call.payload.call_id)
      assert.equal(outputs.length, 1, 'each call must retain its paired output')
      assert.deepEqual(JSON.parse(outputs[0].payload.output), { text: 'found' })
    }
  }
  assert.equal(await readFile(nestedToolsFile, 'utf8'), nestedToolsText, 'export must not alter source history')

  const emptyForkPreview = await loadSessionEvents('codex', ids.emptyNativeFork)
  assert.deepEqual(
    emptyForkPreview.events
      .filter((event) => event.type === 'user_message')
      .map((event) => event.payload.text),
    [originalPrompt],
    'an empty native fork must replay its inherited history_base'
  )
  const continuedForkPreview = await loadSessionEvents('codex', ids.nativeForkA)
  assert.deepEqual(
    continuedForkPreview.events
      .filter((event) => event.type === 'user_message')
      .map((event) => event.payload.text),
    [originalPrompt, 'fork A inherited prompt'],
    'a continued native fork must merge inherited and branch-local turns'
  )
  const ordinalForkPreview = await loadSessionEvents('codex', ids.ordinalFork)
  assert.deepEqual(
    ordinalForkPreview.events
      .filter((event) => event.type === 'user_message')
      .map((event) => event.payload.text),
    [originalPrompt],
    'ordinal-only lineage must stop before parent turns appended after the fork'
  )

  // A direct import of a native fork includes its inherited prefix. Tool-heavy
  // parents must not consume a replay budget that hides the branch's own turns.
  const longParentId = '99999999-9999-4999-8999-999999999999'
  const longForkId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await writeRollout(longParentId, 'long parent prompt')
  const longParentFile = join(sessionsDir, `rollout-2026-08-31T00-00-00-${longParentId}.jsonl`)
  await appendFile(longParentFile, Array.from({ length: 4_100 }, (_, index) =>
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_reasoning', text: `inherited reasoning ${index}` }
    })
  ).join('\n') + '\n')
  await writeRollout(longForkId, 'latest branch prompt', {
    history_base: {
      thread_id: longParentId,
      end_byte_offset: (await stat(longParentFile)).size
    }
  })
  const longSession = await orchestrator.importSession('codex', longForkId, 'direct')
  assert.equal(longSession?.nativeSessionId, longForkId)
  assert.equal(longSession?.importMode, 'direct')
  const longEvents = await orchestrator.getEvents(longSession.id)
  assert.equal(longEvents.filter((event) => event.type === 'reasoning').length, 4_100)
  assert.deepEqual(
    longEvents.filter((event) => event.type === 'user_message').map((event) => event.payload.text),
    ['long parent prompt', 'latest branch prompt']
  )
  assert.equal(
    longEvents.filter((event) => event.type === 'agent_message').at(-1)?.payload.text,
    `reply for ${longForkId}`,
    'direct import must retain the latest branch reply after more than 4,000 inherited events'
  )
  const beforeAppend = await orchestrator.getSessionRuntimeState(longSession.id, false)
  assert.deepEqual(beforeAppend.events, [], 'polling must not transfer the full transcript')
  assert.ok(beforeAppend.nativeSessionOccupancy.historyVersion)
  await appendFile(
    join(sessionsDir, `rollout-2026-08-31T00-00-00-${longForkId}.jsonl`),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'external latest reply' } }) + '\n'
  )
  const afterAppend = await orchestrator.getSessionRuntimeState(longSession.id, false)
  assert.notEqual(afterAppend.nativeSessionOccupancy.historyVersion, beforeAppend.nativeSessionOccupancy.historyVersion)
  await appendFile(join(codexDir, 'session_index.jsonl'), JSON.stringify({
    id: longForkId, thread_name: '外部更新的标题', updated_at: new Date().toISOString()
  }) + '\n')
  const titleUpdates = []
  orchestrator.on('sessionUpdated', ({ session }) => { titleUpdates.push(session.title) })
  const refreshed = await orchestrator.refreshNativeSession(longSession.id)
  assert.equal(refreshed.session.title, '外部更新的标题')
  assert.ok(titleUpdates.includes('外部更新的标题'), 'native refresh notifies title subscribers')
  assert.equal(refreshed.session.nativeSessionId, longForkId)
  assert.equal(refreshed.session.importMode, 'direct')
  assert.equal(refreshed.runtime.events.at(-1)?.payload.text, 'external latest reply')
  assert.equal(
    (await orchestrator.getSessionRuntimeState(longSession.id, false)).nativeSessionOccupancy.historyVersion,
    afterAppend.nativeSessionOccupancy.historyVersion,
    'read-only refresh must not write to the native rollout'
  )

  // A promoted side thread inherits native questions, while their local skip
  // results live only in the original UniAgent session's checkpoints.
  const questionSourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const questionSideId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const questionForkId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const questionFile = id => join(sessionsDir, `rollout-2026-08-31T00-00-00-${id}.jsonl`)
  const questionRecord = (id, prompt = '是否继续？') => ({ type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'AgentMessage', id, delivery: 'async', text: prompt,
      questions: [{ id: 'choice', question: prompt, options: ['继续'] }] }
  } })
  await writeFile(questionFile(questionSourceId), [
    { type: 'session_meta', payload: { id: questionSourceId, cwd: sandbox } },
    { type: 'event_msg', payload: { type: 'user_message', message: '原会话' } },
    questionRecord('skipped-in-source'), questionRecord('skipped-in-middle', '中间会话的问题？'),
    questionRecord('pending-in-source', '另一个问题？')
  ].map(JSON.stringify).join('\n') + '\n')
  await writeFile(questionFile(questionSideId), [
    { type: 'session_meta', payload: { id: questionSideId, thread_source: 'side', cwd: sandbox,
      history_base: { thread_id: questionSourceId, end_byte_offset: (await stat(questionFile(questionSourceId))).size } } },
    { type: 'event_msg', payload: { type: 'user_message', message: '转为新会话' } },
    questionRecord('local-question')
  ].map(JSON.stringify).join('\n') + '\n')
  await writeFile(questionFile(questionForkId), JSON.stringify({ type: 'session_meta', payload: {
    id: questionForkId, cwd: sandbox,
    history_base: { thread_id: questionSideId, end_byte_offset: (await stat(questionFile(questionSideId))).size }
  } }) + '\n')
  const questionStore = new SessionStore(join(sandbox, 'question-sessions.json'))
  const sourceSession = { id: 'question-source', title: '原会话', config: { agentId: 'codex', workdir: sandbox },
    createdAt: 1, status: 'idle', nativeSessionId: questionSourceId, origin: 'created' }
  const middleSession = { ...sourceSession, id: 'question-middle', nativeSessionId: questionSideId }
  questionStore.saveOrThrow([sourceSession, middleSession])
  const questionHosts = []
  const openQuestions = async () => {
    const host = new Orchestrator(id => id === codexAgent.id ? codexAgent : undefined, questionStore)
    questionHosts.push(host)
    await host.loadPersisted()
    return host
  }
  try {
    const beforeRestart = await openQuestions()
    await beforeRestart.getEvents(sourceSession.id)
    await beforeRestart.respondToRequest(sourceSession.id, 'async-question:skipped-in-source', { action: 'skip' })
    await beforeRestart.getEvents(middleSession.id)
    await beforeRestart.respondToRequest(middleSession.id, 'async-question:skipped-in-middle', { action: 'skip' })
    const side = {
      forkPersistent: async () => questionForkId,
      removeAllListeners() {}, disposeFork() {}
    }
    beforeRestart.ensureSideStreamer = () => {
      beforeRestart.sideStreamers.set(middleSession.id, side)
      return side
    }
    beforeRestart.ensureMainStreamer = () => ({})
    beforeRestart.sideEvents.set(middleSession.id, [
      { sessionId: middleSession.id, seq: 0, ts: 1, type: 'user_message', payload: { text: '转为新会话' } }
    ])
    const promoted = await beforeRestart.promoteSideToSession(middleSession.id)
    await beforeRestart.closeSessionLogs()

    const afterRestart = await openQuestions()
    const restoredQuestions = await afterRestart.getEvents(promoted.id)
    const questionById = id => restoredQuestions.find(event => event.payload.id === id)
    assert.deepEqual(questionById('skipped-in-source')?.payload.submittedAnswer, { action: 'skip' },
      'a question skipped in the original session must stay skipped after side promotion and restart')
    assert.deepEqual(questionById('skipped-in-middle')?.payload.submittedAnswer, { action: 'skip' },
      'the nearest ancestor’s local skip must take precedence over an older unanswered question')
    assert.equal(questionById('pending-in-source')?.payload.submittedAnswer, undefined, 'other questions remain unanswered')
    assert.equal(questionById('local-question')?.payload.submittedAnswer, undefined, 'equal question text must not inherit another item’s skip')
    assert.ok(restoredQuestions.every(event => event.sessionId === promoted.id), 'inherited states belong to the promoted session')
    await afterRestart.respondToRequest(promoted.id, 'async-question:pending-in-source', { action: 'skip' })
    const originalQuestion = (await afterRestart.getEvents(sourceSession.id)).find(event => event.payload.id === 'skipped-in-source')
    afterRestart.logEvent({ ...originalQuestion, payload: { ...originalQuestion.payload,
      submittedAnswer: { answers: { choice: { answers: ['继续'] } } } } })
    await afterRestart.refreshNativeSession(promoted.id)
    const refreshedQuestions = await afterRestart.getEvents(promoted.id)
    for (const id of ['skipped-in-source', 'skipped-in-middle', 'pending-in-source']) {
      assert.deepEqual(refreshedQuestions.find(event => event.payload.id === id)?.payload.submittedAnswer, { action: 'skip' },
        'refresh must retain the fork’s own checkpoints even when the source changes')
    }
    assert.ok(refreshedQuestions.every(event => event.sessionId === promoted.id))
    await afterRestart.closeSessionLogs()

    // The fork owns its copied state even if the original is no longer listed.
    questionStore.saveOrThrow([promoted])
    const secondRestart = await openQuestions()
    const independent = await secondRestart.getEvents(promoted.id)
    for (const id of ['skipped-in-source', 'skipped-in-middle', 'pending-in-source']) {
      assert.deepEqual(independent.find(event => event.payload.id === id)?.payload.submittedAnswer, { action: 'skip' },
        'a second restart must retain inherited and local skips independently of the source session')
    }
    assert.equal(independent.find(event => event.payload.id === 'local-question')?.payload.submittedAnswer, undefined)
  } finally {
    for (const host of questionHosts) { host.disposeAll(); await host.closeSessionLogs() }
  }

  const resumePanel = await server.ssrLoadModule('/src/renderer/components/ResumePanel.tsx')
  assert.equal(typeof resumePanel.matchesHistoryItem, 'function')
  const searchable = byId.get(ids.original)
  assert.equal(resumePanel.matchesHistoryItem(searchable, '规划远程仓库'), true)
  assert.equal(resumePanel.matchesHistoryItem(searchable, 'original first prompt'), true)
  assert.equal(resumePanel.matchesHistoryItem(searchable, 'searchable tail'), true)
  assert.equal(resumePanel.matchesHistoryItem(searchable, '/repo/UniAgent'), true)
  assert.equal(resumePanel.matchesHistoryItem(searchable, ids.original), true)
  assert.equal(resumePanel.matchesHistoryItem(searchable, 'missing query'), false)
} finally {
  await server.close()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(sandbox, { recursive: true, force: true })
}

console.log('codex history import checks passed')
