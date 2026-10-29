// Run on request: node scripts/run-ts-test.mjs test/requirement-switch-ui.tsx
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RequirementSettings } from '../src/renderer/components/RequirementSettings'
import { SessionList } from '../src/renderer/components/SessionList'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'
import { NewTaskPanel } from '../src/renderer/components/NewTaskPanel'
import { RequirementPicker } from '../src/renderer/components/RequirementPicker'
import { ViewDropdown } from '../src/renderer/components/ViewDropdown'
import { ToggleSwitch } from '../src/renderer/components/Icons'
import type { Requirement } from '../src/shared/requirementTypes'
import type { AgentDef, Session } from '../src/shared/types'

const dispatcher = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const states: unknown[] = []
let index = 0
dispatcher.current = {
  useState(initial: unknown) {
    const slot = index++
    if (!(slot in states)) states[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [states[slot], (next: unknown) => { states[slot] = typeof next === 'function' ? (next as (v: unknown) => unknown)(states[slot]) : next }]
  },
  useRef(initial: unknown) { return { current: initial } },
  useMemo(value: () => unknown) { return value() },
  useCallback(value: unknown) { return value },
  useEffect() {},
  useLayoutEffect() {}
}

function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement<any>(child)) return []
    // SetRow 把开关放在 control prop 里，须一并遍历才能拿到 ToggleSwitch 元素。
    const control = child.props.control
    return [child, ...elements(child.props.children), ...(React.isValidElement<any>(control) ? elements(control) : [])]
  })
}
const requirement: Requirement = { id: 'req', name: '共享需求', dir: '/requirements/共享需求', docPath: '/requirements/共享需求/context.md', status: 'active', createdAt: 1, updatedAt: 1 }
function renderSettings(enabled: boolean, toggles: boolean[]) {
  index = 0
  return RequirementSettings({ enabled, onToggle: checked => toggles.push(checked) })
}

try {
  index = 0
  const settings = elements(SettingsPanel({
    initialCategory: 'requirements', agents: [], onRedetect() {}, onInitialize() {},
    onAgentsChanged() {}, onOpenSync() {}, onBack() {}
  })).find(e => e.type === RequirementSettings)
  assert.ok(settings, 'requirement settings remain accessible')
  assert.equal(settings.props.enabled, false, 'settings start disabled before configuration loads')

  // 关闭态：保留开关与「已停用」说明，隐藏需求列表、新建入口与说明文案。
  const offToggles: boolean[] = []
  states.length = 0
  states[0] = [requirement] // useRequirements 的列表槽位：关闭态也不得外泄列表内容
  const off = renderSettings(false, offToggles)
  const offMarkup = renderToStaticMarkup(off)
  assert.match(offMarkup, /启用需求/, 'switch stays visible while disabled so the feature can be re-enabled')
  assert.match(offMarkup, /需求功能已停用/)
  assert.match(offMarkup, /已有需求数据与会话关联完整保留/)
  assert.doesNotMatch(offMarkup, /新建需求/)
  assert.doesNotMatch(offMarkup, /共享需求/, 'requirement rows stay hidden while disabled')
  assert.doesNotMatch(offMarkup, /每个需求拥有独立目录/)
  const offSwitch = elements(off).find(e => e.type === ToggleSwitch)
  assert.ok(offSwitch, 'toggle switch renders in the disabled state')
  assert.equal(offSwitch!.props.checked, false)
  assert.equal(offSwitch!.props.label, '启用需求')
  offSwitch!.props.onChange(true)
  assert.deepEqual(offToggles, [true], 'switch reports the requested enable')

  // 开启态：列表与新建入口恢复，无「已停用」说明。
  const onToggles: boolean[] = []
  states.length = 0
  states[0] = [requirement]
  const on = renderSettings(true, onToggles)
  const onMarkup = renderToStaticMarkup(on)
  assert.match(onMarkup, /启用需求/)
  assert.match(onMarkup, /新建需求/)
  assert.match(onMarkup, /共享需求/)
  assert.match(onMarkup, /每个需求拥有独立目录/)
  assert.doesNotMatch(onMarkup, /需求功能已停用/)
  const onSwitch = elements(on).find(e => e.type === ToggleSwitch)
  assert.equal(onSwitch!.props.checked, true)
  onSwitch!.props.onChange(false)
  assert.deepEqual(onToggles, [false], 'switch reports the requested disable')

  // 会话列表视图：关闭时去掉「按需求」视图项，开启时保留。
  const noop = () => {}
  const agents = [{ id: 'codex', name: 'Codex', lifecycle: { availability: 'available' } }] as AgentDef[]
  const sessions: Session[] = [{
    id: 's1', title: '会话', status: 'idle', createdAt: 1,
    config: { agentId: 'codex', workdir: '/repo' }
  }]
  const renderList = (requirementsEnabled?: boolean) => {
    index = 0
    states.length = 0
    return elements(SessionList({
      sessions, agents, activeId: 's1', statusBySession: {}, unreadBySession: {},
      onSelect: noop, onArchive: noop, onUnarchive: noop, onDelete: noop,
      onArchiveMany: noop, onDeleteMany: noop, onRename: noop, onPin: noop,
      requirementsEnabled
    }))
  }
  // ViewDropdown 是子组件：手动展开后再断言视图按钮。
  const viewButtons = (requirementsEnabled?: boolean) => {
    const dropdown = renderList(requirementsEnabled).find(e => e.props.ariaLabel === '会话视图')
    assert.ok(dropdown, 'view dropdown renders')
    return elements(ViewDropdown(dropdown!.props)).filter(e => e.props['data-view'])
  }
  assert.deepEqual(viewButtons().map(e => e.props['data-view']), ['all', 'byAgent', 'byProject'], 'requirement view is hidden by default')
  assert.deepEqual(viewButtons(false).map(e => e.props['data-view']), ['all', 'byAgent', 'byProject'], 'requirement view is removed while disabled')
  assert.deepEqual(viewButtons(true).map(e => e.props['data-view']), ['all', 'byAgent', 'byProject', 'byRequirement'], 'requirement view returns when enabled')

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: { homeDir: '/work' } } })
  const renderNewTask = (requirementsEnabled?: boolean) => {
    index = 0
    states.length = 0
    states[2] = 'codex'
    return elements(NewTaskPanel({
      agents: [{ ...agents[0], adapter: 'codex', models: [], capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] } } as AgentDef],
      onCreate: async () => sessions[0], onCommitCreatedSession: noop,
      quickCreateSeed: { requirementId: requirement.id }, requirementsEnabled
    }))
  }
  assert.equal(renderNewTask().some(e => e.type === RequirementPicker), false, 'new tasks hide requirement selection by default, even with a requirement seed')
  assert.equal(renderNewTask(true).find(e => e.type === RequirementPicker)?.props.value, requirement.id, 'explicit enable restores seeded requirement selection')
} finally {
  dispatcher.current = previous
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
}

console.log('requirement-switch-ui: ok')
