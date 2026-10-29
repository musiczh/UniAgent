import WebSocket from 'ws'
const port = process.argv[2] || '9222'
const r = await fetch(`http://127.0.0.1:${port}/json`).then((x)=>x.json())
const page = r.find((t)=>t.type==='page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res)=>ws.on('open',res))
let id=0; const pend=new Map()
ws.on('message',(d)=>{const m=JSON.parse(d); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}})
const send=(method,params)=>new Promise((res)=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}))})
await send('Runtime.enable')
const ev=async(expr)=>(await send('Runtime.evaluate',{expression:`(async()=>{${expr}})()`,awaitPromise:true,returnByValue:true})).result?.result?.value
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
async function realClick(sel){
  const rect=await ev(`const b=document.querySelector('${sel}'); if(!b)return null; const r=b.getBoundingClientRect(); return {cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2)};`)
  if(!rect)return {missing:true}
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.cx,y:rect.cy})
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.cx,y:rect.cy,button:'left',clickCount:1})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.cx,y:rect.cy,button:'left',clickCount:1})
  await sleep(500)
  return {clicked:rect}
}
let pass=0, fail=0
const chk=(n,ok,d='')=>{console.log((ok?'✅':'❌')+' '+n+(d?'  '+d:'')); ok?pass++:fail++}

// ---- 1) subagent 返回列表 ----
await ev(`const list=await window.uniagent.listSessions();
  for(const s of list){const evs=await window.uniagent.getEvents(s.id);
    if((evs||[]).some(e=>e.type==='subagent'&&e.payload&&(e.payload.agents||[]).length)){
      const row=[...document.querySelectorAll('[data-session-id]')].find(r=>r.getAttribute('data-session-id')===s.id);
      if(row){row.click();break;}}} return true;`)
await sleep(700)
await ev(`const l=document.querySelector('.sa-line'); if(l)l.click(); return !!l;`)
await sleep(700)
const beforeSub=await ev(`return !!document.querySelector('.subagent-detailpage');`)
await realClick('.subagent-back')
const afterSub=await ev(`return {list:!!document.querySelector('.subagent-listpage'),detail:!!document.querySelector('.subagent-detailpage')};`)
chk('返回列表 real click flips detail→list', beforeSub && afterSub.list && !afterSub.detail, JSON.stringify(afterSub))
// no-drag region present
const subNoDrag=await ev(`const h=document.querySelector('.subagent-panel-head'); return h&&(getComputedStyle(h).getPropertyValue('-webkit-app-region')||'').trim();`)
chk('subagent-panel-head is no-drag', subNoDrag==='no-drag', `region=${subNoDrag}`)

// close panel
await ev(`const x=document.querySelector('.subagent-panel-head .close-x'); if(x)x.click(); return true;`)
await sleep(300)

// ---- 2) settings → capability center → capsync → capability center ----
await ev(`const gear=[...document.querySelectorAll('.settings-entry')].find(b=>/设置/.test(b.textContent||'')); if(gear)gear.click(); return true;`)
await sleep(400)
await ev(`const b=[...document.querySelectorAll('button')].find(x=>/打开工具能力/.test(x.textContent||'')); if(b)b.click(); return !!b;`)
await sleep(600)
await ev(`const row=[...document.querySelectorAll('.capability-row')].find(x=>/Skill/.test(x.textContent||'')&&!x.querySelector('input')?.disabled);if(row)row.querySelector('input')?.click();const b=[...document.querySelectorAll('.capability-toolbar button')].find(x=>/添加到其他 Agent/.test(x.textContent||''));if(b&&!b.disabled)b.click();return !!b&&!b.disabled;`)
await sleep(600)
const beforeCap=await ev(`return !!document.querySelector('.capability-sync-panel');`)
await realClick('.capability-sync-panel .settings-mini-btn')
const afterCap=await ev(`return {capabilities:!!document.querySelector('.capability-center'),cap:!!document.querySelector('.capability-sync-panel')};`)
chk('返回工具能力 real click flips capsync→capabilities', beforeCap && afterCap.capabilities && !afterCap.cap, JSON.stringify(afterCap))
const capBtnNoDrag=await ev(`
  const gear=[...document.querySelectorAll('.settings-entry')].find(b=>/设置/.test(b.textContent||'')); if(gear)gear.click();
  await new Promise(r=>setTimeout(r,300));
  const open=[...document.querySelectorAll('button')].find(x=>/打开工具能力/.test(x.textContent||'')); if(open)open.click();
  await new Promise(r=>setTimeout(r,400));
  const row=[...document.querySelectorAll('.capability-row')].find(x=>/Skill/.test(x.textContent||'')&&!x.querySelector('input')?.disabled);if(row)row.querySelector('input')?.click();
  const b=[...document.querySelectorAll('.capability-toolbar button')].find(x=>/添加到其他 Agent/.test(x.textContent||'')); if(b&&!b.disabled)b.click();
  await new Promise(r=>setTimeout(r,400));
  const btn=document.querySelector('.capability-sync-panel .settings-mini-btn');
  return btn&&(getComputedStyle(btn).getPropertyValue('-webkit-app-region')||'').trim();`)
chk('capsync back button is no-drag', capBtnNoDrag==='no-drag', `region=${capBtnNoDrag}`)

console.log(`\n== ${pass} passed, ${fail} failed ==`)
ws.close()
process.exit(fail?1:0)
