import type { SessionConfig, SessionSummary, UAEvent } from '../shared/types.ts'
import { DeepSeekHostClient, DeepSeekHostError } from './deepseekHostClient.ts'
import { normalizeDeepSeekHistory } from './deepseekEventProjection.ts'

const managed = async () => (await import('./deepseekService.ts')).getDeepSeekHost()

/** These reads observe persistence; they never create an Agent or acquire its writer. */
export async function listDeepSeekHostSessions(client?: DeepSeekHostClient): Promise<SessionSummary[]> {
  client ||= await managed()
  const result = await client.call<any>('session/list', { _request: {} })
  if (!Array.isArray(result?.items)) throw new DeepSeekHostError('invalid-session-list')
  return result.items.filter((row: any) => !row.blank && row.origin !== 'subagent').map((row: any) => ({
    id: row.sessionId, agentId: 'deepseek', title: row.projections?.values?.title || '(DeepSeek 会话)',
    cwd: row.cwd, updatedAt: row.updatedAt
  }))
}
export async function loadDeepSeekHostHistory(id: string, client?: DeepSeekHostClient): Promise<{ events: UAEvent[]; cwd?: string; model?: string; effort?: SessionConfig['effort'] }> {
  client ||= await managed()
  const controller = new AbortController()
  const stream = client.stream<any>('session/follow', { request: { address: { kind: 'session', sessionId: id }, maxMessages: 100 } }, controller.signal)
  let snapshot: any
  try { snapshot = (await stream.next()).value } finally { controller.abort(); await stream.return(undefined) }
  if (snapshot?.type !== 'snapshot' || !Array.isArray(snapshot.records)) throw new DeepSeekHostError('invalid-history-snapshot')
  let records = snapshot.records, hasMore = snapshot.hasMore
  while (hasMore) {
    const beforeSeq = records.find((row: any) => row.type === 'event')?.event.seq
    if (!Number.isSafeInteger(beforeSeq)) throw new DeepSeekHostError('invalid-history-cursor')
    const page = await client.call<any>('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: snapshot.cursor, beforeSeq, maxMessages: 100 } })
    if (!Array.isArray(page?.records) || !page.records.some((row: any) => row.type === 'event' && row.event.seq < beforeSeq)) throw new DeepSeekHostError('history-pagination-stalled')
    records = [...page.records, ...records]; hasMore = page.hasMore
  }
  const events = records.filter((row: any) => row.type === 'event').map((row: any) => row.event)
  return normalizeDeepSeekHistory({ session: snapshot.header, events }) as Awaited<ReturnType<typeof loadDeepSeekHostHistory>>
}
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Read one recorded image block for the transcript. Observes persistence only:
 * never creates, resumes or steers the native session, so a thumbnail can load
 * for both live turns and restored history. */
export async function loadDeepSeekHostImage(
  id: string,
  selector: { eventSeq: number; blockIndex: number; toolResult?: boolean },
  client?: DeepSeekHostClient
): Promise<string | null> {
  if (!Number.isSafeInteger(selector.eventSeq) || selector.eventSeq < 0 ||
      !Number.isSafeInteger(selector.blockIndex) || selector.blockIndex < 0) return null
  client ||= await managed()
  const page = await client.call<any>('session/page', { request: {
    address: { kind: 'session', sessionId: id }, throughSeq: selector.eventSeq, beforeSeq: selector.eventSeq + 1, maxMessages: 1
  } })
  const event = page?.records?.find((row: any) => row.type === 'event' && row.event?.seq === selector.eventSeq)?.event
  if (event?.type !== (selector.toolResult === true ? 'tool/result' : 'assistant/message')) return null
  const block = event.data?.message?.content?.[selector.blockIndex]
  if (block?.type !== 'image' || typeof block.attachment?.attachmentId !== 'string') return null
  const image = await client.call<any>('session/attachment', { request: { sessionId: id, attachmentId: block.attachment.attachmentId } })
  if (!IMAGE_MEDIA_TYPES.has(image?.attachment?.mediaType) || typeof image.data !== 'string') return null
  return `data:${image.attachment.mediaType};base64,${image.data}`
}
export async function forkDeepSeekHostSession(id: string, atSeq?: number, client?: DeepSeekHostClient): Promise<{ nativeId: string; cwd?: string; model?: string; effort?: SessionConfig['effort'] }> {
  client ||= await managed()
  if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new DeepSeekHostError('invalid-fork-boundary')
  const result = await client.call<any>('session/fork', { request: { sessionId: id, ...(atSeq === undefined ? {} : { atSeq }) } })
  if (typeof result?.sessionId !== 'string' || result.sessionId === id) throw new DeepSeekHostError('invalid-fork-identity')
  const history = await loadDeepSeekHostHistory(result.sessionId, client)
  return { nativeId: result.sessionId, cwd: history.cwd, model: history.model, effort: history.effort }
}
