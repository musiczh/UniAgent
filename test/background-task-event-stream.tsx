import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderOpenChains } from './regression/open-chain'
import { mergeSessionEvent } from '../src/renderer/App.tsx'
import { EventStream } from '../src/renderer/components/EventStream.tsx'
import type { UAEvent } from '../src/shared/types.ts'

function task(seq: number, state: UAEvent['state'], status: string): UAEvent {
  return {
    sessionId: 'task-session', seq, ts: 1_000 + seq,
    type: 'background_task' as UAEvent['type'], state,
    payload: {
      id: 'task-message-1', turnId: 'turn-1', taskId: '6201', status,
      summary: status === 'failed' ? 'Shell task failed with exit code 1' : 'Shell task completed with exit code 0',
      outputFile: '/tmp/task_output-6201.txt'
    }
  }
}

const merged = [
  task(1, 'running', 'running'),
  task(2, 'success', 'completed')
].reduce<UAEvent[]>(mergeSessionEvent, [])
assert.equal(merged.length, 1, 'started/completed updates for one background task must replace in place')
assert.equal(merged[0].state, 'success')

const successMarkup = renderOpenChains(createElement(EventStream, {
  sessionId: 'task-session', status: 'running',
  events: [
    { sessionId: 'task-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'run' } },
    merged[0]
  ]
}))
assert.match(successMarkup, /后台任务 #6201/)
assert.match(successMarkup, /Shell task completed with exit code 0/)
assert.match(successMarkup, /task_output-6201.txt/)
assert.doesNotMatch(successMarkup, /<details[^>]* open=""/, 'successful background tasks must stay collapsed by default')

const failedMarkup = renderOpenChains(createElement(EventStream, {
  sessionId: 'task-session', status: 'running',
  events: [
    { sessionId: 'task-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'run' } },
    task(3, 'failed', 'failed')
  ]
}))
assert.match(failedMarkup, /background-task open state-failed/, 'failed background tasks must open by default')
assert.match(failedMarkup, /Shell task failed with exit code 1/)

console.log('background task event stream: ok')
