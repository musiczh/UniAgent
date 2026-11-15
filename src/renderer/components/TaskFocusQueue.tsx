import { useEffect, useRef, useState } from 'react'
import type { UAEvent } from '@shared/types'
import type { TaskFocusEntry } from '@shared/taskBoard'
import { isNativeTaskDecision, type TaskDecision } from '@shared/taskDecisions'
import { planFeedbackInAnswer } from '@shared/interactionRequests'
import { RequestDetailCard, PlanDecision, questionBackgroundText } from './EventStream'
import { Markdown } from './Markdown'
import { HtmlPreviewSessionContext } from './HtmlPreview'
import { FileBrowser } from './FileBrowser'
import { UiIcon } from './Icons'
import { useTaskDecisions } from './TaskDecisions'
import { useLayoutMotion } from '../conversationMotion'

/** Only visited tasks load their original requests; hidden panels retain answer drafts. */
export function TaskFocusQueue({ entries, onRefresh, onOpenTask }: { entries: TaskFocusEntry[]; onRefresh: () => void; onOpenTask: (id: string) => void | Promise<void> }): JSX.Element | null {
  const [current, setCurrent] = useState<TaskFocusEntry>()
  const [visited, setVisited] = useState<string[]>([])
  const [folded, setFolded] = useState(false)
  const [phase, setPhase] = useState('')
  const motionRef = useRef<HTMLElement>(null)
  useLayoutMotion(motionRef, !!current, '[data-motion-key]', false)
  const latest = useRef(entries); latest.current = entries
  const currentExists = !!current && entries.some(entry => entry.id === current.id)
  const nextId = entries[0]?.id
  useEffect(() => {
    if (!current) { setCurrent(entries[0]); return }
    if (currentExists) { setPhase(value => value === 'leaving' ? 'arriving' : value); return }
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180
    const element = motionRef.current
    const closing = !entries.length && duration && element ? element.animate([
      { height: `${element.getBoundingClientRect().height}px`, marginBottom: getComputedStyle(element).marginBottom, overflow: 'hidden' },
      { height: '0px', marginBottom: '0px', overflow: 'hidden' }
    ], { duration, easing: 'ease-in', fill: 'forwards' }) : undefined
    setPhase('leaving')
    const timer = setTimeout(() => { setCurrent(latest.current[0]); setPhase('arriving') }, duration)
    return () => { clearTimeout(timer); closing?.cancel() }
  }, [current?.id, currentExists, nextId])
  useEffect(() => { if (current) setVisited(ids => ids.includes(current.id) ? ids : [...ids, current.id]) }, [current?.id])
  if (!current) return null
  const panels = entries.some(entry => entry.id === current.id) ? entries : [current, ...entries]
  return <section className={`task-focus-queue ${phase}`} aria-label="聚焦提问与审批" ref={motionRef}>
    <div className={`interaction-dock${folded ? ' is-collapsed' : ''}`} data-motion-key="focus">
      <div className="interaction-dock-head"><UiIcon name="question" size={15}/><strong>需要你处理</strong><span className="approval-wait-chip">{entries.length} 个任务</span><div className="interaction-dock-tools"><button className="interaction-dock-toggle" title="打开当前任务" onClick={() => { void onOpenTask(current.id) }}><UiIcon name="arrow-right" size={13}/>进入任务</button><button className="interaction-dock-toggle" aria-label={folded ? '展开提问卡片' : '收起提问卡片'} aria-expanded={!folded} onClick={() => setFolded(value => !value)}><UiIcon name="chevron-down" size={14}/>{folded ? '展开' : '收起'}</button></div></div>
      <div hidden={folded}>{panels.filter(entry => visited.includes(entry.id) || entry.id === current.id).map(entry => <FocusTaskPanel key={entry.id} entry={entry} active={entry.id === current.id} onRefresh={onRefresh} onOpenTask={onOpenTask}/>)}</div>
      {folded && <p className="task-focus-folded">{entries.find(entry => entry.id === current.id)?.title || current.title}</p>}
    </div>
    {entries.length > 1 && <details className="task-focus-more"><summary>还有 {entries.length - 1} 个任务待处理<UiIcon name="chevron-down" size={12}/></summary><div>{entries.filter(entry => entry.id !== current.id).map(entry => <button key={entry.id} onClick={() => { setCurrent(entry); setPhase('') }}>{entry.title}</button>)}</div></details>}
  </section>
}

function FocusTaskPanel({ entry, active, onRefresh, onOpenTask }: { entry: TaskFocusEntry; active: boolean; onRefresh: () => void; onOpenTask: (id: string) => void | Promise<void> }): JSX.Element {
  const requests = useTaskDecisions(entry.id, active, entry.updatedAt)
  const [events, setEvents] = useState<UAEvent[]>([])
  const [contextError, setContextError] = useState('')
  const [contextReady, setContextReady] = useState(false)
  const [selected, setSelected] = useState('')
  const [fileFocus, setFileFocus] = useState<{ path: string; line?: number }>()
  const openFile = (path: string, line?: number): void => setFileFocus({ path, line })
  useEffect(() => {
    if (!active) return
    let live = true
    void window.uniagent.getEvents(entry.id).then(value => { if (live) { setEvents(value); setContextError(''); setContextReady(true); onRefresh() } }, error => { if (live) setContextError(String(error)) })
    return () => { live = false }
  }, [entry.id, active, entry.updatedAt])
  const items = requests.items.filter(isNativeTaskDecision)
  const current = items.find(item => item.id === selected) || items[0]
  const inputs = events.filter(event => event.sessionId === entry.id && (event.type === 'user_message' || event.type === 'goal_message') && !event.payload.automaticRecovery)
  return <HtmlPreviewSessionContext.Provider value={entry.id}><div hidden={!active} className="task-focus-panel" data-focus-task-id={entry.id}>
    <div className="task-focus-context"><button className="task-source-link" onClick={() => { void onOpenTask(entry.id) }}>{entry.title}</button><dl><dt>任务描述</dt><dd><ContextText text={entry.description || inputs[0]?.payload.text || '正在核对任务背景…'}/></dd><dt>最近输入</dt><dd><ContextText text={inputs.at(-1)?.payload.text || '暂无可用输入记录'}/></dd></dl></div>
    {(requests.error || contextError) && <p className="scope-error" role="alert">{requests.error || contextError}<button onClick={() => { requests.refresh(); onRefresh() }}>重新读取</button></p>}
    {items.length > 1 && <div className="interaction-tabs" role="tablist" aria-label="本任务待处理问题">{items.map((item, index) => <button key={item.id} role="tab" aria-selected={current?.id === item.id} onClick={() => setSelected(item.id)}>{index + 1} · {item.title}</button>)}</div>}
    {items.map(item => {
      const background = item.event ? questionBackgroundText(events, item.event) : ''
      return <div hidden={current?.id !== item.id} key={item.id} className="interaction-panel">{background && <div className="question-context"><Markdown text={background} onOpenFile={openFile}/></div>}<TaskRequestCard sessionId={entry.id} item={item} onOpenFile={openFile} readOnly={entry.readOnly || !contextReady || !!requests.error || !!contextError} onHandled={() => { requests.refresh(); onRefresh() }}/></div>
    })}
    {!items.length && <p className="task-detail-muted">正在核对待处理问题…</p>}
  </div>{active && fileFocus && <FileBrowser sessionId={entry.id} workdir="" focusPath={fileFocus.path} focusLine={fileFocus.line} onOpenFile={openFile} onClose={() => setFileFocus(undefined)}/>}</HtmlPreviewSessionContext.Provider>
}

function ContextText({ text }: { text: string }): JSX.Element {
  return text.length > 180 ? <details><summary>{text.slice(0, 180)}…</summary><p>{text}</p></details> : <>{text}</>
}

export function TaskRequestCard({ sessionId, item, readOnly, onHandled, onRevisePlan, onOpenFile }: { sessionId: string; item: TaskDecision; readOnly?: boolean; onHandled: () => void; onRevisePlan?: (feedback: string) => Promise<void>; onOpenFile?: (path: string, line?: number) => void }): JSX.Element {
  const action = useRef<{ fingerprint: string; id: string }>()
  async function respond(_id: string, answer: unknown): Promise<void> {
    const fingerprint = JSON.stringify([item.id, item.version, answer])
    if (action.current?.fingerprint !== fingerprint) action.current = { fingerprint, id: crypto.randomUUID() }
    try { await window.uniagent.resolveTaskDecision(sessionId, { id: item.id, version: item.version, actionId: action.current.id, answer }) }
    finally { onHandled() }
  }
  if (!item.event) return <p role="status">正在核对原请求…</p>
  const disabled = readOnly || item.status !== 'open'
  return <><p hidden={item.status === 'open'} role="status">{item.status === 'submitting' ? '正在提交，请稍候。' : '处理结果待确认，系统不会重复提交。'}<button className="task-source-link" onClick={onHandled}>刷新状态</button></p>{item.type === 'plan' ? <><Markdown text={item.event.payload.params?.plan || 'Agent 请求结束计划模式并开始实施。'} onOpenFile={onOpenFile}/>{!disabled && <PlanDecision onImplement={() => respond(item.requestId!, { decision: 'approved' })} onSkip={() => respond(item.requestId!, { decision: 'cancelled' })} onRevise={async feedback => {
    const inline = planFeedbackInAnswer(item.event?.payload.method)
    if (!inline && !onRevisePlan) throw new Error('请打开任务提交方案反馈')
    await respond(item.requestId!, { decision: 'rejected', ...(inline ? { feedback } : {}) })
    if (!inline) await onRevisePlan!(feedback)
  }}/>}</> : <RequestDetailCard ev={item.event} readOnly={disabled} onOpenFile={onOpenFile} onRespond={disabled ? undefined : respond}/>}</>
}
