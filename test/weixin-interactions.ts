import assert from 'node:assert/strict'
import { WeixinInteractions } from '../src/main/assistant/weixinInteractions'
import type { UAEvent } from '../src/shared/types'

const interactions = new WeixinInteractions()
const request = (id: string, kind = 'command', extra: object = {}): UAEvent => ({ sessionId: 'weixin', seq: 1, ts: 1, type: 'approval_request', state: 'pending', payload: { requestId: id, kind, method: 'item/commandExecution/requestApproval', params: { command: 'pnpm install' }, ...extra } })
const approval = request('approval-1')
const description = interactions.register(approval)!.join('\n')
const code = description.match(/[A-F0-9]{6}/)![0]
const submitted: any[] = []
const submit = async (answer: unknown) => { submitted.push(answer) }
assert.ok(description.includes('pnpm install'))
assert.equal(interactions.register(approval), undefined, 'repeated event must not duplicate prompts')
assert.equal(await interactions.receive('weixin', '分析项目', submit), undefined)
assert.match((await interactions.receive('feishu', `同意 ${code}`, submit))!.join('\n'), /不属于/)
assert.equal(submitted.length, 0)
assert.match((await interactions.receive('weixin', '同意', submit))!.join('\n'), /带编号/)
await interactions.receive('weixin', `同意 ${code}`, submit)
assert.deepEqual(submitted[0].answer, { decision: 'accept' })
assert.match((await interactions.receive('weixin', `同意 ${code}`, submit))!.join('\n'), /已处理/)
assert.equal(submitted.length, 1)

const question = request('questions', 'question', { method: 'item/tool/requestUserInput', params: { questions: [
  { id: 'directory', question: '使用哪个目录？', options: [{ label: '当前项目', description: '' }, { label: '新建目录', description: '' }] },
  { id: 'name', question: '项目名称？' }
] } })
const qcode = interactions.register(question)![0].match(/[A-F0-9]{6}/)![0]
const second = (await interactions.receive('weixin', `回答 ${qcode} 1`, submit))!
assert.match(second[1], /项目名称/)
assert.equal(submitted.length, 1, 'collect all fields before calling the provider')
await interactions.receive('weixin', `回答 ${second[1].match(/[A-F0-9]{6}/)![0]} 微信助手`, submit)
assert.deepEqual(submitted[1].answer, { answers: { directory: { answers: ['当前项目'] }, name: { answers: ['微信助手'] } } })

const acp = request('acp', 'command', { method: 'session/request_permission', options: [
  { optionId: 'allow', kind: 'allow_once', name: '允许一次' }, { optionId: 'deny', kind: 'reject_once', name: '拒绝' }
] })
const acode = interactions.register(acp)![0].match(/[A-F0-9]{6}/)![0]
await interactions.receive('weixin', `选择 ${acode} 2`, submit)
assert.deepEqual(submitted[2].answer, { outcome: { outcome: 'selected', optionId: 'deny' } })
const expired = request('expired')
const ecode = interactions.register(expired)![0].match(/[A-F0-9]{6}/)![0]
interactions.register({ ...expired, state: 'success' })
assert.match((await interactions.receive('weixin', `同意 ${ecode}`, submit))!.join('\n'), /失效/)
const secret = request('secret', 'elicitation', { params: { requestedSchema: { type: 'object', properties: { password: { type: 'string', format: 'password' } } } } })
assert.match(interactions.register(secret)![0], /敏感|桌面/)

const createQuestion = (id: string, questions: object[]) => {
  const handler = new WeixinInteractions()
  const description = handler.register(request(id, 'question', { method: 'item/tool/requestUserInput', params: { questions } }))!
  const answers: any[] = []
  return { handler, code: description[0].match(/[A-F0-9]{6}/)![0], messages: description, answers, submit: async (result: unknown) => { answers.push(result) } }
}
const options = [{ label: '当前项目' }, { label: '新建目录' }]
const numbered = createQuestion('numbered', [{ id: 'target', question: '使用哪个目录？', options }])
assert.equal(numbered.messages.length, 2, 'each question has a separate copyable message')
assert.equal(numbered.messages[1], `回答问题 ${numbered.code} 1`)
assert.match(numbered.messages[0], /复制下一条消息，修改序号。/)
await numbered.handler.receive('weixin', `回答问题 ${numbered.code.toLowerCase()} 2`, numbered.submit)
assert.deepEqual(numbered.answers[0]?.answer, { answers: { target: { answers: ['新建目录'] } } }, 'the new command selects the numbered option')

const supplement = createQuestion('supplement', [{ id: 'target', question: '使用哪个目录？', options, allowOther: true }])
await supplement.handler.receive('weixin', `回答问题 ${supplement.code} 2 在工作区旁创建，保留中文名称`, supplement.submit)
assert.deepEqual(supplement.answers[0]?.answer, { answers: { target: { answers: ['新建目录\n补充：在工作区旁创建，保留中文名称'] } } }, 'selection and supplemental text must both reach the Agent')

const freeText = createQuestion('free-text', [{ id: 'name', question: '项目名称？' }])
assert.equal(freeText.messages[1], `回答问题 ${freeText.code}`, 'a text template contains neither an option number nor a content placeholder')
assert.match(freeText.messages[0], /在编号后填写回答/)
await freeText.handler.receive('weixin', `回答问题 ${freeText.code}`, freeText.submit)
assert.equal(freeText.answers.length, 0, 'copying a text template without an answer cannot submit an empty field')
await freeText.handler.receive('weixin', `回答问题 ${freeText.code} 2026 年助手\n保留数字、标点，和换行`, freeText.submit)
assert.deepEqual(freeText.answers[0]?.answer, { answers: { name: { answers: ['2026 年助手\n保留数字、标点，和换行'] } } }, 'a text question never treats its first number as an option')

const custom = createQuestion('custom', [{ id: 'target', question: '使用哪个目录？', options, allowOther: true }])
await custom.handler.receive('weixin', `回答问题 ${custom.code} 使用临时目录`, custom.submit)
assert.deepEqual(custom.answers[0]?.answer, { answers: { target: { answers: ['使用临时目录'] } } })

const invalid = createQuestion('invalid', [{ id: 'target', question: '使用哪个目录？', options, allowOther: true }])
for (const content of ['0', '3', '999 补充', '1,2', '1,']) {
  await invalid.handler.receive('weixin', `回答问题 ${invalid.code} ${content}`, invalid.submit)
  assert.equal(invalid.answers.length, 0, `invalid selection ${content} cannot silently become a custom answer`)
}
await invalid.handler.receive('weixin', `回答问题 ${invalid.code} 1`, invalid.submit)
assert.equal(invalid.answers.length, 1, 'invalid input leaves the question available for correction')

const strict = createQuestion('strict', [{ id: 'target', question: '使用哪个目录？', options }])
const unsupported = await strict.handler.receive('weixin', `回答问题 ${strict.code} 2 不能丢弃这段补充`, strict.submit)
assert.match(unsupported![0], /不能附加补充内容/)
assert.equal(strict.answers.length, 0, 'a native enum-only question cannot discard supplemental text or invent a value')
await strict.handler.receive('weixin', `回答问题 ${strict.code} 2`, strict.submit)
assert.equal(strict.answers.length, 1)

const multi = createQuestion('multi', [{ id: 'target', question: '使用哪些目录？', options, multiSelect: true, allowOther: true }])
assert.equal(multi.messages[1], `回答问题 ${multi.code} 1,2`)
await multi.handler.receive('weixin', `回答问题 ${multi.code} 1， 2 补充里有逗号，不能拆开`, multi.submit)
assert.deepEqual(multi.answers[0]?.answer, { answers: { target: { answers: ['当前项目', '新建目录\n补充：补充里有逗号，不能拆开'] } } })

const bounded = createQuestion('bounded', [{ id: 'target', question: '选两个目录', options, multiSelect: true, minItems: 2, maxItems: 2 }])
for (const content of ['1', '1,1', '1,2,1']) {
  await bounded.handler.receive('weixin', `回答问题 ${bounded.code} ${content}`, bounded.submit)
  assert.equal(bounded.answers.length, 0, 'selection bounds and duplicate checks still apply')
}
await bounded.handler.receive('weixin', bounded.messages[1], bounded.submit)
assert.deepEqual(bounded.answers[0]?.answer, { answers: { target: { answers: ['当前项目', '新建目录'] } } }, 'the generated multi-select example is a valid answer')

const boundedSupplement = createQuestion('bounded-supplement', [{ id: 'target', question: '选两个目录', options, multiSelect: true, allowOther: true, minItems: 2, maxItems: 2 }])
await boundedSupplement.handler.receive('weixin', `回答问题 ${boundedSupplement.code} 1,2 都保留中文名称`, boundedSupplement.submit)
assert.deepEqual(boundedSupplement.answers[0]?.answer, { answers: { target: { answers: ['当前项目', '新建目录\n补充：都保留中文名称'] } } }, 'supplemental text must not be counted as another selection')

const verbatim = createQuestion('verbatim', [{ id: 'target', question: '使用哪个目录？', options }])
await verbatim.handler.receive('weixin', `回答问题 ${verbatim.code} 新建目录`, verbatim.submit)
assert.deepEqual(verbatim.answers[0]?.answer, { answers: { target: { answers: ['新建目录'] } } })

const sequential = createQuestion('sequential', [
  { id: 'target', question: '使用哪个目录？', options }, { id: 'name', question: '项目名称？' }
])
const nextDescription = (await sequential.handler.receive('weixin', `回答问题 ${sequential.code} 1`, sequential.submit))!
const nextCode = nextDescription[1].match(/[A-F0-9]{6}/)![0]
assert.notEqual(nextCode, sequential.code, 'each question has its own code, including fields in the same native request')
await sequential.handler.receive('weixin', `回答问题 ${sequential.code} 2`, sequential.submit)
assert.equal(sequential.answers.length, 0, 're-sending the previous question cannot answer the next one')
await sequential.handler.receive('weixin', `回答问题 ${nextCode} 独立问题`, sequential.submit)
assert.deepEqual(sequential.answers[0]?.answer, { answers: { target: { answers: ['当前项目'] }, name: { answers: ['独立问题'] } } })

const retry = createQuestion('retry', [{ id: 'name', question: '项目名称？' }])
await assert.rejects(retry.handler.receive('weixin', `回答问题 ${retry.code} 测试`, async () => { throw new Error('provider unavailable') }), /provider unavailable/)
await retry.handler.receive('weixin', `回答问题 ${retry.code} 测试`, retry.submit)
assert.equal(retry.answers.length, 1, 'failed submission keeps the original request available')

for (const [kind, method, params, expected] of [
  ['question', '_x.ai/ask_user_question', { questions: [{ question: '目录？', options, allowOther: true }] }, { outcome: 'accepted', answers: { '目录？': ['新建目录\n补充：保留中文'] } }],
  ['question', '_uniagent/ask_user_question', { questions: [{ id: 'target', question: '目录？', options, allowOther: true }] }, { answers: [{ id: 'target', selected: [], custom: '新建目录\n补充：保留中文' }] }],
  ['question', 'zcode/userInput', { freeText: true, questions: [{ question: '目录？', options: [{ label: '当前项目', value: 'current' }, { label: '新建目录', value: 'new' }] }] }, { action: 'accept', content: { answers: { '目录？': '新建目录\n补充：保留中文' } } }],
  ['elicitation', 'elicitation/create', { requestedSchema: { type: 'object', properties: { target: { type: 'string', enum: ['current', 'new'] } }, required: ['target'] } }, { action: 'accept', content: { target: 'new' } }]
] as const) {
  const handler = new WeixinInteractions()
  const description = handler.register(request(method, kind, { method, params }))!
  const code = description[0].match(/[A-F0-9]{6}/)![0]
  let answer: unknown
  await handler.receive('weixin', `回答问题 ${code} 2${kind === 'elicitation' ? '' : ' 保留中文'}`, async result => { answer = result.answer })
  assert.deepEqual(answer, expected, `preserve the native answer schema for ${method}`)
}
const grokBounds = new WeixinInteractions()
const grokDescription = grokBounds.register(request('grok-bounds', 'question', { method: '_x.ai/ask_user_question', params: {
  questions: [{ question: '选两个目录', options, multiSelect: true, minItems: 2, maxItems: 2 }]
} }))!
const grokCode = grokDescription[0].match(/[A-F0-9]{6}/)![0]
let grokSubmissions = 0
const grokSubmit = async () => { grokSubmissions++ }
assert.match((await grokBounds.receive('weixin', `回答问题 ${grokCode} 1`, grokSubmit))![0], /选项数量/)
assert.equal(grokSubmissions, 0, 'a codec-side validation failure must return guidance without losing the question')
await grokBounds.receive('weixin', grokDescription[1], grokSubmit)
assert.equal(grokSubmissions, 1)
console.log('weixin-interactions: numbered replies, supplemental text, free text, per-question codes, native constraints, isolation and retry passed')
