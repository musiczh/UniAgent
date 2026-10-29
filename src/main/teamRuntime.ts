import { randomBytes } from 'node:crypto'

/** In-memory only. Never serialize capabilities into a Session or project. */
type TeamRuntime = { token: string; leader: boolean; instructions: string; beforeUserTurn?: () => void; rewindReason?: () => string | undefined; afterRewind?: () => void }
const bindings = new Map<string, TeamRuntime>()
export const TEAM_EXECUTION = Symbol('team-execution')
export function bindTeamRuntime(sessionId: string, leader: boolean, instructions: string, beforeUserTurn?: () => void, rewindReason?: () => string | undefined, afterRewind?: () => void): void {
  const old = bindings.get(sessionId)
  bindings.set(sessionId, { token: old?.token || randomBytes(32).toString('hex'), leader, instructions, beforeUserTurn, rewindReason, afterRewind })
}
export function teamRuntime(sessionId?: string): TeamRuntime | undefined { return sessionId ? bindings.get(sessionId) : undefined }
export function authenticateTeamRuntime(token: unknown): string {
  if (typeof token !== 'string' || token.length !== 64) throw new Error('not_team_session')
  for (const [id, b] of bindings) if (b.token === token) return id
  throw new Error('not_team_session')
}
