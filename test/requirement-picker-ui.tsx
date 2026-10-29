// Run on request: node scripts/run-ts-test.mjs test/requirement-picker-ui.tsx
import assert from 'node:assert/strict'
import React from 'react'
import { RequirementPicker } from '../src/renderer/components/RequirementPicker'
import type { Requirement } from '../src/shared/requirementTypes'

const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const previousWindow = (globalThis as any).window
const states: any[] = []
let index = 0, subscribed = false
const selected: Array<string | undefined> = []
const requests: Array<{ name: string; resolve: (r: Requirement) => void; reject: (e: Error) => void }> = []
const requirement = (id: string): Requirement => ({ id, name: id, dir: '/requirements/' + id, docPath: '/requirements/' + id + '/context.md', status: 'active', createdAt: 1, updatedAt: 1 })
;(globalThis as any).window = { uniagent: {
  listRequirements: async () => [requirement('existing')],
  onRequirementsChanged: () => () => {},
  createRequirement: ({ name }: { name: string }) => new Promise<Requirement>((resolve, reject) => requests.push({ name, resolve, reject }))
} }
dispatcher.current = {
  useState(initial: any) {
    const slot = index++
    if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
    return [states[slot], (next: any) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next }]
  },
  useRef(current: unknown) {
    const slot = index++
    return states[slot] ||= { current }
  },
  useEffect(effect: () => void) { if (!subscribed) { subscribed = true; effect() } },
  useLayoutEffect() {}
}
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => React.isValidElement<any>(child) ? [child, ...elements(child.props.children)] : [])
}
function render() {
  index = 0
  return elements(RequirementPicker({ onChange: id => selected.push(id) }))
}
const details = { open: true, removeAttribute() { this.open = false } }
const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve() }
function draft(name: string) {
  details.open = true
  render().find(e => e.props.className === 'project-picker-create')!.props.onClick()
  render().find(e => e.type === 'input' && e.props.placeholder === '新需求名称，回车创建')!.props.onChange({ target: { value: name } })
  return render().find(e => e.type === 'input' && e.props.placeholder === '新需求名称，回车创建')!
}
try {
  const element = render().find(e => e.type === 'details')!
  ;(element as any).ref.current = details
  await settle()
  let input = draft('中文需求')
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { assert.fail('candidate confirmation must remain with the IME') } })
  assert.equal(requests.length, 0)
  const enter = { key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} }
  input.props.onKeyDown(enter)
  input.props.onKeyDown(enter)
  assert.equal(requests.length, 1, 'repeat input cannot create duplicate requests')
  assert.equal(requests[0].name, '中文需求')
  requests[0].resolve(requirement('created'))
  await settle()
  assert.deepEqual(selected, ['created'])
  assert.equal(details.open, false)

  input = draft('A')
  input.props.onKeyDown(enter)
  render().find(e => e.props.role === 'option' && elements(e).some(child => child.type === 'strong' && React.Children.toArray(child.props.children).join('') === 'existing'))!.props.onClick()
  requests[1].resolve(requirement('A'))
  await settle()
  assert.deepEqual(selected, ['created', 'existing'], 'late creation cannot overwrite a later selection')

  input = draft('Cancelled')
  input.props.onKeyDown(enter)
  details.open = false
  render().find(e => e.type === 'details')!.props.onToggle({ currentTarget: details })
  input = draft('Current')
  input.props.onKeyDown(enter)
  requests[2].reject(new Error('Old failure'))
  await settle()
  assert.equal(render().some(e => e.props.role === 'alert'), false, 'cancelled errors cannot enter the new draft')
  assert.equal(render().find(e => e.type === 'input' && e.props.placeholder === '新需求名称，回车创建')!.props.disabled, true, 'old completion cannot unlock a newer request')
  requests[3].resolve(requirement('Current'))
  await settle()
  assert.deepEqual(selected, ['created', 'existing', 'Current'])
  console.log('Requirement picker: IME confirmation, duplicate prevention and cancelled creation ownership ok')
} finally {
  dispatcher.current = previous
  ;(globalThis as any).window = previousWindow
}
