import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import type { AgentDef, SessionConfig, UAEvent } from '../src/shared/types.ts'

// 子agent隔离 — a headless unit test for the adapter's parent/child thread
// demultiplexing. We can't easily trigger a real multi-agent turn deterministically,
// so we drive AppServerRunner's private JSON-RPC message handler directly with
// synthetic notifications carrying the child's `threadId`, then assert that:
//   1. child agent_message / reasoning / command notifications NEVER reach the
//      main timeline (only the parent thread's do);
//   2. a collabAgentToolCall captures the dispatched `prompt` + `model` and emits
//      a `subagent` event carrying it;
//   3. a child `thread/tokenUsage/updated` surfaces as a `subagent` tokens
//      snapshot, NOT a main-chat usage/context notice;
//   4. the parent turn cannot declare a queued child completed; the child's own
//      terminal status determines the roster state.

const PARENT = 'parent-thread-0001'
const CHILD = 'child-thread-aaaa'
const QUEUED_CHILD = 'child-thread-queued'

const agent: AgentDef = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  adapter: 'codex',
  installed: true,
  capabilities: { streaming: true } as any
} as any

const config: SessionConfig = {
  agentId: 'codex',
  model: 'gpt-5',
  workdir: process.cwd(),
  permissionMode: 'full-access'
} as any

const events: UAEvent[] = []
const seqRef = { n: 0 }
const runner: any = new AppServerRunner('sess-1', seqRef, agent, config, PARENT)
runner.on('event', (ev: UAEvent) => events.push(ev))
runner.activeTurnToken = 'turn-attempt-fixture'
runner.curTurnId = 'turn-1'

// Feed a raw JSON-RPC notification through the same entry point the stdio reader
// uses (onMessage → onNotification), so we exercise the real dispatch path.
function notify(method: string, params: any): void {
  runner.onMessage({ jsonrpc: '2.0', method, params })
}

// 1) Parent spawns a child with a dispatched task + model. This must register the
//    child thread AND emit a subagent event carrying the prompt.
notify('item/started', {
  threadId: PARENT,
  turnId: 'turn-1',
  item: {
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status: 'inProgress',
    senderThreadId: PARENT,
    receiverThreadIds: [CHILD],
    prompt: '分析 zip 封面恢复逻辑并给出方案',
    model: 'gpt-5-codex',
    reasoningEffort: null,
    agentsStates: { [CHILD]: { status: 'running', message: null } }
  }
})

// 2) The CHILD streams its own output. NONE of this may hit the main timeline.
notify('item/started', {
  threadId: CHILD,
  turnId: 'cturn-1',
  item: { type: 'agentMessage', id: 'c-msg-1', text: '子agent的详细输出' }
})
notify('item/agentMessage/delta', { threadId: CHILD, turnId: 'cturn-1', itemId: 'c-msg-1', delta: '更多内容' })
notify('item/completed', {
  threadId: CHILD,
  turnId: 'cturn-1',
  item: { type: 'agentMessage', id: 'c-msg-1', text: '子agent的详细输出更多内容' }
})
notify('item/reasoning/textDelta', { threadId: CHILD, turnId: 'cturn-1', itemId: 'c-r-1', delta: '子思考' })
notify('item/commandExecution/outputDelta', { threadId: CHILD, turnId: 'cturn-1', itemId: 'c-cmd-1', delta: 'ls' })

// 3) The CHILD reports token usage — must surface only in the sidebar (subagent).
notify('thread/tokenUsage/updated', {
  threadId: CHILD,
  turnId: 'cturn-1',
  tokenUsage: {
    total: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 0 },
    last: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 0 },
    modelContextWindow: 200000
  }
})

// 4) The PARENT streams its own message — this SHOULD reach the main timeline.
notify('item/started', {
  threadId: PARENT,
  turnId: 'turn-1',
  item: { type: 'agentMessage', id: 'p-msg-1', text: '主agent的回答' }
})
notify('item/completed', {
  threadId: PARENT,
  turnId: 'turn-1',
  item: { type: 'agentMessage', id: 'p-msg-1', text: '主agent的回答' }
})

// 5) Parent token usage — this is the main-chat usage source.
notify('thread/tokenUsage/updated', {
  threadId: PARENT,
  turnId: 'turn-1',
  tokenUsage: {
    total: { inputTokens: 5000, outputTokens: 800, cachedInputTokens: 0 },
    last: { inputTokens: 5000, outputTokens: 800, cachedInputTokens: 0 },
    modelContextWindow: 200000
  }
})

// 6) One child finishes, while another is still queued when the parent finishes.
notify('turn/completed', { threadId: CHILD, turn: { id: 'cturn-1', status: 'completed' } })
notify('item/started', {
  threadId: PARENT,
  turnId: 'turn-1',
  item: {
    type: 'collabAgentToolCall', id: 'collab-queued', tool: 'spawnAgent',
    status: 'inProgress', senderThreadId: PARENT,
    receiverThreadIds: [QUEUED_CHILD],
    agentsStates: { [QUEUED_CHILD]: { status: 'running' } }
  }
})
notify('turn/completed', { threadId: PARENT, turn: { id: 'turn-1', status: 'completed', durationMs: 1234 } })

const queuedBeforeCompletion = events.filter((e) => e.type === 'subagent')
  .flatMap((e) => ((e.payload as any).agents || []) as any[])
  .filter((a) => a.agentThreadId === QUEUED_CHILD).at(-1)?.status
notify('turn/completed', { threadId: QUEUED_CHILD, turn: { id: 'cturn-queued', status: 'interrupted' } })

// ---- assertions ----
const results: { name: string; pass: boolean; detail?: string }[] = []
const check = (name: string, pass: boolean, detail?: string): void => {
  results.push({ name, pass, detail })
}

const mainMessages = events.filter((e) => e.type === 'agent_message')
const mainMsgText = mainMessages.map((e) => (e.payload as any).text || '').join('||')
check(
  '主聊天框只含主agent消息（无子agent文本泄漏）',
  mainMessages.length > 0 && !mainMsgText.includes('子agent') && mainMsgText.includes('主agent的回答'),
  `mainMessages=${mainMessages.length}, text="${mainMsgText}"`
)

const mainReasoning = events.filter((e) => e.type === 'reasoning')
check('子agent的reasoning不进主聊天框', mainReasoning.every((e) => !((e.payload as any).text || '').includes('子思考')), `reasoning=${mainReasoning.length}`)

const mainCommands = events.filter((e) => e.type === 'command_exec')
check('子agent的命令输出不进主聊天框', mainCommands.length === 0, `command_exec=${mainCommands.length}`)

const usageNotices = events.filter((e) => e.type === 'system_notice' && (e.payload as any).kind === 'usage')
const contextNotices = events.filter((e) => e.type === 'system_notice' && (e.payload as any).kind === 'context')
// Only the PARENT usage should produce main-chat usage/context notices. The child
// tokenUsage must NOT add a second context tick.
check('主聊天框仅一份用量卡片（子agent token不泄漏）', usageNotices.length === 1, `usage notices=${usageNotices.length}`)
check('上下文计量仅来自主线程（1 次）', contextNotices.length === 1, `context notices=${contextNotices.length}`)

const subEvents = events.filter((e) => e.type === 'subagent')
const allAgents = subEvents.flatMap((e) => ((e.payload as any).agents || []) as any[])
const withPrompt = allAgents.find((a) => a.prompt && a.prompt.includes('zip 封面'))
check('侧栏捕获派发任务（prompt）', !!withPrompt, withPrompt ? `prompt="${withPrompt.prompt}"` : '无 prompt')

const withTokens = allAgents.find((a) => a.tokens && a.tokens.totalTokens === 1540)
check('侧栏承载子agent token（1540）', !!withTokens, withTokens ? `tokens=${JSON.stringify(withTokens.tokens)}` : '无 tokens')

// The LAST subagent state for the child must be a terminal status (completed).
const childStates = allAgents.filter((a) => a.agentThreadId === CHILD)
const lastChild = childStates[childStates.length - 1]
check('子agent结束后状态为completed（横幅不再进行中）', !!lastChild && lastChild.status === 'completed', `lastStatus=${lastChild?.status}`)
check('主回合完成不能把排队中的子agent标成已完成', queuedBeforeCompletion === 'running', `lastStatus=${queuedBeforeCompletion}`)
const queuedLast = allAgents.filter((a) => a.agentThreadId === QUEUED_CHILD).at(-1)
check('子回合中断状态来自原生通知', queuedLast?.status === 'interrupted', `lastStatus=${queuedLast?.status}`)

// ---- summary ----
const passed = results.filter((r) => r.pass).length
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? ' :: ' + r.detail : ''}`)
console.log(`\n==== ${passed}/${results.length} checks passed ====`)
runner.dispose?.()
process.exit(passed === results.length ? 0 : 1)
