import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { SessionAttentionBadge } from '../src/main/appNotifications'
import { SessionAttentionStore } from '../src/main/sessionAttentionStore'
import { teamRowSessionIds } from '../src/shared/teamAttention'
import { IPC, type Session, type UAEvent } from '../src/shared/types'

// Execute the actual main-process initializers, subscriptions and IPC handlers.
// The optional source path lets the same regression verify an isolated Git index.
const source = await readFile(process.env.UA_ATTENTION_WIRING_SOURCE || 'src/main/index.ts', 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const variables = new Set(['sessionAttentionStore', 'sessionAttentionReady', 'sessionAttentionLoaded', 'sessionBadge', 'teamRowIds'])
const functions = new Set(['restoreSessionAttention', 'refreshTeamRowIds', 'badgeOwner', 'badgeOwnerId', 'forgetBadgeSession'])
const events = new Set(['sessionCreated', 'sessionArchived', 'sessionDeleted', 'sideStatus', 'sessionUpdated'])
const selected: string[] = []
const references = (node: ts.Node, name: string): boolean => ts.isIdentifier(node) && node.text === name || !!ts.forEachChild(node, child => references(child, name) || undefined)
for (const statement of ast.statements) {
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => variables.has(declaration.name.getText(ast)))) selected.push(statement.getText(ast))
  if (ts.isFunctionDeclaration(statement) && statement.name && functions.has(statement.name.text)) selected.push(statement.getText(ast))
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
  const call = statement.expression, target = call.expression.getText(ast)
  const event = call.arguments[0]
  if (target === 'refreshTeamRowIds' || target === 'teams.on' && references(call, 'refreshTeamRowIds') || target === 'orchestrator.on' && event && ts.isStringLiteral(event) && events.has(event.text) && references(call, 'sessionBadge')) selected.push(statement.getText(ast))
}
const register = ast.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'registerIpc')
for (const statement of register?.body?.statements || []) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
  const call = statement.expression, channel = call.arguments[0]
  if (call.expression.getText(ast) === 'ipcMain.handle' && channel && ts.isPropertyAccessExpression(channel) && ['sessionAttentionGet', 'sessionBadgeVisible'].includes(channel.name.text)) selected.push(statement.getText(ast))
}

const directory = await mkdtemp(join(tmpdir(), 'uniagent-attention-wiring-'))
const session: Session = { id: 'task', title: 'task', status: 'idle', createdAt: 1, config: { agentId: 'codex', workdir: '/fixture' } }
const sessions = new Map([[session.id, session]])
const handlers = new Map<string, (...args: any[]) => any>(), badges: string[] = [], errors: unknown[] = []
let focused = false
const orchestrator = Object.assign(new EventEmitter(), {
  getSessionById: (id: string) => sessions.get(id), managedSessions: () => [...sessions.values()],
  getEvents: async () => [], getSideEvents: () => []
})
const teams = Object.assign(new EventEmitter(), { store: { projectList: () => [] } })
const noop = () => {}
const context = vm.createContext({
  SessionAttentionBadge, SessionAttentionStore, teamRowSessionIds, IPC, join, structuredClone,
  resolveUserDataHome: () => directory, startupSessionHydration: Promise.resolve(),
  process: { platform: 'darwin' }, app: { dock: { setBadge: (text: string) => badges.push(text) } },
  mainWindow: { isDestroyed: () => false, isFocused: () => focused, isVisible: () => true, isMinimized: () => false, webContents: { send: noop } },
  orchestrator, teams, ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) },
  assertTrustedCapabilitySyncIpc: noop, recordRuntime: (...args: unknown[]) => errors.push(args),
  comments: { syncPermissions: async () => {} }, feishuBridge: { handleSessionUpdated: noop }, assistantFeishuBridge: { handleSessionUpdated: noop },
  handoffTaskStore: { isActive: () => false, removeSession: noop }, handoffWaits: new Map(), handoffSessions: new Map()
})
let store: SessionAttentionStore | undefined
try {
  vm.runInContext(ts.transpileModule(selected.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  assert.ok(handlers.has(IPC.sessionAttentionGet), 'the attention IPC must be registered before the startup IPC is invoked')
  assert.ok(handlers.has(IPC.sessionBadgeVisible))
  const snapshot = () => handlers.get(IPC.sessionAttentionGet)!({}, { unread: {}, pending: {} })
  assert.deepEqual((await snapshot()).unreadBySession, {})
  store = vm.runInContext('sessionAttentionStore', context)
  const badge: SessionAttentionBadge = vm.runInContext('sessionBadge', context)
  orchestrator.emit('sessionCreated', session)
  const update = (patch: Partial<Session>) => { Object.assign(session, patch); orchestrator.emit('sessionUpdated', { session }) }
  update({ status: 'running' }); update({ status: 'completed' })
  assert.deepEqual((await snapshot()).unreadBySession, { task: 'main' }, 'session snapshots drive the same Dock ledger')
  focused = true
  await handlers.get(IPC.sessionBadgeVisible)!({}, session.id)
  assert.deepEqual((await snapshot()).unreadBySession, {})
  focused = false
  await handlers.get(IPC.sessionBadgeVisible)!({}, null)
  orchestrator.emit('sideStatus', { sessionId: session.id, status: 'running' })
  orchestrator.emit('sideStatus', { sessionId: session.id, status: 'idle' })
  assert.deepEqual((await snapshot()).unreadBySession, { task: 'side' }, 'side status subscriptions reach the unread ledger')
  assert.equal(vm.runInContext("badgeOwnerId('task')", context), session.id, 'owner lookup does not recursively remap the ledger')
  const completed: UAEvent = { sessionId: session.id, seq: 10, ts: 10, type: 'turn_completed', state: 'success', payload: {} }
  badge.handleEvent(completed, session, 'side')
  session.archived = true; orchestrator.emit('sessionArchived', session.id); orchestrator.emit('sessionUpdated', { session })
  assert.deepEqual((await snapshot()).unreadBySession, {})
  update({ archived: false })
  badge.handleEvent(completed, session, 'side')
  assert.deepEqual((await snapshot()).unreadBySession, {}, 'the archive event and subsequent snapshot retain old read identities')
  orchestrator.emit('sessionDeleted', session.id)
  assert.deepEqual((await snapshot()).unreadBySession, {}, 'deletion executes without an unrelated session variable')
  assert.equal(badges.at(-1), '')
  assert.deepEqual(errors, [])
  console.log('PASS actual main attention initialization, IPC registration, status wiring, owner lookup, archive/read and deletion')
} finally {
  await store?.flush()
  await rm(directory, { recursive: true, force: true })
}
