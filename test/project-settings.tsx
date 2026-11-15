import assert from 'node:assert/strict'
import React, { type ReactElement, type ReactNode } from 'react'
import type { AgentDef, Project, ProjectInput, Session } from '../src/shared/types'
import { ProjectSettings } from '../src/renderer/components/ProjectSettings'
import { ProjectEditorDialog, ProjectEditorForm } from '../src/renderer/components/ProjectEditorDialog'
import { ProjectWorktrees } from '../src/renderer/components/ProjectWorktrees'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'

// Exercise the real components and handlers without loading user data or Agent runtimes.
const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
function harness<P>(component: (props: P) => ReactNode, runEffects = true) {
  const slots: any[] = []
  let index = 0, changed = false
  let pending: (() => void)[] = []
  let snapshot: any
  let storeUpdates = 0
  return {
    get snapshot() { return snapshot },
    get storeUpdates() { return storeUpdates },
    render(props: P): ReactNode {
      let result: ReactNode
      do {
        index = 0; changed = false; pending = []
        const previous = dispatcher.current
        dispatcher.current = {
          useState(initial: any) {
            const slot = index++
            if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
            return [slots[slot], (next: any) => {
              const value = typeof next === 'function' ? next(slots[slot]) : next
              if (!Object.is(value, slots[slot])) { slots[slot] = value; changed = true }
            }]
          },
          useRef(initial: any) { const slot = index++; return slots[slot] ||= { current: initial } },
          useMemo(value: () => unknown) { return value() },
          useCallback(value: unknown) { return value },
          useSyncExternalStore(subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) {
            const slot = index++
            if (!(slot in slots)) slots[slot] = {}
            const state = slots[slot]
            if (state.subscribe !== subscribe) pending.push(() => {
              state.cleanup?.()
              state.subscribe = subscribe
              state.cleanup = subscribe(() => { changed = true; storeUpdates++ })
            })
            snapshot = getSnapshot()
            return snapshot
          },
          useEffect(effect: () => void | (() => void), deps?: unknown[]) {
            const slot = index++
            if (!runEffects) return
            const previous = slots[slot]
            if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
              pending.push(() => { previous?.cleanup?.(); slots[slot] = { deps, cleanup: effect() } })
            }
          }
        }
        try { result = component(props) } finally { dispatcher.current = previous }
        pending.forEach(effect => effect())
      } while (changed)
      return result
    },
    dispose() { slots.forEach(slot => slot?.cleanup?.()) }
  }
}
function elements(node: ReactNode): ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => React.isValidElement<any>(child)
    ? [child, ...elements(child.props.children), ...elements(child.props.action)] : [])
}
function text(node: ReactNode): string {
  return React.Children.toArray(node).map(child => React.isValidElement<any>(child) ? text(child.props.children) : String(child)).join('')
}
function classes(node: ReactNode, name: string) {
  return elements(node).filter(element => element.props.className?.split(' ').includes(name))
}
function button(node: ReactNode, label: string) {
  const found = elements(node).find(element => element.type === 'button' && text(element.props.children).trim().startsWith(label))
  assert.ok(found, `button ${label} is present`)
  return found
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const project = (id: string, isDefault = false): Project => ({
  id, name: id, primaryDirectory: isDefault ? '/home/test' : '/repo/shared', additionalDirectories: [],
  createdAt: 1, updatedAt: 1, ...(isDefault ? { isDefault } : {})
})
const projects = [project('default', true), project('space-a'), project('space-b'), project('empty')]
const session = (id: string, projectId?: string, extra: Partial<Session> = {}): Session => ({
  id, title: id, status: 'idle', createdAt: 1, config: { agentId: 'codex', projectId, workdir: '/repo/shared' }, ...extra
})
const worktree: NonNullable<Session['config']['worktree']> = {
  id: 'tree', projectId: 'space-a', sourcePrimaryDirectory: '/repo/shared', repositoryRoot: '/repo/shared',
  gitCommonDirectory: '/repo/shared/.git', checkoutRoot: '/worktrees/feature', workdir: '/worktrees/feature',
  baseRef: 'master', baseCommit: '123', creationRequestId: 'request', state: 'ready'
}
const sessions = [
  session('ordinary', 'space-a', { updatedAt: 30 }),
  session('tool', 'space-a', { handoffId: 'handoff', updatedAt: 60 }),
  session('imported', 'space-a', { readOnly: true, origin: 'imported', updatedAt: 50 }),
  session('worktree', 'space-a', { createdAt: 80, config: { agentId: 'codex', projectId: 'space-a', workdir: worktree.workdir, worktree } }),
  session('unavailable', 'space-a', { config: { agentId: 'missing', projectId: 'space-a', workdir: '/repo/shared' } }),
  session('member', 'space-a', { teamBinding: { teamProjectId: 'team', memberId: 'worker' }, updatedAt: 40 }),
  session('archived', 'space-a', { archived: true, updatedAt: 90 }),
  session('other-space', 'space-b'), session('legacy'), session('deleted-space', 'deleted')
]
const agents = [{ id: 'codex', name: 'Codex', adapter: 'codex', lifecycle: { availability: 'available' } }] as AgentDef[]
const originalSessions = structuredClone(sessions)
const opened: string[] = [], events: string[] = [], deleted: string[] = []
let confirm = true, deleteError = '', picked: string | null = null
const savedInputs: { id?: string; input: ProjectInput }[] = []
let saveError = '', pendingSave: Promise<Project> | undefined
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  confirm: () => confirm,
  dispatchEvent: (event: Event) => { events.push(event.type) },
  uniagent: {
    pickDirectory: async () => picked,
    deleteProject: async (id: string) => { deleted.push(id); if (deleteError) throw new Error(deleteError); return projects.filter(item => item.id !== id) },
    updateProject: async (id: string, input: ProjectInput) => {
      savedInputs.push({ id, input }); if (saveError) throw new Error(saveError)
      return pendingSave || { ...projects[1], ...input }
    },
    createProject: async (input: ProjectInput) => { savedInputs.push({ input }); return { ...project('new'), ...input } }
  }
} })

try {
  const settingsHarness = harness(SettingsPanel, false)
  const wired = elements(settingsHarness.render({
    agents, sessions, initialCategory: 'projects', onRedetect() {}, onInitialize() {}, onAgentsChanged() {}, onOpenSync() {}, onBack() {}
  })).find(element => element.type === ProjectSettings)!
  assert.ok(wired, 'space settings render in the selected category')
  assert.equal(wired.props.sessions, sessions, 'settings forward the live session collection without sidebar filtering')
  assert.equal(wired.props.agents, agents)

  const guard = { current: null as (() => boolean) | null }
  let props = { projects, sessions, agents, navigationGuard: guard, onOpenSession: (id: string) => opened.push(id), onProjectsChange: (next: Project[]) => { props = { ...props, projects: next } } }
  const panel = harness(ProjectSettings)
  const render = () => panel.render(props)
  const rows = () => classes(render(), 'project-session-row')
  assert.equal(classes(render(), 'project-settings-link').length, 4, 'empty spaces remain enterable')
  assert.match(text(button(render(), 'space-a').props.children), /7 个会话/)
  assert.match(text(button(render(), 'default').props.children), /2 个会话/, 'legacy and deleted-space sessions share the existing default fallback')
  button(render(), 'space-a').props.onClick()
  assert.deepEqual(rows().map(row => row.props['data-session-id']), ['worktree', 'tool', 'imported', 'member', 'ordinary', 'unavailable'])
  assert.match(text(render()), /未归档6已归档1/)
  assert.match(text(render()), /工具会话/)
  assert.match(text(render()), /导入只读/)
  assert.match(text(render()), /专家团/)
  assert.match(text(render()), /工作树 · feature/)
  rows()[0].props.onClick()
  assert.deepEqual(opened, ['worktree'])
  button(render(), '已归档').props.onClick()
  assert.deepEqual(rows().map(row => row.props['data-session-id']), ['archived'])
  rows()[0].props.onClick()
  assert.deepEqual(opened, ['worktree', 'archived'])
  assert.deepEqual(sessions, originalSessions, 'viewing archived sessions never mutates archive state')

  props = { ...props, sessions: [...sessions, session('new-arrival', 'space-a', { updatedAt: 100 })] }
  button(render(), '未归档').props.onClick()
  assert.equal(rows()[0].props['data-session-id'], 'new-arrival', 'live additions update counts and ordering')
  props = { ...props, sessions: props.sessions.map(item => item.id === 'ordinary' ? { ...item, archived: true } : item) }
  assert.equal(rows().some(row => row.props['data-session-id'] === 'ordinary'), false)
  button(render(), '已归档').props.onClick()
  assert.equal(rows().length, 2, 'live archiving updates both partitions')
  button(render(), '工作树').props.onClick()
  const trees = elements(render()).find(element => element.type === ProjectWorktrees)!
  assert.equal(trees.props.project.id, 'space-a')
  trees.props.onOpenSession('worktree')
  assert.equal(opened.at(-1), 'worktree', 'existing worktree session navigation remains wired')
  button(render(), '项目信息').props.onClick()
  let info = elements(render()).find(element => element.type === ProjectEditorForm)!
  assert.equal(info.props.project.id, 'space-a')
  guard.current = () => false
  button(render(), '全部项目').props.onClick()
  assert.ok(elements(render()).some(element => element.type === ProjectEditorForm), 'unsaved guard can block returning to the list')
  button(render(), '会话').props.onClick()
  assert.ok(elements(render()).some(element => element.type === ProjectEditorForm), 'unsaved guard can block tab switches')
  guard.current = null
  const renamed = { ...projects[1], name: 'renamed space' }
  info.props.onSaved(renamed)
  assert.ok(text(render()).includes('renamed space'))
  assert.equal(events.at(-1), 'uniagent-projects-changed')

  confirm = false
  info = elements(render()).find(element => element.type === ProjectEditorForm)!
  info.props.onRemove(); await tick()
  assert.deepEqual(deleted, [], 'canceling deletion never calls IPC')
  confirm = true; deleteError = 'project_has_active_sessions'
  info.props.onRemove(); await tick()
  assert.match(text(render()), /请等待会话结束后再删除/)
  assert.ok(elements(render()).some(element => element.type === ProjectEditorForm), 'failed deletion retains the detail')
  deleteError = ''
  elements(render()).find(element => element.type === ProjectEditorForm)!.props.onRemove(); await tick()
  assert.equal(classes(render(), 'project-settings-link').length, 3, 'successful deletion returns to the updated list')
  button(render(), 'empty').props.onClick()
  assert.match(text(render()), /暂无未归档会话/)
  button(render(), '已归档').props.onClick()
  assert.match(text(render()), /暂无已归档会话/)
  button(render(), '全部项目').props.onClick()
  button(render(), '新建项目').props.onClick()
  const dialog = elements(render()).find(element => element.type === ProjectEditorDialog)!
  dialog.props.onSaved(project('new'))
  assert.equal(classes(render(), 'project-settings-link').length, 4)
  assert.equal(elements(render()).some(element => element.type === ProjectEditorDialog), false)
  console.log('project settings: session membership, archive views, live updates, navigation, worktrees, create/delete passed')

  let formProps = { project: projects[1], inline: true, navigationGuard: guard, onSaved: (_saved: Project) => {} }
  const form = harness(ProjectEditorForm)
  const renderForm = () => form.render(formProps)
  const input = () => elements(renderForm()).find(element => element.type === 'input')!
  assert.equal(button(renderForm(), '保存').props.disabled, true, 'unchanged inline forms do not submit')
  input().props.onChange({ target: { value: '  新空间名称  ' } })
  assert.equal(button(renderForm(), '保存').props.disabled, false)
  confirm = false
  assert.equal(guard.current?.(), false, 'dirty form participates in the outer settings navigation guard')
  confirm = true
  assert.equal(guard.current?.(), true)
  picked = '/extra'
  button(renderForm(), '添加目录').props.onClick(); await tick()
  button(renderForm(), '添加目录').props.onClick(); await tick()
  assert.equal(classes(renderForm(), 'project-directory-row').length, 2, 'duplicate additional directories are ignored')
  button(renderForm(), '设为主目录').props.onClick()
  assert.match(text(classes(renderForm(), 'is-primary')[0]), /\/extra/)
  picked = '/repo/shared'
  button(renderForm(), '选择').props.onClick(); await tick()
  assert.equal(classes(renderForm(), 'project-directory-row').length, 1, 'choosing an extra directory as primary removes the duplicate')
  button(renderForm(), '保存').props.onClick(); await tick()
  assert.deepEqual(savedInputs.at(-1), { id: 'space-a', input: { name: '新空间名称', primaryDirectory: '/repo/shared', additionalDirectories: [] } })

  saveError = 'project_has_active_sessions'
  button(renderForm(), '保存').props.onClick(); await tick()
  assert.match(text(renderForm()), /请等待会话结束后再修改目录/)
  assert.equal(input().props.value, '  新空间名称  ', 'failed saves retain the draft')
  button(renderForm(), '取消修改').props.onClick()
  assert.equal(input().props.value, 'space-a')
  assert.equal(elements(renderForm()).some(element => element.props.role === 'alert'), false)
  input().props.onChange({ target: { value: '   ' } })
  const beforeBlank = savedInputs.length
  button(renderForm(), '保存').props.onClick(); await tick()
  assert.equal(savedInputs.length, beforeBlank, 'blank names are rejected even if the handler is called directly')
  button(renderForm(), '取消修改').props.onClick()

  saveError = ''
  let finishSave!: (value: Project) => void
  pendingSave = new Promise(resolve => { finishSave = resolve })
  input().props.onChange({ target: { value: 'pending' } })
  const saveButton = button(renderForm(), '保存')
  const beforePending = savedInputs.length
  saveButton.props.onClick(); saveButton.props.onClick()
  assert.equal(savedInputs.length, beforePending + 1, 'rapid repeated saves produce one request')
  assert.equal(guard.current?.(), false, 'in-flight save blocks leaving even before a re-render')
  assert.equal(input().props.disabled, true)
  finishSave({ ...projects[1], name: 'pending' }); await tick()
  pendingSave = undefined
  formProps = { ...formProps, project: { ...projects[1], name: 'pending' } }
  assert.equal(input().props.value, 'pending')
  assert.equal(button(renderForm(), '保存').props.disabled, true, 'saved project becomes the clean baseline')
  form.dispose()
  assert.equal(guard.current, null, 'unmount releases the navigation guard')

  const defaultForm = harness(ProjectEditorForm)
  const defaultTree = defaultForm.render({ project: projects[0], inline: true, onSaved() {}, onRemove() { throw new Error('default space removal') } })
  assert.equal(elements(defaultTree).find(element => element.type === 'input')!.props.readOnly, true)
  assert.equal(elements(defaultTree).filter(element => element.type === 'button').length, 0, 'default space has no mutation controls')
  const createForm = harness(ProjectEditorForm)
  const createProps = { onSaved() {}, onClose() {} }
  const renderCreate = () => createForm.render(createProps)
  assert.equal(button(renderCreate(), '创建项目').props.disabled, true)
  elements(renderCreate()).find(element => element.type === 'input')!.props.onChange({ target: { value: 'new space' } })
  assert.equal(button(renderCreate(), '创建项目').props.disabled, true, 'a directory is required before creation')
  const beforeDirectory = savedInputs.length
  button(renderCreate(), '创建项目').props.onClick(); await tick()
  assert.equal(savedInputs.length, beforeDirectory)
  picked = '/new/repo'
  button(renderCreate(), '选择').props.onClick(); await tick()
  button(renderCreate(), '创建项目').props.onClick(); await tick()
  assert.deepEqual(savedInputs.at(-1), { input: { name: 'new space', primaryDirectory: '/new/repo', additionalDirectories: [] } }, 'the existing modal creation flow still submits')
  console.log('project editor: directory reuse, save/cancel/failure, validation, pending-save guard, default read-only and creation passed')

  const requests: { projectId: string; resolve: (rows: any[]) => void; reject: (error: Error) => void }[] = []
  const api = window.uniagent as any
  api.listProjectWorktrees = (projectId: string) => new Promise((resolve, reject) => { requests.push({ projectId, resolve, reject }) })
  const tree = (name: string) => ({ path: `/repo/${name}`, branch: name, source: 'managed', state: 'ready', sessions: [] })
  const worktreeProps = { project: project('cache-space'), onOpenSession: (id: string) => opened.push(id) }
  const firstVisit = harness(ProjectWorktrees)
  const firstTree = firstVisit.render(worktreeProps)
  assert.match(text(firstTree), /正在读取工作树/)
  assert.equal(requests.length, 1)
  requests[0].resolve([tree('cached')]); await tick()
  assert.equal(classes(firstVisit.render(worktreeProps), 'project-worktree-row').length, 1)
  firstVisit.dispose()

  const revisit = harness(ProjectWorktrees)
  const cachedTree = revisit.render(worktreeProps)
  assert.equal(classes(cachedTree, 'project-worktree-row').length, 1, 'returning to the tab must show cached rows before the refresh resolves')
  assert.doesNotMatch(text(cachedTree), /正在读取工作树/, 'cached visits must never flash the loading placeholder')
  assert.equal(requests.length, 2, 'cache hits still revalidate in the background')
  const updatesBeforeResponse = revisit.storeUpdates
  requests[1].resolve([tree('updated')]); await tick()
  assert.ok(revisit.storeUpdates > updatesBeforeResponse, 'background responses must notify the mounted UI')
  assert.match(text(revisit.render(worktreeProps)), /updated/)
  assert.doesNotMatch(text(revisit.render(worktreeProps)), /cached/)
  const stableRows = revisit.snapshot.rows
  button(revisit.render(worktreeProps), '刷新').props.onClick()
  assert.match(text(revisit.render(worktreeProps)), /updated/, 'manual refresh retains existing rows')
  requests.at(-1)!.resolve([tree('updated')]); await tick()
  revisit.render(worktreeProps)
  assert.equal(revisit.snapshot.rows, stableRows, 'unchanged results retain the same UI data object')
  button(revisit.render(worktreeProps), '刷新').props.onClick()
  requests.at(-1)!.reject(new Error('temporary failure')); await tick()
  assert.match(text(revisit.render(worktreeProps)), /updated/, 'refresh errors must preserve the last successful result')
  assert.match(text(revisit.render(worktreeProps)), /temporary failure/)
  revisit.dispose()

  const overlapping = harness(ProjectWorktrees)
  overlapping.render(worktreeProps)
  const pendingRequestCount = requests.length
  overlapping.dispose()
  const quickReturn = harness(ProjectWorktrees)
  assert.doesNotMatch(text(quickReturn.render(worktreeProps)), /正在读取工作树/)
  assert.equal(requests.length, pendingRequestCount, 'quick tab switches must share an in-flight request')
  requests.at(-1)!.resolve([]); await tick()
  assert.match(text(quickReturn.render(worktreeProps)), /暂无可用工作树/)
  quickReturn.dispose()
  const cachedEmpty = harness(ProjectWorktrees)
  assert.match(text(cachedEmpty.render(worktreeProps)), /暂无可用工作树/)
  assert.doesNotMatch(text(cachedEmpty.render(worktreeProps)), /正在读取工作树/, 'an empty successful result is also cached')
  requests.at(-1)!.resolve([tree('remove-me')]); await tick()
  cachedEmpty.render(worktreeProps)

  let finishRemoval!: (rows: any[]) => void
  const removedPaths: string[] = []
  api.removeProjectWorktree = (_projectId: string, path: string) => {
    removedPaths.push(path)
    return new Promise(resolve => { finishRemoval = resolve })
  }
  const removeButton = elements(cachedEmpty.render(worktreeProps)).find(element => element.props['aria-label'] === '删除工作树')!
  removeButton.props.onClick()
  assert.equal(requests.at(-1)!.projectId, worktreeProps.project.id, 'removal always rechecks the backend instead of trusting the cache')
  requests.at(-1)!.resolve([{ ...tree('remove-me'), removalBlockedReason: 'fresh lock' }]); await tick()
  assert.deepEqual(removedPaths, [], 'fresh removal restrictions take precedence over a removable cached row')
  assert.match(text(cachedEmpty.render(worktreeProps)), /fresh lock/)
  elements(cachedEmpty.render(worktreeProps)).find(element => element.props['aria-label'] === '删除工作树')!.props.onClick()
  requests.at(-1)!.resolve([tree('remove-me')]); await tick()
  assert.deepEqual(removedPaths, ['/repo/remove-me'])
  cachedEmpty.dispose()
  const duringRemoval = harness(ProjectWorktrees)
  duringRemoval.render(worktreeProps)
  const staleQuery = requests.at(-1)!
  finishRemoval([]); await tick()
  assert.match(text(duringRemoval.render(worktreeProps)), /暂无可用工作树/, 'mutation results update a newly mounted subscriber as well as the cache')
  staleQuery.resolve([tree('remove-me')]); await tick()
  assert.equal(classes(duringRemoval.render(worktreeProps), 'project-worktree-row').length, 0, 'an old refresh cannot resurrect a removed worktree')
  duringRemoval.dispose()

  const uncachedProps = { project: project('uncached-space') }
  const uncached = harness(ProjectWorktrees)
  assert.match(text(uncached.render(uncachedProps)), /正在读取工作树/)
  assert.equal(classes(uncached.render(uncachedProps), 'project-worktree-row').length, 0, 'spaces that share a primary directory still have separate caches')
  requests.at(-1)!.reject(new Error('cold failure')); await tick()
  assert.match(text(uncached.render(uncachedProps)), /cold failure/)
  assert.doesNotMatch(text(uncached.render(uncachedProps)), /正在读取工作树/)
  uncached.dispose()

  const leftDuringLoad = harness(ProjectWorktrees)
  leftDuringLoad.render(uncachedProps)
  leftDuringLoad.dispose()
  requests.at(-1)!.resolve([tree('loaded-after-leaving')]); await tick()
  const afterLeaving = harness(ProjectWorktrees)
  assert.match(text(afterLeaving.render(uncachedProps)), /loaded-after-leaving/, 'a request finishing after unmount still fills the cache')
  const previousDirectoryQuery = requests.at(-1)!
  const movedProps = { project: { ...uncachedProps.project, primaryDirectory: '/different/repo' } }
  const moved = afterLeaving.render(movedProps)
  assert.doesNotMatch(text(moved), /loaded-after-leaving/, 'changing a space directory invalidates its old cached rows')
  assert.match(text(moved), /正在读取工作树/)
  requests.at(-1)!.resolve([tree('different-directory')]); await tick()
  assert.match(text(afterLeaving.render(movedProps)), /different-directory/)
  previousDirectoryQuery.resolve([tree('late-previous-directory')]); await tick()
  assert.doesNotMatch(text(afterLeaving.render(movedProps)), /late-previous-directory/, 'late responses from the previous directory cannot replace current rows')
  afterLeaving.dispose()
  console.log('project worktrees: cached return, background updates, stable rows, errors, empty results, request sharing, mutation races and cache isolation passed')
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
}
