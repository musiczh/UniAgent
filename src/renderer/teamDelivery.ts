import type { TeamAssignment } from '@shared/teamTypes'

function structuredResult(text: string): Record<string, unknown> | undefined {
  const raw = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) &&
      ['summary', 'result', 'question', 'error'].some(key => typeof value[key] === 'string') ? value : undefined
  } catch {
    return undefined
  }
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function failureSummary(status: string, error: string): string {
  if (status !== 'failed' || !error) return ''
  if (/5-hour usage limit/i.test(error) && /kimi/i.test(error)) {
    return '失败原因：Kimi 模型的 5 小时使用额度已耗尽，等待额度重置或更换模型后可重试。'
  }
  return `失败原因：${error}`
}

/** Resolve the exact delivery attempt; event JSON supplies a fallback for old transcripts. */
export function teamDeliveryContent(assignment: TeamAssignment, attempt: number, eventSummary: string): {
  summary: string; result: string; error: string; question: string; artifactRefs: string[]; review: string; status: string
} {
  const current = assignment.attempt === attempt
  const delivery = current ? assignment : assignment.history.find(item => item.attempt === attempt)
  const event = structuredResult(eventSummary)
  const stored = structuredResult(delivery?.result || '')
  const status = delivery?.status || textField(event?.status)
  const error = delivery?.error || textField(stored?.error) || textField(event?.error)
  const result = textField(stored?.result) || (stored ? '' : delivery?.result || '') ||
    textField(event?.result) || (event ? '' : eventSummary)
  const summaryText = [failureSummary(status, error), textField(event?.summary), textField(stored?.summary),
    current ? assignment.summary : '', result].find(text => text.trim() && text !== '执行中') || ''
  const summary = /^[{\[]|^```/.test(summaryText.trim())
    ? '组员结果已到，可展开查看完整报告。'
    : summaryText.replace(/^\s*#{1,6}\s+/, '').trim()
  const refs = delivery?.artifactRefs || event?.artifactRefs
  return {
    summary,
    result: result || textField(stored?.summary),
    error,
    question: (current ? assignment.question : '') || textField(stored?.question) || textField(event?.question),
    status,
    artifactRefs: Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string') : [],
    review: delivery?.endedAt ? `第 ${attempt} 次交付 · ${delivery.review
      ? (delivery.review.decision === 'accept' ? 'Leader 已验收' : '需补做') + ' · ' + delivery.review.reason
      : delivery.status === 'succeeded' ? '待 Leader 验收' : '未成功交付'}` : '',
  }
}
