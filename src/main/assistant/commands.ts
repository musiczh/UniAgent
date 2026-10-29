import type { Orchestrator } from '../orchestrator'
import { isSessionBusy } from '../../shared/sessionStatus'
import type { PersonalAssistantSnapshot } from '../../shared/assistant'
import type { Session, SessionConfig } from '../../shared/types'

export class AssistantCommands {
  private receipts = new Map<string, Promise<Session>>()
  constructor(private orchestrator: Orchestrator, private snapshot: () => Promise<PersonalAssistantSnapshot>, private invalidate: () => Promise<void>, private defaultConfig: () => Promise<SessionConfig>) {}
  execute(sessionId: string, command: 'new' | 'clear', requestId: string): Promise<Session> {
    if (typeof sessionId !== 'string' || !['new','clear'].includes(command) || typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId)) return Promise.reject(new Error('invalid_assistant_command'))
    const key = `${sessionId}:${command}:${requestId}`
    if (this.receipts.has(key)) return this.receipts.get(key)!
    const result = this.run(sessionId, command)
    this.receipts.set(key, result)
    if (this.receipts.size > 200) this.receipts.delete(this.receipts.keys().next().value!)
    return result
  }
  private async run(sessionId: string, command: 'new' | 'clear'): Promise<Session> {
    const session = this.orchestrator.getSessionById(sessionId)
    if (!session?.config.assistantSnapshot || session.teamBinding || session.readOnly || session.handoffId) throw new Error('assistant_session_required')
    this.orchestrator.lockAssistantCommand(sessionId)
    try {
      const { initializationJobId, initializationTargetAgentId, workspaceSelection, roleSnapshot, useAssistant, worktree, ...config } = session.config
      const nextConfig = command === 'new'
        ? { ...await this.defaultConfig(), ...(session.config.assistantChannel ? { assistantChannel: session.config.assistantChannel } : {}) }
        : { ...config, assistantSnapshot: await this.snapshot() }
      await this.invalidate()
      if (isSessionBusy(session.status) || this.orchestrator.getQueue(sessionId).length) {
        await new Promise<void>((resolve, reject) => {
          const end = () => { if (!isSessionBusy(session.status)) { cleanup(); resolve() } }
          const timer = setTimeout(() => { cleanup(); reject(new Error('assistant_session_busy')) }, 10000)
          const cleanup = () => { clearTimeout(timer); this.orchestrator.removeListener('statusChange', end); this.orchestrator.removeListener('assistantTurnEnded', end) }
          this.orchestrator.on('statusChange', end)
          this.orchestrator.on('assistantTurnEnded', end)
          this.orchestrator.interrupt(sessionId)
          end()
        })
      }
      if (this.orchestrator.getSessionById(sessionId) !== session) throw new Error('assistant_session_busy')
      return this.orchestrator.createAssistantDraft(nextConfig, sessionId, command)
    } finally { this.orchestrator.assistantCommandSessions.delete(sessionId) }
  }
}
