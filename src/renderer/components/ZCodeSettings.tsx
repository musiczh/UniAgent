import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ZCodeInstallationSnapshot } from '@shared/zcode'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { RefreshIcon } from './Icons'
import type { AgentDef } from '@shared/types'
import { AgentInstallFallback } from './AgentInstallFallback'

const active = (snapshot?: ZCodeInstallationSnapshot) => !!snapshot && ['preparing', 'downloading', 'building', 'verifying', 'activating'].includes(snapshot.phase)

export function ZCodeSettings({ agent, onRedetect, children }: {
  agent?: AgentDef; onRedetect: () => unknown; children: (installed: boolean, ready: boolean) => ReactNode
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<ZCodeInstallationSnapshot>()
  const [installing, setInstalling] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const busy = installing || active(snapshot)
  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const next = await window.uniagent.getZCodeInstallation()
        if (!current) return
        setSnapshot(next)
        if (installing || active(next)) timer = setTimeout(() => void load(), 1000)
      } catch { if (current) setError('安装状态读取失败，请重新打开详情页') }
    }
    void load()
    return () => { current = false; if (timer) clearTimeout(timer) }
  }, [installing])
  const install = async () => {
    setInstalling(true); setError('')
    try {
      const next = await window.uniagent.installZCode()
      if (mounted.current) setSnapshot(next)
    } catch { if (mounted.current) setError('安装未完成，请先结束 ZCode 任务、更新或配置检测后重试') }
    finally { if (mounted.current) { setInstalling(false); setCancelling(false) } }
  }
  const cancel = async () => {
    setCancelling(true)
    try { await window.uniagent.cancelZCodeInstall() }
    catch { if (mounted.current) setError('取消未完成，请稍后重试') }
    finally { if (mounted.current) setCancelling(false) }
  }
  const select = async () => {
    if (busy) return
    setInstalling(true); setError('')
    try { const next = await window.uniagent.selectZCodeRuntime(); if (next && mounted.current) setSnapshot(next) }
    catch { if (mounted.current) setError('所选运行时未通过校验，请检查完整资源与协议') }
    finally { if (mounted.current) setInstalling(false) }
  }
  const failed = snapshot?.phase === 'failed' || !!error
  const installed = !!snapshot?.installed
  const ready = agent?.lifecycle?.availability === 'available' || !!agent?.lifecycle?.lastReadyAt
  if (ready && !editing) return <>{children(installed, true)}<button className="set-mini-btn" onClick={() => setEditing(true)}>管理连接</button></>
  return <>
    <SetGroup title="程序安装">
      <SetRow label="安装 ZCode" sub={error || snapshot?.message || (installed ? `ZCode ${snapshot?.version || ''} 已安装` : '先检查完整 CLI 与官方 App；缺失时构建兼容运行时。独立会话数据库避免与外部 App 并发写入。')} control={<>
        {busy ? <>
          <button className="set-mini-btn" disabled><RefreshIcon size={13} className="is-spinning" />安装中…</button>
          <button className="set-mini-btn" disabled={cancelling || !snapshot?.cancellable} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消'}</button>
        </> : !installed && <button className="set-mini-btn primary" disabled={!snapshot} onClick={() => void install()}>
          {failed || snapshot?.phase === 'cancelled' ? '重试安装' : '一键安装'}
        </button>}
        <span className="status-pill" role="status"><span className={`dot ${failed ? 'warn' : installed ? 'ok' : 'off'}`} />
          {failed ? installed ? '检测失败' : '安装失败' : busy ? '安装中' : installed ? '已安装' : snapshot?.phase === 'cancelled' ? '已取消' : '待安装'}</span>
      </>} />
      <SetRow label="本机程序与资源" sub="当前接入使用 Personal Provider；暂不支持官方账号浏览器登录。外部程序由原程序管理更新。" control={<><button className="set-mini-btn" disabled={busy} onClick={() => void select()}>选择已有运行时</button><button className="set-mini-btn" disabled={busy} onClick={() => void onRedetect()}>重新检测</button></>} />
      {!installed || failed ? <div className="deepseek-install-note"><AgentInstallFallback id="zcode" name="ZCode" failure={error || (failed ? snapshot?.message : '')} /></div> : null}
    </SetGroup>
    {children(installed && !busy && !failed, false)}
  </>
}
