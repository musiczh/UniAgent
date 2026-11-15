import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import type { TaskDecision } from '@shared/taskDecisions'
import { PlanDecision, RequestDetailCard } from './EventStream'
import { UiIcon } from './Icons'
import { Markdown } from './Markdown'
import { planFeedbackInAnswer } from '@shared/interactionRequests'

export function useTaskDecisions(sessionId: string, active: boolean, revision: unknown) {
  const [state, setState] = useState<{ sessionId: string; items: TaskDecision[]; error: string }>({ sessionId, items: [], error: '' })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active) return
    let live = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      const ticket = ++generation
      void window.uniagent.getTaskDecisions(sessionId).then(value => {
        if (live && ticket === generation) setState({ sessionId, items: Array.isArray(value) ? value : [], error: '' })
      }, reason => { if (live && ticket === generation) setState(current => ({ sessionId, items: current.sessionId === sessionId ? current.items : [], error: String(reason) })) })
    }
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; refresh() }, 50) }
    refresh()
    const off = [window.uniagent.onEvent(event => { if (event.sessionId === sessionId && ['approval_request','agent_message','error','turn_completed','turn_started'].includes(event.type) && (event.type !== 'agent_message' || event.payload.delivery === 'async')) schedule() }),
      window.uniagent.onSideEvent(({ sessionId: id }) => { if (id === sessionId) schedule() }),
      window.uniagent.onSessionUpdated(({ session }) => { if (session.id === sessionId) schedule() })]
    return () => { live = false; if (timer) clearTimeout(timer); off.forEach(stop => { if (typeof stop === 'function') stop() }) }
  }, [sessionId, active, revision, retry])
  const current = state.sessionId === sessionId ? state : undefined
  return { items: current?.items || [], error: current?.error || '', refresh: useCallback(() => setRetry(n => n + 1), []) }
}

export function TaskDecisions({ session, items, error, onRefresh, onOpenConversation, onRevisePlan }: {
  session: Session; items: TaskDecision[]; error: string; onRefresh: () => void; onOpenConversation: (seq?: number) => void
  onRevisePlan?: (feedback: string) => Promise<void>
}): JSX.Element | null {
  const [selected, setSelected] = useState('')
  const action = useRef<{ fingerprint: string; id: string }>()
  const current = items.find(item => item.id === selected) || items[0]
  if (!current && !error && (!session.recovery || session.recovery.phase === 'stopped')) return null
  const index = Math.max(0, items.findIndex(item => item.id === current?.id))
  async function respond(_id: string, answer: unknown): Promise<void> {
    if (!current) throw new Error('决策已失效')
    const fingerprint = JSON.stringify([current.id, current.version, answer])
    if (action.current?.fingerprint !== fingerprint) action.current = { fingerprint, id: crypto.randomUUID() }
    try { await window.uniagent.resolveTaskDecision(session.id, { id: current.id, version: current.version, actionId: action.current.id, answer }) }
    finally { onRefresh() }
  }
  return <div className="task-decisions">
    {error && <div className="scope-error" role="alert">决策状态读取失败，保留最近已知信息。<button onClick={onRefresh}>重试</button></div>}
    {session.recovery && session.recovery.phase !== 'stopped' && <p className="task-detail-muted" role="status">自动恢复{session.recovery.phase === 'judging' ? '判断中' : session.recovery.phase === 'waiting' ? '等待重试' : '重试中'} · {session.recovery.attempts} / {session.recovery.maxRetries}<br/>{session.recovery.reason}</p>}
    {current && <section className="task-decision" aria-label="当前决策">
      <div className={`task-decision-head ${current.priority}`}><UiIcon name={current.type === 'question' ? 'question' : current.priority === 'high' ? 'shield' : 'alert-circle'} size={15}/><strong>{current.title}</strong><span>{current.type !== 'exception' && (current.blocking ? '执行等待处理' : '任务仍可继续执行')}</span>
        <div className="task-decision-navigation"><small>{index + 1} / {items.length}</small>{items.length > 1 && <><button aria-label="上一项决策" onClick={() => setSelected(items[(index + items.length - 1) % items.length].id)}><UiIcon name="chevron-left" size={14}/></button><button aria-label="下一项决策" onClick={() => setSelected(items[(index + 1) % items.length].id)}><UiIcon name="chevron-right" size={14}/></button></>}</div>
      </div>
      <div className="task-decision-body">
        {current.status !== 'open' ? <p role="status">{current.status === 'submitting' ? '正在提交，请稍候。' : '处理结果待确认，系统不会重复提交。'}<button className="task-source-link" onClick={onRefresh}>刷新状态</button></p> : current.type === 'plan' && current.event ? <>
          <Markdown text={current.event.payload.params?.plan || 'Agent 请求结束计划模式并开始实施。'}/>
          {!session.readOnly && !error && <PlanDecision key={current.id} onImplement={() => respond(current.requestId!, { decision: 'approved' })} onSkip={() => respond(current.requestId!, { decision: 'cancelled' })} onRevise={async feedback => {
            const inline = planFeedbackInAnswer(current.event?.payload.method)
            if (!inline && !onRevisePlan) throw new Error('请到原对话提交方案反馈')
            await respond(current.requestId!, { decision: 'rejected', ...(inline ? { feedback } : {}) })
            if (!inline) await onRevisePlan!(feedback)
          }}/>}
        </> : current.event && current.type !== 'exception' ? <RequestDetailCard key={current.id + current.version} ev={current.event} readOnly={!!session.readOnly || !!error} onRespond={session.readOnly || error ? undefined : respond}/> : <><p>{current.detail}</p><p className="task-detail-muted">请先检查原始错误和恢复记录，确认原因后在原对话继续。</p></>}
        <button className="task-source-link" onClick={() => onOpenConversation(current.event?.seq)}>查看原对话与完整材料</button>
      </div>
    </section>}
  </div>
}
