import { useEffect, useState } from 'react'
import type { RequirementCurationConversation as Conversation } from '@shared/requirementTypes'
import { SessionConversation } from './SessionConversation'
import { UiIcon } from './Icons'

export function RequirementCurationConversation({ id, name, onBack }: { id: string; name: string; onBack: () => void }): JSX.Element {
  const [data, setData] = useState<Conversation>(), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const value = await window.uniagent.requirementCurationConversation(id)
        if (value.requirementId !== id || value.sessionId !== 'curation-' + id) throw new Error('整理会话与当前需求不一致')
        if (live) { setData(value); setError('') }
      } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { if (live) timer = setTimeout(() => void load(), 1500) }
    }
    void load()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [id, retry])
  const current = data?.requirementId === id ? data : undefined
  return <section className="session-view requirement-curation-conversation" aria-label="后台整理会话">
    <div className="session-header responsive-toolbar"><button type="button" className="session-return-btn" aria-label="返回需求概览" title="返回需求概览" onClick={onBack}><UiIcon name="back" size={18}/></button><span className="topbar-title"><span className="topbar-title-main">整理会话 · {name}</span></span><span className="task-execution-status">只读</span></div>
    <div className="session-workspace-notice" role="status">后台整理的原始对话，消息自动更新。{current?.model ? ` 模型：${current.model}。` : ''}{current?.status === 'running' ? ' 当前正在整理…' : ''}</div>
    {current && error && <div className="session-workspace-notice scope-error" role="alert">读取更新失败：{error}<button className="scope-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
    {current && !current.events.length && !error ? <div className="panel-loading" role="status"><span>尚无整理消息，开始整理后会在这里显示。</span></div>
      : <SessionConversation readOnly sessionId={'curation-' + id} events={current?.events || []} status={current?.status === 'running' ? 'running' : 'completed'} loading={!current && !error} loadError={!current ? error : undefined} onRetryLoad={() => setRetry(value => value + 1)}/>}
  </section>
}
