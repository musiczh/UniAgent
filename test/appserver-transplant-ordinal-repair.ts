import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, SessionConfig } from '../src/shared/types.ts'

class OrdinalCheckingTransport extends EventEmitter {
  methods: string[] = []

  constructor(private readonly rollout: string) {
    super()
  }

  async start(): Promise<void> {}
  notify(): void {}
  respond(): void {}
  interrupt(): void {}
  async dispose(): Promise<void> {}

  async request<T>(method: string, params: any): Promise<T> {
    return (await this.requestSequenced<T>(method, params)).result
  }

  async requestSequenced<T>(method: string, params: any): Promise<{ result: T; sequence: number }> {
    this.methods.push(method)
    if (method === 'initialize') return { result: {} as T, sequence: this.methods.length }
    if (method === 'config/read') return { result: { config: {} } as T, sequence: this.methods.length }
    if (method === 'thread/resume') {
      const records = (await readFile(this.rollout, 'utf8')).trim().split('\n').map(JSON.parse)
      const expectedFinalOrdinal = records.length - 1
      if (records.at(-1)?.ordinal !== expectedFinalOrdinal) {
        throw new Error('final canonical rollout record is missing an ordinal')
      }
      for (const record of records) {
        const callId = record.type === 'response_item' && record.payload?.call_id
        if (typeof callId === 'string' && callId.length > 64) {
          throw new Error('resume still contains an oversized call_id')
        }
      }
      return {
        result: { thread: { id: params.threadId } } as T,
        sequence: this.methods.length
      }
    }
    if (method === 'thread/goal/get') {
      return { result: { goal: null } as T, sequence: this.methods.length }
    }
    if (method === 'turn/start') {
      return { result: { turn: { id: 'turn-1' } } as T, sequence: this.methods.length }
    }
    throw new Error(`unexpected method: ${method}`)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'ua-transplant-ordinal-'))
const previousHome = process.env.HOME
process.env.HOME = scratch

try {
  const threadId = '11111111-1111-4111-8111-111111111111'
  const rollout = join(
    scratch,
    '.trae/cli/sessions/2026/10/09',
    `rollout-2026-10-09T00-00-00-${threadId}.jsonl`
  )
  await mkdir(join(rollout, '..'), { recursive: true })
  await writeFile(rollout, [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: threadId,
        session_id: threadId,
        cwd: scratch,
        history_format: 'canonical_v1',
        history_mode: 'paginated',
        uniagent_transplant: true
      }
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '继续' } })
  ].join('\n') + '\n')

  const [{ AppServerRunner }, { repairTransplantedSessionHistory }] = await Promise.all([
    import('../src/main/appServerAdapter.ts'),
    import('../src/main/history.ts')
  ])
  const transport = new OrdinalCheckingTransport(rollout)
  const agent = {
    id: 'traex',
    name: 'TraeX',
    bin: 'traecli',
    adapter: 'traex',
    icon: 'traex',
    builtin: true,
    installed: true,
    capabilities: {
      streaming: true,
      permissionModes: [{ id: 'danger-full-access', label: '完全放开', hint: '' }]
    },
    models: []
  } as AgentDef
  const config: SessionConfig = {
    agentId: 'traex',
    workdir: scratch,
    permissionMode: 'danger-full-access'
  }
  const runner = new AppServerRunner(
    'session-1',
    { n: 0 },
    agent,
    config,
    threadId,
    undefined,
    () => transport as any
  )
  try {
    await runner.startTurn('继续')
    assert.ok(
      transport.methods.includes('turn/start'),
      'a legacy UniAgent transplant must be repaired before thread/resume'
    )
    const records = (await readFile(rollout, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(
      records.map((record) => record.ordinal),
      [0, 1, 2],
      'repair must add contiguous ordinals without dropping records'
    )
  } finally {
    runner.dispose()
  }

  for (const adapter of ['codex', 'traex'] as const) {
    const id = '44444444-4444-4444-8444-444444444444'
    const file = join(scratch, adapter === 'codex' ? '.codex' : '.trae/cli',
      'sessions/2026/10/09', `rollout-2026-10-09T00-00-02-${id}.jsonl`)
    await mkdir(join(file, '..'), { recursive: true })
    const callIds = ['x'.repeat(64), 'x'.repeat(65), `${'x'.repeat(90)}a`, `${'x'.repeat(90)}b`]
    const records = [
      { type: 'session_meta', payload: { id, uniagent_transplant: true } },
      ...callIds.flatMap((call_id) => [
        { type: 'response_item', payload: { type: 'function_call', call_id, name: 'lookup', arguments: '{}' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id, output: 'result', uniagentTool: { state: 'failed' } } }
      ])
    ].map((record, ordinal) => ({ ...record, ordinal }))
    await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    const checkingTransport = new OrdinalCheckingTransport(file)
    const resumed = new AppServerRunner('session-long-calls', { n: 0 },
      { ...agent, id: adapter, adapter }, { ...config, agentId: adapter }, id,
      undefined, () => checkingTransport as any)
    try {
      await resumed.startTurn('继续')
      assert.ok(checkingTransport.methods.includes('turn/start'), 'call IDs must be repaired before resume')
    } finally {
      resumed.dispose()
    }
    const repaired = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
    const calls = repaired.filter((record) => record.payload.type === 'function_call')
    assert.equal(repaired.length, records.length, 'repair must retain every history record')
    assert.equal(calls[0].payload.call_id, callIds[0], '64-character IDs must remain unchanged')
    assert.equal(new Set(calls.map((record) => record.payload.call_id)).size, calls.length,
      'long IDs sharing the first 64 characters must remain distinct')
    for (let index = 0; index < callIds.length; index++) {
      const call = repaired[index * 2 + 1]
      const output = repaired[index * 2 + 2]
      assert.ok(call.payload.call_id.length > 0 && call.payload.call_id.length <= 64)
      assert.equal(output.payload.call_id, call.payload.call_id, 'calls and results must stay paired')
      assert.deepEqual(call, { ...records[index * 2 + 1], payload: {
        ...records[index * 2 + 1].payload, call_id: call.payload.call_id
      } }, 'repair must retain call arguments and ordinals')
      assert.deepEqual(output, { ...records[index * 2 + 2], payload: {
        ...records[index * 2 + 2].payload, call_id: call.payload.call_id
      } }, 'repair must retain output, failure metadata and ordinals')
    }
    const repairedText = await readFile(file, 'utf8')
    assert.equal(await repairTransplantedSessionHistory(adapter, id), false, 'repair must be idempotent')
    assert.equal(await readFile(file, 'utf8'), repairedText)
  }

  for (const [id, records] of [
    [
      '22222222-2222-4222-8222-222222222222',
      [
        { type: 'session_meta', payload: { id: '22222222-2222-4222-8222-222222222222', originator: 'trae-cli' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'native' } },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'x'.repeat(91), name: 'native', arguments: '{}' } }
      ]
    ],
    [
      '33333333-3333-4333-8333-333333333333',
      [
        { ordinal: 0, type: 'session_meta', payload: { id: '33333333-3333-4333-8333-333333333333', uniagent_transplant: true } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'partial' } }
      ]
    ]
  ] as const) {
    const file = join(
      scratch,
      '.trae/cli/sessions/2026/10/09',
      `rollout-2026-10-09T00-00-01-${id}.jsonl`
    )
    const original = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    await writeFile(file, original)
    assert.equal(await repairTransplantedSessionHistory('traex', id), false)
    assert.equal(
      await readFile(file, 'utf8'),
      original,
      'repair must not alter native or partially-numbered rollouts'
    )
  }
} finally {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(scratch, { recursive: true, force: true })
}

console.log('appserver transplant ordinal repair: ok')
