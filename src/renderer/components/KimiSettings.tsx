import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentDef } from '@shared/types'
import type { KimiSetupSnapshot } from '@shared/kimiOnboarding'
import { AgentInstallFallback } from './AgentInstallFallback'
import { SetRow } from './SettingsPrimitives'
import { kimiErrorCopy } from '@shared/kimiErrors'

export function KimiSettings({ agent, installation, defaultParameters }: {
  agent: AgentDef; installation?: ReactNode; defaultParameters?: ReactNode
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<KimiSetupSnapshot>({ phase: 'idle', cancellable: false })
  const [pending, setPending] = useState(false)
  const [method, setMethod] = useState<'browser' | 'key'>('browser')
  const [region, setRegion] = useState<'cn' | 'global'>('cn')
  const [apiKey, setApiKey] = useState('')
  const [failure, setFailure] = useState('')
  const locked = useRef(false), mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const off = window.uniagent.onKimiSetupChanged(value => { if (mounted.current) setSnapshot(value) })
    void window.uniagent.getKimiSetup().then(value => { if (mounted.current) setSnapshot(value) }).catch(() => { if (mounted.current) setFailure('状态读取失败，请重新检测') })
    return () => { mounted.current = false; off() }
  }, [])
  const busy = pending || snapshot.cancellable
  const installed = agent.lifecycle ? agent.installed === true : snapshot.status ? snapshot.status !== 'uninstalled' : agent.installed === true
  const ready = agent.lifecycle ? agent.lifecycle.availability === 'available' || !!agent.lifecycle.lastReadyAt : snapshot.status === 'ready'
  const detectionFailed = agent.lifecycle ? agent.lifecycle.detectionStatus === 'failed' || agent.incompatible : snapshot.status === 'incompatible'
  const error = failure || (snapshot.phase === 'failed' || snapshot.phase === 'cancelled' ? snapshot.message : '') || ''
  const perform = async (action: 'install' | 'check' | 'login') => {
    if (locked.current) return
    locked.current = true; setPending(true); setFailure('')
    try {
      const value = await (action === 'install' ? window.uniagent.installKimi() : action === 'check' ? window.uniagent.checkKimiSetup()
        : window.uniagent.signInKimi({ region, ...(method === 'key' ? { apiKey: apiKey.trim() } : {}) }))
      if (mounted.current) { setSnapshot(value); if (value.status === 'ready') setApiKey('') }
    } catch { if (mounted.current) setFailure('操作未完成，请重新检测或重试') }
    finally { locked.current = false; if (mounted.current) setPending(false) }
  }
  const cancel = () => window.uniagent.cancelKimiSetup().catch(() => { if (mounted.current) setFailure('取消失败，请重试') })
  const reopen = () => window.uniagent.reopenKimiSignIn().catch(() => { if (mounted.current) setFailure('授权页面尚未就绪或浏览器未打开，请重试') })
  if (ready) return <>{installation}{error && <p role="alert" className="deepseek-setup-error">{error}</p>}{defaultParameters}</>
  return <div className="deepseek-setup mcode-setup">
    <p className="deepseek-setup-lead">优先复用本机程序、已有账号与第三方模型配置。</p>
    <section className={`deepseek-step${installed ? ' complete' : ' current'}`} aria-label="第一步，安装 Kimi Code">
      <div className="deepseek-step-head"><div className="deepseek-step-main"><div className="deepseek-step-title">{installed ? 'Kimi Code 已安装' : '安装 Kimi Code'}</div><div className="deepseek-step-sub">{installed ? `${snapshot.version || agent.version || ''} · ${agent.bin}` : '安装到当前用户的 ~/.local/bin，终端与 UniAgent 共用。已有私有安装继续复用。'}</div></div>
        <div className="mcode-actions">{!installed && !detectionFailed && <button className="set-mini-btn primary" disabled={busy} onClick={() => void perform('install')}>{busy ? '安装中…' : error ? '重试安装' : '一键安装'}</button>}<button className="set-mini-btn" disabled={busy} onClick={() => void perform('check')}>重新检测</button>{snapshot.cancellable && <button className="set-mini-btn" onClick={() => void cancel()}>取消</button>}</div>
      </div>
      {!installed && <div className="deepseek-install-note">{busy && <progress aria-label="Kimi 安装进度" {...(snapshot.totalBytes ? { max: snapshot.totalBytes, value: snapshot.receivedBytes || 0 } : {})} />}{error && <p className="deepseek-setup-error" role="alert">{error}</p>}<AgentInstallFallback id="kimi" name="Kimi Code" failure={error} /></div>}
    </section>
    <section className={`deepseek-step${installed ? ' current' : ' waiting'}`} aria-label="第二步，登录 Kimi Code">
      <div className="deepseek-step-head"><div className="deepseek-step-main"><div className="deepseek-step-title">{snapshot.phase === 'login' ? '等待浏览器授权' : '登录 Kimi Code'}</div><div className="deepseek-step-sub">{!installed ? '安装后自动检查已有连接。' : detectionFailed ? '检测未完成，请先重新检测程序与模型配置。' : '选择一种连接方式，已有有效 Provider 将直接复用。'}</div></div></div>
      {installed && <div className="deepseek-connection-form">
        {error && <p className="deepseek-setup-error" role="alert">{error}</p>}
        {detectionFailed ? <p className="deepseek-step-sub">{kimiErrorCopy(snapshot.message || agent.unavailableReason)?.hint || snapshot.message || agent.unavailableReason}</p> : snapshot.phase === 'login' ? <><p>请在官方浏览器完成授权，完成后自动复查。</p><div className="mcode-actions"><button className="set-mini-btn" disabled={!snapshot.canReopen} onClick={() => void reopen()}>重新打开浏览器</button><button className="set-mini-btn" onClick={() => void cancel()}>取消等待</button></div></> : <>
          <div className="mcode-segments" role="group" aria-label="登录方式"><button aria-pressed={method === 'browser'} disabled={busy} onClick={() => setMethod('browser')}>浏览器登录</button><button aria-pressed={method === 'key'} disabled={busy} onClick={() => setMethod('key')}>Platform API Key</button></div>
          <SetRow label="账号区域" control={<div className="mcode-segments" role="group" aria-label="Kimi 账号区域"><button aria-pressed={region === 'cn'} disabled={busy} onClick={() => setRegion('cn')}>中国大陆</button><button aria-pressed={region === 'global'} disabled={busy} onClick={() => setRegion('global')}>Global</button></div>} />
          {method === 'key' && <SetRow label="Platform API Key" sub="开放平台 Key 与 Code 订阅不同；按 Kimi 原生配置保存，仅当前用户可读写。" control={<input className="set-fld-inp mcode-key" aria-label="Kimi Platform API Key" type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy} placeholder="输入 Platform API Key" onChange={event => setApiKey(event.target.value)} />} />}
          <div className="deepseek-connection-footer"><span className="deepseek-step-sub">{method === 'key' ? '验证模型目录，不发送模型任务；保留已有 Provider。' : '使用官方账号授权，完成后自动检查。'}</span><button className="set-mini-btn primary" disabled={busy || method === 'key' && !apiKey.trim()} onClick={() => void perform('login')}>{busy ? '验证中…' : method === 'key' ? '使用 API Key 登录' : '一键登录'}</button></div>
        </>}
      </div>}
    </section>
  </div>
}
