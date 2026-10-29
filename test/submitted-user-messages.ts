import assert from 'node:assert/strict'
import { hydrateSubmittedUserMessages, submittedTextHash } from '../src/main/submittedUserMessages.ts'
import type { Attachment, SubmittedUserMessage, UAEvent } from '../src/shared/types.ts'

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

console.log('submitted user message hydration: ok')
