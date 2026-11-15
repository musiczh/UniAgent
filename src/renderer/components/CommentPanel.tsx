import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CommentThread } from '@shared/comments'
import { agentForSession, type UAEvent } from '@shared/types'
import type { Annotation } from '../textAnnotations'
import { latestCommentReplySeq, useComments, visibleCommentEvents } from '../comments'
import { EventStream, MessageAvatarContext } from './EventStream'
import { ModelPicker } from './ModelPicker'
import { UiIcon } from './Icons'
import { AgentIcon } from './AgentIcon'
import { cancelSendOrigin, captureSendOrigin } from '../conversationMotion'

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
        {comments.threads.map(thread => <CommentItem key={thread.id} thread={thread} active={comments.selected === thread.id} />)}
        {!comments.loading && !comments.threads.length && <p className="ai-comment-empty">选中文字后点击“侧边评论”</p>}
      </div>}
  </aside>
}

function CommentItem({ thread, active }: { thread: CommentThread; active: boolean }): JSX.Element {
  const comments = useComments()!
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const head = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const replySeq = latestCommentReplySeq(thread)
  const unread = comments.unread(thread)
  useEffect(() => {
    if (!active || !unread) return
    const reply = head.current?.parentElement?.querySelector<HTMLElement>(`.ai-comment-conversation [data-seq="${replySeq}"]`)
    if (!reply) return
    let visible = false
    const read = (): void => {
      const reader = document.querySelector('.immersive-reader-overlay')
      if (visible && document.visibilityState !== 'hidden' && document.hasFocus() && (!reader || reader.contains(reply))) {
        comments.markRead(thread.id, replySeq)
      }
    }
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRect.height > 0 && entry.intersectionRect.width > 0)
      read()
    })
    observer.observe(reply)
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', read)
    return () => { observer.disconnect(); window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read) }
  }, [active, unread, replySeq, thread.id, comments.markRead])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent): void => { if (!head.current?.contains(event.target as Node)) setMenu(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setMenu(false); more.current?.focus() } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [menu])
  useEffect(() => { if (confirm) cancel.current?.focus() }, [confirm])
  const open = (): void => { comments.select(thread.id); comments.locate(thread) }
  const remove = async (): Promise<void> => {
    setDeleting(true); setError('')
    try { await comments.remove(thread) }
    catch (error: any) { setError(String(error.message || error)); setDeleting(false) }
  }
  return <section className={`ai-comment-card${active ? ' active' : ''}`}
    onClick={event => { if (!active && !(event.target as Element).closest('button, a, input, textarea, [role="button"], .ai-comment-confirm')) open() }}>
    <div className="ai-comment-head" ref={head}>
      <button className="ai-comment-toggle" aria-label={active ? '折叠评论' : '展开评论'} aria-expanded={active}
        onClick={() => comments.toggle(thread.id)}><UiIcon name="chevron-right" size={14} /></button>
      <button className="ai-comment-source" onClick={open} aria-expanded={active} title={thread.anchor.quote}>
        <span className="ai-comment-source-text">{thread.anchor.quote}</span>
        {unread && <span className="ai-comment-unread" role="img" aria-label="有未读回复" title="有未读回复" />}
        <time>{new Date(thread.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
      </button>
      <button className="ai-comment-more" ref={more} aria-label="评论更多操作" aria-haspopup="menu" aria-expanded={menu}
        onClick={() => setMenu(!menu)}><UiIcon name="more-horizontal" size={14} /></button>
      {menu && <div className="ai-comment-menu" role="menu"><button role="menuitem" onClick={() => { setMenu(false); setConfirm(true) }}>
        <UiIcon name="trash" size={14} />删除评论</button></div>}
    </div>
    {confirm && <div className="ai-comment-confirm" role="alertdialog" aria-label="删除评论" onKeyDown={event => { if (event.key === 'Escape' && !deleting) { setConfirm(false); more.current?.focus() } }}>
      <p>删除这条评论及其讨论？</p>{error && <p className="ai-comment-error" role="alert">{error}</p>}
      <div><button ref={cancel} disabled={deleting} onClick={() => setConfirm(false)}>取消</button>
        <button className="danger" disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除…' : '删除'}</button></div>
    </div>}
    {active && <CommentConversation thread={thread} />}
  </section>
}

function CommentConversation({ thread }: { thread: CommentThread }): JSX.Element {
  const comments = useComments()!
  const agentId = comments.session?.config.agentId || thread.config.agentId
  const baseAgent = comments.agents.find(agent => agent.id === agentId)
  const agent = baseAgent && agentForSession(baseAgent, comments.session)
  const savedModel = thread.config.agentId === agentId ? thread.config.model : comments.session?.config.model
  const [text, setText] = useState(() => { try { return localStorage.getItem(`ua.comment-draft:${thread.id}`) || '' } catch { return '' } })
  const key = (agentId: string, model?: string): string => JSON.stringify([agentId, model || ''])
  const [preferredModel, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(`ua.comment-model:${thread.id}`)
      const value = saved ? JSON.parse(saved) : undefined
      if (Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'string')) return saved!
    } catch { /* invalid view state falls back to the saved thread model */ }
    return key(agentId, savedModel)
  })
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [pendingInput, setPendingInput] = useState<UAEvent>()
  const receivedInput = pendingInput && thread.events.some(event => event.type === 'user_message' && event.payload.clientTurnKey === pendingInput.payload.clientTurnKey)
  useEffect(() => { if (receivedInput) setPendingInput(undefined) }, [receivedInput])
  const input = useRef<HTMLTextAreaElement>(null)
  const busy = sending || thread.status === 'running' || thread.status === 'awaiting-approval'
  const models = (agent?.models.length ? agent.models : [{ id: '', label: '默认', efforts: [] }]).map(item => ({ ...item,
    id: key(agentId, item.id), label: `${agent?.name || agentId} · ${item.label}` }))
  const savedKey = key(agentId, savedModel)
  if (savedModel && !models.some(item => item.id === savedKey)) models.unshift({ id: savedKey, label: `${agent?.name || agentId} · ${savedModel}`, efforts: [] })
  const model = models.some(item => item.id === preferredModel) ? preferredModel
    : models.some(item => item.id === savedKey) ? savedKey : models[0].id
  useEffect(() => { try { localStorage.setItem(`ua.comment-draft:${thread.id}`, text) } catch { /* optional draft cache */ } }, [text, thread.id])
  useEffect(() => { try { localStorage.setItem(`ua.comment-model:${thread.id}`, model) } catch { /* optional draft cache */ } }, [model, thread.id])
  useEffect(() => { if (thread.status === 'draft') input.current?.focus() }, [thread.id])
  async function send(question = text): Promise<void> {
    if (busy || !question.trim()) return
    const motionKey = captureSendOrigin(input.current)
    setPendingInput({ sessionId: thread.sessionId, seq: -Date.now(), ts: Date.now(), type: 'user_message', payload: { text: question, optimistic: true, clientTurnKey: motionKey } })
    setSending(true); setError('')
    try {
      const [, modelId] = JSON.parse(model)
      await window.uniagent.sendComment(thread.sessionId, thread.id, question, { agentId, model: modelId || undefined }, motionKey)
      try { if (localStorage.getItem(`ua.comment-draft:${thread.id}`) === question) localStorage.removeItem(`ua.comment-draft:${thread.id}`) } catch { /* optional draft cache */ }
      setText(current => current === question ? '' : current)
    } catch (error: any) { cancelSendOrigin(motionKey); setPendingInput(undefined); setError(String(error.message || error)) }
    finally { setSending(false) }
  }
  return <>
    {(thread.status !== 'draft' || pendingInput) && <div className="ai-comment-conversation"><MessageAvatarContext.Provider value={{ agentId, adapter: agent?.adapter }}><EventStream sessionId={thread.sessionId} events={[...visibleCommentEvents(thread.events), ...(pendingInput && !receivedInput ? [pendingInput] : [])]}
      status={thread.status === 'running' ? 'running' : 'idle'}
      onRespond={(id, answer) => window.uniagent.respondComment(thread.sessionId, thread.id, id, answer)} /></MessageAvatarContext.Provider>
      {thread.status === 'interrupted' && <p className="ai-comment-state">已停止</p>}
      {thread.status === 'awaiting-approval' && <p className="ai-comment-state">等待确认</p>}
    </div>}
    {(error || thread.error) && <div className="ai-comment-error" role="alert">{error || thread.error}
      {!busy && <button onClick={() => { const last = thread.events.findLast(event => event.type === 'user_message'); if (last) void send(last.payload.text) }}>重试</button>}</div>}
    <div className="ai-comment-composer"><textarea ref={input} value={text} onChange={event => setText(event.target.value)}
      placeholder="这段内容哪里不明白？写下你的问题…" rows={3} disabled={sending}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <div className="ai-comment-compose-actions"><AgentIcon agentId={agentId} adapter={agent?.adapter} size={15} /><ModelPicker models={models} value={model} onChange={setModel} disabled={busy} portal />
        {busy ? <button className="ai-comment-stop" aria-label="停止回答" onClick={() => void window.uniagent.stopComment(thread.sessionId, thread.id).catch(error => setError(String(error.message || error)))}><span /></button>
          : <button className="ai-comment-send" aria-label="发送评论" disabled={!text.trim()} onClick={() => void send()}><UiIcon name="arrow-up" size={16} /></button>}
      </div>
    </div>
  </>
}
