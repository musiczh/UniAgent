import assert from 'node:assert/strict'
import test from 'node:test'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderOpenChains } from './regression/open-chain'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream, coveredSubAgentToolSeqs, subAgentsFromEvents } from '../src/renderer/components/EventStream.tsx'
import { SubAgentPanel, subAgentDetailEvents } from '../src/renderer/components/SubAgentPanel.tsx'
import { BUILTIN_AGENTS } from '../src/main/agents.ts'
import { agentForSession } from '../src/shared/types.ts'
import type { UAEvent, UASubAgent } from '../src/shared/types.ts'

// Match the existing SSR timeline tests; sanitization requires a browser DOM.
Object.assign(DOMPurify, { sanitize: (html: string) => html })

const event = (seq: number, type: UAEvent['type'], payload: Record<string, unknown>, state?: UAEvent['state']): UAEvent => ({
  sessionId: 'session',
  seq,
  ts: seq * 100,
  type,
  state,
  payload
})

const firstThread = '01a0573c-48be-7380-91b0-3926c01da499'
const secondThread = '01a0573c-49c6-7f93-887c-19d6f7d319d1'

test('sub-agent list retains two restored children when a third arrives in the event stream', () => {
  const saved: UASubAgent[] = [
    { agentThreadId: firstThread, name: 'ui_test_a', status: 'completed', prompt: '核对测试证据。不要修改源码。' },
    { agentThreadId: secondThread, name: 'ui_test_b', status: 'completed' }
  ]
  const events = [event(10, 'subagent', { agents: [{
    agentThreadId: 'third-thread', name: 'ui_test_c', status: 'completed'
  }] })]
  const roster = subAgentsFromEvents(events, saved)
  assert.deepEqual(roster.map(agent => agent.name), ['ui_test_a', 'ui_test_b', 'ui_test_c'])
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
  try {
    const markup = renderToStaticMarkup(createElement(SubAgentPanel, {
      open: true, sessionId: 'session', subagents: roster, activeThreadId: '', initialView: 'list',
      onSelect() {}, onClose() {}
    }))
    assert.match(markup, /完成 · 3/)
    for (const name of ['ui_test_a', 'ui_test_b', 'ui_test_c']) {
      assert.equal((markup.match(new RegExp(`>${name}<`, 'g')) || []).length, 1)
    }
    assert.match(markup, /class="sa-task"> · 核对测试证据</)
    assert.doesNotMatch(markup, /不要修改源码/)
    const detail = renderToStaticMarkup(createElement(SubAgentPanel, {
      open: true, sessionId: 'session', subagents: roster, activeThreadId: firstThread, initialView: 'detail',
      onSelect() {}, onClose() {}
    }))
    assert.match(detail, /title="ui_test_a · 核对测试证据"/)
  } finally {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else delete (globalThis as any).localStorage
  }
  assert.equal(saved.length, 2, 'deriving the visible roster must not mutate the saved snapshot')
})

test('visible sub-agent roster merges current dispatches without losing saved task metadata', () => {
  const saved: UASubAgent[] = [{
    agentThreadId: firstThread, name: 'review', status: 'completed', generation: 1,
    dispatchId: 'old', prompt: 'old task', startedAt: 100, endedAt: 200
  }, {
    agentThreadId: secondThread, name: 'saved-only', status: 'completed', prompt: 'saved task'
  }]
  const roster = subAgentsFromEvents([
    event(3, 'subagent', { agents: [{
      agentThreadId: firstThread, status: 'running', generation: 2, dispatchId: 'new', prompt: 'new task'
    }] }),
    event(4, 'subagent', { agents: [{ agentThreadId: firstThread, status: 'completed', generation: 1 }] })
  ], saved)
  assert.equal(roster[0].status, 'running')
  assert.equal(roster[0].prompt, 'new task')
  assert.equal(roster[0].generation, 2)
  assert.equal(roster[1].prompt, 'saved task')
  assert.deepEqual(subAgentsFromEvents([], saved).map(agent => agent.agentThreadId), [firstThread, secondThread])
})

test('later sub-agent names replace colliding short-id labels', () => {
  const markup = renderOpenChains(createElement(EventStream, {
    events: [
      event(1, 'user_message', { text: 'review' }),
      event(2, 'subagent', { agents: [
        { agentThreadId: firstThread, name: '01a0573c', status: 'running' },
        { agentThreadId: secondThread, name: '01a0573c', status: 'running' }
      ] }),
      event(3, 'subagent', { agents: [
        { agentThreadId: firstThread, name: 'review_git_flow', status: 'completed' }
      ] }),
      event(4, 'subagent', { agents: [
        { agentThreadId: secondThread, name: 'review_ui_flow', status: 'completed' }
      ] })
    ]
  }))

  assert.doesNotMatch(markup, />01a0573c</)
  assert.equal((markup.match(/>review_git_flow</g) || []).length, 2)
  assert.equal((markup.match(/>review_ui_flow</g) || []).length, 2)
})

test('an appended sub-agent question renders once without restarting or exposing its thread id', () => {
  const markup = renderOpenChains(createElement(EventStream, {
    events: [
      event(1, 'user_message', { text: 'review' }),
      event(2, 'subagent', { id: 'spawn:started', agents: [{
        agentThreadId: firstThread,
        status: 'running',
        generation: 1,
        dispatchId: 'spawn',
        tool: 'spawnAgent'
      }] }),
      event(3, 'subagent', { id: 'append:started', agents: [{
        agentThreadId: firstThread,
        name: 'review_verified_links',
        status: 'running',
        generation: 1,
        dispatchId: 'spawn',
        tool: 'sendInput'
      }] }),
      event(4, 'subagent', { id: 'append:completed', agents: [{
        agentThreadId: firstThread,
        name: 'review_verified_links',
        status: 'running',
        generation: 1,
        dispatchId: 'spawn',
        tool: 'interacted'
      }] }),
      event(5, 'subagent', { id: 'token-tick', agents: [{
        agentThreadId: firstThread,
        name: 'review_verified_links',
        status: 'running',
        generation: 1,
        dispatchId: 'spawn'
      }] })
    ]
  }))

  assert.equal((markup.match(/>开始工作</g) || []).length, 1)
  assert.equal((markup.match(/>追加提问</g) || []).length, 1)
  assert.doesNotMatch(markup, />已完成</)
  assert.doesNotMatch(markup, />已中断</)
  assert.doesNotMatch(markup, />01a0573c</)
  assert.equal((markup.match(/>review_verified_links</g) || []).length, 2)
})

test('a sub-agent without metadata uses a generic label instead of a short thread id', () => {
  const markup = renderOpenChains(createElement(EventStream, {
    events: [
      event(1, 'user_message', { text: 'review' }),
      event(2, 'subagent', { agents: [{
        agentThreadId: firstThread,
        name: firstThread.slice(0, 8),
        status: 'running'
      }] })
    ]
  }))

  assert.match(markup, />子智能体</)
  assert.doesNotMatch(markup, />01a0573c</)
})

test('native names and dispatch task summaries stay consistent across lifecycle rows', () => {
  const events = [
    event(1, 'user_message', { text: 'generate reports' }),
    event(2, 'subagent', { agents: [{
      agentThreadId: firstThread, status: 'running', dispatchId: 'report-v2', generation: 1,
      prompt: '生成最终报告 v2。保留测试证据。'
    }] }),
    event(3, 'subagent', { agents: [{
      agentThreadId: firstThread, name: 'Dirac', status: 'running', dispatchId: 'report-v2', generation: 1,
      tool: 'sendInput'
    }] }),
    event(4, 'subagent', { agents: [{
      agentThreadId: firstThread, status: 'completed', dispatchId: 'report-v2', generation: 1
    }] }),
    event(5, 'subagent', { agents: [{
      agentThreadId: firstThread, status: 'running', dispatchId: 'report-v3', generation: 2,
      prompt: '更新报告 v3。检查数量。'
    }] }),
    event(6, 'subagent', { agents: [{
      agentThreadId: secondThread, name: 'Curie', status: 'running', prompt: '核对截图。'
    }] })
  ]
  const markup = renderOpenChains(createElement(EventStream, { events }))
  assert.equal((markup.match(/>Dirac</g) || []).length, 4)
  assert.equal((markup.match(/class="sa-task"> · 生成最终报告 v2</g) || []).length, 3)
  assert.equal((markup.match(/class="sa-task"> · 更新报告 v3</g) || []).length, 1,
    'a newer dispatch task must not replace earlier lifecycle row summaries')
  assert.match(markup, />Curie</)
  assert.match(markup, /class="sa-task"> · 核对截图</)
  assert.doesNotMatch(markup, /保留测试证据|检查数量/)
})

test('sub-agent detail trusts persisted user messages instead of moving the latest prompt to the top', () => {
  const items = [
    event(1, 'user_message', { text: 'initial task' }),
    event(2, 'agent_message', { text: 'working' }),
    event(3, 'user_message', { text: 'appended question' })
  ]
  const ordered = subAgentDetailEvents({
    agentThreadId: firstThread,
    status: 'running',
    prompt: 'appended question',
    startedAt: 100
  }, items)

  assert.deepEqual(
    ordered.filter((item) => item.type === 'user_message').map((item) => item.payload.text),
    ['initial task', 'appended question']
  )
})

test('sub-agent detail hides opaque and empty inputs while retaining readable messages and output order', () => {
  const encrypted = `gAAAAA${'B'.repeat(92)}==`
  const active: UASubAgent = { agentThreadId: firstThread, status: 'running', prompt: encrypted }
  const output = event(2, 'agent_message', { text: 'working' })
  for (const prompt of [encrypted, `  ${encrypted}\n`, '', ' \n ', undefined]) {
    assert.deepEqual(subAgentDetailEvents({ ...active, prompt }, [output]), [output],
      'an unreadable dispatch must not create a synthetic input bubble')
  }
  const initial = event(3, 'user_message', { text: '检查接口实现' })
  const followup = event(5, 'user_message', { text: 'also inspect the fallback' })
  const items = [event(1, 'user_message', { text: encrypted }), output, initial,
    event(4, 'user_message', { text: ' \n ' }), followup]
  const visible = subAgentDetailEvents(active, items)
  assert.deepEqual(visible, [output, initial, followup])
  assert.equal(items.length, 5, 'filtering must not mutate the persisted events')
  const markup = renderToStaticMarkup(createElement(EventStream, { events: visible, status: 'running' }))
  assert.doesNotMatch(markup, /gAAAA|无法获取输入/)
  assert.equal((markup.match(/class="card user-msg/g) || []).length, 2)
  const fallback = subAgentDetailEvents({ ...active, prompt: '可读的初始任务' }, [items[0], output])
  assert.deepEqual(fallback.map(item => [item.type, item.payload.text]),
    [['user_message', '可读的初始任务'], ['agent_message', 'working']])
  const attachment = event(6, 'user_message', { text: encrypted,
    attachments: [{ kind: 'file', name: 'input.txt', path: '/fixture/input.txt' }] })
  assert.deepEqual(subAgentDetailEvents(active, [attachment])[0].payload,
    { ...attachment.payload, text: '' }, 'valid attachments must survive without exposing opaque text')
})

test('restored opaque tasks never appear in sub-agent titles or summaries', () => {
  const encrypted = `gAAAAA${'B'.repeat(92)}==`
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
  try {
    for (const initialView of ['list', 'detail'] as const) {
      const markup = renderToStaticMarkup(createElement(SubAgentPanel, {
        open: true, sessionId: 'session', activeThreadId: firstThread, initialView,
        subagents: [{ agentThreadId: firstThread, name: 'search_docs', status: 'running', prompt: encrypted }],
        onSelect() {}, onClose() {}
      }))
      assert.match(markup, /search_docs/)
      assert.doesNotMatch(markup, /gAAAA|class="sa-task"/)
    }
  } finally {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else delete (globalThis as any).localStorage
  }
})

test('latest turn usage appears only after the owning agent finishes', () => {
  const events: UAEvent[] = [
    event(10, 'user_message', { text: 'first' }),
    event(11, 'system_notice', {
      kind: 'usage',
      usage: { inputTokens: 111, outputTokens: 11 }
    }),
    event(12, 'turn_completed', {}),
    event(13, 'user_message', { text: 'second' }),
    event(14, 'system_notice', {
      kind: 'usage',
      usage: { inputTokens: 222, outputTokens: 22 }
    }),
    // A growing rollout parser may synthesize this at its current EOF even though
    // the authoritative child lifecycle still says the agent is running.
    event(15, 'turn_completed', {})
  ]
  const runningMarkup = renderToStaticMarkup(createElement(EventStream, {
    events,
    status: 'running'
  }))
  assert.match(runningMarkup, /本轮 · 输入 111 · 输出 11/)
  assert.doesNotMatch(runningMarkup, /本轮 · 输入 222 · 输出 22/)

  const finishedMarkup = renderToStaticMarkup(createElement(EventStream, {
    events,
    status: 'idle'
  }))
  assert.match(finishedMarkup, /本轮 · 输入 222 · 输出 22/)
})

test('a sub-agent card covers its dispatch tool row while unpaired tool calls stay', () => {
  const markup = renderOpenChains(createElement(EventStream, {
    events: [
      event(1, 'user_message', { text: '并行探索需求链路' }),
      event(2, 'tool_call', { id: 'toolu_agent', name: 'Agent', input: { prompt: '在仓库中探索需求链路' } }, 'running'),
      event(3, 'subagent', { agents: [{
        agentThreadId: firstThread, name: 'explore_settings', status: 'running', dispatchId: 'toolu_agent'
      }] }),
      event(4, 'tool_call', { id: 'toolu_agent', name: 'Agent', input: { prompt: '在仓库中探索需求链路' } }, 'success'),
      event(5, 'tool_call', { id: 'toolu_keep', name: 'Bash', input: { command: 'git log --oneline' } }, 'success'),
      event(6, 'subagent', { agents: [{
        agentThreadId: firstThread, name: 'explore_settings', status: 'completed', dispatchId: 'toolu_agent'
      }] })
    ]
  }))

  // 已有子 Agent 卡片时，同一派发的工具行（running 与 success 更新）一起隐藏。
  assert.doesNotMatch(markup, /在仓库中探索需求链路/)
  assert.doesNotMatch(markup, />Agent</)
  // 卡片本身保留；对不上卡片的工具调用仍展示。
  assert.equal((markup.match(/>explore_settings</g) || []).length, 2)
  assert.match(markup, /git log --oneline/)
})

test('an agent dispatch tool row stays visible when no sub-agent card covers it', () => {
  const markup = renderOpenChains(createElement(EventStream, {
    events: [
      event(1, 'user_message', { text: 'review' }),
      event(2, 'tool_call', { id: 'toolu_solo', name: 'Agent', input: { prompt: '派发未上报卡片' } }, 'failed')
    ]
  }))

  assert.match(markup, /派发未上报卡片/)
})

test('covered sub-agent tool seqs hide the whole tool-id group only', () => {
  const events = [
    event(2, 'tool_call', { id: 'toolu_agent', name: 'Agent', input: { prompt: 'x' } }, 'running'),
    event(3, 'tool_call', { id: 'toolu_agent', name: 'Agent', output: 'done' }, 'success'),
    event(4, 'tool_call', { id: 'toolu_keep', name: 'Bash', input: { command: 'ls' } }, 'success')
  ]
  assert.deepEqual([...coveredSubAgentToolSeqs([{ dispatchId: 'toolu_agent' }], events)].sort(), [2, 3],
    '同一 tool id 的 running / success 更新成组隐藏，未配对工具行保留')
  assert.deepEqual([...coveredSubAgentToolSeqs([], events)], [], '没有子 Agent 卡片时工具行保留')
  assert.deepEqual([...coveredSubAgentToolSeqs([{}], events)], [], '卡片缺少 dispatchId 时不误伤工具行')
})

test('claude declares structured sub-agents so cards open the detail panel', () => {
  const claude = BUILTIN_AGENTS.find((agent) => agent.id === 'claude')
  assert.ok(claude, 'claude must stay a builtin agent')
  // App.tsx 仅在该能力为 true 时传入 onOpenSubAgent 并挂载 SubAgentPanel。
  assert.equal(agentForSession(claude, null).capabilities.structuredSubagents, true)
})
