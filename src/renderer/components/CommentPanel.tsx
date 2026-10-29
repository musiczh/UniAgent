import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CommentThread } from '@shared/comments'
import type { Annotation } from '../textAnnotations'
import { useComments, visibleCommentEvents } from '../comments'
import { EventStream } from './EventStream'
import { ModelPicker } from './ModelPicker'
import { UiIcon } from './Icons'
import { AgentIcon } from './AgentIcon'

export function CommentPanel({ pending = [], pendingContent, embedded = false }: {
  pending?: Annotation[]; pendingContent?: ReactNode; embedded?: boolean
}): JSX.Element | null {
  const comments = useComments()
  const [width, setWidth] = useState(() => { try { return Math.max(260, Math.min(520, Number(localStorage.getItem('ua.comment-width')) || 380)) } catch { return 380 } })
  const [maxWidth, setMaxWidth] = useState(520)
  const drag = useRef<{ x: number; width: number }>()
  useEffect(() => {
    const update = (): void => setMaxWidth(Math.max(260, Math.min(520, Math.floor(window.innerWidth * .48))))
    update(); window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  if (!comments?.open) return null
  const actualWidth = Math.min(width, maxWidth)
  const resize = (value: number): void => { const next = Math.max(260, Math.min(maxWidth, value)); setWidth(next); try { localStorage.setItem('ua.comment-width', String(next)) } catch { /* optional view state */ } }
  const active = comments.threads.find(thread => thread.id === comments.selected) || comments.threads[0]
  return <aside className={`ai-comments${embedded ? ' embedded' : ''}`} aria-label="侧边评论" style={{ width: actualWidth }}>
    <div className="immersive-reader-comments-resizer" role="separator" tabIndex={0} aria-label="调整侧边评论宽度"
      aria-orientation="vertical" aria-valuemin={260} aria-valuemax={maxWidth} aria-valuenow={actualWidth}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width: actualWidth }; event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={event => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX) }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = undefined }}
      onLostPointerCapture={() => { drag.current = undefined }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); resize(event.key === 'Home' ? 260 : event.key === 'End' ? maxWidth : actualWidth + (event.key === 'ArrowLeft' ? 20 : -20)) } }} />
    <header className="ai-comments-head"><strong>评论 <span>{comments.threads.length + pending.length}</span></strong>
      <button onClick={comments.close} aria-label="收起侧边评论" title="收起评论"><UiIcon name="chevrons-right" size={17} /></button></header>
    <div className="ai-comments-tabs" role="tablist" aria-label="评论类型">
      <button role="tab" aria-selected={comments.tab === 'ai'} onClick={() => comments.setTab('ai')}>AI 评论 {comments.threads.length}</button>
      <button role="tab" aria-selected={comments.tab === 'pending'} onClick={() => comments.setTab('pending')}>待发送批注 {pending.length}</button>
    </div>
    {comments.error && <p className="ai-comment-error" role="alert">{comments.error}</p>}
    {comments.tab === 'pending' ? pendingContent || <div className="ai-comments-list">{pending.map(annotation => <button className="ai-pending" key={annotation.id}
      onClick={() => window.dispatchEvent(new CustomEvent('ua:edit-pending-comment', { detail: annotation }))}>
      <blockquote>{annotation.quote}</blockquote><p>{annotation.comment || '待补充评论'}</p></button>)}
      {!pending.length && <p className="ai-comment-empty">暂无待发送批注</p>}</div>
      : <div className="ai-comments-list">
        {comments.loading && <p role="status" className="ai-comment-empty">正在读取评论…</p>}
        {comments.threads.map((thread, index) => <section key={thread.id} className={`ai-comment-card${active?.id === thread.id ? ' active' : ''}`}>
          <button className="ai-comment-source" onClick={() => comments.select(thread.id)} aria-expanded={active?.id === thread.id}>
            {thread.status !== 'draft' && <span className="ai-comment-number">{index + 1}</span>}<span>{thread.status === 'draft' ? '发起评论' : thread.anchor.filePath?.split('/').pop() || '本条回复'}</span>
            <time>{new Date(thread.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
          </button>
          <button className="ai-comment-quote" title="定位原文" onClick={() => comments.locate(thread)}><blockquote>{thread.anchor.quote}</blockquote><UiIcon name="search" size={14} /></button>
          {active?.id === thread.id && <CommentConversation thread={thread} />}
        </section>)}
        {!comments.loading && !comments.threads.length && <p className="ai-comment-empty">选中文字后点击“侧边评论”</p>}
      </div>}
  </aside>
}

function CommentConversation({ thread }: { thread: CommentThread }): JSX.Element {
  const comments = useComments()!
  const [text, setText] = useState(() => { try { return localStorage.getItem(`ua.comment-draft:${thread.id}`) || '' } catch { return '' } })
  const key = (agentId: string, model?: string): string => JSON.stringify([agentId, model || ''])
  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(`ua.comment-model:${thread.id}`)
      const value = saved ? JSON.parse(saved) : undefined
      if (Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'string')) return saved!
    } catch { /* invalid view state falls back to the saved thread model */ }
    return key(thread.config.agentId, thread.config.model)
  })
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const busy = sending || thread.status === 'running' || thread.status === 'awaiting-approval'
  const models = comments.agents.flatMap(agent => {
    if (agent.installed === false) return []
    const permission = comments.session?.config.permissionMode || thread.config.permissionMode
    if (permission && !agent.capabilities.permissionModes.some(mode => mode.id === permission)) return []
    return (agent.models.length ? agent.models : [{ id: '', label: '默认', efforts: [] }]).map(item => ({ ...item,
      id: key(agent.id, item.id), label: `${agent.name} · ${item.label}` }))
  })
  if (!models.some(item => item.id === model)) models.unshift({ id: model, label: `${thread.config.agentId} · ${thread.config.model || '默认'}`, efforts: [] })
  useEffect(() => { try { localStorage.setItem(`ua.comment-draft:${thread.id}`, text) } catch { /* optional draft cache */ } }, [text, thread.id])
  useEffect(() => { try { localStorage.setItem(`ua.comment-model:${thread.id}`, model) } catch { /* optional draft cache */ } }, [model, thread.id])
  useEffect(() => { if (thread.status === 'draft') input.current?.focus() }, [thread.id])
  async function send(question = text): Promise<void> {
    if (busy || !question.trim()) return
    setSending(true); setError('')
    try {
      const [agentId, modelId] = JSON.parse(model)
      await window.uniagent.sendComment(thread.sessionId, thread.id, question, { agentId, model: modelId || undefined })
      setText('')
    } catch (error: any) { setError(String(error.message || error)) }
    finally { setSending(false) }
  }
  return <>
    <div className="ai-comment-conversation"><EventStream sessionId={thread.sessionId} events={visibleCommentEvents(thread.events)}
      status={thread.status === 'running' ? 'running' : 'idle'}
      onRespond={(id, answer) => window.uniagent.respondComment(thread.sessionId, thread.id, id, answer)} />
      {thread.status === 'interrupted' && <p className="ai-comment-state">已停止</p>}
      {thread.status === 'awaiting-approval' && <p className="ai-comment-state">等待确认</p>}
    </div>
    {(error || thread.error) && <div className="ai-comment-error" role="alert">{error || thread.error}
      {!busy && <button onClick={() => { const last = thread.events.findLast(event => event.type === 'user_message'); if (last) void send(last.payload.text) }}>重试</button>}</div>}
    <div className="ai-comment-composer"><textarea ref={input} value={text} onChange={event => setText(event.target.value)}
      placeholder="这段内容哪里不明白？写下你的问题…" rows={3} disabled={sending}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <div className="ai-comment-compose-actions"><AgentIcon agentId={JSON.parse(model)[0]} size={17} /><ModelPicker models={models} value={model} onChange={setModel} disabled={busy} portal />
        {busy ? <button className="ai-comment-stop" aria-label="停止回答" onClick={() => void window.uniagent.stopComment(thread.sessionId, thread.id).catch(error => setError(String(error.message || error)))}><span /></button>
          : <button className="ai-comment-send" aria-label="发送评论" disabled={!text.trim()} onClick={() => void send()}><UiIcon name="arrow-up" size={18} /></button>}
      </div>
    </div>
  </>
}
