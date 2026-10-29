import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { resolve, join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, Session, UAEvent } from '../src/shared/types.ts'
import { formatClaudeNativeReport } from '../src/shared/claudeNativeReports.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-claude-native-reports-'))
const bin = join(root, 'claude.cjs')
const context = { model: 'claude-sonnet-4-5', totalTokens: 1500, rawMaxTokens: 200000, percentage: 0.75,
  categories: [{ name: 'System prompt', tokens: 1000, kind: 'used' }], mcpTools: [{ name: 'read', serverName: 'docs', tokens: 50 }] }
const usage = { session: { total_cost_usd: 0.15, total_api_duration_ms: 2000, total_duration_ms: 3000,
  total_lines_added: 2, total_lines_removed: 1, model_usage: { 'claude-sonnet-4-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, costUSD: 0.15 } } },
  subscription_type: null, rate_limits_available: false, rate_limits: null }
await writeFile(bin, `#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);if(v.type==='user')process.exit(8);const result=v.request.subtype==='get_context_usage'?${JSON.stringify(context)}:v.request.subtype==='get_usage'?${JSON.stringify(usage)}:{commands:[]};process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:result}})+'\\n')});\n`, { mode: 0o700 })
const agent: AgentDef = { id: 'claude', name: 'Claude', bin, adapter: 'claude', builtin: true, icon: '', installed: true, version: '2.1.296', models: [],
  lifecycle: { availability: 'available', auth: 'authenticated', health: 'healthy', updateStatus: 'current', checkedAt: 1 },
  capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [{ id: 'full-access', label: '', hint: '' }] } }
const store = new SessionStore(join(root, 'sessions.json'))
const orchestrator = new Orchestrator(() => agent, store, join(root, 'artifacts'))
const session: Session = { id: 'reports', title: 'Reports', status: 'idle', createdAt: 1, config: { agentId: 'claude', permissionMode: 'full-access', workdir: root } }
;(orchestrator as any).sessions.set(session.id, session)
;(orchestrator as any).events.set(session.id, [])
;(orchestrator as any).seqRefs.set(session.id, { n: 0 })
try {
  const wrapperQuota = formatClaudeNativeReport('usage_report', { session: usage.session, rate_limits: { limits: [
    { kind: 'five_hour', percent: 35, resets_at: '2026-10-11T15:00:00Z' }
  ] }, extra_usage: { is_enabled: true, used_credits: 12, monthly_limit: 100, currency: 'USD' } })
  assert.match(wrapperQuota, /已用 35%/)
  assert.match(wrapperQuota, /额外用量/)
  assert.match(wrapperQuota, /12/)
  await orchestrator.sendMessage(session.id, '/context')
  await orchestrator.sendMessage(session.id, '/usage')
  const events = (orchestrator as any).events.get(session.id) as UAEvent[]
  assert.ok(events.some((event) => event.payload.kind === 'context_usage'), 'exact /context must query locally and publish its report')
  assert.ok(events.some((event) => event.payload.kind === 'usage_report'), 'exact /usage must publish a native session report')
  assert.equal(events.some((event) => event.type === 'turn_started' || event.payload.kind === 'usage'), false)
  assert.equal(session.status, 'idle')

  session.status = 'running'
  let liveQueries = 0
  ;(orchestrator as any).runners.set(session.id, { getClaudeContextUsage: async () => { liveQueries++; return context }, getClaudeUsage: async () => usage })
  await orchestrator.sendMessage(session.id, '/context')
  assert.equal(liveQueries, 1, 'a running session must query its existing native control channel')
  assert.equal(session.status, 'running')
  ;(orchestrator as any).runners.delete(session.id)

  const vite = await createServer({ root: process.cwd(), configFile: false, plugins: [{
    name: 'ssr-dom-sanitizer', enforce: 'pre',
    resolveId(id) { if (id === 'dompurify') return '\0dompurify-ssr-fixture' },
    load(id) { if (id === '\0dompurify-ssr-fixture') return 'export default {sanitize: (value) => value}' }
  }], ssr: { noExternal: ['dompurify'] }, resolve: { alias: { '@shared': resolve('src/shared') } },
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { EventStream } = await vite.ssrLoadModule('/src/renderer/components/EventStream.tsx')
    const markup = renderToStaticMarkup(React.createElement(EventStream, { events, status: 'idle', emptyMessage: '' }))
    assert.match(markup, /Claude 上下文/)
    assert.match(markup, /1,500/)
    assert.match(markup, /System prompt/)
    assert.match(markup, /Claude 会话用量/)
    assert.match(markup, /0\.1500/)
    assert.match(markup, /未返回订阅额度/)
    assert.doesNotMatch(markup, /本轮 · 输入/)
    console.log('Claude native reports: exact commands use live/local controls; reports render outside turn usage')
  } finally { await vite.close() }
} finally {
  orchestrator.disposeAll()
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
