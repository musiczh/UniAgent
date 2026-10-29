import assert from 'node:assert/strict'
import { asyncQuestionReply, asInteractionRequest } from '../src/shared/interactionRequests'
import { appendFeishuContext } from '../src/shared/feishuContext'
import type { UAEvent } from '../src/shared/types'
import { renderEventStream } from './regression/render-event-stream.mjs'

const sessionId = 'quiet-cards'
const event = (seq: number, type: UAEvent['type'], payload: UAEvent['payload'], state: UAEvent['state'] = 'success'): UAEvent =>
  ({ sessionId, seq, ts: seq * 1_000, type, payload, state })
const questionPrompt = '需要核对哪个版本？'.repeat(12) + '\n请保留完整版本说明。'
const appendText = '补充：保留完整记录\n' + '完整执行证据与来源说明。'.repeat(24)
const question = event(3, 'agent_message', {
  id: 'scope', delivery: 'async', questions: [{ id: 'scope', question: questionPrompt }],
  submittedAnswer: { answers: { scope: { answers: ['当前版本'] } } },
})
const events = [
  event(0, 'user_message', { text: '核对版本' }),
  event(1, 'turn_started', {}),
  event(2, 'command_exec', { command: 'git status --short' }), question,
  event(4, 'user_message', { text: asyncQuestionReply(asInteractionRequest(question), question.payload.submittedAnswer), appendedToTurn: true, asyncQuestion: true }),
  event(5, 'user_message', {
    text: '发给模型的原始内容', displayText: appendText, appendedToTurn: true,
    comments: [{ quote: '原始结论', comment: '请保留来源' }],
    attachments: [{ kind: 'file', path: '/fixture/evidence.txt', name: '证据.txt' }],
  }),
  event(6, 'error', { message: '连接断开', detail: 'Connection closed while waiting for a response.' }, 'failed'),
  event(7, 'agent_message', { id: 'final', text: '核对完成', phase: 'final_answer' }),
  event(8, 'turn_completed', {}),
]

const result = await renderEventStream(events, 'completed', sessionId, {
  setup: `
    import { ApprovalCard, LaunchNotice, QuestionForm } from './src/renderer/components/EventStream';
    import { ModelSwitchCard } from './src/renderer/components/ModelSwitchCard';
    import { TeamAssignmentCard } from './src/renderer/components/TeamAssignmentCard';
    import { TeamEventCard } from './src/renderer/components/TeamEventCard';
    const fixtures = document.createElement('div'); fixtures.id = 'card-fixtures';
    document.body.append(fixtures);
    Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text=>{window.__copied=text}}});
    window.__cardResponses = [];
    const permission = id => ({sessionId:'fixture',seq:1,ts:1,type:'approval_request',state:'pending',payload:{requestId:id,kind:'command',method:'execCommandApproval',params:{command:'git status --short'}}});
    const switchEvent = state => ({sessionId:'fixture',seq:1,ts:1,type:'model_switch',state,payload:{fromLabel:'Old model',toLabel:'New model',compacted:true,step:'apply',startedAt:1000,endedAt:3200,error:'保留原模型',hints:['original hint']}});
    createRoot(fixtures).render(React.createElement(React.Fragment, null,
      ...['accept','session','decline'].map(action => React.createElement('div',{id:'permission-'+action,key:action,className:'interaction-dock'},React.createElement(ApprovalCard,{ev:permission(action),onRespond:async(id,answer)=>window.__cardResponses.push({id,answer})}))),
      React.createElement('div',{className:'event-stream'},
      ...['skip','expired','cancelled'].map(state=>React.createElement('div',{id:'readonly-'+state,key:state},React.createElement(ApprovalCard,{readOnly:true,ev:{sessionId:'fixture',seq:1,ts:1,type:'approval_request',state:state==='skip'?'success':'cancelled',payload:{requestId:state,kind:'question',delivery:'async',params:{questions:[{id:'scope',prompt:'这组提问如何处理？',options:[]}]},submittedAnswer:state==='skip'?{action:'skip'}:undefined,interactionExpired:state==='expired'}}}))),
      ...['success','running','failed'].map(state => React.createElement(ModelSwitchCard,{key:state,ev:switchEvent(state)})),
      React.createElement(LaunchNotice,{event:{sessionId:'fixture',seq:1,ts:1,type:'system_notice',state:'success',payload:{label:'Codex',model:'test-model',sandbox:'read-only',text:'启动: codex app-server'}},warnings:[{payload:{text:'test warning'}}]}),
      React.createElement(TeamAssignmentCard,{parsed:{kind:'parsed',raw:'',footer:'',payload:{title:'核对版本',goal:'保留证据',expectedOutput:'核对结果',permissionMode:'read-only'}},context:{sender:'Leader',recipient:'Codex',statusByAssignmentKey:{}}}),
      React.createElement(TeamEventCard,{parsed:{kind:'parsed',payload:{events:[{kind:'progress',summary:'版本核对完成',state:'consumed'}]}}}),
      React.createElement('div',{id:'multi-readonly'},React.createElement(QuestionForm,{kind:'question',readOnly:true,params:{questions:[{id:'first',prompt:'是否保留说明？',options:[{label:'保留',description:'选项说明仍可阅读'},{label:'取消',description:'另一项说明'}]},{id:'second',prompt:'补充说明',options:[]}]},answer:{answers:{first:{answers:['保留']},second:{answers:['LongAnswer'.repeat(24)+'\\n第二行回答']}}}})),
      React.createElement('div',{id:'secret-readonly'},React.createElement(QuestionForm,{kind:'elicitation',readOnly:true,params:{requestedSchema:{type:'object',properties:{key:{type:'string',format:'password',title:'密钥'}}}},answer:{action:'accept',content:{key:'secret-fixture'}}}))
      )
    ));
  `,
  inspect: `(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve,220));
    document.documentElement.style.height='auto'; document.documentElement.style.overflow='visible';
    document.body.style.height='auto'; document.body.style.overflow='visible';
    document.querySelector('#root').style.cssText='height:auto;overflow:visible;width:640px';
    document.querySelector('#card-fixtures').style.cssText='width:640px;height:auto;overflow:visible';
    for (let pass=0;pass<3;pass++) {
      for (const node of document.querySelectorAll('.processed-fold.closed > .processed-head, .steps-fold-row[aria-expanded=false], .process-step-meta[aria-expanded=false]')) node.click();
      await wait();
    }
    const root=document.querySelector('#root');
    const append=[...root.querySelectorAll('.user-append-step')].map(row=>{
      const node=row.querySelector('.user-append-node'); const rect=node.getBoundingClientRect();
      const ancestors=[]; for(let parent=node.parentElement;parent;parent=parent.parentElement) {
        if (['hidden','clip'].includes(getComputedStyle(parent).overflowX)) ancestors.push(parent.getBoundingClientRect());
      }
      return {title:row.querySelector('.user-append-head').textContent,inside:rect.left>=row.getBoundingClientRect().left && ancestors.every(bound=>rect.left>=bound.left && rect.right<=bound.right),background:getComputedStyle(row.querySelector('.user-append-card')).backgroundColor,border:getComputedStyle(row.querySelector('.user-append-card')).borderTopWidth};
    });
    const reply=root.querySelector('.async-question-reply');
    const replyHead=reply.querySelector('.user-append-head');
    const replyBody=reply.querySelector('.user-append-body');
    const preview=reply.querySelector('.async-reply-preview');
    const replyInitial={collapsed:reply instanceof HTMLDetailsElement && !reply.open,bodyVisible:replyBody.checkVisibility(),preview:preview?.textContent};
    reply.querySelector('.message-action.copy').click();await wait();
    const replyCopy={text:window.__copied,collapsed:reply instanceof HTMLDetailsElement && !reply.open};
    replyHead.click();await wait();
    const replyExpanded={open:reply.open===true,bodyVisible:replyBody.checkVisibility(),previewVisible:preview?.checkVisibility(),question:reply.querySelector('.async-reply-question > div').textContent,answer:reply.querySelector('.async-reply-answer > div').textContent};
    const replyLabels=[...reply.querySelectorAll('.async-reply-question-label,.async-reply-answer-label')].map(node=>node.textContent);
    replyBody.click();await wait();
    const located=!!root.querySelector('.interaction-timeline.highlighted');
    const hasLocate=reply.textContent.includes('定位到原提问') || reply.querySelector('[role=link],[title="定位到原提问"]')!==null;
    replyHead.click();await wait();
    root.style.width='320px';await wait();
    const replyCollapsed={closed:reply.open===false,bodyVisible:replyBody.checkVisibility(),previewVisible:preview?.checkVisibility(),nowrap:preview && getComputedStyle(preview).whiteSpace,ellipsis:preview && getComputedStyle(preview).textOverflow,truncated:preview && preview.scrollWidth>preview.clientWidth,singleLine:preview && preview.getBoundingClientRect().height<=replyHead.getBoundingClientRect().height,fits:replyHead.scrollWidth<=replyHead.clientWidth+1};
    root.style.width='640px';await wait();
    const normalAppend=[...root.querySelectorAll('.user-append-card')].find(card=>!card.classList.contains('async-question-reply'));
    const normalHead=normalAppend.querySelector('.user-append-head');
    const normalBody=normalAppend.querySelector('.user-append-body');
    const normalPreview=normalAppend.querySelector('.user-append-preview');
    const normal={visible:normalBody.checkVisibility(),text:normalAppend.querySelector('.user-append-text').textContent,foldable:normalAppend instanceof HTMLDetailsElement,closed:normalAppend.open===false,preview:normalPreview?.textContent};
    normalAppend.querySelector('.message-action.copy').click();await wait();
    const normalCopy={text:window.__copied,closed:normalAppend.open===false};
    normalHead.click();await wait();
    const normalExpanded={open:normalAppend.open===true,visible:normalBody.checkVisibility(),previewVisible:normalPreview?.checkVisibility(),quote:normalAppend.querySelector('.bubble-comment-quote')?.textContent,comment:normalAppend.querySelector('.bubble-comment-note')?.textContent,attachment:normalAppend.querySelector('.bubble-attach')?.textContent.trim()};
    normalHead.click();await wait();root.style.width='320px';await wait();
    const normalCollapsed={closed:normalAppend.open===false,visible:normalBody.checkVisibility(),previewVisible:normalPreview?.checkVisibility(),truncated:normalPreview && normalPreview.scrollWidth>normalPreview.clientWidth,nowrap:normalPreview && getComputedStyle(normalPreview).whiteSpace,fits:normalHead.scrollWidth<=normalHead.clientWidth+1};
    root.style.width='640px';await wait();
    const questionNode=root.querySelector('.interaction-node svg');
    const details=root.querySelector('.interaction-link'); details?.click(); await wait();
    const questionDetails=root.querySelector('.readonly-approval')?.textContent;
    const detail=root.querySelector('.readonly-approval');
    const detailHead=detail?.querySelector('.card-head');
    const readonlyAnswer=detail?.querySelector('.question-readonly-answer');
    const detailPresentation={headerVisible:!!detailHead && getComputedStyle(detailHead).display!=='none',summary:detail.closest('.interaction-timeline').querySelector('.interaction-summary').textContent,background:getComputedStyle(detail).backgroundColor,answerBackground:getComputedStyle(readonlyAnswer).backgroundColor,answerBorder:getComputedStyle(readonlyAnswer).borderTopWidth,labels:[...detail.querySelectorAll('.question-detail-label')].map(node=>node.textContent)};
    const multi=document.querySelector('#multi-readonly'); multi.style.width='280px';
    const multiple={answers:[...multi.querySelectorAll('.question-readonly-answer')].map(node=>node.textContent),description:multi.textContent.includes('选项说明仍可阅读'),selected:!!multi.querySelector('.question-opt.checked .ui-icon-check'),fits:[...multi.querySelectorAll('.question-prompt,.question-readonly-row')].every(node=>node.scrollWidth<=node.clientWidth+1),controls:multi.querySelectorAll('input,textarea,button').length};
    const secret=document.querySelector('#secret-readonly').textContent;
    const outcomes={};
    for(const state of ['skip','expired','cancelled']) {
      const fixture=document.querySelector('#readonly-'+state);fixture.querySelector('.interaction-link').click();await wait();
      const detail=fixture.querySelector('.readonly-approval');
      outcomes[state]={state:fixture.querySelector('.interaction-state').textContent,answer:detail.querySelector('.question-readonly-answer').textContent,background:getComputedStyle(detail).backgroundColor,controls:detail.querySelectorAll('input,textarea,button').length};
    }
    const errorDetails=root.querySelector('.error-details');
    const errorBefore=errorDetails?.open; errorDetails?.querySelector('summary')?.click();
    const errorAfter=errorDetails?.open;
    const complete=document.querySelector('.ms-card.state-success');
    const process=complete.querySelector('.ms-process');
    const processBefore=process?.open; process?.querySelector('summary')?.click();
    const processAfter=process?.open;
    const runningVisible=[...document.querySelectorAll('.ms-card.state-running .ms-step')].every(node=>node.getBoundingClientRect().height>0);
    const launch=document.querySelector('.launch-card'); launch.querySelector('.launch-head').click(); await wait();
    const borders=Object.fromEntries(['.interaction-timeline','.ms-card','.launch-card','.team-assignment','.team-event-card','.team-event-item'].map(selector=>[selector,getComputedStyle(document.querySelector(selector)).borderTopWidth]));
    const modelPresentation=[...document.querySelectorAll('.ms-card')].map(node=>({background:getComputedStyle(node).backgroundColor,border:getComputedStyle(node).borderTopWidth}));
    const palette=[...document.querySelectorAll('#permission-accept .appr-btn')].map(button=>({text:button.textContent.trim(),background:getComputedStyle(button).backgroundColor,height:button.getBoundingClientRect().height}));
    const icons=[...document.querySelectorAll('.event-stream svg,.interaction-dock svg')].filter(node=>node.getBoundingClientRect().width>0 && !node.closest('.user-msg,.agent-msg'));
    const tooLarge=icons.filter(node=>node.getBoundingClientRect().width>parseFloat(getComputedStyle(node).fontSize)+.5).map(node=>node.outerHTML.slice(0,120));
    for (const [id,index] of [['accept',0],['session',1],['decline',2]]) {document.querySelectorAll('#permission-'+id+' .appr-btn')[index].click();await wait();}
    return {append,replyInitial,replyCopy,replyExpanded,replyCollapsed,located,hasLocate,normal,normalCopy,normalExpanded,normalCollapsed,replyLabels,questionIcon:questionNode?.getAttribute('class'),questionDetails,detailPresentation,multiple,secret,outcomes,errorBefore,errorAfter,errorText:errorDetails?.textContent,processBefore,processAfter,processText:process?.textContent,runningVisible,failedText:document.querySelector('.ms-card.state-failed')?.textContent,launchText:launch.textContent,borders,modelPresentation,palette,tooLarge,responses:window.__cardResponses};
  })()`,
})

assert.equal(result.append.length, 2)
assert.ok(result.append.every(row => row.inside), '追加图标须完整位于行与折叠容器内，不能因负外边距被裁切')
assert.ok(result.append.every(row => !row.title.includes('继续当前任务')))
assert.ok(result.append.every(row => row.background === 'rgba(0, 0, 0, 0)' && row.border === '0px'))
assert.deepEqual(result.replyInitial, { collapsed: true, bodyVisible: false, preview: questionPrompt.replace(/\s+/g, ' ') }, '异步回答默认折叠，行内摘要来自问题')
assert.equal(result.replyCopy.collapsed, true, '复制按钮不切换折叠状态')
assert.equal(result.replyCopy.text, events[4].payload.text, '折叠时仍可复制完整回答消息')
assert.deepEqual(result.replyExpanded, { open: true, bodyVisible: true, previewVisible: false, question: questionPrompt, answer: '当前版本' }, '展开显示完整问答，隐藏行内重复问题')
assert.deepEqual(result.replyCollapsed, { closed: true, bodyVisible: false, previewVisible: true, nowrap: 'nowrap', ellipsis: 'ellipsis', truncated: true, singleLine: true, fits: true }, '再次点击收起，窄列中的问题摘要保持单行省略且不挤出行宽')
assert.equal(result.located, false, '展开及点击回答正文不再定位到原提问')
assert.equal(result.hasLocate, false, '回答项不再提供定位入口')
assert.deepEqual(result.normal, { visible: false, text: appendText, foldable: true, closed: true, preview: appendText.replace(/\s+/g, ' ') }, '普通追加消息默认收起，摘要来自实际展示内容')
assert.deepEqual(result.normalCopy, { text: appendText + '\n\n> 原始结论\n请保留来源', closed: true }, '折叠时复制完整正文和评论，不切换展开状态')
assert.deepEqual(result.normalExpanded, { open: true, visible: true, previewVisible: false, quote: '原始结论', comment: '请保留来源', attachment: '📎 证据.txt' }, '展开后完整显示正文、评论和附件，隐藏重复摘要')
assert.deepEqual(result.normalCollapsed, { closed: true, visible: false, previewVisible: true, truncated: true, nowrap: 'nowrap', fits: true }, '再次收起后长摘要在窄列内省略，不挤出时间与操作')
assert.deepEqual(result.replyLabels, ['问题','回答'])
assert.ok(result.questionIcon?.includes('question'), '提问节点须使用提问图标')
assert.ok(result.questionDetails?.includes('当前版本'), '原提问详情保留已提交回答')
assert.equal(result.detailPresentation.headerVisible, false, '展开详情不重复外层的提问标题与状态')
assert.equal(result.detailPresentation.summary, '', '展开时题干只在问题行出现一次')
assert.equal(result.detailPresentation.background, 'rgba(0, 0, 0, 0)')
assert.equal(result.detailPresentation.answerBackground, 'rgba(0, 0, 0, 0)')
assert.equal(result.detailPresentation.answerBorder, '0px', '只读回答不能呈现为输入框')
assert.deepEqual(result.detailPresentation.labels, ['问题', '回答'])
assert.deepEqual(result.multiple.answers, ['保留', 'LongAnswer'.repeat(24) + '\n第二行回答'])
assert.equal(result.multiple.description, false, '回答记录不显示选项说明')
assert.equal(result.multiple.selected, false, '回答记录不重放选项和勾选标记')
assert.equal(result.multiple.fits, true, '长回答在窄列中自然换行')
assert.equal(result.multiple.controls, 0, '只读多题不出现输入与提交控件')
assert.ok(result.secret.includes('已填写') && !result.secret.includes('secret-fixture'))
assert.equal((result.secret.match(/密钥/g)||[]).length, 1, '信息补充不重复相同的标题和题干')
assert.deepEqual(result.outcomes, {
  skip: { state: '已跳过', answer: '已跳过', background: 'rgba(0, 0, 0, 0)', controls: 0 },
  expired: { state: '已失效', answer: '未回答', background: 'rgba(0, 0, 0, 0)', controls: 0 },
  cancelled: { state: '已取消', answer: '未回答', background: 'rgba(0, 0, 0, 0)', controls: 0 },
})
assert.equal(result.errorBefore, false)
assert.equal(result.errorAfter, true)
assert.ok(result.errorText?.includes('Connection closed'))
assert.equal(result.processBefore, false)
assert.equal(result.processAfter, true)
assert.ok(result.processText?.includes('应用新模型并恢复会话'))
assert.equal(result.runningVisible, true, '切换进行中不能折叠正在执行的步骤')
assert.ok(result.failedText.includes('保留原模型'))
assert.ok(result.launchText.includes('codex app-server') && result.launchText.includes('test warning'))
assert.ok(Object.entries(result.borders).filter(([selector])=>selector!=='.ms-card').every(([,border]) => border === '0px'))
assert.ok(result.modelPresentation.every(card=>card.background!=='rgba(0, 0, 0, 0)' && card.border==='1px'), '模型切换三种状态均恢复卡片背景与边界')
assert.deepEqual(result.palette.map(button => button.text), ['批准', '本会话都批准', '拒绝'])
assert.ok(result.palette.every(button => button.height <= 26), '权限审批按钮收敛到 26px')
assert.ok(result.palette.every(button => {
  const rgb = button.background.match(/[\d.]+/g).slice(0, 3).map(Number)
  return Math.max(...rgb) - Math.min(...rgb) <= 8
}), '审批按钮使用灰阶')
assert.deepEqual(result.tooLarge, [], '图标不能超过同排文字字号')
assert.deepEqual(result.responses, [
  { id: 'accept', answer: { decision: 'approved' } },
  { id: 'session', answer: { decision: 'approved_for_session' } },
  { id: 'decline', answer: { decision: 'denied' } },
])

const appendEdges = await renderEventStream([
  event(0, 'user_message', { text: '开始' }),
  event(1, 'user_message', { text: '  ', appendedToTurn: true, attachments: [{ kind: 'image', name: '设计稿.png', path: '/fixture/design.png' }] }),
  event(2, 'user_message', { text: '', appendedToTurn: true, comments: [{ quote: '原始结论', comment: '补充评论' }] }),
  event(3, 'user_message', { text: appendFeishuContext('远程追加内容'), source: 'feishu', appendedToTurn: true }),
  event(4, 'user_message', { text: '', appendedToTurn: true }),
], 'running', sessionId, { inspect: `(() => {
  const cards=[...document.querySelectorAll('.user-append-card')];
  const initial=cards.map(card=>({closed:card.open===false,preview:card.querySelector('.user-append-preview')?.textContent,hidden:!card.querySelector('.user-append-body').checkVisibility()}));
  cards[0].querySelector('summary').click();
  return {initial,image:!!cards[0].querySelector('.bubble-attachments'),remote:cards[2].querySelector('.user-append-text')?.textContent,source:!!cards[2].querySelector('.user-feishu-source')};
})()` })
assert.deepEqual(appendEdges.initial, [
  { closed: true, preview: '设计稿.png', hidden: true },
  { closed: true, preview: '补充评论', hidden: true },
  { closed: true, preview: '远程追加内容', hidden: true },
  { closed: true, preview: '', hidden: true },
], '无正文时用附件或评论提供摘要，远程消息不把上下文后缀带进摘要，空消息可正常折叠')
assert.equal(appendEdges.image, true, '展开仅图片的消息仍保留附件区域')
assert.equal(appendEdges.remote, '远程追加内容')
assert.equal(appendEdges.source, true)
console.log('conversation cards: unclipped nodes, compact neutral controls, disclosures and permission semantics verified')
