import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import { diagnostics, DiagnosticsStore } from '../src/main/diagnostics.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, SessionConfig } from '../src/shared/types.ts'

const agent: AgentDef = {
  id: 'traex', name: 'TraeX', bin: 'trae', adapter: 'traex', icon: '', builtin: true,
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
  models: [], installed: true
}
const config: SessionConfig = { agentId: agent.id, workdir: '/repo', permissionMode: 'ask' }
const root = mkdtempSync(join(tmpdir(), 'uniagent-ignored-events-'))
const diagnosticStore = new DiagnosticsStore(join(root, 'diagnostics.jsonl'))
const originalRecord = diagnostics.record
diagnostics.record = diagnosticStore.record.bind(diagnosticStore)
const orchestrator = new Orchestrator(
  (id) => id === agent.id ? agent : undefined,
  new SessionStore(join(root, 'sessions.json')),
  join(root, 'artifacts'),
  join(root, 'session-logs')
)
;(orchestrator as any).sessions.set('session-1', {
  id: 'session-1', title: 'test', status: 'idle', createdAt: 1, config
})
const runner = new AppServerRunner('session-1', { n: 0 }, agent, config)
;(runner as any).threadId = 'thread-1'
;(orchestrator as any).bindAppServerDiagnostics(runner, 'session-1')
const events: unknown[] = []
const rateLimits: unknown[] = []
runner.on('event', (event) => events.push(event))
runner.on('rateLimits', (snapshot) => rateLimits.push(snapshot))

try {
  ;(runner as any).onNotification('future/stream/delta', {
    threadId: 'thread-1', turnId: 'turn-1', value: 'new protocol data'
  })
  ;(runner as any).onNotification('future/stream/delta', {
    threadId: 'thread-1', turnId: 'turn-1', value: 'newer protocol data'
  })
  ;(runner as any).onNotification('item/started', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'future-item', type: 'futureItem', value: 1 }
  })
  ;(runner as any).onNotification('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'future-item', type: 'futureItem', value: 2 }
  })
  ;(runner as any).onNotification('turn/plan/updated', {
    threadId: 'thread-1', turnId: 'turn-1', plan: []
  })
  ;(runner as any).onNotification('turn/completed', {
    threadId: 'thread-1', turn: { status: 'completed' }
  })
  ;(runner as any).onNotification('item/started', {
    threadId: 'thread-1', item: { id: 'known-file', type: 'fileChange' }
  })
  ;(runner as any).onNotification('item/completed', {
    threadId: 'thread-1', item: { id: 'known-user', type: 'userMessage' }
  })
  ;(runner as any).onNotification('thread/goal/cleared', { threadId: 'other-thread' })
  ;(runner as any).onNotification('thread/status/changed', {
    threadId: 'thread-1', status: { type: 'active', activeFlags: [] }
  })
  ;(runner as any).onNotification('thread/closed', { threadId: 'thread-1' })
  ;(runner as any).onNotification('item/reasoning/summaryPartAdded', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0
  })
  ;(runner as any).onNotification('remoteControl/status/changed', {
    status: 'disabled', installationId: 'installation-1', environmentId: null
  })
  ;(runner as any).onNotification('account/rateLimits/updated', {
    rateLimits: {
      primary: { usedPercent: 22, windowDurationMins: 10_080, resetsAt: 1_789_441_437 },
      secondary: null, planType: 'prolite'
    }
  })
  // 额度耗尽后的全 null 空快照：预期形态，既不更新额度卡片也不产生诊断。
  ;(runner as any).onNotification('account/rateLimits/updated', {
    rateLimits: {
      limitId: 'codex', limitName: null, normalModelSlug: null,
      primary: null, secondary: null, credits: null, planType: null
    }
  })
  // TraeX worktree 会话广播：信息类事件，消费即可。
  ;(runner as any).onNotification('thread/worktreeSession/entered', {
    threadId: 'thread-1',
    worktree: { name: 'review-card', branch: 'worktree-review-card', path: '/repo/.trae/worktrees/review-card' },
    originalCwd: '/repo'
  })
  ;(runner as any).onNotification('thread/worktreeSession/updated', {
    threadId: 'thread-1',
    worktree: { name: 'review-card', branch: 'worktree-review-card', path: '/repo/.trae/worktrees/review-card' },
    originalCwd: '/repo'
  })
  ;(runner as any).onNotification('account/updated', { authMode: 'chatgpt', planType: 'plus' })
  ;(runner as any).onNotification('item/commandExecution/terminalInteraction', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1',
    toolCallId: 'tool-1', processId: '73367', stdin: 'secret input',
    command: 'git commit', durationMs: 0
  })
  for (const phase of ['started', 'completed']) {
    ;(runner as any).onNotification(`item/${phase}`, {
      threadId: 'thread-1', turnId: 'turn-1',
      item: {
        type: 'collabAgentToolCall', id: `empty-wait-${phase}`, tool: 'wait',
        status: phase === 'started' ? 'inProgress' : 'completed',
        receiverThreadIds: [], agentsStates: {}
      }
    })
  }
  const taskItem = {
    type: 'taskNotification', id: 'task-message-1',
    content: [{
      type: 'text',
      text: '<task-notification>\n<task-id>6201</task-id>\n<status>completed</status>\n<summary>Shell task completed with exit code 0</summary>\n<output-file>/tmp/task_output-6201.txt</output-file>\n</task-notification>'
    }]
  }
  ;(runner as any).onNotification('item/started', {
    threadId: 'thread-1', turnId: 'turn-1', item: taskItem
  })
  ;(runner as any).onNotification('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1', item: taskItem
  })
  ;(runner as any).onNotification('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: {
      id: 'command-1', type: 'commandExecution', status: 'completed',
      command: 'printf ok', aggregatedOutput: 'ok', exitCode: 0, durationMs: 321
    }
  })
  const hookRun = {
    id: 'user-prompt-submit:13:/repo/.trae/traecli.toml',
    eventName: 'userPromptSubmit',
    handlerType: 'command',
    executionMode: 'sync',
    scope: 'turn',
    sourcePath: '/repo/.trae/traecli.toml',
    source: 'user',
    displayOrder: 13,
    status: 'running',
    statusMessage: null,
    startedAt: 1_788_284_339,
    completedAt: null,
    durationMs: null,
    entries: []
  }
  ;(runner as any).onNotification('hook/started', {
    threadId: 'thread-1', turnId: 'turn-1', run: hookRun
  })
  ;(runner as any).onNotification('hook/completed', {
    threadId: 'thread-1', turnId: 'turn-1',
    run: {
      ...hookRun, status: 'completed', completedAt: 1_788_284_340, durationMs: 96,
      entries: [{ kind: 'warning', text: 'hook output' }]
    }
  })
  ;(runner as any).activeTurnToken = 'turn-attempt-test'
  ;(runner as any).curTurnId = 'turn-1'
  ;(runner as any).onNotification('error', {
    threadId: 'thread-1', turnId: 'turn-1', willRetry: true,
    error: { message: 'Reconnecting… 1/5' }
  }, undefined, 1_788_284_339)
  ;(runner as any).onNotification('error', {
    threadId: 'thread-1', turnId: 'turn-1', willRetry: false,
    error: { message: 'stream disconnected before completion: invalid param' }
  })
  ;(runner as any).onNotification('turn/completed', {
    threadId: 'thread-1',
    turn: {
      id: 'turn-1', status: 'failed',
      error: { message: 'stream disconnected before completion: invalid param' }
    }
  })
  runner.emit('diagnostic', {
    kind: 'title_generation_failed',
    data: { stage: 'thread/start', message: 'invalid transport in `mcp_servers.uniagent`' }
  })

  assert.deepEqual(
    (events as any[]).map(({ type, state, payload }) => ({ type, state, payload })),
    [
      {
        type: 'background_task', state: 'success',
        payload: {
          id: 'task-message-1', turnId: 'turn-1', taskId: '6201', status: 'completed',
          summary: 'Shell task completed with exit code 0',
          outputFile: '/tmp/task_output-6201.txt'
        }
      },
      {
        type: 'background_task', state: 'success',
        payload: {
          id: 'task-message-1', turnId: 'turn-1', taskId: '6201', status: 'completed',
          summary: 'Shell task completed with exit code 0',
          outputFile: '/tmp/task_output-6201.txt'
        }
      },
      {
        type: 'command_exec', state: 'success',
        payload: {
          id: 'command-1', command: 'printf ok', output: 'ok', exitCode: 0, durationMs: 321
        }
      },
      {
        type: 'hook', state: 'running',
        payload: { ...hookRun, id: hookRun.id, threadId: 'thread-1', turnId: 'turn-1' }
      },
      {
        type: 'hook', state: 'success',
        payload: {
          ...hookRun, id: hookRun.id, status: 'completed',
          completedAt: 1_788_284_340, durationMs: 96,
          entries: [{ kind: 'warning', text: 'hook output' }],
          threadId: 'thread-1', turnId: 'turn-1'
        }
      },
      {
        type: 'system_notice', state: 'running',
        payload: {
          kind: 'reconnect',
          id: 'reconnect-turn-1-1788284339',
          turnId: 'turn-1', text: 'Reconnect…'
        }
      },
      {
        type: 'error', state: 'failed',
        payload: {
          message: 'stream disconnected before completion: invalid param',
          providerError: { message: 'stream disconnected before completion: invalid param' },
          threadId: 'thread-1', turnId: 'turn-1'
        }
      },
      {
        type: 'turn_completed', state: 'failed',
        payload: { turnId: 'turn-1' }
      }
    ],
    'hooks enter the call chain, retries become inline status state, and failed completion does not duplicate its error'
  )
  assert.equal(rateLimits.length, 1)
  const rateLimitSnapshot = rateLimits[0] as any
  assert.deepEqual({ ...rateLimitSnapshot, capturedAt: 0 }, {
    primary: { usedPercent: 22, windowMinutes: 10_080, resetsAt: 1_789_441_437 },
    secondary: null, planType: 'prolite', capturedAt: 0
  }, 'account rate-limit notifications must become a live normalized snapshot')
  assert.ok(Number.isFinite(rateLimitSnapshot.capturedAt))

  assert.deepEqual(
    diagnosticStore.list().map(({ code, field, count }) => ({ code, field, count })),
    [
      { code: 'title_generation_failed', field: 'thread/start', count: 1 },
      { code: 'ignored_provider_event', field: 'notification:turn/completed:missing_turn_id', count: 1 },
      { code: 'ignored_provider_event', field: 'notification:turn/plan/updated:missing_plan_steps', count: 1 },
      { code: 'ignored_provider_event', field: 'item:futureItem:completed', count: 1 },
      { code: 'ignored_provider_event', field: 'item:futureItem:started', count: 1 },
      { code: 'ignored_provider_event', field: 'notification:future/stream/delta:unsupported_method', count: 1 }
    ]
  )
  assert.ok(diagnosticStore.list().every(({ category, source, agentId, sessionId }) =>
    category === 'app_runtime' && source === 'traex-app-server' &&
    agentId === 'traex' && sessionId === 'session-1'
  ))
  const report = diagnosticStore.formatReport()
  assert.match(report, /自动生成会话标题失败/)
  assert.match(report, /invalid transport in `mcp_servers\.uniagent`/)
  assert.match(report, /TraeX app-server 忽略了 notification "future\/stream\/delta"/)
  assert.match(report, /new protocol data/)

  const sessionLog = readFileSync(join(root, 'session-logs', 'session-1.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
  const ignored = sessionLog.filter(({ kind }) => kind === 'ignored_provider_event')
  assert.equal(ignored.length, 5)
  assert.equal(ignored[0].data.channel, 'main')
  assert.equal(ignored[0].data.data.method, 'future/stream/delta')
  const titleFailures = sessionLog.filter(({ kind }) => kind === 'title_generation_failed')
  assert.equal(titleFailures.length, 1)
  assert.deepEqual(titleFailures[0].data, {
    channel: 'main',
    data: { stage: 'thread/start', message: 'invalid transport in `mcp_servers.uniagent`' }
  })

  const beforeDiagnostics = diagnosticStore.list().length
  const beforeEvents = events.length
  const closed = {
    type: 'collabAgentToolCall', id: 'close-child', tool: 'closeAgent',
    receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'completed', message: 'Done' } }
  }
  ;(runner as any).onSubAgentItem(closed, 'completed')
  ;(runner as any).onSubAgentItem(closed, 'completed')
  assert.equal(events.length, beforeEvents + 1, 'terminal child events remain deduplicated')
  assert.equal(diagnosticStore.list().length, beforeDiagnostics, 'deduplication is not missing provider state')
  ;(runner as any).onSubAgentItem({ ...closed, receiverThreadIds: [], agentsStates: {} }, 'completed')
  assert.equal(diagnosticStore.list().length, beforeDiagnostics + 1, 'truly missing recipients still report a diagnostic')
} finally {
  diagnostics.record = originalRecord
  runner.dispose()
  orchestrator.disposeAll()
  rmSync(root, { recursive: true, force: true })
}

console.log('appserver ignored events: ok')
