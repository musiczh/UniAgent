import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderOpenChains } from './regression/open-chain'
import { EventStream, groupChainEvents } from '../src/renderer/components/EventStream.tsx'
import type { UAEvent } from '../src/shared/types.ts'

const command = (seq: number, id: string): UAEvent => ({
  sessionId: 'bash-session', seq, ts: 1_000 + seq, type: 'command_exec', state: 'success',
  payload: { id, command: `echo ${id}`, output: `output-${id}`, exitCode: 0 },
})

const first = command(1, 'first')
const second = command(3, 'second')
const latest = command(4, 'latest')
const fileChange: UAEvent = {
  sessionId: 'bash-session', seq: 2, ts: 1_002, type: 'file_change', state: 'success',
  payload: { id: 'file', changes: [{ kind: 'modify', path: '/repo/file.ts' }] },
}
const trailingTool: UAEvent = {
  sessionId: 'bash-session', seq: 5, ts: 1_005, type: 'tool_call', state: 'success',
  payload: { id: 'tool', name: 'read_file', result: { ok: true } },
}

const grouped = groupChainEvents([first, fileChange, second, latest, trailingTool])
assert.deepEqual(grouped.map((entry) => entry.kind), ['commands', 'event', 'event'])
assert.equal(grouped[0].kind === 'commands' ? grouped[0].events.length : 0, 3)

const markup = renderOpenChains(createElement(EventStream, {
  sessionId: 'bash-session',
  status: 'running',
  events: [
    { sessionId: 'bash-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'run' } },
    first, fileChange, second, latest, trailingTool,
  ],
}))

assert.match(markup, /step-call-row" type="button" aria-expanded="false"/, 'Bash call details stay collapsed by default')
assert.match(markup, /step-call-name">Bash<\/span>[\s\S]*step-call-count">×2 次/, 'adjacent Bash calls summarize repeated executions')
assert.match(markup, /step-call-disclosure\" data-collapse-state=\"closed\" aria-hidden=\"true\"/, 'collapsed Bash details are hidden from the accessible tree')

const running = { ...command(6, 'running'), state: 'running' as const }
const runningMarkup = renderOpenChains(createElement(EventStream, {
  sessionId: 'bash-session',
  status: 'running',
  events: [
    { sessionId: 'bash-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'run' } },
    first, running,
  ],
}))
assert.match(runningMarkup, /step-call-count">×2 次/, 'Bash call status includes completed and running commands')
assert.match(runningMarkup, /step-call-status">[\s\S]*运行中/, 'the call row exposes running status')

console.log('bash event stream: ok')
