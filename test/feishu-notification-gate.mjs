import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import { build } from 'esbuild'

const directory = await mkdtemp(join(tmpdir(), 'uniagent-feishu-gate-'))
const output = join(directory, 'feishuBridge.mjs')
const power = {
  idleState: 'active',
  idleTime: 0,
  workspaceCallbacks: new Map()
}
globalThis.__UNIAGENT_FEISHU_POWER_TEST__ = power
after(async () => {
  delete globalThis.__UNIAGENT_FEISHU_POWER_TEST__
  await rm(directory, { recursive: true, force: true })
})

await build({
  entryPoints: ['src/main/feishuBridge.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: output,
  plugins: [{
    name: 'electron-power-monitor-stub',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      builder.onResolve({ filter: /^@larksuiteoapi\/node-sdk$/ }, () => ({ path: 'lark-sdk', namespace: 'lark-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents: `
            const state = globalThis.__UNIAGENT_FEISHU_POWER_TEST__;
            export const powerMonitor = {
              on() {}, off() {},
              getSystemIdleState() { return state.idleState; },
              getSystemIdleTime() { return state.idleTime; }
            };
            export const systemPreferences = {
              subscribeWorkspaceNotification(name, callback) {
                state.workspaceCallbacks.set(name, callback);
                return state.workspaceCallbacks.size;
              },
              unsubscribeWorkspaceNotification() {}
            };
          `
      }))
      builder.onLoad({ filter: /.*/, namespace: 'lark-stub' }, () => ({
        contents: `
            export class WSClient {}
            export class Client {}
            export class EventDispatcher { register() { return this; } }
            export const defaultHttpInstance = {}
            export function normalizeCardAction(value) { return value; }
          `
      }))
    }
  }]
})

const { FeishuBridge } = await import(`${pathToFileURL(output).href}?${Date.now()}`)
const settings = {
  enabled: true,
  appId: '',
  appSecret: '',
  notifyChatId: 'configured-notification-target',
  notifyOnlyWhenLocked: true,
  idleThresholdSec: 300
}
let driver
let session
const bridge = new FeishuBridge({
  orchestrator: { getSessionById: () => session },
  threadStore: { bySession: () => driver ? { driver } : undefined },
  getAgents: () => [],
  getSettings: () => settings,
  onStatus: () => {}
})

test('an active unlocked Mac does not notify before the configured five-minute threshold', () => {
  power.idleState = 'active'
  power.idleTime = 299
  assert.equal(bridge.shouldPush(), false)
  power.idleTime = 300
  assert.equal(bridge.shouldPush(), true)
})

test('disabling idle-time notification does not notify on an unlocked awake Mac', () => {
  settings.idleThresholdSec = 0
  power.idleState = 'idle'
  power.idleTime = 86_400
  assert.equal(bridge.shouldPush(), false)
})

test('disabling idle-time notification still notifies while the system is locked', () => {
  settings.idleThresholdSec = 0
  power.idleState = 'locked'
  assert.equal(bridge.shouldPush(), true)
  power.idleState = 'active'
  assert.equal(bridge.shouldPush(), false)
})

test('disabling idle-time notification still notifies after the display sleeps', () => {
  settings.idleThresholdSec = 0
  power.idleState = 'idle'
  power.idleTime = 86_400
  const sleep = power.workspaceCallbacks.get('NSWorkspaceScreensDidSleepNotification')
  assert.equal(typeof sleep, 'function', 'the bridge subscribes to the real macOS display-sleep event')
  sleep()
  assert.equal(bridge.shouldPush(), true)
  const wake = power.workspaceCallbacks.get('NSWorkspaceScreensDidWakeNotification')
  assert.equal(typeof wake, 'function', 'the bridge subscribes to the real macOS display-wake event')
  wake()
  assert.equal(bridge.shouldPush(), false)
})

test('a Feishu-driven session keeps its existing immediate-reply behavior', () => {
  settings.idleThresholdSec = 0
  power.idleState = 'active'
  power.idleTime = 0
  driver = 'feishu'
  assert.equal(bridge.shouldPushFor('feishu-session'), true)
  driver = undefined
})

test('an MCP-created session only notifies for the current user-authored turn', () => {
  session = {
    handoffId: 'mcp-task',
    handoffUserContinued: true,
    submittedUserMessages: [{ source: 'mcp' }]
  }
  try {
    power.idleState = 'locked'
    assert.equal(bridge.shouldPushFor('mcp-session'), false, 'locking the Mac does not opt in an MCP task')
    settings.notifyOnlyWhenLocked = false
    assert.equal(bridge.shouldPushFor('mcp-session'), false, 'always-notify still excludes MCP tasks')
    driver = 'feishu'
    assert.equal(bridge.shouldPushFor('mcp-session'), false, 'a previously bound thread does not imply manual continuation')

    session.submittedUserMessages = [{ source: 'app' }]
    assert.equal(bridge.shouldPushFor('mcp-session'), true, 'manual continuation enables normal Feishu replies')
    session.submittedUserMessages = [{ source: 'mcp' }]
    assert.equal(bridge.shouldPushFor('mcp-session'), false, 'a later MCP follow-up is silent again')
    session.submittedUserMessages = [{ source: 'app' }]
    driver = undefined
    settings.notifyOnlyWhenLocked = true
    power.idleState = 'active'
    power.idleTime = 0
    assert.equal(bridge.shouldPushFor('mcp-session'), false, 'app continuation still respects the lock/idle gate')
    power.idleState = 'locked'
    assert.equal(bridge.shouldPushFor('mcp-session'), true)
  } finally {
    session = undefined
    driver = undefined
    settings.notifyOnlyWhenLocked = true
    power.idleState = 'active'
  }
})
