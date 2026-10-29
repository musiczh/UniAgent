import DOMPurify from 'dompurify'
// SSR checks layout only; browser sanitization is covered by engine acceptance.
DOMPurify.sanitize = (html: string) => html
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UAEvent } from '../src/shared/types.ts'
import { EventStream } from '../src/renderer/components/EventStream.tsx'

const files = Array.from({ length: 7 }, (_, index) => ({
  path: `file-${index + 1}.ts`,
  kind: 'modify' as const,
  diff: '',
  added: 1,
  removed: 0,
}))

const render = (count: number): string => {
  const diff = files.slice(0, count).map((file) =>
    `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1 +1 @@\n-old\n+new`
  ).join('\n')
  const events: UAEvent[] = [
    { sessionId: 'test', seq: 1, ts: 1, type: 'user_message', payload: { text: 'edit' } },
    { sessionId: 'test', seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { text: 'done' } },
    { sessionId: 'test', seq: 3, ts: 3, type: 'diff_update', payload: { diff } },
    { sessionId: 'test', seq: 4, ts: 4, type: 'turn_completed', payload: {} },
  ]
  return renderToStaticMarkup(createElement(EventStream, { events }))
}

const markup = render(7)
assert.equal((markup.match(/data-file=/g) || []).length, 6)
assert.match(markup, /展开其余 1 个文件/)

const twoFileMarkup = render(2)
assert.equal((twoFileMarkup.match(/data-file=/g) || []).length, 2)
