import { SessionAttentionBadge } from '../../src/main/appNotifications'
import type { LegacySessionAttention, SessionAttentionSnapshot, ReplyUnreadKind } from '../../src/shared/sessionAttention'
import type { Session, UAEvent } from '../../src/shared/types'

/** In-process stand-in for the main/preload IPC boundary, using the production ledger. */
export function sessionAttentionFixture(sessions: () => Session[], events: (id: string, source: ReplyUnreadKind) => readonly UAEvent[],
  focused = () => document.hasFocus()) {
  const listeners = new Set<(snapshot: SessionAttentionSnapshot) => void>()
  let text = ''
  const create = () => new SessionAttentionBadge(value => { text = value }, focused, snapshot => {
    for (const listener of listeners) listener(snapshot)
  })
  let badge = create()
  badge.restore({ version: 1, legacyImported: false, channels: [] }, sessions())
  return {
    get badge() { return badge },
    text: () => text,
    methods: {
      getSessionAttention: async (legacy: LegacySessionAttention) => {
        badge.importLegacy(legacy, sessions(), events)
        return badge.snapshot()
      },
      onSessionAttentionChanged: (callback: (snapshot: SessionAttentionSnapshot) => void) => {
        listeners.add(callback); return () => { listeners.delete(callback) }
      },
      setBadgeVisibleSession: async (id: string | null) => { badge.setVisibleSession(id) }
    },
    push(name: string, value: any) {
      const session = sessions().find(item => item.id === (value?.sessionId || value?.event?.sessionId || value?.session?.id || value?.id))
      if (name === 'event') badge.handleEvent(value, session)
      if (name === 'side' || name === 'sideEvent') badge.handleEvent(value.event, session, 'side')
      if ((name === 'status' || name === 'sideStatus') && session) {
        badge.handleStatus(session, value.status, session, name === 'sideStatus' ? 'side' : 'main')
        if (name === 'status') session.status = value.status
      }
      if (name === 'updated') badge.handleSession(value.session)
      if (name === 'created') badge.handleSession(value)
    },
    restart(legacy = false) {
      const saved = legacy ? { version: 1 as const, legacyImported: false, channels: [] } : badge.serialize()
      text = ''; badge = create(); badge.restore(saved, sessions())
    },
    reconcile(id: string) {
      badge.reconcileRequests(id, events(id, 'main'), 'main')
      badge.reconcileRequests(id, events(id, 'side'), 'side')
    }
  }
}
