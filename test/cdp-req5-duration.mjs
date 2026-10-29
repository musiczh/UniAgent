// Req5 packaged-app verification: historical sub-agent duration fidelity and
// same-thread redispatch generations. The app must be launched with --ua-e2e
// and a remote debugging port before running this script.
//
// Usage: node test/cdp-req5-duration.mjs [port] [agentId]

// This verifier creates one exact TraeX rollout fixture, reads it back through
// the packaged app's real previewHistory IPC, injects the normalized events into
// an isolated disposable sidebar session, and checks the rendered sub-agent
// detail panel.

// Both the exact rollout file and disposable host session are removed in finally.
// e2eInjectEvents itself still sends renderer-only events.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const port = process.argv[2] || '9222'
const hostAgentId = process.argv[3] || 'codex'
const fixtureId = randomUUID()
const childId = randomUUID()
const childName = `req5-duration-${childId.slice(0, 8)}`
const generation1Dispatch = `req5-generation-1-${fixtureId}`
const generation1Prompt = `REQ5 generation 1 ${fixtureId}`
const hostPrompt = `REQ5 disposable renderer host ${fixtureId}`
const turnBoundaryText = `REQ5 isolated lifecycle turn ${fixtureId}`
const fixtureWrittenAt = Date.now()
const generation1Start = fixtureWrittenAt - 9_000
const generation1End = generation1Start + 4_200
const unrelatedParentTail = generation1End + 6 * 60 * 60 * 1_000
const dateParts = new Date(fixtureWrittenAt).toISOString().slice(0, 10).split('-')
const fixtureDir = join(homedir(), '.trae', 'cli', 'sessions', ...dateParts)
const fixtureStamp = new Date(fixtureWrittenAt).toISOString().replace(/[:.]/g, '-')
const fixtureFile = join(fixtureDir, `rollout-${fixtureStamp}-${fixtureId}.jsonl`)
const childFixtureFile = join(fixtureDir, `rollout-${fixtureStamp}-child-${childId}.jsonl`)

const results = []
const check = (label, ok, detail = '') => {
  const passed = !!ok
  results.push({ label, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let ws = null
let fixtureSessionId = null
let requestId = 0
const pending = new Map()

async function getPage() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const page =
        targets.find((target) => target.type === 'page' && /index\.html/.test(target.url || '')) ||
        targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await sleep(250)
  }
  throw new Error(`no packaged-app page target on CDP port ${port}`)
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`CDP socket is not open for ${method}`))
      return
    }
    const id = ++requestId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} timed out`))
    }, 30_000)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(body) {
  const response = await send('Runtime.evaluate', {
    expression: `(async()=>{${body}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'Runtime.evaluate failed'
    )
  }
  return response.result?.value
}

async function waitFor(label, body, timeoutMs = 8_000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await evaluate(body)
      if (last) return last
    } catch (error) {
      // A renderer reload briefly destroys its JavaScript execution context.
      // Treat that as a transient poll miss and keep the last useful diagnostic.
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

function subAgentEvents(events) {
  return events.filter((event) => event.type === 'subagent')
}

try {
  const rollout = [
    {
      timestamp: new Date(generation1Start - 500).toISOString(),
      type: 'session_meta',
      payload: { id: fixtureId, cwd: process.cwd() }
    },
    {
      timestamp: new Date(generation1Start).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'sub_agent_activity',
        agent_thread_id: childId,
        agent_path: `/req5/${childName}.md`,
        kind: 'started',
        occurred_at_ms: generation1Start,
        event_id: generation1Dispatch
      }
    },
    {
      timestamp: new Date(unrelatedParentTail).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        message: `REQ5 unrelated late parent activity ${fixtureId}`
      }
    }
  ]
  const childRollout = [
    {
      timestamp: new Date(generation1Start).toISOString(),
      type: 'session_meta',
      payload: {
        id: childId,
        cwd: process.cwd(),
        parent_thread_id: fixtureId,
        source: { subagent: { thread_spawn: { parent_thread_id: fixtureId } } }
      }
    },
    {
      timestamp: new Date(generation1End).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', message: `REQ5 child completed ${fixtureId}` }
    }
  ]

  await mkdir(fixtureDir, { recursive: true })
  await writeFile(fixtureFile, `${rollout.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
  await writeFile(childFixtureFile, `${childRollout.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })

  const page = await getPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  ws.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('CDP socket closed'))
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  await send('Runtime.enable')
  await send('Page.enable')

  await waitFor(
    'preload API',
    `return typeof window.uniagent?.previewHistory === 'function' &&
      typeof window.uniagent?.e2eInjectEvents === 'function';`
  )
  const e2eEnabled = await evaluate(`return await window.uniagent.e2eEnabled();`)
  check(
    'packaged app exposes the guarded --ua-e2e fixture surface',
    e2eEnabled === true,
    `e2eEnabled=${String(e2eEnabled)}`
  )
  if (!e2eEnabled) throw new Error('launch UniAgent with both --ua-e2e and --remote-debugging-port')

  const preview = JSON.parse(
    await evaluate(`
      const preview = await window.uniagent.previewHistory('traex', ${JSON.stringify(fixtureId)});
      return JSON.stringify(preview);
    `)
  )
  const historical = subAgentEvents(preview.events || [])
  const historicalStart = historical[0]?.payload?.agents?.[0]
  const historicalEnd = historical[historical.length - 1]?.payload?.agents?.[0]
  const previewObservedAt = Date.now()
  const historyFacts = {
    count: historical.length,
    startTs: historical[0]?.ts,
    endTs: historical[historical.length - 1]?.ts,
    startedAt: historicalStart?.startedAt,
    endedAt: historicalEnd?.endedAt,
    startGeneration: historicalStart?.generation,
    endGeneration: historicalEnd?.generation,
    endStatus: historicalEnd?.status,
    startAgeMs: previewObservedAt - (historicalStart?.startedAt ?? previewObservedAt),
    endAgeMs: previewObservedAt - (historicalEnd?.endedAt ?? previewObservedAt)
  }
  check(
    'previewHistory bounds child duration by its rollout despite a 6h parent tail',
    historical.length === 2 &&
      historyFacts.startTs === generation1Start &&
      historyFacts.endTs === generation1End &&
      historyFacts.startedAt === generation1Start &&
      historyFacts.endedAt === generation1End &&
      historyFacts.endedAt - historyFacts.startedAt === 4_200 &&
      historyFacts.startGeneration === 1 &&
      historyFacts.endGeneration === 1 &&
      historyFacts.endStatus === 'completed',
    JSON.stringify(historyFacts)
  )
  check(
    'historical timestamps precede preview time by a reasonable bounded interval',
    historyFacts.startAgeMs >= 4_200 &&
      historyFacts.endAgeMs >= 0 &&
      historyFacts.startAgeMs <= 120_000 &&
      historyFacts.endAgeMs <= 120_000 &&
      historyFacts.startAgeMs - historyFacts.endAgeMs === 4_200,
    `startAge=${historyFacts.startAgeMs}ms endAge=${historyFacts.endAgeMs}ms`
  )
  if (historical.length !== 2 || !historicalStart || !historicalEnd) {
    throw new Error(`previewHistory returned an invalid sub-agent fixture: ${JSON.stringify(historyFacts)}`)
  }

  // Create a disposable host using an actually available agent. Lifecycle
  // validation intentionally rejects unknown agents, so using a fake id here
  // would only test the gate instead of the packaged renderer. The session is
  // deleted in finally, which also disposes any short-lived runner.
  const fixtureSession = JSON.parse(
    await evaluate(`
      const session = await window.uniagent.createSession({
        agentId: ${JSON.stringify(hostAgentId)},
        workdir: window.uniagent.homeDir,
        permissionMode: 'read-only'
      }, ${JSON.stringify(hostPrompt)});
      return JSON.stringify(session);
    `)
  )
  fixtureSessionId = fixtureSession?.id || null
  check(
    'created an isolated disposable renderer session',
    !!fixtureSessionId,
    JSON.stringify({ id: fixtureSessionId, status: fixtureSession?.status })
  )
  if (!fixtureSessionId) throw new Error('failed to create disposable renderer session')

  await send('Page.reload', { ignoreCache: false })
  await waitFor(
    'preload API after renderer reload',
    `return typeof window.uniagent?.listSessions === 'function' &&
      typeof window.uniagent?.e2eInjectEvents === 'function';`,
    12_000
  )

  const selected = JSON.parse(
    await waitFor(
      'disposable sidebar session row',
      `
      document.querySelector('.subagent-panel .close-x')?.click();
      document.querySelector('.sidebar-reveal')?.click();
      const allTab = [...document.querySelectorAll('button.sl-tab')]
        .find((button) => (button.textContent || '').trim() === '全部');
      allTab?.click();
      const session = (await window.uniagent.listSessions())
        .find((candidate) => candidate.id === ${JSON.stringify(fixtureSessionId)});
      const row = [...document.querySelectorAll('.session-item[data-session-id]')]
        .find((candidate) => candidate.getAttribute('data-session-id') === ${JSON.stringify(fixtureSessionId)});
      if (!session || !row) return '';
      row.click();
      return JSON.stringify({
        id: session.id,
        agentId: session.config?.agentId,
        title: session.title
      });
    `,
      12_000
    )
  )
  await waitFor(
    'disposable session view and hydrated host turn',
    `
      const row = document.querySelector(
        '.session-item[data-session-id=${JSON.stringify(fixtureSessionId)}]'
      );
      const bubbles = [...document.querySelectorAll('.session-view .user-msg .bubble')];
      return !!document.querySelector('.session-view') &&
        !!row?.classList.contains('active') &&
        bubbles.some((bubble) => (bubble.textContent || '').includes(${JSON.stringify(hostPrompt)}));
    `,
    12_000
  )
  check(
    'selected and hydrated the isolated renderer session',
    selected.id === fixtureSessionId,
    JSON.stringify(selected)
  )
  if (selected.id !== fixtureSessionId) {
    throw new Error('disposable session view did not mount')
  }

  const turnBoundary = {
    sessionId: selected.id,
    seq: fixtureWrittenAt * 10 - 1,
    ts: generation1Start - 1,
    type: 'user_message',
    payload: { id: `req5-turn-boundary-${fixtureId}`, text: turnBoundaryText }
  }
  const injectedHistorical = historical.map((event, index) => ({
    ...event,
    sessionId: selected.id,
    seq: fixtureWrittenAt * 10 + index
  }))
  const injectedGeneration1 = await evaluate(`
    return await window.uniagent.e2eInjectEvents(${JSON.stringify([turnBoundary, ...injectedHistorical])});
  `)
  check(
    'injected a visible turn boundary and previewHistory events into the isolated session',
    injectedGeneration1 === true,
    `accepted=${String(injectedGeneration1)} events=${injectedHistorical.length + 1}`
  )
  await waitFor(
    'isolated injected turn boundary',
    `return [...document.querySelectorAll('.session-view .user-msg .bubble')]
      .some((bubble) => (bubble.textContent || '').includes(${JSON.stringify(turnBoundaryText)}));`
  )

  await waitFor(
    'generation 1 inline lifecycle rows',
    `
      const rows = [...document.querySelectorAll('.session-view .sa-line')];
      return rows.some((row) =>
        (row.querySelector('.nm')?.textContent || '').trim() === ${JSON.stringify(childName)} &&
        (row.querySelector('.st')?.textContent || '').includes('开始工作')
      ) && rows.some((row) =>
        (row.querySelector('.nm')?.textContent || '').trim() === ${JSON.stringify(childName)} &&
        (row.querySelector('.st')?.textContent || '').includes('已完成')
      );
    `
  )
  await evaluate(`
    const row = [...document.querySelectorAll('.session-view .sa-line')].find((candidate) =>
      (candidate.querySelector('.nm')?.textContent || '').trim() === ${JSON.stringify(childName)} &&
      (candidate.querySelector('.st')?.textContent || '').includes('开始工作')
    );
    row?.click();
    return !!row;
  `)
  await waitFor(
    'generation 1 sub-agent detail panel',
    `return !!document.querySelector('.subagent-panel .subagent-detailpage .detail-sub');`
  )
  const generation1Dom = JSON.parse(
    await evaluate(`
      const detail = document.querySelector('.subagent-panel .subagent-detailpage');
      const norm = (node) => (node?.textContent || '').replace(/\\s+/g, ' ').trim();
      return JSON.stringify({
        name: norm(detail?.querySelector('.detail-nm')),
        status: norm(detail?.querySelector('.detail-sub')),
        panelCount: document.querySelectorAll('.subagent-panel').length
      });
    `)
  )
  check(
    'generation 1 detail uses historical duration (用时 4 秒)',
    generation1Dom.panelCount === 1 &&
      generation1Dom.name === childName &&
      generation1Dom.status.includes('已完成') &&
      generation1Dom.status.includes('用时 4 秒') &&
      !generation1Dom.status.includes('已处理'),
    JSON.stringify(generation1Dom)
  )

  await sleep(1_100)
  const generation1Stable = await evaluate(`
    const text = document.querySelector('.subagent-panel .detail-sub')?.textContent || '';
    return text.replace(/\\s+/g, ' ').trim();
  `)
  check(
    'generation 1 terminal duration stays frozen after panel load',
    generation1Stable === generation1Dom.status && generation1Stable.includes('用时 4 秒'),
    `before="${generation1Dom.status}" after="${generation1Stable}"`
  )
  await evaluate(`document.querySelector('.subagent-panel .close-x')?.click(); return true;`)
  await waitFor('generation 1 detail panel close', `return !document.querySelector('.subagent-panel');`)

  const generation2Dispatch = `req5-generation-2-${fixtureId}`
  const generation2Prompt = `REQ5 generation 2 new prompt ${fixtureId}`
  const generation2Start = Date.now()
  const generation2Running = {
    sessionId: selected.id,
    seq: fixtureWrittenAt * 10 + injectedHistorical.length + 1,
    ts: generation2Start,
    type: 'subagent',
    state: 'running',
    payload: {
      id: generation2Dispatch,
      agents: [
        {
          agentThreadId: childId,
          status: 'running',
          name: childName,
          tool: 'sendInput',
          prompt: generation2Prompt,
          dispatchId: generation2Dispatch,
          generation: 2,
          startedAt: generation2Start
        }
      ]
    }
  }
  const acceptedGeneration2 = await evaluate(`
    return await window.uniagent.e2eInjectEvents([${JSON.stringify(generation2Running)}]);
  `)
  check(
    'explicit generation 2 sendInput event is accepted',
    acceptedGeneration2 === true,
    `accepted=${String(acceptedGeneration2)} startedAt=${generation2Start}`
  )

  const secondStartCount = await waitFor(
    'second 开始工作 row for the same child',
    `
      const rows = [...document.querySelectorAll('.session-view .sa-line')].filter((row) =>
        (row.querySelector('.nm')?.textContent || '').trim() === ${JSON.stringify(childName)} &&
        (row.querySelector('.st')?.textContent || '').includes('开始工作')
      );
      return rows.length >= 2 ? rows.length : 0;
    `
  )
  await evaluate(`
    const rows = [...document.querySelectorAll('.session-view .sa-line')].filter((row) =>
      (row.querySelector('.nm')?.textContent || '').trim() === ${JSON.stringify(childName)} &&
      (row.querySelector('.st')?.textContent || '').includes('开始工作')
    );
    rows[rows.length - 1]?.click();
    return rows.length;
  `)
  await waitFor(
    'generation 2 detail panel',
    `return !!document.querySelector('.subagent-panel .subagent-detailpage .detail-sub');`
  )
  const generation2Dom = JSON.parse(
    await evaluate(`
      const detail = document.querySelector('.subagent-panel .subagent-detailpage');
      const norm = (node) => (node?.textContent || '').replace(/\\s+/g, ' ').trim();
      const status = norm(detail?.querySelector('.detail-sub'));
      const elapsed = status.match(/已处理\\s*(\\d+)\\s*秒/);
      const prompts = [...detail?.querySelectorAll('.subagent-detail-stream .user-msg .bubble') || []]
        .map((node) => norm(node));
      return JSON.stringify({
        name: norm(detail?.querySelector('.detail-nm')),
        status,
        elapsedSeconds: elapsed ? Number(elapsed[1]) : null,
        prompts
      });
    `)
  )
  check(
    'same child reopens for generation 2 with a restarted small elapsed time',
    secondStartCount === 2 &&
      generation2Dom.name === childName &&
      generation2Dom.status.includes('进行中') &&
      Number.isInteger(generation2Dom.elapsedSeconds) &&
      generation2Dom.elapsedSeconds >= 0 &&
      generation2Dom.elapsedSeconds <= Math.ceil((Date.now() - generation2Start) / 1_000) + 2 &&
      generation2Dom.prompts.includes(generation2Prompt),
    JSON.stringify({ secondStartCount, ...generation2Dom })
  )

  const lateGeneration1 = {
    sessionId: selected.id,
    seq: generation2Running.seq + 1,
    ts: Date.now(),
    type: 'subagent',
    state: 'running',
    payload: {
      id: `req5-late-generation-1-${fixtureId}`,
      agents: [
        {
          agentThreadId: childId,
          status: 'running',
          name: childName,
          tool: 'wait',
          prompt: generation1Prompt,
          message: 'late generation 1 running tick',
          dispatchId: generation1Dispatch,
          generation: 1,
          startedAt: generation1Start
        }
      ]
    }
  }
  const acceptedLate = await evaluate(`
    return await window.uniagent.e2eInjectEvents([
      ${JSON.stringify(lateGeneration1)},
      {
        sessionId: ${JSON.stringify(selected.id)},
        seq: ${lateGeneration1.seq + 1},
        ts: Date.now(),
        type: 'system_notice',
        payload: {
          id: ${JSON.stringify(`req5-late-observed-${fixtureId}`)},
          kind: 'notice',
          text: ${JSON.stringify(`REQ5 late-generation checkpoint ${fixtureId}`)}
        }
      }
    ]);
  `)
  const afterLate = JSON.parse(
    await waitFor(
      'late generation 1 event renderer checkpoint',
      `
      const checkpointSeen = [...document.querySelectorAll('.session-view .system-notice')]
        .some((node) => (node.textContent || '').includes(${JSON.stringify(`REQ5 late-generation checkpoint ${fixtureId}`)}));
      if (!checkpointSeen) return '';
      const detail = document.querySelector('.subagent-panel .subagent-detailpage');
      const norm = (node) => (node?.textContent || '').replace(/\\s+/g, ' ').trim();
      const status = norm(detail?.querySelector('.detail-sub'));
      const elapsed = status.match(/已处理\\s*(\\d+)\\s*秒/);
      const prompts = [...detail?.querySelectorAll('.subagent-detail-stream .user-msg .bubble') || []]
        .map((node) => norm(node));
      const startRows = [...document.querySelectorAll('.session-view .sa-line')].filter((row) =>
        (row.querySelector('.nm')?.textContent || '').trim() === ${JSON.stringify(childName)} &&
        (row.querySelector('.st')?.textContent || '').includes('开始工作')
      ).length;
      return JSON.stringify({ status, elapsedSeconds: elapsed ? Number(elapsed[1]) : null, prompts, startRows });
    `
    )
  )
  check(
    'late generation 1 running tick cannot overwrite generation 2',
    acceptedLate === true &&
      afterLate.status.includes('进行中') &&
      Number.isInteger(afterLate.elapsedSeconds) &&
      afterLate.elapsedSeconds <= Math.ceil((Date.now() - generation2Start) / 1_000) + 2 &&
      afterLate.prompts.includes(generation2Prompt) &&
      !afterLate.prompts.includes(generation1Prompt) &&
      afterLate.startRows === 2,
    JSON.stringify(afterLate)
  )

  // Keep this deterministic and independent of how long the preceding DOM
  // assertions took: an explicit endedAt is the lifecycle source of truth.
  const generation2End = generation2Start + 2_400
  const generation2Completed = {
    sessionId: selected.id,
    seq: lateGeneration1.seq + 2,
    ts: generation2End,
    type: 'subagent',
    state: 'success',
    payload: {
      id: `req5-generation-2-completed-${fixtureId}`,
      agents: [
        {
          agentThreadId: childId,
          status: 'completed',
          name: childName,
          tool: 'sendInput',
          dispatchId: generation2Dispatch,
          generation: 2,
          startedAt: generation2Start,
          endedAt: generation2End
        }
      ]
    }
  }
  const acceptedCompletion = await evaluate(`
    return await window.uniagent.e2eInjectEvents([${JSON.stringify(generation2Completed)}]);
  `)
  await waitFor(
    'generation 2 terminal detail',
    `
      const text = document.querySelector('.subagent-panel .detail-sub')?.textContent || '';
      return text.includes('已完成') && text.includes('用时 2 秒');
    `
  )
  const terminalBefore = await evaluate(`
    return (document.querySelector('.subagent-panel .detail-sub')?.textContent || '')
      .replace(/\\s+/g, ' ').trim();
  `)
  await sleep(1_100)
  const terminalAfter = await evaluate(`
    return (document.querySelector('.subagent-panel .detail-sub')?.textContent || '')
      .replace(/\\s+/g, ' ').trim();
  `)
  check(
    'generation 2 completion shows a frozen terminal elapsed duration',
    acceptedCompletion === true &&
      terminalBefore.includes('已完成') &&
      terminalBefore.includes('用时 2 秒') &&
      !terminalBefore.includes('已处理') &&
      terminalAfter === terminalBefore,
    `before="${terminalBefore}" after="${terminalAfter}"`
  )
} catch (error) {
  check('Req5 CDP verifier completed without fatal error', false, error?.stack || String(error))
} finally {
  if (fixtureSessionId && ws && ws.readyState === WebSocket.OPEN) {
    try {
      const removed = await evaluate(`
        await window.uniagent.deleteSession(${JSON.stringify(fixtureSessionId)});
        return !(await window.uniagent.listSessions())
          .some((session) => session.id === ${JSON.stringify(fixtureSessionId)});
      `)
      check('removed the disposable renderer session', removed === true, fixtureSessionId)
    } catch (error) {
      check('removed the disposable renderer session', false, String(error))
    }
  }
  if (ws && ws.readyState < WebSocket.CLOSING) ws.close()
  try {
    await Promise.all([rm(fixtureFile, { force: true }), rm(childFixtureFile, { force: true })])
    check('removed the exact temporary rollout fixtures', true, `${fixtureFile}, ${childFixtureFile}`)
  } catch (error) {
    check('removed the exact temporary rollout fixtures', false, String(error))
  }
}

const failures = results.filter((result) => !result.passed)
console.log(
  `\nREQ5 CDP ${failures.length === 0 ? 'PASS' : 'FAIL'}: ` +
    `${results.length - failures.length}/${results.length} checks passed`
)
process.exitCode = failures.length === 0 ? 0 : 1
