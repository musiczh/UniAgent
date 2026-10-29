import { createHash } from 'node:crypto'
import type { UAEvent } from '../../shared/types'
import { asInteractionRequest } from '../../shared/interactionRequests'
import { normalizeQuestions, questionAnswerKind, questionAnswerValues, encodeAnswer, validateQuestionAnswer, OTHER_VALUE, type NormalizedField } from '../../shared/questions'
import { buildDecisionAnswer } from '../../shared/approvalDecision'

type Collected = Record<string, { choice: string[]; text: string; other: string }>
interface Pending { event: UAEvent; code: string; fields: NormalizedField[]; collected: Collected; index: number }
export interface WeixinInteractionAnswer { requestId: string; answer: unknown; event: UAEvent; code: string }

const questionCode = (event: UAEvent, index = 0): string => createHash('sha256')
  .update(`${event.sessionId}/${event.payload.requestId}/${event.seq}${index ? '/' + index : ''}`).digest('hex').slice(0,6).toUpperCase()

/** Text commands are parsed by the host, never interpreted by the language model. */
export class WeixinInteractions {
  private pending = new Map<string, Pending>()
  register(raw: UAEvent): string[] | undefined {
    const event = asInteractionRequest(raw)
    if (event.type !== 'approval_request' || typeof event.payload.requestId !== 'string') return
    const key = `${event.sessionId}/${event.payload.requestId}`
    if (event.state !== 'pending' || event.payload.submittedAnswer !== undefined || event.payload.interactionExpired) {
      this.pending.delete(key)
      return
    }
    if (this.pending.has(key)) return
    const { kind, method, params } = event.payload
    const fields = ['question','elicitation'].includes(kind) ? normalizeQuestions(questionAnswerKind(kind, method), params) : []
    const pending = { event, fields, collected: {}, index: 0, code: questionCode(event) }
    this.pending.set(key, pending)
    return this.describe(pending)
  }
  clear(sessionId?: string): void {
    for (const [key, pending] of this.pending) if (!sessionId || pending.event.sessionId === sessionId) this.pending.delete(key)
  }
  settle(answer: WeixinInteractionAnswer): void { this.pending.delete(`${answer.event.sessionId}/${answer.requestId}`) }
  async receive(sessionId: string, text: string, submit: (answer: WeixinInteractionAnswer) => Promise<void>): Promise<string[] | undefined> {
    if (!/^(回答问题|同意|拒绝|回答|取消|选择)(?:\s|$)/.test(text)) return
    const match = /^(回答问题|同意|拒绝|回答|取消|选择)\s+([A-Fa-f0-9]{6})(?:\s+([\s\S]+))?$/.exec(text)
    if (!match) return ['请使用带编号的指令，例如「同意 A7B2C3」或「回答问题 A7B2C3 2」。']
    const [, rawAction, rawCode, content = ''] = match
    const action = rawAction === '回答问题' ? '回答' : rawAction
    const code = rawCode.toUpperCase()
    const pending = [...this.pending.values()].find(p => p.code === code && p.event.sessionId === sessionId)
    if (!pending) return [`请求 ${code} 已处理、已失效或不属于当前微信对话。`]
    const { event, fields } = pending
    const { kind, method, options } = event.payload
    let answer: unknown
    let receipt: string | undefined
    if (fields.length) {
      if (fields.some(field => field.secret)) return ['此问题包含敏感输入，请在 UniAgent 桌面端处理。']
      if (action !== '回答' || !content.trim()) return this.describe(pending)
      const field = fields[pending.index]
      let value: Collected[string]
      try { value = this.collect(field, content.trim()) }
      catch (error) { return [(error as Error).message, ...this.describe(pending)] }
      const collected = { ...pending.collected, [field.id]: value }
      const answerKind = questionAnswerKind(kind, method)
      let fieldAnswer: unknown
      try { fieldAnswer = encodeAnswer(answerKind, [field], collected); validateQuestionAnswer(answerKind, [field], fieldAnswer) }
      catch { return ['答案格式或选项数量不符合要求，请重新回答。', ...this.describe(pending)] }
      receipt = questionAnswerValues(answerKind, field, fieldAnswer).join('、')
      if (pending.index + 1 < fields.length) {
        pending.collected = collected; pending.index++
        pending.code = questionCode(event, pending.index)
        return [`已记录 ${code}：${receipt}`, ...this.describe(pending)]
      }
      answer = encodeAnswer(answerKind, fields, collected)
      try { validateQuestionAnswer(answerKind, fields, answer) } catch { return ['答案格式或选项数量不符合要求，请重新回答。', ...this.describe(pending)] }
    } else if (['question','elicitation'].includes(kind)) return ['此提问格式暂不支持文本回答，请在 UniAgent 桌面端处理。']
    else if (kind === 'planMode') {
      if (action === '同意') answer = { decision: 'approved' }
      else if (action === '取消' || action === '拒绝') answer = { decision: 'cancelled' }
      else if (action === '回答' && content.trim()) answer = { decision: 'rejected', feedback: content.trim() }
      else return this.describe(pending)
    } else if (method === 'session/request_permission' || method === 'zcode/permission') {
      const offered = Array.isArray(options) ? options : []
      let option = action === '选择' && /^\d+$/.test(content.trim()) ? offered[Number(content.trim()) - 1] : undefined
      if (action === '同意') option = offered.find(item => item.kind === 'allow_once')
      if (action === '拒绝') option = offered.find(item => item.kind === 'reject_once') || offered.find(item => item.kind === 'reject_always')
      if (action === '取消' && method === 'session/request_permission') answer = buildDecisionAnswer({ kind, method, act: 'cancel' })
      else if (option?.optionId) answer = buildDecisionAnswer({ kind, method, act: 'select', optionId: option.optionId })
      else return this.describe(pending)
    } else {
      if (!['同意','拒绝'].includes(action)) return this.describe(pending)
      answer = buildDecisionAnswer({ kind, method, act: action === '同意' ? 'accept' : 'decline' })
    }
    const result = { event, requestId: event.payload.requestId, answer, code }
    await submit(result)
    this.settle(result)
    return [receipt !== undefined ? `已提交 ${code}：${receipt}` : `已处理 ${code}。`]
  }
  private collect(field: NormalizedField, content: string): Collected[string] {
    if (field.type === 'text') return { choice: [], text: content, other: '' }
    const exact = field.options.find(option => option.label === content || option.value === content)
    if (exact) return { choice: [exact.value], text: '', other: '' }
    const numbered = /^(\d+(?:\s*[,，]\s*\d+)*)(?:\s+([\s\S]+))?$/.exec(content)
    const values = numbered ? numbered[1].split(/[,，]/).map(value => value.trim()) : field.type === 'multi' ? content.split(/[,，]/).map(value => value.trim()) : [content]
    if (!numbered && /^\d+(?:\s|[,，]|$)/.test(content)) throw new Error('序号格式不正确，多个序号请用逗号分隔。')
    if (numbered && field.type === 'single' && values.length > 1) throw new Error('此问题只能选择一个选项。')
    const choices: string[] = []
    const custom: string[] = []
    for (const value of values) {
      const option = numbered ? field.options[Number(value) - 1] : field.options.find(entry => entry.label === value || entry.value === value)
      if (option) choices.push(option.value)
      else if (numbered) throw new Error('选项序号超出范围，请使用题目中的序号。')
      else if (!field.allowOther) throw new Error('答案不在选项中，请填写选项序号。')
      else custom.push(value)
    }
    if (new Set(choices).size !== choices.length) throw new Error('选项序号重复，请每个选项只填写一次。')
    const supplement = numbered?.[2]?.trim()
    if (supplement) {
      if (!field.allowOther) throw new Error('此问题只接受提供的选项，不能附加补充内容。')
      // Native answers have no note field. Annotate one allowed custom value so
      // supplemental text does not count as an additional multi-select choice.
      const last = choices.pop()!
      return { choice: [...choices, OTHER_VALUE], text: '', other: `${field.options.find(option => option.value === last)!.label}\n补充：${supplement}` }
    }
    return { choice: [...choices, ...(custom.length ? [OTHER_VALUE] : [])], text: '', other: custom.join('，') }
  }
  private describe(pending: Pending): string[] {
    const { event, code, fields, index } = pending
    const { kind, method, params, options } = event.payload
    if (fields.length) {
      if (fields.some(field => field.secret)) return [`需要你回答 · ${code}\n此问题包含敏感输入，请在 UniAgent 桌面端处理。`]
      const field = fields[index]
      const hint = field.type === 'text' ? '复制下一条消息，在编号后填写回答。'
        : `复制下一条消息，修改序号${field.type === 'multi' ? '（多选用逗号分隔）' : ''}${field.allowOther ? '；可在序号后补充说明，也可改填回答文字。' : '。'}`
      const minimum = field.minItems ?? (field.type === 'multi' ? Math.min(2, field.maxItems ?? 2) : 1)
      const count = Math.min(field.options.length, Math.max(1, minimum))
      const example = `回答问题 ${code}${field.type === 'text' ? '' : ' ' + Array.from({ length: count }, (_, i) => i + 1).join(',')}`
      const title = [`需要你回答 · ${code}${fields.length > 1 ? `（${index + 1}/${fields.length}）` : ''}`, field.prompt || field.title].filter(Boolean).join('\n')
      return [[title, field.options.map((option, i) => `${i + 1}. ${option.label}${option.description ? '：' + option.description : ''}`).join('\n'),
        hint].filter(Boolean).join('\n\n'), example]
    }
    if (['question','elicitation'].includes(kind)) return [`需要你回答 · ${code}\n此提问格式暂不支持文本回答，请在 UniAgent 桌面端处理。`]
    const detail = kind === 'planMode' ? params?.plan || params?.text : params?.command || params?.description || params?.reason || params?.toolName || params?.tool || 'Agent 请求执行操作'
    const rendered = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.join(' ') : '请在 UniAgent 查看操作详情'
    const choices = method === 'session/request_permission' || method === 'zcode/permission'
      ? (Array.isArray(options) ? options : []).map((option, i) => `${i + 1}. ${option.name || option.label || option.optionId}`).join('\n')
      : ''
    return [[`需要确认 · ${code}`, rendered.slice(0,1800), choices,
      choices ? `回复「选择 ${code} 序号」。` : `回复「同意 ${code}」或「拒绝 ${code}」。`,
      kind === 'planMode' ? `修改计划请回复「回答问题 ${code} 修改意见」。` : '', '编号只对当前微信对话有效。'].filter(Boolean).join('\n')]
  }
}
