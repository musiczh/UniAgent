import { isToolSession, type NotificationMode, type Session, type SessionStatus, type UAEvent } from '../shared/types.ts'
import { isSessionBusy } from '../shared/sessionStatus.ts'
import { interactionRequestKey, isPendingInteraction } from '../shared/interactionRequests.ts'

/** Reading attention is independent of the session's execution/approval state. */
export class SessionAttentionBadge {
  private unread = new Set<string>()
  private visibleSessionId: string | null = null
  private lastEvents = new Map<string, Partial<Record<UAEvent['type'], string>>>()
  private statuses = new Map<string, SessionStatus>()

  constructor(private setBadge: (text: string) => void, private windowFocused: () => boolean) {}

  handleEvent(event: UAEvent, session: Session | undefined, source: 'main' | 'side' = 'main'): void {
    const attention = isPendingInteraction(event) ||
      event.type === 'error' && event.state === 'failed' ||
      event.type === 'turn_completed' && ['success', 'failed', 'cancelled'].includes(event.state || '')
    if (!attention) return
    const key = `${event.sessionId}:${source}`
    const requestKey = interactionRequestKey(event)
    const identity = JSON.stringify([requestKey || event.seq, requestKey ? undefined : event.ts, event.payload.teamRevision])
    const previous = this.lastEvents.get(key)
    if (previous?.[event.type] === identity) return
    this.lastEvents.set(key, { ...previous, [event.type]: identity })
    this.markUnread(session)
  }

  handleStatus(session: Session | undefined, status: SessionStatus, owner: Session | undefined = session): void {
    if (!session) return
    // Status edges stay keyed by the session that actually changed, while the
    // unread entry belongs to the row the user reads (a team's Leader session).
    const previous = this.statuses.get(session.id)
    this.statuses.set(session.id, status)
    if (previous === status) return
    // Some startup/queue failures only publish an error status, without an error event.
    if (status === 'error' || isSessionBusy(previous) && ['idle', 'completed', 'cancelled', 'interrupted'].includes(status)) {
      this.markUnread(owner)
    }
  }

  setVisibleSession(sessionId: string | null): void {
    this.visibleSessionId = sessionId
    this.readVisibleSession()
  }

  handleNavigation(isMainFrame: boolean, isInPlace: boolean): void {
    if (isMainFrame && !isInPlace) this.visibleSessionId = null
  }

  readVisibleSession(): void {
    if (this.windowFocused() && this.visibleSessionId && this.unread.delete(this.visibleSessionId)) this.publish()
  }

  removeSession(sessionId: string): void {
    this.lastEvents.delete(`${sessionId}:main`)
    this.lastEvents.delete(`${sessionId}:side`)
    this.statuses.delete(sessionId)
    if (this.visibleSessionId === sessionId) this.visibleSessionId = null
    if (this.unread.delete(sessionId)) this.publish()
  }

  private markUnread(session: Session | undefined): void {
    if (!session || session.archived || isToolSession(session) || this.unread.has(session.id) ||
        this.visibleSessionId === session.id && this.windowFocused()) return
    this.unread.add(session.id)
    this.publish()
  }

  private publish(): void {
    this.setBadge(this.unread.size ? String(this.unread.size) : '')
  }
}

export function shouldShowAppNotification(mode: NotificationMode, windowFocused: boolean): boolean {
  return mode === 'always' || (mode === 'unfocused' && !windowFocused)
}

export function appNotificationBody(event: UAEvent, failedSessions = new Set<string>()): string | null {
  if (event.type === 'turn_started') {
    failedSessions.delete(event.sessionId)
    return null
  }
  if (event.type === 'error' && event.state === 'failed') {
    if (failedSessions.has(event.sessionId)) return null
    failedSessions.add(event.sessionId)
    return '任务失败，点击查看详情'
  }
  if (event.type === 'turn_completed') {
    const alreadyFailed = failedSessions.delete(event.sessionId)
    if (event.state === 'failed') return alreadyFailed ? null : '任务失败，点击查看详情'
    return event.state === 'success' && !alreadyFailed ? '任务已完成' : null
  }
  if (event.type !== 'approval_request' || event.state !== 'pending') return null
  return event.payload?.kind === 'question' || event.payload?.kind === 'elicitation'
    ? 'Agent 正在等待你的回答'
    : 'Agent 正在等待你的批准'
}
