// Requirement 6: manual context compaction through the packaged Electron app.
//
// The script creates a real streaming/app-server session, checks that the
// ContextMeter popover keeps its action visible but disabled during a turn, then
// physically clicks the enabled action through CDP. The resulting main-process
// events prove the renderer -> preload -> IPC -> AppServerRunner path, while DOM
// snapshots prove one keyed row transitions from running to success.
//
// Usage: node test/cdp-manual-compact.mjs [port] [agentId]
// Launch the packaged app with --remote-debugging-port=<port> first.
const port = process.argv[2] || '9222'
const requestedAgentId = process.argv[3] || 'codex'
const mode = process.argv[4] || 'live'

async function getPage() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && /index\.html/.test(target.url))
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no page on port ${port}`)
}

const page = await getPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let commandId = 1
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = commandId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
await send('Runtime.enable')

async function evaluate(body) {
  const result = await send('Runtime.evaluate', {
    expression: `(async()=>{${body}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result?.value
}

async function realClick(selector) {
  const rect = JSON.parse(await evaluate(`
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return JSON.stringify({ error: 'missing ${selector}' });
    const rect = element.getBoundingClientRect();
    return JSON.stringify({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      visible: rect.width > 0 && rect.height > 0
    });
  `))
  if (rect.error || !rect.visible) throw new Error(rect.error || `${selector} is not visible`)
  // Move the real pointer onto the hover-owned popover before pressing. A
  // pressed event alone does not reliably synthesize mouseenter in Electron;
  // if the pointer was outside ContextMeter, React can close the popover before
  // the click is delivered and the product action never runs.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
}

async function waitFor(label, body, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(body)
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`)
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// Second phase for the restart boundary. Run the normal mode once to persist an
// idle app-server session, restart the packaged app, then invoke with
// `restored`. The session metadata survives but the process-local runner must
// not, so the action stays visible and explains how to establish a connection.
if (mode === 'restored') {
  try {
    const restored = JSON.parse(await evaluate(`
      const sessions = (await window.uniagent.listSessions())
        .filter((session) =>
          session.config?.agentId === ${JSON.stringify(requestedAgentId)} &&
          session.status === 'idle' &&
          !session.readOnly &&
          !!session.nativeSessionId
        )
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
      const session = sessions[0];
      if (!session) return JSON.stringify({ error: 'no persisted idle app-server session' });
      const runtime = await window.uniagent.getSessionRuntimeState(session.id);
      for (let i = 0; i < 80 && !document.querySelector('[data-session-id="' + session.id + '"]'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      document.querySelector('[data-session-id="' + session.id + '"]')?.click();
      return JSON.stringify({ sessionId: session.id, hasLiveStreamer: runtime.hasLiveStreamer });
    `))
    if (restored.error) throw new Error(restored.error)
    const state = JSON.parse(await waitFor(
      'restored session compact state',
      `
        const meter = document.querySelector('.composer-wrap .ctx-meter');
        if (!meter) return '';
        if (!meter.querySelector('.ctx-pop')) meter.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const button = meter.querySelector('.ctx-compact-btn');
        const reason = meter.querySelector('.ctx-compact-reason')?.textContent?.trim() || '';
        return button && /尚未建立实时连接/.test(reason)
          ? JSON.stringify({ disabled: !!button.disabled, reason })
          : '';
      `,
      12_000
    ))
    check(
      '重启恢复的 idle 会话没有虚假的压缩能力',
      restored.hasLiveStreamer === false && state.disabled && /尚未建立实时连接/.test(state.reason),
      JSON.stringify({ ...restored, ...state })
    )
  } catch (error) {
    check('需求6 重启恢复 CDP', false, String(error?.stack || error).slice(0, 800))
  }
  const failures = results.filter((result) => !result.ok)
  console.log(`\n===== RESTORED COMPACT CDP: PASS=${results.length - failures.length} FAIL=${failures.length} =====`)
  ws.close()
  process.exit(failures.length ? 1 : 0)
}

try {
  await evaluate(`
    window.__req6Events = [];
    if (!window.__req6EventHook) {
      window.__req6EventHook = window.uniagent.onEvent((event) => window.__req6Events.push(event));
    }
    window.__req6Set = (element, value) => {
      const prototype = element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : element.tagName === 'SELECT'
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    return true;
  `)

  const agents = JSON.parse(await evaluate(`
    const agents = await window.uniagent.detectAgents();
    return JSON.stringify(agents.map((agent) => ({
      id: agent.id,
      installed: agent.installed,
      adapter: agent.adapter,
      streaming: agent.capabilities?.streaming
    })));
  `))
  const target = agents.find((agent) =>
    agent.id === requestedAgentId &&
    agent.installed &&
    agent.streaming === true &&
    (agent.adapter === 'codex' || agent.adapter === 'traex')
  )
  if (!target) throw new Error(`${requestedAgentId} is not an installed app-server agent: ${JSON.stringify(agents)}`)

  await evaluate(`
    document.querySelector('.btn-new')?.click();
    for (let i = 0; i < 80 && !document.querySelector('.new-task .prompt-input'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  `)
  const created = JSON.parse(await evaluate(`
    const panel = document.querySelector('.new-task');
    if (!panel) return JSON.stringify({ error: 'new-task panel did not mount' });
    const selects = [...panel.querySelectorAll('.cfg select')];
    const agentSelect = selects.find((select) => /Agent/.test(select.closest('.cfg')?.textContent || '')) || selects[0];
    if (!agentSelect) return JSON.stringify({ error: 'agent selector missing' });
    window.__req6Set(agentSelect, ${JSON.stringify(requestedAgentId)});
    await new Promise((resolve) => setTimeout(resolve, 250));
    const prompt = panel.querySelector('.prompt-input');
    window.__req6Set(prompt, 'Use the shell to run sleep 8, then reply with exactly REQ6_READY.');
    const sendButton = panel.querySelector('.btn-send');
    for (let i = 0; i < 40 && sendButton?.disabled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const wasDisabled = !!sendButton?.disabled;
    sendButton?.click();
    for (let i = 0; i < 80 && !document.querySelector('.session-view'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const row = document.querySelector('.session-item.active[data-session-id]');
    return JSON.stringify({
      error: !row ? 'active session row missing' : undefined,
      sid: row?.getAttribute('data-session-id') || '',
      wasDisabled,
      mounted: !!document.querySelector('.session-view')
    });
  `))
  if (created.error || !created.sid || created.wasDisabled || !created.mounted) {
    throw new Error(`could not create active session: ${JSON.stringify(created)}`)
  }
  const sid = created.sid

  const busyButton = JSON.parse(await waitFor(
    'busy compact button with loaded capability',
    `
      const meter = document.querySelector('.composer-wrap .ctx-meter');
      if (!meter) return '';
      if (!meter.querySelector('.ctx-pop')) meter.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const button = meter.querySelector('.ctx-compact-btn');
      const reason = meter.querySelector('.ctx-compact-reason');
      const rect = button?.getBoundingClientRect();
      const state = {
        visible: !!button && rect.width > 0 && rect.height > 0,
        disabled: !!button?.disabled,
        label: button?.textContent?.trim() || '',
        reason: reason?.textContent?.trim() || ''
      };
      return state.visible && state.disabled && /运行中/.test(state.reason)
        ? JSON.stringify(state)
        : '';
    `,
    6_000
  ))
  check(
    'ContextMeter 悬浮窗始终显示压缩按钮',
    busyButton.visible && busyButton.label === '压缩上下文',
    JSON.stringify(busyButton)
  )
  check(
    'Agent 运行中按钮禁用并解释原因',
    busyButton.disabled && /运行中/.test(busyButton.reason),
    JSON.stringify(busyButton)
  )

  await waitFor(
    'initial turn completion',
    `
      const completed = window.__req6Events.some((event) =>
        event.sessionId === ${JSON.stringify(sid)} && event.type === 'turn_completed'
      );
      return completed && !!document.querySelector('.composer-wrap .btn-send');
    `,
    180_000
  )

  const idleButton = JSON.parse(await evaluate(`
    const meter = document.querySelector('.composer-wrap .ctx-meter');
    if (!meter.querySelector('.ctx-pop')) meter.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const button = meter.querySelector('.ctx-compact-btn');
    return JSON.stringify({
      visible: !!button && button.getBoundingClientRect().width > 0,
      disabled: !!button?.disabled,
      reason: meter.querySelector('.ctx-compact-reason')?.textContent?.trim() || ''
    });
  `))
  check('app-server 会话空闲时可压缩', idleButton.visible && !idleButton.disabled && !idleButton.reason, JSON.stringify(idleButton))

  // 需求2 — record the occupancy figure the ContextMeter shows BEFORE compaction
  // so we can assert it drops once compaction succeeds. `contextTokens` is the
  // renderer's source of truth (the meter's leading number is a rounded view of
  // it); read it from the newest `context` notice the main process has emitted.
  const occupancyBefore = JSON.parse(await evaluate(`
    const notices = window.__req6Events.filter((event) =>
      event.sessionId === ${JSON.stringify(sid)} &&
      event.type === 'system_notice' && event.payload?.kind === 'context' && event.payload.usage
    );
    const meter = document.querySelector('.composer-wrap .ctx-meter .ctx-tok');
    return JSON.stringify({
      contextTokens: notices.length ? (notices[notices.length - 1].payload.usage.contextTokens || 0) : 0,
      meterText: meter?.textContent?.trim() || ''
    });
  `))

  const priorIds = JSON.parse(await evaluate(`
    return JSON.stringify(window.__req6Events
      .filter((event) => event.sessionId === ${JSON.stringify(sid)} && event.type === 'context_compaction')
      .map((event) => event.payload?.id)
      .filter(Boolean));
  `))
  await evaluate(`
    window.__req6DomTrace = [];
    window.__req6Observer?.disconnect();
    window.__req6Capture = () => {
      const button = document.querySelector('.ctx-compact-btn');
      const rows = [...document.querySelectorAll('.context-compaction')].map((row) => ({
        id: row.getAttribute('data-compaction-id'),
        running: row.classList.contains('state-running'),
        text: (row.textContent || '').replace(/\s+/g, ' ').trim()
      }));
      window.__req6DomTrace.push({
        rows,
        buttonDisabled: !!button?.disabled,
        buttonText: button?.textContent?.trim() || ''
      });
    };
    window.__req6Observer = new MutationObserver(window.__req6Capture);
    window.__req6Observer.observe(document.querySelector('.session-view'), {
      childList: true, subtree: true, attributes: true, characterData: true
    });
    window.__req6Capture();
    return true;
  `)

  // This is deliberately a physical CDP mouse click, not element.click().
  await realClick('.ctx-compact-btn')

  const terminal = JSON.parse(await waitFor(
    'manual compaction success',
    `
      window.__req6Capture?.();
      const prior = new Set(${JSON.stringify(priorIds)});
      const events = window.__req6Events.filter((event) =>
        event.sessionId === ${JSON.stringify(sid)} &&
        event.type === 'context_compaction' &&
        event.payload?.id &&
        !prior.has(event.payload.id)
      );
      const running = events.find((event) => event.state === 'running');
      const success = running && events.find((event) =>
        event.payload.id === running.payload.id && event.state === 'success'
      );
      return success ? JSON.stringify({ id: running.payload.id, events }) : '';
    `,
    120_000
  ))

  const finalState = JSON.parse(await evaluate(`
    window.__req6Observer?.disconnect();
    window.__req6Capture?.();
    const id = ${JSON.stringify(terminal.id)};
    const rows = [...document.querySelectorAll('.context-compaction')]
      .filter((row) => row.getAttribute('data-compaction-id') === id);
    const compact = rows[0];
    const row = compact?.querySelector('.step-call-row');
    const children = row ? [...row.children].map((child) => child.getBoundingClientRect()) : [];
    const rowRect = row?.getBoundingClientRect();
    const trace = window.__req6DomTrace || [];
    return JSON.stringify({
      count: rows.length,
      text: (row?.textContent || '').replace(/\s+/g, ' ').trim(),
      completed: compact?.classList.contains('state-success'),
      insideItem: !!compact?.closest('.process-step-calls'),
      elapsed: compact?.querySelector('.context-compaction-duration')?.textContent || '',
      oneLine: !!rowRect && children.length > 1 &&
        Math.max(...children.map((rect) => rect.top)) - Math.min(...children.map((rect) => rect.top)) <= 1 &&
        rowRect.height <= Math.max(...children.map((rect) => rect.height)) + 10,
      sawRunningRow: trace.some((snapshot) => snapshot.rows.some((item) =>
        item.id === id && item.running
      )),
      sawCompactingButton: trace.some((snapshot) =>
        snapshot.buttonDisabled && /压缩中/.test(snapshot.buttonText)
      )
    });
  `))

  check(
    '按钮点击走真实 IPC 并收到 running→success',
    terminal.events.some((event) => event.state === 'running') &&
      terminal.events.some((event) => event.state === 'success'),
    `id=${terminal.id} states=${terminal.events.map((event) => event.state).join('→')}`
  )
  check(
    '压缩中禁用按钮以防重复提交',
    finalState.sawCompactingButton,
    JSON.stringify(finalState)
  )
  check(
    'running→success 复用同一单行生命周期',
    finalState.sawRunningRow &&
      finalState.count === 1 &&
      finalState.completed && finalState.insideItem &&
      /^\d+(?:\.\d+)?(?:ms|s)$/.test(finalState.elapsed) &&
      finalState.oneLine,
    JSON.stringify(finalState)
  )

  // 需求2(主动压缩更新) — a successful compaction must make the ContextMeter drop
  // immediately, without waiting for the next turn. Poll for a fresh `context`
  // notice whose occupancy is strictly below the pre-compaction figure, and
  // confirm the visible meter text changed too. We assert a strict decrease
  // rather than a fixed value: the post-compaction size depends on how much the
  // model summarized, but it must be smaller than before.
  const occupancyAfter = JSON.parse(await waitFor(
    'post-compaction occupancy drop',
    `
      const notices = window.__req6Events.filter((event) =>
        event.sessionId === ${JSON.stringify(sid)} &&
        event.type === 'system_notice' && event.payload?.kind === 'context' && event.payload.usage
      );
      const latest = notices.length ? (notices[notices.length - 1].payload.usage.contextTokens || 0) : 0;
      const meter = document.querySelector('.composer-wrap .ctx-meter .ctx-tok');
      const meterText = meter?.textContent?.trim() || '';
      return (latest > 0 && latest < ${occupancyBefore.contextTokens})
        ? JSON.stringify({ contextTokens: latest, meterText })
        : '';
    `,
    20_000
  ))
  check(
    '压缩成功后占用条实时下降',
    occupancyBefore.contextTokens > 0 &&
      occupancyAfter.contextTokens > 0 &&
      occupancyAfter.contextTokens < occupancyBefore.contextTokens &&
      occupancyAfter.meterText !== occupancyBefore.meterText,
    JSON.stringify({ before: occupancyBefore, after: occupancyAfter })
  )
} catch (error) {
  check('需求6 CDP 执行', false, String(error?.stack || error).slice(0, 800))
}

const failures = results.filter((result) => !result.ok)
console.log(`\n===== MANUAL COMPACT CDP: PASS=${results.length - failures.length} FAIL=${failures.length} =====`)
ws.close()
process.exit(failures.length ? 1 : 0)
