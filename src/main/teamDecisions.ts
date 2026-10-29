import { extname, basename } from 'node:path'
import type { TeamDecisionQuestion, TeamInteraction, TeamProject, TeamArtifact } from '../shared/teamTypes'
import { TeamStore, teamId, teamKeys, teamRecord, teamText } from './teamStore'

/** Validate every reference before publishing; question data and material copies are immutable. */
export function createTeamDecision(p: TeamProject, input: Record<string, any>, store: TeamStore, checkedPath: (path: string) => string): TeamInteraction {
  const title = teamText(input.title, 'question_title', 200)
  const purpose = input.purpose
  if (!['information', 'decision', 'design'].includes(purpose)) throw new Error('invalid_question_purpose')
  if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 10) throw new Error('invalid_questions')
  const questions: TeamDecisionQuestion[] = input.questions.map((raw: unknown) => {
    const q = teamRecord(raw)
    teamKeys(q, ['id', 'question', 'type', 'options', 'required', 'minItems', 'maxItems'])
    const id = teamText(q.id, 'question_id', 128)
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('invalid_question_id')
    if (!['single', 'multi', 'text'].includes(q.type)) throw new Error('invalid_question_type')
    if (q.required !== undefined && typeof q.required !== 'boolean') throw new Error('invalid_required')
    const options = q.options === undefined ? [] : q.options
    if (!Array.isArray(options) || options.length > 20 || (q.type === 'text' ? options.length > 0 : options.length < 2)) throw new Error('invalid_options')
    const parsed = options.map((raw: unknown) => {
      const o = teamRecord(raw); teamKeys(o, ['label', 'description'])
      return { label: teamText(o.label, 'option', 200), ...(o.description === undefined ? {} : { description: teamText(o.description, 'option_description', 2000, false) }) }
    })
    if (new Set(parsed.map(o => o.label)).size !== parsed.length) throw new Error('duplicate_options')
    for (const key of ['minItems', 'maxItems']) if (q[key] !== undefined && (q.type !== 'multi' || !Number.isInteger(q[key]) || q[key] < 0 || q[key] > parsed.length)) throw new Error('invalid_selection_count')
    if ((q.minItems ?? 0) > (q.maxItems ?? parsed.length)) throw new Error('invalid_selection_count')
    return { id, question: teamText(q.question, 'question', 8000), type: q.type, options: parsed, required: q.required !== false, minItems: q.minItems, maxItems: q.maxItems }
  })
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('duplicate_question_id')
  const materials = input.materials ?? []
  if (!Array.isArray(materials) || materials.length > 30) throw new Error('invalid_materials')
  const sources = materials.map((raw: unknown) => {
    const m = teamRecord(raw); teamKeys(m, ['artifactId', 'path', 'text', 'title', 'questionId', 'optionLabel'])
    if ([m.artifactId, m.path, m.text].filter(v => v !== undefined).length !== 1) throw new Error('material_requires_one_source')
    const q = m.questionId === undefined ? undefined : questions.find(q => q.id === m.questionId)
    if (m.questionId !== undefined && !q || m.optionLabel !== undefined && !q?.options?.some(o => o.label === m.optionLabel)) throw new Error('invalid_material_question')
    const existing: TeamArtifact | undefined = m.artifactId === undefined ? undefined : p.artifacts.find(a => a.id === m.artifactId)
    if (m.artifactId !== undefined && !existing) throw new Error('artifact_not_found')
    if (existing?.snapshot) store.verifySnapshot(p.id, existing)
    const sourcePath = existing?.path ?? m.path
    const path = sourcePath === undefined ? undefined : existing?.snapshot ? sourcePath : checkedPath(teamText(sourcePath, 'material_path', 8000))
    const text = path ? undefined : teamText(existing?.text ?? m.text, 'material_text', 200000)
    const title = teamText(m.title ?? existing?.title ?? (path ? basename(path) : '决策正文'), 'material_title', 200)
    return { title, path, text, questionId: q?.id, optionLabel: m.optionLabel, visual: !!path && ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.html', '.htm', '.pdf'].includes(extname(path).toLowerCase()) }
  })
  if (purpose !== 'information') for (const q of questions) {
    const relevant = sources.filter(m => !m.questionId || m.questionId === q.id)
    if (!relevant.length || purpose === 'design' && !relevant.some(m => m.visual)) throw new Error('decision_material_required: ' + q.id)
    // Option-specific comparisons must cover every option. Common materials may cover the whole question.
    if (relevant.some(m => m.optionLabel) && !relevant.some(m => !m.optionLabel)) for (const o of q.options || []) {
      if (!relevant.some(m => m.optionLabel === o.label && (purpose !== 'design' || m.visual))) throw new Error('option_material_required: ' + o.label)
    }
  }
  const snapshots = sources.map(source => ({ source, artifact: store.snapshotArtifact(p.id, source) }))
  p.artifacts.push(...snapshots.map(m => m.artifact))
  return { id: teamId('interaction'), revision: 1, kind: 'leader_question', runId: p.runId, memberId: p.team.leaderMemberId, sessionId: p.memberSessions[p.team.leaderMemberId], requestId: input.requestId, state: 'pending', createdAt: Date.now(), decision: {
    title, purpose, questions,
    materials: snapshots.map(({ source, artifact }) => ({ artifactId: artifact.id, questionId: source.questionId, optionLabel: source.optionLabel }))
  } }
}
