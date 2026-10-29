// 需求（飞书新话题配置卡片）— when a user starts a new topic the bot replies a
// config card so they can pick 运行目录/Agent/模型/推理强度 before the session is
// created. This exercises the two pure helpers end to end:
//  1. topicConfigCard renders JSON-2.0 STANDALONE selects (not a form) with a
//     preselected workdir/agent and — because the agent has modelSelect +
//     reasoningEffort — model + effort selects; each select fires its own callback,
//  2. an agent WITHOUT model/effort capability drops those selects,
//  3. stripMentions removes the @_user_N / @_all placeholders a群@ injects.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// feishuBridge.ts imports electron/@larksuiteoapi; transpile ONLY the two pure
// helpers, shared model choices and a tiny clip + EFFORT_LABEL stub.
const bridge = readFileSync(new URL('../src/main/feishuBridge.ts', import.meta.url), 'utf8')
const choices = readFileSync(new URL('../src/shared/agentChoices.ts', import.meta.url), 'utf8')
const grab = (marker, endMarker) => {
  const s = bridge.indexOf(marker)
  const e = bridge.indexOf(endMarker, s)
  assert.ok(s > 0 && e > s, `could not locate ${marker}`)
  return bridge.slice(s, e)
}
const cardSrc = grab('export function topicConfigCard', '\n/** 需求3 — map a form_value')
const stub = `
function clip(t, max = 3500){return t.length>max?t.slice(0,max-1)+'…':t}
function sanitizeProgressMarkdown(t){return t}
function oneLine(t, max){return clip(t.replace(/\\s+/g,' '),max)}
function formatElapsed(ms){return Math.floor(ms/1000)+' 秒'}
const EFFORT_LABEL = { low:'低', medium:'中', high:'高', xhigh:'极高', max:'最大', ultra:'Ultra' }
`
const js = ts.transpileModule(
  stub + choices + cardSrc + '\nexport { topicConfigCard, stripMentions }',
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
).outputText
const { topicConfigCard, stripMentions } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
)

const codex = {
  id: 'codex', name: 'Codex', adapter: 'codex',
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
  defaultModel: 'gpt-5', models: [
    { id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'] },
    { id: 'o3', label: 'o3', efforts: ['medium'] }
  ]
}
const plain = {
  id: 'plain', name: 'Plain', adapter: 'generic',
  capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] },
  models: []
}

// ---- full card: project + agent + model + effort, all preselected ----
const sel = { projectId: '/Users/me/Proj', agentId: 'codex', model: 'gpt-5', effort: 'high' }
const requirements = [{ id: 'req-active', name: '飞书接入', status: 'active' }, { id: 'req-done', name: '已完成需求', status: 'done' }]
const teams = [{ id: 'team-1', name: '专家团一号' }]
const card = topicConfigCard('topic_1', { ...sel, executor: 'agent', requirementId: 'req-active' }, [codex, plain], ['/Users/me/Proj', '/tmp'], requirements, teams)
assert.equal(card.schema, '2.0', 'JSON 2.0 card so standalone selects can carry inline callbacks')
assert.equal(card.config?.update_multi, true, 'update_multi so the locked card can replace this 2.0 card')
// Selects are standalone (NOT inside a form) so each fires its callback on change.
assert.ok(!card.body.elements.some((e) => e.tag === 'form'), 'no form container — selects must fire per-change callbacks')
const byName = Object.fromEntries(card.body.elements.filter((e) => e.name).map((e) => [e.name, e]))
assert.ok(byName.projectId && byName.requirementId && byName.executor && byName.agentId && byName.model && byName.effort, 'project/requirement/executor and Agent selects rendered')
assert.equal(byName.projectId.initial_option, '/Users/me/Proj', 'project preselected from selection')
assert.equal(byName.requirementId.initial_option, 'req-active', 'requirement preselected from selection')
assert.deepEqual(byName.requirementId.options.map((o) => o.value), ['__none__', 'req-active', 'req-done'], 'requirement supports none, active and done')
assert.deepEqual(byName.executor.options.map((o) => o.value), ['agent', 'team'], 'executor switches between one Agent and a team')
assert.equal(byName.agentId.initial_option, 'codex', 'agent preselected from selection')
assert.equal(byName.model.initial_option, 'gpt-5', 'model preselected from selection')
assert.equal(byName.effort.initial_option, 'high', 'effort preselected from selection')
assert.deepEqual(byName.effort.options.map((o) => o.value), ['low', 'high'], 'effort options follow the chosen model')
assert.equal(byName.agentId.behaviors[0].value.act, 'agentChange', 'agent select re-renders the card (dynamic linkage)')
assert.equal(byName.model.behaviors[0].value.act, 'setModel', 'model select merges its own value on change')
assert.equal(byName.projectId.behaviors[0].value.act, 'setProject', 'project select merges its own value on change')
assert.equal(byName.projectId.behaviors[0].value.topicId, 'topic_1', 'callbacks carry the topic id')
const submit = card.body.elements.find((e) => e.tag === 'button')
assert.ok(submit && submit.behaviors[0].value.act === 'startTopic' && !submit.form_action_type, '开始 is a plain callback button (no form submit)')
assert.deepEqual(byName.projectId.options.map((o) => o.value), ['/Users/me/Proj', '/tmp'], 'project options = recent dirs')

// ---- an agent without model/effort capability drops those selects ----
const plainCard = topicConfigCard('topic_2', { projectId: '/w', executor: 'agent', agentId: 'plain' }, [plain, codex], ['/w'])
const plainNames = plainCard.body.elements.filter((e) => e.name).map((e) => e.name)
assert.ok(plainNames.includes('projectId') && plainNames.includes('agentId'), 'project + agent always render')
assert.ok(!plainNames.includes('model') && !plainNames.includes('effort'), 'no model/effort select for a plain agent')

// ---- team mode swaps all Agent-specific fields for one team selector ----
const teamCard = topicConfigCard('topic_3', { projectId: '/w', executor: 'team', agentId: 'codex', teamId: 'team-1' }, [codex], ['/w'], requirements, teams)
const teamNames = teamCard.body.elements.filter((e) => e.name).map((e) => e.name)
assert.ok(teamNames.includes('requirementId') && teamNames.includes('executor') && teamNames.includes('teamId'))
assert.ok(!teamNames.includes('agentId') && !teamNames.includes('model') && !teamNames.includes('effort'), 'team mode hides Agent-only fields')
assert.equal(teamCard.body.elements.find((e) => e.name === 'teamId').initial_option, 'team-1')

// ---- stripMentions clears the @ placeholders a群@ injects ----
assert.equal(stripMentions('@_user_1  跑一下测试'), '跑一下测试', 'strip a single user mention')
assert.equal(stripMentions('@_all @_user_2 hi'), 'hi', 'strip @_all + user mentions')
assert.equal(stripMentions('  普通消息  '), '普通消息', 'plain text is just trimmed')

console.log('feishu-topic-card: ok')
