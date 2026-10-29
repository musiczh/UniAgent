import { useEffect, useMemo, useRef, useState } from 'react'
import encodeQR from 'qr'
import type { AssistantWeixinState } from '@shared/weixin'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { UiIcon } from './Icons'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
export function AssistantWeixinBinding({ disabled = false }: { disabled?: boolean }): JSX.Element {
  const [state, setState] = useState<AssistantWeixinState>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const revision = useRef(0)
  const operation = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const refresh = () => {
      const current = ++revision.current
      void window.uniagent.getAssistantWeixin().then(value => {
        if (mounted.current && current === revision.current) setState(value)
      }, error => { if (mounted.current && current === revision.current) setError(errorText(error)) })
    }
    refresh()
    const stop = window.uniagent.onAssistantWeixinChanged(refresh)
    return () => { mounted.current = false; revision.current++; stop() }
  }, [])
  const run = async (action: () => Promise<AssistantWeixinState>) => {
    const current = ++operation.current
    setBusy(true); setError('')
    try { const value = await action(); if (mounted.current && current === operation.current) { revision.current++; setState(value) } }
    catch (error) { if (mounted.current && current === operation.current) setError(errorText(error)) }
    finally { if (mounted.current && current === operation.current) setBusy(false) }
  }
  return <WeixinBindingView state={state} disabled={disabled || busy && state?.phase !== 'connecting'} error={error}
    onLogin={() => void run(() => window.uniagent.loginAssistantWeixin())}
    onDisconnect={() => void run(() => window.uniagent.disconnectAssistantWeixin())}
    onVerify={code => void run(() => window.uniagent.verifyAssistantWeixin(code))}
    onOpenSession={id => window.dispatchEvent(new CustomEvent('uniagent-open-assistant-session', { detail: id }))} />
}

export function WeixinBindingView({ state, disabled = false, error, onLogin, onDisconnect, onVerify, onOpenSession }: {
  state?: AssistantWeixinState; disabled?: boolean; error?: string
  onLogin(): void; onDisconnect(): void; onVerify(code: string): void; onOpenSession(id: string): void
}): JSX.Element {
  const [code, setCode] = useState('')
  const qr = useMemo(() => {
    if (!state?.qrContent) return undefined
    try { return encodeQR(state.qrContent, 'data-url', { scale: 4, border: 4 }) } catch { return undefined }
  }, [state?.qrContent])
  useEffect(() => { setCode('') }, [state?.qrContent, state?.phase])
  const phase = state?.phase
  const scanning = phase === 'awaiting-scan' || phase === 'awaiting-confirmation' || phase === 'awaiting-code'
  const connecting = phase === 'connecting'
  const connected = phase === 'connected'
  const label = !state ? '读取中…' : ({ idle: '未绑定', connecting: '连接中', 'awaiting-scan': '等待扫码', 'awaiting-confirmation': '等待确认',
    'awaiting-code': '等待配对码', connected: '已连接', reconnecting: '正在重连', expired: '授权或二维码已过期', failed: '连接失败' })[state.phase]
  const canLogin = !!state && !scanning && !connecting && !connected && phase !== 'reconnecting'
  return <SetGroup title="微信">
    <SetRow label={<><UiIcon name="message-square" size={16} />微信 ClawBot</>} sub="与飞书各自使用独立对话，共享助手身份和长期记忆" control={<div className="assistant-bind-actions">
      <span className="status-pill" role="status"><span className={'dot ' + (connected ? 'ok' : 'off')} /><span className={connected ? 'txt-ok' : 'txt-off'}>{label}</span></span>
      {canLogin && <button className="set-mini-btn primary" disabled={disabled} onClick={onLogin}>{phase === 'expired' || phase === 'failed' ? '重新扫码' : '扫码绑定'}</button>}
      {(state?.configured || scanning || connecting) && <button className="set-mini-btn" disabled={disabled} onClick={onDisconnect}>{scanning || connecting ? '取消绑定' : '断开'}</button>}
    </div>} />
    {(error || state?.message || scanning) && <div className="assistant-bind-form">
      {(error || state?.message) && <p className={error || phase === 'failed' || phase === 'expired' ? 'assistant-error assistant-hint' : 'assistant-hint'} role={error ? 'alert' : 'status'}>{error || state?.message}</p>}
      {scanning && <div className="assistant-weixin-scan">
        {qr ? <img className="assistant-weixin-qr" src={qr} alt="微信绑定二维码" /> : <p className="assistant-error">二维码无法显示，请取消后重新扫码。</p>}
        <div><p className="assistant-hint">请使用微信扫码并在手机上确认。Mac 与 UniAgent 需保持运行并联网。</p>
          {phase === 'awaiting-code' && <form className="assistant-bind-actions" onSubmit={event => { event.preventDefault(); if (!disabled && /^[\dA-Za-z]{4,16}$/.test(code.trim())) onVerify(code.trim()) }}>
            <input className="set-fld-inp assistant-weixin-code" type="text" aria-label="微信配对码" autoComplete="one-time-code" placeholder="手机显示的配对码" maxLength={16} value={code} disabled={disabled} onChange={event => setCode(event.target.value)} />
            <button className="set-mini-btn primary" type="submit" disabled={disabled || !/^[\dA-Za-z]{4,16}$/.test(code.trim())}>确认配对码</button>
          </form>}
        </div>
      </div>}
    </div>}
    {state?.sessionId && <SetRow label="当前对话" sub="个人助手 · 微信；/new 和 /clear 只更换微信对话" control={<button className="set-mini-btn" disabled={disabled} onClick={() => onOpenSession(state.sessionId!)}>打开会话</button>} />}
  </SetGroup>
}
