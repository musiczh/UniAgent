// Run on request: node scripts/run-ts-test.mjs test/mcp-tool-sessions.tsx
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { isToolSession, type AgentDef, type Session } from '../src/shared/types'
import { emptyNativeCapabilitySnapshot } from '../src/shared/nativeCapabilities'
import { isSidebarSessionEligible } from '../src/renderer/sessionVisibility'
import { unreadAfterReplyStatus } from '../src/renderer/App'
import { SessionList } from '../src/renderer/components/SessionList'
import { Composer } from '../src/renderer/components/Composer'
import { ViewDropdown } from '../src/renderer/components/ViewDropdown'

const agent = {
  id: 'codex', name: 'Codex', adapter: 'codex', installed: true, models: [],
  lifecycle: { availability: 'available' },
  capabilities: { streaming: true, modelSelect: false, reasoningEffort: false, permissionModes: [] }
} as AgentDef
const tool: Session = {
  id: 'tool', title: 'MCP task', status: 'idle', createdAt: 1, updatedAt: 2,
  handoffId: 'task-1', nativeSessionId: 'native-1', origin: 'created',
  config: { agentId: 'codex', workdir: '/repo', permissionMode: 'ask' }
}
const enabled: Session = { ...tool, id: 'enabled', nativeSessionId: 'native-2', handoffUserContinued: true }
const archived: Session = { ...tool, id: 'archived-tool', nativeSessionId: 'native-3', archived: true, pinned: true }
assert.equal(isSidebarSessionEligible(tool, [agent]), false)
assert.equal(isSidebarSessionEligible(archived, [agent]), false)
assert.equal(isSidebarSessionEligible(enabled, [agent]), true, 'legacy human-continued sessions stay normal')
for (const kind of ['main', 'side'] as const) {
  assert.equal(unreadAfterReplyStatus('main', 'running', 'idle', kind, true, tool), undefined)
  assert.equal(unreadAfterReplyStatus(undefined, 'running', 'completed', kind, true, enabled), kind)
}

// Exercise the existing component handlers without starting Electron or live agents.
const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const states: any[] = []
let index = 0
const noop = () => {}
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap((child) => React.isValidElement<any>(child)
    ? [child, ...elements(child.props.children)] : [])
}
const sessions = [tool, enabled, archived]
let selected = ''
function renderList() {
  index = 0
  return SessionList({
    sessions, agents: [agent], activeId: null, statusBySession: {}, unreadBySession: { tool: 'main' },
    onSelect: (id) => { selected = id }, onArchive: noop, onUnarchive: noop, onDelete: noop,
    onArchiveMany: noop, onDeleteMany: noop, onRename: noop, onPin: noop
  })
}
try {
  dispatcher.current = {
    useState(initial: any) {
      const slot = index++
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
      return [states[slot], (next: any) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next }]
    },
    useMemo(value: () => unknown) { return value() },
    useRef(current: unknown) { return { current } }, useEffect() {}, useLayoutEffect() {}
  }
  for (const view of ['全部', '按 Agent', '按项目']) {
    const selector = elements(renderList()).find(element => element.type === ViewDropdown)!
    selector.props.onChange(view === '全部' ? 'all' : view === '按 Agent' ? 'byAgent' : 'byProject')
    assert.deepEqual(elements(renderList()).filter((element) => element.props['data-session-id']).map((element) => element.props['data-session-id']), ['enabled'])
  }
  const toggle = elements(renderList()).find((element) => element.type === 'button' && elements(element).some((child) => child.props.children === '工具会话'))!
  assert.equal(toggle.props['aria-expanded'], false)
  toggle.props.onClick()
  const rows = elements(renderList()).filter((element) => element.props.className?.includes('tool-session'))
  assert.deepEqual(rows.map((row) => row.props['data-session-id']), ['tool', 'archived-tool'])
  assert.ok(rows.every((row) => !row.props.draggable && !row.props.onContextMenu))
  assert.ok(rows.every((row) => elements(row).every((child) => child.props.unread === undefined)))
  rows[0].props.onClick()
  assert.equal(selected, 'tool')
  tool.handoffUserContinued = true
  assert.equal(elements(renderList()).filter((element) => element.props['data-session-id'] === 'tool').length, 1, 'activation moves the row without duplicating it')
} finally {
  delete tool.handoffUserContinued
  dispatcher.current = previous
}
const html = renderToStaticMarkup(React.createElement(Composer, {
  sessionId: tool.id, agent, config: tool.config, status: 'running', toolSessionReadOnly: true,
  onEnableToolSession: async () => {}, onSend: noop, onForceSend: noop, onInterrupt: noop,
  onUpdateConfig: noop, onSetCollaborationMode: noop, onRunNativeAction: noop,
  queue: [{ id: 'queued', prompt: 'MCP follow-up' }], onDequeue: noop, onPromoteQueue: noop, onEditQueueItem: noop,
  capabilities: emptyNativeCapabilitySnapshot('codex', '/repo'), capabilitiesReady: true,
  contextUsed: 0, onCompact: async () => {}, canCompact: false, compacting: false
}))
assert.match(html, /工具会话只读提示/)
assert.match(html, /启用会话/)
assert.match(html, /class="composer-controls" aria-hidden="true"/)
assert.doesNotMatch(html, /class="queue-card-acts"/)

const root = mkdtempSync(join(tmpdir(), 'ua-tool-sessions-'))
try {
  const store = new SessionStore(join(root, 'sessions.json'))
  store.saveOrThrow([tool, archived])
  const orchestrator = new Orchestrator(() => agent, store, join(root, 'artifacts'))
  orchestrator.loadPersisted()
  const current = orchestrator.getSessionById(tool.id)!
  current.status = 'running'
  await assert.rejects(orchestrator.sendMessage(tool.id, 'user send'), /启用/)
  await assert.rejects(orchestrator.forceSend(tool.id, 'Feishu send', undefined, undefined, { source: 'feishu' }), /启用/)
  assert.throws(() => orchestrator.assertUserSessionEnabled(tool.id), /启用/)
  await orchestrator.sendMessage(tool.id, 'MCP follow-up', undefined, undefined, false, { source: 'mcp' })
  assert.equal(orchestrator.getQueue(tool.id)[0]?.prompt, 'MCP follow-up', 'MCP can keep executing before activation')
  assert.equal(isToolSession(current), true)
  const before = structuredClone(current)
  const save = store.saveOrThrow.bind(store)
  store.saveOrThrow = () => { throw new Error('disk unavailable') }
  assert.throws(() => orchestrator.enableToolSession(tool.id), /disk unavailable/)
  assert.equal(isToolSession(current), true, 'failed activation keeps the session read-only')
  assert.equal(current.archived, before.archived)
  assert.equal(current.updatedAt, before.updatedAt)
  assert.equal(current.status, before.status)
  assert.deepEqual(current.pendingQueue, before.pendingQueue)
  store.saveOrThrow = save
  orchestrator.enableToolSession(tool.id)
  assert.equal(isToolSession(current), false)
  assert.equal(current.status, before.status, 'activation does not stop the running task')
  assert.equal(current.nativeSessionId, 'native-1')
  assert.deepEqual(current.pendingQueue, before.pendingQueue)
  assert.doesNotThrow(() => orchestrator.assertUserSessionEnabled(tool.id))
  assert.equal(isToolSession(store.load().find((session) => session.id === tool.id)), false, 'activation survives restart')
  const unarchived = orchestrator.enableToolSession(archived.id)
  assert.equal(unarchived.archived, false)
  assert.equal(unarchived.pinned, true)
  assert.equal(orchestrator.enableToolSession(tool.id), current, 'repeated activation is harmless')
  assert.throws(() => orchestrator.enableToolSession('missing'), /不存在/)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('MCP tool sessions: grouping, unread, read-only and durable activation ok')
