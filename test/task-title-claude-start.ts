import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { TurnRunner, buildCommand } from '../src/main/adapter'
import { TaskTitleIntegration } from '../src/main/taskTitleIntegration'
import { TaskMetadataStore } from '../src/main/taskMetadataStore'
import { TaskTitleService } from '../src/main/taskTitleService'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'title-claude-start-'))
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; assert.fail('Claude fixture timeout') }
try {
  for (const mode of ['pending', 'reject'] as const) {
    const config = { agentId: 'claude', workdir: root, model: 'small', permissionMode: 'ask' as const }
    const agent = { id: 'claude', adapter: 'claude', name: 'Claude', bin: '/usr/bin/true', installed: true, models: [{ id: 'small', efforts: [] }], capabilities: { modelSelect: true, startupSystemPrompt: true, permissionModes: [{ id: 'ask', label: '', hint: '' }] } } as AgentDef
    const session = { id: mode, title: '临时标题', config } as Session
    let generated = 0, send = false, settle!: () => void
    const titles = new TaskTitleService(new TaskMetadataStore(join(root, mode)), {
      session: id => id === mode ? session : undefined, agents: () => [agent], config: () => ({ enabled: true, agentId: 'claude', model: 'small' }),
      generate: async () => { generated++; return '{"title":"修复图片漏显","description":"任务描述夹具","needsClarification":false}' }
    }, { debounceMs: 8 })
    const bridge = new TaskTitleIntegration(titles, id => id === mode ? session : undefined)
    const runner = new TurnRunner(mode, { n: 1 }), sdk = new EventEmitter() as any
    sdk.request = async (method: string) => {
      if (method === 'reloadPlugins') return { commands: [] }
      if (method === 'send') { send = true; return new Promise<void>((resolve, reject) => { settle = () => mode === 'reject' ? reject(new Error('fixture send failed')) : resolve() }) }
      return {}
    }
    sdk.close = async () => {}; sdk.respond = () => {}
    const launch = buildCommand(agent, config, '修复图片漏显', undefined, undefined, mode, undefined, true)
    ;(runner as any).sdk = sdk
    ;(runner as any).sdkKey = JSON.stringify({ bin: agent.bin, version: agent.version, config, env: undefined, instructions: launch.appendedPrompt })
    ;(runner as any).nativeSessionId = 'claude-native'
    const events: UAEvent[] = []
    runner.on('event', event => { events.push(event); bridge.observe(event) })
    bridge.observe({ sessionId: mode, seq: 0, ts: 1, type: 'user_message', payload: { text: '修复图片漏显' } })
    bridge.accepted(mode)
    try {
      runner.start(agent, config, '修复图片漏显')
      await until(() => send)
      const optimistic = events.find(event => event.type === 'turn_started')!
      assert.ok(optimistic.payload.turnId && optimistic.payload.sessionId === 'claude-native' && !optimistic.payload.threadId, 'real TurnRunner retains the synthetic UI boundary before sdk.send')
      if (mode === 'reject') settle()
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(generated, 0, 'synthetic Claude start must not spend on title while send is pending or failed')
      if (mode === 'pending') {
        settle()
        ;(runner as any).parseClaude({ type: 'assistant', uuid: 'assistant-first', session_id: 'claude-native', message: { id: 'message-first', role: 'assistant', content: [{ type: 'text', text: '正在修复图片显示' }] } })
        await until(() => generated === 1)
        ;(runner as any).parseClaude({ type: 'assistant', uuid: 'assistant-repeat', session_id: 'claude-native', message: { id: 'message-repeat', role: 'assistant', content: [{ type: 'text', text: '继续检查' }] } })
        ;(runner as any).parseClaude({ type: 'assistant', uuid: 'assistant-final', session_id: 'claude-native', message: { id: 'message-final', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '主 AI 已定位历史消息中的图片预览丢失。' }] } })
        bridge.observe({ sessionId: mode, seq: 999, ts: Date.now(), type: 'turn_completed', state: 'success', payload: {} })
        await until(() => generated === 1)
        await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(generated, 1)
      }
    } finally { settle?.(); await titles.close(); await (runner as any).disposeClaudeSdk() }
  }
  console.log('PASS real Claude first output starts naming; synthetic start and pending/rejected send do not name')
} finally { await rm(root, { recursive: true, force: true }) }
