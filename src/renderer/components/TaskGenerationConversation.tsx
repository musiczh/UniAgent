import { useEffect, useState } from 'react'
import type { Session } from '@shared/types'
import type { TaskGenerationConversation as Conversation } from '@shared/taskGeneration'
import { sessionDisplayTitle } from '@shared/task'
import { SessionConversation } from './SessionConversation'
import { UiIcon } from './Icons'

export function TaskGenerationConversation({ session, onBack }: { session: Session; onBack: () => void }): JSX.Element {
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ taskId: string; data?: Conversation; loading: boolean; error: string }>({ taskId: session.id, loading: true, error: '' })
  useEffect(() => {
    let live = true, ticket = 0, timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      const request = ++ticket
      setState(current => current.taskId === session.id ? { ...current, loading: true, error: '' } : { taskId: session.id, loading: true, error: '' })
      void window.uniagent.getTaskGenerationConversation(session.id).then(data => {
        if (!data || data.taskId !== session.id) throw new Error('生成记录与当前任务不一致')
        if (live && request === ticket) setState({ taskId: session.id, data, loading: false, error: '' })
      }).catch(error => {
        if (live && request === ticket) setState(current => ({ taskId: session.id, data: current.taskId === session.id ? current.data : undefined, loading: false, error: error instanceof Error ? error.message : String(error) }))
      })
    }
    const off = window.uniagent.onTaskGenerationChanged(event => {
      if (event.taskId !== session.id || timer) return
      timer = setTimeout(() => { timer = undefined; load() }, 50)
    })
    load()
    return () => { live = false; if (timer) clearTimeout(timer); off() }
  }, [session.id, retry])
  const current = state.taskId === session.id ? state : undefined
  const data = current?.data, error = current?.error
  return <section className="session-view task-generation-conversation" aria-label="任务生成会话" data-generation-task-id={session.id}>
    <div className="session-header responsive-toolbar"><button type="button" className="session-return-btn" aria-label="返回任务" title="返回任务" onClick={onBack}><UiIcon name="back" size={18}/></button><span className="topbar-title"><span className="topbar-title-main">生成会话 · {sessionDisplayTitle(session)}</span></span><span className="task-execution-status">只读</span></div>
    <div className="session-workspace-notice" role="status">{data?.legacyHistory ? '旧版本未保存完整的原始生成对话；此处只展示已记录的真实调用。' : '查看标题、描述与快捷回复的生成记录；后台生成时自动更新。'}{data?.running ? ' 当前正在生成…' : ''}</div>
    {data && error && <div className="session-workspace-notice scope-error" role="alert">读取更新失败：{error}<button className="scope-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
    {data && !data.events.length && !data.running ? <div className="panel-loading" role="status"><span>{data.legacyHistory ? '旧版原始生成对话未保存，后续生成记录会出现在这里。' : '当前任务尚无生成记录，后续生成时会自动显示。'}</span></div>
      : <SessionConversation readOnly sessionId={session.id} events={data?.events || []} status={data?.running ? 'running' : 'completed'} loading={!data && (!current || current.loading)} loadError={!data ? error : undefined} onRetryLoad={() => setRetry(value => value + 1)}/>}
  </section>
}
