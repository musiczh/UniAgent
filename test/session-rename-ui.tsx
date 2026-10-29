// Run on request: node scripts/run-ts-test.mjs test/session-rename-ui.tsx
import assert from 'node:assert/strict'
import React from 'react'
import { SessionList } from '../src/renderer/components/SessionList'
import type { AgentDef, Session } from '../src/shared/types'

// Use the repository's hook-dispatcher pattern to exercise real UI handlers
// without starting Electron or accessing user sessions.
const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const states: any[] = []
let index = 0
dispatcher.current = {
  useState(initial: any) {
    const slot = index++
    if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
    return [states[slot], (next: any) => {
      states[slot] = typeof next === 'function' ? next(states[slot]) : next
    }]
  },
  useMemo(value: () => unknown) { return value() },
  useRef(current: unknown) { return { current } },
  useEffect() {},
  useLayoutEffect() {}
}

function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap((child) =>
    React.isValidElement<any>(child) ? [child, ...elements(child.props.children)] : []
  )
}
const renamed: [string, string][] = []
const pinned: [string, boolean][] = []
const openedRequirements: [string, string][] = []
const requirement = { id: 'req', name: '需求一', dir: '/requirements/需求一', docPath: '/requirements/需求一/context.md', status: 'active', createdAt: 1, updatedAt: 1 } as const
states[1] = [requirement]
const sessions: Session[] = ['regular', 'pinned', 'archived'].map((id) => ({
  id, title: '原标题', status: 'idle', createdAt: 1, pinned: id === 'pinned', archived: id === 'archived',
  config: { agentId: 'codex', workdir: '/repo', permissionMode: 'default', requirementId: requirement.id }
}))
const agents = [{ id: 'codex', name: 'Codex', lifecycle: { availability: 'available' } }] as AgentDef[]
const noop = () => {}
function render() {
  index = 0
  return SessionList({
    requirementsEnabled: true,
    sessions, agents, activeId: 'regular', statusBySession: {}, unreadBySession: {},
    onSelect: noop, onArchive: noop, onUnarchive: noop, onDelete: noop,
    onArchiveMany: noop, onDeleteMany: noop, onPin: (id, value) => pinned.push([id, value]),
    onRename: (id, title) => renamed.push([id, title]),
    onOpenRequirement: (path, root) => openedRequirements.push([path, root])
  })
}
function row(id: string) {
  const found = elements(render()).find((element) => element.props['data-session-id'] === id)
  assert.ok(found, `session ${id} is visible`)
  return found
}
function openMenu(id: string) {
  let prevented = false
  let stopped = false
  row(id).props.onContextMenu({ clientX: 120, clientY: 80, currentTarget: null,
    preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
  assert.ok(prevented && stopped, 'right click opens the session menu without selecting the row')
  const menu = elements(render()).find((element) => element.props.role === 'menu')
  assert.ok(menu, 'right click opens all session actions')
  return menu
}
function edit(id: string) {
  const sessionRow = row(id)
  if (id !== 'archived') openMenu(id)
  const button = id === 'archived'
    ? elements(sessionRow).find((element) => element.props['aria-label'] === '修改会话标题')
    : elements(render()).find((element) => element.props.role === 'menuitem' && elements(element).some((child) => child.props.name === 'edit'))
  assert.ok(button, `session ${id} has a rename action`)
  let stopped = false
  button.props.onClick({ stopPropagation() { stopped = true } })
  if (id === 'archived') assert.ok(stopped, 'rename does not also select the session')
  assert.equal(elements(render()).some((element) => element.props.role === 'menu'), false, 'rename closes the context menu')
  const input = elements(row(id)).find((element) => element.type === 'input')
  assert.ok(input, 'rename opens the inline editor')
  assert.equal(input.props.defaultValue, '原标题')
  assert.equal(input.props.maxLength, 80)
  const target = { value: '  新标题  ', blur() { input.props.onBlur({ currentTarget: target }) } }
  return { target, key(key: string, isComposing = false) {
    input.props.onKeyDown({ key, nativeEvent: { isComposing }, currentTarget: target, stopPropagation: noop, preventDefault: noop })
  } }
}

try {
  assert.equal(elements(render()).some((element) => element.props.className?.includes?.('si-check')), false, 'checkboxes stay hidden by default')
  const multiSelect = elements(openMenu('regular')).find((element) => element.props.role === 'menuitem' && elements(element).some((child) => child.props.name === 'checkbox'))!
  assert.ok(multiSelect, 'right-click menu offers multi-select')
  multiSelect.props.onClick()
  assert.equal(elements(render()).filter((element) => element.props.className?.split?.(' ').includes('si-check')).length, 2, 'entering multi-select shows active-row checkboxes')
  assert.ok(row('regular').props.className.includes('selected'), 'the right-clicked session starts selected')
  elements(render()).find((element) => element.props.className === 'sl-batch-btn ghost')!.props.onClick()
  assert.equal(elements(render()).some((element) => element.props.className?.includes?.('si-check')), false, 'cancel hides all checkboxes')

  for (const id of ['regular', 'pinned']) {
    const inlineActions = elements(row(id)).find((element) => element.props.className === 'si-actions')!
    const icons = elements(inlineActions).filter((element) => element.props.name).map((element) => element.props.name)
    assert.deepEqual(icons, ['pin', 'archive'], 'only safe, frequent actions remain inline')
    const menu = openMenu(id)
    assert.deepEqual(elements(menu).filter((element) => element.props.name).map((element) => element.props.name),
      ['edit', 'pin', 'checkbox', 'archive', 'trash'], 'all original actions and multi-select remain accessible')
    const pin = elements(menu).find((element) => element.props.role === 'menuitem' && elements(element).some((child) => child.props.name === 'pin'))!
    pin.props.onClick()
    assert.deepEqual(pinned.at(-1), [id, id !== 'pinned'], 'pin toggles the right-clicked session')
    assert.equal(elements(render()).some((element) => element.props.role === 'menu'), false)
    openMenu(id).props.onKeyDown({ key: 'Escape', preventDefault: noop, stopPropagation: noop })
    assert.equal(elements(render()).some((element) => element.props.role === 'menu'), false, 'Escape dismisses the menu')
  }
  elements(render()).find((element) => element.props.className === 'sl-archive-head')!.props.onClick()
  for (const id of ['regular', 'pinned', 'archived']) {
    const editor = edit(id)
    const before = renamed.length
    editor.key('Enter', true)
    assert.equal(renamed.length, before, 'IME confirmation must not save the title')
    editor.key('Enter')
    assert.deepEqual(renamed.at(-1), [id, '新标题'])
    assert.equal(elements(row(id)).some((element) => element.type === 'input'), false)

    edit(id).key('Escape')
    assert.equal(renamed.length, before + 1, 'Escape cancels without saving')
    const empty = edit(id)
    empty.target.value = '  '
    empty.target.blur()
    assert.equal(renamed.length, before + 1, 'blank titles preserve the original')
    const unchanged = edit(id)
    unchanged.target.value = '原标题'
    unchanged.target.blur()
    assert.equal(renamed.length, before + 1, 'unchanged titles do not lock automatic titles')
  }
  for (const view of ['byAgent', 'byProject', 'byRequirement']) {
    const selector = elements(render()).find(element => element.props.ariaLabel === '会话视图')
    assert.ok(selector, 'unified view dropdown is present')
    selector.props.onChange(view)
    edit('regular').target.blur()
    assert.deepEqual(renamed.at(-1), ['regular', '新标题'], 'grouped sessions save on blur')
  }
  const requirementHeader = elements(render()).find((element) => element.props.className === 'sl-group-head' && elements(element).some((child) => child.props.children === requirement.name))!
  requirementHeader.props.onContextMenu({ clientX: 120, clientY: 80, currentTarget: null, preventDefault: noop, stopPropagation: noop })
  const requirementMenu = elements(render()).find((element) => element.props['aria-label'] === '需求操作')!
  assert.deepEqual(elements(requirementMenu).filter((element) => element.props.name).map((element) => element.props.name), ['file', 'archive'])
  elements(requirementMenu).find((element) => element.props.role === 'menuitem')!.props.onClick()
  assert.deepEqual(openedRequirements, [[requirement.docPath, requirement.dir]])
  console.log('session-rename-ui: ok')
} finally {
  dispatcher.current = previous
}
