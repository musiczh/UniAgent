import { useState } from 'react'
import type { AgentDef, Session } from '@shared/types'
import { sessionDisplayTitle } from '@shared/task'
import { isSessionBusy } from '@shared/sessionStatus'
import { UiIcon } from './Icons'

export function AssistantSessionHistory({ sessions, agents, channelLabel, currentId, loading, error, pending, operationError, onSelect, onArchive, onUnarchive, onRetry, onClose }: {
  sessions: Session[]; agents: AgentDef[]; channelLabel: string; currentId?: string; loading: boolean; error: string
  pending: string | null; operationError: string
  onSelect(id: string): void; onArchive(id: string): void; onUnarchive(id: string): void; onRetry(): void; onClose(): void
}): JSX.Element {
  const [archived, setArchived] = useState(false)
  const rows = sessions.filter(session => !!session.archived === archived)
  return <section className="assistant-history-panel" role="dialog" aria-label="助手历史会话">
    <div className="assistant-history-head"><strong>历史会话</strong><span>{channelLabel}</span><button type="button" className="assistant-new-close" aria-label="关闭历史会话" onClick={onClose}><UiIcon name="close" size={14}/></button></div>
    <div className="assistant-history-tabs" role="tablist" aria-label="会话归档状态">{[false, true].map(value => <button key={String(value)} type="button" role="tab" data-archived={value} aria-selected={archived === value} onClick={() => setArchived(value)}>{value ? '已归档' : '未归档'}<span>{sessions.filter(session => !!session.archived === value).length}</span></button>)}</div>
    {loading && <p className="assistant-history-notice" role="status">正在读取历史会话…</p>}
    {error && <p className="assistant-history-notice" role="alert">{error}<button type="button" onClick={onRetry}>重试</button></p>}
    {operationError && <p className="assistant-history-notice" role="alert">{operationError}</p>}
    <div className="assistant-history-rows">{rows.map(session => {
      const current = session.id === currentId
      const recovering = !!session.recovery && session.recovery.phase !== 'stopped'
      const busy = isSessionBusy(session.status)
      const title = sessionDisplayTitle(session)
      return <div key={session.id} className={'assistant-history-row' + (current ? ' is-current' : '')} data-session-id={session.id} onClick={() => onSelect(session.id)}>
        <button type="button" className="assistant-history-open" aria-label={`打开 ${title} 的聊天`}><span className="assistant-history-title">{title}</span><span className="assistant-history-meta">{agents.find(agent => agent.id === session.config.agentId)?.name || session.config.agentId}<i/>{new Date(session.updatedAt || session.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{current && <span className="assistant-history-badge">当前对话</span>}</span></button>
        {current ? <span className="assistant-history-state">正在使用</span> : <button type="button" className={archived ? 'assistant-history-restore' : 'assistant-history-archive'} aria-label={`${archived ? '取消归档' : '归档'} ${title}`} disabled={!!pending || !archived && (busy || recovering)} title={recovering ? '恢复中的会话不可归档' : busy ? '运行中的会话不可归档' : archived ? '取消归档' : '归档'} onClick={event => { event.stopPropagation(); if (archived) onUnarchive(session.id); else onArchive(session.id) }}>{pending === session.id ? '处理中…' : archived ? '取消归档' : <UiIcon name="archive" size={15}/>}</button>}
      </div>
    })}{!rows.length && !loading && !error && <p className="assistant-history-empty">{archived ? '暂无已归档会话' : '暂无历史会话'}</p>}</div>
    <p className="assistant-history-foot">{archived ? <>点击每项查看对应聊天记录。<br/>取消归档不会切换渠道的当前对话。</> : <>点击每项进入对应聊天，右侧图标单条归档。<br/>当前及运行中的对话不可归档。</>}</p>
  </section>
}
