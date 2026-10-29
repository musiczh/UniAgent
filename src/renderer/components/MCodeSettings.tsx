import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MCodeConnectionSnapshot } from '@shared/mcode'
import { agentInitializationPrompt } from '@shared/agentInitialization'
import type { AgentDef } from '@shared/types'
import { RefreshIcon, UiIcon } from './Icons'
import { SetGroup, SetRow } from './SettingsPrimitives'

export function MCodeSettings({ agent, onRedetect, installation, defaultParameters }: {
  agent: AgentDef
  onRedetect: () => unknown
  installation: ReactNode
  defaultParameters: ReactNode
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<MCodeConnectionSnapshot>()
  const [apiKey, setApiKey] = useState('')
  const [method, setMethod] = useState<'browser' | 'key'>('browser')
  const [region, setRegion] = useState<'cn' | 'global'>('cn')
  const [action, setAction] = useState<'install' | 'check' | 'browser' | 'key' | null>(null)
  const [error, setError] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  const wasReady = useRef(agent.lifecycle?.availability === 'available')
  if (snapshot?.status === 'ready') wasReady.current = true
  else if (snapshot && snapshot.status !== 'failed') wasReady.current = false
  const installed = snapshot?.installed ?? agent.installed === true
  const busy = action !== null || snapshot?.cancellable === true
  const ready = snapshot?.status === 'ready' || wasReady.current && (!snapshot || snapshot.status === 'failed')
  useEffect(() => {
    let current = true
    mounted.current = true
    void window.uniagent.getMCodeConnection().then(value => {
      if (current) { setSnapshot(value); setRegion(value.region) }
    }).catch(() => { if (current) setError('配置状态读取失败，请重新检测') })
    return () => { current = false; mounted.current = false }
  }, [agent.bin, agent.lifecycle?.checkedAt])
  useEffect(() => {
    if (!busy) return
    let current = true
    const timer = setInterval(() => {
      void window.uniagent.getMCodeConnection().then(value => {
        if (!current) return
        setSnapshot(value)
        if (!value.cancellable) { current = false; clearInterval(timer); if (action === null) void onRedetect() }
      }).catch(() => {})
    }, 1000)
    return () => { current = false; clearInterval(timer) }
  }, [busy, action])

  const perform = async (next: NonNullable<typeof action>): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setAction(next); setError(''); setNotice('')
    try {
      const value = next === 'install' ? await window.uniagent.installMCode()
        : next === 'browser' ? await window.uniagent.signInMCode(region)
        : next === 'key' ? await window.uniagent.checkMCodeConnection({ apiKey: apiKey.trim(), region })
        : await window.uniagent.getMCodeConnection()
      if (mounted.current) { setSnapshot(value); if (next === 'key') setApiKey('') }
      await onRedetect()
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作未完成，请重试')
        if (next === 'install') setPromptOpen(true)
        await window.uniagent.getMCodeConnection().then(value => { if (mounted.current) setSnapshot(value) }).catch(() => {})
      }
    } finally {
      pending.current = false
      if (mounted.current) setAction(null)
    }
  }
  const cancel = async () => {
    try { await window.uniagent.cancelMCodeOperation() }
    catch { if (mounted.current) setError('取消未完成，请重试') }
  }
  const reopen = async () => {
    try { await window.uniagent.reopenMCodeSignIn(); if (mounted.current) setError('') }
    catch { if (mounted.current) setError('授权页面尚未就绪或浏览器未打开，请稍后重试') }
  }
  const failure = error || snapshot?.message || ''
  const prompt = (failure ? `本次自动安装未完成：${failure}\n请先核对失败阶段，保留已完成步骤。\n\n` : '') + agentInitializationPrompt('mcode', 'MiniMax Code')
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); if (mounted.current) setNotice('安装提示词已复制') }
    catch { if (mounted.current) setNotice('复制失败，请选中上方提示词手动复制') }
  }
  const status = (text: string, tone: 'ok' | 'warn' | 'off' = 'off') => <span className="status-pill"><span className={`dot ${tone}`} /><span className={`txt-${tone}`}>{text}</span></span>
  const checking = <button className="set-mini-btn" disabled={busy} onClick={() => void perform('check')}><RefreshIcon size={13} />重新检测</button>
  const failureBlock = failure && <p className="deepseek-setup-error" role="alert">{failure}</p>
  if (ready) return <>{installation}{failureBlock}{defaultParameters}</>
  if (!snapshot && !error) return <SetGroup title="MiniMax Code 配置"><SetRow label="正在检测本机程序与已有登录…" /></SetGroup>
  if (!snapshot || snapshot.status === 'failed' && !installed) return <SetGroup title="MiniMax Code 检测"><SetRow label="检测未完成" sub={failure} control={checking} /></SetGroup>

  const installing = action === 'install' || snapshot.phase === 'installing'
  const browser = action === 'browser' || snapshot.phase === 'login'
  return <div className="deepseek-setup mcode-setup">
    <p className="deepseek-setup-lead">自动复用已有程序和登录，只完成尚未就绪的步骤。</p>
    <section className={`deepseek-step${installed ? ' complete' : ' current'}`} aria-label="第一步，安装 MiniMax Code">
      <div className="deepseek-step-head">
        <span className="deepseek-step-number">{installed ? <UiIcon name="check" size={14} /> : '1'}</span>
        <div className="deepseek-step-main">
          <div className="deepseek-step-title">{installed ? 'MiniMax Code 已安装' : installing ? '正在安装 MiniMax Code' : '安装 MiniMax Code'}</div>
          <div className="deepseek-step-sub">{installed ? `${snapshot.version} · 已复用本机程序` : '未检测到本机 mcode。'}</div>
        </div>
        {installed ? status('已安装', 'ok') : <div className="mcode-actions">
          <button className="set-mini-btn primary" disabled={busy} onClick={() => void perform('install')}>{installing ? '安装中…' : failure ? '重试安装' : '一键安装'}</button>
          {busy ? snapshot.cancellable && <button className="set-mini-btn" onClick={() => void cancel()}>取消</button> : checking}
        </div>}
      </div>
      {installed ? <div className="deepseek-install-note"><code>{snapshot.bin || agent.bin}</code></div>
        : <div className="deepseek-install-note">
          {installing ? <><progress aria-label="MiniMax Code 安装进度" className="deepseek-install-progress" /><span>正在安装官方程序，完成后自动检测登录状态。</span></> : <>
            {failureBlock}<p>安装后，终端与 UniAgent 共用同一份程序。</p>
            <button className="mcode-prompt-toggle" aria-expanded={promptOpen} onClick={() => setPromptOpen(value => !value)}><UiIcon name="chevron-right" size={12} /><span>备用方式：提示词安装</span></button>
            {promptOpen && <div className="mcode-prompt">
              <p>复制给外部 Agent，协助完成本机安装。无需 UniAgent 已有可用 Agent。</p>
              <textarea aria-label="完整安装提示词" readOnly value={prompt} />
              <button className="set-mini-btn primary" onClick={() => void copy()}>复制安装提示词</button>
              <p>外部安装完成后，点击上方“重新检测”。</p>
              {notice && <p role="status">{notice}</p>}
            </div>}
          </>}
        </div>}
    </section>
    <section className={`deepseek-step${installed ? ' current' : ' waiting'}`} aria-label="第二步，登录 MiniMax Code">
      <div className="deepseek-step-head">
        <span className="deepseek-step-number">2</span>
        <div className="deepseek-step-main">
          <div className="deepseek-step-title">{browser ? '等待浏览器授权' : snapshot.status === 'failed' ? '连接检测未完成' : '登录 MiniMax Code'}</div>
          <div className="deepseek-step-sub">{!installed ? '安装完成后，自动检查已有登录与模型配置。' : browser ? '请在 MiniMax 官方页面完成登录，完成后自动检测。' : '选择一种登录方式，完成后即可使用。'}</div>
        </div>
        {status(!installed ? '等待安装' : browser ? '登录中' : action === 'key' ? '验证中' : snapshot.status === 'failed' ? '检测失败' : '待登录', snapshot.status === 'failed' ? 'warn' : 'off')}
      </div>
      {installed && <div className="deepseek-connection-form">
        {snapshot.status === 'failed' && !busy ? <>{failureBlock}{checking}</> : browser ? <>
          {failureBlock}<div className="mcode-actions"><button className="set-mini-btn primary" onClick={() => void reopen()}>重新打开浏览器</button><button className="set-mini-btn" onClick={() => void cancel()}>取消等待</button></div>
        </> : <>
          <div className="mcode-segments" role="group" aria-label="登录方式">
            <button aria-pressed={method === 'browser'} disabled={busy} onClick={() => setMethod('browser')}>浏览器登录</button>
            <button aria-pressed={method === 'key'} disabled={busy} onClick={() => setMethod('key')}>API Key 登录</button>
          </div>
          {method === 'browser' ? <SetRow label="账号区域" control={<div className="mcode-segments" role="group" aria-label="MiniMax 账号区域">
            <button aria-pressed={region === 'cn'} disabled={busy} onClick={() => setRegion('cn')}>中国大陆</button>
            <button aria-pressed={region === 'global'} disabled={busy} onClick={() => setRegion('global')}>Global</button>
          </div>} /> : <SetRow label="MiniMax API Key" control={<input className="set-fld-inp mcode-key" type="password" aria-label="MiniMax API Key" placeholder="输入 API Key" autoComplete="off" spellCheck={false} disabled={busy} value={apiKey} onChange={event => { setApiKey(event.target.value); setError('') }} />} />}
          <div className="deepseek-connection-footer">
            <div className={failure ? 'deepseek-setup-error' : 'deepseek-step-sub'} role={failure ? 'alert' : 'status'}>{failure || (method === 'browser' ? '将打开 MiniMax 官方页面，完成授权后自动检测。' : '验证模型连接可能消耗少量额度。')}</div>
            <button className="set-mini-btn primary" disabled={busy || method === 'key' && !apiKey.trim()} onClick={() => void perform(method === 'browser' ? 'browser' : 'key')}>{busy ? '验证中…' : method === 'browser' ? '一键登录' : '使用 API Key 登录'}</button>
          </div>
        </>}
      </div>}
    </section>
  </div>
}
