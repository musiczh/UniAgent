import type { AppServerRpc } from './appServerTransport'

type HistoryClient = Pick<AppServerRpc, 'request'>
type Page<T> = { data: T[]; nextCursor?: string | null }

function paginationUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (error as Error & { code?: number }).code === -32601 ||
    /^thread\/(?:turns|items)\/list is not supported(?: yet)?$/i.test(error.message) ||
    /^(?:method not found|unknown method)(?:[.: ]|$)/i.test(error.message) ||
    /unknown variant [`'"]thread\/(?:turns|items)\/list[`'"]/i.test(error.message)
}

async function listPages<T>(
  client: HistoryClient,
  method: string,
  params: Record<string, unknown>
): Promise<T[]> {
  const items: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await client.request<Page<T>>(method, {
      ...params, limit: 100, ...(cursor ? { cursor } : {})
    })
    if (!Array.isArray(page?.data)) throw new Error(`${method} 未返回分页数据`)
    items.push(...page.data)
    cursor = page.nextCursor || undefined
    if (cursor && cursors.has(cursor)) throw new Error(`${method} 返回重复分页游标`)
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return items
}

export async function readThreadTurns<T>(client: HistoryClient, threadId: string): Promise<T[]> {
  try {
    return await listPages<T>(client, 'thread/turns/list', {
      threadId, sortDirection: 'asc', itemsView: 'full'
    })
  } catch (error) {
    if (!paginationUnsupported(error)) throw error
    // Older app-server builds expose only the full-history read API.
    const response = await client.request<{ thread: { turns: T[] } }>('thread/read', {
      threadId, includeTurns: true
    })
    return response.thread.turns
  }
}

export async function readThreadTurnItems<T>(
  client: HistoryClient,
  threadId: string,
  turnId: string
): Promise<T[]> {
  try {
    const entries = await listPages<{ turnId: string; item: T }>(client, 'thread/items/list', {
      threadId, turnId, sortDirection: 'asc'
    })
    return entries.filter((entry) => entry.turnId === turnId).map((entry) => entry.item)
  } catch (error) {
    if (!paginationUnsupported(error)) throw error
    const turns = await readThreadTurns<{ id: string; items: T[] }>(client, threadId)
    return turns.find((turn) => turn.id === turnId)?.items || []
  }
}
