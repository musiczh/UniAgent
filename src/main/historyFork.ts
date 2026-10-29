import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { AgentDef, ClaudeForkOrigin, HistoryForkPoint, UAEvent } from '../shared/types'
import { AppServerRpcClient } from './appServerTransport'
import { readThreadTurns } from './appServerHistory'
import { loadSessionEvents } from './history'

const execFileP = promisify(execFile)
type ForkSupport = { afterTurn: boolean; message: boolean; deferGoal: boolean }
type NativeHistoryTurn = { id: string; status: string; items?: { type: string; text?: string; phase?: string }[] }
const unsupported: ForkSupport = { afterTurn: false, message: false, deferGoal: false }
const supportCache = new Map<string, Promise<ForkSupport>>()

/** Inspect the installed executable; whole-session fork support is insufficient. */
async function forkSupport(agent: AgentDef): Promise<ForkSupport> {
  if (!['codex', 'traex', 'claude'].includes(agent.adapter)) return unsupported
  const info = await stat(agent.bin)
  const key = `${agent.bin}:${info.mtimeMs}:${info.size}`
  let result = supportCache.get(key)
  if (!result) {
    result = inspectForkSupport(agent).catch(() => {
      supportCache.delete(key)
      return unsupported
    })
    supportCache.set(key, result)
  }
  return result
}

async function inspectForkSupport(agent: AgentDef): Promise<ForkSupport> {
  if (agent.adapter === 'claude') {
    const { stdout } = await execFileP(agent.bin, ['--help'], { timeout: 8000 })
    if (!stdout.includes('--fork-session')) return unsupported
    // resume-session-at is hidden from --help in some supported CLI versions.
    // Missing its required value exits in argument parsing without starting a session.
    try {
      await execFileP(agent.bin, ['--resume-session-at'], { timeout: 8000 })
    } catch (error: any) {
      if (/option ['"]--resume-session-at <[^>]+>['"] argument missing/.test(error.stderr || '')) {
        return { ...unsupported, message: true }
      }
    }
    return unsupported
  }
  return withHistoryClient(agent, async (client) => {
    // CLI wrappers may only forward RPC, not generate-json-schema. A known
    // field rejects an object with its expected type; ignored/unknown fields
    // cannot pass this check. The invalid UUID prevents creating a fork even
    // when a server ignores the field and proceeds to look up the session.
    const accepts = async (field: string, type: 'string' | 'boolean'): Promise<boolean> => {
      try {
        await client.request('thread/fork', { threadId: '__uniagent_fork_capability_probe__', [field]: {} })
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === `Invalid request: invalid type: map, expected a ${type}`) return true
          if (/invalid (?:session|thread) id:|unknown field/i.test(error.message)) return false
        }
        throw error
      }
      return false
    }
    return {
      afterTurn: await accepts('lastTurnId', 'string'),
      message: false,
      deferGoal: await accepts('deferGoalContinuation', 'boolean')
    }
  })
}

async function withHistoryClient<T>(agent: AgentDef, action: (client: AppServerRpcClient) => Promise<T>): Promise<T> {
  const client = new AppServerRpcClient({ bin: agent.bin, args: ['app-server'], cwd: homedir(), timeoutMs: 15000 })
  try {
    await client.start()
    await client.request('initialize', {
      clientInfo: { name: 'uniagent', version: '1.0.0' }, capabilities: { experimentalApi: true }
    })
    client.notify('initialized', {})
    return await action(client)
  } finally {
    await client.dispose()
  }
}

/** Only offer positions that map to a native boundary in this exact transcript. */
export async function historyForkPoints(agent: AgentDef | undefined, nativeId: string, events: UAEvent[]): Promise<HistoryForkPoint[]> {
  if (!agent || !events.length) return []
  if (agent.adapter === 'zcode') {
    const completed = new Set(events.filter(event => event.type === 'turn_completed' && event.state === 'success').map(event => event.payload.turnId))
    const replies = new Map<string, UAEvent>()
    for (const event of events) if (event.type === 'agent_message' && event.state === 'success' && completed.has(event.payload.turnId)
      && Number.isSafeInteger(event.payload.rowId) && typeof event.payload.entityId === 'string') replies.set(event.payload.turnId, event)
    return [...replies.values()].map(event => ({ eventSeq: event.seq, kind: 'message' as const,
      nativeId: JSON.stringify({ rowId: event.payload.rowId, entityId: event.payload.entityId }) }))
  }
  if (agent.adapter === 'deepseek') return events.filter(event => event.type === 'agent_message' && Number.isSafeInteger(event.payload.nativeEventSeq)).map(event => ({ eventSeq: event.seq, kind: 'message', nativeId: String(event.payload.nativeEventSeq) }))
  try {
    const support = await forkSupport(agent)
    if (support.message) {
      return events.flatMap((event) =>
        typeof event.payload.nativeMessageId === 'string' &&
        event.type === 'agent_message'
          ? [{ eventSeq: event.seq, kind: 'message' as const, nativeId: event.payload.nativeMessageId }]
          : []
      )
    }
    if (!support.afterTurn) return []
    const turns = await withHistoryClient(agent, (client) =>
      readThreadTurns<NativeHistoryTurn>(client, nativeId)
    )
    const nativeTurns = new Map(turns.map((turn) => [turn.id, turn]))
    const replies = new Map<string, UAEvent>()
    let currentId: string | undefined
    for (const event of events) {
      if (event.type === 'user_message' || event.type === 'goal_message') {
        currentId = undefined
      } else if (event.type === 'turn_started' && nativeTurns.has(event.payload.turnId)) {
        currentId = event.payload.turnId as string
      } else if (event.type === 'agent_message' && currentId) {
        replies.set(currentId, event)
      }
    }
    return [...replies].flatMap(([id, reply]) => {
      const points: HistoryForkPoint[] = []
      const nativeTurn = nativeTurns.get(id)
      const nativeReply = nativeTurn?.items?.findLast((item) => item.type === 'agentMessage')
      // A bounded preview may end mid-turn even when the native turn is complete.
      if (
        nativeTurn?.status === 'completed' &&
        nativeReply?.text === reply.payload.text &&
        (nativeReply?.phase === 'final_answer' || nativeReply === nativeTurn.items?.at(-1))
      ) {
        points.push({ eventSeq: reply.seq, kind: 'after-turn', nativeId: id })
      }
      return points
    })
  } catch {
    // Preview remains usable when the executable/protocol cannot prove support.
    return []
  }
}

export async function loadClaudeForkHistory(origin: ClaudeForkOrigin) {
  const history = await loadSessionEvents('claude', origin.sessionId)
  const end = history.events.findIndex((event) => event.payload.nativeMessageId === origin.messageId)
  if (end < 0) throw new Error('来源会话的分叉位置已不可用，请重新预览后选择')
  return { ...history, events: history.events.slice(0, end + 1) }
}

export function historyEventsThroughPoint(events: UAEvent[], point: HistoryForkPoint): UAEvent[] {
  const start = events.findLastIndex((event) => point.kind === 'message'
    ? event.type === 'agent_message' && event.payload.nativeMessageId === point.nativeId
    : event.type === 'turn_started' && event.payload.turnId === point.nativeId)
  if (start < 0) throw new Error('来源会话的分叉位置已不可用，请重新预览后选择')
  const end = point.kind === 'message' ? start + 1 : events.findIndex((event, index) =>
    index > start && ['user_message', 'goal_message', 'turn_started'].includes(event.type))
  return events.slice(0, end < 0 ? events.length : end)
}

export async function loadHistoryAtPoint(agent: AgentDef, nativeId: string, point: HistoryForkPoint) {
  if (!point || !['message', 'after-turn'].includes(point.kind) ||
      typeof point.nativeId !== 'string' || !point.nativeId.trim()) {
    throw new Error('分叉位置无效，请重新选择')
  }
  const history = await loadSessionEvents(agent.id, nativeId, agent.bin)
  const points = await historyForkPoints(agent, nativeId, history.events)
  // Renderer event sequences may differ from disk replay; native ids are stable.
  if (!points.some((entry) => entry.kind === point.kind && entry.nativeId === point.nativeId)) {
    throw new Error('当前 Agent 或所选位置不支持原生分叉，请刷新会话预览')
  }
  return { ...history, events: historyEventsThroughPoint(history.events, point) }
}

export async function forkHistoryAt(agent: AgentDef, nativeId: string, point: HistoryForkPoint) {
  const history = await loadHistoryAtPoint(agent, nativeId, point)
  if (point.kind === 'message') {
    const origin: ClaudeForkOrigin = { sessionId: nativeId, messageId: point.nativeId }
    return { ...history, pendingClaudeFork: origin, nativeId: undefined }
  }
  const support = await forkSupport(agent)
  const response = await withHistoryClient(agent, (client) =>
    client.request<{ thread: { id: string; cwd?: string } }>('thread/fork', {
      threadId: nativeId,
      ephemeral: false,
      excludeTurns: true,
      lastTurnId: point.nativeId,
      ...(support.deferGoal ? { deferGoalContinuation: true } : {})
    })
  )
  const forkedId = response.thread?.id
  if (!forkedId || forkedId === nativeId) throw new Error('原生分叉未返回独立会话，已停止导入')
  return { ...history, nativeId: forkedId, pendingClaudeFork: undefined }
}
