import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { generateRouterContext } from '../src/main/router/summary'
import { validateRoutingFragment } from '../src/main/requirementRouting'
import { loadRouterTokenizer } from '../src/main/router/tokenizer'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'
import type { AgentDef } from '../src/shared/types'

// Explicit native probe of the production background generator. It has no Router
// assignment bridge or business Task; the existing runtime denies tools.
const model = process.env.UA_ROUTER_EVAL_MODEL || 'ferry-deepseek-v4-1-flash'
const config = { ...DEFAULT_ROUTER_CONFIG, agentId: 'codex', model, effort: 'high' as const }
const agent = { id: 'codex', adapter: 'codex', bin: process.env.UA_ROUTER_EVAL_CODEX_BIN || 'codex', installed: true, name: 'Codex',
  models: [{ id: model, label: model, efforts: ['high'], imageInput: true }], capabilities: { startupSystemPrompt: true } } as AgentDef
const currentCore = process.env.UA_ROUTER_EVAL_CORE_FILE ? JSON.parse(await readFile(process.env.UA_ROUTER_EVAL_CORE_FILE, 'utf8')) : undefined
const text = currentCore?.document.content || '本需求承载结算工作流、对账文件导出和结算结果反馈。库存盘点不是本需求目标。结算工作流正在实现，用户尚未验收。'
const document = currentCore?.document || { id: 'core', kind: 'core' as const, title: '结算需求', content: text, contentHash: createHash('sha256').update(text).digest('hex'),
  status: 'active' as const, freshness: 'verified' as const, summary: '', sources: [], dependencies: [], updatedAt: 1 }
const report: any = { model, agentId: 'codex', startedAt: new Date().toISOString(), realBusinessDeliveries: 0, probes: [], errors: [] }
if (currentCore) report.material = { requirementId: currentCore.requirementId, revision: currentCore.revision, document }
const tokenizer = await loadRouterTokenizer()
try {
  for (const routing of [false, true]) {
    const prompt = routing ? '提取需求路由事实，只输出 JSON，features、exclusions、conflicts 为数组。features 每项为 {name,aliases,responsibility,ownershipRefs,implementation:{status,refs},acceptance:{status,refs}}。' +
      'name/aliases 必须逐字出现于原文，responsibility 非空。所有 refs 为 {documentId,documentHash,quote}，quote 必须是连续原文。implementation.status=unknown|planned|design|implementing|delivered，acceptance.status=unknown|pending|accepted；没有明确阶段证据用unknown及空refs。exclusions/conflicts 每项为{text,refs}。\n' +
      JSON.stringify(document) : '依据资料概括需求目标、功能范围与边界，不把进度当范围。只输出 JSON：{description,sourceRefs}，description 非空且最多500 token，sourceRefs仅使用资料ref。\n' +
      JSON.stringify({ ref: 'fixture:core', text })
    const started = Date.now()
    const output = await generateRouterContext([agent], config, prompt, new AbortController().signal, routing)
    const value = JSON.parse(output.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
    if (routing) validateRoutingFragment(value, document, { offset: 0, text })
    else if (typeof value.description !== 'string' || !value.description.trim() || tokenizer.count(value.description) > 500 ||
      !Array.isArray(value.sourceRefs) || !value.sourceRefs.length || value.sourceRefs.some((ref: string) => ref !== 'fixture:core')) throw Error('invalid_native_description')
    report.probes.push({ kind: routing ? 'routing-fragment' : 'description', output: value, durationMs: Date.now() - started, passed: true })
  }
} catch (error) { report.errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
finally {
  report.completedAt = new Date().toISOString()
  await writeFile(process.env.UA_ROUTER_EVAL_OUTPUT || 'out/router-system-native-generation.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ probes: report.probes.map((probe: any) => ({ kind: probe.kind, passed: probe.passed })), errors: report.errors, realBusinessDeliveries: 0 }))
}
