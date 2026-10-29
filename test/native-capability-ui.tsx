import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import DOMPurify from 'dompurify'
import { act, createElement, useLayoutEffect, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  addNativeCandidateId,
  buildNativeCapabilityScope,
  filterNativeCandidates,
  retainNativeCandidateIds,
  rollbackOptimisticSessionStatus,
  shouldApplyNativeCapabilityResponse,
  useAttachments,
  useNativeCapabilities
} from '../src/renderer/hooks.ts'
import {
  ComposerCapabilityChips,
  replaceComposerCommand
} from '../src/renderer/components/SkillChips.tsx'
import { NativeActionMenu } from '../src/renderer/components/NativeActionMenu.tsx'
import {
  ReviewStartDialog,
  buildReviewDraft,
  isReviewDraftValid
} from '../src/renderer/components/ReviewStartDialog.tsx'
import {
  buildComposerDelivery,
  composerDraftSeedKey,
  dispatchComposerDelivery,
  filterComposerSeedAttachments,
  shouldHydrateComposerDraftSeed,
  shouldReconcileComposerDraftSeed,
  shouldResetComposerDraft,
  shouldResetGoalDraft,
  snapshotComposerDraft,
  submitComposerDraft
} from '../src/renderer/components/Composer.tsx'
import {
  buildCreatedComposerDraftSeed,
  completeNewTaskCreation,
  dispatchNewTaskDelivery,
  guardNewTaskConfigurationMutation,
  snapshotNewTaskDraft
} from '../src/renderer/components/NewTaskPanel.tsx'
import * as newTaskPanelContracts from '../src/renderer/components/NewTaskPanel.tsx'
import {
  displayedGoalTimeSeconds,
  GoalStatusBar,
  goalStatusLabel
} from '../src/renderer/components/GoalStatusBar.tsx'
import { PlanModeBadge } from '../src/renderer/components/PlanModeBadge.tsx'
import { EventStream, toolCallDetail, toolCallTitle } from '../src/renderer/components/EventStream.tsx'
import type {
  NativeCapabilitySnapshot,
  NativeCapabilityChange,
  NativeMcpCandidate,
  NativeSkillCandidate
} from '../src/shared/nativeCapabilities.ts'
import type { Attachment, PickedFile, Session } from '../src/shared/types.ts'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const skillCandidate: NativeSkillCandidate = {
  id: 'skill:/skills/docs/SKILL.md',
  kind: 'skill',
  name: 'docs',
  path: '/skills/docs/SKILL.md',
  description: 'OpenAI 产品与 Codex 官方说明',
  enabled: true
}

const mcpCandidate: NativeMcpCandidate = {
  id: 'mcp:figma',
  kind: 'mcp',
  name: 'figma',
  description: 'Figma 原生 MCP Server',
  authStatus: 'oAuth',
  startupStatus: 'ready',
  toolNames: ['get_file']
}

const snapshot: NativeCapabilitySnapshot = {
  agentId: 'codex',
  workdir: '/repo',
  source: 'provider-native',
  candidates: [mcpCandidate, skillCandidate],
  actions: {
    goal: true,
    review: true,
    plan: { id: 'plan', name: 'Plan', model: null, reasoningEffort: null }
  },
  errors: []
}

const createdSession: Session = {
  id: 'session-created',
  title: 'Created',
  config: { agentId: 'codex', workdir: '/repo', permissionMode: 'ask' },
  status: 'idle',
  createdAt: 1
}

function capabilityChipsContract(): void {
  const markup = renderToStaticMarkup(createElement(ComposerCapabilityChips, {
    command: 'plan',
    candidates: [mcpCandidate, skillCandidate],
    onRemoveCommand: () => undefined,
    onRemoveCandidate: () => undefined
  }))
  assert.ok(
    markup.indexOf('data-command="plan"') < markup.indexOf('data-candidate="mcp:figma"'),
    'the single command chip must be the first capability chip in the DOM'
  )
  assert.equal((markup.match(/composer-command-chip/g) || []).length, 1)
  assert.equal(replaceComposerCommand('goal', 'plan'), 'plan')
  assert.equal(replaceComposerCommand('plan', 'goal'), 'goal')
}

function nativeActionMenuContract(): void {
  const markup = renderToStaticMarkup(createElement(NativeActionMenu, {
    actions: { goal: true, review: true, plan: null },
    disabled: false,
    onSelectCommand: () => undefined,
    onOpenReview: () => undefined
  }))
  assert.match(markup, />Goal</)
  assert.match(markup, />Review</)
  assert.doesNotMatch(markup, />Plan</)

  const disabledMarkup = renderToStaticMarkup(createElement(NativeActionMenu, {
    actions: snapshot.actions,
    disabled: true,
    onSelectCommand: () => undefined,
    onOpenReview: () => undefined
  }))
  assert.equal((disabledMarkup.match(/disabled=""/g) || []).length, 3)

  const pendingCreateMarkup = renderToStaticMarkup(createElement(NativeActionMenu, {
    actions: snapshot.actions,
    disabled: false,
    reviewDisabled: true,
    onSelectCommand: () => undefined,
    onOpenReview: () => undefined
  }))
  assert.equal(
    (pendingCreateMarkup.match(/disabled=""/g) || []).length,
    1,
    'pending create keeps Goal/Plan draft commands editable while Review stays disabled'
  )
}

function slashCandidateContract(): void {
  const manySkills = Array.from({ length: 91 }, (_, index) => ({
    ...skillCandidate, id: `skill:/skills/skill-${index}/SKILL.md`, name: `skill-${index}`
  }))
  assert.deepEqual(filterNativeCandidates(manySkills, ''), manySkills)
  assert.deepEqual(filterNativeCandidates(manySkills, 'skill-90'), [manySkills[90]])
  assert.deepEqual(
    filterNativeCandidates([skillCandidate, mcpCandidate], 'fig').map((candidate) => candidate.id),
    ['mcp:figma']
  )
  assert.deepEqual(addNativeCandidateId([], skillCandidate.id), [skillCandidate.id])
  assert.deepEqual(
    addNativeCandidateId([skillCandidate.id], skillCandidate.id),
    [skillCandidate.id],
    'native candidate IDs must be de-duplicated'
  )
  assert.deepEqual(
    retainNativeCandidateIds(
      [skillCandidate.id, 'mcp:removed'],
      [skillCandidate, mcpCandidate]
    ),
    [skillCandidate.id],
    'a capability refresh must remove unavailable IDs'
  )
}

function reviewDraftContract(): void {
  assert.deepEqual(buildReviewDraft('uncommittedChanges', '', '', ''), {
    scope: { type: 'uncommittedChanges' }
  })
  assert.deepEqual(buildReviewDraft('baseBranch', ' master ', '', ' focus tests '), {
    scope: { type: 'baseBranch', branch: 'master' },
    instructions: 'focus tests'
  })
  assert.deepEqual(buildReviewDraft('commit', '', ' abc123 ', ''), {
    scope: { type: 'commit', sha: 'abc123' }
  })
  assert.deepEqual(buildReviewDraft('custom', '', '', ' security only '), {
    scope: { type: 'custom' },
    instructions: 'security only'
  })
  assert.equal(isReviewDraftValid(buildReviewDraft('baseBranch', ' ', '', '')), false)
  assert.equal(isReviewDraftValid(buildReviewDraft('commit', '', ' ', '')), false)
  assert.equal(isReviewDraftValid(buildReviewDraft('custom', '', '', ' ')), false)
  assert.equal(isReviewDraftValid(buildReviewDraft('custom', '', '', 'security')), true)

  const markup = renderToStaticMarkup(createElement(ReviewStartDialog, {
    open: true,
    submitting: false,
    onClose: () => undefined,
    onSubmit: () => undefined
  }))
  assert.match(markup, /role="dialog"/)
  assert.match(markup, /未提交的修改/)
  assert.match(markup, /相对基础分支/)
  assert.match(markup, /指定 Commit/)
  assert.match(markup, /自定义审查/)
}

async function deliveryAndResetContract(): Promise<void> {
  const attachment: Attachment = { kind: 'file', path: '/tmp/a.txt', name: 'a.txt' }
  assert.deepEqual(
    buildComposerDelivery('goal', ' finish native UI ', [attachment], [skillCandidate.id]),
    {
      kind: 'goal',
      action: { type: 'goal.set', objective: 'finish native UI' }
    },
    'Goal must use only trimmed text and must not consume attachments or candidates'
  )
  assert.deepEqual(
    buildComposerDelivery('plan', ' implement it ', [attachment], [skillCandidate.id]),
    {
      kind: 'turn',
      prompt: 'implement it',
      attachments: [attachment],
      selection: { candidateIds: [skillCandidate.id] },
      activatePlan: true
    }
  )
  assert.deepEqual(
    buildComposerDelivery(null, ' implement it ', [], [mcpCandidate.id]),
    {
      kind: 'turn',
      prompt: 'implement it',
      attachments: undefined,
      selection: { candidateIds: [mcpCandidate.id] },
      activatePlan: false
    }
  )
  assert.equal(buildComposerDelivery('goal', '  ', [attachment], []), null)
  assert.equal(buildComposerDelivery('plan', '  ', [attachment], []), null)

  const sessionCalls: unknown[][] = []
  await dispatchComposerDelivery(
    buildComposerDelivery('goal', 'ship it', [attachment], [skillCandidate.id])!,
    false,
    {
      runNativeAction: async (...args) => { sessionCalls.push(['native', ...args]) },
      send: async (...args) => { sessionCalls.push(['send', ...args]) },
      forceSend: async (...args) => { sessionCalls.push(['force', ...args]) }
    }
  )
  assert.deepEqual(sessionCalls, [['native', { type: 'goal.set', objective: 'ship it' }]])

  const newTaskCalls: unknown[][] = []
  const planDelivery = buildComposerDelivery('plan', 'plan it', [attachment], [mcpCandidate.id])!
  await dispatchNewTaskDelivery(
    { agentId: 'codex', workdir: '/repo', permissionMode: 'ask' },
    planDelivery,
    {
      create: async (...args) => { newTaskCalls.push(['create', ...args]); return createdSession },
      createNativeAction: async (...args) => { newTaskCalls.push(['native', ...args]); return createdSession }
    }
  )
  assert.deepEqual(newTaskCalls, [[
    'create',
    { agentId: 'codex', workdir: '/repo', permissionMode: 'ask' },
    'plan it',
    [attachment],
    { candidateIds: [mcpCandidate.id] },
    true
  ]])
  const goalSession = await dispatchNewTaskDelivery(
    { agentId: 'codex', workdir: '/repo', permissionMode: 'ask' },
    buildComposerDelivery('goal', 'goal it', [attachment], [skillCandidate.id])!,
    {
      create: async () => { throw new Error('Goal must not use normal create') },
      createNativeAction: async (...args) => {
        newTaskCalls.push(['native', ...args])
        return createdSession
      }
    }
  )
  assert.equal(goalSession, createdSession)
  assert.deepEqual(newTaskCalls.at(-1), [
    'native',
    { agentId: 'codex', workdir: '/repo', permissionMode: 'ask' },
    { type: 'goal.set', objective: 'goal it' }
  ], 'New Task Goal sends neither candidates nor attachments to the native action')

  const accepted = snapshotComposerDraft({
    sessionId: 'session-a',
    text: 'draft',
    attachments: [attachment],
    candidateIds: [skillCandidate.id],
    command: 'goal',
    generation: 3
  })
  const same = snapshotComposerDraft({
    sessionId: 'session-a',
    text: 'draft',
    attachments: [attachment],
    candidateIds: [skillCandidate.id],
    command: 'goal',
    generation: 3
  })
  const edited = snapshotComposerDraft({
    sessionId: 'session-a',
    text: 'draft plus more',
    attachments: [attachment],
    candidateIds: [skillCandidate.id],
    command: 'goal',
    generation: 4
  })
  assert.equal(shouldResetComposerDraft(same, accepted), true)
  assert.equal(shouldResetGoalDraft(same, accepted), true)
  assert.equal(shouldResetComposerDraft(edited, accepted), false)
  assert.equal(shouldResetGoalDraft(edited, accepted), false)

  let acceptedCount = 0
  const error = await submitComposerDraft(
    async () => { throw new Error('native action failed') },
    () => { acceptedCount += 1 }
  )
  assert.equal(error, 'native action failed')
  assert.equal(acceptedCount, 0, 'failed IPC must preserve the exact renderer draft')

  const composerSource = readFileSync(
    'src/renderer/components/Composer.tsx',
    'utf8'
  )
  assert.match(
    composerSource,
    /delivery.kind === 'goal'[\s\S]*?draftRef.current = clearedDraft[\s\S]*?setText\(''\)[\s\S]*?await submitComposerDraft/,
    'Goal submission must clear its accepted text before awaiting the native action'
  )
  assert.match(
    composerSource,
    /if \(error && clearedDraft && shouldResetComposerDraft\(draftRef.current, clearedDraft\)\)/,
    'a failed optimistic Goal submission must reuse the guarded draft restoration path'
  )
}

function responseAnnotationDeliveryContract(): void {
  const instruction = 'Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, where N is its one-based array position (for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.'

  assert.equal(
    buildComposerDelivery(null, '  Apply these changes  ', [], [], [
      { quote: '  selected response  ', comment: '  revise this  ' }
    ])?.prompt,
    `\n# Response annotations:\n${instruction}\n<response-annotations>\n[{"text":"selected response","annotation":"revise this"}]\n</response-annotations>\n\n## My request:\nApply these changes\n`,
    'response comments must use the Codex response-annotations wire format'
  )

  assert.equal(
    buildComposerDelivery(null, 'continue', [], [], [
      { quote: 'first', comment: 'one' },
      { quote: 'second', comment: '' }
    ])?.prompt,
    `\n# Response annotations:\n${instruction}\n<response-annotations>\n[{"text":"first","annotation":"one"},{"text":"second"}]\n</response-annotations>\n\n## My request:\ncontinue\n`,
    'annotation order must be preserved and empty comments must omit annotation'
  )

  const emptyRequest = buildComposerDelivery(null, '   ', [], [], [
    { quote: 'line 1\n"line 2"', comment: 'use \\ safely' }
  ])
  assert.equal(
    emptyRequest?.prompt,
    `\n# Response annotations:\n${instruction}\n<response-annotations>\n[{"text":"line 1\\n\\"line 2\\"","annotation":"use \\\\ safely"}]\n</response-annotations>\n\n## My request:\n\n`,
    'an annotation-only turn must keep the request empty and JSON-escape its content'
  )
  assert.equal(emptyRequest?.displayText, '解决一下这些注释')
}

async function newTaskAtomicHandoffContract(): Promise<void> {
  const attachment: PickedFile = {
    kind: 'image',
    path: '/tmp/pasted.png',
    name: 'pasted.png',
    mime: 'image/png',
    previewDataUrl: 'data:image/png;base64,preview'
  }
  const submitted = snapshotNewTaskDraft({
    agentId: 'codex',
    workdir: '/repo',
    text: 'original',
    command: 'plan',
    candidateIds: [skillCandidate.id],
    attachments: [attachment],
    previews: { [attachment.path]: attachment.previewDataUrl! }
  })
  let current = submitted
  let resolveCreation!: (session: Session) => void
  const creation = new Promise<Session>((resolve) => { resolveCreation = resolve })
  const commits: unknown[][] = []
  const pending = completeNewTaskCreation({
    create: () => creation,
    kind: 'turn',
    submitted,
    current: () => current,
    commit: (session, seed) => { commits.push([session, seed]) }
  })
  assert.equal(commits.length, 0, 'App navigation must wait until the child snapshots pending edits')
  current = snapshotNewTaskDraft({
    agentId: 'codex',
    workdir: '/repo',
    text: 'new draft while pending',
    command: 'goal',
    candidateIds: [mcpCandidate.id],
    attachments: [attachment],
    previews: { [attachment.path]: attachment.previewDataUrl! }
  })
  resolveCreation(createdSession)
  await pending
  assert.deepEqual(commits, [[createdSession, {
    sessionId: 'session-created',
    agentId: 'codex',
    workdir: '/repo',
    text: 'new draft while pending',
    command: 'goal',
    candidateIds: [mcpCandidate.id],
    attachments: [attachment]
  }]])

  assert.equal(
    buildCreatedComposerDraftSeed(createdSession, 'turn', submitted, submitted),
    null,
    'an exact accepted normal or Plan draft is fully consumed'
  )
  assert.deepEqual(
    buildCreatedComposerDraftSeed(createdSession, 'goal', submitted, submitted),
    {
      sessionId: 'session-created', agentId: 'codex', workdir: '/repo',
      text: '', command: null, candidateIds: [skillCandidate.id], attachments: [attachment]
    },
    'Goal keeps candidates, attachments, and renderer preview data without sending them to Goal'
  )
  assert.deepEqual(
    buildCreatedComposerDraftSeed(createdSession, 'review', submitted, submitted),
    {
      sessionId: 'session-created', agentId: 'codex', workdir: '/repo',
      text: 'original', command: 'plan', candidateIds: [skillCandidate.id], attachments: [attachment]
    },
    'Review hands the complete untouched draft to the created session'
  )
  const pendingGoalSeed = buildCreatedComposerDraftSeed(createdSession, 'goal', submitted, current)
  const pendingReviewSeed = buildCreatedComposerDraftSeed(createdSession, 'review', submitted, current)
  assert.deepEqual(pendingGoalSeed, commits[0][1], 'pending Goal edits seed the complete latest draft')
  assert.deepEqual(pendingReviewSeed, commits[0][1], 'pending Review edits seed the complete latest draft')

  let failedCommits = 0
  await assert.rejects(() => completeNewTaskCreation({
    create: async () => { throw new Error('temporary failure') },
    kind: 'review',
    submitted,
    current: () => current,
    commit: () => { failedCommits += 1 }
  }), /temporary failure/)
  assert.equal(failedCommits, 0, 'a failed create keeps New Task mounted for retry')
  current = snapshotNewTaskDraft({
    agentId: 'codex', workdir: '/repo', text: 'retry draft', command: null,
    candidateIds: [], attachments: [], previews: {}
  })
  await completeNewTaskCreation({
    create: async () => createdSession,
    kind: 'review',
    submitted,
    current: () => current,
    commit: (_session, seed) => { commits.push(['retry', seed]) }
  })
  assert.deepEqual(commits.at(-1), ['retry', {
    sessionId: 'session-created', agentId: 'codex', workdir: '/repo',
    text: 'retry draft', command: null, candidateIds: [], attachments: []
  }], 'retry commits the latest preserved draft after a temporary failure')
}

function composerSeedConsumptionContract(): void {
  const attachment: PickedFile = {
    kind: 'image', path: '/tmp/pasted.png', name: 'pasted.png',
    previewDataUrl: 'data:image/png;base64,preview'
  }
  const seed = {
    sessionId: 'session-created', agentId: 'codex', workdir: '/repo',
    text: 'continue', command: 'plan' as const, candidateIds: [skillCandidate.id],
    attachments: [attachment]
  }
  const key = composerDraftSeedKey(seed)
  const config = { agentId: 'codex', workdir: '/repo', permissionMode: 'ask' as const }
  assert.equal(
    shouldHydrateComposerDraftSeed(seed, null, 'session-created', config),
    true,
    'matching seed data hydrates before capability discovery succeeds'
  )
  assert.equal(
    shouldHydrateComposerDraftSeed(seed, key, 'session-created', config),
    false,
    'capability refresh must not hydrate over user edits a second time'
  )
  assert.equal(
    shouldHydrateComposerDraftSeed(seed, null, 'session-created', { ...config, workdir: '/other' }),
    false,
    'a mismatched scope never hydrates'
  )
  assert.equal(
    shouldReconcileComposerDraftSeed(seed, key, null, 'session-created', config, {
      ...snapshot,
      errors: ['temporary']
    }, true),
    false,
    'temporary discovery errors retain hydrated candidate IDs and keep the seed replayable'
  )
  const editedWhileWaiting = {
    text: 'edited after hydration',
    command: 'goal' as const,
    candidateIds: [skillCandidate.id, mcpCandidate.id],
    attachments: [...seed.attachments, {
      kind: 'file' as const,
      path: '/tmp/added.txt',
      name: 'added.txt'
    }]
  }
  assert.equal(
    shouldHydrateComposerDraftSeed(seed, key, 'session-created', config),
    false,
    'an error refresh cannot rehydrate the seed over newer text, command, candidates, or attachments'
  )
  assert.equal(
    shouldReconcileComposerDraftSeed(seed, key, null, 'session-created', config, snapshot, true),
    true,
    'the first successful same-scope snapshot reconciles candidates and consumes the seed'
  )
  assert.equal(
    shouldReconcileComposerDraftSeed(seed, key, key, 'session-created', config, snapshot, true),
    false,
    'a successful seed is consumed once'
  )
  assert.equal(
    shouldReconcileComposerDraftSeed(
      seed,
      key,
      null,
      'session-created',
      { ...config, workdir: '/other' },
      snapshot,
      true
    ),
    false,
    'a mismatched Composer scope never consumes a retained seed'
  )
  assert.equal(
    shouldHydrateComposerDraftSeed(seed, null, 'session-created', config),
    true,
    'unmount/remount before successful consumption can replay the retained seed'
  )
  assert.deepEqual(
    {
      ...editedWhileWaiting,
      candidateIds: retainNativeCandidateIds(editedWhileWaiting.candidateIds, [mcpCandidate])
    },
    {
      ...editedWhileWaiting,
      candidateIds: [mcpCandidate.id]
    },
    'success only removes invalid IDs from the latest edited draft and preserves all other fields'
  )
  assert.deepEqual(
    retainNativeCandidateIds(editedWhileWaiting.candidateIds, [mcpCandidate]),
    [mcpCandidate.id],
    'success reconciles the latest user-edited candidate IDs instead of restoring the seed list'
  )
  assert.deepEqual(
    filterComposerSeedAttachments([
      attachment,
      { kind: 'file', path: '/tmp/a.txt', name: 'a.txt' }
    ], true, false),
    [attachment],
    'seed hydration keeps renderer previews while honoring current attachment capabilities'
  )
}

function newTaskConfigurationFreezeContract(): void {
  const mutations: string[] = []
  for (const name of ['agent', 'workdir', 'preset']) {
    assert.equal(
      guardNewTaskConfigurationMutation(true, () => { mutations.push(name) }),
      false,
      `${name} configuration must stay frozen while create is pending`
    )
  }
  assert.deepEqual(mutations, [])
  assert.equal(
    guardNewTaskConfigurationMutation(false, () => { mutations.push('agent') }),
    true
  )
  assert.deepEqual(mutations, ['agent'])
}

function oneShotNewTaskInputContract(): void {
  const claimInput = (
    newTaskPanelContracts as unknown as Record<string, unknown>
  ).claimNewTaskOneShotInput
  assert.equal(
    typeof claimInput,
    'function',
    'prompt prefill and quick-create inputs need an identity-based one-shot claim'
  )
  if (typeof claimInput !== 'function') return
  const prefill = { text: 'initialize' }
  const first = claimInput(prefill, null, false) as {
    claimed: typeof prefill | null
    shouldApply: boolean
  }
  assert.equal(first.shouldApply, true)
  assert.equal(first.claimed, prefill)

  const pendingReplay = claimInput(prefill, first.claimed, true) as typeof first
  assert.equal(pendingReplay.shouldApply, false)
  const unlockedReplay = claimInput(prefill, pendingReplay.claimed, false) as typeof first
  assert.equal(
    unlockedReplay.shouldApply,
    false,
    'unlocking after a failed create must not replay the same prompt prefill'
  )

  const quickCreate = { agentId: 'codex', workdir: '/repo' }
  const skippedPendingQuickCreate = claimInput(quickCreate, null, true) as {
    claimed: typeof quickCreate | null
    shouldApply: boolean
  }
  assert.equal(skippedPendingQuickCreate.claimed, quickCreate)
  assert.equal(skippedPendingQuickCreate.shouldApply, false)
  assert.equal(
    (claimInput(quickCreate, skippedPendingQuickCreate.claimed, false) as typeof skippedPendingQuickCreate).shouldApply,
    false,
    'a pending quick-create input is claimed once and cannot replay on failure unlock'
  )
}

async function attachmentPreviewEffectTimingContract(): Promise<void> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousActFlag = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  const noop = (): void => undefined
  class FakeHTMLElement {}
  class FakeHTMLIFrameElement extends FakeHTMLElement {}
  const fakeWindow = {
    ...globalThis,
    HTMLElement: FakeHTMLElement,
    HTMLIFrameElement: FakeHTMLIFrameElement,
    addEventListener: noop,
    removeEventListener: noop,
    getComputedStyle: () => ({})
  } as unknown as Window & typeof globalThis
  const fakeDocument = {
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: null,
    body: null
  } as unknown as Document
  const container = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
    parentNode: null,
    firstChild: null,
    lastChild: null,
    addEventListener: noop,
    removeEventListener: noop,
    textContent: ''
  } as unknown as Element
  ;(fakeDocument as unknown as { documentElement: Element }).documentElement = container
  ;(fakeDocument as unknown as { body: Element }).body = container
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

  const picked: PickedFile = {
    kind: 'image', path: '/tmp/pasted.png', name: 'pasted.png',
    previewDataUrl: 'data:image/png;base64,preview'
  }
  let observed: { attachments: Attachment[]; previews: Record<string, string> } | undefined
  function Probe(): null {
    const state = useAttachments()
    observed = { attachments: state.attachments, previews: state.previews }
    useLayoutEffect(() => state.replacePickedFiles([picked]), [state.replacePickedFiles])
    return null
  }
  const goalStateOwners: string[] = []
  function GoalSessionStateProbe({ sessionId }: { sessionId: string }): null {
    const [stateOwner] = useState(sessionId)
    useLayoutEffect(() => { goalStateOwners.push(stateOwner) }, [sessionId, stateOwner])
    return null
  }

  try {
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(container)
    await act(async () => { root.render(createElement(Probe)) })
    assert.deepEqual(observed, {
      attachments: [{ kind: 'image', path: '/tmp/pasted.png', name: 'pasted.png' }],
      previews: { '/tmp/pasted.png': 'data:image/png;base64,preview' }
    }, 'seed replacement must keep attachment and preview through real React effect ordering')
    await act(async () => {
      root.render(createElement(GoalSessionStateProbe, {
        key: 'session-a',
        sessionId: 'session-a'
      }))
    })
    await act(async () => {
      root.render(createElement(GoalSessionStateProbe, {
        key: 'session-b',
        sessionId: 'session-b'
      }))
    })
    assert.deepEqual(
      goalStateOwners,
      ['session-a', 'session-b'],
      'switching the React key must remount session-local pending/error state for the next Goal'
    )
    let publish!: (change: NativeCapabilityChange) => void
    let resolveCatalog!: (snapshot: NativeCapabilitySnapshot) => void
    let capabilityState!: ReturnType<typeof useNativeCapabilities>
    const queries: unknown[] = []
    Object.assign(fakeWindow, { uniagent: {
      getNativeCapabilities: (request: unknown) => {
        queries.push(request)
        return queries.length === 1 ? new Promise<NativeCapabilitySnapshot>(resolve => { resolveCatalog = resolve }) : Promise.resolve(snapshot)
      },
      onNativeCapabilitiesChanged: (listener: typeof publish) => { publish = listener; return noop }
    } })
    function CapabilityProbe(): null {
      capabilityState = useNativeCapabilities('codex', '/repo')
      return null
    }
    await act(async () => { root.render(createElement(CapabilityProbe)) })
    await act(async () => {
      for (let i = 0; i < 20; i++) publish({ agentId: 'codex', workdir: '/repo',
        mcpStatus: { name: 'figma', status: 'failed', statusMessage: 'fixture unavailable' } })
      resolveCatalog(snapshot)
    })
    assert.equal(queries.length, 1, 'MCP startup notifications must never launch catalog probes')
    const updated = capabilityState.snapshot.candidates.find(candidate => candidate.id === 'mcp:figma')!
    assert.equal(updated.kind === 'mcp' && updated.startupStatus, 'failed', 'status received during initial discovery survives its late response')
    assert.equal(capabilityState.ready, true)
    await act(async () => { publish({ agentId: 'codex', workdir: '/repo' }) })
    assert.equal(queries.length, 2, 'real catalog changes still refresh native candidates')
    await act(async () => { root.unmount() })
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete (globalThis as { window?: unknown }).window
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete (globalThis as { document?: unknown }).document
    if (previousActFlag) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActFlag)
    else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
  }
}

function generationGuardContract(): void {
  const oldScope = buildNativeCapabilityScope('codex', '/old')
  const currentScope = buildNativeCapabilityScope('codex', '/repo')
  assert.notEqual(oldScope, currentScope, 'workdir must be part of the capability scope')
  assert.equal(shouldApplyNativeCapabilityResponse(currentScope, oldScope, 2, 1), false)
  assert.equal(shouldApplyNativeCapabilityResponse(currentScope, currentScope, 2, 1), false)
  assert.equal(shouldApplyNativeCapabilityResponse(currentScope, currentScope, 2, 2), true)

  assert.deepEqual(
    rollbackOptimisticSessionStatus({ 'session-a': 'running' }, 'session-a', 'idle'),
    { 'session-a': 'idle' },
    'an IPC rejection must not leave an optimistic running state behind'
  )
  assert.deepEqual(
    rollbackOptimisticSessionStatus({ 'session-a': 'running' }, 'session-a', undefined),
    {},
    'rollback must restore the absence of an override so Session status remains authoritative'
  )
  const backendAdvanced = { 'session-a': 'awaiting-approval' } as const
  assert.equal(
    rollbackOptimisticSessionStatus(backendAdvanced, 'session-a', 'idle'),
    backendAdvanced,
    'a real backend status must win over optimistic rollback'
  )
}

async function persistentGoalAndPlanModeContract(): Promise<void> {
  const goal = {
    objective: '完成原生能力接入',
    status: 'active' as const,
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 3,
    createdAt: 1,
    updatedAt: 2
  }
  const goalMarkup = renderToStaticMarkup(createElement(GoalStatusBar, { goal }))
  assert.match(goalMarkup, /class="goal-status-bar conversation-column"/)
  assert.match(goalMarkup, /role="button"/)
  assert.match(goalMarkup, /tabindex="0"/)
  assert.match(goalMarkup, />Goal</)
  assert.doesNotMatch(goalMarkup, /当前 Goal/)
  assert.doesNotMatch(goalMarkup, /完成原生能力接入/)
  assert.doesNotMatch(goalMarkup, /已使用/)
  assert.match(goalMarkup, /class="goal-toggle-btn"/)

  assert.match(goalMarkup, /aria-label="展开 Goal"/)
  assert.match(goalMarkup, /aria-expanded="false"/)
  assert.doesNotMatch(goalMarkup, /<button/)
  assert.doesNotMatch(goalMarkup, /清除 Goal|goal-clear-btn/)
  assert.equal(displayedGoalTimeSeconds(goal, 5_000, true), 6)
  assert.equal(displayedGoalTimeSeconds(goal, 5_000, false), 3)
  assert.equal(displayedGoalTimeSeconds({ ...goal, status: 'paused' }, 5_000, true), 3)
  const completedGoalMarkup = renderToStaticMarkup(createElement(GoalStatusBar, {
    goal: { ...goal, status: 'complete', tokensUsed: 566, timeUsedSeconds: 11 }
  }))
  assert.match(completedGoalMarkup, /已完成 · 566 Token/)
  const goalBubbleMarkup = renderToStaticMarkup(createElement(EventStream, {
    sessionId: 'goal-session',
    events: [{
      sessionId: 'goal-session', seq: 1, ts: 1, type: 'goal_message',
      payload: { text: goal.objective }
    }]
  }))
  assert.match(goalBubbleMarkup, /data-command="goal"/)
  assert.match(goalBubbleMarkup, /class="capability-chip-name">Goal</)
  assert.match(goalBubbleMarkup, /完成原生能力接入/)
  assert.doesNotMatch(goalBubbleMarkup, /实施此计划？/)
  const planFollowedByGoalMarkup = renderToStaticMarkup(createElement(EventStream, {
    sessionId: 'goal-session',
    events: [
      {
        sessionId: 'goal-session', seq: 1, ts: 1, type: 'user_message',
        payload: { text: '先给我一个计划' }
      },
      {
        sessionId: 'goal-session', seq: 2, ts: 2, type: 'agent_message', state: 'success',
        payload: { id: 'plan-1', kind: 'plan', text: '执行计划' }
      },
      {
        sessionId: 'goal-session', seq: 3, ts: 3, type: 'turn_completed',
        payload: { turnId: 'turn-1' }
      },
      {
        sessionId: 'goal-session', seq: 4, ts: 4, type: 'goal_message',
        payload: { text: goal.objective }
      }
    ],
    onImplementPlan: async () => undefined,
    onRevisePlan: async () => undefined
  }))
  assert.match(
    planFollowedByGoalMarkup,
    /完成原生能力接入/,
    'a Goal prompt must render as the latest marked user turn'
  )
  assert.doesNotMatch(
    planFollowedByGoalMarkup,
    /实施此计划？/,
    'a Goal prompt must retire the previous Plan decision like a normal user message'
  )
  const userMessageAfterGoalMarkup = renderToStaticMarkup(createElement(EventStream, {
    sessionId: 'goal-session',
    events: [
      {
        sessionId: 'goal-session', seq: 1, ts: 1, type: 'user_message',
        payload: { text: '先给我一个计划' }
      },
      {
        sessionId: 'goal-session', seq: 2, ts: 2, type: 'agent_message', state: 'success',
        payload: { id: 'plan-1', kind: 'plan', text: '执行计划' }
      },
      {
        sessionId: 'goal-session', seq: 3, ts: 3, type: 'turn_completed',
        payload: { turnId: 'turn-1' }
      },
      {
        sessionId: 'goal-session', seq: 4, ts: 4, type: 'goal_message',
        payload: { text: goal.objective }
      },
      {
        sessionId: 'goal-session', seq: 5, ts: 5, type: 'user_message',
        payload: { text: '开始一个新回合' }
      }
    ],
    onImplementPlan: async () => undefined,
    onRevisePlan: async () => undefined
  }))
  assert.doesNotMatch(
    userMessageAfterGoalMarkup,
    /实施此计划？/,
    'a real user turn after a Goal must retire the previous Plan decision'
  )
  assert.deepEqual(
    ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].map((status) =>
      goalStatusLabel(status as Parameters<typeof goalStatusLabel>[0])
    ),
    ['进行中', '已暂停', '受阻', '用量受限', '预算受限', '已完成']
  )

  assert.equal(renderToStaticMarkup(createElement(PlanModeBadge, {
    mode: 'default', onExit: () => undefined
  })), '')
  const planMarkup = renderToStaticMarkup(createElement(PlanModeBadge, {
    mode: 'plan', onExit: () => undefined
  }))
  assert.match(planMarkup, /data-collaboration-mode="plan"/)
  assert.match(planMarkup, />Plan</)
  assert.doesNotMatch(planMarkup, /权限|请求批准|完全访问/)

  assert.equal(toolCallTitle({ provider: 'mcp', server: 'figma', name: 'get_file' }), 'MCP · figma · get_file')
  assert.equal(toolCallTitle({ name: 'dynamic' }), '工具调用: dynamic')
  assert.deepEqual(toolCallDetail({ provider: 'mcp', input: { path: 'a' } }, 'running'), { path: 'a' })
  assert.deepEqual(toolCallDetail({ provider: 'mcp', input: {}, result: { ok: true } }, 'success'), { ok: true })
  assert.deepEqual(toolCallDetail({ provider: 'mcp', input: {}, error: { message: 'failed' } }, 'failed'), { message: 'failed' })
  assert.deepEqual(toolCallDetail({ name: 'dynamic', raw: { legacy: true } }, 'success'), { legacy: true })

  const appSource = readFileSync('src/renderer/App.tsx', 'utf8')
  const headerAt = appSource.indexOf('<SessionHeader')
  const goalAt = appSource.indexOf('<GoalStatusBar', headerAt)
  const bodyAt = appSource.indexOf('<SessionConversation', headerAt)
  assert.ok(headerAt >= 0 && goalAt > headerAt && bodyAt > goalAt,
    'Goal status bar must stay outside scrolling session-body and immediately follow the header')
  assert.match(
    appSource,
    /<GoalStatusBar\s+key=\{activeSession\.id\}/s,
    'GoalStatusBar must use the active session identity as its React key so expansion state cannot cross sessions'
  )
  assert.match(
    appSource,
    /<GoalStatusBar[\s\S]*running=\{isSessionBusy\(activeStatus\)\}/,
    'Goal live time must follow the active session runtime state'
  )
  assert.match(appSource, /setCollaborationMode\(sessionId, mode\)/)

  const css = readFileSync('src/renderer/styles.css', 'utf8')
  assert.match(css, /\.goal-status-usage\s*\{[^}]*color:\s*#878a90;[^}]*font-size:\s*11\.5px;[^}]*font-weight:\s*400;/s)
}

function pendingExitPlanUsesPlanDecision(): void {
  const markup = renderToStaticMarkup(createElement(EventStream, {
    sessionId: 'plan-session',
    status: 'awaiting-approval',
    events: [
      {
        sessionId: 'plan-session', seq: 1, ts: 1, type: 'user_message',
        payload: { text: '先给我一个计划' }
      },
      {
        sessionId: 'plan-session', seq: 2, ts: 2, type: 'approval_request', state: 'pending',
        payload: {
          requestId: 'mode-1',
          method: 'mode/change/respond',
          kind: 'planMode',
          params: { targetMode: 'default', reason: 'ExitPlanMode' }
        }
      }
    ],
    onRespond: () => undefined
  }))
  assert.match(
    markup,
    /实施此计划？/,
    'a live ExitPlanMode request must reuse the plan decision while the turn is blocked'
  )
  assert.doesNotMatch(markup, /审批请求|ExitPlanMode/)
}

function editableResponseAnnotationContract(): void {
  const eventStreamSource = readFileSync('src/renderer/components/EventStream.tsx', 'utf8')
  const annotationSource = readFileSync('src/renderer/textAnnotations.ts', 'utf8')
  const css = readFileSync('src/renderer/styles.css', 'utf8')
  assert.ok(eventStreamSource.includes('onEditAnnotation={onEditAnnotation}'), 'reply highlights must open the comment editor')
  assert.ok(eventStreamSource.includes('onRemoveComment(editingId)'), 'the comment editor must delete its annotation')
  assert.ok(annotationSource.includes("mark.setAttribute('role', 'button')"), 'underlined text must be keyboard editable')
  assert.ok(css.includes('border-bottom: 2px solid var(--blue)'), 'comments must retain a blue underline')
}

if (process.env.UA_TEST_CASE === 'traex-mode-change-ui') {
  pendingExitPlanUsesPlanDecision()
  console.log('Native capability UI: traex-mode-change-ui ok')
  process.exit(0)
}

if (process.env.UA_TEST_CASE === 'response-annotations') {
  responseAnnotationDeliveryContract()
  console.log('Native capability UI: response-annotations ok')
  process.exit(0)
}

capabilityChipsContract()
nativeActionMenuContract()
slashCandidateContract()
reviewDraftContract()
await deliveryAndResetContract()
responseAnnotationDeliveryContract()
editableResponseAnnotationContract()
await newTaskAtomicHandoffContract()
composerSeedConsumptionContract()
newTaskConfigurationFreezeContract()
oneShotNewTaskInputContract()
await attachmentPreviewEffectTimingContract()
generationGuardContract()
await persistentGoalAndPlanModeContract()
pendingExitPlanUsesPlanDecision()

console.log('Native capability UI: 13/13 checks passed')
