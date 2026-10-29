import assert from 'node:assert/strict'
import { parseAssistantCommand, parseAssistantSnapshot, assistantIdentity } from '../src/shared/assistant'
import { assistantPrompt, configureAssistantContext, stripAssistantContext } from '../src/main/assistant/context'
import { compileSearch, searchTokens } from '../src/main/assistant/search'
import { appendFeishuContext } from '../src/shared/feishuContext'
import { appendWeixinContext } from '../src/shared/weixin'

assert.equal(parseAssistantCommand(' /clear '), 'clear')
assert.equal(parseAssistantCommand('/new feature'), undefined)
assert.equal(parseAssistantSnapshot({ assistantId: 'other', soul: '', soulRevision: 1, workingRules: '', workingRulesRevision: 1 }), undefined)
const snapshot = parseAssistantSnapshot({ assistantId: 'personal', soul: '简洁表达', soulRevision: 1, workingRules: '行动前明确任务范围', workingRulesRevision: 1 })!
assert.ok(assistantIdentity(snapshot).includes('简洁表达'))
assert.ok(assistantIdentity(snapshot).includes('行动前明确任务范围'))
assert.ok(assistantIdentity(snapshot).includes('只有实际完成的工作才能称为完成'))
assert.equal(assistantIdentity(undefined), '')
const config = { agentId: 'codex', workdir: '/Users/example', assistantSnapshot: snapshot }
configureAssistantContext(async () => [{ assistantId: 'personal', type: 'user', content: '喜欢中文', revision: 7, updatedAt: 1, updatedBy: 'user' }])
const prompt = await assistantPrompt('s_1', config, '原始输入')
assert.equal(stripAssistantContext(prompt), '原始输入')
assert.equal(stripAssistantContext(await assistantPrompt('s_1', config, '原始输入', '工作区约束')), '原始输入')
assert.ok(prompt.includes('"revision":7'))
assert.ok(prompt.includes('"workdir":"/Users/example"'))
assert.ok(prompt.includes('"channel":"app"'))
const nativePrompt = await assistantPrompt('s_1', config, '原生输入', '', false)
assert.ok(!nativePrompt.includes('简洁表达'))
assert.ok(nativePrompt.includes('"revision":7'))
assert.equal(stripAssistantContext(nativePrompt), '原生输入')
const feishuInput = appendFeishuContext('飞书输入')
assert.ok((await assistantPrompt('s_1', config, feishuInput)).includes('"channel":"feishu"'))
assert.equal(stripAssistantContext(await assistantPrompt('s_1', config, feishuInput)), feishuInput)
const weixinInput = appendWeixinContext('微信输入')
assert.ok((await assistantPrompt('s_1', config, weixinInput)).includes('"channel":"weixin"'))
assert.equal(stripAssistantContext(await assistantPrompt('s_1', config, weixinInput)), weixinInput)
assert.equal(stripAssistantContext('你是用户在 UniAgent 中的个人助手。旧版提示\n\n当前用户输入：\n旧输入'), '旧输入')
assert.equal(await assistantPrompt('s_2', { agentId: 'codex', workdir: '' }, '普通对话'), '普通对话')
assert.match(compileSearch('"待办 提醒"'), /^"/)
assert.notDeepEqual(searchTokens('c4f60'), searchTokens('你'))
