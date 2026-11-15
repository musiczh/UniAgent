import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-review-delete-ui', {
  screenshot: process.env.UNIAGENT_ROUTER_REVIEW_DELETE_SCREENSHOT ? { path: resolve(process.env.UNIAGENT_ROUTER_REVIEW_DELETE_SCREENSHOT), width: 1100, height: 700 } : undefined,
  setup: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {RouterReviewPanel} from './src/renderer/components/RouterReviewPanel';
    let rows=[],mode='',resolveDelete,allowConfirm=true,arriveOnConfirm=false;
    const queries=[],plans=[],deletes=[],confirmations=[],errors=[];
    function make(index){return {request:{requestId:String(index+1).padStart(8,'0')+'-1111-4111-8111-111111111111',prompt:'路由样例 '+index,state:index===0?'routing':'bound',delivery:'finished',version:1,createdAt:index+1,decision:{action:'reuse_task',reason:'继续已有任务'}},revision:0,deletable:index!==0,feedback:index===1?{matches:false}:undefined,traceAvailable:false};}
    function reset(count=53){rows=Array.from({length:count},(_,index)=>make(index));}
    const longReason='这是路由理由的完整内容，用于验证长中文理由最多显示五行，完整内容仍保留在详情中。'.repeat(12);
    function density(){reset(7);rows[0].request.decision.reason=longReason;rows[1].request.decision.reason='https://example.test/'+('verylongunbrokenpath'.repeat(40));rows[2].request.decision.reason='继续原任务。';rows[3].request.decision.reason='第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行\\n第七行';rows[4].request.decision=undefined;rows[4].request.error=longReason;rows[5].request.decision=undefined;rows[5].request.question=longReason;rows[6].request.decision=undefined;}
    reset();
    window.confirm=message=>{confirmations.push(message);if(arriveOnConfirm){rows.push(make(100));arriveOnConfirm=false}return allowConfirm};
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({
      listRouterReviews:async query=>{queries.push(query);const filtered=rows.filter(row=>(query.filter==='all'||query.filter==='bad'&&row.feedback?.matches===false||query.filter==='unrated'&&!row.feedback||query.filter==='good'&&row.feedback?.matches===true)&&(!query.search||row.request.prompt.includes(query.search)));return {rows:filtered.slice(query.offset,query.offset+query.limit),total:filtered.length,counts:{all:rows.length,bad:rows.filter(row=>row.feedback?.matches===false).length,good:0,unrated:rows.filter(row=>!row.feedback).length},deletableCount:rows.filter(row=>row.deletable).length};},
      getRouterReviewDeletion:async ids=>{plans.push(ids);const chosen=rows.filter(row=>!ids||ids.includes(row.request.requestId));return {items:chosen.filter(row=>row.deletable).map(row=>({requestId:row.request.requestId,requestVersion:row.request.version,reviewRevision:row.revision})),protectedCount:chosen.filter(row=>!row.deletable).length};},
      deleteRouterReviews:async items=>{deletes.push(items);if(mode==='reject')throw Error('fixture delete failed');if(mode==='blocked')await new Promise(resolve=>resolveDelete=resolve);const failed=mode==='partial'?items.slice(1):[],skipped=mode==='skip'?items:[],deleted=items.filter(item=>!failed.includes(item)&&!skipped.includes(item));rows=rows.filter(row=>!deleted.some(item=>item.requestId===row.request.requestId));return {deletedIds:deleted.map(item=>item.requestId),skippedIds:skipped.map(item=>item.requestId),failures:failed.map(item=>({requestId:item.requestId,error:'fixture partial failure'}))};},
      getRouterReview:async id=>{const row=rows.find(row=>row.request.requestId===id);if(!row)throw Error('该路由记录已删除');return {...row,attempts:[],feedbackHistory:[]}},copyRouterReviewPrompt:async()=>({count:rows.length}),
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.className='settings-inner';host.style.cssText='position:fixed;left:0;top:0;width:1100px;height:900px;overflow:auto';
    const root=createRoot(host);let generation=0;const mount=props=>root.render(React.createElement(RouterReviewPanel,{key:++generation,onBack:()=>{},...props}));mount();
    window.deleteFixture={host,queries,plans,deletes,confirmations,errors,mode:value=>mode=value,confirm:value=>allowConfirm=value,arrive:()=>arriveOnConfirm=true,release:()=>resolveDelete(),reset,mount,density,longReason};
  `,
  inspect: `(async()=>{
    const f=window.deleteFixture,h=f.host,checks=[],tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await tick()}throw Error('delete UI timeout: '+checks.join(',')+' '+f.errors.join(','))};
    const q=selector=>h.querySelector(selector),button=label=>[...h.querySelectorAll('button')].find(row=>row.textContent.trim()===label),selected=()=>[...h.querySelectorAll('.router-review-table-row input:checked')],ready=()=>q('[aria-label="选择本页可删除记录"]')&&!q('[aria-label="选择本页可删除记录"]').disabled;
    const check=(name,value)=>{if(!value)throw Error(name);checks.push(name)},choose=index=>h.querySelectorAll('.router-review-table-row input')[index].click(),all=()=>q('[aria-label="选择本页可删除记录"]'),remove=()=>h.querySelector('.router-review-bulkbar .danger');
    const change=value=>{const input=q('[aria-label="搜索路由记录"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
    await wait(ready);check('empty selection disabled and active protected',remove().disabled&&h.querySelector('.router-review-table-row input').disabled);
    choose(1);await tick();check('partial selection',all().indeterminate&&selected().length===1);all().click();await tick();check('select current page only',selected().length===49);
    button('下一页').click();await wait(()=>h.textContent.includes('51—53 / 53')&&ready());check('page change resets selection',selected().length===0&&remove().disabled);
    choose(0);await tick();button('不符合预期 1').click();await wait(()=>h.querySelectorAll('.router-review-table-row').length===1&&ready());check('filter change resets selection',remove().disabled);
    choose(0);await tick();change('样例');await wait(()=>f.queries.at(-1).search==='样例'&&ready());check('search resets selection',remove().disabled);
    choose(0);await tick();f.confirm(false);const before=f.deletes.length;remove().click();await wait(()=>f.confirmations.length===1&&!button('清空记录').disabled);check('cancel preserves selection without deletion',selected().length===1&&f.deletes.length===before);
    f.confirm(true);f.mode('reject');remove().click();await wait(()=>button('重试删除'));check('failure preserves row and selection',h.textContent.includes('fixture delete failed')&&selected().length===1);
    f.mode('');button('重试删除').click();await wait(()=>h.textContent.includes('已删除 1 条')&&!button('清空记录').disabled);check('retry uses confirmed snapshot',f.deletes.length===before+2&&JSON.stringify(f.deletes.at(-1))===JSON.stringify(f.deletes.at(-2)));
    check('filtered empty result does not disable global clear',!!q('.router-review-empty')&&!button('清空记录').disabled);
    f.arrive();button('清空记录').click();await wait(()=>h.textContent.includes('已删除 51 条')&&!button('清空记录').disabled);check('clear ignores current filter and search',f.plans.at(-1)===undefined&&f.confirmations.at(-1).includes('所有筛选、所有分页'));
    check('clear confirmation states snapshot retention and protection',f.confirmations.at(-1).includes('1 条正在处理')&&f.confirmations.at(-1).includes('导出快照'));
    change('');await wait(()=>f.queries.at(-1).search===''&&!button('清空记录').disabled);button('全部 2').click();await wait(()=>h.querySelectorAll('.router-review-table-row').length===2&&ready());check('new arrival and active record survive',h.textContent.includes('路由样例 100')&&h.querySelector('.router-review-table-row input').disabled);
    f.reset(53);f.mount();await wait(()=>h.textContent.includes('全部 53')&&ready());button('下一页').click();await wait(()=>h.textContent.includes('51—53 / 53')&&ready());all().click();await tick();remove().click();await wait(()=>h.textContent.includes('全部 50')&&!q('.router-review-pagination')&&ready());check('deleting last page returns to valid first page',f.queries.at(-1).offset===0&&h.querySelectorAll('.router-review-table-row').length===50);
    choose(1);choose(2);await tick();f.mode('partial');remove().click();await wait(()=>h.textContent.includes('fixture partial failure')&&button('重试删除'));check('partial failure retains only failed selection',selected().length===1&&h.textContent.includes('已删除 1 条'));
    f.mode('');button('重试删除').click();await wait(()=>!button('重试删除')&&ready());check('partial retry targets failed records only',f.deletes.at(-1).length===1);
    choose(1);await tick();f.mode('skip');remove().click();await wait(()=>h.textContent.includes('状态或反馈已变化')&&ready());check('stale record retained for reselection',selected().length===1&&!button('重试删除'));
    f.mode('blocked');const start=f.plans.length;remove().click();remove().click();await wait(()=>button('正在删除…'));check('busy state prevents duplicate operation',f.plans.length===start+1&&all().disabled&&q('[aria-label="搜索路由记录"]').disabled);f.release();await wait(ready);
    f.mode('');button('清空记录').click();await wait(()=>h.textContent.includes('全部 1')&&!button('正在删除…'));check('only protected records disable clear',button('清空记录').disabled&&remove().disabled&&all().disabled);
    f.reset(0);f.mount();await wait(()=>q('.router-review-empty'));check('fully empty list disables destructive operations and export',button('清空记录').disabled&&remove().disabled&&all().disabled&&button('一键复制优化 Prompt').disabled);
    f.mount({initialRequestId:'removed'});await wait(()=>h.textContent.includes('该路由记录已删除'));check('deleted card detail shows explicit message',!q('.router-feedback-form')&&h.textContent.includes('返回配置'));
    f.reset(3);f.mount();await wait(ready);choose(1);choose(2);await tick();h.style.width='760px';await tick();check('narrow layout has no horizontal overflow',h.scrollWidth<=h.clientWidth);h.style.width='1100px';
    f.density();f.mount();await wait(()=>ready()&&h.querySelectorAll('.router-review-table-row').length===7&&h.textContent.includes(f.longReason));
    const rows=()=>[...h.querySelectorAll('.router-review-table-row')],reason=row=>row.querySelector('.router-review-reason-text')||row.children[2],height=element=>element.getBoundingClientRect().height,lineHeight=()=>parseFloat(getComputedStyle(reason(rows()[0])).lineHeight);
    check('long Chinese and unbroken reasons show five lines',rows().slice(0,2).every(row=>Math.abs(height(reason(row))-lineHeight()*5)<1&&reason(row).scrollHeight>reason(row).clientHeight));
    check('short reason keeps natural height',height(reason(rows()[2]))<lineHeight()*5);
    check('explicit newlines and fallback reasons clamp',rows().slice(3,6).every(row=>Math.abs(height(reason(row))-lineHeight()*5)<1)&&reason(rows()[6]).textContent==='等待路由');
    check('full reason stays in the document',reason(rows()[0]).textContent===f.longReason);
    const first=rows()[0],currentWidth=first.children[2].getBoundingClientRect().width,narrow=window.matchMedia('(max-width:1000px)').matches;first.style.gridTemplateColumns=narrow?'minmax(0,2fr) minmax(0,1.2fr) minmax(0,1.2fr) minmax(100px,1fr)':'minmax(0,2.1fr) minmax(0,1.6fr) minmax(0,1.55fr) minmax(120px,1fr)';const oldWidth=first.children[2].getBoundingClientRect().width;first.style.gridTemplateColumns='';check('reason column widens at the current breakpoint',Math.abs(currentWidth/oldWidth-(narrow?1.6/1.2:2/1.55))<.01);
    const shape=getComputedStyle(all());check('checkbox uses soft custom shape',shape.appearance==='none'&&all().getBoundingClientRect().width===16&&shape.borderRadius==='4px');
    const label=rows()[1].querySelector('label');check('checkbox click area is 24px',!!label&&label.getBoundingClientRect().width===24&&label.getBoundingClientRect().height===24);label.click();await tick();check('label click selects row',selected().length===1&&all().indeterminate);
    const rowStyle=getComputedStyle(rows()[1].querySelector('input')),mixedStyle=getComputedStyle(all(),'::after');check('checked and indeterminate indicators render',rowStyle.backgroundColor!==getComputedStyle(rows()[2].querySelector('input')).backgroundColor&&mixedStyle.content!=='none'&&parseFloat(mixedStyle.width)===8);
    const head=h.querySelector('.router-review-table-head');check('table columns remain aligned',Math.abs(head.children[2].getBoundingClientRect().left-first.children[2].getBoundingClientRect().left)<1);
    h.style.width='760px';await tick();check('narrow reasons stay clamped without overflow',h.scrollWidth<=h.clientWidth&&rows().slice(0,2).every(row=>height(reason(row))<=lineHeight()*5+1));h.style.width='1100px';
    first.querySelector('button').click();await wait(()=>h.querySelector('.router-review-card'));check('detail retains full unclamped reason',[...h.querySelectorAll('.router-review-card dd')].some(element=>element.textContent===f.longReason&&height(element)>parseFloat(getComputedStyle(element).lineHeight)*5));button('返回列表').click();await wait(ready);
    return {checks,errors:f.errors};
  })().catch(error=>({error:error.stack,reasonMetrics:[...document.querySelectorAll('.router-review-reason-text')].slice(0,2).map(el=>({height:el.getBoundingClientRect().height,client:el.clientHeight,scroll:el.scrollHeight,lineHeight:getComputedStyle(el).lineHeight,clamp:getComputedStyle(el).webkitLineClamp,display:getComputedStyle(el).display,textLength:el.textContent.length}))}))`
})
assert.equal(result.error, undefined, JSON.stringify(result.reasonMetrics))
assert.equal(result.checks.length, 34)
assert.deepEqual(result.errors, [])
console.log(`PASS Router review deletion UI: ${result.checks.join(', ')}`)
