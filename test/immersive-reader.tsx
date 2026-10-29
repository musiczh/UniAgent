// Run explicitly: node scripts/run-ts-test.mjs test/immersive-reader.tsx
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DOMPurify from 'dompurify'
import type { UAEvent } from '../src/shared/types'
import { EventStream } from '../src/renderer/components/EventStream'
import { ImmersiveReader } from '../src/renderer/components/ImmersiveReader'

// Node has no DOM; these controlled fixtures contain no untrusted HTML.
Object.assign(DOMPurify, { sanitize: (html: string) => html })
const event = (seq: number, type: UAEvent['type'], payload: UAEvent['payload'] = {}): UAEvent =>
  ({ sessionId: 'reader-check', seq, ts: seq * 1000, type, payload, state: 'success' })
const user = event(1, 'user_message', { text: 'Explain' })
const progress = event(2, 'agent_message', { text: 'Checking', phase: 'commentary' })
const final = event(3, 'agent_message', { text: '# Answer', phase: 'final_answer' })
const completed = event(4, 'turn_completed')
const supplement = event(5, 'agent_message', { text: 'Extra details' })
const readerButtons = (events: UAEvent[], status: 'running' | 'idle') => {
  const html = renderToStaticMarkup(createElement(EventStream, { events, status, onOpenReader: () => {} }))
  return (html.match(/aria-label="沉浸阅读"/g) || []).length
}
assert.equal(readerButtons([user, progress], 'running'), 0, 'progress must never expose reading')
assert.equal(readerButtons([user, progress, completed], 'idle'), 0, 'ending after commentary does not turn it into a final answer')
assert.equal(readerButtons([user, progress, final, completed, supplement], 'idle'), 1,
  'the final answer has one entry; supplements have none')
assert.equal(readerButtons([user, progress, event(3, 'agent_message', { text: 'Legacy final' }), completed], 'idle'), 1,
  'providers without phase metadata use the completed turn final reply')

const renderReader = (reply: UAEvent) => renderToStaticMarkup(createElement(ImmersiveReader, {
  event: reply, sessionTitle: 'Test', agentName: 'Agent', annotations: [],
  onAddComment: () => {}, onUpdateComment: () => {}, onRemoveComment: () => {},
  onOpenFile: () => {}, onClose: () => {},
}))
const html = renderReader(final)
assert.match(html, /aria-label="展开评论"[^>]*aria-expanded="false"/, 'comments start collapsed')
assert.doesNotMatch(html, /<aside[^>]*aria-label="评论"/, 'collapsed comments consume no sidebar')
assert.match(html, /aria-label="返回对话"/, 'the icon-only back action stays accessible')
assert.doesNotMatch(html, /aria-label="关闭沉浸阅读"/, 'there is only one exit action')
assert.match(html, /aria-label="展开目录"/, 'a reply with headings exposes its table of contents')
const noHeadings = renderReader(event(6, 'agent_message', { text: 'Plain reply\n\n```md\n# Code, not a heading\n```' }))
assert.doesNotMatch(noHeadings, /immersive-reader-toc-slot|aria-label="(?:展开目录|收起目录|目录)"|本条回复没有标题/,
  'a reply without headings has no table of contents control or empty column')
console.log('Immersive reader checks passed')
