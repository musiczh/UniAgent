import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UAEvent, SessionSummary } from '../shared/types.ts'
import { kimiWebTranscriptEvents } from './kimiWebEventProjection.ts'
import { acquireKimiWebService } from './kimiWebService.ts'
import { KimiWebError, type KimiWebTransport } from './kimiWebTransport.ts'
import { normalizeKimiWebTurns } from './kimiWebTranscriptState.ts'

export async function listKimiWebSessions(bin = 'kimi', cwd?: string, env: NodeJS.ProcessEnv = {}): Promise<SessionSummary[]> {
  const lease = await acquireKimiWebService({ bin, cwd: cwd || process.cwd(), env })
  try {
    const rows: SessionSummary[] = [], cursors = new Set<string>()
    let before: string | undefined
    for (;;) {
      const page = await lease.transport.request<any>('GET', `/api/v1/sessions?page_size=100${before ? '&before_id=' + encodeURIComponent(before) : ''}`)
      if (!Array.isArray(page.items) || typeof page.has_more !== 'boolean') throw new KimiWebError('session_list_invalid')
      for (const row of page.items) if (typeof row.id === 'string' && (!cwd || row.metadata?.cwd === cwd)) rows.push({ id: row.id, title: row.title || '(Kimi 会话)', cwd: row.metadata?.cwd, updatedAt: Date.parse(row.updated_at) || 0, agentId: 'kimi' })
      if (!page.has_more) return rows
      before = page.items.at(-1)?.id
      if (!before || cursors.has(before)) throw new KimiWebError('session_cursor_repeated')
      cursors.add(before)
    }
  } finally { await lease.release() }
}

export async function deleteKimiWebSession(id: string, bin = 'kimi', cwd?: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  if (!id || id.includes('\0')) throw new KimiWebError('session_id_invalid')
  const lease = await acquireKimiWebService({ bin, cwd: cwd || process.cwd(), env })
  try {
    const base = `/api/v1/sessions/${encodeURIComponent(id)}`
    const status = await lease.transport.request<any>('GET', base + '/status')
    if (status.busy) throw new KimiWebError('session_busy')
    const result = await lease.transport.request<any>('POST', base + ':delete', {})
    if (result.deleted !== true) throw new KimiWebError('delete_unconfirmed')
  } finally { await lease.release() }
}

/** Public REST supports a quiescent whole-session fork, never an arbitrary node. */
export async function forkKimiWebSession(id: string, bin = 'kimi', cwd?: string, env: NodeJS.ProcessEnv = {}): Promise<{ nativeId: string; cwd: string; kimiThinking?: string; dataHome: string }> {
  const lease = await acquireKimiWebService({ bin, cwd: cwd || process.cwd(), env })
  try {
    const base = `/api/v1/sessions/${encodeURIComponent(id)}`
    const status = await lease.transport.request<any>('GET', base + '/status')
    if (status.busy) throw new KimiWebError('fork_requires_idle')
    const session = await lease.transport.request<any>('POST', base + ':fork', {})
    if (typeof session.id !== 'string' || session.id === id || typeof session.metadata?.cwd !== 'string') throw new KimiWebError('fork_unconfirmed')
    return { nativeId: session.id, cwd: session.metadata.cwd, kimiThinking: session.agent_config?.thinking, dataHome: lease.home }
  } finally { await lease.release() }
}

/** The official transcript retains pre-compaction turns and message origins. */
export async function readKimiTranscript(transport: KimiWebTransport, sessionId: string, agentId: string, knownTurns?: ReadonlySet<string>): Promise<{ items: any[]; meta: any; agents?: any[] }> {
  const pages: any[][] = []
  const cursors = new Set<string>()
  let before: string | undefined
  let meta: any
  let agents: any[] | undefined
  let canStopAtKnownTurn = true
  for (;;) {
    if (transport.turnsProtocol) {
      const page = await transport.request<any>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/turns?page_size=100${before ? '&before_ordinal=' + encodeURIComponent(before) : ''}`)
      if (!Array.isArray(page?.turns) || typeof page.has_more !== 'boolean') throw new KimiWebError('transcript_invalid')
      pages.push(normalizeKimiWebTurns(page.turns))
      if (!page.has_more) break
      const oldest = page.turns[0]?.ordinal
      if (!Number.isSafeInteger(oldest) || oldest < 0 || cursors.has(String(oldest))) throw new KimiWebError('transcript_cursor_repeated')
      cursors.add(String(oldest)); before = String(oldest)
      continue
    }
    const page = await transport.request<any>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?agent_id=${encodeURIComponent(agentId)}&page_size=100${before ? '&before_turn=' + encodeURIComponent(before) : ''}`)
    if (page?.agent_id !== agentId || !Array.isArray(page.items) || typeof page.has_more !== 'boolean') throw new KimiWebError('transcript_invalid')
    if (!pages.length) { meta = page.meta; agents = page.agents }
    pages.push(page.items)
    if (page.items.some((item: any) => item.kind === 'marker' && item.marker === 'compaction')) canStopAtKnownTurn = false
    if (canStopAtKnownTurn && page.items.some((item: any) => item.kind === 'turn' &&
      item.state !== 'running' && item.state !== 'queued' && knownTurns?.has(String(item.turnId)))) break
    if (!page.has_more) break
    const oldest = page.items.find((item: any) => item.kind === 'turn')?.turnId
    if (typeof oldest !== 'string' || !oldest || cursors.has(oldest)) throw new KimiWebError('transcript_cursor_repeated')
    cursors.add(oldest)
    before = oldest
  }
  return { items: pages.reverse().flat(), meta, ...(agents ? { agents } : {}) }
}

/**
 * Read one owned native child transcript without loading the parent agent,
 * resending input or changing the session profile. The task registry proves
 * latest ownership; a persisted nativeTaskId covers a task that aged out of the
 * registry after a restart.
 */
export async function loadKimiSubAgentEvents(
  sessionId: string,
  agentId: string,
  bin = 'kimi',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {},
  trusted?: { nativeTaskId: string; parentNativeSessionId: string }
): Promise<UAEvent[]> {
  if (!sessionId || sessionId.includes('\0')) throw new KimiWebError('session_id_invalid')
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(agentId) || agentId === 'main') throw new KimiWebError('subagent_identity_invalid')
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, KIMI_CODE_WATCH: 'false', NO_COLOR: '1' }
  env.KIMI_CODE_HOME = resolve(env.KIMI_CODE_HOME || join(env.HOME || homedir(), '.kimi-code'))
  for (const key of Object.keys(env)) if (key.startsWith('UNIAGENT_')) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  const server = await acquireKimiWebService({ bin, cwd: cwd || process.cwd(), env })
  try {
    const transport = server.transport!
    const persisted = trusted?.parentNativeSessionId === sessionId && /^[A-Za-z0-9._-]{1,128}$/.test(trusted?.nativeTaskId || '')
    if (!transport.transcriptProtocol) {
      const tasks = await transport.request<any>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks`)
      if (!Array.isArray(tasks?.items)) throw new KimiWebError('task_list_invalid')
      const owned = tasks.items.some((task: any) => task?.session_id === sessionId && task.kind === 'subagent' && task.agent_id === agentId)
      if (!owned && !persisted) throw new KimiWebError('subagent_not_owned')
    }
    const transcript = await readKimiTranscript(transport, sessionId, agentId)
    if (transport.turnsProtocol) {
      const tasks = await transport.tasks(sessionId)
      if (!tasks.items.some(task => task.kind === 'subagent' && task.agent_id === agentId && task.parent_agent_id === 'main') && !persisted) throw new KimiWebError('subagent_not_owned')
    } else if (transport.transcriptProtocol) {
      const child = transcript.agents?.find(row => row.agentId === agentId)
      if (child?.type === 'independent' || child?.parentAgentId && child.parentAgentId !== 'main' ||
        !(child?.type === 'sub' && child.parentAgentId === 'main') && !persisted) throw new KimiWebError('subagent_not_owned')
    }
    const fallback = Date.now()
    return kimiWebTranscriptEvents(transcript.items)
      .map((event, seq) => ({ sessionId: '', seq, ...event, ts: event.ts ?? fallback }))
  } finally { await server.release() }
}

/** Read cold history without loading a writable agent or changing its profile. */
export async function loadKimiSessionEvents(
  id: string,
  bin = 'kimi',
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ events: UAEvent[]; cwd?: string; model?: string; effort?: string; kimiThinking?: string; contextWindow?: number }> {
  if (!id || id.includes(String.fromCharCode(0))) throw new Error('Kimi sessionId 无效')
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, KIMI_CODE_WATCH: 'false', NO_COLOR: '1' }
  env.KIMI_CODE_HOME = resolve(env.KIMI_CODE_HOME || join(env.HOME || homedir(), '.kimi-code'))
  for (const key of Object.keys(env)) if (key.startsWith('UNIAGENT_')) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  const server = await acquireKimiWebService({ bin, cwd: cwd || process.cwd(), env })
  try {
    const transport = server.transport!
    const session = await transport.request<any>('GET', `/api/v1/sessions/${encodeURIComponent(id)}`)
    if (session?.id !== id) throw new KimiWebError('session_identity_invalid')
    const transcript = await readKimiTranscript(transport, id, 'main')
    const status = transcript.meta?.agent
    const model = status?.model || session.agent_config?.model
    const fallbackTime = Date.parse(session.updated_at) || Date.now()
    const events = kimiWebTranscriptEvents(transcript.items).map((event, seq) => ({ sessionId: '', seq, ...event, ts: event.ts ?? fallbackTime }))
    return {
      events,
      cwd: typeof session.metadata?.cwd === 'string' ? session.metadata.cwd : cwd,
      model: typeof model === 'string' && model ? model : undefined,
      kimiThinking: typeof (status?.thinkingEffort || session.agent_config?.thinking) === 'string' ? status?.thinkingEffort || session.agent_config.thinking : undefined,
      contextWindow: typeof status?.maxContextTokens === 'number' && status.maxContextTokens > 0 ? status.maxContextTokens : undefined
    }
  } finally {
    await server.release()
  }
}
