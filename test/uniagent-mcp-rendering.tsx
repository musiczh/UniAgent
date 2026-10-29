import assert from 'node:assert/strict'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../src/renderer/components/EventStream.tsx'
import { handoffTaskAction } from '../src/shared/handoffEvents.ts'
import type { UAEvent } from '../src/shared/types.ts'
import { renderEventStream } from './regression/render-event-stream.mjs'

const originalId = '53f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e'
const nextId = '63f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e'
function render(name: string, input: object, result: unknown, options: {
  state?: UAEvent['state']
  waitingForHandoff?: ComponentProps<typeof EventStream>['waitingForHandoff']
} = {}): string {
  const events: UAEvent[] = [
    { sessionId: 'caller', seq: 0, ts: 1000, type: 'user_message', payload: { text: '执行任务' } },
    { sessionId: 'caller', seq: 1, ts: 1001, type: 'tool_call', state: options.state ?? 'success',
      payload: { id: 'call', provider: 'mcp', server: 'uniagent', name, input, result } }
  ]
  return renderToStaticMarkup(createElement(EventStream, {
    sessionId: 'caller', status: 'running', events,
    handoffSessionTargets: { [originalId]: { sessionId: 'target', roleName: '审查员', agentName: 'Codex' } },
    onJumpToSession: () => {},
    waitingForHandoff: options.waitingForHandoff
  }))
}

for (const current of [true, false]) {
  const create = render(current ? 'uniagent_task' : 'create_uniagent_task',
    { ...(current ? { action: 'create' } : {}), role: 'internal-role', prompt: '只读审查' },
    `taskId=${originalId}\n\n[uniagent:event=started]`)
  assert.match(create, /跨agent调用[\s\S]*审查员[\s\S]*（Codex）[\s\S]*派发任务/)
  assert.match(create, /点击跳转到该任务会话/)
  assert.doesNotMatch(create, /internal-role/)

  const followup = render(current ? 'uniagent_task' : 'create_uniagent_task',
    { ...(current ? { action: 'followup', taskId: originalId } : { followupTaskId: originalId }), prompt: '继续检查' },
    `taskId=${nextId}\n\n[uniagent:event=delivered]`)
  assert.match(followup, /审查员[\s\S]*（Codex）[\s\S]*追加消息/)
  assert.match(followup, /点击跳转到该任务会话/, 'a new followup taskId must resolve to its original session')

  const forced = render(current ? 'uniagent_task' : 'create_uniagent_task',
    { ...(current ? { action: 'followup', taskId: originalId } : { followupTaskId: originalId }), prompt: '立即收尾', force: true },
    `taskId=${originalId}\n\n[uniagent:event=force-delivered]`)
  assert.match(forced, /强制追加/)

  for (const [status, label] of [['completed', '任务结束'], ['failed', '任务异常'], ['stopped', '任务中止']]) {
    const ended = render(current ? 'uniagent_task' : 'get_uniagent_task',
      { ...(current ? { action: 'get', wait: true } : {}), taskId: originalId },
      JSON.stringify({ taskId: originalId, status, done: true, latestReply: '查询的最终结果' }))
    assert.match(ended, new RegExp(label))
    assert.doesNotMatch(ended, /已开始|已送达|已完成|已中止/)
    assert.match(ended, /查询的最终结果/)
  }
  const running = render(current ? 'uniagent_task' : 'get_uniagent_task',
    { ...(current ? { action: 'get' } : {}), taskId: originalId },
    JSON.stringify({ taskId: originalId, status: 'running', done: false }))
  assert.doesNotMatch(running, /process-handoff-end/)
  const stopped = render(current ? 'uniagent_task' : 'stop_uniagent_task',
    { ...(current ? { action: 'stop' } : {}), taskId: originalId },
    `taskId=${originalId}\n\n已停止\n\n[uniagent:terminal=stopped]`)
  assert.match(stopped, /任务中止/)
  assert.match(stopped, /由 MCP 中止/)
}
assert.equal(handoffTaskAction({ payload: { name: 'uniagent_query', input: { action: 'get' } } }), undefined)
assert.equal(handoffTaskAction({ payload: { name: 'uniagent_task', input: { action: 'unknown' } } }), undefined)

const waitingForHandoff = { handoffId: nextId, awaitedSessionId: 'target', agentId: 'codex', agentName: 'Codex', label: '同步追加的需求' }
for (const current of [true, false]) {
  const name = current ? 'uniagent_task' : 'create_uniagent_task'
  const input = { ...(current ? { action: 'followup', taskId: originalId } : { followupTaskId: originalId }), prompt: '同步追加的需求', wait: true }
  for (const state of ['running', 'pending'] as const) {
    const create = render(name, { ...(current ? { action: 'create' } : {}), role: 'internal-role', prompt: '同步派发的需求', wait: true }, undefined, {
      state, waitingForHandoff: { ...waitingForHandoff, handoffId: originalId },
    })
    assert.match(create, /审查员[\s\S]*（Codex）[\s\S]*派发任务/, '同步新建任务继续使用已确认的卡片')
    const waiting = render(name, input, undefined, { state, waitingForHandoff })
    assert.equal((waiting.match(/class="hx"/g) || []).length, 1, '同步追加在运行或待处理时立即复用一张跨 Agent 卡片')
    assert.match(waiting, /审查员[\s\S]*（Codex）[\s\S]*追加消息/)
    assert.match(waiting, /同步追加的需求/)
    assert.doesNotMatch(waiting, /step-call-name[^>]*>uniagent/, '卡片替代普通工具调用行')
  }
  const unconfirmed = render(name, input, undefined, { state: 'running' })
  assert.doesNotMatch(unconfirmed, /class="hx"/, '没有实际目标会话的等待确认时不伪造追加卡片')
  const asynchronous = render(name, { ...input, wait: false }, undefined, { state: 'running', waitingForHandoff })
  assert.doesNotMatch(asynchronous, /class="hx"/, '异步请求在收到送达结果前不复用其它等待状态生成卡片')
  const differentTask = render(name, input, `taskId=${originalId}`, { state: 'running', waitingForHandoff })
  assert.doesNotMatch(differentTask, /class="hx"/, '已有结果中的任务 ID 不匹配当前等待任务时不推断送达')
}

const forcedId = '73f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e'
const failedId = '83f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e'
const stoppedId = '93f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e'
const directId = 'a3f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e'
const unrelated = render('uniagent_task', { action: 'create', agent: 'codex', prompt: '另一个任务' }, `taskId=${directId}\n\n[uniagent:event=started]`, { waitingForHandoff })
assert.doesNotMatch(unrelated, /class="hx"[^>]*role="button"/, '其它未解析的任务卡片不能跳转到当前等待中的任务')
const event = (seq: number, type: UAEvent['type'], payload: UAEvent['payload']): UAEvent =>
  ({ sessionId: 'caller', seq, ts: 1000 + seq, type, state: 'success', payload })
const call = (seq: number, input: object, taskId: string, marker: string): UAEvent => event(seq, 'tool_call', {
  id: `call-${seq}`, provider: 'mcp', server: 'uniagent', name: 'uniagent_task', input,
  result: `taskId=${taskId}\n\n[uniagent:event=${marker}]`,
})
const presentation = await renderEventStream([
  event(0, 'user_message', { text: '执行任务' }),
  call(1, { action: 'create', role: 'internal-role', prompt: '派发任务的简要', model: 'hidden-model', effort: 'ultra' }, originalId, 'started'),
  call(2, { action: 'followup', taskId: originalId, prompt: '追加内容的简要' }, nextId, 'delivered'),
  call(3, { action: 'followup', taskId: originalId, prompt: '立即补充的简要', force: true }, forcedId, 'force-delivered'),
  event(4, 'system_notice', { kind: 'handoff_end', taskId: failedId, targetSessionId: 'failed-target', agentName: 'Codex', status: 'failed', reply: '异常原因的简要' }),
  event(5, 'system_notice', { kind: 'handoff_end', taskId: stoppedId, targetSessionId: 'stopped-target', agentName: 'Codex', status: 'stopped', reply: '中止原因的简要', stoppedBy: 'stop_uniagent_task' }),
  event(6, 'system_notice', { kind: 'handoff_end', taskId: originalId, targetSessionId: 'target', agentName: 'Codex', status: 'completed', reply: '完成结果的简要' }),
  call(7, { action: 'create', agent: 'codex', prompt: '不指定角色的任务' }, directId, 'started'),
], 'running', 'caller', {
  setup: `window.__jumps=[];window.__eventStreamProps={
    handoffSessionTargets:{
      '${originalId}':{sessionId:'target',roleName:'审查员',agentName:'Codex'},
      '${failedId}':{sessionId:'failed-target',roleName:'很长的角色名称'.repeat(10),agentName:'Codex'}
    },onJumpToSession:id=>window.__jumps.push(id)
  };`,
  inspect: `(async()=>{
    const root=document.querySelector('#root');root.style.width='640px';
    const cards=[...root.querySelectorAll('.hx')];
    const rows=cards.map(card=>{
      const head=card.querySelector('.hx-head'),action=card.querySelector('.hx-action');
      const node=card.closest('.process-handoff').querySelector('.process-step-node');
      return {label:card.querySelector('.hx-label')?.textContent,name:card.querySelector('.hx-name')?.textContent,action:action?.textContent,last:head.lastElementChild===action,color:action && getComputedStyle(action).color,background:getComputedStyle(card).backgroundColor,border:getComputedStyle(card).borderTopWidth,icons:card.querySelectorAll('svg').length,nodeBorder:getComputedStyle(node).borderTopWidth,nodeColor:getComputedStyle(node).color,nodeWidth:node.querySelector('svg').getBoundingClientRect().width,summary:card.querySelector('.hx-summary')?.textContent};
    });
    cards[0].click();
    const keys=['Enter',' '].map(key=>!cards[0].dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})));
    root.style.width='320px';await new Promise(resolve=>setTimeout(resolve,50));
    const fits=cards.every(card=>card.scrollWidth<=card.clientWidth+1 && card.getBoundingClientRect().right<=root.getBoundingClientRect().right+1);
    return {rows,jumps:window.__jumps,keys,fits,text:cards.map(card=>card.textContent).join(' '),unresolved:cards.at(-1).hasAttribute('role')};
  })()`,
})
assert.deepEqual(presentation.rows.map((row: any) => row.action), ['派发任务', '追加消息', '强制追加', '任务异常', '任务中止', '任务结束', '派发任务'])
assert.deepEqual(presentation.rows.map((row: any) => row.color), ['rgb(91, 157, 255)', 'rgb(91, 157, 255)', 'rgb(210, 153, 34)', 'rgb(248, 81, 73)', 'rgb(210, 153, 34)', 'rgb(63, 185, 80)', 'rgb(91, 157, 255)'])
assert.ok(presentation.rows.every((row: any) => row.last && row.label === '跨agent调用'), '动作是首行最后一个元素，标签保持独立')
assert.ok(presentation.rows.every((row: any) => row.background === 'rgba(0, 0, 0, 0)' && row.border === '1px' && row.icons === 0), '卡片保留轮廓，不填背景、不重复放图标')
assert.ok(presentation.rows.every((row: any) => row.nodeBorder === '0px' && row.nodeColor === 'rgb(91, 157, 255)' && row.nodeWidth === 13), '调度图标独立显示在时间轴上，不套圆点')
assert.deepEqual(presentation.rows.slice(0, 3).map((row: any) => row.name), ['审查员（Codex）', '审查员（Codex）', '审查员（Codex）'], '追加任务的新 ID 继承角色与 Agent 名称')
assert.equal(presentation.rows.at(-1).name, 'Codex', '没有角色时只展示一次 Agent 名称')
assert.deepEqual(presentation.rows.map((row: any) => row.summary), ['派发任务的简要', '追加内容的简要', '立即补充的简要', '异常原因的简要', '由 MCP 中止：中止原因的简要', '完成结果的简要', '不指定角色的任务'])
assert.deepEqual(presentation.jumps, ['target', 'target', 'target'], '整卡点击、Enter 和空格都跳转到目标任务')
assert.deepEqual(presentation.keys, [true, true], '键盘激活阻止默认滚动')
assert.equal(presentation.unresolved, false, '无法解析目标会话时不伪造跳转入口')
assert.equal(presentation.fits, true, '窄列与长角色名称不导致卡片横向溢出')
assert.doesNotMatch(presentation.text, /已开始|已送达|已完成|已中止|hidden-model|Ultra|强制介入/)

const syncFollowup = await renderEventStream([], 'running', 'caller', {
  setup: `
    const fixture=document.createElement('div');fixture.id='sync-handoff';document.body.append(fixture);
    const stream=createRoot(fixture);window.__jumps=[];
    const syncInput={action:'followup',taskId:'${originalId}',wait:true,prompt:'同步追加的需求'};
    window.__renderSync=stage=>{
      const finished=stage!=='running';
      const events=[
        {sessionId:'caller',seq:0,ts:1000,type:'user_message',payload:{text:'执行任务'}},
        {sessionId:'caller',seq:1,ts:1001,type:'agent_message',payload:{id:'commentary',phase:'commentary',text:'把核对出的缺口交回继续处理'}},
        {sessionId:'caller',seq:2,ts:1002,type:'tool_call',state:finished?'success':'running',payload:{id:'sync-followup',server:'uniagent',provider:'mcp',name:'uniagent_task',input:syncInput,...(finished?{result:'taskId=${nextId}\\n\\n[uniagent:event=delivered]\\n[uniagent:terminal=completed]'}:{})}},
        ...(finished?[{sessionId:'caller',seq:3,ts:1003,type:'system_notice',state:'success',payload:{kind:'handoff_end',taskId:'${nextId}',targetSessionId:'target',agentName:'Codex',status:'completed',reply:'同步追加执行完成'}}]:[])
      ];
      stream.render(React.createElement(EventStream,{sessionId:'caller',status:stage==='history'?'completed':'running',events,
        handoffSessionTargets:{'${originalId}':{sessionId:'target',roleName:'审查员',agentName:'Codex'}},
        waitingForHandoff:finished?undefined:${JSON.stringify(waitingForHandoff)},onJumpToSession:id=>window.__jumps.push(id)
      }));
    };
    window.__renderSync('running');
  `,
  inspect: `(async()=>{
    const fixture=document.querySelector('#sync-handoff');
    const wait=()=>new Promise(resolve=>setTimeout(resolve,120));
    const snapshot=()=>({actions:[...fixture.querySelectorAll('.hx-action')].map(node=>node.textContent),names:[...fixture.querySelectorAll('.hx-name')].map(node=>node.textContent),toolRows:[...fixture.querySelectorAll('.step-call-name')].filter(node=>node.textContent.includes('uniagent')).length,waiting:!!fixture.querySelector('.handoff-wait-line')});
    const card=fixture.querySelector('.hx');const initial=snapshot();card?.click();
    window.__renderSync('result');await wait();
    const completed=snapshot(),sameCard=card===fixture.querySelector('.hx');
    window.__renderSync('history');await wait();
    fixture.querySelector('.processed-fold.closed > .processed-head')?.click();await wait();
    return {initial,completed,sameCard,history:snapshot(),jumps:window.__jumps,summaries:[...fixture.querySelectorAll('.hx-summary')].map(node=>node.textContent)};
  })()`,
})
assert.deepEqual(syncFollowup.initial, { actions: ['追加消息'], names: ['审查员（Codex）'], toolRows: 0, waiting: true }, '截图中的同步调用在等待时直接展示本期卡片')
assert.deepEqual(syncFollowup.completed, { actions: ['追加消息', '任务结束'], names: ['审查员（Codex）', '审查员（Codex）'], toolRows: 0, waiting: false }, '结果返回后保留追加卡片并只显示一次任务结束')
assert.equal(syncFollowup.sameCard, true, '结果返回时沿用等待期间的卡片，不切换为另一张卡片')
assert.deepEqual(syncFollowup.history, syncFollowup.completed, '历史时间轴继续保留同样的追加与结束卡片')
assert.deepEqual(syncFollowup.jumps, ['target'], '返回新 taskId 前也能跳转到原目标会话')
assert.deepEqual(syncFollowup.summaries, ['同步追加的需求', '同步追加执行完成'])
console.log('uniagent-mcp-rendering: ok')
