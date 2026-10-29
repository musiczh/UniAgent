import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DEEPSEEK_BASE_URL, type DeepSeekConnectionSnapshot } from '@shared/deepseek'
import type { AgentDef } from '@shared/types'
import { RefreshIcon, UiIcon } from './Icons'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { AgentInstallFallback } from './AgentInstallFallback'

export function DeepSeekSettings({ agent, onRedetect, installation, defaultParameters }: {
  agent: AgentDef
  onRedetect: () => unknown
  installation: ReactNode
  defaultParameters: ReactNode
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<DeepSeekConnectionSnapshot>()
  const [baseUrl, setBaseUrl] = useState(DEEPSEEK_BASE_URL)
  const [apiKey, setApiKey] = useState('')
  const [action, setAction] = useState<'install' | 'check' | 'browser' | 'signout' | null>(null)
  const [loginMethod, setLoginMethod] = useState<'key' | 'browser'>('key')
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [reload, setReload] = useState(0)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    let current = true
    mounted.current = true
    void window.uniagent.getDeepSeekConnection().then(value => {
      if (current) {
        setSnapshot(value); setBaseUrl(value.baseUrl); setError('')
        if (['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(value.account?.phase || '')) setLoginMethod('browser')
      }
    }).catch(() => { if (current) setError('配置状态读取失败，请重试') })
    return () => { current = false; mounted.current = false }
  }, [reload])
  useEffect(() => window.uniagent.onDeepSeekChanged(value => setSnapshot(value)), [])
  const installed = !!snapshot?.installed
  const installing = action === 'install' || ['preparing', 'downloading', 'verifying', 'activating'].includes(snapshot?.installation?.phase || '')
  const loggingIn = action === 'browser' || ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(snapshot?.account?.phase || '')
  const ready = installed && (agent.lifecycle?.availability === 'available' || !!agent.lifecycle?.lastReadyAt) && !editing && !loggingIn
  const busy = action !== null || installing || loggingIn
  const sourceLabel = '系统加密保存 · 仅用于 UniAgent'
  const perform = async (next: 'install' | 'check' | 'browser' | 'signout'): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setAction(next); setError(''); setCancelling(false)
    try {
      const value = next === 'install' ? await window.uniagent.installDeepSeek()
        : next === 'browser' ? await window.uniagent.signInDeepSeek()
        : next === 'signout' ? await window.uniagent.signOutDeepSeek()
        : await window.uniagent.checkDeepSeekConnection({ baseUrl, ...(apiKey.trim() ? { apiKey } : {}) })
      if (!mounted.current) return
      setSnapshot(value); setBaseUrl(value.baseUrl)
      if (next === 'check' || next === 'browser') { setApiKey(''); setEditing(false) }
      if (next === 'install') {
        const refreshed = await window.uniagent.getDeepSeekConnection()
        if (mounted.current) setSnapshot(refreshed)
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : next === 'install' ? '安装失败，请重试' : '连接检查失败，请重试')
    } finally {
      pending.current = false
      if (mounted.current) { setAction(null); setCancelling(false) }
    }
  }
  const cancel = async (kind: 'install' | 'browser') => {
    if (cancelling) return
    setCancelling(true)
    try {
      if (kind === 'install') await window.uniagent.cancelDeepSeekInstall()
      else await window.uniagent.cancelDeepSeekSignIn()
    } catch { setError('取消失败，请重试'); setCancelling(false) }
  }
  const installText = { idle: '准备安装…', preparing: '正在准备运行环境，缺少时自动下载…', downloading: '正在下载并安装…', verifying: '下载完成，正在验证运行程序…', activating: '正在启用已验证的版本…', completed: '安装完成', cancelled: '已取消安装，可手动重试。', failed: '安装未完成，请重试。' }[snapshot?.installation?.phase || 'idle']
  const loginText = snapshot?.account?.phase === 'succeeded' ? '授权成功，正在加载模型…'
    : snapshot?.account?.phase === 'exchanging' ? '浏览器授权已返回，正在验证…'
    : snapshot?.account?.phase === 'committing' ? '正在保存登录状态…'
    : snapshot?.account?.phase === 'waiting-browser' ? '等待浏览器完成登录，授权后将自动返回 UniAgent。' : '正在准备浏览器授权…'
  const status = (label: string, tone: 'ok' | 'warn' | 'off' = 'off') => <span className="status-pill"><span className={`dot ${tone}`} /><span className={`txt-${tone}`}>{label}</span></span>

  if (!snapshot) return <SetGroup title="DeepSeek 配置"><SetRow label={error || '正在读取配置…'} control={error && <button className="set-mini-btn" onClick={() => { setError(''); setReload(value => value + 1) }}>重试</button>} /></SetGroup>
  if (ready) return <>
    <SetGroup title="DeepSeek 连接"><SetRow label={snapshot.account?.signedIn ? '账户' : 'API Key'} sub={snapshot.account?.signedIn ? '已通过浏览器登录 · 仅用于 UniAgent' : `已配置 · ${sourceLabel}`} control={<>
      {status(snapshot.account?.signedIn ? snapshot.account.phase === 'succeeded' ? '登录成功' : '已登录' : '已连接', 'ok')}<button className="set-mini-btn" onClick={() => { setEditing(true); setError(''); setLoginMethod(snapshot.account?.signedIn ? 'browser' : 'key') }}>管理登录</button>
    </>} /></SetGroup>
    {installation}
    {defaultParameters}
  </>
  return <div className="deepseek-setup">
    <p className="deepseek-setup-lead">DeepSeek 使用独立运行服务，配置与会话由 UniAgent 单独管理，不影响终端已有 dsh。</p>
    <section className={`deepseek-step${installed ? ' complete' : ' current'}`} aria-label="第一步，安装 Harness">
      <div className="deepseek-step-head">
        <span className="deepseek-step-number">{installed ? <UiIcon name="check" size={14} /> : '1'}</span>
        <div className="deepseek-step-main"><div className="deepseek-step-title">{agent.incompatible ? '修复 Harness' : '安装 Harness'}</div><div className="deepseek-step-sub">{installed ? `已安装${snapshot.version ? ` · ${snapshot.version}` : ''}` : 'Harness 是 DeepSeek 的本地运行程序，首次使用需先安装。'}</div></div>
        {installed ? status('已完成', 'ok') : <button className="set-mini-btn primary" disabled={busy} onClick={() => void perform('install')}>
          {installing && <RefreshIcon size={13} className="is-spinning" />}{installing ? '安装中…' : error || snapshot.installation?.phase === 'failed' ? '重试安装' : '一键安装'}
        </button>}
      </div>
      {!installed && <div className="deepseek-install-note"><button className="set-mini-btn" disabled={busy} onClick={() => void onRedetect()}>重新检测</button>{installing && <progress className="deepseek-install-progress" aria-label="安装进度" />}
        <span role="status">{installing ? installText : snapshot.installation?.phase === 'cancelled' ? installText : '程序安装到 UniAgent 独立目录；缺少运行环境时会自动补齐。'}</span>
        {installing && <button className="set-mini-btn" disabled={cancelling || !snapshot.installation?.cancellable} onClick={() => void cancel('install')}>{cancelling ? '正在取消…' : '取消'}</button>}
        {error && <div className="deepseek-setup-error" role="alert">{error}</div>}
        <AgentInstallFallback id="deepseek" name="DeepSeek Harness" failure={error || (snapshot.installation?.phase === 'failed' ? '受管服务安装未完成' : '')} /></div>}
    </section>
    <section className={`deepseek-step${installed ? ' current' : ' waiting'}`} aria-label="第二步，登录 DeepSeek">
      <div className="deepseek-step-head">
        <span className="deepseek-step-number">2</span>
        <div className="deepseek-step-main"><div className="deepseek-step-title">登录 DeepSeek</div><div className="deepseek-step-sub">{installed ? '填写 API Key，或通过浏览器登录授权。' : '安装完成后，选择登录方式。'}</div></div>
        {status(!installed ? '等待安装' : loggingIn ? '等待授权' : action === 'check' ? '检查中' : error ? '请重试' : '待登录', error && installed ? 'warn' : 'off')}
      </div>
      {installed && <div className="deepseek-connection-form">
        <div className="mcode-segments" role="group" aria-label="登录方式">
          <button className={`set-mini-btn${loginMethod === 'key' ? ' primary' : ''}`} aria-pressed={loginMethod === 'key'} disabled={busy} onClick={() => { setLoginMethod('key'); setError('') }}>API Key</button>
          {snapshot.account?.supported && <button className={`set-mini-btn${loginMethod === 'browser' ? ' primary' : ''}`} aria-pressed={loginMethod === 'browser'} disabled={busy} onClick={() => { setLoginMethod('browser'); setError('') }}>浏览器登录</button>}
        </div>
        {!snapshot.account?.supported && <p className="deepseek-step-sub">当前运行服务未提供浏览器授权能力，请使用 API Key。</p>}
        {agent.incompatible && <p className="deepseek-setup-error" role="alert">程序已安装，连接检测未完成：{agent.unavailableReason}<button className="set-mini-btn" onClick={() => void onRedetect()}>重新检测</button></p>}
        {loginMethod === 'browser' ? <div className="deepseek-connection-footer">
          <div className={error ? 'deepseek-setup-error' : 'deepseek-step-sub'} role={error ? 'alert' : 'status'}>{error || (loggingIn ? loginText : snapshot.account?.signedIn ? '已通过浏览器登录；可退出或重新授权。' : '在浏览器中登录并授权 DeepSeek，完成后自动显示登录成功。')}</div>
          {loggingIn ? <><button className="set-mini-btn" disabled={snapshot.account?.phase !== 'waiting-browser'} onClick={() => void window.uniagent.reopenDeepSeekSignIn().catch(() => setError('授权页面尚未就绪或浏览器未打开，请重试'))}>重新打开浏览器</button><button className="set-mini-btn" disabled={cancelling} onClick={() => void cancel('browser')}>{cancelling ? '正在取消…' : '取消登录'}</button></> : <>
            {snapshot.account?.signedIn && <button className="set-mini-btn" disabled={busy} onClick={() => void perform('signout')}>退出登录</button>}
            <button className="set-mini-btn primary" disabled={busy} onClick={() => void perform('browser')}>打开浏览器登录</button>
          </>}
        </div> : <>
        <SetRow label="API Key" sub={snapshot.hasKey ? `已配置 · ${sourceLabel}` : '从 DeepSeek 开放平台获取，密钥加密保存在本机。'} control={
          <input className="set-fld-inp mcode-key" aria-label="DeepSeek API Key" type="password" autoComplete="off" spellCheck={false} value={apiKey} placeholder={snapshot.hasKey ? '留空保留现有密钥' : '输入 API Key'} disabled={busy} onChange={event => { setApiKey(event.target.value); setError('') }} />
        } />
        <details className="deepseek-service-address"><summary>服务地址 · {baseUrl === DEEPSEEK_BASE_URL ? '默认使用 DeepSeek 官方服务' : '自定义服务'}</summary>
          <SetRow label="服务地址" control={<input className="set-fld-inp" aria-label="DeepSeek 服务地址" value={baseUrl} disabled={busy} onChange={event => { setBaseUrl(event.target.value); setError('') }} />} />
        </details>
        <div className="deepseek-connection-footer">
          <div className={error ? 'deepseek-setup-error' : 'deepseek-step-sub'} role={error ? 'alert' : 'status'}>{error || (action === 'check' ? '正在验证 API Key 与模型连接…' : '检查会发起一次模型请求，可能消耗少量额度。')}</div>
          <button className="set-mini-btn primary" disabled={busy || !baseUrl.trim() || (!apiKey.trim() && !snapshot.hasKey)} onClick={() => void perform('check')}>
            {action === 'check' && <RefreshIcon size={13} className="is-spinning" />}{action === 'check' ? '检查中…' : error ? '重新检查连接' : '检查连接'}
          </button>
        </div>
        </>}
      </div>}
    </section>
    {installed && <details className="deepseek-install-details"><summary>安装详情与更新</summary>{installation}</details>}
  </div>
}
