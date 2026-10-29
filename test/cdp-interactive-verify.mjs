// Interactive-feature verification against the RUNNING packaged app via CDP.
// Covers the two features that need a live server→client round-trip / a real
// attachment upload, which the static suites can't exercise. Both checks are
// driven through the REAL New Task form (so App's React state mounts the
// sidebar + session-view and the ApprovalCard / UserBubble actually render),
// each as a single tight in-page round trip to survive memory pressure:
//   Doc3-F6 approval UI: read-only sandbox + on-request (reviewer=user) forces
//           a genuine command approval; we click 拒绝 (decline) and confirm the
//           card resolves and the turn winds down.
//   Doc4-N3 attachments: a follow-up message carries a real file; the
//           user_message event carries it, the bubble chip renders, the turn
//           completes, and the file's ALL-CAPS token reaches the model.
//
// Usage: node test/cdp-interactive-verify.mjs [port]
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.argv[2] || '9222'
async function getPage() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json')
      const t = await r.json()
      const p = t.find((x) => x.type === 'page' && /index\.html/.test(x.url))
      if (p && p.webSocketDebuggerUrl) return p
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no page on port ' + port)
}
const page = await getPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 1
const pend = new Map()
const raw = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = id++
    pend.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    const { res, rej } = pend.get(m.id)
    pend.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
await raw('Runtime.enable')

const results = []
const rec = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}
const evalInPage = async (expression) => {
  const r = await raw('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}

const SETREACT = `
  const setReact = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
`

// ---- Doc3-F6: real command-approval round-trip ----
try {
  const tmp = mkdtempSync(join(tmpdir(), 'ua-iv3-'))
  const target = join(tmp, `ua_appr_${Date.now()}.txt`)
  const out = await evalInPage(`(async()=>{${SETREACT}
    const plus = document.querySelector('.btn-new');
    if (!document.querySelector('.new-task') && plus) plus.click();
    for (let i=0;i<60;i++){ if (document.querySelector('.new-task .config-bar select')) break; await sleep(120); }
    const nt = document.querySelector('.new-task');
    const [agentSel,, , permSel] = nt.querySelectorAll('.config-bar select');
    setReact(agentSel, 'codex'); await sleep(120);
    const ro = [...permSel.options].find(o=>o.value==='read-only'); if (ro) setReact(permSel, 'read-only'); await sleep(120);
    setReact(nt.querySelector('.prompt-input'), 'Using your shell tool, actually execute a single bash command that writes the text hi into the file ${JSON.stringify(target)}. Use: echo hi > ${JSON.stringify(target)} . Run it now, do not explain first.');
    await sleep(120);
    nt.querySelector('.btn-send').click();
    for (let i=0;i<80;i++){ if (document.querySelector('.session-view')) break; await sleep(120); }
    const sid = (await window.uniagent.listSessions())[0]?.id;
    let sawPending=false, sawAwaiting=false, kind='', card=false;
    for (let i=0;i<80;i++){
      await sleep(500);
      const evs = await window.uniagent.getEvents(sid);
      const pending = evs.find(e=>e.type==='approval_request' && e.state==='pending');
      const sess = (await window.uniagent.listSessions()).find(x=>x.id===sid);
      if (pending){ sawPending=true; kind=pending.payload?.kind||''; }
      if (sess?.status==='awaiting-approval') sawAwaiting=true;
      if (document.querySelector('.session-view .approval.pending')) card=true;
      if (sawPending && card) break;
    }
    let clicked=false, resolved=false;
    if (card){
      const btn = document.querySelector('.session-view .approval.pending .appr-decline');
      if (btn){ btn.click(); clicked=true; await sleep(800);
        resolved = !!document.querySelector('.session-view .approval.resolved'); }
    }
    let settled=false;
    for (let i=0;i<40;i++){
      await sleep(500);
      const sess=(await window.uniagent.listSessions()).find(x=>x.id===sid);
      const evs=await window.uniagent.getEvents(sid);
      if (sess?.status!=='awaiting-approval') settled=true;
      if (settled && (sess?.status==='idle' || evs.some(e=>e.type==='turn_completed'))) break;
    }
    return JSON.stringify({ sid, sawPending, sawAwaiting, kind, card, clicked, resolved, settled });
  })()`)
  const d = JSON.parse(out)
  rec(
    'Doc3-F6 提问/审批UI交互承接',
    d.sawPending && d.sawAwaiting && d.card && d.clicked && (d.resolved || d.settled),
    `kind=${d.kind} awaiting=${d.sawAwaiting} card=${d.card} clicked=${d.clicked} resolved=${d.resolved} settled=${d.settled}`
  )
} catch (e) {
  rec('Doc3-F6 提问/审批UI交互承接', false, String(e).slice(0, 200))
}

// ---- Doc4-N3: send a real file attachment through a follow-up turn ----
try {
  const tmp = mkdtempSync(join(tmpdir(), 'ua-ivn3-'))
  const file = join(tmp, 'attach_probe.txt')
  writeFileSync(file, 'UNIAGENT_ATTACH_TOKEN_42\nThis file was attached via UniAgent.\n', 'utf8')
  const out = await evalInPage(`(async()=>{${SETREACT}
    const plus = document.querySelector('.btn-new');
    if (plus) plus.click();
    for (let i=0;i<60;i++){ if (document.querySelector('.new-task .config-bar select')) break; await sleep(120); }
    const nt = document.querySelector('.new-task');
    const [agentSel,, , permSel] = nt.querySelectorAll('.config-bar select');
    setReact(agentSel, 'codex'); await sleep(120);
    const ro = [...permSel.options].find(o=>o.value==='read-only'); if (ro) setReact(permSel, 'read-only'); await sleep(120);
    setReact(nt.querySelector('.prompt-input'), 'Reply with only the single word READY.'); await sleep(120);
    nt.querySelector('.btn-send').click();
    for (let i=0;i<80;i++){ if (document.querySelector('.session-view')) break; await sleep(120); }
    const sid = (await window.uniagent.listSessions())[0]?.id;
    for (let i=0;i<80;i++){
      await sleep(500);
      const sess=(await window.uniagent.listSessions()).find(x=>x.id===sid);
      const evs=await window.uniagent.getEvents(sid);
      if (sess?.status==='idle' || evs.some(e=>e.type==='turn_completed')) break;
    }
    const att = [{ kind:'file', path:${JSON.stringify(file)}, name:'attach_probe.txt' }];
    await window.uniagent.sendMessage(sid, 'Read the attached file at the absolute path ${JSON.stringify(file)} (use: cat ${JSON.stringify(file)}) and reply with ONLY the ALL-CAPS token it contains. Do not search the filesystem.', att);
    let hasAttachInEvent=false, chip=false, chipText='';
    for (let i=0;i<60;i++){
      await sleep(200);
      const evs = await window.uniagent.getEvents(sid);
      const um = evs.filter(e=>e.type==='user_message' && (e.payload?.attachments||[]).length>0).slice(-1)[0];
      if (um) hasAttachInEvent=true;
      const c = document.querySelector('.session-view .user-msg .bubble-attach');
      if (c){ chip=true; chipText=(c.textContent||'').trim(); }
      if (hasAttachInEvent && chip) break;
    }
    let tokenSeen=false, completed=false, hardError=false;
    for (let i=0;i<120;i++){
      await sleep(500);
      const evs = await window.uniagent.getEvents(sid);
      const blob = JSON.stringify(evs.filter(e=>e.type==='agent_message'));
      if (blob.includes('UNIAGENT_ATTACH_TOKEN_42')) tokenSeen=true;
      if (evs.filter(e=>e.type==='turn_completed').length>=2) completed=true;
      if (evs.some(e=>e.type==='error' && e.state==='failed')) hardError=true;
      if (completed || hardError) break;
    }
    return JSON.stringify({ sid, hasAttachInEvent, chip, chipText, tokenSeen, completed, hardError });
  })()`)
  const d = JSON.parse(out)
  rec(
    'Doc4-N3 发送图片/文件附件',
    d.hasAttachInEvent && d.chip && d.completed && d.tokenSeen,
    `eventAttach=${d.hasAttachInEvent} chip="${d.chipText}" turnDone=${d.completed} modelReadToken=${d.tokenSeen}`
  )
} catch (e) {
  rec('Doc4-N3 发送图片/文件附件', false, String(e).slice(0, 200))
}

const fails = results.filter((r) => !r.ok)
console.log(`\n===== INTERACTIVE VERIFY: PASS=${results.length - fails.length} FAIL=${fails.length} =====`)
try {
  ws.close()
} catch {}
process.exit(fails.length === 0 ? 0 : 1)
