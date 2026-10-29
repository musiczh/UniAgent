// 需求3(飞书问题卡片) — the Feishu question card must let a user answer EVERY
// question (single-select dropdown, multi-select, and text) in ONE form and submit
// once. This verifies the card→form_value→encodeAnswer round-trip end to end:
//  1. normalizeQuestions parses a multi-question codex request (single + multi + other),
//  2. questionFormCard renders one interactive component per field inside a `form`,
//  3. collectFormValue maps a form_value callback back onto NormalizedField[],
//  4. encodeAnswer reconstructs the exact codex reply shape (labels kept byte-for-byte).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// feishuBridge.ts imports electron/@larksuiteoapi; transpile ONLY the two pure card
// helpers (questionFormCard + collectFormValue) plus a tiny clip stub, then exercise
// them against the real shared normalizeQuestions/encodeAnswer.
const bridge = readFileSync(new URL('../src/main/feishuBridge.ts', import.meta.url), 'utf8')
const grab = (marker, endMarker) => {
  const s = bridge.indexOf(marker)
  const e = bridge.indexOf(endMarker, s)
  assert.ok(s > 0 && e > s, `could not locate ${marker}`)
  return bridge.slice(s, e)
}
const cardSrc = grab('function questionFormCard', '\nfunction noteCard')
const shared = readFileSync(new URL('../src/shared/questions.ts', import.meta.url), 'utf8')
// Stitch: shared helpers + a clip/kindTitle stub + the two extracted card helpers, drop `export`.
const textAnswerSrc=grab('export function buildQuestionAnswer','\nfunction firstQuestionId')
const slice = `${shared}\nfunction clip(t, max = 3500){return t.length>max?t.slice(0,max-1)+'…':t}\nfunction kindTitle(k){return k}\n${cardSrc}\n${textAnswerSrc}`
  .replace(/export function collectFormValue/, 'function collectFormValue')
const js = ts.transpileModule(
  slice + '\nexport { normalizeQuestions, encodeAnswer, questionFormCard, collectFormValue }',
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
).outputText
const { normalizeQuestions, encodeAnswer, questionFormCard, collectFormValue, buildQuestionAnswer } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
)

// ---- codex: single-select + multi-select + text + 其他, in ONE request ----
const params = {
  questions: [
    { id: 'color', header: '主色', prompt: '选择主色？', options: [{ label: '蓝色（推荐）' }, { label: '绿色' }] },
    { id: 'langs', header: '语言', prompt: '会哪些？（可多选）', multiSelect: true, options: [{ label: 'TS' }, { label: 'Rust' }, { label: 'Go' }] },
    { id: 'framework', prompt: '框架？', isOther: true, options: [{ label: 'React' }] },
    { id: 'name', prompt: '项目名？' }
  ]
}
const fields = normalizeQuestions('question', params)
assert.equal(fields.length, 4, 'every question becomes a field (not just the first)')

const card = questionFormCard('question', 'req_1', 'sess_1', fields)
const form = card.body.elements[0]
assert.equal(form.tag, 'form', 'questions render inside a single form container')
const byTag = form.elements.map((e) => e.tag)
assert.ok(byTag.includes('select_static'), 'single-select → select_static dropdown')
assert.ok(byTag.includes('multi_select_static'), 'multi-select → multi_select_static')
assert.ok(byTag.filter((t) => t === 'input').length >= 2, 'text field + 其他 field render as inputs')
const submit = form.elements.find((e) => e.tag === 'button' && e.form_action_type === 'submit')
assert.ok(submit, 'a submit button drives the form')
assert.equal(submit.name, 'submitQuestion')
assert.deepEqual(submit.behaviors[0].value, {
  sessionId: 'sess_1', requestId: 'req_1', kind: 'question', act: 'submitQuestion', actLabel: '已回答'
}, 'submit carries routing context via a callback behavior (surfaced as action.value)')
// Each interactive component MUST have a unique name (else Feishu rejects the form).
const names = form.elements.filter((e) => e.name).map((e) => e.name)
assert.equal(new Set(names).size, names.length, 'every component name is unique')
// The single-select carries an 其他 option and its options keep labels byte-for-byte.
const colorSelect = form.elements.find((e) => e.tag === 'select_static')
assert.equal(colorSelect.options[0].value, '蓝色（推荐）', 'option value = normalized field value (label)')

// ---- simulate the form_value callback for a submit, then encode the reply ----
// single: string, multi: string[], 其他: OTHER sentinel + separate o-index text.
const formValue = {
  f0: '蓝色（推荐）',          // color single-select
  f1: ['TS', 'Go'],            // langs multi-select
  f2: '__other__',             // framework picked 其他
  o2: 'Svelte',                // 其他 text
  f3: 'UniAgent'               // name text
}
const collected = collectFormValue(fields, formValue)
const reply = encodeAnswer('question', fields, collected)
assert.deepEqual(reply, {
  answers: {
    color: { answers: ['蓝色（推荐）'] },
    langs: { answers: ['TS', 'Go'] },
    framework: { answers: ['Svelte'] },
    name: { answers: ['UniAgent'] }
  }
}, 'form submit reconstructs the codex reply for ALL questions (single, multi, 其他, text)')

// ---- MCP elicitation round-trip: single enum + multi array + text ----
const elicit = normalizeQuestions('elicitation', {
  requestedSchema: {
    required: ['env'],
    properties: {
      env: { title: '环境', enum: ['dev', 'prod'], enumNames: ['开发', '生产'] },
      tags: { title: '标签', type: 'array', items: { enum: ['a', 'b', 'c'] } },
      note: { title: '备注', type: 'string' }
    }
  }
})
const eForm = questionFormCard('elicitation', 'req_2', 'sess_2', elicit).body.elements[0]
assert.equal(eForm.elements.find((e) => e.tag === 'select_static').options[0].value, 'dev', 'elicitation option value stays the raw enum member')
const eReply = encodeAnswer('elicitation', elicit, collectFormValue(elicit, { f0: 'dev', f1: ['a', 'c'], f2: 'ok' }))
assert.deepEqual(eReply, { action: 'accept', content: { env: 'dev', tags: ['a', 'c'], note: 'ok' } })

const fullDetail='# Native implementation plan\n\n'+('Every requirement stays visible.\n'.repeat(180))+'FINAL_NATIVE_PLAN'
const deepseek=normalizeQuestions('deepseek',{questions:[{id:'plan',question:'Review the plan',detail:fullDetail,allowOther:true,options:[{label:'Approve plan'},{label:'Revise plan'}]}]})
const dForm=questionFormCard('deepseek','native-plan','deepseek-session',deepseek).body.elements[0]
const detailBlocks=dForm.elements.filter(element=>element.tag==='markdown').map(element=>element.content).join('')
assert.ok(detailBlocks.includes('FINAL_NATIVE_PLAN'),'Feishu must display the complete native Plan detail without truncation')
const nativeReply=encodeAnswer('deepseek',deepseek,collectFormValue(deepseek,{f0:'__other__',o0:'Approve plan'}))
assert.deepEqual(nativeReply,{answers:[{id:'plan',selected:[],custom:'Approve plan'}]},'Feishu Other matching plan approval stays custom in native array')
assert.deepEqual(buildQuestionAnswer({kind:'question',method:'_uniagent/ask_user_question',qid:'plan',fields:deepseek},'Approve plan'),nativeReply,'Feishu plain text equal to an approval label is custom, never selected')
assert.deepEqual(buildQuestionAnswer({kind:'question',method:'item/tool/requestUserInput',qid:'plan'},'Approve plan'),{answers:{plan:{answers:['Approve plan']}}},'legacy text reply shape remains unchanged')

const zcode = normalizeQuestions('zcode', { freeText: false, questions: [{ question: ' Exact question? ', options: [{ label: 'Shown label', value: 'opaque-value' }] }] })
const zcodeForm = questionFormCard('zcode', 'zcode-question', 'zcode-session', zcode)
assert.equal(zcodeForm.body.elements[0].elements.find(element => element.tag === 'select_static').options[0].value, 'opaque-value')
assert.equal(zcodeForm.body.elements[1].name, 'cancelQuestion')
const zcodeReply = { action: 'accept', content: { answers: { ' Exact question? ': 'opaque-value' } } }
assert.deepEqual(encodeAnswer('zcode', zcode, collectFormValue(zcode, { f0: 'opaque-value' })), zcodeReply)
assert.deepEqual(buildQuestionAnswer({ kind: 'question', method: 'zcode/userInput', fields: zcode }, 'Shown label'), zcodeReply, 'Feishu text replies preserve native option values')

console.log('feishu-question-card: ok')
