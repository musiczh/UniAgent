// DOM-driven UI verification against the RUNNING packaged app via CDP. Unlike
// cdp-feature-verify (which drives the IPC surface), this test manipulates the
// REAL React UI in the live renderer — filling the actual NewTaskPanel form and
// clicking its button so a session is created through the true user path — then
// asserts on the rendered DOM exactly as a user would see it. Covers:
//   Doc1-F1 textarea auto-resize (capped ~1/3 window)
//   Doc1-F2 live Markdown list preview (only when list syntax present)
//   Doc1-F3 adjustable status bar + context meter (bar + % + token count)
//   Doc4-N7 reasoning shown expanded on first render (live)
//   Doc4-N5 read-only diff review sidebar (via a real auto-edit turn)
//
// Usage: node test/cdp-ui-verify.mjs [port]
const port = process.argv[2] || '9222'

async function getPage() {
  for (let i = 0; i < 80; i++) {
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
const send = (m, p = {}) =>
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{${expr}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
await send('Page.enable')
await send('Page.reload', { ignoreCache: false })
await new Promise((r) => setTimeout(r, 2600))
await send('Runtime.enable')

const results = []
const rec = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}

// React-aware setters for controlled inputs/selects: set value via the native
// prototype setter, then fire the event React actually listens on.
const HELPERS = `
  window.__reactSet = function(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`
await ev(`${HELPERS} return 1;`)

// Ensure we start on the New Task screen (click ＋ if a session is open).
await ev(`
  const plus = document.querySelector('.btn-new');
  if (!document.querySelector('.new-task') && plus) plus.click();
  for (let i=0;i<40;i++){ if (document.querySelector('.new-task .prompt-input')) break; await new Promise(r=>setTimeout(r,120)); }
  return 1;
`)

// ---- Doc1-F2: list preview appears only for list syntax (NewTaskPanel) ----
try {
  const r = await ev(`
    const ta = document.querySelector('.new-task .prompt-input');
    if (!ta) return JSON.stringify({ err: 'no prompt-input' });
    window.__reactSet(ta, 'just some plain prose without any list at all');
    await new Promise(r=>setTimeout(r,120));
    const proseHasPreview = !!document.querySelector('.new-task .list-preview');
    window.__reactSet(ta, '购物清单：\\n- 苹果\\n- 香蕉\\n1. 第一\\n2. 第二');
    await new Promise(r=>setTimeout(r,150));
    const box = document.querySelector('.new-task .list-preview');
    const hasUL = !!box?.querySelector('ul');
    const hasOL = !!box?.querySelector('ol');
    const liCount = box ? box.querySelectorAll('li').length : 0;
    window.__reactSet(ta, '');
    return JSON.stringify({ proseHasPreview, listPreview: !!box, hasUL, hasOL, liCount });
  `)
  const d = JSON.parse(r)
  rec(
    'Doc1-F2 Markdown列表实时预览',
    d.err ? false : d.proseHasPreview === false && d.listPreview && d.hasUL && d.hasOL && d.liCount >= 4,
    d.err || `prose预览=${d.proseHasPreview} 列表预览=${d.listPreview} ul=${d.hasUL} ol=${d.hasOL} li=${d.liCount}`
  )
} catch (e) {
  rec('Doc1-F2 Markdown列表实时预览', false, String(e).slice(0, 160))
}

// ---- Doc1-F1: textarea auto-resize grows with content, capped at ~1/3 window ----
try {
  const r = await ev(`
    const ta = document.querySelector('.new-task .prompt-input');
    if (!ta) return JSON.stringify({ err: 'no prompt-input' });
    window.__reactSet(ta, 'one line');
    await new Promise(r=>setTimeout(r,120));
    const h1 = ta.getBoundingClientRect().height;
    window.__reactSet(ta, Array.from({length: 40}, (_,i)=>'line '+i).join('\\n'));
    await new Promise(r=>setTimeout(r,150));
    const h2 = ta.getBoundingClientRect().height;
    const cap = Math.round(window.innerHeight / 3);
    window.__reactSet(ta, '');
    await new Promise(r=>setTimeout(r,80));
    const h3 = ta.getBoundingClientRect().height;
    return JSON.stringify({ h1: Math.round(h1), h2: Math.round(h2), h3: Math.round(h3), cap, winH: window.innerHeight });
  `)
  const d = JSON.parse(r)
  rec(
    'Doc1-F1 输入框高度自适应(≤1/3窗高)',
    d.err ? false : d.h2 > d.h1 && d.h2 <= d.cap + 6 && d.h3 < d.h2,
    d.err || `空=${d.h1}px 满=${d.h2}px 清空=${d.h3}px 上限=${d.cap}px(窗${d.winH})`
  )
} catch (e) {
  rec('Doc1-F1 输入框高度自适应', false, String(e).slice(0, 160))
}

// ---- Create a REAL session via the form: codex, auto-edit, high effort, a
//      prompt that induces reasoning AND a file write (covers N7 + N5 + F3). ----
const created = await ev(`
  window.__e = window.__e || [];
  if (!window.__uihook) { window.__uihook = true; window.uniagent.onEvent(x => window.__e.push(x)); }
  const nt = document.querySelector('.new-task');
  if (!nt) return JSON.stringify({ err: 'not on new-task' });
  const selects = nt.querySelectorAll('.config-bar select');
  // selects: [Agent, 模型, 推理, 权限]
  const [agentSel, modelSel, effortSel, permSel] = selects;
  window.__reactSet(agentSel, 'codex');
  await new Promise(r=>setTimeout(r,100));
  // pick a model that supports effort so reasoning shows.
  const opt = [...modelSel.options].find(o=>/sol/i.test(o.value)) || modelSel.options[1];
  if (opt) window.__reactSet(modelSel, opt.value);
  await new Promise(r=>setTimeout(r,100));
  if (effortSel && !effortSel.disabled) {
    const hi = [...effortSel.options].find(o=>o.value==='high') || effortSel.options[effortSel.options.length-1];
    if (hi) window.__reactSet(effortSel, hi.value);
  }
  // permission -> auto-edit so the write needs no approval and emits a diff.
  const ae = [...permSel.options].find(o=>o.value==='auto-edit');
  if (ae) window.__reactSet(permSel, 'auto-edit');
  await new Promise(r=>setTimeout(r,100));
  const ta = nt.querySelector('.prompt-input');
  window.__reactSet(ta, 'First think briefly step by step about the exact content. Then create a new file named ua_probe.txt containing exactly the text hello-uniagent, and stop.');
  await new Promise(r=>setTimeout(r,120));
  const btn = nt.querySelector('.btn-send');
  const disabled = btn.disabled;
  btn.click();
  // wait for the session view + composer to mount.
  for (let i=0;i<80;i++){ if (document.querySelector('.composer-wrap')) break; await new Promise(r=>setTimeout(r,120)); }
  const perm = permSel.value, model = modelSel.value, effort = effortSel?.value;
  return JSON.stringify({ mounted: !!document.querySelector('.composer-wrap'), perm, model, effort, disabled });
`)
const cinfo = JSON.parse(created)
if (cinfo.err || !cinfo.mounted) {
  rec('会话视图挂载(通过真实表单)', false, cinfo.err || JSON.stringify(cinfo))
}

// ---- Doc1-F3: adjustable status bar + context meter present ----
try {
  const r = await ev(`
    const sb = document.querySelector('.composer-wrap .status-bar');
    const selects = sb ? sb.querySelectorAll('select').length : 0;
    const attach = !!sb?.querySelector('.sb-add-btn');
    const meter = document.querySelector('.composer-wrap .ctx-meter');
    return JSON.stringify({
      statusBar: !!sb, selects, attach, meter: !!meter,
      hasBar: !!meter?.querySelector('.ctx-bar'),
      hasTok: /tok/.test(meter?.textContent || ''),
      meterText: (meter?.textContent||'').slice(0,40)
    });
  `)
  const d = JSON.parse(r)
  rec(
    'Doc1-F3 可调状态栏+上下文负载',
    d.statusBar && d.selects >= 1 && d.attach && d.meter && d.hasTok,
    `statusBar=${d.statusBar} selects=${d.selects} attach=${d.attach} meter=${d.meter} bar=${d.hasBar} "${d.meterText}"`
  )
} catch (e) {
  rec('Doc1-F3 可调状态栏+上下文负载', false, String(e).slice(0, 160))
}

// ---- Doc4-N7: reasoning shown EXPANDED on first render while the turn runs ----
try {
  let expandedWhileLive = false
  let sawReasoning = false
  for (let i = 0; i < 140; i++) {
    await new Promise((r) => setTimeout(r, 300))
    const s = await ev(`
      const card = document.querySelector('.session-view .reasoning');
      const body = document.querySelector('.session-view .reasoning .reasoning-body');
      const completed = document.querySelectorAll('.session-view .agent-msg').length>0 &&
        !document.querySelector('.session-view .agent-msg.streaming');
      return JSON.stringify({ card: !!card, bodyVisible: !!body, completed });
    `)
    const d = JSON.parse(s)
    if (d.card) sawReasoning = true
    if (d.card && d.bodyVisible) {
      expandedWhileLive = true
      break
    }
    if (d.completed) break
  }
  rec(
    'Doc4-N7 思考首展不折叠',
    expandedWhileLive,
    `sawReasoningCard=${sawReasoning} expandedWhileLive=${expandedWhileLive}`
  )
} catch (e) {
  rec('Doc4-N7 思考首展不折叠', false, String(e).slice(0, 200))
}

// ---- Wait for turn completion so a usage footer (context) lands ----
const sidNow = await ev(`
  const evs = window.__e;
  // newest session id we created
  const ids = [...new Set(evs.map(e=>e.sessionId))];
  return ids[ids.length-1] || '';
`)
await ev(`
  for (let i=0;i<400;i++){
    const evs = window.__e.filter(e=>e.sessionId===${JSON.stringify(sidNow)});
    if (evs.some(e=>e.type==='turn_completed')) break;
    await new Promise(r=>setTimeout(r,300));
  }
  return 1;
`)

// ---- Doc1-F3b: context meter reflects a real usage snapshot (>0 tokens) ----
try {
  const r = await ev(`
    const tokEl = document.querySelector('.composer-wrap .ctx-meter .ctx-tok');
    const txt = tokEl?.textContent || '';
    const box = document.querySelector('.composer-wrap .ctx-meter');
    // The meter opens its detail popover on click (also on hover, but React's
    // synthetic onMouseEnter isn't driven by a dispatched mouseenter, so click).
    box?.click();
    await new Promise(r=>setTimeout(r,120));
    const pop = document.querySelector('.composer-wrap .ctx-meter .ctx-pop');
    const rows = pop ? pop.querySelectorAll('.ctx-pop-row').length : 0;
    const popText = (pop?.textContent||'').replace(/\\s+/g,' ').slice(0,80);
    box?.click();
    const num = parseFloat((txt.match(/([\\d.]+)\\s*[kM]?/)||[])[1]||'0');
    return JSON.stringify({ txt: txt.trim(), num, popoverRows: rows, popText });
  `)
  const d = JSON.parse(r)
  rec(
    'Doc1-F3 上下文负载(真实token+明细弹层)',
    d.num > 0 && d.popoverRows >= 1,
    `meter="${d.txt}" popoverRows=${d.popoverRows} pop="${d.popText}"`
  )
} catch (e) {
  rec('Doc1-F3 上下文负载(真实token)', false, String(e).slice(0, 160))
}

// ---- Doc4-N5: read-only diff review sidebar from the auto-edit turn ----
try {
  const hasDiffEvent = await ev(`
    const evs = window.__e.filter(e=>e.sessionId===${JSON.stringify(sidNow)});
    return evs.some(e=>e.type==='diff_update' && (e.payload?.diff||'').length>0);
  `)
  const r = await ev(`
    const tab = document.querySelector('.diff-tab');
    if (tab) tab.click();
    await new Promise(r=>setTimeout(r,200));
    const side = document.querySelector('.diff-sidebar');
    const files = side ? side.querySelectorAll('.diff-file').length : 0;
    const addLines = side ? side.querySelectorAll('.dl.add').length : 0;
    const editable = side ? side.querySelectorAll('input,textarea,[contenteditable="true"]').length : 0;
    const stat = side?.querySelector('.diff-stat')?.textContent || '';
    const probe = /ua_probe\\.txt|hello-uniagent/.test(side?.textContent||'');
    return JSON.stringify({ sidebar: !!side, files, addLines, editable, stat, probe, hadTab: !!tab });
  `)
  const d = JSON.parse(r)
  rec(
    'Doc4-N5 代码变更审查侧栏(只读)',
    hasDiffEvent && d.sidebar && d.files >= 1 && d.addLines >= 1 && d.editable === 0,
    `diffEvent=${hasDiffEvent} sidebar=${d.sidebar} files=${d.files} +lines=${d.addLines} editable=${d.editable} probe=${d.probe} stat="${d.stat}"`
  )
} catch (e) {
  rec('Doc4-N5 代码变更审查侧栏(只读)', false, String(e).slice(0, 200))
}

const fails = results.filter((r) => !r.ok)
console.log(`\n===== UI VERIFY: PASS=${results.length - fails.length} FAIL=${fails.length} =====`)
ws.close()
process.exit(fails.length === 0 ? 0 : 1)
