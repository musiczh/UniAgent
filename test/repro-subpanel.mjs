// Repro: open a session that has sub-agents, open the sub-agent DETAIL panel,
// click "‹ 返回列表", and report whether the list page actually shows.
import WebSocket from 'ws'

const port = process.argv[2] || '9222'
async function getPage() {
  const r = await fetch(`http://127.0.0.1:${port}/json`).then((x) => x.json())
  const p = r.find((t) => t.type === 'page')
  if (!p) throw new Error('no page')
  return p.webSocketDebuggerUrl
}
const ws = new WebSocket(await getPage())
await new Promise((res) => ws.on('open', res))
let id = 0
const pend = new Map()
ws.on('message', (d) => {
  const m = JSON.parse(d)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m)
    pend.delete(m.id)
  }
})
function send(method, params) {
  return new Promise((res) => {
    const i = ++id
    pend.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
}
await send('Runtime.enable')
async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{${expr}})()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.result?.exceptionDetails) console.log('EXC', JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) Find a session in the sidebar whose events contain a subagent spawn, click it.
const picked = await ev(`
  const list = await window.uniagent.listSessions();
  for (const s of list) {
    const evs = await window.uniagent.getEvents(s.id);
    const hasSub = (evs||[]).some(e=>e.type==='subagent' && e.payload && (e.payload.agents||[]).length);
    if (hasSub) return {id:s.id, title:s.title};
  }
  return null;
`)
console.log('session with subagents:', JSON.stringify(picked))
if (!picked) {
  console.log('NO SESSION WITH SUBAGENTS — cannot repro')
  process.exit(0)
}

// 2) Click that session row in the sidebar.
await ev(`
  const rows=[...document.querySelectorAll('[data-session-id]')];
  const row=rows.find(r=>r.getAttribute('data-session-id')==='${picked.id}');
  if(row) row.click();
  return !!row;
`)
await sleep(700)

// 3) Click the first inline .sa-line row to open the DETAIL panel.
const opened = await ev(`
  const line=document.querySelector('.sa-line');
  if(!line) return {noLine:true};
  line.click();
  return {clicked:true};
`)
console.log('inline row:', JSON.stringify(opened))
await sleep(700)

// 4) Snapshot: is detail showing? then click back, then snapshot again.
const before = await ev(`
  return {
    panel: !!document.querySelector('.subagent-panel'),
    detail: !!document.querySelector('.subagent-detailpage'),
    list: !!document.querySelector('.subagent-listpage'),
    back: !!document.querySelector('.subagent-back')
  };
`)
console.log('BEFORE back-click:', JSON.stringify(before))

await ev(`
  const b=document.querySelector('.subagent-back');
  if(b) b.click();
  return !!b;
`)
await sleep(600)
const after = await ev(`
  return {
    panel: !!document.querySelector('.subagent-panel'),
    detail: !!document.querySelector('.subagent-detailpage'),
    list: !!document.querySelector('.subagent-listpage')
  };
`)
console.log('AFTER back-click:', JSON.stringify(after))
console.log(after.list && !after.detail ? '✅ back-to-list WORKS' : '❌ back-to-list BROKEN')
ws.close()
