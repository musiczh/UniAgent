import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  emptyNativeCapabilitySnapshot,
  nativeCandidateKey,
  type NativeCandidate,
  type NativeTurnSelectionRequest
} from '../src/shared/nativeCapabilities.ts'

const skill = {
  id: 'skill:/repo/.codex/skills/openai-docs/SKILL.md',
  kind: 'skill',
  name: 'openai-docs',
  path: '/repo/.codex/skills/openai-docs/SKILL.md',
  description: 'OpenAI docs',
  enabled: true
} satisfies NativeCandidate
const request = { candidateIds: [skill.id] } satisfies NativeTurnSelectionRequest

assert.equal(nativeCandidateKey(skill), skill.id)
assert.deepEqual(request.candidateIds, [skill.id])
assert.deepEqual(emptyNativeCapabilitySnapshot('codex', '/repo'), {
  agentId: 'codex',
  workdir: '/repo',
  source: 'provider-native',
  candidates: [],
  actions: { goal: false, review: false, plan: null },
  errors: []
})

const executableSources = await Promise.all([
  'src/shared/types.ts',
  'src/main/scanners.ts',
  'src/main/orchestrator.ts',
  'src/main/index.ts',
  'src/preload/index.ts',
  'src/renderer/App.tsx',
  'src/renderer/styles.css'
].map(async (path) => [path, await readFile(join(process.cwd(), path), 'utf8')] as const))

const forbiddenLegacySlash = [
  /IPC\.runCommand/,
  /window\.uniagent\.runCommand/,
  /IPC\.listCandidates/,
  /window\.uniagent\.listCandidates/,
  /\bPRESET_COMMANDS\b/,
  /\.slash-kind-command/
]
for (const [path, source] of executableSources) {
  for (const pattern of forbiddenLegacySlash) {
    assert.doesNotMatch(source, pattern, `${path} must not expose the legacy Slash command chain`)
  }
}

const verifier = await import(pathToFileURL(join(process.cwd(), 'test/cdp-native-capabilities.mjs')).href)
const verifierPaths = verifier.createNativeVerifierPaths('/tmp/uniagent-native-fixture')
assert.equal(
  verifierPaths.capabilityData,
  '/tmp/uniagent-native-fixture/home/.uniagent-capability-data',
  'the packaged verifier capability data must stay inside its isolated HOME safety boundary'
)
assert.ok(
  verifier.cssColorLightness('rgb(255, 255, 255)') >
    verifier.cssColorLightness('rgba(255, 255, 255, 0.72)'),
  'the Slash contrast probe must include alpha when comparing active-row text brightness'
)
const cleanupCalls: string[] = []
let forceRequested = false
await verifier.sweepOwnedVerifierProcesses(
  {
    sweep: async ({ shouldAbort }: { shouldAbort: () => boolean }) => {
      cleanupCalls.push('graceful')
      forceRequested = true
      assert.equal(shouldAbort(), true, 'second termination signal must abort graceful cleanup')
    },
    forceSweep: async () => { cleanupCalls.push('force') }
  },
  () => forceRequested
)
assert.deepEqual(
  cleanupCalls,
  ['graceful', 'force'],
  'an aborted graceful sweep must immediately force-sweep the same owned process tree'
)

const readyFixture = {
  id: 'mcp:isolated_fixture',
  kind: 'mcp',
  name: 'isolated_fixture',
  startupStatus: 'ready'
}
assert.equal(
  verifier.requireReadyInjectedMcp([
    { id: 'mcp:environment', kind: 'mcp', name: 'environment', startupStatus: 'ready' },
    readyFixture
  ], 'isolated_fixture'),
  readyFixture,
  'the packaged probe must select the exact injected MCP candidate'
)
for (const candidates of [
  [],
  [{ ...readyFixture, startupStatus: 'failed' }],
  [{ ...readyFixture, startupStatus: 'cancelled' }],
  [{ ...readyFixture, startupStatus: 'auth-required' }]
]) {
  assert.throws(
    () => verifier.requireReadyInjectedMcp(candidates, 'isolated_fixture'),
    /isolated_fixture.*(?:missing|ready)/,
    'the injected MCP fixture cannot be skipped or accepted in a non-ready state'
  )
}
