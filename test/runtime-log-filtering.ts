import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticsStore } from '../src/main/diagnostics'

const root = mkdtempSync(join(tmpdir(), 'uniagent-runtime-filter-'))
try {
  const file = join(root, 'diagnostics.jsonl')
  const base = { category: 'app_runtime' as const, level: 'error' as const, agentId: 'app' }
  const store = new DiagnosticsStore(file)
  const noise = [
    { source: 'agent', code: 'agent_run_warning', message: '---------------------------------------------------------------' },
    { source: 'agent', code: 'agent_run_warning', message: 'Automatic continuation of background results is paused after this turn failed. Resolve the error, then send a message to continue.' },
    { source: 'agent', code: 'agent_run_error', message: 'Selected model is at capacity. Please try a different model.' },
    { source: 'agent', code: 'agent_run_warning', message: 'Failed to update plugin marketplace `ponytail`: git ls-remote marketplace source failed with status exit status: 128: fatal: unable to access a marketplace: Send failure: Broken pipe' },
    { source: 'renderer-performance', code: 'renderer_long_tasks', message: '页面出现耗时任务' },
    { source: 'renderer-console', code: 'console_error', message: 'Uncaught Error: 设计稿面板越界', sample: { context: { sourceId: 'about:srcdoc' } } },
    { source: 'feishu', code: 'progress_card_update_failed', message: 'timeout', sample: { context: { retryStopped: false, failureKind: 'timeout' } } }
  ]
  for (const input of noise) assert.equal(store.record({ ...base, ...input }), undefined)
  for (const feishuCode of [300120, 300308]) {
    assert.equal(store.record({ ...base, source: 'feishu', code: 'progress_card_update_failed', message: 'server error',
      sample: { context: { retryStopped: false, failureKind: 'business', feishuCode } } }), undefined)
  }
  for (const input of [
    { source: 'renderer', code: 'render_process_gone', message: 'crashed' },
    { source: 'renderer-console', code: 'console_error', message: 'Uncaught Error: 设计稿面板越界', sample: { context: { sourceId: 'file:///app/index.js' } } },
    { source: 'feishu', code: 'progress_card_update_failed', message: 'timeout', sample: { context: { retryStopped: true, failureKind: 'timeout' } } },
    { source: 'feishu', code: 'progress_card_update_failed', message: 'unknown failure' },
    { source: 'feishu', code: 'progress_card_update_failed', message: 'unknown business error', sample: { context: { retryStopped: false, feishuCode: 99999 } } },
    { source: 'feishu', code: 'team_material_send_failed', message: 'timeout' },
    { source: 'agent', code: 'agent_run_warning', message: 'failed to parse hooks config: beforeReadFile' },
    { source: 'agent', code: 'agent_run_error', message: 'Invalid tool schema' }
  ]) assert.ok(store.record({ ...base, ...input }), input.message)

  const fixed = { ...base, source: 'renderer', code: 'uncaught_exception', message: "Uncaught TypeError: Cannot read properties of undefined (reading 'info')", sample: JSON.stringify({ error: 'TypeError at NewTaskPanel' }) }
  writeFileSync(file, [
    { ...fixed, id: 'old', ts: Date.parse('2026-10-13T06:14:59.601Z'), count: 2 },
    { ...fixed, id: 'regression', ts: Date.parse('2026-10-14T00:00:00Z'), count: 1 },
    { ...fixed, id: 'unrelated', ts: Date.parse('2026-10-13T06:14:59.601Z'), count: 1, sample: JSON.stringify({ error: 'TypeError at AnotherPanel' }) }
  ].map(row => JSON.stringify(row)).join('\n'))
  assert.deepEqual(new DiagnosticsStore(file).list().map(row => row.id), ['regression', 'unrelated'])

  const legacyRows = [
    { source: 'app-update', code: 'network', message: 'network' },
    { source: 'codex-app-server', code: 'title_generation_failed', field: 'response', message: '自动生成会话标题失败，已保留当前标题：标题回合未完成：failed', sample: JSON.stringify({ stage: 'response', message: '标题回合未完成：failed' }) },
    { source: 'main-process', code: 'unhandled_rejection', message: 'rename failed', sample: JSON.stringify({ error: { code: 'ENOENT', syscall: 'rename', path: '/data/team-results/c69e953b-fdf0-429f-ba7c-e28be1743e8d.json.tmp' } }) },
    { source: 'agent', code: 'agent_run_error', message: "Invalid 'input[4].call_id': string too long. Expected a string with maximum length 64, but got a string with length 91 instead." },
    { source: 'agent', code: 'agent_run_error', message: 'Trae chat history contains duplicate tool calls; refusing ambiguous history' },
    { source: 'agent', code: 'agent_run_error', message: 'unexpected status 404 Not Found: 模型不属于当前第三方来源, url: http://127.0.0.1:11436/api/codex/v1/kimi/responses' },
    { source: 'renderer-console', code: 'console_error', message: 'Not allowed to load local resource: file:///app/out/renderer/assets/index-BtBNoes2.css', sample: JSON.stringify({ context: { sourceId: 'file:///app/out/renderer/html-preview.html' } }) }
  ]
  for (const row of legacyRows) {
    writeFileSync(file, [
      { ...base, ...row, id: 'old', ts: Date.parse('2026-10-10T00:00:00Z'), count: 1 },
      { ...base, ...row, id: 'regression', ts: Date.parse('2026-10-14T00:00:00Z'), count: 1 }
    ].map(entry => JSON.stringify(entry)).join('\n'))
    assert.deepEqual(new DiagnosticsStore(file).list().map(entry => entry.id), ['regression'], row.code)
  }
} finally { rmSync(root, { recursive: true, force: true }) }
