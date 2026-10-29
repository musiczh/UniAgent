import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

const root = await mkdtemp(join(tmpdir(), 'uniagent-native-token-'))
const previousHome = process.env.HOME
const previousUserData = process.env.UNIAGENT_USER_DATA
const previousDecoderNode = process.env.UNIAGENT_TOKEN_NODE_BIN
const previousDshHome = process.env.DSH_HOME
const uuid = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
const query = (date: string, now = '2026-09-02T04:00:00.000Z') => ({
  period: 'day' as const,
  start: date,
  end: date,
  now,
  timeZone: 'Asia/Shanghai'
})
const line = (value: unknown): string => `${JSON.stringify(value)}\n`
const tokenCount = (
  timestamp: string,
  input: number,
  output: number,
  cached: number
): string => line({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached
      }
    }
  }
})
const tokenUsage = (
  timestamp: string,
  responseId: string,
  input: number,
  output: number,
  cached: number,
  threadInput: number,
  threadOutput: number,
  threadCached: number
): string => line({
  timestamp,
  type: 'token_usage_record',
  payload: {
    response_id: responseId,
    usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
    thread_token_usage: {
      input_tokens: threadInput, output_tokens: threadOutput, cached_input_tokens: threadCached
    }
  }
})

try {
  process.env.HOME = root
  process.env.UNIAGENT_USER_DATA = join(root, '.uniagent-public')
  // A developer shell may run inside a DeepSeek Harness session (DSH_HOME set);
  // keep this scan on the fixture home only.
  process.env.DSH_HOME = join(root, '.dsh')
  await mkdir(join(root, '.codex', 'sessions', '2026', '08'), { recursive: true })
  await mkdir(join(root, '.trae', 'cli', 'sessions'), { recursive: true })
  await mkdir(join(root, '.claude', 'projects'), { recursive: true })
  await mkdir(join(root, '.uniagent-public'), { recursive: true })
  await writeFile(join(root, '.uniagent-public', 'pricing.json'), JSON.stringify({
    version: 1,
    models: {
      'gpt-5.6-sol': { input: 10, cachedInput: 1, output: 20, source: 'manual' }
    }
  }))
  await writeFile(join(root, '.uniagent-public', 'token-usage-cache.json'), JSON.stringify({
    version: 4,
    timeZone: 'Asia/Shanghai',
    sessions: {},
    days: {
      '2026-08-27': [{
        filePath: '/stale', agentId: 'codex', updatedAt: Date.parse('2026-08-27T15:00:00.000Z'),
        inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
        reasoningTokens: 0, cost: 0
      }]
    },
    finalizedDays: ['2026-08-27'],
    historyStart: '2026-08-27'
  }))

  const sessions = join(root, '.codex', 'sessions', '2026', '08')
  const sameDay = join(sessions, `rollout-2026-08-29T10-00-00-${uuid('1')}.jsonl`)
  await writeFile(sameDay,
    line({ timestamp: '2026-08-29T02:00:00.000Z', type: 'session_meta', payload: { cwd: '/work/SameDay' } }) +
    line({ timestamp: '2026-08-29T02:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
    tokenCount('2026-08-29T02:10:00.000Z', 1_000, 100, 800)
  )
  await utimes(sameDay, new Date('2026-08-29T02:10:00.000Z'), new Date('2026-08-29T02:10:00.000Z'))

  // The first JSONL record deliberately exceeds the old fixed 128 KiB head read.
  // Real TraeX session_meta records contain a similarly large model catalog.
  const crossDay = join(sessions, `rollout-2026-08-30T23-00-00-${uuid('2')}.jsonl`)
  await writeFile(crossDay,
    line({
      timestamp: '2026-08-30T15:00:00.000Z',
      type: 'session_meta',
      payload: { cwd: '/work/HugeProject', model_catalog_snapshot: 'x'.repeat(180 * 1024) }
    }) +
    line({ timestamp: '2026-08-30T15:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
    tokenCount('2026-08-30T15:10:00.000Z', 1_000, 100, 800) +
    tokenCount('2026-08-30T17:10:00.000Z', 1_600, 160, 1_300)
  )
  await utimes(crossDay, new Date('2026-08-30T17:10:00.000Z'), new Date('2026-08-30T17:10:00.000Z'))

  const currentDay = join(sessions, `rollout-2026-09-02T08-00-00-${uuid('3')}.jsonl`)
  await writeFile(currentDay,
    line({ timestamp: '2026-09-02T00:00:00.000Z', type: 'session_meta', payload: { cwd: '/work/Today' } }) +
    line({ timestamp: '2026-09-02T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
    tokenCount('2026-09-02T00:10:00.000Z', 100, 10, 80)
  )
  await utimes(currentDay, new Date('2026-09-02T00:10:00.000Z'), new Date('2026-09-02T00:10:00.000Z'))

  const preciseCrossDay = join(sessions, `rollout-2026-08-27T23-00-00-${uuid('4')}.jsonl`)
  await writeFile(preciseCrossDay,
    line({ timestamp: '2026-08-27T14:59:00.000Z', type: 'session_meta', payload: { cwd: '/work/Precise' } }) +
    line({ timestamp: '2026-08-27T14:59:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
    tokenCount('2026-08-27T15:00:00.000Z', 50, 5, 40) +
    tokenUsage('2026-08-27T15:10:00.000Z', 'response-1', 100, 10, 80, 150, 15, 120) +
    tokenUsage('2026-08-27T15:10:00.001Z', 'response-1', 100, 10, 80, 150, 15, 120) +
    tokenCount('2026-08-27T15:10:01.000Z', 150, 15, 120) +
    line({ timestamp: '2026-08-27T15:59:59.000Z', type: 'compacted', payload: { id: 'compact-1' } }) +
    tokenUsage('2026-08-27T17:10:00.000Z', 'response-2', 200, 20, 160, 350, 35, 280) +
    tokenCount('2026-08-27T17:10:01.000Z', 200, 20, 160)
  )
  await utimes(preciseCrossDay, new Date('2026-08-27T17:10:01.000Z'), new Date('2026-08-27T17:10:01.000Z'))

  const preciseSameDayMixed = join(sessions, `rollout-2026-08-26T08-00-00-${uuid('6')}.jsonl`)
  await writeFile(preciseSameDayMixed,
    line({ timestamp: '2026-08-26T00:00:00.000Z', type: 'session_meta', payload: { cwd: '/work/PreciseMixed' } }) +
    line({ timestamp: '2026-08-26T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
    tokenCount('2026-08-26T00:10:00.000Z', 500, 50, 400) +
    tokenUsage('2026-08-26T00:20:00.000Z', 'mixed-1', 100, 10, 80, 100, 10, 80) +
    tokenCount('2026-08-26T00:20:01.000Z', 100, 10, 80) +
    tokenUsage('2026-08-26T00:30:00.000Z', 'mixed-2', 200, 20, 160, 300, 30, 240) +
    tokenCount('2026-08-26T00:30:01.000Z', 300, 30, 240)
  )
  await utimes(preciseSameDayMixed, new Date('2026-08-26T00:30:01.000Z'), new Date('2026-08-26T00:30:01.000Z'))

  const preciseSameDay = join(sessions, `rollout-2026-09-01T08-00-00-${uuid('5')}.jsonl`)
  await writeFile(preciseSameDay,
    line({
      timestamp: '2026-09-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { cwd: '/work/PreciseSummary', history_base: { thread_id: 'parent' } }
    }) +
    line({ timestamp: '2026-09-01T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
    tokenUsage('2026-09-01T00:10:00.000Z', 'summary-1', 100, 10, 80, 10_100, 1_010, 8_080) +
    tokenCount('2026-09-01T00:10:01.000Z', 100, 10, 80) +
    line({ timestamp: '2026-09-01T00:20:00.000Z', type: 'compacted', payload: { id: 'compact-2' } }) +
    tokenUsage('2026-09-01T00:30:00.000Z', 'summary-2', 200, 20, 160, 10_300, 1_030, 8_240) +
    tokenCount('2026-09-01T00:30:01.000Z', 200, 20, 160)
  )
  await utimes(preciseSameDay, new Date('2026-09-01T00:30:01.000Z'), new Date('2026-09-01T00:30:01.000Z'))

  // A single-day Codex session must keep its per-event hours for the day-view
  // bar chart instead of collapsing a whole day into the file mtime hour.
  const hourlySingleDay = join(sessions, `rollout-2026-09-04T10-00-00-${uuid('7')}.jsonl`)
  await writeFile(hourlySingleDay,
    line({ timestamp: '2026-09-04T10:00:00.000Z', type: 'session_meta', payload: { cwd: '/work/HourlyDay' } }) +
    line({ timestamp: '2026-09-04T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
    tokenUsage('2026-09-04T10:05:00.000Z', 'hourly-1', 100, 10, 80, 100, 10, 80) +
    tokenUsage('2026-09-04T15:05:00.000Z', 'hourly-2', 50, 5, 20, 150, 15, 100)
  )
  await utimes(hourlySingleDay, new Date('2026-09-04T15:05:00.000Z'), new Date('2026-09-04T15:05:00.000Z'))

  // 第三方小米 MiMo 模型同样通过 Codex 会话产生用量，需归入「小米 MiMo」家族。
  const mimoDay = join(sessions, `rollout-2026-09-08T10-00-00-${uuid('a')}.jsonl`)
  await writeFile(mimoDay,
    line({ timestamp: '2026-09-08T02:00:00.000Z', type: 'session_meta', payload: { cwd: '/work/MimoProject' } }) +
    line({ timestamp: '2026-09-08T02:00:01.000Z', type: 'turn_context', payload: { model: 'mimo-v2.6-pro' } }) +
    tokenCount('2026-09-08T02:10:00.000Z', 100, 10, 80)
  )
  await utimes(mimoDay, new Date('2026-09-08T02:10:00.000Z'), new Date('2026-09-08T02:10:00.000Z'))

  // DeepSeek Harness appends every event batch as its own Zstandard frame, so a
  // session bundle is a concatenated-frame file. Only decoding the first frame
  // would yield the session header and no usage at all.
  const zstdAvailable = typeof zlib.zstdCompressSync === 'function'
  let compressedCodex = ''
  let compressedCodexSize = 0
  const zstd = (value: unknown): Buffer => zlib.zstdCompressSync!(
    Buffer.from(`${JSON.stringify(value)}\n`),
    { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
  )
  const dshSession = (id: string, cwd: string, seeded = false) => zstd({
    type: 'session', version: 4, id, cwd, createdAt: Date.parse('2026-09-06T00:00:00.000Z'), isSeeded: seeded
  })
  const dshHeader = (model: string) => zstd({
    type: 'request/header', seq: 1, time: Date.parse('2026-09-06T00:00:00.000Z'),
    data: { header: { config: { provider: 'deepseek-official', model, reasoningEffort: 'max' } } }
  })
  const dshMessage = (
    time: string, seq: number, turn: number, step: number, input: number, output: number, cached: number
  ): Buffer => zstd({
    type: 'assistant/message', seq, time: Date.parse(time),
    data: {
      turn, step,
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: 0 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
    }
  })
  const dshSessions = join(root, '.uniagent-public', 'deepseek', 'home', 'sessions')
  const multiFrameDay = '2026-09-06'
  const seededDay = '2026-09-07'
  const multiFrameEvent = '2026-09-06T01:00:00.000Z'
  const multiFrameDir = join(dshSessions, '--work-DeepSeekProject--', 'session-00000000-0000-4000-8000-000000000101')
  if (zstdAvailable) {
    await mkdir(multiFrameDir, { recursive: true })
    const torn = dshMessage('2026-09-06T02:00:00.000Z', 4, 1, 3, 999, 99, 0)
    await writeFile(join(multiFrameDir, 'session.v4.jsonl.zstd'), Buffer.concat([
      dshSession('session-00000000-0000-4000-8000-000000000101', '/work/DeepSeekProject'),
      dshHeader('deepseek-flash'),
      // 00:30 and 09:00 in Asia/Shanghai, both on 2026-09-06.
      dshMessage('2026-09-05T16:30:00.000Z', 2, 1, 1, 100, 10, 80),
      dshMessage('2026-09-06T01:00:00.000Z', 3, 1, 2, 50, 5, 20),
      torn.subarray(0, 8) // a session that is still being written ends torn
    ]))
    await utimes(join(multiFrameDir, 'session.v4.jsonl.zstd'),
      new Date(multiFrameEvent), new Date(multiFrameEvent))

    const seededDir = join(dshSessions, '--work-SeededProject--', 'session-00000000-0000-4000-8000-000000000102')
    await mkdir(seededDir, { recursive: true })
    await writeFile(join(seededDir, 'session.v4.jsonl.zstd'), Buffer.concat([
      dshSession('session-00000000-0000-4000-8000-000000000102', '/work/SeededProject', true),
      dshHeader('deepseek-flash'),
      dshMessage('2026-09-07T00:10:00.000Z', 2, 1, 1, 900, 90, 0), // inherited history, must be ignored
      zstd({ type: 'session/end-seed', seq: 3, time: Date.parse('2026-09-07T00:15:00.000Z') }),
      dshMessage('2026-09-07T00:20:00.000Z', 4, 1, 2, 40, 4, 10)
    ]))
    await utimes(join(seededDir, 'session.v4.jsonl.zstd'),
      new Date('2026-09-07T00:20:00.000Z'), new Date('2026-09-07T00:20:00.000Z'))

    // Codex compresses closed rollouts to `.jsonl.zst`; most historical Codex
    // days exist only in this form and must still reach the native totals.
    compressedCodex = join(sessions, `rollout-2026-09-05T10-00-00-${uuid('8')}.jsonl.zst`)
    await writeFile(compressedCodex, zlib.zstdCompressSync!(Buffer.from(
      line({ timestamp: '2026-09-05T10:00:00.000Z', type: 'session_meta', payload: { cwd: '/work/CompressedRollout' } }) +
      line({ timestamp: '2026-09-05T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
      tokenUsage('2026-09-05T10:05:00.000Z', 'compressed-1', 100, 10, 80, 100, 10, 80) +
      tokenUsage('2026-09-05T15:05:00.000Z', 'compressed-2', 50, 5, 20, 150, 15, 100)
    )))
    await utimes(compressedCodex, new Date('2026-09-05T15:05:00.000Z'), new Date('2026-09-05T15:05:00.000Z'))
    compressedCodexSize = (await stat(compressedCodex)).size
  }

  const { getNativeTokenUsage, refreshNativeTokenUsage } = await import('../src/main/nativeTokenUsage.ts')

  if (!zstdAvailable) {
    console.log('native token usage: DeepSeek zstd coverage skipped (runtime without Zstandard)')
  } else {
    const deepseekNow = '2026-09-10T04:00:00.000Z'
    // The decoder needs an external Node; a broken runtime must leave the day
    // retryable instead of finalizing it as "no DeepSeek usage".
    process.env.UNIAGENT_TOKEN_NODE_BIN = join(root, 'missing-node')
    const undecodable = await getNativeTokenUsage(query(multiFrameDay, deepseekNow))
    assert.ok(!('unavailable' in undecodable))
    assert.deepEqual(undecodable.toolBreakdown, [], '解码器不可用时不能伪造 DeepSeek 用量')
    assert.equal(undecodable.stats.tokens, 0)

    delete process.env.UNIAGENT_TOKEN_NODE_BIN
    refreshNativeTokenUsage()
    const deepseekDay = await getNativeTokenUsage(query(multiFrameDay, deepseekNow))
    assert.ok(!('unavailable' in deepseekDay))
    const { cost: _deepseekCost, ...deepseekStats } = deepseekDay.stats
    assert.deepEqual(deepseekStats, {
      tokens: 265, sessions: 1, hours: 0, codeLines: 0,
      inputTokens: 150, outputTokens: 15, cachedTokens: 100, reasoningTokens: 0
    }, '多帧 DeepSeek 会话必须统计全部帧，且缓存读取只作为输入子集')
    assert.deepEqual(deepseekDay.toolBreakdown.map(({ source, tokens, sessions }) => ({ source, tokens, sessions })), [
      { source: 'DeepSeek Harness', tokens: 265, sessions: 1 }
    ], 'DeepSeek Harness 必须出现在按工具（来源）统计中')
    assert.deepEqual(deepseekDay.modelBreakdown.map(({ model, family, tokens }) => ({ model, family, tokens })), [
      { model: 'deepseek-flash', family: 'DeepSeek', tokens: 265 }
    ])
    assert.deepEqual(deepseekDay.projectBreakdown.map(({ project, tokens, sessions, models }) => ({
      project, tokens, sessions, models
    })), [{ project: 'DeepSeekProject', tokens: 265, sessions: 1, models: 1 }])
    const deepseekHours = deepseekDay.hourlyTrend?.tokens || []
    assert.equal(deepseekDay.hourlyTrend?.date, multiFrameDay)
    assert.equal(deepseekHours.length, 24)
    assert.equal(deepseekHours[0], 190, '00:30 的事件必须落在本地 0 点桶')
    assert.equal(deepseekHours[9], 75, '09:00 的事件必须落在本地 9 点桶')
    assert.equal(deepseekHours.reduce((total, value) => total + value, 0), 265,
      '24 个小时桶之和必须等于当天总 Token')

    const seededDayProfile = await getNativeTokenUsage(query(seededDay, deepseekNow))
    assert.ok(!('unavailable' in seededDayProfile))
    assert.deepEqual(seededDayProfile.toolBreakdown.map(({ source, tokens }) => ({ source, tokens })), [
      { source: 'DeepSeek Harness', tokens: 54 }
    ], '种子会话只统计 end-seed 之后的新增用量')
  }

  const preciseMixed = await getNativeTokenUsage(query('2026-08-26'))
  assert.ok(!('unavailable' in preciseMixed))
  assert.equal(preciseMixed.stats.tokens, 880,
    'same-day summary must retain legacy usage when precise counters restart from zero')

  const preciseFirstDay = await getNativeTokenUsage(query('2026-08-27'))
  assert.ok(!('unavailable' in preciseFirstDay))
  const { cost: preciseFirstCost, ...preciseFirstStats } = preciseFirstDay.stats
  assert.deepEqual(preciseFirstStats, {
    tokens: 165, sessions: 1, hours: 0, codeLines: 0,
    inputTokens: 30, outputTokens: 15, cachedTokens: 120, reasoningTokens: 0
  }, 'legacy usage plus unique response records must be counted once before midnight')
  assert.ok(Math.abs(preciseFirstCost - 0.00072) < 1e-12)

  const preciseSecondDay = await getNativeTokenUsage(query('2026-08-28'))
  assert.ok(!('unavailable' in preciseSecondDay))
  const { cost: preciseSecondCost, ...preciseSecondStats } = preciseSecondDay.stats
  assert.deepEqual(preciseSecondStats, {
    tokens: 220, sessions: 1, hours: 0, codeLines: 0,
    inputTokens: 40, outputTokens: 20, cachedTokens: 160, reasoningTokens: 0
  }, 'post-compaction response usage must stay on its actual day without token_count reset loss')
  assert.ok(Math.abs(preciseSecondCost - 0.00096) < 1e-12)

  const preciseSummary = await getNativeTokenUsage(query('2026-09-01'))
  assert.ok(!('unavailable' in preciseSummary))
  assert.equal(preciseSummary.stats.tokens, 330,
    'same-day summary must subtract inherited fork usage and ignore reset token_count totals')

  const sameDayProfile = await getNativeTokenUsage(query('2026-08-29'))
  assert.ok(!('unavailable' in sameDayProfile))
  const { cost: sameDayCost, ...sameDayStats } = sameDayProfile.stats
  assert.deepEqual(sameDayStats, {
    tokens: 1_100,
    sessions: 1,
    hours: 0,
    codeLines: 0,
    inputTokens: 200,
    outputTokens: 100,
    cachedTokens: 800,
    reasoningTokens: 0
  }, '总 Token 应包含缓存，同时输入明细只展示非缓存输入')
  assert.ok(Math.abs(sameDayCost - 0.0048) < 1e-12)

  await appendFile(sameDay, tokenCount('2026-08-29T03:10:00.000Z', 9_000, 900, 7_200))
  await utimes(sameDay, new Date('2026-08-29T03:10:00.000Z'), new Date('2026-08-29T03:10:00.000Z'))
  refreshNativeTokenUsage()
  const cachedPastProfile = await getNativeTokenUsage(query('2026-08-29'))
  assert.ok(!('unavailable' in cachedPastProfile))
  const { cost: _pastCost, ...cachedPastStats } = cachedPastProfile.stats
  assert.deepEqual(cachedPastStats, {
    tokens: 9_900, sessions: 1, hours: 0, codeLines: 0,
    inputTokens: 1_800, outputTokens: 900, cachedTokens: 7_200, reasoningTokens: 0
  }, '历史日期在会话文件变化后必须重算，不能继续使用旧结算')

  refreshNativeTokenUsage()
  const crossDayProfile = await getNativeTokenUsage(query('2026-08-31'))
  assert.ok(!('unavailable' in crossDayProfile))
  const { cost: crossDayCost, ...crossDayStats } = crossDayProfile.stats
  assert.deepEqual(crossDayStats, {
    tokens: 660,
    sessions: 1,
    hours: 0,
    codeLines: 0,
    inputTokens: 100,
    outputTokens: 60,
    cachedTokens: 500,
    reasoningTokens: 0
  }, '跨日会话只能把当天累计增量计入当天')
  assert.ok(Math.abs(crossDayCost - 0.0027) < 1e-12)
  assert.deepEqual(crossDayProfile.modelBreakdown, [{
    model: 'gpt-5.6-sol', family: 'OpenAI', tokens: 660, cost: 0.0027
  }], '超大 session_meta 之后的模型仍应参与模型与成本统计')
  assert.deepEqual(crossDayProfile.projectBreakdown, [{
    project: 'HugeProject', tokens: 660, cost: 0.0027, sessions: 1, models: 1
  }], '超大 session_meta 中的项目仍应被解析')

  const firstCurrentProfile = await getNativeTokenUsage(query('2026-09-02'))
  assert.ok(!('unavailable' in firstCurrentProfile))
  assert.equal(firstCurrentProfile.stats.tokens, 110)
  await appendFile(currentDay, tokenCount('2026-09-02T01:10:00.000Z', 200, 20, 160))
  await utimes(currentDay, new Date('2026-09-02T01:10:00.000Z'), new Date('2026-09-02T01:10:00.000Z'))
  refreshNativeTokenUsage()
  const refreshedCurrentProfile = await getNativeTokenUsage(query('2026-09-02'))
  assert.ok(!('unavailable' in refreshedCurrentProfile))
  assert.equal(refreshedCurrentProfile.stats.tokens, 220, '当天缓存必须在刷新后重新扫描')

  await appendFile(currentDay, tokenCount('2026-09-02T02:10:00.000Z', 300, 30, 240))
  await utimes(currentDay, new Date('2026-09-02T02:10:00.000Z'), new Date('2026-09-02T02:10:00.000Z'))
  refreshNativeTokenUsage()
  const finalizedYesterday = await getNativeTokenUsage(query('2026-09-02', '2026-09-03T04:00:00.000Z'))
  assert.ok(!('unavailable' in finalizedYesterday))
  assert.equal(finalizedYesterday.stats.tokens, 330, '当天临时缓存应在次日首次访问时重新结算')
  await appendFile(currentDay, tokenCount('2026-09-02T03:10:00.000Z', 400, 40, 320))
  await utimes(currentDay, new Date('2026-09-02T03:10:00.000Z'), new Date('2026-09-02T03:10:00.000Z'))
  refreshNativeTokenUsage()
  const immutableYesterday = await getNativeTokenUsage(query('2026-09-02', '2026-09-03T04:00:00.000Z'))
  assert.ok(!('unavailable' in immutableYesterday))
  assert.equal(immutableYesterday.stats.tokens, 440,
    '结算完成的历史日期在会话文件变化后必须重算')

  const hourlyDay = await getNativeTokenUsage(query('2026-09-04', '2026-09-10T04:00:00.000Z'))
  assert.ok(!('unavailable' in hourlyDay))
  assert.equal(hourlyDay.stats.tokens, 165)
  const codexHours = hourlyDay.hourlyTrend?.tokens || []
  assert.equal(codexHours.length, 24)
  assert.equal(codexHours[18], 110, '单日 Codex 会话必须按事件时间落在本地 18 点桶')
  assert.equal(codexHours[23], 55, '单日 Codex 会话必须按事件时间落在本地 23 点桶')
  assert.equal(codexHours.reduce((total, value) => total + value, 0), 165,
    '24 个小时桶之和必须等于当天总 Token')

  const mimoDayProfile = await getNativeTokenUsage(query('2026-09-08', '2026-09-10T04:00:00.000Z'))
  assert.ok(!('unavailable' in mimoDayProfile))
  assert.deepEqual(mimoDayProfile.modelBreakdown.map(({ model, family, tokens }) => ({ model, family, tokens })), [
    { model: 'mimo-v2.6-pro', family: '小米 MiMo', tokens: 110 }
  ], 'MiMo 第三方模型必须归入小米 MiMo 家族')

  if (zstdAvailable) {
    const compressedDay = await getNativeTokenUsage(query('2026-09-05', '2026-09-10T04:00:00.000Z'))
    assert.ok(!('unavailable' in compressedDay))
    assert.equal(compressedDay.stats.tokens, 165, '压缩的 Codex rollout 必须参与原生统计')
    assert.deepEqual(compressedDay.toolBreakdown.map(({ source, tokens, sessions }) => ({
      source, tokens, sessions
    })), [{ source: 'Codex', tokens: 165, sessions: 1 }])
    assert.equal(compressedDay.hourlyTrend?.tokens[18], 110)
    assert.equal(compressedDay.hourlyTrend?.tokens[23], 55)
    const cached = JSON.parse(await readFile(join(root, '.uniagent-public', 'token-usage-cache.json'), 'utf8'))
    assert.equal(cached.sessions[compressedCodex]?.size, compressedCodexSize,
      '压缩会话的缓存大小必须取磁盘上的压缩文件大小')

    // A newly discovered session must rebuild a day that was already finalized.
    const lateCodex = join(sessions, `rollout-2026-09-05T12-00-00-${uuid('9')}.jsonl`)
    await writeFile(lateCodex,
      line({ timestamp: '2026-09-05T12:00:00.000Z', type: 'session_meta', payload: { cwd: '/work/LateDay' } }) +
      line({ timestamp: '2026-09-05T12:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
      tokenUsage('2026-09-05T12:05:00.000Z', 'late-1', 50, 5, 20, 50, 5, 20)
    )
    await utimes(lateCodex, new Date('2026-09-05T12:05:00.000Z'), new Date('2026-09-05T12:05:00.000Z'))
    const rebuilt = await getNativeTokenUsage(query('2026-09-05', '2026-09-10T04:00:00.000Z'))
    assert.ok(!('unavailable' in rebuilt))
    assert.equal(rebuilt.stats.tokens, 220, '结算完成的历史日期在出现新会话后必须重算')
  }
} finally {
  try {
    const { flushTokenUsageLog } = await import('../src/main/tokenUsageLog.ts')
    await flushTokenUsageLog()
  } catch { /* diagnostics are best effort */ }
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  if (previousDecoderNode === undefined) delete process.env.UNIAGENT_TOKEN_NODE_BIN
  else process.env.UNIAGENT_TOKEN_NODE_BIN = previousDecoderNode
  if (previousUserData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousUserData
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(root, { recursive: true, force: true })
}

console.log('native token usage: ok')
