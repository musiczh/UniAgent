import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentDef, Session, UAEvent } from '@shared/types'
import type { CommentSelection, CommentThread } from '@shared/comments'
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
  close(): void
  show(): void
  setTab(tab: 'ai' | 'pending'): void
  locate(thread: CommentThread): void
  annotations(annotations: Annotation[], sessionId?: string): Annotation[]
}
const CommentsContext = createContext<CommentsState | null>(null)
export function useComments(): CommentsState | null { return useContext(CommentsContext) }
export const COMMENT_ANNOTATION_PREFIX = 'ai-comment:'

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
  const owner = useRef<string>()
  const configure = useCallback((next: Session | null, definitions: AgentDef[]) => { setSession(next); setAgents(definitions) }, [])
  useEffect(() => window.uniagent.onCommentChanged(thread => {
    setByOwner(previous => ({ ...previous, [thread.sessionId]: merge(previous[thread.sessionId] || [], thread) }))
  }), [])
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
      if (!cancelled) setByOwner(previous => ({ ...previous, [id]: rows.reduce(merge, previous[id] || []) }))
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
    session, agents, threads, selected, open, tab, error, loading, configure, select,
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
    annotations(existing, sessionId) {
      if (!sessionId || sessionId !== session?.id) return existing
      return [...existing, ...threads.map((thread, index) => ({ id: COMMENT_ANNOTATION_PREFIX + thread.id, ...thread.anchor,
        anchor: thread.anchor, number: index + 1, hideBadge: thread.status === 'draft', comment: '' }))]
    }
  }
  return <CommentsContext.Provider value={value}>{children}</CommentsContext.Provider>
}

export function visibleCommentEvents(events: UAEvent[]): UAEvent[] {
  return events.filter(event => !(event.type === 'system_notice' && event.payload.kind === 'usage'))
}
