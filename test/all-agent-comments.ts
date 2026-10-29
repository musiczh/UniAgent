import assert from 'node:assert/strict'
import { buildComposerDelivery } from '../src/renderer/components/Composer.tsx'
import type { AgentDef } from '../src/shared/types.ts'
import { renderEventStream } from './regression/render-event-stream.mjs'

type CommentDeliveryBuilder = (
  command: null,
  text: string,
  attachments: [],
  candidateIds: [],
  comments: Array<{ quote: string; comment: string }>,
  provider: AgentDef['adapter']
) => ReturnType<typeof buildComposerDelivery>

const buildForProvider = buildComposerDelivery as CommentDeliveryBuilder
const comment = [{ quote: '  shared answer  ', comment: '  clarify this  ' }]

for (const provider of ['codex', 'traex'] as const) {
  const delivery = buildForProvider(null, 'Apply it', [], [], comment, provider)
  assert.match(delivery?.prompt || '', /# Response annotations:/)
  assert.match(delivery?.prompt || '', /:codex-annotation\{index="N"\}/)
  assert.match(delivery?.prompt || '', /\{"text":"shared answer","annotation":"clarify this"\}/)
}

for (const provider of ['zcode', 'deepseek', 'claude', 'kimi', 'grok'] as const) {
  const delivery = buildForProvider(null, 'Apply it', [], [], comment, provider)
  assert.equal(
    delivery?.prompt,
    '\n# Response comments:\nEach item quotes text selected from an earlier agent response and may include a user comment. Use every selection as context and address every comment.\n<response-comments>\n[{"quote":"shared answer","comment":"clarify this"}]\n</response-comments>\n\n## My request:\nApply it\n',
    `${provider} must receive comments as a provider-neutral prompt`
  )
  assert.doesNotMatch(delivery?.prompt || '', /Codex|codex-annotation|response-annotations/)
  assert.deepEqual(delivery?.comments, comment, 'the sent bubble keeps the original selected quote and comment')
}

const selectionActions = `{
  annotations: [],
  onComment: value => { window.__capturedComment = value },
  onUpdateComment: () => {},
  onRemoveComment: () => {},
  onEditComment: () => {},
  onEditRequestHandled: () => {}
}`
const selectionUi = await renderEventStream([
  { sessionId: 'all-agent-comments', seq: 1, ts: 1, type: 'user_message', payload: { text: 'Question' } },
  { sessionId: 'all-agent-comments', seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { text: 'Shared answer', phase: 'final_answer' } },
  { sessionId: 'all-agent-comments', seq: 3, ts: 3, type: 'turn_completed', state: 'success', payload: {} },
], 'idle', 'all-agent-comments', {
  setup: `window.__eventStreamProps = { selection: ${selectionActions} };`,
  inspect: `(async () => {
    const text = document.querySelector('.agent-msg .agent-md').firstChild;
    const range = document.createRange();
    range.selectNodeContents(text);
    const nativeSelection = window.getSelection();
    nativeSelection.removeAllRanges();
    nativeSelection.addRange(range);
    text.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    const actions = [...document.querySelectorAll('.sel-pop .sel-btn')].map(button => button.textContent.trim());
    document.querySelector('.sel-pop .sel-btn')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const textarea = document.querySelector('.sel-cmt-ta');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, 'clarify this');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.sel-cmt-primary')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    return { actions, comment: window.__capturedComment };
  })()`
})

assert.deepEqual(selectionUi.actions, ['评论'], 'an agent without branch callbacks exposes only the shared comment action')
assert.deepEqual(
  selectionUi.comment,
  { seq: 2, start: 0, end: 13, quote: 'Shared answer', comment: 'clarify this' },
  'the shared comment action must capture and submit the selected reply text'
)

const codexUi = await renderEventStream([
  { sessionId: 'codex-comments', seq: 1, ts: 1, type: 'agent_message', state: 'success', payload: { text: 'Codex answer', phase: 'final_answer' } },
  { sessionId: 'codex-comments', seq: 2, ts: 2, type: 'turn_completed', state: 'success', payload: {} },
], 'idle', 'codex-comments', {
  setup: `window.__eventStreamProps = { selection: {
    ...${selectionActions},
    onDetail: () => {},
    onSide: () => {}
  } };`,
  inspect: `(async () => {
    const text = document.querySelector('.agent-msg .agent-md').firstChild;
    const range = document.createRange(); range.selectNodeContents(text);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    text.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return [...document.querySelectorAll('.sel-pop .sel-btn')].map(button => button.textContent.trim());
  })()`
})

assert.deepEqual(codexUi, ['评论', '解释', '侧边聊天'], 'Codex and TraeX retain all existing selection actions')
console.log('all agent comments: neutral prompts and capability-scoped selection actions passed')
