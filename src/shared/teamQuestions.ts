import type { TeamInteraction, TeamProject } from './teamTypes'
import { normalizeQuestions } from './questions'

export function pendingTeamQuestion(project: TeamProject): TeamInteraction | undefined {
  if (project.archivedAt || !['ready', 'running', 'waiting_members', 'waiting_user'].includes(project.status)) return undefined
  return project.interactions.find(interaction => interaction.runId === project.runId && interaction.kind === 'leader_question' && interaction.decision && interaction.state === 'pending')
}

export function teamQuestionParams(interaction: TeamInteraction): { questions: unknown[]; teamQuestion: boolean } {
  return { teamQuestion: !!interaction.decision, questions: interaction.decision
    ? interaction.decision.questions.map(q => ({ ...q, multiSelect: q.type === 'multi', allowOther: q.type !== 'text' }))
    : (interaction.questions || []).filter(q => interaction.state !== 'pending' || !q.resolved && !q.answer).map(q => ({ id: q.id, question: q.prompt })) }
}

/** Same validation for desktop and Feishu; answers always refer to one frozen revision. */
export function validateTeamAnswer(interaction: TeamInteraction, answer: unknown): void {
  const values = (answer as any)?.answers
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('invalid_answer')
  const fields = normalizeQuestions('question', teamQuestionParams(interaction))
  if (Object.keys(values).some(id => !fields.some(f => f.id === id))) throw new Error('unknown_question')
  for (const field of fields) {
    const selected = values[field.id]?.answers ?? []
    if (!Array.isArray(selected) || selected.some(v => typeof v !== 'string' || v.length > 16000) || new Set(selected).size !== selected.length) throw new Error('invalid_answer')
    if (field.required && !selected.some(v => v.trim())) throw new Error('question_required: ' + field.prompt)
    if (field.type !== 'multi' && selected.length > 1) throw new Error('single_answer_required')
    const custom = selected.filter(v => !field.options.some(o => o.value === v))
    if (field.type !== 'text' && custom.length && (!field.allowOther || custom.length > 1 || custom.some(v => !v.trim()))) throw new Error('invalid_option')
    if (field.type === 'multi' && (selected.length < (field.minItems ?? (field.required ? 1 : 0)) || selected.length > (field.maxItems ?? field.options.length + Number(field.allowOther)))) throw new Error('invalid_selection_count')
  }
}

export function teamInteractionForUser(interaction: TeamInteraction, leaderId: string): boolean {
  return interaction.kind !== 'native_question' || interaction.memberId === leaderId
}

export function teamRequestId(interaction: TeamInteraction): string {
  return `team:${interaction.id}:${interaction.revision}`
}
