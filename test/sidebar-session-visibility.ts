import assert from 'node:assert/strict'
import type { AgentDef, Session } from '../src/shared/types'
import { isSidebarSessionEligible } from '../src/renderer/sessionVisibility'

const agent = (
  id: string,
  availability: NonNullable<AgentDef['lifecycle']>['availability']
): AgentDef => ({
  id,
  name: id,
  bin: `/safe/${id}`,
  adapter: 'codex',
  icon: '',
  builtin: true,
  installed: availability !== 'not-installed',
  models: [],
  capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] },
  lifecycle: {
    availability,
    auth: availability === 'available' ? 'authenticated' : 'required',
    health: availability === 'available' ? 'healthy' : 'unknown',
    updateStatus: 'idle',
    checkedAt: Date.now()
  }
})

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  title: 'Session',
  status: 'idle',
  createdAt: Date.now(),
  origin: 'created',
  config: {
    agentId: 'codex',
    workdir: '/work',
    model: 'default',
    permissionMode: 'default'
  },
  ...overrides
})

const available = [agent('codex', 'available')]

assert.equal(
  isSidebarSessionEligible(session({ readOnly: true, origin: 'imported' }), available),
  false,
  'current read-only history snapshots stay out of the sidebar'
)
assert.equal(
  isSidebarSessionEligible(session({ origin: 'imported', readOnly: undefined }), available),
  false,
  'legacy imported snapshots without a persisted readOnly flag stay hidden'
)
assert.equal(
  isSidebarSessionEligible(
    session({
      origin: 'imported',
      readOnly: false,
      importMode: 'direct',
      nativeSessionId: 'native-direct'
    }),
    available
  ),
  true,
  'directly imported writable native sessions remain visible without fork lineage'
)
assert.equal(
  isSidebarSessionEligible(
    session({ origin: 'imported', readOnly: false, nativeSessionId: 'legacy-unsafe' }),
    available
  ),
  false,
  'legacy imported sessions without direct-import provenance stay hidden'
)
assert.equal(
  isSidebarSessionEligible(
    session({
      origin: 'imported',
      readOnly: false,
      forkedFrom: { agentId: 'codex', nativeId: 'native-source', mode: 'same' }
    }),
    available
  ),
  true,
  'writable imported forks remain visible'
)
assert.equal(
  isSidebarSessionEligible(session({ nativeSessionId: undefined, status: 'running' }), available),
  true,
  'a newly-created running session remains visible before it gets a native id'
)
for (const availability of ['not-installed', 'needs-auth', 'unhealthy'] as const) {
  assert.equal(
    isSidebarSessionEligible(session(), [agent('codex', availability)]),
    false,
    `sessions for ${availability} agents stay hidden`
  )
}
assert.equal(
  isSidebarSessionEligible(session({ archived: true }), available),
  true,
  'archive grouping is applied after eligibility and does not alter writability'
)

console.log('sidebar-session-visibility: ok')
