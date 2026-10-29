// 需求3(问题卡片多问题渲染) — unit coverage for normalizeQuestions / encodeAnswer.
// These pure functions are the contract the ApprovalCard question/elicitation
// form is built on: they must handle codex/traex multi-question requests and MCP
// elicitation schemas (single + multi + text), keep option labels byte-for-byte
// in the reply, and never fabricate protocol fields.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// The helpers now live in a pure `.ts` module (shared by the renderer AND the
// Feishu bridge); transpile the whole file and exercise it headless.
const source = readFileSync(new URL('../src/shared/questions.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const { normalizeQuestions, encodeAnswer } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
)

// ---- codex / traex: multiple single-select questions with options + isOther ----
const codexParams = {
  questions: [
    {
      id: 'color',
      header: '主色',
      prompt: '选择主题主色？',
      options: [
        { label: '蓝色（推荐）', description: '默认' },
        { label: '绿色' }
      ]
    },
    { id: 'name', prompt: '项目名称？' },
    {
      id: 'framework',
      prompt: '框架？',
      isOther: true,
      options: [{ label: 'React' }, { label: 'Vue' }]
    },
    { id: 'token', prompt: 'API Token？', isSecret: true }
  ]
}
const codexFields = normalizeQuestions('question', codexParams)
assert.equal(codexFields.length, 4, 'every question must produce a field, not just the first')
assert.equal(codexFields[0].type, 'single')
assert.equal(codexFields[0].options[0].label, '蓝色（推荐）', 'recommended suffix kept byte-for-byte')
assert.equal(codexFields[1].type, 'text', 'a question without options degrades to text')
assert.equal(codexFields[2].allowOther, true, 'isOther enables the 其他 free-text choice')
assert.equal(codexFields[3].secret, true, 'isSecret marks the field secret')

const codexReply = encodeAnswer('question', codexFields, {
  color: { choice: ['蓝色（推荐）'], text: '', other: '' },
  name: { choice: [], text: 'UniAgent', other: '' },
  framework: { choice: ['__other__'], text: '', other: 'Svelte' },
  token: { choice: [], text: 's3cr3t' }
})
assert.deepEqual(
  codexReply,
  {
    answers: {
      color: { answers: ['蓝色（推荐）'] },
      name: { answers: ['UniAgent'] },
      framework: { answers: ['Svelte'] },
      token: { answers: ['s3cr3t'] }
    }
  },
  'codex reply keeps the {answers:{[id]:{answers:[label]}}} shape; 其他 uses the typed text'
)

// ---- codex: a question with multiSelect:true maps to a multi (checkbox) field ----
const codexMultiFields = normalizeQuestions('question', {
  questions: [
    {
      id: 'langs',
      header: '语言',
      question: '挑选你熟悉的语言（可多选）',
      multiSelect: true,
      options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Go' }]
    },
    { id: 'style', question: '风格？', options: [{ label: '函数式' }, { label: '面向对象' }] }
  ]
})
assert.equal(codexMultiFields[0].type, 'multi', 'multiSelect:true → multi (checkbox) field')
assert.equal(codexMultiFields[1].type, 'single', 'a question without multiSelect stays single')
const codexMultiReply = encodeAnswer('question', codexMultiFields, {
  langs: { choice: ['TypeScript', 'Rust'], text: '', other: '' },
  style: { choice: ['函数式'], text: '', other: '' }
})
assert.deepEqual(
  codexMultiReply,
  { answers: { langs: { answers: ['TypeScript', 'Rust'] }, style: { answers: ['函数式'] } } },
  'multi reply carries every picked label'
)

// ---- MCP elicitation: single (enum), multi (array enum, maxItems>1), text ----
const elicitParams = {
  message: '请补充信息',
  requestedSchema: {
    type: 'object',
    required: ['env', 'tags'],
    properties: {
      env: {
        title: '环境',
        description: '部署到哪个环境？',
        enum: ['dev', 'prod'],
        enumNames: ['开发', '生产']
      },
      tags: {
        title: '标签',
        type: 'array',
        items: { enum: ['a', 'b', 'c'] },
        minItems: 1,
        maxItems: 2
      },
      note: { title: '备注', type: 'string' }
    }
  }
}
const elicitFields = normalizeQuestions('elicitation', elicitParams)
assert.equal(elicitFields.length, 3)
const [envF, tagsF, noteF] = elicitFields
assert.equal(envF.type, 'single')
assert.deepEqual(envF.options.map((o) => o.label), ['开发', '生产'], 'enumNames label the enum values')
assert.equal(envF.options[0].value, 'dev', 'value stays the raw enum member')
assert.equal(tagsF.type, 'multi')
assert.equal(tagsF.minItems, 1)
assert.equal(tagsF.maxItems, 2)
assert.equal(noteF.type, 'text')

const elicitReply = encodeAnswer('elicitation', elicitFields, {
  env: { choice: ['dev'], text: '', other: '' },
  tags: { choice: ['a', 'c'], text: '', other: '' },
  note: { choice: [], text: 'ok', other: '' }
})
assert.deepEqual(
  elicitReply,
  { action: 'accept', content: { env: 'dev', tags: ['a', 'c'], note: 'ok' } },
  'elicitation accept sends raw enum value for single, array for multi, string for text'
)

// oneOf composite → single
const oneOfFields = normalizeQuestions('elicitation', {
  requestedSchema: {
    properties: {
      mode: {
        title: '模式',
        oneOf: [
          { const: 'fast', title: '快速', description: '更快' },
          { const: 'safe', title: '安全' }
        ]
      }
    }
  }
})
assert.equal(oneOfFields[0].type, 'single')
assert.deepEqual(oneOfFields[0].options.map((o) => o.value), ['fast', 'safe'])
assert.equal(oneOfFields[0].options[0].label, '快速')

// ---- fallback: no questions, no schema → one free-text field (legacy shape) ----
const fallback = normalizeQuestions('question', { prompt: '随便说点什么' })
assert.equal(fallback.length, 1)
assert.equal(fallback[0].type, 'text')
assert.deepEqual(encodeAnswer('question', fallback, { q0: { choice: [], text: 'hi', other: '' } }), {
  answers: { q0: { answers: ['hi'] } }
})

console.log('question-normalize: ok')
