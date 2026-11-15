import { useEffect, useState } from 'react'
import type { RecoveryProgress } from '@shared/sessionRecovery'
import './sessionRecovery.css'

export function SessionRecoveryStatus({ sessionId, recovery }: { sessionId: string; recovery: RecoveryProgress }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (recovery.phase !== 'waiting') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [recovery.phase, recovery.nextRetryAt])
  const title = recovery.phase === 'judging' ? '正在判断是否值得重试'
    : recovery.phase === 'waiting' ? `${Math.max(0, Math.ceil(((recovery.nextRetryAt || now) - now) / 1000))} 秒后自动重试`
      : recovery.phase === 'retrying' ? '已自动接续，正在执行' : '自动恢复已停止'
  return <div className="session-recovery-status" role="status"><div><strong>{title}</strong><span> · 已重试 {recovery.attempts} / {recovery.maxRetries} 次</span><p>{error || recovery.reason}</p></div>
    {['judging', 'waiting'].includes(recovery.phase) && <button className="set-mini-btn" disabled={busy} onClick={async () => {
      setBusy(true)
      try { await window.uniagent.cancelRecovery(sessionId); setError('') }
      catch (cause) { setError(String(cause)) }
      finally { setBusy(false) }
    }}>{busy ? '取消中…' : '取消自动恢复'}</button>}
  </div>
}
