import assert from 'node:assert/strict'
import type { Project, Session } from '../src/shared/types'
import {
  applyOrder,
  finishOrderDrag,
  groupSessionsByAgent,
  groupSessionsByProject,
  moveItem,
  readOrder,
  splitPinnedSessions,
  toggleStoredItem
} from '../src/renderer/components/SessionList.tsx'

const projects: Project[] = [
  {
    id: 'default',
    name: '默认项目',
    primaryDirectory: '/Users/test',
    additionalDirectories: [],
    createdAt: 1,
    updatedAt: 1,
    isDefault: true
  },
  {
    id: 'project-a',
    name: '项目 A',
    primaryDirectory: '/repo/shared',
    additionalDirectories: ['/repo/docs'],
    createdAt: 2,
    updatedAt: 2
  },
  {
    id: 'project-b',
    name: '项目 B',
    primaryDirectory: '/repo/shared',
    additionalDirectories: [],
    createdAt: 3,
    updatedAt: 3
  }
]

const session = (id: string, projectId?: string): Session => ({
  id,
  title: id,
  config: { agentId: 'codex', projectId, workdir: '/repo/shared' },
  status: 'idle',
  createdAt: 1
})

const groups = groupSessionsByProject([
  session('a', 'project-a'),
  session('b', 'project-b'),
  session('legacy'),
  session('orphan', 'deleted-project')
], projects)

assert.deepEqual(
  groups.map((group) => [group.project.id, group.sessions.map((item) => item.id)]),
  [
    ['default', ['legacy', 'orphan']],
    ['project-a', ['a']],
    ['project-b', ['b']]
  ],
  'sessions must group by stable project id even when projects share a primary directory; missing projects fall back to default'
)

const partitioned = splitPinnedSessions([
  session('regular-a', 'project-a'),
  { ...session('pinned-a', 'project-a'), pinned: true },
  session('regular-b', 'project-b'),
  { ...session('pinned-b', 'project-b'), pinned: true }
])
assert.deepEqual(
  partitioned.pinned.map((item) => item.id),
  ['pinned-a', 'pinned-b'],
  'the pinned group must preserve the active-session order'
)
assert.deepEqual(
  groupSessionsByProject(partitioned.regular, projects)
    .flatMap((group) => group.sessions.map((item) => item.id)),
  ['regular-a', 'regular-b'],
  'pinned sessions must not be duplicated in ordinary project groups'
)

assert.deepEqual(
  groupSessionsByProject([], projects, ['project-a']).map((group) => [group.project.id, group.sessions.length]),
  [['project-a', 0]],
  'only pinned projects remain visible after their last active session is archived or deleted'
)
assert.deepEqual(groupSessionsByProject([], projects), [], 'empty unpinned project groups must stay hidden')
assert.deepEqual(
  groupSessionsByAgent([session('agent-session')], [{ id: 'codex' }, { id: 'claude' }], ['claude'])
    .map(([agentId, sessions]) => [agentId, sessions.map((item) => item.id)]),
  [['codex', ['agent-session']], ['claude', []]],
  'a pinned Agent must remain visible without sessions while unpinned empty Agents stay hidden'
)
assert.deepEqual(
  groupSessionsByAgent([], [{ id: 'codex' }], []),
  [],
  'empty unpinned Agent groups must stay hidden'
)

const draggedOrder = moveItem(['default', 'project-a', 'project-b'], 'project-b', 'default', false)
const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  }
})
toggleStoredItem('ua.sidebar.pinnedProjectGroups', [], 'project-a', () => {})
assert.deepEqual(
  readOrder('ua.sidebar.pinnedProjectGroups'),
  ['project-a'],
  'pinning a group must survive the localStorage reload used on restart'
)
toggleStoredItem('ua.sidebar.pinnedProjectGroups', ['project-a'], 'project-a', () => {})
assert.deepEqual(
  readOrder('ua.sidebar.pinnedProjectGroups'),
  [],
  'unpinning must remove the persisted group id'
)
finishOrderDrag({
  preview: draggedOrder,
  storageKey: 'ua.sidebar.projectGroupOrder',
  setter: () => {}
}, false)
assert.deepEqual(
  applyOrder(
    groupSessionsByProject([], projects, projects.map((project) => project.id)),
    readOrder('ua.sidebar.projectGroupOrder'),
    (group) => group.project.id
  )
    .map((group) => group.project.id),
  ['project-b', 'default', 'project-a'],
  'a dragged project order must survive the localStorage reload used on restart'
)

console.log('sidebar project groups: ok')
