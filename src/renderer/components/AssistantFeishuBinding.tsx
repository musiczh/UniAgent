import { useEffect, useRef, useState } from 'react'
import type { AssistantFeishuState } from '@shared/assistant'
import type { FeishuStatus } from '@shared/types'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { UiIcon } from './Icons'

const sessionState = (status: FeishuStatus): AssistantFeishuState => ({ configured: !!status.appId, configuring: status.configuring, status })
const bindingError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
const bindingApis = {
  assistant: {
    get: () => window.uniagent.getAssistantFeishu(),
    bind: (appId: string, appSecret: string) => window.uniagent.bindAssistantFeishu({ appId, appSecret }),
    disconnect: () => window.uniagent.bindAssistantFeishu(null),
    install: () => window.uniagent.installAssistantFeishu(),
    cancel: () => window.uniagent.cancelAssistantFeishuInstall(),
    subscribe: (refresh: () => void) => window.uniagent.onAssistantFeishuChanged(refresh)
  },
  session: {
    get: async () => sessionState(await window.uniagent.feishuStatus()),
    bind: async (appId: string, appSecret: string) => sessionState(await window.uniagent.feishuBind({ appId, appSecret })),
    disconnect: async () => sessionState(await window.uniagent.feishuStop()),
    install: async () => sessionState(await window.uniagent.feishuInstall()),
    cancel: async () => sessionState(await window.uniagent.feishuCancelInstall()),
    subscribe: (refresh: () => void) => window.uniagent.onFeishuInstallProgress(refresh)
  }
}

export function FeishuBinding({ disabled = false, onDirtyChange, scope = 'assistant' }: {
  disabled?: boolean
  onDirtyChange?(dirty: boolean): void
  scope?: 'assistant' | 'session'
}): JSX.Element {
  const api = bindingApis[scope]
  const session = scope === 'session'
  const [state, setState] = useState<AssistantFeishuState>()
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(false)
  const [appId, setAppId] = useState(''), [secret, setSecret] = useState(''), [showSecret, setShowSecret] = useState(false)
  const [error, setError] = useState('')
  const installVersion = useRef(0)
  const dirty = (session ? manual : expanded) && (appId !== (state?.status.appId || '') || !!secret)
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    let active = true
    let version = 0
    const refresh = () => {
      const current = ++version
      void api.get().then(value => {
        if (!active || version !== current) return
        setState(value)
        if (value.configuring) setExpanded(true)
        if (!dirtyRef.current) setAppId(value.status.appId || '')
        if (value.configured && !value.configuring) { setExpanded(false); setManual(false); setSecret(''); setShowSecret(false) }
      }, error => { if (active && version === current) setError(bindingError(error)) })
    }
    refresh()
    const stop = api.subscribe(refresh)
    return () => { active = false; installVersion.current++; stop() }
  }, [api])
  const locked = disabled || busy || !state || !!state.configuring
  const reset = (value: AssistantFeishuState) => { setState(value); setAppId(value.status.appId || ''); setSecret(''); setShowSecret(false); setExpanded(false); setManual(false) }
  const bind = async () => {
    setBusy(true); setError('')
    try {
      const value = await api.bind(appId, secret)
      if (value.status.phase === 'failed') { setState(value); setError(value.status.message || '连接失败，请检查机器人配置后重试') }
      else reset(value)
    } catch (error) { setError(bindingError(error)) }
    finally { setBusy(false) }
  }
  const unbind = async () => {
    setBusy(true); setError('')
    try { reset(await api.disconnect()) }
    catch (error) { setError(bindingError(error)) }
    finally { setBusy(false) }
  }
  const install = async () => {
    if (dirty && !window.confirm('使用浏览器选择机器人会替换未保存的手工配置，继续？')) return
    const version = ++installVersion.current
    setBusy(true); setError('')
    setSecret(''); setShowSecret(false); setAppId(state?.status.appId || '')
    try {
      const value = await api.install()
      if (version !== installVersion.current) return
      if (value.configuring) setState(value)
      else if (value.status.phase === 'failed') { setState(value); setError(value.status.message || '连接失败，请检查机器人配置后重试') }
      else reset(value)
    } catch (error) { if (version === installVersion.current) setError(bindingError(error)) }
    finally { if (version === installVersion.current) setBusy(false) }
  }
  const cancelInstall = async () => {
    const version = ++installVersion.current
    setBusy(true)
    try { const value = await api.cancel(); if (version === installVersion.current) { setState(value); setError('') } }
    catch (error) { if (version === installVersion.current) setError(bindingError(error)) }
    finally { if (version === installVersion.current) setBusy(false) }
  }
  const label = !state ? '读取中…' : state.configuring ? state.status.phase === 'awaiting-scan' ? '等待授权' : '配置中' : state.status.connected ? '已连接' : state.status.phase === 'failed' ? '连接失败' : !state.configured ? '未绑定' : state.status.phase === 'installing' ? '连接中' : '未连接'
  return <SetGroup title="飞书机器人">
    <SetRow label={<><UiIcon name="feishu" size={16} />{state?.configured ? session ? state.status.botName || '飞书机器人' : '飞书机器人' : '绑定飞书机器人'}</>} sub={state?.configured ? undefined : session ? '绑定后即可配置 Session 飞书同步' : '在飞书中与个人助手对话'} onClick={session || state?.configured ? undefined : () => {
      if (locked) return
      if (expanded && dirty && !window.confirm('放弃未保存的机器人配置？')) return
      setExpanded(value => !value); setSecret(''); setShowSecret(false); setAppId(state?.status.appId || '')
    }} control={<div className="assistant-bind-actions"><span className="status-pill"><span className={'dot ' + (state?.status.connected ? 'ok' : 'off')} /><span className={state?.status.connected ? 'txt-ok' : 'txt-off'}>{label}</span></span>{state?.configured && <button className="set-mini-btn" disabled={locked} onClick={() => void unbind()}>断开</button>}</div>} />
    {error && <p className="assistant-error assistant-bind-form" role="alert">{error}</p>}
    {state?.status.phase === 'failed' && state.status.message && !error && <p className="assistant-error assistant-bind-form" role="status">{state.status.message}</p>}
    {state && (!state.configured || state.configuring) && (session || expanded) && <div className="assistant-bind-form">
      {(!session || !manual) && <div className={session ? 'assistant-bind-actions' : 'assistant-bind-intro'}>{!session && <p className="assistant-hint">浏览器选择机器人，授权后自动绑定；也可手动填写凭证。</p>}<button className="set-mini-btn primary" disabled={locked} onClick={() => void install()}><UiIcon name="external-link" size={14} />{state?.configuring ? '配置中…' : '一键配置'}</button>{session && <button className="set-mini-btn" disabled={locked} onClick={() => { setManual(true); setError('') }}>手动配置</button>}</div>}
      {state?.configuring && <div className="assistant-bind-progress">
        <p className="assistant-hint" role="status">{state.status.message || '正在准备飞书授权…'}</p>
        <div className="assistant-bind-actions">
          {state.status.verificationUrl && <button className="set-mini-btn" onClick={() => void window.uniagent.openExternal(state.status.verificationUrl!)}>打开授权页面</button>}
          <button className="set-mini-btn" disabled={state.status.phase === 'awaiting-login'} onClick={() => void cancelInstall()}>取消配置</button>
        </div>
      </div>}
      {(!session || manual) && <>
        <div className="set-fld"><label htmlFor={`${scope}-feishu-app-id`}>App ID</label><input id={`${scope}-feishu-app-id`} className="set-fld-inp mono" placeholder="cli_…" value={appId} disabled={locked} onChange={event => setAppId(event.target.value)} /></div>
        <div className="set-fld"><label htmlFor={`${scope}-feishu-secret`}>{session ? 'App Secret（API Key）' : 'App Secret'}</label><span className="secret-row"><input id={`${scope}-feishu-secret`} className="set-fld-inp mono" type={showSecret ? 'text' : 'password'} autoComplete="off" placeholder="输入 App Secret" value={secret} disabled={locked} onChange={event => setSecret(event.target.value)} /><button className="set-mini-btn ghost" disabled={locked} onClick={() => setShowSecret(value => !value)}>{showSecret ? '隐藏' : '显示'}</button></span></div>
        <div className="assistant-bind-actions"><button className="set-mini-btn primary" disabled={locked || !appId.trim() || !secret.trim()} onClick={() => void bind()}>{busy ? '处理中…' : '绑定并连接'}</button><button className="set-mini-btn" disabled={locked} onClick={() => { setExpanded(false); setManual(false); setAppId(''); setSecret(''); setShowSecret(false) }}>取消</button></div>
      </>}
    </div>}
  </SetGroup>
}
