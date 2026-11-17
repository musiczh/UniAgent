import assert from 'node:assert/strict'
import { parseAssistantCommand, parseAssistantSnapshot, assistantIdentity } from '../src/shared/assistant'
import { prepareAssistantInitializationForSession, assistantInitialization, prepareAssistantMessage, configureAssistantContext, configureAssistantContextRuntime, queryAssistantContext, stripAssistantContext } from '../src/main/assistant/context'
import { compileSearch, searchTokens } from '../src/main/assistant/search'
import { appendFeishuContext } from '../src/shared/feishuContext'
import { appendWeixinContext } from '../src/shared/weixin'
import type { Session } from '../src/shared/types'

assert.equal(parseAssistantCommand(' /clear '), 'clear')
assert.equal(parseAssistantCommand('/new feature'), undefined)
assert.equal(parseAssistantSnapshot({ assistantId: 'other', soul: '', soulRevision: 1, workingRules: '', workingRulesRevision: 1 }), undefined)
const snapshot = parseAssistantSnapshot({ assistantId: 'personal', soul: '简洁表达', soulRevision: 1, workingRules: '行动前明确任务范围', workingRulesRevision: 1 })!
assert.ok(assistantIdentity(snapshot).includes('简洁表达'))
assert.ok(assistantIdentity(snapshot).includes('行动前明确任务范围'))
assert.ok(assistantIdentity(snapshot).includes('只有实际完成的工作才能称为完成'))
assert.equal(assistantIdentity(undefined), '')
const config = { agentId: 'codex', workdir: '/Users/example', assistantSnapshot: snapshot }
const session: Session = { id: 's_1', title: 'Assistant context', config, status: 'idle', createdAt: 1 }
configureAssistantContextRuntime(id => id === session.id ? session : undefined, () => {})
configureAssistantContext(async () => [{ assistantId: 'personal', type: 'user', content: '喜欢中文', revision: 7, updatedAt: 1, updatedBy: 'user' }])
await prepareAssistantInitializationForSession('s_1', config)
const context = assistantInitialization('s_1')
assert.ok(context.includes('"revision":7'))
assert.ok(context.includes('喜欢中文'))
assert.doesNotMatch(context, /"workspace"|"workdir"/)
const live = await queryAssistantContext('s_1', { action: 'context' }) as { workspace: { workdir: string; additionalDirectories: string[] }; agentId: string; assistantId: string; channel: string }
assert.equal(live.workspace.workdir, '/Users/example')
assert.deepEqual(live.workspace.additionalDirectories, [])
assert.equal(live.agentId, 'codex'); assert.equal(live.assistantId, 'personal'); assert.equal(live.channel, 'app')
assert.throws(() => queryAssistantContext('s_1', { action: 'context', sessionId: 'other' }), /context_only_accepts_action/)
await assert.rejects(queryAssistantContext('missing', { action: 'context' }), /context_session_not_found/)
const native = await prepareAssistantMessage('s_1', config, '原生输入')
assert.equal(native.text, '原生输入'); native.accepted()
const feishu = await prepareAssistantMessage('s_1', config, appendFeishuContext('飞书输入'))
assert.equal(feishu.text, '飞书输入'); assert.match(feishu.context!, /UniAgent App → 飞书/); feishu.accepted()
assert.equal((await queryAssistantContext('s_1', { action: 'context' }) as any).channel, 'feishu')
const weixin = await prepareAssistantMessage('s_1', config, appendWeixinContext('微信输入'))
assert.equal(weixin.text, '微信输入'); assert.match(weixin.context!, /飞书 → 微信/)
const pending = await queryAssistantContext('s_1', { action: 'context' }) as any
assert.equal(pending.channel, 'feishu'); assert.equal(pending.pendingChannel, 'weixin')
weixin.accepted()
assert.equal((await queryAssistantContext('s_1', { action: 'context' }) as any).channel, 'weixin')
const followup = await prepareAssistantMessage('s_1', config, appendWeixinContext('同通道原文'))
assert.equal(followup.text, '同通道原文'); assert.equal(followup.context, undefined); followup.accepted()
assert.equal(stripAssistantContext('你是用户在 UniAgent 中的个人助手。旧版提示\n\n当前用户输入：\n旧输入'), '旧输入')
assert.equal((await prepareAssistantMessage('s_2', { agentId: 'codex', workdir: '' }, '普通对话')).text, '普通对话')
assert.match(compileSearch('"待办 提醒"'), /^"/)
assert.notDeepEqual(searchTokens('c4f60'), searchTokens('你'))
configureAssistantContextRuntime(() => undefined, () => {})
configureAssistantContext(undefined)
