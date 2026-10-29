import assert from 'node:assert/strict'
import {
  agentForSession,
  assertAgentSupportsSteer,
  type AgentDef,
  type SessionAgentContract
} from '../src/shared/types.ts'
import { normalizeQuestions } from '../src/shared/questions.ts'
import {
  KIMI_PERMISSION_MODES,
  assertACPProviderConfig,
  acpLaunchArgs,
  projectACPContract
} from '../src/main/acp/acpRunner.ts'

const agent: AgentDef = {
  id: 'kimi',
  name: 'Kimi Code',
  bin: 'kimi',
  adapter: 'kimi',
  icon: 'kimi',
  builtin: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: false,
    permissionModes: [],
    protocol: 'acp',
    steer: true,
    sessionFork: false
  },
  models: []
}

const contract = {
  models: [],
  permissionModes: [],
  imageAttachments: true,
  fileAttachments: true,
  sessionList: true,
  sessionLoad: true,
  sessionResume: true,
  sessionFork: true,
  sessionForkAtTurn: false,
  crossAgentFork: false,
  steer: false,
  followup: true,
  sideChat: false,
  structuredSubagents: false,
  formElicitation: true,
  freeTextElicitation: false,
  nativeGoal: false,
  nativeReview: false,
  structuredUsage: false,
  capabilityInventory: false,
  additionalDirectoriesNew: true,
  additionalDirectoriesResume: false,
  commands: ['/compact', '/usage']
} satisfies SessionAgentContract

const projected = agentForSession(agent, { agentContract: contract } as any)

// Break caught: renderer/MCP reads the process-wide Kimi definition and offers
// steer even though this concrete ACP session explicitly rejected it.
assert.equal(projected.capabilities.steer, false)
assert.equal(projected.capabilities.followup, true)

// Break caught: one sessionFork bit opens unsupported point/cross-agent forks.
assert.equal(projected.capabilities.sessionFork, true)
assert.equal(projected.capabilities.sessionForkAtTurn, false)
assert.equal(projected.capabilities.crossAgentFork, false)

// Break caught: Web-only UI survives because the negative ACP capability is
// dropped while overlaying the session contract.
assert.equal(projected.capabilities.nativeGoal, false)
assert.equal(projected.capabilities.sideChat, false)
assert.equal(projected.capabilities.structuredSubagents, false)
assert.equal(projected.capabilities.formElicitation, true)
assert.equal(projected.capabilities.freeTextElicitation, false)
assert.equal(projected.capabilities.structuredUsage, false)
assert.equal(projected.capabilities.capabilityInventory, false)
assert.equal(projected.capabilities.additionalDirectoriesNew, true)
assert.equal(projected.capabilities.additionalDirectoriesResume, false)

const [multi] = normalizeQuestions('elicitation', {
  requestedSchema: {
    type: 'object',
    required: ['checks'],
    properties: {
      checks: {
        type: 'array',
        title: '检查项',
        items: {
          anyOf: [
            { const: 'tests', title: '测试' },
            { const: 'types', title: '类型检查' }
          ]
        },
        minItems: 1,
        maxItems: 2
      }
    }
  }
})
// Break caught: Kimi's items.anyOf multi-select is rendered as a free-text box,
// producing an answer shape the ACP server cannot map back to option ids.
assert.equal(multi.type, 'multi')
assert.deepEqual(multi.options, [
  { value: 'tests', label: '测试', description: undefined },
  { value: 'types', label: '类型检查', description: undefined }
])
assert.equal(multi.allowOther, false)

assert.deepEqual(acpLaunchArgs('kimi', {} as any), ['acp'])
assert.deepEqual(KIMI_PERMISSION_MODES.map((mode) => mode.id), [
  'ask',
  'full-access'
])

const kimiContract = projectACPContract(
  'kimi',
  {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: {
        list: {}, resume: {}, close: {}, delete: {}, fork: {}, additionalDirectories: {}
      }
    }
  },
  {
    configOptions: [
      {
        type: 'select', id: 'model', currentValue: 'kimi-k2',
        options: [{ value: 'kimi-k2', name: 'Kimi K2' }, { value: 'other-model', name: 'Other' }]
      },
      {
        type: 'select', id: 'thinking', currentValue: 'high',
        options: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }]
      },
      {
        type: 'select', id: 'mode', currentValue: 'default',
        options: ['default', 'plan', 'auto', 'yolo'].map((value) => ({ value, name: value }))
      }
    ],
    modes: {
      currentModeId: 'default',
      availableModes: ['default', 'plan', 'auto', 'yolo'].map((id) => ({ id }))
    }
  },
  { agentId: 'kimi', permissionMode: 'ask', workdir: '/tmp' } as any,
  ['/compact', '/usage']
)

assert.equal(kimiContract.currentModelId, 'kimi-k2')
assert.deepEqual(kimiContract.models[0], {
  id: 'kimi-k2',
  label: 'Kimi K2',
  efforts: [],
  defaultEffort: 'high',
  imageInput: true,
  thinkingOptions: ['off', 'high'],
  defaultThinking: 'high'
})
assert.equal(kimiContract.steer, false)
assert.equal(kimiContract.followup, true)
assert.equal(kimiContract.sessionFork, false)
assert.equal(kimiContract.models[1].thinkingOptions, undefined)
assert.throws(() => assertACPProviderConfig('kimi', { agentId: 'kimi', workdir: '/tmp', permissionMode: 'read-only' }), /permission|权限|支持/)
assert.equal(kimiContract.additionalDirectoriesNew, true)
assert.equal(kimiContract.additionalDirectoriesResume, true)
assert.equal(kimiContract.nativeGoal, false)
assert.equal(kimiContract.structuredUsage, false)
assert.equal(kimiContract.structuredSubagents, false)
assert.equal(kimiContract.formElicitation, false)
assert.equal(kimiContract.freeTextElicitation, false)

assert.throws(
  () => assertAgentSupportsSteer(projected),
  /unsupported_target_capability: Kimi Code \(ACP\) does not support steer/
)

console.log('kimi-capability-gates: negotiated capability overlay stays authoritative')
