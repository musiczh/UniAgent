import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { continueMarkdownList } from '../src/renderer/listContinuation.ts'
import { isSessionBusy } from '../src/shared/sessionStatus.ts'
import { resolveQuickCreateAgent, resolveRequirementProjectId } from '../src/renderer/components/NewTaskPanel.tsx'

const ordered = continueMarkdownList('1. first', 8, 8)
assert.deepEqual(ordered, { value: '1. first\n2. ', caret: 12 })

const unordered = continueMarkdownList('  * item', 8, 8)
assert.deepEqual(unordered, { value: '  * item\n  * ', caret: 13 })

const empty = continueMarkdownList('1. first\n2. ', 12, 12)
assert.deepEqual(empty, { value: '1. first\n', caret: 9 })

const textAfterMarker = continueMarkdownList('1. first\n2. later', 12, 12)
assert.deepEqual(textAfterMarker, { value: '1. first\n2. \n3. later', caret: 16 })

const splitMidLine = continueMarkdownList('1. hello world', 8, 8)
assert.deepEqual(splitMidLine, { value: '1. hello\n2. world', caret: 12 })

const agents = [{ id: 'codex' }, { id: 'traex' }]
assert.equal(resolveQuickCreateAgent(agents, 'traex', 'codex')?.id, 'traex')
assert.equal(resolveQuickCreateAgent(agents, undefined, 'traex')?.id, 'traex')
assert.equal(resolveQuickCreateAgent(agents, undefined, 'missing')?.id, 'codex')
assert.equal(resolveQuickCreateAgent(agents, 'missing', 'codex'), undefined)

assert.equal(resolveRequirementProjectId('requirement-a', [{ id: 'requirement-a', projectId: 'project-a' }], [{ id: 'project-a' }]), 'project-a')
assert.equal(resolveRequirementProjectId('requirement-a', [{ id: 'requirement-a', projectId: 'missing' }], [{ id: 'project-a' }]), undefined)

const composerSource = readFileSync(
  resolve('src/renderer/components/Composer.tsx'),
  'utf8'
)
assert.doesNotMatch(
  composerSource,
  /pendingCmd|cmd-arg-input/,
  'Composer must not restore the removed legacy command-argument input'
)
assert.match(
  composerSource,
  /const busy = isSessionBusy\(status\)/,
  'Composer must keep cancelling sessions in the busy send/queue state'
)

assert.equal(isSessionBusy('cancelling'), true)

console.log('list continuation tests passed')
