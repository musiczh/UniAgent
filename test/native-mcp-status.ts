import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import { NativeCapabilityService, normalizeClaudeNativeSnapshot } from '../src/main/nativeCapabilityService.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, Session, SessionConfig, UAEvent } from '../src/shared/types.ts'

const agent: AgentDef = {
  id: 'codex', name: 'Codex', bin: 'codex', adapter: 'codex', icon: '', builtin: true,
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
  models: [], installed: true, version: '0.148.0'
}
const config: SessionConfig = { agentId: agent.id, workdir: '/repo', permissionMode: 'ask' }

function runnerNotificationContract(): void {
  const runner = new AppServerRunner('session', { n: 0 }, agent, config)
  ;(runner as any).threadId = 'parent-thread'
  const events: UAEvent[] = []
  const statuses: unknown[] = []
  runner.on('event', (event) => events.push(event))
  runner.on('mcpStatusChanged', (status) => statuses.push(status))

  ;(runner as any).onNotification('item/started', {
    threadId: 'parent-thread',
    item: {
      type: 'mcpToolCall', id: 'mcp-1', server: 'figma', tool: 'get_file',
      status: 'inProgress', arguments: { file: 'abc' }, result: null, error: null, durationMs: null
    }
  })
  ;(runner as any).onNotification('item/completed', {
    threadId: 'parent-thread',
    item: {
      type: 'mcpToolCall', id: 'mcp-1', server: 'figma', tool: 'get_file',
      status: 'completed', arguments: { file: 'abc' }, result: { content: 'ok' }, error: null, durationMs: 17
    }
  })
  ;(runner as any).onNotification('item/completed', {
    threadId: 'parent-thread',
    item: {
      type: 'mcpToolCall', id: 'mcp-2', server: 'figma', tool: 'write_file',
      status: 'failed', arguments: { file: 'abc' }, result: null,
      error: { message: 'denied' }, durationMs: 4
    }
  })
  ;(runner as any).onNotification('item/completed', {
    threadId: 'parent-thread',
    item: { type: 'dynamicToolCall', id: 'dynamic-1', name: 'custom', status: 'completed', arguments: { value: 1 } }
  })

  const toolEvents = events.filter(({ type }) => type === 'tool_call')
  assert.deepEqual(toolEvents.map(({ state, payload }) => ({ state, payload })), [
    {
      state: 'running',
      payload: {
        id: 'mcp-1', provider: 'mcp', server: 'figma', name: 'get_file', input: { file: 'abc' },
        result: null, error: null, durationMs: null
      }
    },
    {
      state: 'success',
      payload: {
        id: 'mcp-1', provider: 'mcp', server: 'figma', name: 'get_file', input: { file: 'abc' },
        result: { content: 'ok' }, error: null, durationMs: 17
      }
    },
    {
      state: 'failed',
      payload: {
        id: 'mcp-2', provider: 'mcp', server: 'figma', name: 'write_file', input: { file: 'abc' },
        result: null, error: { message: 'denied' }, durationMs: 4
      }
    },
    {
      state: 'success',
      payload: { id: 'dynamic-1', name: 'custom', input: { value: 1 }, raw: {
        type: 'dynamicToolCall', id: 'dynamic-1', name: 'custom', status: 'completed', arguments: { value: 1 }
      } }
    }
  ])

  const startup = (threadId: string | null | undefined, name: unknown, status: unknown, extra: Record<string, unknown> = {}): void => {
    ;(runner as any).onNotification('mcpServer/startupStatus/updated', {
      ...(threadId === undefined ? {} : { threadId }), name, status, error: null, failureReason: null, ...extra
    })
  }
  startup(null, 'global', 'starting')
  startup(undefined, 'legacy-global', 'ready')
  startup('parent-thread', 'auth', 'failed', { error: 'sign in again', failureReason: 'reauthenticationRequired' })
  startup('child-thread', 'child', 'failed', { error: 'must not leak' })
  startup('unknown-thread', 'unknown', 'failed', { error: 'must not leak' })
  startup('parent-thread', '', 'ready')
  startup('parent-thread', 'invalid', 'connected')
  assert.deepEqual(statuses, [
    { name: 'global', status: 'starting', statusMessage: undefined },
    { name: 'legacy-global', status: 'ready', statusMessage: undefined },
    { name: 'auth', status: 'auth-required', statusMessage: 'sign in again' }
  ])
  runner.dispose()
}

function orchestratorOwnerGateContract(): void {
  const root = mkdtempSync(join(tmpdir(), 'uniagent-mcp-owner-'))
  const store = new SessionStore(join(root, 'sessions.json'))
  const orchestrator = new Orchestrator((id) => id === agent.id ? agent : undefined, store, join(root, 'artifacts'))
  const session: Session = { id: 'session', title: 'Session', config, status: 'idle', createdAt: 1 }
  const streamer = Object.assign(new EventEmitter(), { dispose: () => undefined })
  const forwarded: unknown[] = []
  orchestrator.on('nativeMcpStatusChanged', (change) => forwarded.push(change))
  ;(orchestrator as any).sessions.set(session.id, session)
  ;(orchestrator as any).streamers.set(session.id, streamer)
  ;(orchestrator as any).bindNativeCapabilityInvalidation(streamer, session)
  streamer.emit('mcpStatusChanged', { name: 'figma', status: 'failed', statusMessage: 'offline' })
  ;(orchestrator as any).streamers.set(
    session.id,
    Object.assign(new EventEmitter(), { dispose: () => undefined })
  )
  streamer.emit('mcpStatusChanged', { name: 'stale-streamer', status: 'ready' })
  ;(orchestrator as any).streamers.set(session.id, streamer)
  ;(orchestrator as any).sessions.set(session.id, { ...session })
  streamer.emit('mcpStatusChanged', { name: 'stale-session', status: 'ready' })
  assert.deepEqual(forwarded, [{
    agentId: 'codex', workdir: '/repo', name: 'figma', status: 'failed', statusMessage: 'offline'
  }])
  orchestrator.disposeAll()
  rmSync(root, { recursive: true, force: true })
}

async function serviceOverlayContract(): Promise<void> {
  let requests = 0
  let offline = false
  const service = new NativeCapabilityService(() => ({
    start: async () => undefined,
    notify: () => undefined,
    request: async (method: string) => {
      if (method === 'initialize') {
        if (offline) throw new Error('offline')
        return {}
      }
      if (method === 'skills/list') { requests++; return { data: [{ cwd: '/repo', skills: [] }] } }
      if (method === 'mcpServerStatus/list') return { data: [
        { name: 'figma', authStatus: 'oAuth', tools: {} },
        { name: 'auth', authStatus: 'notLoggedIn', startupStatus: 'ready', statusMessage: 'login required', tools: {} }
      ], nextCursor: null }
      if (method === 'collaborationMode/list') return { data: [] }
      throw new Error(method)
    },
    dispose: async () => undefined
  }) as never)

  const first = await service.discover(agent, '/repo')
  assert.equal((first.candidates.find(({ id }) => id === 'mcp:figma') as any).startupStatus, 'starting')
  service.applyMcpStatus('codex', '/repo', 'figma', 'failed', 'connection refused')
  const failed = await service.discover(agent, '/repo')
  assert.equal(requests, 1, 'a live status update patches the matching cache without launching a probe')
  assert.deepEqual(failed.candidates.filter(({ kind }) => kind === 'mcp').map((candidate: any) => ({
    name: candidate.name, status: candidate.startupStatus, message: candidate.statusMessage
  })), [
    { name: 'figma', status: 'failed', message: 'connection refused' },
    { name: 'auth', status: 'auth-required', message: 'login required' }
  ])

  service.applyMcpStatus('codex', '/repo', 'auth', 'ready', 'provider says ready')
  const auth = await service.discover(agent, '/repo')
  assert.equal((auth.candidates.find(({ id }) => id === 'mcp:auth') as any).startupStatus, 'auth-required')
  assert.equal((auth.candidates.find(({ id }) => id === 'mcp:figma') as any).startupStatus, 'failed',
    'a later list response without startup data cannot reset the live overlay')

  offline = true
  service.applyMcpStatus('codex', '/repo', 'missing', 'ready')
  const empty = await service.discover(agent, '/repo', true)
  assert.equal(empty.candidates.length, 0, 'an overlay cannot invent a server when provider discovery fails')
  assert.deepEqual(empty.errors, ['offline'])
}

function mainForwardingSourceContract(): void {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /orchestrator\.on\('nativeMcpStatusChanged'/)
  assert.match(source, /nativeCapabilityService\.applyMcpStatus/)
  assert.match(source, /webContents\.send\(IPC\.nativeCapabilitiesChanged/)
}

function claudeNativeStatusContract(): void {
  const snapshot = normalizeClaudeNativeSnapshot('claude', '/repo', {}, { mcpServers: [
    { name: 'docs', status: 'connected', tools: [{ name: 'mcp__docs__read' }, { name: 'mcp__docs__write' }] },
    { name: 'login', status: 'needs-auth', error: 'OAuth required' },
    { name: 'offline', status: 'failed', error: 'Connection refused' },
    { name: 'disabled', status: 'disabled' },
    { name: 'pending', status: 'pending' }
  ] })
  assert.deepEqual(snapshot.candidates.map((candidate: any) => ({
    name: candidate.name, startup: candidate.startupStatus, auth: candidate.authStatus,
    tools: candidate.toolNames, message: candidate.statusMessage
  })), [
    { name: 'docs', startup: 'ready', auth: 'unknown', tools: ['mcp__docs__read', 'mcp__docs__write'], message: undefined },
    { name: 'login', startup: 'auth-required', auth: 'notLoggedIn', tools: [], message: 'OAuth required' },
    { name: 'offline', startup: 'failed', auth: 'unknown', tools: [], message: 'Connection refused' },
    { name: 'disabled', startup: 'cancelled', auth: 'unknown', tools: [], message: undefined },
    { name: 'pending', startup: 'starting', auth: 'unknown', tools: [], message: undefined }
  ])
}

runnerNotificationContract()
orchestratorOwnerGateContract()
await serviceOverlayContract()
mainForwardingSourceContract()
claudeNativeStatusContract()

console.log('native MCP status: 5/5 checks passed')
