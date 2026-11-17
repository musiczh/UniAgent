import assert from 'node:assert/strict'
import { buildComposerDelivery, dispatchComposerDelivery } from '../src/renderer/components/Composer.tsx'
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

for (const provider of ['zcode', 'deepseek', 'claude', 'kimi', 'grok', 'mcode', 'qoder', 'nika'] as const) {
  const delivery = buildForProvider(null, 'Apply it', [], [], comment, provider)
  assert.equal(
    delivery?.prompt,
    '\n# Response comments:\n以下各项包含引用原文及可选评论；结合所有引用逐项回应评论。\n<response-comments>\n[{"quote":"shared answer","comment":"clarify this"}]\n</response-comments>\n\n## My request:\nApply it\n',
    `${provider} must receive comments as a provider-neutral prompt`
  )
  assert.doesNotMatch(delivery?.prompt || '', /Codex|codex-annotation|response-annotations/)
  assert.deepEqual(delivery?.comments, comment, 'the sent bubble keeps the original selected quote and comment')
}

for (const provider of ['codex', 'traex', 'zcode', 'deepseek', 'claude', 'kimi', 'grok', 'mcode', 'qoder', 'nika'] as const) {
  const instruction = provider === 'codex' || provider === 'traex' ? '以下各项包含引用原文及可选批注' : '以下各项包含引用原文及可选评论'
  const delivery = buildForProvider(null, 'Apply it', [], [], comment, provider)!
  for (const force of [false, true]) {
    const submitted: unknown[][] = []
    await dispatchComposerDelivery(delivery, force, {
      runNativeAction: () => { throw new Error('comments cannot become a native action') },
      send: (...args) => { assert.equal(force, false); submitted.push(args) },
      forceSend: (...args) => { assert.equal(force, true); submitted.push(args) }
    })
    assert.equal(submitted.length, 1)
    const [prompt, , , fourth, fifth] = submitted[0]
    assert.equal(prompt, delivery.prompt)
    assert.equal(String(prompt).split(instruction).length, 2, `${provider} sends the comment instruction exactly once`)
    assert.deepEqual(force ? fourth : fifth, { comments: comment, displayText: 'Apply it' }, 'comment instructions stay out of the displayed bubble')
  }
  assert.equal(buildForProvider(null, '普通消息', [], [], [], provider)?.prompt, '普通消息', 'ordinary messages do not acquire comment instructions')
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
    const text = document.querySelector('.agent-msg .agent-md p');
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
    const text = document.querySelector('.agent-msg .agent-md p');
    const range = document.createRange(); range.selectNodeContents(text);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    text.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return [...document.querySelectorAll('.sel-pop .sel-btn')].map(button => button.textContent.trim());
  })()`
})

assert.deepEqual(codexUi, ['评论', '解释', '侧边聊天'], 'Codex and TraeX retain all existing selection actions')

const initialSelection = await renderEventStream([], 'idle', 'initial-selection', {
  setup: `
    function ImmediateSelection() {
      React.useLayoutEffect(() => {
        const text = document.querySelector('#initial-selection-fixture .agent-md p');
        const range = document.createRange(); range.selectNodeContents(text);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        text.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
      }, []);
      return React.createElement(EventStream, {
        events:[{sessionId:'initial-selection',seq:1,ts:1,type:'agent_message',state:'success',payload:{text:'First visible reply',phase:'final_answer'}}],
        status:'idle',sessionId:'initial-selection',selection:{
          ...${selectionActions},onDetail:value=>{window.initialSelection=value}
        }
      });
    }
    const host=document.body.appendChild(document.createElement('div'));host.id='initial-selection-fixture';
    createRoot(host).render(React.createElement(ImmediateSelection));
  `,
  inspect: `(async()=>{
    for(let i=0;i<100&&!document.querySelector('.sel-pop');i++)await new Promise(resolve=>setTimeout(resolve,10));
    const actions=[...document.querySelectorAll('.sel-pop .sel-btn')];
    actions.find(button=>button.textContent.includes('解释'))?.click();
    return {actions:actions.map(button=>button.textContent.trim()),selection:{quote:window.initialSelection?.quote,selectedMessageText:window.initialSelection?.selectedMessageText}};
  })()`
})
assert.deepEqual(initialSelection.actions, ['评论', '解释'], 'the first visible reply must accept selection before passive effects run')
assert.equal(initialSelection.selection.quote, 'First visible reply')
assert.equal(initialSelection.selection.selectedMessageText, 'First visible reply\n')
console.log('all agent comments: neutral prompts and capability-scoped selection actions passed')
