import type { ModelSourceQuota } from '@shared/modelSourceQuota'
import { RefreshIcon, UiIcon } from './Icons'

const number = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const compactNumber = (value: number) => Math.abs(value) >= 1e8 ? `${number(value / 1e8)} 亿` : Math.abs(value) >= 1e4 ? `${number(value / 1e4)} 万` : number(value)
const money = (value: string | number, currency: string) => {
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 4 }).format(Number(value)) }
  catch { return `${currency} ${number(Number(value))}` }
}
const date = (value: number) => new Date(value).toLocaleString('zh-CN')
const remaining = (used: number) => Math.max(0, Math.min(100, 100 - used))
export function sourceQuotaText(quota?: ModelSourceQuota): { summary: string; detail: string; hasValue: boolean } {
  let values: string[] = [], detail: string[] = []
  const prefix = quota?.stale ? '上次剩余' : '剩余'
  if (quota?.accounts?.length) {
    return { summary: `${quota.accounts.length} 组凭据 · 分别查询`, detail: '不同凭据可能属于同一账户，余额分别展示，不相加。', hasValue: quota.accounts.some(account => sourceQuotaText(account.quota).hasValue) }
  }
  if (quota?.amount) {
    const amount = quota.amount
    const format = (value: number) => ['USD', 'CNY'].includes(amount.unit) ? money(value, amount.unit) : `${compactNumber(value)} ${amount.unit}`
    values = amount.unlimited ? ['不限额'] : amount.remaining !== undefined ? [`${prefix} ${format(amount.remaining)}`] : []
    detail = [amount.used !== undefined ? `已用 ${format(amount.used)}` : '', amount.total !== undefined ? `总额 ${format(amount.total)}` : ''].filter(Boolean)
  } else if (quota?.kind === 'balance') {
    values = (quota.balances || []).map(balance => `${prefix} ${money(balance.total, balance.currency)}`)
    detail = (quota.balances || []).flatMap(balance => [
      balance.toppedUp !== undefined ? `现金 ${money(balance.toppedUp, balance.currency)}` : '',
      balance.granted !== undefined ? `赠金 ${money(balance.granted, balance.currency)}` : '',
      balance.creditAvailable !== undefined ? `含可用授信 ${money(balance.creditAvailable, balance.currency)}` : '',
      balance.frozen !== undefined ? `已扣除冻结 ${money(balance.frozen, balance.currency)}` : ''
    ]).filter(Boolean)
  } else if (quota?.kind === 'windows') {
    values = (quota.windows || []).map(window => `${window.label}${prefix} ${number(remaining(window.usedPercent))}%`)
    detail = (quota.windows || []).filter(window => window.resetsAt).map(window => `${window.label} ${date(window.resetsAt!)} 重置`)
  } else if (quota?.kind === 'credits' && quota.credits) {
    const credits = quota.credits
    values = [`${prefix} ${compactNumber(credits.remaining)} / ${compactNumber(credits.total)} ${credits.unit}`]
    detail = [`精确值 ${number(credits.remaining)} / ${number(credits.total)} ${credits.unit}`, ...(credits.resetsAt ? [`套餐周期截至 ${date(credits.resetsAt)}`] : [])]
  }
  if (quota?.planType) detail.unshift(`当前套餐：${quota.planType}`)
  return { summary: values.join(' · ') || (quota?.needsCredentials ? '待配置额度查询' : quota?.refreshing ? '正在查询额度…' : quota?.checkedAt ? '暂无法获取额度' : '尚未查询额度'),
    detail: quota?.status === 'error' ? `${quota.message || '刷新失败'}${quota.stale ? ' · 显示上次结果' : ''}` : detail.join(' · ') || quota?.message || (values.length ? '' : '请在对应控制台查看额度'), hasValue: values.length > 0 }
}
function preferredAccountQuota(quota?: ModelSourceQuota): ModelSourceQuota | undefined {
  const accounts = quota?.accounts
  if (!accounts?.length) return quota
  // Keep credential order, but prefer a successful current result over cached values.
  const selected = accounts.find(account => account.quota.status === 'ready' && !account.quota.stale && sourceQuotaText(account.quota).hasValue)
    ?? accounts.find(account => sourceQuotaText(account.quota).hasValue)
    ?? accounts[0]
  return { ...selected.quota, refreshing: quota?.refreshing ?? selected.quota.refreshing }
}
function Meter({ value }: { value: number }): JSX.Element { return <div className={`quota-meter${value <= 10 ? ' quota-low' : ''}`} aria-hidden="true"><i style={{ width: `${value}%` }} /></div> }
function QuotaValue({ quota, compact }: { quota?: ModelSourceQuota; compact: boolean }): JSX.Element {
  const text = sourceQuotaText(quota)
  const prefix = quota?.stale ? '上次剩余' : '剩余'
  return <>
    {quota?.accounts?.length ? <>
      <div className={compact ? 'quota-summary-value' : 'r-label'}>{text.summary}</div>
      {quota.accounts.map((account, index) => <div key={account.id} className={compact ? 'quota-secondary' : 'quota-account'}>{compact ? <span title={account.label}>{`凭据 ${index + 1} · ${sourceQuotaText(account.quota).summary}`}{account.quota.status === 'error' && ' · 查询失败'}</span> : <><div className="r-label">{account.label}</div><QuotaValue quota={account.quota} compact={false} /></>}</div>)}
      {!compact && <div className="r-sub">{text.detail}</div>}
    </> : quota?.kind === 'windows' && quota.windows?.length ? <>
      {quota.windows.map((window, index) => <div className={compact ? 'quota-window-summary' : 'quota-window'} key={index}>
        <div><span className={compact ? '' : 'r-label'}>{window.label}</span>{!compact && window.resetsAt && <div className="r-sub">{date(window.resetsAt)} 重置</div>}</div>
        <div className="quota-window-value"><span className={remaining(window.usedPercent) <= 10 ? 'quota-low' : undefined}>{prefix} {number(remaining(window.usedPercent))}%</span>{!compact && <Meter value={remaining(window.usedPercent)} />}</div>
      </div>)}
      {compact && <Meter value={Math.min(...quota.windows.map(window => remaining(window.usedPercent)))} />}
      {compact && quota.windows.some(window => window.resetsAt) && <small>{date(Math.min(...quota.windows.flatMap(window => window.resetsAt ? [window.resetsAt] : [])))} 重置</small>}
      {!compact && quota.planType && <div className="r-sub">当前套餐：{quota.planType}</div>}
    </> : <>
      <div className={compact ? 'quota-summary-value' : 'r-label'} title={quota?.kind === 'credits' ? text.detail : undefined}>{quota?.refreshing && <RefreshIcon size={13} className="is-spinning" />}{compact && quota?.credits ? `${prefix} ${compactNumber(quota.credits.remaining)} ${quota.credits.unit}` : text.summary}</div>
      {quota?.credits && <><div className="quota-secondary">总额 {compactNumber(quota.credits.total)} · 剩余 {number(quota.credits.total > 0 ? quota.credits.remaining / quota.credits.total * 100 : 0)}%</div><Meter value={quota.credits.total > 0 ? quota.credits.remaining / quota.credits.total * 100 : 0} />{compact && quota.credits.resetsAt && <small>{date(quota.credits.resetsAt)} 到期</small>}</>}
      {!compact && <div className="r-sub">{text.detail}</div>}
    </>}
    {(compact && quota?.needsCredentials || quota?.kind === 'windows' && quota.status === 'error') && <div className="quota-secondary">{text.detail}</div>}
    {quota?.capturedAt && <small>{quota.stale ? '上次更新' : '更新于'} {date(quota.capturedAt)}</small>}
  </>
}
export function ModelSourceQuotaView({ quota: sourceQuota, consoleUrl, compact = false, singleAccount = false, onRefresh, onConsole, onConfigure, onQueryConfigure }: {
  quota?: ModelSourceQuota; consoleUrl?: string; compact?: boolean; singleAccount?: boolean; onRefresh?: () => void; onConsole: (url: string) => void; onConfigure: () => void; onQueryConfigure?: () => void
}): JSX.Element {
  const quota = singleAccount ? preferredAccountQuota(sourceQuota) : sourceQuota
  const text = sourceQuotaText(quota)
  const consoleButton = <button type="button" className="set-mini-btn quota-console" onClick={() => consoleUrl ? onConsole(consoleUrl) : onConfigure()}>{consoleUrl ? '控制台查看额度' : '设置控制台地址'}<UiIcon name={consoleUrl ? 'external-link' : 'edit'} size={13} /></button>
  const configure = onQueryConfigure && <button type="button" className="set-mini-btn quota-query-configure" onClick={onQueryConfigure}><UiIcon name="edit" size={13} />{quota?.needsCredentials ? '配置查询' : '查询设置'}</button>
  return <div className={compact ? 'quota-summary' : `row model-source-quota-detail${quota?.accounts?.length || quota?.windows?.length ? ' quota-expanded' : ''}`}>
    <div className={compact ? 'quota-summary-text' : 'r-main quota-detail-result'} role="status" aria-live="polite"><QuotaValue quota={quota} compact={compact} /></div>
    {compact ? !text.hasValue && <div className="quota-actions">{quota?.needsCredentials && configure}{consoleButton}</div> : <div className="r-control quota-actions">{onRefresh && <button type="button" className="set-mini-btn" disabled={quota?.refreshing} aria-busy={!!quota?.refreshing} onClick={onRefresh}><RefreshIcon size={14} className={quota?.refreshing ? 'is-spinning' : undefined} />{quota?.refreshing ? '查询中…' : '刷新额度'}</button>}{configure}{consoleButton}</div>}
  </div>
}
