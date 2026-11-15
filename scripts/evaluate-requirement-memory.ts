import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { RequirementStore } from '../src/main/requirementStore'
import { RequirementDistiller } from '../src/main/requirementDistiller'
import { extractRequirementText } from '../src/main/requirementExtractionRuntime'
import { configureRequirementRuntime, prepareRequirementTurn, setRequirementsEnabled } from '../src/main/requirementRuntime'
import { stripAssistantContext } from '../src/main/assistant/context'
import { AppServerRpcClient } from '../src/main/appServerTransport'
import { redactRequirementText } from '../src/main/requirementSpace'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'

// Explicit live evaluation: real requirement snapshot and completed native conversation excerpts.
// It writes only the isolated replay directory and the requested evidence report.
const id = process.env.UA_MEMORY_REQUIREMENT_ID || '2de4e0ab-3262-4698-ad3b-c9f69d7f678f'
const sourceHome = process.env.UA_MEMORY_SOURCE_HOME || join(homedir(), '.uniagent-public')
const nativeFile = process.env.UA_MEMORY_NATIVE_FILE
assert.ok(nativeFile, 'UA_MEMORY_NATIVE_FILE must identify the source conversation')
const output = resolve(process.env.UA_MEMORY_REPORT || 'out/requirement-memory-evaluation.json')
const original = JSON.parse(await readFile(join(sourceHome, 'requirements.json'), 'utf8')).find((row: any) => row.id === id)
assert.ok(original, 'real requirement must exist')
const beforeManifest = await readFile(join(original.dir, '.uniagent-public/manifest.json'), 'utf8')
const { revision } = JSON.parse(beforeManifest)
const originalSnapshot = await readFile(join(original.dir, '.uniagent-public/revisions', revision + '.json'), 'utf8')
const manifest = JSON.parse(originalSnapshot)
const scratch = await mkdtemp(join(tmpdir(), 'ua-memory-real-data-'))
const home = join(scratch, 'data'), dir = join(home, 'requirements', original.name)
await mkdir(join(dir, '.uniagent-public/bodies'), { recursive: true })
await mkdir(join(dir, '.uniagent-public/revisions'), { recursive: true })
await writeFile(join(dir, '.uniagent-public/manifest.json'), beforeManifest)
await writeFile(join(dir, '.uniagent-public/revisions', revision + '.json'), originalSnapshot)
for (const hash of new Set(Object.values(manifest.documents).map((doc: any) => doc.contentHash).filter(Boolean)))
  await copyFile(join(original.dir, '.uniagent-public/bodies', hash + '.md'), join(dir, '.uniagent-public/bodies', hash + '.md'))
for (const file of ['reading.json', 'reading-status.json', 'sync.json'])
  await copyFile(join(original.dir, '.uniagent-public', file), join(dir, '.uniagent-public', file)).catch((error: any) => { if (error.code !== 'ENOENT') throw error })
const requirement = { ...original, dir, docPath: join(dir, 'context.md') }
await writeFile(join(home, 'requirements.json'), JSON.stringify([requirement]))
const rows = (await readFile(nativeFile!, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const messages = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'message').map(row => ({
  role: row.payload.role, channel: row.payload.channel || row.payload.phase, ts: Date.parse(row.timestamp),
  text: stripAssistantContext((row.payload.content || []).map((part: any) => part.text || '').join('\n')).split('<uniagent_feishu_context>')[0].trim()
}))
const userTexts = messages.filter(row => row.role === 'user').map(row => ({ ...row, text: row.text.includes('当前用户输入：') ? row.text.slice(row.text.lastIndexOf('当前用户输入：') + 8).trim() : row.text }))
const goals = userTexts.filter(row => row.text.includes('可持续补充的上下文空间') || row.text.includes('routerAgent 那边使用') || row.text.includes('确认，开始优化'))
const reportText = messages.filter(row => row.role === 'assistant' && ['final', 'final_answer'].includes(row.channel) && row.text.includes('shared-memory-review')).at(-1)
assert.ok(goals.length >= 2 && reportText, 'real completed product-goal discussion and design delivery report must be present')
const inputs: Record<string, UAEvent[]> = {
  'source-goals': goals.map((row, index) => ({ sessionId: 'source-goals', seq: index, ts: row.ts, type: 'user_message', payload: { text: row.text } })),
  'source-delivery': [{ sessionId: 'source-delivery', seq: 0, ts: reportText.ts - 1, type: 'user_message', payload: { text: '整理本次设计交付记录，供后续会话查阅。' } },
    { sessionId: 'source-delivery', seq: 1, ts: reportText.ts, type: 'agent_message', payload: { text: reportText.text } }]
}
const sessions = new Map<string, Session>()
const store = new RequirementStore(home)
store.configureContext({ events: async sid => inputs[sid] || [], requirementId: () => id, workdir: () => scratch })
const agent = { id: 'codex', adapter: 'codex', bin: execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim(), installed: true } as AgentDef
const config = { agentId: 'codex', model: process.env.UA_MEMORY_MODEL || 'gpt-6.1-sol', workdir: scratch, requirementId: id, permissionMode: 'full-access' as const }
const report: any = { schemaVersion: 1, startedAt: new Date().toISOString(), requirement: original.name, sourceRevision: revision,
  realDocuments: Object.keys(manifest.documents).length, fixtureNotice: '原资料按当前快照复制；对话摘录在隔离 Session 中重放，序号是测试重建身份，非生产会话序号。交付记录为 Agent 报告。',
  dataHome: home, requirementId: id, results: [], modelCalls: 0, productDataModified: false }
await mkdir(resolve(output, '..'), { recursive: true })
const save = () => writeFile(output, JSON.stringify(report, null, 2))
const pass = (name: string, actual: any) => { report.results.push({ name, passed: true, actual }); console.log('PASS ' + name); return save() }
const generate = async (prompt: string, signal: AbortSignal) => {
  const call: { stage: string; inputChars: number; startedAt: number; elapsedMs: number; output?: string } = { stage: prompt.startsWith('你是需求阅读') ? 'overview' : prompt.startsWith('你是需求资料') ? 'extraction' : 'consumer', inputChars: prompt.length, startedAt: Date.now(), elapsedMs: 0 }
  report.calls ||= []; report.calls.push(call); report.modelCalls++; await save()
  try { const output = await extractRequirementText(agent, config, prompt, signal, options => {
    const rpc = new AppServerRpcClient(options)
    rpc.on('notification', (method: string, params: any) => {
      if (method === 'error') { report.protocolErrors ||= []; report.protocolErrors.push(redactRequirementText(String(params?.error?.message || params?.message || 'unknown protocol error')).slice(0, 1000)) }
    })
    return rpc
  }, { timeoutMs: 180000, maxOutputChars: 25000, effort: 'low' }); call.output = redactRequirementText(output); return output }
  finally { call.elapsedMs = Date.now() - call.startedAt; await save() }
}
const worker = new RequirementDistiller(store, { session: sid => sessions.get(sid), unsupported: () => undefined,
  extract: (_s, prompt, signal) => generate(prompt, signal), summarize: (_s, prompt, signal) => generate(prompt, signal), report: (_sid, message) => { report.errors ||= []; report.errors.push(message) } })
try {
  setRequirementsEnabled(true)
  const baseline = await store.context(id, 'consumer', { action: 'bootstrap', query: '跨 Session 共享记忆与 Router' })
  report.baseline = { memories: baseline.memories.items, readingStatus: baseline.readingStatus }
  configureRequirementRuntime(sid => sessions.get(sid), (sid, request) => store.context(id, sid, request))
  const consumer = { id: 'consumer', nativeSessionId: 'native-consumer', status: 'idle', config } as Session
  sessions.set(consumer.id, consumer)
  const initial = prepareRequirementTurn(consumer, '需求当前是什么情况？'); await initial.ready; initial.complete()
  for (const [sid, events] of Object.entries(inputs)) {
    sessions.set(sid, { id: sid, status: 'idle', config } as Session)
    await store.recordInput(id, events[0])
    await store.finishTurn(id, { sessionId: sid, seq: events.at(-1)!.seq + 1, ts: events.at(-1)!.ts, type: 'turn_completed', state: 'success', payload: {} })
    worker.schedule(id, sid); await worker.flush(id)
    console.log('EXTRACTED ' + sid)
  }
  const overview = await store.readOverview(id)
  report.overview = overview
  const catalog = await store.context(id, consumer.id, { action: 'read', query: 'Session Router', limit: 100 })
  const shared = catalog.documents.filter((doc: any) => doc.memory)
  assert.ok(shared.some((doc: any) => doc.memory.basis === 'user'))
  const reports = (await store.context(id, consumer.id, { action: 'read', query: '设计 交付', limit: 100 })).documents.filter((doc: any) => doc.memory?.basis === 'agent')
  assert.ok(reports.length, 'a new Session can discover the prior design report')
  assert.ok(reports.every((doc: any) => doc.status === 'draft'))
  const prepared = prepareRequirementTurn(consumer, '需求上下文最重要的目标和三类使用者是什么？之前的设计交付代表已经实施了吗？')
  const prompt = await prepared.ready; prepared.complete()
  report.consumerPrompt = prompt
  assert.ok(prompt.includes('"contextKind":"changes"'))
  assert.ok(Buffer.byteLength(prompt) < 18000)
  const answer = await generate(prompt + '\n\n只依据已提供资料回答，不能调用工具。返回 JSON：{primaryGoal:string,consumers:string[],priorChanges:string[],unverified:string[],startAuthorization:"confirmed"|"pending"|"unknown"}；startAuthorization 仅说明此前用户是否明确要求开始本轮优化，不代表功能验收或当前会话执行授权。不知道的保持未知。', AbortSignal.timeout(180000))
  report.consumerAnswer = JSON.parse(answer.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim())
  assert.match(report.consumerAnswer.primaryGoal, /Session|会话/i)
  assert.ok(report.consumerAnswer.consumers.some((text: string) => /Router/i.test(text)))
  assert.ok(report.consumerAnswer.consumers.some((text: string) => /用户|人类|^人[：:]|human|reader|user/i.test(text)))
  assert.ok(report.consumerAnswer.consumers.some((text: string) => !/router/i.test(text) && /执行|Session|智能体|agent/i.test(text)))
  assert.ok(report.consumerAnswer.unverified.length > 0)
  assert.equal(report.consumerAnswer.startAuthorization, 'confirmed', 'the later instruction to start optimization must survive the earlier pending-design delivery report')
  await pass('真实新模型会话继承目标、三类用途及未验证边界', report.consumerAnswer)
  assert.equal(overview.readingStatus, 'ready', JSON.stringify(report.errors || []))
  assert.ok(overview.reading!.topics?.length)
  assert.ok(overview.reading!.changes?.length)
  await pass('真实模型生成有依据的主题概览与重要变化', { topics: overview.reading!.topics, changes: overview.reading!.changes, coverage: overview.reading!.coverage })
  const topic = prepareRequirementTurn(consumer, 'Router 的需求归属与任务复用分别如何判断？'); const topicPrompt = await topic.ready; topic.complete()
  report.topicPrompt = topicPrompt
  assert.ok(topicPrompt.includes('"contextKind":"topic"'))
  await pass('真实资料下同版本切换主题能够补充入口', { bytes: Buffer.byteLength(topicPrompt) })
  const routing = await store.routingSources(id)
  assert.ok(!routing.documents.some(doc => reports.some((item: any) => item.id === doc.id)))
  await pass('Router 的有效归属来源排除新增报告与候选', { effectiveDocuments: routing.documents.length, excludedReports: reports.length })
  assert.equal(await readFile(join(original.dir, '.uniagent-public/manifest.json'), 'utf8'), beforeManifest)
  report.completedAt = new Date().toISOString(); report.passed = true
} catch (error) { report.passed = false; report.failure = String(error); throw error }
finally { worker.dispose(); setRequirementsEnabled(false); configureRequirementRuntime(() => undefined); await save(); console.log('REPORT ' + output); console.log('ISOLATED_DATA ' + home) }
