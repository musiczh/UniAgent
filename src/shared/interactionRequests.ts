import type { UAEvent } from './types'
import { normalizeQuestions, questionAnswerKind, questionAnswerValues, validateQuestionAnswer } from './questions'

export const ASYNC_QUESTION_PREFIX = 'async-question:'
export const LOCAL_PLAN_PREFIX = 'plan-confirmation:'

/** These methods deliver plan feedback inside the approval answer itself; a follow-up message would duplicate it. */
export function planFeedbackInAnswer(method?: string): boolean {
  return method === 'local/plan' || method === 'kimi/web/approval'
}

export function localPlanRequest(plan: UAEvent): UAEvent {
  return { ...plan, type: 'approval_request', state: 'pending', payload: {
    requestId: LOCAL_PLAN_PREFIX + (plan.payload.id ?? plan.seq),
    kind: 'planMode', method: 'local/plan', params: { plan: plan.payload.text },
    planId: plan.payload.id, planSeq: plan.seq, turnId: plan.payload.turnId,
  } }
}

/** A local confirmation is only offered for the latest completed plan turn. */
export function latestLocalPlanRequest(events: UAEvent[]): UAEvent | undefined {
  const boundary = events.findLastIndex(event => event.type === 'user_message' || event.type === 'goal_message' || event.type === 'turn_started')
  const turn = events.slice(boundary + 1)
  if (turn.some(event => event.type === 'approval_request' && event.payload.kind === 'planMode' && event.payload.method !== 'local/plan')) return undefined
  const plan = turn.findLast(event => event.type === 'agent_message' && event.payload.kind === 'plan' && event.state === 'success' && event.payload.text?.trim())
  const completed = turn.findLast(event => event.type === 'turn_completed')
  if (!plan || !completed || completed.state !== 'success' || completed.seq < plan.seq) return undefined
  const request = localPlanRequest(plan)
  return turn.findLast(event => event.type === 'approval_request' && event.payload.requestId === request.payload.requestId) || request
}

/** Native plan exits sometimes omit the plan body; use only this request's turn. */
export function withPlanText(event: UAEvent, events: UAEvent[]): UAEvent {
  if (event.type !== 'approval_request' || event.payload.kind !== 'planMode' || event.payload.params?.plan) return event
  const before = events.filter(item => item.seq <= event.seq)
  const boundary = before.findLastIndex(item => item.type === 'user_message' || item.type === 'goal_message' || item.type === 'turn_started')
  const plan = before.slice(boundary + 1).findLast(item => item.type === 'agent_message' && item.payload.kind === 'plan' && item.payload.text?.trim())
  return plan ? { ...event, payload: { ...event.payload, params: { ...event.payload.params, plan: plan.payload.text } } } : event
}

/** A streamed async item may complete after its question was already answered. */
export function withInteractionState(event: UAEvent, events: UAEvent[]): UAEvent {
  if (!isAsyncQuestion(event)) return withPlanText(event, events)
  const prior = events.findLast(item => isAsyncQuestion(item) && item.payload.id === event.payload.id)
  if (!prior) return event
  return { ...event, payload: { ...event.payload,
    ...(prior.payload.submittedAnswer !== undefined ? { submittedAnswer: prior.payload.submittedAnswer } : {}),
    ...(prior.payload.interactionExpired ? { interactionExpired: true } : {}),
  } }
}

export function isAsyncQuestion(event: UAEvent): boolean {
  return event.type === 'agent_message' && event.payload?.delivery === 'async' &&
    Array.isArray(event.payload.questions) && event.payload.questions.length > 0
}

export function isPendingInteraction(event: UAEvent): boolean {
  return (event.type === 'approval_request' && event.state === 'pending' || isAsyncQuestion(event)) &&
    event.payload.submittedAnswer === undefined && !event.payload.interactionExpired
}

export function asyncQuestionParams(payload: UAEvent['payload']): { questions: any[] } {
  return { questions: payload.questions.filter((question: any) => question && typeof question === 'object').map((question: any) => ({
    ...question,
    question: question.question || question.prompt || question.title || '',
    title: question.header || (question.question || question.prompt ? question.title : undefined),
    allowOther: question.allowOther !== false,
  })) }
}

/** The wire item remains an agent message; only its presentation is a request. */
export function asInteractionRequest(event: UAEvent): UAEvent {
  if (!isAsyncQuestion(event)) return event
  return {
    ...event,
    type: 'approval_request',
    state: event.payload.interactionExpired ? 'cancelled' :
      event.payload.submittedAnswer === undefined ? 'pending' : 'success',
    payload: {
      ...event.payload,
      requestId: ASYNC_QUESTION_PREFIX + event.payload.id,
      kind: 'question',
      params: asyncQuestionParams(event.payload),
    },
  }
}

export function interactionRequestKey(event: UAEvent | undefined): string | undefined {
  if (!event) return undefined
  if (isAsyncQuestion(event)) return ASYNC_QUESTION_PREFIX + event.payload.id
  if (event.type === 'approval_request' && typeof event.payload.requestId === 'string') return event.payload.requestId
  return undefined
}

export function isSkippedQuestionAnswer(answer: unknown): boolean {
  return !!answer && typeof answer === 'object' && (answer as { action?: unknown }).action === 'skip'
}

/** Secret form values are not needed to restore a read-only answer. */
export function redactInteractionAnswer(event: UAEvent): UAEvent {
  const request = asInteractionRequest(event)
  const answer = request.payload.submittedAnswer
  if (!answer || (request.payload.kind !== 'question' && request.payload.kind !== 'elicitation')) return event
  if (isSkippedQuestionAnswer(answer)) return { ...event, payload: { ...event.payload, submittedAnswer: { action: 'skip' } } }
  const answerKind = questionAnswerKind(request.payload.kind, request.payload.method)
  const fields = normalizeQuestions(answerKind, request.payload.params).filter(field => field.secret)
  if (!fields.length) return event
  if (Array.isArray(answer.answers)) {
    const secretFields = new Map(fields.map(field => [field.id, field]))
    const masked = { ...answer, answers: answer.answers.map((entry: any) => {
      const field = secretFields.get(entry?.id)
      if (!field) return entry
      return { ...entry, selected: [], custom: questionAnswerValues(answerKind, field, answer).length ? '已填写' : undefined }
    }) }
    return { ...event, payload: { ...event.payload, submittedAnswer: masked } }
  }
  const masked = answerKind === 'zcode'
    ? { ...answer, content: { ...answer.content, answers: { ...answer.content?.answers } } }
    : answerKind === 'elicitation'
    ? { ...answer, content: { ...answer.content } }
    : { ...answer, answers: { ...answer.answers } }
  for (const field of fields) {
    if (!questionAnswerValues(answerKind, field, answer).length) continue
    if (answerKind === 'zcode') masked.content.answers[field.id] = '已填写'
    else if (answerKind === 'elicitation') masked.content[field.id] = '已填写'
    else masked.answers[field.id] = answerKind === 'grok' ? ['已填写'] : { answers: ['已填写'] }
  }
  return { ...event, payload: { ...event.payload, submittedAnswer: masked } }
}

/** Reject empty/malformed answers before dispatching an ordinary user message. */
export function asyncQuestionReply(event: UAEvent, answer: unknown): string {
  const fields = normalizeQuestions('question', asyncQuestionParams(event.payload))
  if (!fields.length) throw new Error('提问内容无效')
  if (isSkippedQuestionAnswer(answer)) {
    return `跳过 Agent 提问：\n\n${fields.map(field => field.prompt || field.title || field.id).join('\n\n')}\n\n用户跳过了此组提问，未提供答案。跳过不代表同意、授权或确认前置条件。`
  }
  validateQuestionAnswer('question', fields, answer)
  const lines = fields.map(field => {
    const values = questionAnswerValues('question', field, answer).filter(value => value.trim())
    return `${field.prompt || field.title || field.id}\n回答：${values.join('、') || '未填写'}`
  })
  return `回答 Agent 提问：\n\n${lines.join('\n\n')}`
}
