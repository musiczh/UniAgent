import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
import { mergeSessionEvent } from '../src/renderer/App.tsx'
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

async function markup(event: UAEvent): Promise<string> {
  // Markdown sanitization requires a DOM; exercise the actual disclosures in the browser.
  return renderEventStream([
    { sessionId: 'task-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'run' } },
    event
  ], 'running', 'task-session', { inspect: `(async () => {
    for (let pass = 0; pass < 8; pass++) {
      const closed = [...document.querySelectorAll('button.process-step-meta[aria-expanded=false],button.steps-fold-row[aria-expanded=false]')];
      if (!closed.length) return document.body.innerHTML;
      for (const button of closed) button.click();
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('background task disclosures did not settle');
  })()` })
}
const successMarkup = await markup(merged[0])
assert.match(successMarkup, /后台任务 #6201/)
assert.match(successMarkup, /Shell task completed with exit code 0/)
assert.match(successMarkup, /task_output-6201.txt/)
assert.doesNotMatch(successMarkup, /<details[^>]* open=""/, 'successful background tasks must stay collapsed by default')

const failedMarkup = await markup(task(3, 'failed', 'failed'))
assert.match(failedMarkup, /background-task open state-failed/, 'failed background tasks must open by default')
assert.match(failedMarkup, /Shell task failed with exit code 1/)

console.log('background task event stream: ok')
