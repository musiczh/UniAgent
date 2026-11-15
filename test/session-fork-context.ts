import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { codexEffective, claudeEffective, portableMessages, readForkContext, saveForkContext, writeForkTarget, appServerResponseItems, appServerContextEstimate, appServerModelBudget } from '../src/main/forkContext'
import { forkCapacity, claudeForkCapacity, appServerForkCapacity } from '../src/shared/sessionFork'
import { validateForkHandoff } from '../src/main/forkNativeRuntime'

const record = (type: string, payload: any, ordinal = 0) => ({ type, payload, ordinal })
const message = (text: string, role = 'user') => ({ type: 'message', role, content: [{ type: 'input_text', text }] })
const old = record('response_item', message('old '.repeat(100_000)))
const checkpoint = record('compacted', { replacement_history: [message('summary')] })
const telemetry = record('event_msg', { type: 'token_count', info: { total: 999999 } })
const compact = codexEffective([old, checkpoint, telemetry])
assert.deepEqual(compact.items, [message('summary')], '旧历史不得重新装回有效窗口')
assert.equal(compact.reusable, true)
assert.equal(compact.revision, codexEffective([old, checkpoint]).revision, '用量不影响复用')
assert.equal(codexEffective([checkpoint, record('response_item', message('new'))]).reusable, false)
assert.equal(codexEffective([checkpoint, record('event_msg', { type: 'thread_rolled_back', num_turns: 1 })]).reusable, false)
assert.equal(codexEffective([old, record('compacted', {})]).needsHandoff, true)
const traexCheckpoint = record('history_mutation', { version: 1, operation: 'replace', compaction_response_id: 'native-compact', items: [message('TraeX summary')] })
const traexCompact = codexEffective([old, traexCheckpoint, record('event_msg', { type: 'context_compacted' }), telemetry])
assert.deepEqual(traexCompact.items, [message('TraeX summary')])
assert.equal(traexCompact.reusable, true, 'native replace with a compaction receipt is a reusable checkpoint')
assert.equal(traexCompact.needsHandoff, false)
assert.ok(traexCompact.checkpoint)
assert.equal(codexEffective([traexCheckpoint, record('history_mutation', { version: 1, operation: 'append', items: [message('next')] })]).reusable, false)
const replaceOnly = codexEffective([old, record('history_mutation', { version: 1, operation: 'replace', items: [message('replacement')] })])
assert.deepEqual(replaceOnly.items, [message('replacement')])
assert.equal(replaceOnly.reusable, false, 'ordinary replacement is not proof of native compaction')
assert.equal(codexEffective([old, record('event_msg', { type: 'context_compacted' })]).reusable, false)
assert.equal(codexEffective([old, { ...traexCheckpoint, payload: { ...traexCheckpoint.payload, version: 2 } }]).reusable, false)
assert.equal(portableMessages([{ type: 'compaction', encrypted_content: 'opaque' }], false).needsHandoff, true)
const paired = portableMessages([{ type: 'function_call', call_id: 'tool-1', name: 'read', arguments: '{"path":"a"}' }, { type: 'function_call_output', call_id: 'tool-1', output: 'result' }], false)
assert.equal(paired.messages[0].content[0].id, paired.messages[1].content[0].tool_use_id)
assert.equal(portableMessages([{ type: 'function_call_output', call_id: 'missing', output: 'result' }], false).messages[0].content[0].type, 'text')

const claudeRows = [
  { uuid: 'old', parentUuid: null, type: 'user', message: { role: 'user', content: 'old' } },
  { uuid: 'keep', parentUuid: 'old', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'preserved' }] } },
  { uuid: 'boundary', parentUuid: 'old', type: 'system', subtype: 'compact_boundary', compactMetadata: { preservedSegment: { anchorUuid: 'summary', headUuid: 'keep', tailUuid: 'keep' } } },
  { uuid: 'summary', parentUuid: 'boundary', type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } },
  { uuid: 'tail', parentUuid: 'summary', type: 'user', message: { role: 'user', content: 'next' } }
]
assert.deepEqual(claudeEffective(claudeRows).items.map(item => typeof item.content === 'string' ? item.content : item.content[0].text), ['summary','preserved','next'])
assert.equal(claudeEffective(claudeRows).reusable, false)
const withoutPreserved = claudeRows.filter(row => !['keep','tail'].includes(row.uuid)).map(row => row.uuid === 'boundary' ? { ...row, compactMetadata: {} } : row)
assert.equal(claudeEffective(withoutPreserved).reusable, true)
const receiptRows = [...withoutPreserved,
  { uuid: 'caveat', parentUuid: 'summary', type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>native command</local-command-caveat>' } },
  { uuid: 'command', parentUuid: 'caveat', type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } },
  { uuid: 'stdout', parentUuid: 'command', type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } }
]
assert.equal(claudeEffective(receiptRows).reusable, true, 'native /compact receipt is not a new user turn')
assert.deepEqual(claudeEffective(receiptRows).items, [{ role: 'user', content: 'summary' }])
assert.equal(claudeEffective([...receiptRows, { uuid: 'env', parentUuid: 'stdout', type: 'attachment', attachment: { type: 'environment', cwd: '/new' } }]).revision,
  claudeEffective(receiptRows).revision, 'native environment telemetry does not invalidate the approved content revision')
assert.throws(() => claudeEffective(claudeRows.filter(row => row.uuid !== 'keep')), /片段|区间/)
assert.throws(() => forkCapacity(300_000, 200_000, 12000, 32000), /超过/)
assert.throws(() => forkCapacity(100, NaN, 0, 0), /无法确认/)
assert.equal(forkCapacity(10_000, 200_000, 12_000, 32_000), 126_000)
const actualReport = { rawMaxTokens: 200000, totalTokens: 92322, categories: [
  { id: 'messages', kind: 'used', tokens: 72604 }, { id: 'autocompact_buffer', kind: 'buffer', tokens: 33000 }
] }
assert.equal(claudeForkCapacity(actualReport, 1048576).window, 200000, 'native harness limit wins over provider advertisement')
assert.equal(claudeForkCapacity(actualReport, 1048576).contextTokens, 72604, 'native image accounting must not count base64 bytes as tokens')
assert.throws(() => claudeForkCapacity({ ...actualReport, maxTokens: 100000 }, 1048576), /超过/, 'a smaller effective native window also limits the budget')
assert.throws(() => claudeForkCapacity({ ...actualReport, totalTokens: 199000 }, 1048576), /超过/)
assert.throws(() => claudeForkCapacity({ rawMaxTokens: 200000, categories: [] }, 200000), /未返回可核验/)
assert.throws(() => validateForkHandoff('{}'), /必需字段/)

const home = await mkdtemp(join(tmpdir(), 'uniagent-fork-context-'))
const catalog = join(home, 'models.json')
await writeFile(catalog, JSON.stringify({ models: [{ slug: 'GPT-6.1-Sol', context_window: 500000, effective_context_window_percent: 95, supports_search_tool: true }] }))
assert.deepEqual(await appServerModelBudget({ home, agentId: 'traex', model: 'gpt-6.1-sol', catalog }), { window: 475000, deferredTools: true })
assert.deepEqual(await appServerModelBudget({ home, agentId: 'traex', model: 'unknown', catalog }), { window: undefined, deferredTools: false })
assert.deepEqual(await appServerModelBudget({ home, agentId: 'codex', model: 'unknown', catalog: join(home, 'missing.json') }), { deferredTools: false })
const root = join(home, '.codex/sessions/2026/11/02')
await mkdir(root, { recursive: true })
const parentRows = [record('session_meta', { id: 'parent', cwd: home }, 0), { ...old, ordinal: 1 }, { ...checkpoint, ordinal: 2 }]
const prefix = parentRows.map(JSON.stringify).join('\n') + '\n'
await writeFile(join(root, 'rollout-parent.jsonl'), prefix + JSON.stringify(record('response_item', message('future'), 3)) + '\n')
const child = join(root, 'rollout-child.jsonl')
await writeFile(child, JSON.stringify(record('session_meta', { id: 'child', cwd: home, history_base: { thread_id: 'parent', end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 3 } })) + '\n')
const archive = join(home, 'export')
const context = await readForkContext({ home, agentId: 'codex', nativeId: 'child', archive })
assert.equal(context.reusable, true)
assert.equal(context.records, 4)
assert.equal(JSON.stringify(context.messages).includes('future'), false)
assert.equal(JSON.stringify(context.messages).includes('old old'), false)
const before = await readFile(child, 'utf8')
await saveForkContext(archive, context)
const target = await writeForkTarget({ home, agentId: 'claude', nativeId: 'target', cwd: home, archive, model: 'mimo-v2.6-pro' })
const targetRows = (await readFile(target, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
assert.equal(targetRows.length, 2)
assert.equal(targetRows[1].parentUuid, targetRows[0].uuid)
assert.equal(await writeForkTarget({ home, agentId: 'claude', nativeId: 'target', cwd: home, archive, model: 'mimo-v2.6-pro' }), target, 'retry reuses the same native target')
const secondTarget = await writeForkTarget({ home, agentId: 'claude', nativeId: 'new-model-target', cwd: home, archive, model: 'different-model' })
assert.notEqual(secondTarget, target, 'a new model can reuse the export directory without overwriting a prepared target')
for (const agentId of ['codex', 'traex']) {
  const nativeId = `${agentId}-target`
  const file = await writeForkTarget({ home, agentId, nativeId, cwd: home, archive, model: 'gpt-6.1-sol' })
  const loaded = await readForkContext({ home, agentId, nativeId })
  assert.ok(JSON.stringify(loaded.messages).includes('summary'))
  assert.ok(!JSON.stringify(loaded.messages).includes('old old'))
  assert.ok(!JSON.stringify(loaded.messages).includes('future'))
  assert.equal(await writeForkTarget({ home, agentId, nativeId, cwd: home, archive, model: 'gpt-6.1-sol' }), file)
  const reverse = agentId === 'codex' ? 'traex' : 'codex'
  const reverseArchive = join(home, `${agentId}-reverse-export`)
  await mkdir(reverseArchive)
  await saveForkContext(reverseArchive, loaded)
  await writeForkTarget({ home, agentId: reverse, nativeId: `${agentId}-reverse`, cwd: home, archive: reverseArchive, model: 'gpt-6.1-sol' })
  assert.ok(JSON.stringify((await readForkContext({ home, agentId: reverse, nativeId: `${agentId}-reverse` })).messages).includes('summary'))
}
const portableTool = [{ role: 'assistant' as const, content: [{ type: 'text', text: 'inspect' }, { type: 'tool_use', id: 'call', name: 'read', input: { file: 'a' } }] },
  { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(400000) } }] }]
const nativeItems = appServerResponseItems(portableTool)
assert.equal(nativeItems[1].call_id, nativeItems[2].call_id)
assert.equal(nativeItems[3].content[0].type, 'input_image')
assert.ok(appServerContextEstimate(portableTool, 'GPT-6.1-Sol') < 11000, 'GPT image budget is independent of base64 encoding length')
assert.ok(appServerContextEstimate(portableTool, 'unknown-model') > 400000, 'unknown image accounting must remain conservative')
assert.ok(appServerForkCapacity(10000, 200000).overheadTokens >= 50000)
assert.throws(() => appServerForkCapacity(100000, 200000, 100000), /超过/)
assert.throws(() => appServerForkCapacity(1, NaN), /无法确认/)
assert.throws(() => appServerResponseItems([{ role: 'user', content: [{ type: 'unsupported' }] }]), /无法表达/)
const recoveredId = 'recover-target'
const recoveredFile = join(home, '.claude/projects', home.replace(/[^a-zA-Z0-9]/g, '-'), `${recoveredId}.jsonl`)
const payload = Buffer.from((await readFile(target, 'utf8')).replaceAll('"sessionId":"target"', `"sessionId":"${recoveredId}"`))
await writeFile(join(archive, `target-${recoveredId}.jsonl`), payload)
await writeFile(join(archive, `target-${recoveredId}.json`), JSON.stringify({ nativeId: recoveredId, file: recoveredFile,
  bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }))
assert.equal(await writeForkTarget({ home, agentId: 'claude', nativeId: recoveredId, cwd: home, archive, model: 'mimo-v2.6-pro' }), recoveredFile)
assert.deepEqual(await readFile(recoveredFile), payload, 'restart completes a durable target intent without allocating a different identity')
assert.equal(await readFile(child, 'utf8'), before, '导出不修改来源')
assert.ok((await readFile(join(archive, 'history/part-0001.jsonl'), 'utf8')).includes('old old'))
assert.ok(!(await readFile(join(archive, 'history/part-0001.jsonl'), 'utf8')).includes('future'))
await appendFile(child, JSON.stringify(record('response_item', message('new'))) + '\n')
assert.equal((await readForkContext({ home, agentId: 'codex', nativeId: 'child' })).reusable, false)
const artifactsDirectory = join(home, 'cached-turns')
await mkdir(artifactsDirectory)
await writeFile(join(artifactsDirectory, 'manifest.json.gz'), gzipSync(JSON.stringify({ turns: [{ nativeTurnId: 'selected-turn' }, { nativeTurnId: 'future-turn' }] })))
await writeFile(join(artifactsDirectory, 'selected-turn.json.gz'), gzipSync(JSON.stringify({ nativeTurnId: 'selected-turn', files: [
  { path: 'source.ts', before: 'old file', after: 'new file' }, { path: '.env', after: 'PRIVATE_FIXTURE_VALUE' }
] })))
await writeFile(join(artifactsDirectory, 'future-turn.json.gz'), gzipSync(JSON.stringify({ nativeTurnId: 'future-turn', files: [{ after: 'future file' }] })))
await appendFile(child, JSON.stringify(record('event_msg', { type: 'task_complete', turn_id: 'selected-turn' })) + '\n')
const selectedArchive = join(home, 'selected-export')
await readForkContext({ home, agentId: 'codex', nativeId: 'child', point: { nativeId: 'selected-turn', kind: 'after-turn', eventSeq: 0 },
  archive: selectedArchive, sourceCache: { attachments: [], artifactsDirectory } })
const savedManifest = JSON.parse(await readFile(join(selectedArchive, 'manifest.json'), 'utf8'))
assert.ok(savedManifest.files.some((file: any) => file.path === 'artifacts/turn-selected-turn.json'))
assert.ok(!JSON.stringify(savedManifest).includes('future-turn'), 'historical forks archive only snapshots belonging to their frozen prefix')
assert.ok((await readFile(join(selectedArchive, 'artifacts/turn-selected-turn.json'), 'utf8')).includes('old file'))
assert.ok(!(await readFile(join(selectedArchive, 'artifacts/turn-selected-turn.json'), 'utf8')).includes('PRIVATE_FIXTURE_VALUE'))
assert.ok(savedManifest.missing.some((item: string) => item.includes('.env')))
const traexRoot = join(home, '.trae/cli/sessions')
await mkdir(traexRoot, { recursive: true })
const traexFile = (id: string) => join(traexRoot, `rollout-${id}.jsonl`)
const blobRef = (body: string) => `traex-rollout-blob:v1:sha256:${createHash('sha256').update(body).digest('hex')}:${Buffer.byteLength(body)}`
const writeBlob = async (id: string, body: string) => {
  const digest = createHash('sha256').update(body).digest('hex')
  const directory = join(traexRoot, `rollout-${id}.artifacts/rollout-blobs/sha256`, digest.slice(0, 2))
  await mkdir(directory, { recursive: true })
  const file = join(directory, digest)
  await writeFile(file, body)
  return file
}
const writeTraex = async (id: string, rows: any[]) => writeFile(traexFile(id), rows.map(JSON.stringify).join('\n') + '\n')
const imageUrl = 'data:image/png;base64,aW1hZ2U='
const imageMessage = (url: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: url }] })
await writeTraex('inline', [record('response_item', imageMessage(imageUrl))])
await writeTraex('blob-parent', [record('response_item', imageMessage(blobRef(imageUrl)), 0)])
const blobFile = await writeBlob('blob-parent', imageUrl)
await writeTraex('blob-child', [record('session_meta', { history_base: { thread_id: 'blob-parent', end_ordinal_exclusive: 1 } })])
const blobArchive = join(home, 'blob-export')
const hydrated = await readForkContext({ home, agentId: 'traex', nativeId: 'blob-child', archive: blobArchive })
assert.equal(hydrated.contextFingerprint, (await readForkContext({ home, agentId: 'traex', nativeId: 'inline' })).contextFingerprint,
  'native externalization must preserve the snapshot fingerprint, including parent sidecars')
assert.equal(hydrated.messages[0].content[0].source.data, 'aW1hZ2U=')
const blobManifest = JSON.parse(await readFile(join(blobArchive, 'manifest.json'), 'utf8'))
const archivedBlob = blobManifest.files.find((file: any) => file.source === blobFile)
assert.equal(await readFile(join(blobArchive, archivedBlob.path), 'utf8'), imageUrl)
await saveForkContext(blobArchive, hydrated)
await writeForkTarget({ home, agentId: 'codex', nativeId: 'from-blob', cwd: home, archive: blobArchive, model: 'gpt-6.1-sol' })
assert.deepEqual((await readForkContext({ home, agentId: 'codex', nativeId: 'from-blob' })).messages[0], hydrated.messages[0])
await writeFile(blobFile, 'corrupt')
await assert.rejects(readForkContext({ home, agentId: 'traex', nativeId: 'blob-child' }), /缓存长度或哈希不一致/)
await writeTraex('missing-blob', [record('response_item', message(blobRef('missing active text')))])
await assert.rejects(readForkContext({ home, agentId: 'traex', nativeId: 'missing-blob' }), /TraeX 历史缓存/)
await writeTraex('invalid-blob', [record('response_item', message('traex-rollout-blob:unsupported'))])
await assert.rejects(readForkContext({ home, agentId: 'traex', nativeId: 'invalid-blob' }), /不支持的缓存引用格式/)
const oldBlob = '已经压缩的历史工具输出'
await writeBlob('compacted-blobs', oldBlob)
await writeTraex('compacted-blobs', [record('response_item', message(blobRef(oldBlob))),
  record('response_item', message(blobRef('missing old text'))), checkpoint,
  record('event_msg', { type: 'task_complete', turn_id: 'blob-cutoff' }),
  record('response_item', message(blobRef('future missing text')))])
const blobPoint = { nativeId: 'blob-cutoff', kind: 'after-turn' as const, eventSeq: 0 }
const beforeBlobArchive = await readForkContext({ home, agentId: 'traex', nativeId: 'compacted-blobs', point: blobPoint })
const afterBlobArchive = await readForkContext({ home, agentId: 'traex', nativeId: 'compacted-blobs', point: blobPoint, archive: join(home, 'old-blob-export') })
assert.equal(afterBlobArchive.revision, beforeBlobArchive.revision, 'archiving supplementary caches must not invalidate the approved revision')
assert.equal(afterBlobArchive.contextFingerprint, beforeBlobArchive.contextFingerprint)
assert.equal(afterBlobArchive.missing.length, 1, 'missing pre-compaction cache is supplementary; future cache must not be read')
assert.ok((await readFile(join(home, 'old-blob-export/history/part-0001.jsonl'), 'utf8')).includes(oldBlob))
console.log('session-fork-context: passed (compaction, lineage bounds, graph, tool pairing, archive, capacity)')
