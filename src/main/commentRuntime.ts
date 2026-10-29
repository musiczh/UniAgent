import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { SessionStore } from './sessionStore'
import type { AgentDef, AgentPref, SessionConfig, UAEvent } from '../shared/types'

export interface CommentRuntime {
  send(prompt: string): Promise<void>
  stop(): void
  respond(requestId: string, answer: unknown): Promise<void>
  dispose(): void | Promise<void>
}
export interface CommentRuntimeCallbacks { event(event: UAEvent): void; status(status: string): void }

/** Only the comment store owns durable discussion data; native turns stay isolated. */
class RuntimeStore extends SessionStore {
  override save(): void {}
  override saveOrThrow(): void {}
}

export function createCommentRuntime(
  config: SessionConfig, callbacks: CommentRuntimeCallbacks, root: string,
  getAgent: (id: string) => AgentDef | undefined, getPref?: (id: string) => AgentPref | undefined,
  assertReady?: (id: string) => void
): CommentRuntime {
  const owner = new Orchestrator(getAgent, new RuntimeStore(join(root, 'runtime.json')), join(root, 'artifacts'), join(root, 'logs'), undefined, assertReady, getPref)
  let sessionId: string | undefined
  owner.on('event', event => callbacks.event(event))
  owner.on('statusChange', change => callbacks.status(change.status))
  return {
    async send(prompt) {
      if (sessionId) await owner.sendMessage(sessionId, prompt, undefined, undefined, false, undefined, false)
      else sessionId = owner.createSession(config, prompt).id
    },
    stop() { if (sessionId) owner.interrupt(sessionId) },
    async respond(id, answer) { if (sessionId) await owner.respondToRequest(sessionId, id, answer) },
    async dispose() { owner.disposeAll(); owner.removeAllListeners(); await Promise.all([owner.closeZCodeRuntime(), owner.closeSessionLogs()]) }
  }
}
