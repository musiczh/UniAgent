import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FeishuThreadLink } from '../shared/types.ts'
import { resolveUserDataHome } from './userData.ts'

/**
 * 需求4 — persistent session ↔ Feishu 话题(thread) mapping. One session binds one
 * thread; every push replies into that same thread. Survives app restarts so the
 * thread continuity is preserved and the水位(`lastPushedSeq`) still dedupes after
 * a WS reconnect. Best-effort disk I/O (like the other UniAgent stores) — a
 * corrupt/absent file resets to empty rather than throwing.
 */
export class FeishuThreadStore {
  private readonly file: string
  private readonly inboundFile: string
  private links: Map<string, FeishuThreadLink>
  private handledInbound: Set<string>
  private pendingInbound: Set<string>

  constructor(directory = resolveUserDataHome(), private readonly onLinksChanged?: () => void) {
    this.file = join(directory, 'feishu-threads.json')
    this.inboundFile = join(directory, 'feishu-inbound.json')
    this.links = this.load()
    const inbound = this.loadInbound()
    this.handledInbound = inbound.handled
    this.pendingInbound = inbound.pending
  }

  private load(): Map<string, FeishuThreadLink> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(raw)) {
        const map = new Map<string, FeishuThreadLink>()
        for (const item of raw) {
          if (item && typeof item.sessionId === 'string' && typeof item.chatId === 'string' && typeof item.rootMessageId === 'string') {
            map.set(item.sessionId, {
              sessionId: item.sessionId,
              chatId: item.chatId,
              rootMessageId: item.rootMessageId,
              replyInThread: typeof item.replyInThread === 'boolean' ? item.replyInThread : undefined,
              rootAppId: typeof item.rootAppId === 'string' || item.rootAppId === null ? item.rootAppId : undefined,
              botAppId: typeof item.botAppId === 'string' ? item.botAppId : undefined,
              rootTitle: typeof item.rootTitle === 'string' ? item.rootTitle : undefined,
              rootTitleSyncBlocked: item.rootTitleSyncBlocked === true || undefined,
              rootTitleRetryAt: Number.isFinite(item.rootTitleRetryAt) ? item.rootTitleRetryAt : undefined,
              threadId: typeof item.threadId === 'string' ? item.threadId : undefined,
              lastPushedSeq: Number.isFinite(item.lastPushedSeq) ? item.lastPushedSeq : 0,
              pendingRequestId: typeof item.pendingRequestId === 'string' ? item.pendingRequestId : undefined,
              driver: item.driver === 'feishu' || item.driver === 'app' ? item.driver : undefined
            })
          }
        }
        return map
      }
    } catch { /* absent / corrupt → empty */ }
    return new Map()
  }

  private persist(): void {
    try {
      if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify([...this.links.values()], null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch { /* best effort */ }
  }

  private loadInbound(): { handled: Set<string>; pending: Set<string> } {
    try {
      const raw = JSON.parse(readFileSync(this.inboundFile, 'utf8'))
      if (Array.isArray(raw)) {
        return {
          handled: new Set(raw.filter((id): id is string => typeof id === 'string').slice(-500)),
          pending: new Set()
        }
      }
      if (raw && Array.isArray(raw.handled) && Array.isArray(raw.pending)) {
        return {
          handled: new Set(raw.handled.filter((id: unknown): id is string => typeof id === 'string').slice(-500)),
          pending: new Set(raw.pending.filter((id: unknown): id is string => typeof id === 'string').slice(-500))
        }
      }
    } catch { /* absent / corrupt → empty */ }
    return {
      handled: new Set([...this.links.values()].map((link) => link.rootMessageId).slice(-500)),
      pending: new Set()
    }
  }

  hasHandledInbound(id: string): boolean {
    // A pending id left by a process exit has an ambiguous outcome. Prefer
    // at-most-once delivery on restart so an accepted Agent turn cannot repeat.
    return this.handledInbound.has(id) || this.pendingInbound.has(id) || this.byRootMessage(id) !== undefined
  }

  private persistInbound(handled: string[], pending: string[]): void {
    const temporary = `${this.inboundFile}.${process.pid}.tmp`
    try {
      if (!existsSync(dirname(this.inboundFile))) mkdirSync(dirname(this.inboundFile), { recursive: true })
      writeFileSync(temporary, JSON.stringify({ handled, pending }), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.inboundFile)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* absent */ }
      throw error
    }
  }

  /** Persist a retryable reservation before any inbound business side effect. */
  reserveInbound(id: string): void {
    if (this.handledInbound.has(id) || this.pendingInbound.has(id)) return
    const pending = [...this.pendingInbound, id].slice(-500)
    this.persistInbound([...this.handledInbound], pending)
    this.pendingInbound = new Set(pending)
  }

  /** Commit a successfully accepted inbound message across reconnects/restarts. */
  rememberInbound(id: string): void {
    if (this.handledInbound.has(id)) return
    const handled = [...this.handledInbound, id].slice(-500)
    const pending = [...this.pendingInbound].filter((item) => item !== id)
    this.persistInbound(handled, pending)
    this.handledInbound = new Set(handled)
    this.pendingInbound = new Set(pending)
  }

  hasPendingInbound(id: string): boolean {
    return this.pendingInbound.has(id)
  }

  /** Release a failed reservation so a later Feishu delivery can retry it. */
  forgetInbound(id: string): void {
    if (!this.pendingInbound.has(id)) return
    const pending = [...this.pendingInbound].filter((item) => item !== id)
    this.persistInbound([...this.handledInbound], pending)
    this.pendingInbound = new Set(pending)
  }

  bySession(sessionId: string): FeishuThreadLink | undefined {
    return this.links.get(sessionId)
  }

  byThread(threadId: string): FeishuThreadLink | undefined {
    if (!threadId) return undefined
    for (const link of this.links.values()) if (link.threadId === threadId) return link
    return undefined
  }

  /** Reverse-lookup by the thread's root message id (parent_id of a reply). */
  byRootMessage(rootMessageId: string): FeishuThreadLink | undefined {
    if (!rootMessageId) return undefined
    for (const link of this.links.values()) if (link.rootMessageId === rootMessageId) return link
    return undefined
  }

  upsert(link: FeishuThreadLink): FeishuThreadLink {
    this.links.set(link.sessionId, link)
    this.persist()
    this.onLinksChanged?.()
    return link
  }

  /** Merge a partial patch onto an existing link (no-op if unknown session). */
  patch(sessionId: string, patch: Partial<FeishuThreadLink>): FeishuThreadLink | undefined {
    const current = this.links.get(sessionId)
    if (!current) return undefined
    const next = { ...current, ...patch, sessionId: current.sessionId }
    this.links.set(sessionId, next)
    this.persist()
    return next
  }

  remove(sessionId: string): void {
    if (this.links.delete(sessionId)) {
      this.persist()
      this.onLinksChanged?.()
    }
  }

  all(): FeishuThreadLink[] {
    return [...this.links.values()]
  }
}
