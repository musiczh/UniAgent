// Diagnose why a REAL mouse click on "‹ 返回列表" does nothing while DOM .click works.
// Uses elementFromPoint at the button's center + Input.dispatchMouseEvent (a true click).
import WebSocket from 'ws'
const port = process.argv[2] || '9222'
const r = await fetch(`http://127.0.0.1:${port}/json`).then((x) => x.json())
const page = r.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res) => ws.on('open', res))
let id = 0
const pend = new Map()
ws.on('message', (d) => {
  const m = JSON.parse(d)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
})
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable')
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true })
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// open a session with subagents + inline row detail
await ev(`
  const list=await window.uniagent.listSessions();
  for(const s of list){const evs=await window.uniagent.getEvents(s.id);
    if((evs||[]).some(e=>e.type==='subagent'&&e.payload&&(e.payload.agents||[]).length)){
      const row=[...document.querySelectorAll('[data-session-id]')].find(r=>r.getAttribute('data-session-id')===s.id);
      if(row){row.click();break;}
    }}
  return true;`)
await sleep(700)
await ev(`const l=document.querySelector('.sa-line'); if(l)l.click(); return !!l;`)
await sleep(700)

// What is ON TOP at the back button's center? + its rect
const probe = await ev(`
  const b=document.querySelector('.subagent-back');
  if(!b) return {noBack:true};
  const r=b.getBoundingClientRect();
  const cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
  const top=document.elementFromPoint(cx,cy);
  const path=[]; let e=top; while(e&&path.length<6){path.push(e.className||e.tagName);e=e.parentElement;}
  return {rect:{x:r.left,y:r.top,w:r.width,h:r.height,cx,cy}, topClass: top&&(top.className||top.tagName), isBackOrChild: !!(top&&(top===b||b.contains(top)||top.contains(b))), path};
`)
console.log('PROBE:', JSON.stringify(probe, null, 2))

// Now fire a REAL mouse click at that point via CDP Input and see if view flips.
if (probe.rect) {
  const { cx, cy } = probe.rect
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
  await sleep(600)
  const after = await ev(`return {detail:!!document.querySelector('.subagent-detailpage'), list:!!document.querySelector('.subagent-listpage')};`)
  console.log('AFTER REAL CLICK:', JSON.stringify(after), after.list && !after.detail ? '✅ real click works' : '❌ real click BROKEN')
}
ws.close()
