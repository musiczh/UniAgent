import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '../shared/types'
import type { Orchestrator } from './orchestrator'
import type { TeamService } from './teamService'

export function registerSessionDeletionIpc(ipcMain: Pick<IpcMain, 'handle'>, options: {
  assertTrusted: (event: IpcMainInvokeEvent) => void
  hydrate: () => Promise<void>
  orchestrator: Pick<Orchestrator, 'getSessionById' | 'assertUserSessionEnabled' | 'previewSessionDeletion' | 'deleteSession'>
  teams: Pick<TeamService, 'catalog' | 'previewDeleteProject' | 'deleteProject'>
  deletingIds: Set<string>
  changed: () => void
}): void {
  const { assertTrusted, hydrate, orchestrator, teams, deletingIds, changed } = options
  const checks = new Map<string, AbortController>()
  ipcMain.handle(IPC.cancelSessionDeletionPreview, (event, requestId: unknown) => {
    assertTrusted(event)
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) throw new Error('invalid_deletion_request')
    checks.get(event.sender.id + ':' + requestId)?.abort()
  })
  ipcMain.handle(IPC.previewSessionDeletion, async (event, sessionId: unknown, requestId?: unknown) => {
    assertTrusted(event)
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('invalid_session_id')
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 100)) throw new Error('invalid_deletion_request')
    const key = event.sender.id + ':' + (requestId || sessionId)
    if (checks.has(key)) throw new Error('删除检查正在进行')
    const controller = new AbortController(), abort = () => controller.abort()
    checks.set(key, controller)
    event.sender.once('destroyed', abort)
    try {
      await hydrate()
      controller.signal.throwIfAborted()
      const team = teams.catalog().projects.find(p => Object.values(p.memberSessions).includes(sessionId))
      if (team && team.memberSessions[team.team.leaderMemberId] !== sessionId) throw new Error('team_member_read_only')
      if (!team) orchestrator.assertUserSessionEnabled(sessionId, true)
      const ids = team ? Object.values(team.memberSessions) : [sessionId]
      const sessions = ids.map(id => orchestrator.getSessionById(id))
      if (requestId && sessions.some(session => session?.config.worktree)) event.sender.send(IPC.sessionDeletionChecking, { requestId, title: team?.name || sessions[0]?.title || '任务' })
      return await (team ? teams.previewDeleteProject(team.id, controller.signal) : orchestrator.previewSessionDeletion(sessionId, controller.signal))
    } finally {
      checks.delete(key)
      event.sender.removeListener('destroyed', abort)
    }
  })
  ipcMain.handle(IPC.deleteSession, async (event, sessionId: unknown, confirmationId?: unknown) => {
    assertTrusted(event)
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('invalid_session_id')
    if (confirmationId !== undefined && typeof confirmationId !== 'string') throw new Error('invalid_deletion_confirmation')
    await hydrate()
    const team = teams.catalog().projects.find(p => Object.values(p.memberSessions).includes(sessionId))
    if (team && team.memberSessions[team.team.leaderMemberId] !== sessionId) throw new Error('team_member_read_only')
    if (!team) orchestrator.assertUserSessionEnabled(sessionId, true)
    const ids = team ? Object.values(team.memberSessions) : [sessionId]
    if (ids.some(id => deletingIds.has(id))) throw new Error('任务正在删除，请稍后再操作')
    const sessions = ids.map(id => orchestrator.getSessionById(id))
    for (const id of ids) deletingIds.add(id)
    changed()
    try {
      if (team) await teams.deleteProject(team.id, confirmationId)
      else await orchestrator.deleteSession(sessionId, confirmationId)
    } catch (error) {
      if (sessions.some(session => session?.config.worktree?.removedAt)) throw new Error(`工作树已清理，任务记录删除失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      for (const id of ids) deletingIds.delete(id)
      changed()
    }
  })
}
