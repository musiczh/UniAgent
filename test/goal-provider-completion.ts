import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { AppServerRpc } from '../src/main/appServerTransport.ts'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import type { AgentDef, SessionConfig, UAEvent } from '../src/shared/types.ts'

class GoalTransport extends EventEmitter implements AppServerRpc {
  private sequence = 0
  readonly calls: Array<{ method: string; params: any }> = []

  async start(): Promise<void> {}
  notify(): void {}
  respond(): void {}
  interrupt(): void {}
  async dispose(): Promise<void> {}

  async request<T>(method: string, params: any): Promise<T> {
    return (await this.requestSequenced<T>(method, params)).result
  }

  async requestSequenced<T>(method: string, params: any): Promise<{ result: T; sequence: number }> {
    this.calls.push({ method, params })
    const sequence = ++this.sequence
    if (method === 'initialize') return { result: {} as T, sequence }
    if (method === 'config/read') return { result: { config: {} } as T, sequence }
    if (method === 'thread/start') {
      return { result: { thread: { id: 'thread-1', model: 'provider-model' } } as T, sequence }
    }
    if (method === 'thread/goal/get') return { result: { goal: null } as T, sequence }
    if (method === 'thread/goal/set') return { result: { goal: params } as T, sequence }
    if (method === 'turn/start') return { result: { turn: { id: 'turn-1' } } as T, sequence }
    if (method === 'turn/steer') return { result: {} as T, sequence }
    throw new Error(`unexpected method: ${method}`)
  }
}

const makeRunner = (adapter: 'codex' | 'traex'): {
  runner: AppServerRunner
  transport: GoalTransport
  events: UAEvent[]
  done: unknown[]
} => {
  const agent: AgentDef = {
    id: `${adapter}-goal`,
    name: adapter,
    adapter,
    bin: '/usr/bin/true',
    icon: '',
    builtin: true,
    installed: true,
    capabilities: {
      modelSelect: true,
      reasoningEffort: true,
      streaming: true,
      permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
    },
    models: []
  }
  const config: SessionConfig = {
    agentId: agent.id,
    workdir: '/repo',
    permissionMode: 'read-only',
    collaborationMode: 'default'
  }
  const transport = new GoalTransport()
  const runner = new AppServerRunner(
    `${adapter}-goal-session`,
    { n: 0 },
    agent,
    config,
    undefined,
    undefined,
    () => transport
  )
  const events: UAEvent[] = []
  const done: unknown[] = []
  runner.on('event', (event) => events.push(event))
  runner.on('done', (payload) => done.push(payload))
  return { runner, transport, events, done }
}

const waitForFallback = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
}

async function codexWaitsForProviderCompletion(): Promise<void> {
  const { runner, transport, events, done } = makeRunner('codex')
  try {
    await runner.startTurn('Codex Goal')
    runner.completeGoalTurn(2_000)
    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'answer-1',
        type: 'agentMessage',
        text: 'Codex 最终回复',
        phase: 'final_answer'
      }
    })
    transport.emit('notification', 'thread/tokenUsage/updated', {
      threadId: 'thread-1',
      tokenUsage: {
        last: { inputTokens: 8, outputTokens: 2 },
        total: { inputTokens: 8, outputTokens: 2 }
      }
    })
    await waitForFallback()
    assert.equal(done.length, 0, 'Codex must ignore TraeX completion fallbacks')

    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', durationMs: 2_500 }
    })
    assert.equal(done.length, 1)
    assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1)
  } finally {
    runner.dispose()
  }
}

async function traeFallsBackAfterGoalReplyAndUsage(): Promise<void> {
  const { runner, transport, events, done } = makeRunner('traex')
  try {
    await runner.startTurn('TraeX Goal')
    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'answer-1', type: 'agentMessage', text: 'TraeX 最终回复' }
    })
    transport.emit('notification', 'thread/tokenUsage/updated', {
      threadId: 'thread-1',
      tokenUsage: {
        last: { inputTokens: 21, outputTokens: 3 },
        total: { inputTokens: 21, outputTokens: 3 }
      }
    })
    await waitForFallback()
    assert.equal(done.length, 0, 'a non-Goal TraeX reply must stay active')

    runner.completeGoalTurn(1_900)
    runner.completeGoalTurn(2_000)
    await waitForFallback()

    assert.equal(done.length, 1, 'TraeX Goal must settle without turn/completed')
    assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1)
    const usage = events.find(
      (event) => event.type === 'system_notice' && event.payload?.kind === 'usage'
    )
    assert.equal(usage?.payload.durationMs, 2_000)
    assert.equal(usage?.payload.usage?.inputTokens, 21)
    assert.equal(usage?.payload.usage?.outputTokens, 3)

    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', durationMs: 2_500 }
    })
    assert.equal(done.length, 1, 'a late provider completion must be idempotent')
    assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1)
  } finally {
    runner.dispose()
  }
}

async function traeFallsBackAfterExplicitFinalAnswer(): Promise<void> {
  const { runner, transport, events, done } = makeRunner('traex')
  try {
    await runner.startTurn('普通消息')
    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1',
      item: {
        id: 'uncorrelated-answer',
        type: 'agentMessage',
        text: '缺少 turn id 的最终回复',
        phase: 'final_answer'
      }
    })
    await waitForFallback()
    assert.equal(done.length, 0, 'an uncorrelated final_answer must not settle the active turn')

    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'answer-1',
        type: 'agentMessage',
        text: 'TraeX 最终回复',
        phase: 'final_answer'
      }
    })
    await waitForFallback()

    assert.equal(done.length, 1, 'TraeX final_answer must settle without turn/completed')
    assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1)

    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' }
    })
    assert.equal(done.length, 1, 'a late provider completion must be idempotent')
  } finally {
    runner.dispose()
  }
}

async function traeContinuedInputCancelsFinalFallback(): Promise<void> {
  const { runner, transport, done } = makeRunner('traex')
  try {
    await runner.startTurn('等待成员结果')
    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'answer-1', type: 'agentMessage', text: '等待互审。', phase: 'final_answer' }
    })
    transport.emit('notification', 'item/started', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'steered-input', type: 'userMessage', content: [{ type: 'text', text: '互审结果已到达' }] }
    })
    await waitForFallback()
    assert.equal(done.length, 0, 'accepted input after the final answer continues the same native turn')
    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'answer-2', type: 'agentMessage', text: '已完成最终交付。', phase: 'final_answer' }
    })
    await waitForFallback()
    assert.equal(done.length, 1, 'the later final answer can still settle the turn')
  } finally { runner.dispose() }
}

async function traeAsyncQuestionKeepsTurnActive(): Promise<void> {
  const { runner, transport, events, done } = makeRunner('traex')
  try {
    await runner.startTurn('等待授权后继续查询')
    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'async-question',
        type: 'agentMessage',
        text: '请完成授权，我会继续查询。',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: '请完成授权，我会继续查询。', options: null }]
      }
    })
    await waitForFallback()
    assert.equal(done.length, 0, 'an async question must not finish the native turn')
    assert.equal(events.filter((event) => event.type === 'turn_completed').length, 0)
    assert.equal(events.find((event) => event.payload?.id === 'async-question')?.payload.text,
      '请完成授权，我会继续查询。', 'the async question must still reach the conversation')

    runner.completeGoalTurn(2_000)
    transport.emit('notification', 'thread/tokenUsage/updated', {
      threadId: 'thread-1',
      tokenUsage: {
        last: { inputTokens: 21, outputTokens: 3 },
        total: { inputTokens: 21, outputTokens: 3 }
      }
    })
    await waitForFallback()
    assert.equal(done.length, 0, 'an async question must not qualify as the Goal reply')

    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'answer-1', type: 'agentMessage', text: '查询完成。',
        phase: 'final_answer', delivery: null, questions: null
      }
    })
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' }
    })
    await waitForFallback()
    assert.equal(done.length, 1, 'the real completion must settle the original turn exactly once')
    assert.deepEqual(events.filter((event) => event.type === 'turn_completed').map((event) => event.payload.turnId),
      ['turn-1'])
  } finally {
    runner.dispose()
  }
}

async function traeDoesNotReusePreviousTurnUsage(): Promise<void> {
  const { runner, transport, done } = makeRunner('traex')
  try {
    await runner.startTurn('普通消息')
    transport.emit('notification', 'thread/tokenUsage/updated', {
      threadId: 'thread-1',
      tokenUsage: {
        last: { inputTokens: 5, outputTokens: 1 },
        total: { inputTokens: 5, outputTokens: 1 }
      }
    })
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', durationMs: 500 }
    })
    assert.equal(done.length, 1)

    await runner.startTurn('TraeX Goal')
    transport.emit('notification', 'item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'answer-2', type: 'agentMessage', text: 'TraeX 最终回复' }
    })
    runner.completeGoalTurn(2_000)
    await waitForFallback()
    assert.equal(done.length, 1, 'a previous turn token tick must not complete the current Goal')

    transport.emit('notification', 'thread/tokenUsage/updated', {
      threadId: 'thread-1',
      tokenUsage: {
        last: { inputTokens: 7, outputTokens: 2 },
        total: { inputTokens: 12, outputTokens: 3 }
      }
    })
    await waitForFallback()
    assert.equal(done.length, 2, 'the current turn token tail must unlock TraeX Goal completion')
  } finally {
    runner.dispose()
  }
}

async function activeGoalTracksProviderTurnForSteer(): Promise<void> {
  const { runner, transport, events, done } = makeRunner('traex')
  const steerFallbacks: unknown[] = []
  runner.on('steerFailed', (item) => steerFallbacks.push(item))
  try {
    await runner.setGoal({ objective: '持续执行 Goal' })
    await runner.startTurn('持续执行 Goal')
    transport.emit('notification', 'queue/status', {
      threadId: 'thread-1',
      turnId: 'provider-turn-1',
      state: 'waiting',
      position: 3
    })
    await runner.steer('重连后直接发送')
    assert.equal(
      transport.calls.findLast((call) => call.method === 'turn/steer')?.params.expectedTurnId,
      'provider-turn-1',
      'Goal queue status must recover an active turn whose start notification predates the runner'
    )
    transport.emit('notification', 'turn/started', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-1', status: 'inProgress', items: [] }
    })
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-1', status: 'completed' }
    })

    await waitForFallback()
    assert.equal(done.length, 0, 'an active Goal provider turn must not finish the logical UniAgent turn')
    assert.equal(events.filter((event) => event.type === 'turn_completed').length, 0)

    transport.emit('notification', 'turn/started', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-2', status: 'inProgress', items: [] }
    })
    transport.emit('notification', 'turn/started', {
      threadId: 'child-thread',
      turn: { id: 'child-turn', status: 'inProgress', items: [] }
    })
    await runner.steer('直接发送')

    const steer = transport.calls.findLast((call) => call.method === 'turn/steer')
    assert.equal(steer?.params.expectedTurnId, 'provider-turn-2',
      'steer must target the latest provider-started turn on the main thread')
    assert.equal(steerFallbacks.length, 0, 'the accepted steer must not be re-enqueued')

    transport.emit('notification', 'thread/goal/updated', {
      threadId: 'thread-1',
      turnId: 'provider-turn-2',
      goal: {
        objective: '持续执行 Goal',
        status: 'complete',
        tokenBudget: null,
        tokensUsed: 20,
        timeUsedSeconds: 2,
        createdAt: 1,
        updatedAt: 3
      }
    })
    transport.emit('notification', 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'provider-turn-2', status: 'completed' }
    })
    assert.equal(done.length, 1, 'the terminal Goal provider turn must finish the logical turn')
    assert.deepEqual(
      events.filter((event) => event.type === 'turn_completed').map((event) => event.payload.turnId),
      ['provider-turn-2']
    )
  } finally {
    runner.dispose()
  }
}

await codexWaitsForProviderCompletion()
await traeFallsBackAfterGoalReplyAndUsage()
await traeFallsBackAfterExplicitFinalAnswer()
await traeContinuedInputCancelsFinalFallback()
await traeAsyncQuestionKeepsTurnActive()
await traeDoesNotReusePreviousTurnUsage()
await activeGoalTracksProviderTurnForSteer()
console.log('goal-provider-completion: ok')
