import type { Orchestrator } from '../orchestrator'
import { isSessionBusy } from '../../shared/sessionStatus'
import type { PersonalAssistantSnapshot } from '../../shared/assistant'
import { parseAssistantConversationSelection, type AssistantConversationSelection } from '../../shared/assistantConversation'
import type { Session, SessionConfig } from '../../shared/types'

export class AssistantCommands {
  private receipts = new Map<string, Promise<Session>>()
  private appConversationFlight?: Promise<Session>
  constructor(private orchestrator: Orchestrator, private snapshot: () => Promise<PersonalAssistantSnapshot>, private invalidate: () => Promise<void>, private defaultConfig: (selection?: AssistantConversationSelection) => Promise<SessionConfig>) {}
  openAppConversation(): Promise<Session> {
    if (this.appConversationFlight) return this.appConversationFlight
    const current = this.orchestrator.listSessions().find(session => session.config.assistantSnapshot && session.config.assistantChannel === 'app' &&
      !session.assistantEndReason && !session.archived && !session.readOnly && !session.teamBinding && !session.handoffId)
    if (current) return Promise.resolve(current)
    const flight = this.defaultConfig().then(config => this.orchestrator.createAssistantDraft({ ...config, assistantChannel: 'app' }))
    this.appConversationFlight = flight
    void flight.then(() => { this.appConversationFlight = undefined }, () => { this.appConversationFlight = undefined })
    return flight
  }
  execute(sessionId: string, command: 'new' | 'clear', requestId: string, selection?: AssistantConversationSelection): Promise<Session> {
    if (typeof sessionId !== 'string' || !['new','clear'].includes(command) || typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId)) return Promise.reject(new Error('invalid_assistant_command'))
    try { selection = parseAssistantConversationSelection(selection) } catch (error) { return Promise.reject(error) }
    if (command === 'clear' && selection) return Promise.reject(new Error('清空对话不支持覆盖参数'))
    const key = `${sessionId}:${command}:${requestId}`
    if (this.receipts.has(key)) return this.receipts.get(key)!
    const result = this.run(sessionId, command, selection)
    this.receipts.set(key, result)
    if (this.receipts.size > 200) this.receipts.delete(this.receipts.keys().next().value!)
    return result
  }
  private async run(sessionId: string, command: 'new' | 'clear', selection?: AssistantConversationSelection): Promise<Session> {
    const session = this.orchestrator.getSessionById(sessionId)
    if (!session?.config.assistantSnapshot || session.teamBinding || session.readOnly || session.handoffId) throw new Error('assistant_session_required')
    this.orchestrator.lockAssistantCommand(sessionId)
    try {
      const { initializationJobId, initializationTargetAgentId, workspaceSelection, roleSnapshot, useAssistant, worktree, ...config } = session.config
      const nextConfig = command === 'new'
        ? { ...await this.defaultConfig(selection), ...(session.config.assistantChannel ? { assistantChannel: session.config.assistantChannel } : {}) }
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
