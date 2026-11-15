import { isToolSession, type NotificationMode, type Session, type UAEvent } from '../shared/types.ts'
import { isSessionBusy } from '../shared/sessionStatus.ts'
import { attentionRequestIdentity, type LegacySessionAttention, type ReplyUnreadKind, type SessionAttentionChannel, type SessionAttentionData, type SessionAttentionSnapshot } from '../shared/sessionAttention'
import { interactionRequestKey, isPendingInteraction } from '../shared/interactionRequests'

/** The single unread ledger used by the Dock, sidebar and task board. */
export class SessionAttentionBadge {
  private channels = new Map<string, SessionAttentionChannel>()
  private visibleSessionId: string | null = null
  private statuses = new Map<string, string>()
  private clearedResults = new Set<string>()
  private removedSessions = new Set<string>()
  private readOwners = new Set<string>()
  private revision = 0
  private badgeText = ''
  private legacyImported = false

  constructor(private setBadge: (text: string) => void, private windowFocused: () => boolean,
    private onChange: (snapshot: SessionAttentionSnapshot) => void = () => {}) {}

  handleEvent(event: UAEvent, session: Session | undefined, source: ReplyUnreadKind = 'main'): void {
    if (!this.available(session, true) || event.payload.recoveryIntermediate || event.payload.automaticRecovery) return
    const archived = this.archived(session)
    if (archived) this.archiveSession(session.id)
    const key = this.key(event.sessionId, source)
    const channel = this.channel(event.sessionId, session.id, source)
    const requestId = interactionRequestKey(event)
    if (requestId && (event.payload.submittedAnswer !== undefined || event.payload.interactionExpired ||
      event.type === 'approval_request' && ['cancelled', 'failed'].includes(event.state || ''))) {
      const identity = attentionRequestIdentity(event), previous = channel.requests[identity]
      if (previous?.settled) return
      channel.requests[identity] = { unread: false, settled: true }
    } else if (isPendingInteraction(event)) {
      const identity = attentionRequestIdentity(event)
      if (channel.requests[identity]) return
      channel.requests[identity] = { unread: !archived && this.shouldMark(session.id), settled: false }
    } else if ((event.type === 'user_message' || event.type === 'goal_message' || event.type === 'turn_started') && !event.payload.hidden) {
      // Input reads the previous result; only a confirmed response settles a question.
      this.clearedResults.add(key)
      if (!channel.result?.unread) return
      channel.result.unread = false
    } else if (event.type === 'error' && event.state === 'failed' ||
      event.type === 'turn_completed' && ['success', 'failed', 'cancelled'].includes(event.state || '')) {
      const identity = JSON.stringify([event.type, event.seq, event.ts])
      if (channel.result?.identity === identity) return
      channel.result = { identity, unread: !archived && this.shouldMark(session.id) }
    } else return
    this.publish()
  }

  handleStatus(session: Session | undefined, status: string, owner: Session | undefined = session, source: ReplyUnreadKind = 'main'): void {
    if (!session) return
    if (!this.available(session, true) || !this.available(owner, true)) { this.removeSession(session.id); return }
    if (this.archived(session) || this.archived(owner)) {
      this.archiveSession(this.archived(owner) ? owner.id : session.id)
      this.statuses.set(this.key(session.id, source), status)
      return
    }
    const key = this.key(session.id, source), previous = this.statuses.get(key)
    this.statuses.set(key, status)
    if (previous === status) return
    const channel = this.channel(session.id, owner.id, source)
    if (status === 'running' || status === 'queued') {
      this.clearedResults.add(key)
      if (channel.result?.unread) { channel.result.unread = false; this.publish() }
      return
    }
    if (status === 'error' || isSessionBusy(previous) && ['idle', 'completed', 'cancelled', 'interrupted'].includes(status)) {
      channel.result = { identity: 'status:' + status, unread: this.shouldMark(owner.id) }
      this.publish()
    }
  }

  handleSession(session: Session, owner: Session = session): void {
    this.handleStatus(session, session.status, owner)
  }

  remapOwners(ownerId: (id: string) => string): void {
    let changed = false
    for (const channel of this.channels.values()) {
      const id = ownerId(channel.sessionId)
      if (id === channel.ownerId) continue
      channel.ownerId = id
      if (!this.shouldMark(id)) this.readChannel(channel)
      changed = true
    }
    if (changed) this.publish()
  }

  snapshot(): SessionAttentionSnapshot {
    const unreadBySession: SessionAttentionSnapshot['unreadBySession'] = {}
    for (const channel of this.channels.values()) {
      if (channel.result?.unread || Object.values(channel.requests).some(request => request.unread && !request.settled)) {
        // Main questions/results retain the blue marker when both branches are unread.
        if (unreadBySession[channel.ownerId] !== 'main') unreadBySession[channel.ownerId] = channel.source
      }
    }
    return { revision: this.revision, unreadBySession }
  }

  serialize(): SessionAttentionData {
    return structuredClone({ version: 1, legacyImported: this.legacyImported, channels: [...this.channels.values()] })
  }

  restore(data: SessionAttentionData, sessions: readonly Session[], ownerId: (id: string) => string = id => id): void {
    const known = new Map(sessions.map(session => [session.id, session]))
    this.legacyImported = data.legacyImported
    for (const saved of data.channels) {
      const session = known.get(saved.sessionId), owner = known.get(ownerId(saved.sessionId))
      const key = this.key(saved.sessionId, saved.source)
      if (!this.available(session, true) || !this.available(owner, true) || this.removedSessions.has(saved.sessionId) || this.removedSessions.has(owner.id)) continue
      const channel = structuredClone(saved)
      channel.ownerId = owner.id
      if ((this.clearedResults.has(key) || channel.source === 'main' && ['running', 'queued'].includes(session.status)) && channel.result) channel.result.unread = false
      if (this.archived(session) || this.archived(owner) || this.readOwners.has(owner.id) || !this.shouldMark(owner.id)) this.readChannel(channel)
      const live = this.channels.get(key)
      if (live) {
        channel.requests = { ...channel.requests, ...live.requests }
        if (live.result) channel.result = live.result
      }
      this.channels.set(key, channel)
    }
    for (const session of sessions) {
      const key = this.key(session.id, 'main')
      if (!this.statuses.has(key)) this.statuses.set(key, session.status)
    }
    this.publish()
  }

  needsLegacyImport(): boolean { return !this.legacyImported }

  importLegacy(legacy: LegacySessionAttention, sessions: readonly Session[], events: (id: string, source: ReplyUnreadKind) => readonly UAEvent[], ownerId: (id: string) => string = id => id): void {
    if (this.legacyImported) return
    this.legacyImported = true
    for (const session of sessions) {
      const source = legacy.unread[session.id]
      if (!source || !this.available(session) || this.removedSessions.has(session.id)) continue
      const channel = this.channel(session.id, ownerId(session.id), source)
      const mark = this.shouldMark(channel.ownerId) && !this.readOwners.has(channel.ownerId)
      const history = events(session.id, source), requests = new Map<string, UAEvent>()
      for (const event of history) if (interactionRequestKey(event)) requests.set(attentionRequestIdentity(event), event)
      const pending = [...requests.values()].filter(isPendingInteraction)
      for (const request of pending) channel.requests[attentionRequestIdentity(request)] ??= { unread: mark, settled: false }
      const result = history.findLast(event => event.type === 'turn_completed' || event.type === 'error' && event.state === 'failed')
      const lastQuestion = history.findLast(event => !!interactionRequestKey(event))
      const wasQuestion = !!legacy.pending[session.id]?.length || !!lastQuestion && (!result || lastQuestion.seq >= result.seq)
      const resumed = source === 'main' && ['running', 'queued'].includes(session.status)
      if (!channel.result && !this.clearedResults.has(this.key(session.id, source)) && !resumed && (!wasQuestion || result && (!lastQuestion || result.seq > lastQuestion.seq))) {
        channel.result = { identity: result ? JSON.stringify([result.type, result.seq, result.ts]) : 'legacy', unread: mark }
      }
    }
    this.publish()
  }

  pendingSessionIds(): string[] {
    return [...new Set([...this.channels.values()].filter(channel => Object.values(channel.requests).some(request => request.unread && !request.settled)).map(channel => channel.sessionId))]
  }

  reconcileRequests(sessionId: string, events: readonly UAEvent[], source: ReplyUnreadKind): void {
    const channel = this.channels.get(this.key(sessionId, source))
    if (!channel) return
    const latest = new Map<string, UAEvent>()
    for (const event of events) if (interactionRequestKey(event)) latest.set(attentionRequestIdentity(event), event)
    let changed = false
    for (const [identity, request] of Object.entries(channel.requests)) {
      const event = latest.get(identity)
      if (request.settled || !request.unread || event && isPendingInteraction(event)) continue
      channel.requests[identity] = { unread: false, settled: true }; changed = true
    }
    if (changed) this.publish()
  }

  setVisibleSession(sessionId: string | null): void {
    this.visibleSessionId = sessionId
    this.readVisibleSession()
  }

  handleNavigation(isMainFrame: boolean, isInPlace: boolean): void {
    if (isMainFrame && !isInPlace) this.visibleSessionId = null
  }

  readVisibleSession(): void {
    if (!this.windowFocused() || !this.visibleSessionId) return
    this.readOwners.add(this.visibleSessionId)
    let changed = false
    for (const channel of this.channels.values()) if (channel.ownerId === this.visibleSessionId) changed = this.readChannel(channel) || changed
    if (changed) this.publish()
  }

  archiveSession(sessionId: string): void {
    this.readOwners.add(sessionId)
    let changed = false
    for (const channel of this.channels.values()) {
      if (channel.sessionId === sessionId || channel.ownerId === sessionId) changed = this.readChannel(channel) || changed
    }
    if (this.visibleSessionId === sessionId) this.visibleSessionId = null
    if (changed) this.publish()
  }

  removeSession(sessionId: string): void {
    this.removedSessions.add(sessionId)
    let changed = false
    for (const [key, channel] of this.channels) if (channel.sessionId === sessionId || channel.ownerId === sessionId) {
      this.channels.delete(key); this.statuses.delete(key); changed = true
    }
    if (this.visibleSessionId === sessionId) this.visibleSessionId = null
    if (changed) this.publish()
  }

  private key(sessionId: string, source: ReplyUnreadKind): string { return JSON.stringify([sessionId, source]) }

  private channel(sessionId: string, ownerId: string, source: ReplyUnreadKind): SessionAttentionChannel {
    const key = this.key(sessionId, source)
    let channel = this.channels.get(key)
    if (!channel) { channel = { sessionId, ownerId, source, requests: {} }; this.channels.set(key, channel) }
    channel.ownerId = ownerId
    return channel
  }

  private archived(session: Session): boolean {
    return !!session.archived || session.status === 'archived' || session.taskState?.phase === 'archived'
  }

  private available(session: Session | undefined, includeArchived = false): session is Session {
    return !!session && (includeArchived || !this.archived(session)) && !isToolSession(session) && !session.config.managedPurpose
  }

  private shouldMark(ownerId: string): boolean { return this.visibleSessionId !== ownerId || !this.windowFocused() }

  private readChannel(channel: SessionAttentionChannel): boolean {
    let changed = false
    for (const request of Object.values(channel.requests)) if (request.unread) { request.unread = false; changed = true }
    if (channel.result?.unread) { channel.result.unread = false; changed = true }
    return changed
  }

  private publish(): void {
    this.revision++
    const snapshot = this.snapshot(), count = Object.keys(snapshot.unreadBySession).length, text = count ? String(count) : ''
    if (text !== this.badgeText) { this.badgeText = text; this.setBadge(text) }
    this.onChange(snapshot)
  }
}

export function shouldShowAppNotification(mode: NotificationMode, windowFocused: boolean): boolean {
  return mode === 'always' || (mode === 'unfocused' && !windowFocused)
}

export function appNotificationBody(event: UAEvent, failedSessions = new Set<string>()): string | null {
  if (event.payload?.recoveryIntermediate || event.payload?.automaticRecovery) return null
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
