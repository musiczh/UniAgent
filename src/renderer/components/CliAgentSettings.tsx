import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentDef } from '@shared/types'
import type { CliSetupId, CliSetupSnapshot } from '@shared/agentSetup'
import { AgentInstallFallback } from './AgentInstallFallback'
import { UiIcon } from './Icons'

export function CliAgentSettings({ agent, onRedetect, installation, defaultParameters, onOpenModels }: {
  agent: AgentDef; onRedetect: () => unknown; installation: ReactNode; defaultParameters: ReactNode; onOpenModels: () => void
}): JSX.Element {
  const id = agent.id as CliSetupId
  const [snapshot, setSnapshot] = useState<CliSetupSnapshot>({ phase: 'idle', cancellable: false })
  const [method, setMethod] = useState<'browser' | 'key' | 'sso'>('browser')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const locked = useRef(false), mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const off = window.uniagent.onAgentSetupChanged(value => { if (value.id === id && mounted.current) setSnapshot(value.snapshot) })
    void window.uniagent.getAgentSetup(id).then(value => { if (mounted.current) setSnapshot(value) }).catch(() => { if (mounted.current) setError('准备状态读取失败，请重试检测') })
    return () => { mounted.current = false; off() }
  }, [id])
  const busy = pending || snapshot.cancellable
  const installed = agent.installed === true
  const ready = agent.lifecycle?.availability === 'available' || !!agent.lifecycle?.lastReadyAt
  const failedDetection = agent.incompatible || agent.lifecycle?.detectionStatus === 'failed'
  const failure = error || snapshot.message || (agent.lifecycle?.detectionStatus === 'failed' ? agent.lifecycle.detectionError : '') || ''
  const perform = async (action: 'install' | 'login' | 'detect') => {
    if (locked.current) return
    locked.current = true; setPending(true); setError('')
    try {
      if (action === 'detect') await onRedetect()
      else {
        const value = action === 'install' ? await window.uniagent.installAgent(id) : await window.uniagent.signInAgent(id, { method, ...(method === 'key' ? { apiKey: apiKey.trim() } : {}) })
        if (mounted.current) { setSnapshot(value); if (value.phase === 'idle') setApiKey('') }
      }
    } catch { if (mounted.current) setError('操作未完成，请检查网络、程序和配置后重试') }
    finally { locked.current = false; if (mounted.current) setPending(false) }
  }
  const reopen = async () => {
    try { await window.uniagent.reopenAgentSignIn(id) }
    catch { if (mounted.current) setError('授权页面尚未就绪或已过期，请重试登录') }
  }
  const cancel = async () => {
    try { await window.uniagent.cancelAgentSetup(id) }
    catch { if (mounted.current) setError('取消未完成，请重试') }
  }
  const waiting = snapshot.phase === 'login'
  if (ready) return <>{installation}{failure && <p className="deepseek-setup-error" role="alert">{failure}</p>}{defaultParameters}</>
  const detect = <button className="set-mini-btn" disabled={busy} onClick={() => void perform('detect')}>重新检测</button>
  return <div className="deepseek-setup mcode-setup">
    <p className="deepseek-setup-lead">优先复用本机程序与已有连接，只完成尚未就绪的步骤。</p>
    <section className={`deepseek-step${installed ? ' complete' : ' current'}`} aria-label={`第一步，安装 ${agent.name}`}>
      <div className="deepseek-step-head">
        <span className="deepseek-step-number">{installed ? <UiIcon name="check" size={14} /> : '1'}</span>
        <div className="deepseek-step-main"><div className="deepseek-step-title">{installed ? `${agent.name} 已安装` : `安装 ${agent.name}`}</div><div className="deepseek-step-sub">{installed ? `${agent.version || ''} · 已复用本机程序` : '安装后，终端与 UniAgent 共用同一份程序。'}</div></div>
        <div className="mcode-actions">{!installed && !failedDetection && <button className="set-mini-btn primary" disabled={busy} onClick={() => void perform('install')}>{snapshot.phase === 'installing' ? '安装中…' : failure ? '重试安装' : '一键安装'}</button>}{detect}{snapshot.cancellable && <button className="set-mini-btn" onClick={() => void cancel()}>取消</button>}</div>
      </div>
      <div className="deepseek-install-note">
        {installed ? <code>{agent.bin}</code> : <>
          {snapshot.phase === 'installing' && <progress className="deepseek-install-progress" aria-label="正在安装官方程序" />}
          {failure && <p className="deepseek-setup-error" role="alert">{failure}</p>}
          <AgentInstallFallback id={id} name={agent.name} failure={failure} />
        </>}
      </div>
    </section>
    <section className={`deepseek-step${installed ? ' current' : ' waiting'}`} aria-label={`第二步，登录 ${agent.name}`}>
      <div className="deepseek-step-head"><span className="deepseek-step-number">2</span><div className="deepseek-step-main"><div className="deepseek-step-title">{waiting ? '等待官方授权' : `登录 ${agent.name}`}</div><div className="deepseek-step-sub">{!installed ? '安装完成后，自动检查已有登录与模型配置。' : failedDetection ? '检测未完成，原有配置已保留。请先重新检测。' : '选择一种连接方式，完成后自动检查。'}</div></div></div>
      {installed && <div className="deepseek-connection-form">
        {failure && <p className="deepseek-setup-error" role="alert">{failure}</p>}
        {failedDetection ? <p className="deepseek-step-sub">{agent.lifecycle?.detectionError || agent.unavailableReason}</p> : waiting ? <>
          <p className="deepseek-step-sub">请在官方浏览器完成授权，完成后自动复查。</p>
          {snapshot.deviceCode && <p>设备验证码：<code>{snapshot.deviceCode}</code></p>}
          <div className="mcode-actions"><button className="set-mini-btn primary" disabled={!snapshot.canReopen} onClick={() => void reopen()}>重新打开浏览器</button><button className="set-mini-btn" onClick={() => void cancel()}>取消等待</button></div>
        </> : <>
          <div className="mcode-segments" role="group" aria-label="登录方式">
            <button aria-pressed={method === 'browser'} disabled={busy} onClick={() => setMethod('browser')}>{id === 'traex' ? '自动登录' : '浏览器登录'}</button>
            <button aria-pressed={method !== 'browser'} disabled={busy} onClick={() => setMethod(id === 'traex' ? 'sso' : 'key')}>{id === 'traex' ? 'SSO 登录' : 'API Key 登录'}</button>
          </div>
          {id === 'traex' ? <p className="deepseek-step-sub">优先复用 Codebase 企业身份；当前 CLI 未提供已确认的 API Key 登录入口。</p>
            : method === 'key' && <><input className="set-fld-inp mcode-key" aria-label={`${agent.name} API Key`} type="password" autoComplete="off" spellCheck={false} placeholder="输入 API Key" disabled={busy} value={apiKey} onChange={event => setApiKey(event.target.value)} />
              <p className="deepseek-step-sub">{id === 'codex' ? '通过 Codex 原生凭据机制保存。' : '加密保存在本机，仅供 UniAgent 使用；保留已有原生登录。'}</p>
              {id === 'claude' && <button className="set-mini-btn" onClick={onOpenModels}>使用第三方来源 · 模型配置</button>}</>}
          <div className="deepseek-connection-footer"><span className="deepseek-step-sub">{method === 'key' ? '验证认证与模型目录，不发送模型任务。' : '将使用官方登录流程，授权后自动复查。'}</span><button className="set-mini-btn primary" disabled={busy || method === 'key' && !apiKey.trim()} onClick={() => void perform('login')}>{busy ? '验证中…' : method === 'key' ? '使用 API Key 登录' : '一键登录'}</button></div>
        </>}
      </div>}
    </section>
  </div>
}
