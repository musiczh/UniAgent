import { useEffect, useRef, useState } from 'react'
import type { AgentDef, Session } from '@shared/types'
import type { AssistantConversationSelection } from '@shared/assistantConversation'
import type { AssistantFeishuState } from '@shared/assistant'
import type { AssistantWeixinState } from '@shared/weixin'
import type { SessionAttentionSnapshot } from '@shared/sessionAttention'
import { sessionDisplayTitle } from '@shared/task'
import { isSessionBusy } from '@shared/sessionStatus'
import { UiIcon } from './Icons'
import { AssistantNewConversation } from './AssistantNewConversation'
import { AssistantSessionHistory } from './AssistantSessionHistory'
import { readBrowserValue, saveBrowserValue, scopeSessions } from '../scopeBrowser'
import './assistantConversations.css'

type Channel = 'feishu' | 'weixin' | 'app'
const channelKey = 'ua.assistantConversation.channel'
const channels = [{ id: 'feishu', label: '飞书', icon: 'feishu' }, { id: 'weixin', label: '微信', icon: 'message-square' }, { id: 'app', label: 'UniAgent App', icon: 'code' }] as const
const usable = (session: Session): boolean => !!session.config.assistantSnapshot && !session.archived && !session.readOnly && !session.teamBinding && !session.handoffId

/** Select channels around the original App session view; never render another transcript or input. */
export function AssistantConversations({ agents, sessions, activeId, replacements, unread, onSelect, onSessions, onCreated, onNew, onArchive, onUnarchive, onSettings }: {
  agents: AgentDef[]; sessions: Session[]; activeId: string | null; replacements: Record<string, string>; unread: SessionAttentionSnapshot['unreadBySession']
  onSelect(id: string | null): void; onSessions(sessions: Session[]): void; onCreated(session: Session): void
  onNew(sessionId: string, selection?: AssistantConversationSelection): Promise<void>; onSettings(): void
  onArchive(id: string): Promise<boolean>; onUnarchive(id: string): Promise<void>
}): JSX.Element {
  const [channel, setChannel] = useState<Channel>(() => { const saved = readBrowserValue(channelKey, 'feishu'); return channels.some(c => c.id === saved) ? saved as Channel : 'feishu' })
  const [state, setState] = useState<{ ids: string[]; feishu?: AssistantFeishuState; weixin?: AssistantWeixinState }>({ ids: [] })
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [creating, setCreating] = useState(false), [newPending, setNewPending] = useState(false), [newError, setNewError] = useState('')
  const [retry, setRetry] = useState(0)
  const [newOpen, setNewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false), [historyId, setHistoryId] = useState<string | null>(null)
  const [historyPending, setHistoryPending] = useState<string | null>(null), [historyError, setHistoryError] = useState('')
  const newAnchor = useRef<HTMLDivElement>(null), newButton = useRef<HTMLButtonElement>(null)
  const historyAnchor = useRef<HTMLDivElement>(null), historyButton = useRef<HTMLButtonElement>(null)
  const historyRef = useRef(historyId), navigation = useRef(0), historyFlight = useRef(false)
  historyRef.current = historyId
  const live = useRef(true), channelRef = useRef(channel), newFlight = useRef(false), appFlight = useRef(false)
  channelRef.current = channel
  const callbacks = useRef({ onSelect, onSessions, onCreated }); callbacks.current = { onSelect, onSessions, onCreated }
  useEffect(() => {
    live.current = true
    let generation = 0
    const refresh = (): void => {
      const ticket = ++generation
      void Promise.allSettled([window.uniagent.getAssistantPrivateSessions(), window.uniagent.getAssistantFeishu(), window.uniagent.getAssistantWeixin(), window.uniagent.listSessions()]).then(results => {
        if (!live.current || ticket !== generation) return
        const [ids, feishu, weixin, rows] = results
        setState(previous => ({ ids: ids.status === 'fulfilled' ? ids.value : previous.ids,
          feishu: feishu.status === 'fulfilled' ? feishu.value : previous.feishu, weixin: weixin.status === 'fulfilled' ? weixin.value : previous.weixin }))
        if (rows.status === 'fulfilled') callbacks.current.onSessions(rows.value)
        setError(results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => String(r.reason)).join('；'))
        setLoading(false)
      })
    }
    const stops = [window.uniagent.onAssistantPrivateSessionsChanged(refresh), window.uniagent.onAssistantFeishuChanged(refresh), window.uniagent.onAssistantWeixinChanged(refresh), window.uniagent.onAssistantChanged(refresh)]
    refresh()
    return () => { live.current = false; generation++; stops.forEach(stop => stop()) }
  }, [retry])

  function currentId(id?: string): string | undefined {
    const seen = new Set<string>()
    while (id && replacements[id] && !seen.has(id)) { seen.add(id); id = replacements[id] }
    return id
  }
  const app = sessions.filter(s => usable(s) && s.config.assistantChannel === 'app' && !s.assistantEndReason)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))[0]
  const weixinId = currentId(state.weixin?.sessionId)
  const feishuId = state.ids.map(currentId).find(id => id !== weixinId && sessions.some(s => s.id === id && usable(s) && !s.config.assistantChannel))
  const desiredId = channel === 'app' ? currentId(app?.id) : channel === 'weixin' ? weixinId : feishuId
  const selected = sessions.find(s => s.id === desiredId && usable(s))
  const historySessions = scopeSessions(sessions, { kind: 'assistant' }).filter(session => (session.config.assistantChannel || 'feishu') === channel)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
  const historical = historySessions.find(session => session.id === historyId)
  const displayed = historical || selected
  useEffect(() => { setNewOpen(false); setNewError('') }, [channel, selected?.id, historyId])
  useEffect(() => {
    if (!newOpen && !historyOpen) return
    const anchor = historyOpen ? historyAnchor : newAnchor, button = historyOpen ? historyButton : newButton
    const close = (): void => { setNewOpen(false); setHistoryOpen(false) }
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); button.current?.focus() } }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true) }
  }, [newOpen, historyOpen])
  const unreadChannels = new Set(scopeSessions(sessions, { kind: 'assistant' })
    .filter(session => !session.archived && session.status !== 'archived' && session.taskState?.phase !== 'archived' && unread[session.id])
    .map(session => session.config.assistantChannel || 'feishu'))
  // Do not clear a working conversation during a failed or unfinished status read.
  useEffect(() => {
    if (loading || error) return
    if (historyId && !historical) { historyRef.current = null; setHistoryId(null) }
    if (displayed?.id !== activeId && !(channel === 'app' && !displayed)) callbacks.current.onSelect(displayed?.id || null)
  }, [channel, displayed?.id, historyId, historical?.id, activeId, loading, error])

  useEffect(() => {
    if (channel !== 'app' || selected || historyId || loading || error || appFlight.current) return
    appFlight.current = true; setCreating(true)
    void window.uniagent.openAssistantAppConversation().then(session => {
      if (!live.current) return
      callbacks.current.onCreated(session)
      if (channelRef.current === 'app' && !historyRef.current) callbacks.current.onSelect(session.id)
    }, reason => { if (live.current) setNewError(String(reason)) }).finally(() => {
      appFlight.current = false
      if (live.current) setCreating(false)
    })
  }, [channel, selected?.id, historyId, loading, error, retry])

  function changeChannel(value: Channel): void {
    channelRef.current = value; setChannel(value); saveBrowserValue(channelKey, value); setNewError('')
    navigation.current++; historyRef.current = null; setHistoryId(null); setHistoryOpen(false); setHistoryError('')
    // Clear the old transcript immediately so no input can target the previous Tab.
    callbacks.current.onSelect(null)
  }
  function selectHistory(id: string | null): void {
    navigation.current++; historyRef.current = id; setHistoryId(id); setHistoryOpen(false)
    callbacks.current.onSelect(id || selected?.id || null)
  }
  async function changeArchive(id: string, restore: boolean): Promise<void> {
    const session = historySessions.find(row => row.id === id)
    if (historyFlight.current || !session || !restore && (id === selected?.id || isSessionBusy(session.status) || session.recovery && session.recovery.phase !== 'stopped')) return
    historyFlight.current = true; setHistoryPending(id); setHistoryError('')
    const owner = channel, generation = navigation.current
    try {
      let archived = false
      if (restore) await onUnarchive(id)
      else archived = await onArchive(id)
      if (live.current && archived && historyRef.current === id && navigation.current === generation) { historyRef.current = null; setHistoryId(null) }
    } catch (reason) { if (live.current && channelRef.current === owner) setHistoryError(String(reason)) }
    finally { historyFlight.current = false; if (live.current) setHistoryPending(null) }
  }
  async function startNew(selection?: AssistantConversationSelection): Promise<void> {
    if (newFlight.current || !selected) return
    newFlight.current = true; setNewPending(true); setNewError('')
    const owner = channel, generation = navigation.current
    try { await onNew(selected.id, selection); if (live.current && channelRef.current === owner && navigation.current === generation) { historyRef.current = null; setHistoryId(null); setNewOpen(false) } }
    catch (reason) { if (live.current && channelRef.current === owner) setNewError(String(reason)) }
    finally { newFlight.current = false; if (live.current) setNewPending(false) }
  }
  const unavailable = channel === 'feishu' ? !state.feishu?.configured : channel === 'weixin' ? !state.weixin?.configured : false
  const canShowConversation = !!activeId && (loading || !!error || activeId === displayed?.id)
  return <>
    <div className="assistant-conversation-header">
      <span className="assistant-conversation-title">个人助手</span>
      <div className="task-detail-tabs" role="tablist" aria-label="个人助手渠道" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = channels.findIndex(c => c.id === channel)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3
        changeChannel(channels[next].id)
        event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next].focus()
      }}>{channels.map(c => <button key={c.id} id={'assistant-channel-' + c.id} type="button" role="tab" aria-selected={channel === c.id} aria-controls="assistant-conversation-content" tabIndex={channel === c.id ? 0 : -1} onClick={() => changeChannel(c.id)}><UiIcon name={c.icon} size={15}/><span>{c.label}</span>{unreadChannels.has(c.id) && <span className="si-unread" role="img" aria-label={c.label + '有未读消息'}/>}</button>)}</div>
      <div className="assistant-conversation-actions"><div className="assistant-new-anchor" ref={historyAnchor}><button ref={historyButton} type="button" className="scope-button" aria-label="历史会话" aria-haspopup="dialog" aria-expanded={historyOpen} onClick={() => { setNewOpen(false); setHistoryOpen(value => !value) }}><UiIcon name="history" size={14}/>历史会话</button>
        {historyOpen && <AssistantSessionHistory sessions={historySessions} agents={agents} channelLabel={channels.find(item => item.id === channel)!.label} currentId={selected?.id} loading={loading} error={error} pending={historyPending} operationError={historyError} onSelect={id => selectHistory(id === selected?.id ? null : id)} onArchive={id => { void changeArchive(id, false) }} onUnarchive={id => { void changeArchive(id, true) }} onRetry={() => setRetry(value => value + 1)} onClose={() => { setHistoryOpen(false); historyButton.current?.focus() }}/>}</div>
        <div className="assistant-new-anchor" ref={newAnchor}><button ref={newButton} type="button" className="scope-button" aria-label="新对话（/new）" aria-haspopup="dialog" aria-expanded={newOpen} title="选择新对话的 Agent、模型和思考强度" disabled={!selected || newPending || creating} onClick={() => { setHistoryOpen(false); setNewError(''); setNewOpen(value => !value) }}><UiIcon name="plus" size={14}/>{newPending ? '正在新建…' : '新对话'}</button>
        {newOpen && selected && <AssistantNewConversation agents={agents} pending={newPending} error={newError} onClose={() => { setNewOpen(false); newButton.current?.focus() }} onCreate={startNew}/>}</div><button className="scope-button" onClick={onSettings}>助手设置</button></div>
    </div>
    {historical && <div className="assistant-history-reading"><span>正在查看会话 · {sessionDisplayTitle(historical)}{historical.archived && <span>（已归档，仅供查看）</span>}</span><button type="button" aria-label="返回当前对话" disabled={!selected} onClick={() => selectHistory(null)}>返回当前对话</button></div>}
    {(error || newError && !newOpen) && <div className="assistant-channel-error" role="alert">{newError || error}<button onClick={() => { setNewError(''); setRetry(value => value + 1) }}>重试</button></div>}
    {!canShowConversation && <div className="assistant-conversation-empty" id="assistant-conversation-content" role="tabpanel" aria-labelledby={'assistant-channel-' + channel}>
      {loading || channel === 'app' && creating ? <p role="status">{creating ? '正在准备 App 助手对话…' : '正在读取助手对话…'}</p> : <><UiIcon name={channel === 'feishu' ? 'feishu' : 'message-square'} size={28}/><h2>{unavailable ? `还没有绑定${channel === 'weixin' ? '微信' : '飞书'}` : channel === 'app' ? '暂时无法打开 App 助手对话' : `还没有${channel === 'weixin' ? '微信' : '飞书'}对话`}</h2><p>{unavailable ? '绑定后，在这里直接查看和继续对话。' : channel === 'app' ? '请检查个人助手的默认 Agent 和设置后重试。' : '先在对应渠道向个人助手发送消息，再回到这里继续对话。'}</p><button className="scope-button" onClick={onSettings}>{unavailable ? `去绑定${channel === 'weixin' ? '微信' : '飞书'}` : '助手设置'}</button></>}
    </div>}
  </>
}
