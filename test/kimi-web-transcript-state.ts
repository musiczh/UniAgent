import assert from 'node:assert/strict'
import { KimiWebTranscriptState } from '../src/main/kimiWebTranscriptState.ts'

const state = new KimiWebTranscriptState('session')
state.reset('connection-1')
const frame = (type: string, payload: any) => ({ type, session_id: 'session', payload })
state.apply(frame('transcript.reset', { agent_id: 'main', seq: 3, snapshot: { items: [], interactions: [], attachments: [], prompts: [] } }))
const ops = (seq: number, operations: any[]) => state.apply(frame('transcript.ops', { agent_id: 'main', seq, ops: operations }))
ops(4, [{ op: 'turn.upsert', turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' }, prompt: 'hello' } },
  { op: 'step.upsert', turnId: 't1', step: { kind: 'step', stepId: 't1.0', ordinal: 0, state: 'running' } },
  { op: 'frame.upsert', turnId: 't1', stepId: 't1.0', frame: { kind: 'text', frameId: 'reply', role: 'assistant', text: 'hel' } }])
const append = { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.0', frameId: 'reply' }, offset: 2, text: 'llo' }
ops(5, [append])
assert.equal((state.snapshot().transcript as any[])[0].steps[0].frames[0].text, 'hello')
assert.equal(ops(5, [append]), false, 'replayed sequences never duplicate text')
assert.throws(() => ops(6, [{ ...append, offset: 9 }]), /transcript_gap/)
assert.throws(() => ops(6, [{ ...append, offset: 1, text: 'different' }]), /transcript_gap/)
assert.equal((state.snapshot().transcript as any[])[0].steps[0].frames[0].text, 'hello', 'a gap never partially commits an op batch')
assert.equal(state.apply({ type: 'agent', session_id: 'other', agent_id: 'main', status: 'running' }), false)
state.apply({ type: 'agent', session_id: 'session', agent_id: 'main', status: 'running', model: 'local', plan_mode: true, thinking: 'low', permission_mode: 'manual' })
assert.equal(state.status().busy, true)
assert.equal(state.status().plan_mode, true)
assert.equal(state.status().thinking_level, 'low')
assert.equal(state.status().permission, 'manual')
state.apply({ type: 'interaction', session_id: 'session', interaction_id: 'approval', kind: 'approval', status: 'pending', request: { tool_name: 'Write' } })
assert.equal((state.snapshot().pending_approvals as any[])[0].approval_id, 'approval')
state.apply({ type: 'interaction', session_id: 'session', interaction_id: 'approval', kind: 'approval', status: 'ended' })
assert.deepEqual(state.snapshot().pending_approvals, [])
ops(6, [{ op: 'interaction.upsert', interaction: { interactionId: 'restored-question', interactionKind: 'question', state: 'pending', request: { title: 'Restored choice' } } }])
assert.equal((state.snapshot().pending_questions as any[])[0].question_id, 'restored-question', 'native transcript interactionKind restores a pending question without a live interaction frame')
ops(7, [{ op: 'interaction.upsert', interaction: { interactionId: 'restored-question', interactionKind: 'question', state: 'answered' } }])
assert.deepEqual(state.snapshot().pending_questions, [])
ops(8, [{ op: 'turn.upsert', turn: { turnId: 't1', state: 'completed' } }])
assert.equal(state.snapshot().in_flight_turn, null)
assert.equal((state.snapshot().messages as any).items.length, 2, 'completed snapshots preserve both the user input and assistant text')
state.reset('connection-2')
assert.equal(state.snapshot().epoch, 'connection-2')
assert.deepEqual(state.snapshot().transcript, [], 'reconnecting discards old sequence watermarks and requests a fresh native baseline')
state.apply(frame('transcript.reset', { agent_id: 'main', seq: 9, snapshot: { items: [], interactions: [
  { interactionId: 'restored-approval', interactionKind: 'approval', state: 'pending', toolCallId: 'write', request: { tool_name: 'Write' } }
] } }))
assert.equal((state.snapshot().pending_approvals as any[])[0].approval_id, 'restored-approval', 'reconnect baseline restores a pending native approval')
console.log('Kimi subscribe_v2 transcript state: streams, replay, gaps, isolation, interactions and completion passed')

const turns = new KimiWebTranscriptState('modern')
const modern = (type: string, fields: any) => ({ type, session_id: 'modern', agent_id: 'main', ...fields })
const time = '2026-11-15T00:00:00Z'
turns.apply(modern('turns', { turns: [{ turn_id: 'turn-1', ordinal: 1, kind: 'agent', status: 'running', started_at: time, steps: [], items: [
  { type: 'user_message', item_id: 'u1', placement: 'opener', origin: { kind: 'user' }, text: 'original input', attachments: [], status: 'ended', outcome: 'completed', created_at: time },
  { type: 'assistant_message', item_id: 'a1', text: 'hel', step_index: 1, status: 'running', created_at: time }
] }], has_more: false }))
assert.equal(turns.ready, true, 'the new native turns baseline makes the session readable')
turns.apply(modern('item.delta', { turn_id: 'turn-1', item_id: 'a1', field: 'text', delta: 'lo' }))
assert.equal((turns.snapshot().messages as any).items.at(-1).content[0].text, 'hello')
turns.apply(modern('item.ended', { turn_id: 'turn-1', item: { type: 'assistant_message', item_id: 'a1', text: 'hello!', step_index: 1, status: 'ended', outcome: 'completed', created_at: time } }))
assert.equal((turns.snapshot().messages as any).items.at(-1).content[0].text, 'hello!', 'authoritative item replacements supersede streamed deltas')
turns.apply(modern('turn.ended', { turn: { turn_id: 'turn-1', ordinal: 1, kind: 'agent', status: 'ended', outcome: 'interrupted', started_at: time, ended_at: time, steps: [] } }))
assert.equal(turns.snapshot().in_flight_turn, null)
assert.equal((turns.snapshot().transcript as any[])[0].state, 'cancelled')
assert.throws(() => turns.apply(modern('item.delta', { turn_id: 'turn-1', item_id: 'missing', field: 'text', delta: 'lost' })), /transcript_gap/)
assert.equal(turns.apply({ ...modern('item.removed', { turn_id: 'turn-1', item_id: 'a1' }), session_id: 'foreign' }), false)
turns.apply(modern('item.removed', { turn_id: 'turn-1', item_id: 'a1' }))
assert.equal((turns.snapshot().messages as any).items.length, 1)
turns.apply(modern('turns.removed', { turn_ids: ['turn-1'] }))
assert.deepEqual(turns.snapshot().transcript, [])
turns.reset('next-connection')
assert.equal(turns.ready, false)
console.log('Kimi turns feed: baseline, deltas, replacements, interruption, gaps, isolation and removals passed')
