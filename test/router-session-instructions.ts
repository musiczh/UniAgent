import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureAssistantContextRuntime, prepareAssistantInitialization, configureAssistantRules } from '../src/main/assistant/context'
import { sessionInstructions } from '../src/main/sessionInstructions'
import { ROUTER_SYSTEM_PROMPT } from '../src/shared/router'
import type { Session, SessionConfig } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-router-instructions-'))
const sessions = new Map<string, Session>()
const make = (id: string, config: SessionConfig): Session => {
  const session: Session = { id, title: id, createdAt: 1, status: 'idle', config }
  sessions.set(id, session)
  return session
}
configureAssistantContextRuntime(id => sessions.get(id), () => {})

const oldRouterRules = 'OLD_ROUTER_BOOTSTRAP_GUIDE: 每个 requestId 先 router_query mode=bootstrap'
const oldOrdinaryRules = 'OLD_ORDINARY_FROZEN_RULE'
let rules = oldRouterRules
configureAssistantRules(() => rules)

const routerSession = make('router-fixed', { agentId: 'deepseek', workdir: root, managedPurpose: 'router',
  roleSnapshot: { name: '旧角色', instructions: ROUTER_SYSTEM_PROMPT } as any })
await prepareAssistantInitialization(routerSession)
assert.equal(routerSession.promptContext?.rules, oldRouterRules, 'the fixed Session starts with a stale cached rule set')

const current = sessionInstructions(routerSession.config, routerSession.id)
const routerPromptCount = current.split(ROUTER_SYSTEM_PROMPT).length - 1
assert.equal(routerPromptCount, 1, 'the current Router rule appears exactly once')
assert.ok(!current.includes(oldRouterRules), 'the cached bootstrap-era Router rule is bypassed')
assert.ok(current.startsWith(ROUTER_SYSTEM_PROMPT), 'the current Router rule is the active system rule')
assert.equal(routerSession.promptContext?.rules, oldRouterRules, 'reading the current rule does not mutate the frozen initialization cache')

rules = oldOrdinaryRules
const ordinary = make('ordinary-fixed', { agentId: 'codex', workdir: root, roleSnapshot: { name: '普通角色', instructions: 'ROLE_INSTRUCTIONS' } as any })
await prepareAssistantInitialization(ordinary)
assert.equal(ordinary.promptContext?.rules, oldOrdinaryRules)
const frozen = sessionInstructions(ordinary.config, ordinary.id)
assert.ok(frozen.includes(oldOrdinaryRules), 'an ordinary Session keeps its initialization-time frozen rules')
assert.ok(!frozen.includes(ROUTER_SYSTEM_PROMPT), 'ordinary Sessions do not receive Router instructions')
assert.equal(frozen.split(oldOrdinaryRules).length - 1, 1)

console.log('PASS Router session instructions: stale cached bootstrap rules bypassed once, roleSnapshot not duplicated and ordinary Sessions stay frozen')
