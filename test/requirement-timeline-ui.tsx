import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

process.env.TZ = 'Asia/Shanghai'

for (const width of [1360, 480]) {
  const result = await renderEventStream([], 'idle', 'requirement-timeline', {
    screenshot: { width, height: 900, path: resolve('out/test/requirement-timeline-' + width + '.png') },
    setup: `import{RequirementReader}from'./src/renderer/components/RequirementReader';import'./src/renderer/components/workspaceBrowser.css';
      localStorage.clear();
      localStorage.setItem('ua.scopeBrowser.requirement:r.reader.decisions.history','false');
      const queries=[],sources=[];
      const start=Date.parse('2026-11-11T21:28:00+08:00');
      const documents=Array.from({length:34},(_,i)=>({
        id:'timeline-'+i,kind:'decision',title:i===3?'跨渠道长标题、路径与配置都应完整换行。'.repeat(8):'时间轴记录 '+i,
        summary:'原始结论与适用范围 '+i,status:i===2?'superseded':i===3?'archived':'draft',freshness:'needs-review',
        updatedAt:i===33?0:i===1?start-60000:start+86400000,
        memory:i===1||i===33?undefined:{type:'decision',topic:'时间轴',basis:['user','tool','tool','agent','suggestion'][i%5],occurredAt:i===31?start-86400000:i===32?Date.parse('2025-11-10T21:28:00+08:00'):start-i*60000},
        supersedes:i===0?'prior':undefined,sources:[{kind:'user',sessionId:'source',seq:4}],dependencies:[]
      }));
      window.uniagent={onRequirementsChanged:()=>()=>{},readRequirementOverview:async(id,documentId,query={})=>{
        queries.push({documentId,...query});
        if(documentId){const doc=documents.find(item=>item.id===documentId)||documents[0];return{revision:'one',documents:[],document:{...doc,content:'# 原始记录\\n\\n保留来源与历史关系。'},nextOffset:null}}
        const all=documents.filter(item=>!query.query||item.title.includes(query.query));const offset=query.offset||0;
        return{revision:'one',documents:all.slice(offset,offset+30),total:all.length,nextOffset:offset+30<all.length?offset+30:null};
      }};
      const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;overflow:auto;background:var(--bg);padding:20px';
      createRoot(host).render(<RequirementReader id="r" tab="decisions" sessions={[]} onOpenTask={(id,seq)=>sources.push([id,seq])}/>);
      window.timelineFixture={host,queries,sources};`,
    inspect: `(async()=>{
      const f=window.timelineFixture,q=s=>f.host.querySelector(s),all=s=>[...f.host.querySelectorAll(s)];
      const check=(value,label)=>{if(!value)throw Error(label)},tick=()=>new Promise(resolve=>setTimeout(resolve,25));
      const wait=async(probe,label)=>{for(let i=0;i<160;i++){if(probe())return;await tick()}throw Error(label)};
      const click=(selector,text)=>{const button=all(selector).find(item=>item.textContent.trim()===text);check(button,'missing '+text);button.click()};
      const search=value=>{const input=q('.rr-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
      await wait(()=>all('.rr-decision').length===30,'timeline first page');
      check(f.queries.at(-1).includeHistory===true&&!q('.rr-history-filters'),'old saved history=false cannot hide records');
      check(q('.rr-decision-time').dateTime==='2026-11-11T13:28:00.000Z','occurrence time wins over later recording time');
      check(q('.rr-decision-time .rr-time-clock').textContent==='21:28','time is visible beside the record');
      check(all('.rr-decision')[1].querySelector('.rr-decision-time').textContent.includes('记录于'),'fallback time is labelled as recorded');
      check(all('.rr-decision').some(item=>item.textContent.includes('已被替代'))&&all('.rr-decision').some(item=>item.textContent.includes('历史资料')),'historical states remain identifiable');
      const labels=all('.rr-decision-basis').map(item=>item.textContent);
      check(['用户陈述','工具观察','Agent 报告','建议'].every(label=>labels.includes(label)),'provenance survives removing verification status');
      check(!/待核实|记录待复核/.test(q('.requirement-reader').textContent),'verification status is removed');
      const time=q('.rr-decision-time').getBoundingClientRect(),card=q('.rr-decision-main').getBoundingClientRect();
      check(time.right<card.left&&time.top>=card.top&&time.bottom<=card.bottom,'time and content share a row');
      check(all('.rr-decision').every(item=>item.scrollWidth<=item.clientWidth+1),'long titles do not overflow the timeline');
      check(q('.requirement-reader').getBoundingClientRect().width>=f.host.clientWidth-42,'timeline uses the available content width regardless of stylesheet order');
      const summary=q('.rr-decision summary');summary.focus();check(document.activeElement===summary,'summary is keyboard focusable');summary.click();
      check(q('.rr-decision').open&&q('.rr-decision-body').textContent.includes('原始结论'),'row expands its actual summary');
      click('.rr-decision[open] .scope-link','查看结论、原因与来源');await wait(()=>q('.agent-md'),'decision document');
      check(q('.rr-meta').textContent.includes('用户陈述')&&!/待核实|记录待复核/.test(q('.rr-meta').textContent),'document metadata preserves source without verification text');
      click('.rr-sources .scope-link','打开原讨论');check(JSON.stringify(f.sources)==='[["source",4]]','original discussion keeps its exact message');
      q('.rr-back-button').click();await wait(()=>all('.rr-decision').length===30,'return to timeline');
      click('.rr-pagination button','下一页');await wait(()=>q('.rr-pagination span')?.textContent==='2 / 2','timeline second page');
      check(all('.rr-decision').length===4&&q('.rr-decision-title').textContent==='时间轴记录 30','second page uses backend ordering');
      const previousDay=all('.rr-decision')[1].querySelector('.rr-decision-time');
      check(previousDay.dateTime==='2026-11-10T13:28:00.000Z'&&previousDay.textContent.includes('10'),'cross-day records retain their own date');
      if(new Date().getFullYear()!==2025)check(all('.rr-decision')[2].querySelector('.rr-time-day').textContent.includes('2025'),'older years are visible');
      const unknown=all('.rr-decision').at(-1).querySelector('.rr-decision-time');
      check(!unknown.hasAttribute('datetime')&&unknown.textContent.includes('时间未记录'),'missing time never displays the Unix epoch');
      q('.rr-decision summary').click();click('.rr-decision[open] .scope-link','查看结论、原因与来源');await wait(()=>q('.agent-md'),'second-page document');
      q('.rr-back-button').click();await wait(()=>q('.rr-pagination span')?.textContent==='2 / 2'&&all('.rr-decision').length===4,'return preserves page');
      search('时间轴记录 31');await wait(()=>all('.rr-decision').length===1&&q('.rr-pagination span')?.textContent==='1 / 1','search resets the page');
      q('.rr-decision summary').click();click('.rr-decision[open] .scope-link','查看结论、原因与来源');await wait(()=>q('.agent-md'),'searched document');
      q('.rr-back-button').click();await wait(()=>q('.rr-search')?.value==='时间轴记录 31'&&all('.rr-decision').length===1,'return preserves search');
      search('没有该时间轴记录');await wait(()=>q('.rr-documents').textContent.includes('未找到匹配'),'empty search result');
      search('');await wait(()=>all('.rr-decision').length===30,'search cleared');
      check(f.queries.filter(query=>!query.documentId).every(query=>query.includeHistory===true),'search and pagination keep unified scope');
      check(q('.requirement-reader').scrollWidth<=q('.requirement-reader').clientWidth+1,'responsive timeline fits the viewport');
      return{ok:true,width:innerWidth};
    })()`
  })
  assert.equal(result.ok, true)
  assert.equal(result.width, width)
  console.log('PASS requirement timeline ' + width + ': unified history, timestamps, provenance, navigation, paging and long titles')
}
