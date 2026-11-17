import type { ModelSourceQuota, ModelSourceQuotaQuery, QuotaProviderId } from '../../shared/modelSourceQuota'

function number(value: unknown): number {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(result)) throw new Error('额度接口缺少有效数值')
  return result
}
const text = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : undefined
function resetAt(value: unknown): { resetsAt?: number } {
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
  const date = Number.isFinite(numeric) ? numeric > 0 ? numeric < 1e12 ? numeric * 1000 : numeric : NaN : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(date) && date > 0 && date < 8.64e15 ? { resetsAt: date } : {}
}
function percentage(value: unknown): number { const percent = number(value); if (percent < 0) throw new Error('额度接口返回无效比例'); return Math.min(100, percent) }
const money = (value: unknown) => String(number(value))

/** Provider response contracts, independently validated; empty responses never mean zero. */
export function normalizeAdditionalQuota(preset: QuotaProviderId, raw: any, capturedAt: number, query?: ModelSourceQuotaQuery): ModelSourceQuota {
  const result: ModelSourceQuota = { status: 'ready', capturedAt }
  if (preset === 'minimax' || preset === 'minimax-cn') {
    if (raw?.base_resp && number(raw.base_resp.status_code) !== 0) throw new Error('额度查询失败，请检查 MiniMax 套餐凭据')
    const item = Array.isArray(raw?.model_remains) && raw.model_remains.find((entry: any) => entry?.model_name === 'general')
    if (!item) throw new Error('额度接口未返回 MiniMax 编程套餐')
    const windows: NonNullable<ModelSourceQuota['windows']> = []
    if (item.current_interval_remaining_percent != null) windows.push({ label: '5 小时额度', usedPercent: 100 - percentage(item.current_interval_remaining_percent), ...resetAt(item.end_time) })
    if ([1, 2].includes(Number(item.current_weekly_status))) windows.push({ label: '每周额度', usedPercent: 100 - percentage(item.current_weekly_remaining_percent), ...resetAt(item.weekly_end_time) })
    if (!windows.length) throw new Error('额度接口未返回 MiniMax 套餐窗口')
    return { ...result, kind: 'windows', windows }
  }
  if (preset === 'ark-coding-plan' || preset === 'ark-agent-plan') {
    const error = raw?.ResponseMetadata?.Error ?? raw?.Error
    if (error) throw new Error(/auth|signature|denied|credential|token|forbidden/i.test(String(error.Code)) ? '额度查询认证失败，请检查 AK / SK 及套餐查询权限' : '额度接口返回方舟业务错误，请稍后重试')
    const body = raw?.Result
    const windows: NonNullable<ModelSourceQuota['windows']> = []
    if (preset === 'ark-agent-plan') {
      for (const [key, label] of [['AFPFiveHour', '5 小时额度'], ['AFPWeekly', '每周额度'], ['AFPMonthly', '每月额度']]) {
        const item = body?.[key]
        if (!item) continue
        const total = number(item.Quota)
        if (total === 0) continue
        const used = number(item.Used)
        if (total < 0 || used < 0) throw new Error('额度接口返回无效 Agent Plan 用量')
        windows.push({ label, usedPercent: Math.min(100, used / total * 100), ...resetAt(item.ResetTime) })
      }
    } else {
      const items = body?.QuotaUsage ?? body?.Usages ?? body?.Details
      if (Array.isArray(items)) for (const item of items) {
        const label = ({ session: '5 小时额度', '5h': '5 小时额度', fivehour: '5 小时额度', five_hour: '5 小时额度', rolling_5h: '5 小时额度', weekly: '每周额度', week: '每周额度', '7d': '每周额度', monthly: '每月额度', month: '每月额度' } as Record<string, string>)[String(item?.Level ?? item?.Type ?? item?.Period ?? item?.Label ?? item?.Window).toLowerCase()]
        if (!label) continue
        windows.push({ label, usedPercent: percentage(item.Percent ?? item.UsedPercent ?? item.UsagePercent), ...resetAt(item.ResetTime ?? item.ResetTimestamp) })
      }
    }
    if (!windows.length) throw new Error('额度接口未返回当前方舟套餐窗口，请核对订阅与查询权限')
    return { ...result, kind: 'windows', windows, planType: preset === 'ark-agent-plan' ? `Agent Plan${text(body?.PlanType) ? ` ${text(body.PlanType)}` : ''}` : 'Coding Plan' }
  }
  if (preset === 'siliconflow' || preset === 'siliconflow-cn') {
    if (raw?.code != null && ![0, 20000].includes(number(raw.code))) throw new Error('额度接口未返回硅基流动成功结果')
    const data = raw?.data
    return { ...result, kind: 'balance', balances: [{ currency: preset === 'siliconflow-cn' ? 'CNY' : 'USD', total: money(data?.totalBalance), ...(data?.chargeBalance != null ? { toppedUp: money(data.chargeBalance) } : {}), ...(data?.balance != null ? { granted: money(data.balance) } : {}) }] }
  }
  if (preset === 'openrouter') {
    const total = number(raw?.data?.total_credits), used = number(raw?.data?.total_usage)
    return { ...result, kind: 'balance', balances: [{ currency: 'USD', total: money(total - used) }] }
  }
  if (preset === 'stepfun') return { ...result, kind: 'balance', balances: [{ currency: 'CNY', total: money(raw?.balance), ...(raw?.total_cash_balance != null ? { toppedUp: money(raw.total_cash_balance) } : {}), ...(raw?.total_voucher_balance != null ? { granted: money(raw.total_voucher_balance) } : {}) }] }
  if (preset === 'novita') return { ...result, kind: 'balance', balances: [{ currency: 'USD', total: money(number(raw?.availableBalance) / 10000) }] }
  if (preset === 'new-api') {
    if (raw?.success !== true) throw new Error('额度查询失败，请检查 New API 访问令牌及用户 ID')
    const unit = query?.unit && query.unit !== 'quota' ? query.unit : '额度'
    const divisor = unit === '额度' ? 1 : number(query?.quotaPerUnit)
    if (divisor <= 0) throw new Error('额度换算比例无效')
    const remaining = number(raw.data?.quota) / divisor, used = number(raw.data?.used_quota) / divisor
    return { ...result, planType: text(raw.data?.group), amount: { remaining, used, total: remaining + used, unit } }
  }
  if (preset === 'sub2api') {
    if (raw?.isValid === false) throw new Error('额度接口返回账户或套餐不可用')
    const quota = raw?.quota, unit = text(raw?.unit) || text(quota?.unit) || 'USD'
    const hasRemaining = raw?.remaining != null, remaining = hasRemaining ? number(raw.remaining) : undefined
    const total = quota?.limit != null ? number(quota.limit) : undefined
    const amount: NonNullable<ModelSourceQuota['amount']> = { unit }
    if (total != null && total > 0) { const used = number(quota.used); amount.total = total; amount.used = used; amount.remaining = remaining != null && remaining >= 0 ? remaining : total - used }
    else if (remaining === -1) amount.unlimited = true
    else if (remaining != null && remaining >= 0) amount.remaining = remaining
    else throw new Error('额度接口未返回 Sub2API 余额或限额')
    return { ...result, planType: text(raw.planName), amount }
  }
  throw new Error('该接入方式不支持额度查询')
}
