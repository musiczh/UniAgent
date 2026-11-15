import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentDef, Session, UAEvent } from '@shared/types'
import { findCommentSource, type CommentSelection, type CommentThread } from '@shared/comments'
import type { Annotation } from './textAnnotations'

interface CommentsState {
  session: Session | null
  agents: AgentDef[]
  threads: CommentThread[]
  selected?: string
  open: boolean
  tab: 'ai' | 'pending'
  error: string
  loading: boolean
  configure(session: Session | null, agents: AgentDef[]): void
  begin(selection: CommentSelection): Promise<void>
  select(id: string): void
  toggle(id: string): void
  remove(thread: CommentThread): Promise<void>
  close(): void
  show(): void
  setTab(tab: 'ai' | 'pending'): void
  locate(thread: CommentThread): void
  unread(thread: CommentThread): boolean
  markRead(id: string, replySeq: number): void
  annotations(annotations: Annotation[], sessionId?: string, events?: UAEvent[]): Annotation[]
}
const CommentsContext = createContext<CommentsState | null>(null)
export function useComments(): CommentsState | null { return useContext(CommentsContext) }
export const COMMENT_ANNOTATION_PREFIX = 'ai-comment:'

export function latestCommentReplySeq(thread: CommentThread): number {
  return thread.events.reduce((latest, event) => event.type === 'agent_message' && event.payload.phase !== 'commentary' &&
    typeof event.payload.text === 'string' && event.payload.text.trim() &&
    (event.state === 'success' || (!event.state && thread.status === 'idle')) ? Math.max(latest, event.seq) : latest, 0)
}

export function findCommentHighlight(id: string): HTMLElement | undefined {
  const surface = document.querySelector('.immersive-reader-overlay') || document
  return Array.from(surface.querySelectorAll<HTMLElement>('[data-anno-id]'))
    .find(node => node.dataset.annoId === COMMENT_ANNOTATION_PREFIX + id && node.getBoundingClientRect().width > 0)
}

function merge(rows: CommentThread[], next: CommentThread): CommentThread[] {
  const previous = rows.find(row => row.id === next.id)
  if (previous && previous.updatedAt > next.updatedAt) return rows
  return [...rows.filter(row => row.id !== next.id), next].sort((a, b) => a.createdAt - b.createdAt)
}
export function CommentProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [byOwner, setByOwner] = useState<Record<string, CommentThread[]>>({})
  const [selected, setSelected] = useState<string>()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'ai' | 'pending'>('ai')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [readReplies, setReadReplies] = useState<Record<string, number>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('ua.comment-read-replies') || '{}')
      return Object.fromEntries(Object.entries(saved).filter(([, seq]) => Number.isInteger(seq) && Number(seq) >= 0)) as Record<string, number>
    } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem('ua.comment-read-replies', JSON.stringify(readReplies)) } catch { /* optional view state */ }
  }, [readReplies])
  const markRead = useCallback((id: string, replySeq: number) => {
    setReadReplies(previous => (previous[id] || 0) >= replySeq ? previous : { ...previous, [id]: replySeq })
  }, [])
  const owner = useRef<string>()
  const removed = useRef(new Set<string>())
  const forget = useCallback(({ sessionId, id }: { sessionId: string; id: string }) => {
    removed.current.add(id)
    setByOwner(previous => ({ ...previous, [sessionId]: (previous[sessionId] || []).filter(thread => thread.id !== id) }))
    setSelected(current => current === id ? undefined : current)
    setReadReplies(previous => { const next = { ...previous }; delete next[id]; return next })
    try { localStorage.removeItem(`ua.comment-draft:${id}`); localStorage.removeItem(`ua.comment-model:${id}`) } catch { /* optional view state */ }
  }, [])
  const configure = useCallback((next: Session | null, definitions: AgentDef[]) => { setSession(next); setAgents(definitions) }, [])
  useEffect(() => window.uniagent.onCommentChanged(thread => {
    if (removed.current.has(thread.id)) return
    setByOwner(previous => ({ ...previous, [thread.sessionId]: merge(previous[thread.sessionId] || [], thread) }))
  }), [])
  useEffect(() => window.uniagent.onCommentRemoved(forget), [forget])
  useEffect(() => {
    const id = session?.id
    owner.current = id
    setError(''); setSelected(undefined); setOpen(false)
    if (!id) return
    let cancelled = false
    setLoading(true)
    try {
      const saved = JSON.parse(localStorage.getItem(`ua.comment-panel:${id}`) || '{}')
      setOpen(saved.open === true); setSelected(saved.selected)
    } catch { /* optional view state */ }
    void window.uniagent.listComments(id).then(rows => {
      if (!cancelled) setByOwner(previous => ({ ...previous, [id]: rows.filter(thread => !removed.current.has(thread.id)).reduce(merge, previous[id] || []) }))
    }).catch(error => { if (!cancelled) setError(String(error.message || error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [session?.id])
  useEffect(() => {
    if (!session?.id || owner.current !== session.id || loading) return
    try { localStorage.setItem(`ua.comment-panel:${session.id}`, JSON.stringify({ open, selected })) } catch { /* optional view state */ }
  }, [session?.id, open, selected, loading])
  const threads = useMemo(() => byOwner[session?.id || ''] || [], [byOwner, session?.id])
  const select = useCallback((id: string) => { setSelected(id); setTab('ai'); setOpen(true) }, [])
  const value: CommentsState = {
    session, agents, threads, selected, open, tab, error, loading, configure, select, markRead,
    unread: thread => latestCommentReplySeq(thread) > (readReplies[thread.id] || 0),
    toggle: id => { setSelected(current => current === id ? undefined : id); setTab('ai'); setOpen(true) },
    async remove(thread) { await window.uniagent.deleteComment(thread.sessionId, thread.id); forget(thread) },
    show: () => setOpen(true), close: () => setOpen(false), setTab,
    async begin(selection) {
      const id = session?.id
      if (!id) return
      setOpen(true); setTab('ai'); setError(''); setLoading(true)
      try {
        const thread = await window.uniagent.createComment(id, selection)
        setByOwner(previous => ({ ...previous, [id]: merge(previous[id] || [], thread) }))
        if (owner.current === id) setSelected(thread.id)
      } catch (error: any) { if (owner.current === id) setError(String(error.message || error)) }
      finally { if (owner.current === id) setLoading(false) }
    },
    locate(thread) { window.dispatchEvent(new CustomEvent('ua:locate-comment', { detail: thread })) },
    annotations(existing, sessionId, events) {
      if (!sessionId || sessionId !== session?.id) return existing
      return [...existing, ...threads.flatMap((thread, index) => {
        const source = !thread.anchor.filePath && events ? findCommentSource(events, thread.anchor) : undefined
        if (!thread.anchor.filePath && events && !source) return []
        return [{ id: COMMENT_ANNOTATION_PREFIX + thread.id, ...thread.anchor, seq: source?.seq ?? thread.anchor.seq,
          anchor: thread.anchor, number: index + 1, hideBadge: true, comment: '' }]
      })]
    }
  }
  return <CommentsContext.Provider value={value}>{children}</CommentsContext.Provider>
}

export function visibleCommentEvents(events: UAEvent[]): UAEvent[] {
  return events.filter(event => !(event.type === 'system_notice' && event.payload.kind === 'usage'))
}
