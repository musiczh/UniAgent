import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { cloudMonitorConfig } from '../src/shared/cloudMonitorConfig'
import { consumeSignInCallback, DashboardClient, expectedRate, type FeedbackRow, type LogRow, type MonitorStats, type Query } from './client'

const labels: Record<string, string> = { reuse_task: '复用已有任务', create_task: '新建任务', create_requirement: '新建需求与任务', create_task_in_space: '在空间中新建任务', create_task_in_requirement: '在已有需求中新建任务', create_requirement_and_task: '新建需求与任务', clarify: '等待补充信息', unknown: '未提供' }
const date = (value: string) => new Date(value).toLocaleString()
const installation = (value: string) => '安装 ' + value.slice(0, 6)

export function StatsCards({ stats }: { stats: MonitorStats }) {
  return <div className="stats">{[['活跃安装', stats.installations, '按安装身份去重'], ['错误日志', stats.errors, '所选时间范围'], ['已评价路由', stats.feedback, '每回合取最新评价'], ['符合预期比例', expectedRate(stats), `${stats.good} / ${stats.feedback} · 不含未评价`]].map(([title, value, note]) => <div className="stat" key={title}><span>{title}</span><strong>{value}</strong><small>{note}</small></div>)}</div>
}

export function Trend({ daily }: { daily: MonitorStats['daily'] }) {
  if (!daily.length) return <div className="chart"><p className="empty">所选范围暂无错误日志</p></div>
  const maximum = Math.max(1, ...daily.map(row => Number(row.count))), step = 860 / Math.max(1, daily.length - 1)
  const points = daily.map((row, index) => `${45 + index * step},${130 - Number(row.count) / maximum * 105}`).join(' ')
  return <div className="chart"><div className="section-title"><h3>错误日志趋势</h3><small>每日错误数 · UTC</small></div><svg viewBox="0 0 960 170" role="img" aria-label="所选范围的每日错误数量"><path d="M45 25H905M45 78H905M45 130H905" className="grid"/><polyline points={points} className="line"/>{daily.map((row, index) => <g key={row.day}><circle cx={45 + index * step} cy={130 - Number(row.count) / maximum * 105} r="3"/><title>{row.day}：{row.count} 条</title>{(daily.length < 10 || index % Math.ceil(daily.length / 7) === 0 || index === daily.length - 1) && <text x={45 + index * step} y="155" textAnchor="middle">{row.day.slice(5)}</text>}</g>)}</svg></div>
}

export function FeedbackTable({ rows, open }: { rows: FeedbackRow[]; open: (row: FeedbackRow) => void }) {
  return <div className="table"><div className="row table-head"><span>反馈原因</span><span>实际路由结果</span><span>预期结果</span><span>用户反馈</span></div>{rows.map(row => <div className="row" key={row.owner_id + row.event_id}><div>{row.reason || '未填写原因'}<small>{date(row.saved_at)} · {installation(row.owner_id)}</small></div><div>{labels[row.actual_action] || '未提供'}<small>{row.app_version} · {row.distribution === 'public' ? 'Public' : '内网版'}</small></div><div>{row.expected_kind ? labels[row.expected_kind] : '—'}<small>第 {row.revision} 个反馈版本</small></div><div><span className={'badge ' + (row.matches ? 'good' : 'bad')}>{row.matches ? '符合预期' : '不符合预期'}</span><br/><button className="mini" onClick={() => open(row)}>查看详情 ›</button></div></div>)}{!rows.length && <p className="empty">暂无符合条件的反馈</p>}</div>
}

export function LogTable({ rows }: { rows: LogRow[] }) {
  return <div className="table"><div className="row log-row table-head"><span>级别／时间</span><span>Agent／安装</span><span>错误代码与摘要</span><span>版本／渠道</span></div>{rows.map(row => <div className="row log-row" key={row.owner_id + row.event_id}><div><span className={'badge ' + (row.level === 'error' ? 'error-badge' : row.level === 'warn' ? 'bad' : '')}>{row.level}</span><small>{date(row.occurred_at)}</small></div><div>{row.agent_id}<small>{installation(row.owner_id)}</small></div><div>{row.code}<small>{row.payload.message || Object.entries(row.payload).map(([key, value]) => key + ': ' + value).join(' · ')}</small></div><div>{row.app_version}<small>{row.distribution === 'public' ? 'Public' : '内网版'}</small></div></div>)}{!rows.length && <p className="empty">暂无符合条件的日志</p>}</div>
}

export function Dashboard({ client, callback }: { client: DashboardClient; callback?: URLSearchParams }) {
  const [signedIn, setSignedIn] = useState(!callback && client.signedIn()), [email, setEmail] = useState(''), [linkSent, setLinkSent] = useState(false)
  const [verifying, setVerifying] = useState(!!callback)
  const [syncing, setSyncing] = useState(false)
  const [recovery, setRecovery] = useState(!callback && client.needsPassword())
  const [mode, setMode] = useState<'password' | 'link' | 'recover'>('password')
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [remember, setRemember] = useState(true)
  const [tab, setTab] = useState('overview'), [query, setQuery] = useState<Query>({ days: 7, distribution: '', version: '', search: '', filter: '', offset: 0 })
  const [data, setData] = useState<Awaited<ReturnType<DashboardClient['load']>>>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const [history, setHistory] = useState<FeedbackRow[]>(), [historyLoading, setHistoryLoading] = useState(false)
  const generation = useRef(0)
  const historyGeneration = useRef(0)
  useEffect(() => {
    if (verifying) return
    return client.connectSync((checking, cause) => {
      generation.current++; historyGeneration.current++
      setData(undefined); setHistory(undefined); setHistoryLoading(false); setLoading(false)
      setSyncing(checking); setSignedIn(client.signedIn()); setError(cause?.message || '')
      setRecovery(client.needsPassword()); setPassword(''); setConfirmation('')
      if (client.signedIn()) setLinkSent(false)
      if (!checking) setRefresh(value => value + 1)
    })
  }, [client, verifying])
  useEffect(() => {
    if (!callback) return
    let active = true
    void client.completeSignIn(callback).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '登录失败，请重新发送登录链接。')
    }).finally(() => { if (active) { setSignedIn(client.signedIn()); setRecovery(client.needsPassword()); setVerifying(false) } })
    return () => { active = false }
  }, [client, callback])
  useEffect(() => {
    const current = ++generation.current
    historyGeneration.current++
    setData(undefined); setHistory(undefined); setHistoryLoading(false)
    if (!signedIn || recovery) return
    setError('')
    setLoading(true)
    const timer = setTimeout(() => { void client.load(query).then(value => { if (generation.current === current) setData(value) }).catch(cause => {
      if (generation.current === current) { setError(cause instanceof Error ? cause.message : '读取失败，请重试。'); if (!client.signedIn()) setSignedIn(false) }
    }).finally(() => { if (generation.current === current) setLoading(false) }) }, query.search ? 250 : 0)
    return () => { clearTimeout(timer); generation.current++ }
  }, [client, signedIn, recovery, query, refresh])
  const update = (patch: Partial<Query>) => setQuery(previous => ({ ...previous, ...patch, offset: patch.offset ?? 0 }))
  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); setError(''); setLoading(true)
    const current = ++generation.current, secret = password; setPassword('')
    try {
      if (mode === 'password') await client.signInPassword(email, secret, remember)
      else if (mode === 'recover') await client.sendRecovery(email)
      else await client.sendLink(email)
      if (current === generation.current) { setEmail(email.trim()); setSignedIn(client.signedIn()); setLinkSent(mode !== 'password') }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : '登录失败，请重试。') }
    finally { if (current === generation.current) setLoading(false) }
  }
  async function savePassword(event: React.FormEvent) {
    event.preventDefault(); setError(''); setLoading(true)
    const current = ++generation.current, secret = password, repeated = confirmation; setPassword(''); setConfirmation('')
    try { await client.updatePassword(secret, repeated); if (current === generation.current) { setRecovery(false); setSignedIn(client.signedIn()) } }
    catch (cause) { if (current === generation.current) { setRecovery(client.needsPassword()); setSignedIn(client.signedIn()); setError(cause instanceof Error ? cause.message : '设置密码失败，请重试。') } }
    finally { if (current === generation.current) setLoading(false) }
  }
  function changeMode(value: typeof mode) { setMode(value); setLinkSent(false); setPassword(''); setConfirmation(''); setError('') }
  async function signOut() { generation.current++; setSignedIn(false); setRecovery(false); setData(undefined); setHistory(undefined); setError(''); setLoading(false); setLinkSent(false); setPassword(''); setConfirmation(''); setMode('password'); await client.signOut() }
  async function showHistory(row: FeedbackRow) {
    const current = generation.current, historyRequest = ++historyGeneration.current
    setHistory(undefined); setHistoryLoading(true); setError('')
    try { const result = await client.history(row); if (current === generation.current && historyRequest === historyGeneration.current) setHistory(result) }
    catch (cause) { if (current === generation.current && historyRequest === historyGeneration.current) setError(cause instanceof Error ? cause.message : '读取失败') }
    finally { if (current === generation.current && historyRequest === historyGeneration.current) setHistoryLoading(false) }
  }
  const versions = [...new Set([...(data?.feedback.rows.map(row => row.app_version) || []), ...(data?.logs.rows.map(row => row.app_version) || []), ...(query.version ? [query.version] : [])])].sort()
  const total = tab === 'logs' ? data?.logs.total : data?.feedback.total
  return <><header className="cloud-bar"><span className="brand-dot">U</span><strong>UniAgent</strong><span className="quiet">/ 云端监控</span><span className="account">{recovery ? '身份已验证' : signedIn ? '维护者' : '未登录'}</span>{signedIn && !recovery && <button className="mini" onClick={() => void signOut()}>退出登录</button>}</header><main>
    <header className="review-head"><div><h1>云端监控</h1><p className="subtitle">查看安装端自动上报的日志与路由反馈。</p></div>{signedIn && !recovery && <button className="mini" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新</button>}</header>
    {!client.configured() ? <div className="message"><h2>监控服务尚未完成配置</h2><p>请由维护者完成云端部署后再访问。</p></div> : verifying || syncing ? <div className="login-card" role="status"><h2>正在验证登录…</h2><p className="subtitle">正在确认账号信息，请稍候。</p></div> : recovery ?
      <form className="login-card" onSubmit={event => void savePassword(event)}><h2>设置登录密码</h2><p className="subtitle">邮箱验证已完成，请设置密码。</p><label>新密码<input type="password" required minLength={8} maxLength={1024} autoComplete="new-password" value={password} disabled={loading} onChange={event => setPassword(event.target.value)}/></label><label>确认密码<input type="password" required minLength={8} maxLength={1024} autoComplete="new-password" value={confirmation} disabled={loading} onChange={event => setConfirmation(event.target.value)}/></label><button className="mini primary" disabled={loading}>{loading ? '正在保存…' : '保存密码并进入看板'}</button><button className="mini" type="button" disabled={loading} onClick={() => void signOut()}>返回登录</button><small className="secondary-note">设置后，手机与电脑均可使用邮箱和密码登录。</small></form> : !signedIn ? linkSent ?
      <div className="login-card"><h2>{mode === 'recover' ? '设置密码链接已发送' : '登录链接已发送'}</h2><p className="subtitle">{mode === 'recover' ? '如果该邮箱可用，将收到设置密码邮件。打开邮件链接后设置密码，即可在任意设备使用密码登录。' : `请查收 ${email} 的邮件，并打开登录链接。`}</p><button className="mini" type="button" onClick={() => changeMode(mode)}>更换邮箱／重新发送</button>{mode !== 'password' && <button className="mini" type="button" onClick={() => changeMode('password')}>返回密码登录</button>}<small>邮件暂未收到时，可检查垃圾邮件或稍后重试。</small></div> :
      <form className="login-card" onSubmit={event => void authenticate(event)}><h2>{mode === 'recover' ? '首次设置／找回密码' : '登录监控看板'}</h2><p className="subtitle">{mode === 'recover' ? '先验证邮箱身份，再设置登录密码。' : '仅限有权限的维护者查看。'}</p><label>维护者邮箱<input type="email" required value={email} disabled={loading} onChange={event => setEmail(event.target.value)} autoComplete="email" placeholder="请输入邮箱"/></label>
        {mode === 'password' && <><label>密码<input type="password" required maxLength={1024} autoComplete="current-password" value={password} disabled={loading} onChange={event => setPassword(event.target.value)} placeholder="请输入密码"/></label><div className="login-options"><label><input type="checkbox" checked={remember} disabled={loading} onChange={event => setRemember(event.target.checked)}/>保持登录</label><button className="auth-link" type="button" disabled={loading} onClick={() => changeMode('recover')}>首次设置／忘记密码</button></div></>}
        <button className="mini primary" disabled={loading}>{loading ? '正在处理…' : mode === 'password' ? '登录' : mode === 'recover' ? '发送设置密码链接' : '发送登录链接'}</button><button className="mini" type="button" disabled={loading} onClick={() => changeMode(mode === 'password' ? 'link' : 'password')}>{mode === 'password' ? '使用邮件链接登录' : '返回密码登录'}</button><small className="secondary-note">{mode === 'password' ? '设置密码后，日常登录无需收取邮件。' : mode === 'recover' ? '可在手机上完成设置，之后电脑直接使用密码登录。' : '打开邮件中的登录链接，完成后将自动返回看板。'}</small>
      </form> : <>
      <nav className="tabs" aria-label="监控分类">{[['overview', '概览'], ['router', 'RouterAgent 反馈'], ['logs', '日志']].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); update({ search: '', filter: '' }) }}>{label}</button>)}</nav>
      <div className="toolbar"><select aria-label="时间范围" value={query.days} onChange={event => update({ days: Number(event.target.value) })}><option value={1}>最近 24 小时</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select><select aria-label="发行渠道" value={query.distribution} onChange={event => update({ distribution: event.target.value })}><option value="">全部渠道</option><option value="internal">内网版</option><option value="public">Public</option></select><select aria-label="App 版本" value={query.version} onChange={event => update({ version: event.target.value })}><option value="">全部版本</option>{versions.map(value => <option key={value}>{value}</option>)}</select>{tab !== 'overview' && <input className="search" aria-label="搜索记录" placeholder={tab === 'logs' ? '搜索代码或摘要' : '搜索反馈原因'} value={query.search} onChange={event => update({ search: event.target.value.slice(0, 200) })}/>}</div>
      {tab !== 'overview' && <div className="filters">{(tab === 'logs' ? [['', '全部'], ['diagnostic', '错误诊断'], ['performance', '性能日志']] : [['', '全部'], ['bad', '不符合预期'], ['good', '符合预期']]).map(([value, label]) => <button key={value} aria-pressed={query.filter === value} onClick={() => update({ filter: value })}>{label}</button>)}</div>}
      {loading && <p className="message" role="status">正在读取监控数据…</p>}
      {!error && data && <>{tab === 'overview' ? <><StatsCards stats={data.stats}/><Trend daily={data.stats.daily}/><div className="section-title"><h2>最近的路由反馈</h2><button className="mini" onClick={() => { setTab('router'); update({ filter: '' }) }}>查看全部 ›</button></div><FeedbackTable rows={data.feedback.rows.slice(0, 5)} open={row => void showHistory(row)}/></> : tab === 'router' ? <FeedbackTable rows={data.feedback.rows} open={row => void showHistory(row)}/> : <LogTable rows={data.logs.rows}/>}{tab !== 'overview' && <div className="pagination"><button className="mini" disabled={!query.offset || loading} onClick={() => update({ offset: Math.max(0, query.offset - 50) })}>上一页</button><span>{total ? `${query.offset + 1}—${Math.min(query.offset + 50, total)} / ${total}` : '0 条记录'}</span><button className="mini" disabled={query.offset + 50 >= (total || 0) || loading} onClick={() => update({ offset: query.offset + 50 })}>下一页</button></div>}</>}
      {historyLoading && <p className="message" role="status">正在读取反馈版本…</p>}{history && <section className="message"><div className="section-title"><h2>反馈版本</h2><button className="mini" onClick={() => setHistory(undefined)}>关闭</button></div>{history.map(row => <div className="history-item" key={row.event_id}><strong>版本 {row.revision} · {row.matches ? '符合预期' : '不符合预期'}</strong><p>{row.reason || '未填写原因'}</p><small>{date(row.saved_at)} · 实际：{labels[row.actual_action] || '未提供'} · 预期：{row.expected_kind ? labels[row.expected_kind] : '—'}</small></div>)}<small>最多展示最近 100 个反馈版本。</small></section>}
    </>}{error && <div className="message error" role="alert"><p>{error}</p>{signedIn && <button className="mini" onClick={() => setRefresh(value => value + 1)}>重试</button>}</div>}<footer>普通用户安装后无需登录。看板只显示已上传的诊断与反馈字段。</footer>
  </main></>
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('root')
  if (root) {
    let storage: Storage | undefined, persistent: Storage | undefined
    try { storage = sessionStorage } catch { /* The login can still work in memory when storage is unavailable. */ }
    try { persistent = localStorage } catch { /* Remember login is unavailable when persistent storage is blocked. */ }
    const callback = consumeSignInCallback(new URL(window.location.href), url => window.history.replaceState(null, '', url))
    createRoot(root).render(<Dashboard client={new DashboardClient(cloudMonitorConfig, storage, undefined, undefined, persistent)} callback={callback}/>)
  }
}
