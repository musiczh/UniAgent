import assert from 'node:assert/strict'
import { hydrateSubmittedUserMessages, submittedTextHash } from '../src/main/submittedUserMessages.ts'
import type { Attachment, SubmittedUserMessage, UAEvent } from '../src/shared/types.ts'
import { buildDurableQueueItem, Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const image: Attachment = {
  kind: 'image',
  name: 'clip-1792466435643.png',
  path: '/Users/me/Library/Application Support/uniagent/clipboard-images/clip-1792466435643.png',
  mime: 'image/png'
}
const file: Attachment = { kind: 'file', name: 'notes.md', path: '/repo/notes.md', mime: 'text/markdown' }
const suffix = (attachments: Attachment[]) =>
  `\n\n附件:\n${attachments.map(attachment => `- ${attachment.path}`).join('\n')}`

function userEvent(text: string): UAEvent {
  return { sessionId: 's_test', seq: 0, ts: 1, type: 'user_message', payload: { text } }
}

function snapshot(
  text: string,
  attachments?: Attachment[],
  extra: Partial<SubmittedUserMessage> = {}
): SubmittedUserMessage {
  return {
    type: 'user_message',
    userOrdinal: 0,
    textHash: submittedTextHash(text),
    acceptedAt: 1,
    ...(attachments ? { attachments } : {}),
    ...extra
  }
}

// Claude folds both images and files into the native prompt because its CLI has
// no image flag. On restart the native text still ends with that generated
// block; the stored attachments must win so the bubble renders the image again.
const nativeAttachmentPrompt = `看一下这个设置页的截图${suffix([image, file])}`
const nativeHydrated = hydrateSubmittedUserMessages(
  [userEvent(nativeAttachmentPrompt)],
  [snapshot('看一下这个设置页的截图', [image, file])]
)
assert.equal(
  nativeHydrated[0].payload.text,
  '看一下这个设置页的截图',
  'the duplicated attachment block is removed from the visible prompt'
)
assert.deepEqual(nativeHydrated[0].payload.attachments, [image, file], 'the image and file re-attach after restart')
assert.doesNotMatch(JSON.stringify(nativeHydrated[0].payload), /附件:/, 'the path block never reaches the rendered bubble')

// An image-only turn sends an empty prompt plus the attachment block.
const imageOnly = hydrateSubmittedUserMessages(
  [userEvent(`\n\n附件:\n- ${image.path}`)],
  [snapshot('', [image])]
)
assert.equal(imageOnly[0].payload.text, '', 'an image-only turn restores an empty prompt')
assert.deepEqual(imageOnly[0].payload.attachments, [image], 'an image-only turn restores its image')

// Personal-assistant sessions prepend host context to the same native prompt.
const assistantText = '看一下这个设置页的截图'
const assistantHydrated = hydrateSubmittedUserMessages(
  [userEvent(`[uniagent_personal_assistant_context]\n\n当前用户输入：\n${assistantText}${suffix([image])}`)],
  [snapshot(assistantText, [image], { assistantText })]
)
assert.equal(assistantHydrated[0].payload.text, assistantText, 'assistant context and the attachment block are both removed')
assert.deepEqual(assistantHydrated[0].payload.attachments, [image], 'an assistant turn re-attaches its image')

// Ordinary sessions also receive host context, without an assistantText snapshot.
// Cover Codex's separate attachments and Claude's generated path suffix.
const requirementPrefix = '[uniagent_requirement_context]\n需求资料\n\n当前用户输入：\n'
const globalMemoryPrefix = '[uniagent_global_memory_context]\n全局记忆\n\n当前用户输入：\n'
for (const prefix of [requirementPrefix, globalMemoryPrefix, globalMemoryPrefix + requirementPrefix]) {
  for (const text of ['这里的复制图片是假的，无法复制', '']) {
    for (const attachmentSuffix of ['', suffix([image, file])]) {
      const event = userEvent(`${prefix}${text}${attachmentSuffix}`)
      const restored = hydrateSubmittedUserMessages([event], [snapshot(text, [image, file])])
      assert.deepEqual(restored[0].payload.attachments, [image, file],
        'ordinary sessions restore images and files after matching the visible input')
      assert.equal(event.payload.attachments, undefined, 'hydration does not mutate the native event')
    }
  }
}

// Context stripping must not bypass the message identity checks or rewrite a
// native message when its local submission record cannot be matched.
const contextualEvent = userEvent(`${globalMemoryPrefix}${requirementPrefix}原始消息`)
for (const submitted of [
  [],
  [snapshot('不同的消息', [image])],
  [snapshot('原始消息', [image], { userOrdinal: 1 })],
  [snapshot('原始消息', [image], { type: 'goal_message' })]
]) {
  assert.deepEqual(hydrateSubmittedUserMessages([contextualEvent], submitted), [contextualEvent],
    'a missing snapshot or mismatched text, ordinal or message type never restores attachments')
}

// A prompt that merely looks like the generated block is not rewritten when the
// snapshot has no attachments to justify stripping it.
const literal = `说明${suffix([image])}`
const literalHydrated = hydrateSubmittedUserMessages([userEvent(literal)], [snapshot(literal)])
assert.equal(literalHydrated[0].payload.text, literal, 'user-authored text is preserved without attachments')
assert.equal(literalHydrated[0].payload.attachments, undefined)

// Visible-text mismatch still refuses to graft attachments onto another turn.
const mismatched = hydrateSubmittedUserMessages(
  [userEvent(nativeAttachmentPrompt)],
  [snapshot('完全不同的消息', [image])]
)
assert.equal(mismatched[0].payload.attachments, undefined, 'a hash mismatch never attaches a different message')
assert.equal(mismatched[0].payload.text, nativeAttachmentPrompt, 'a hash mismatch leaves the native text untouched')

const root = await mkdtemp(join(tmpdir(), 'ua-display-text-'))
try {
  const wire = 'Router 附加指令及空请求数据'
  const bubble = { displayText: '', comments: [{ quote: '原文', comment: '检查截图' }] }
  const queued = buildDurableQueueItem(wire, [image], undefined, 1, bubble)
  assert.equal(queued.displayText, '', 'image-only display text must survive the initial queue boundary')
  const store = new SessionStore(join(root, 'sessions.json'))
  store.saveOrThrow([{ id: 'display', title: '输入展示', status: 'idle', createdAt: 1, config: { agentId: 'fixture', workdir: root }, pendingQueue: [queued] }])
  assert.equal(store.load()[0].pendingQueue?.[0].displayText, '', 'queue reload must preserve the explicit empty display text')
  assert.deepEqual(store.load()[0].pendingQueue?.[0].comments, bubble.comments, 'structured comments stay with their original input')
  const host = new Orchestrator(() => undefined, store)
  host.loadPersisted()
  try {
    const row = host.getSessionById('display')!
    ;(host as any).record(row.id, { type: 'user_message', payload: { text: wire, ...bubble, attachments: [image] } })
    assert.equal(row.submittedUserMessages?.[0].displayText, '', 'submission snapshots must retain explicit empty user input')
    const saved = store.load()[0].submittedUserMessages
    assert.equal(saved?.[0].displayText, '', 'native-history reload must retain display text in the local snapshot')
    const restored = hydrateSubmittedUserMessages([userEvent(wire)], saved)
    assert.equal(restored[0].payload.displayText, '')
    assert.equal(restored[0].payload.text, wire, 'restoring the display must not change the actual prompt')
    assert.deepEqual(restored[0].payload.attachments, [image])
    assert.deepEqual(restored[0].payload.comments, bubble.comments)
    host.editQueueItem(row.id, queued.id, wire, [image], undefined, bubble)
    assert.equal(host.getQueue(row.id)[0].displayText, '', 'editing an image-only item retains the explicit empty original input')
    host.editQueueItem(row.id, queued.id, '用户自行编辑')
    assert.equal(host.getQueue(row.id)[0].displayText, undefined, 'a normal edit clears the previous original-input override')
    assert.equal(host.getQueue(row.id)[0].comments, undefined)
  } finally { host.disposeAll() }
} finally { await rm(root, { recursive: true, force: true }) }

console.log('submitted user message hydration and display-text persistence: ok')
