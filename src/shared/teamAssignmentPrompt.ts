import type { PermissionMode } from './types'

export const TEAM_ASSIGNMENT_PREFIX = '[团队派单]'
export const TEAM_ASSIGNMENT_FOOTER = '在当前固定 Session 执行。开始前可 get_team_context；完成后报告结果并结束本轮。'

export interface TeamAssignmentPromptPayload {
  assignmentId: string
  attempt: number
  title: string
  goal: string
  permissionMode?: PermissionMode | string
  expectedOutput: string
  contextRefs: string[]
  projectSummary: string
  sharedContext: {
    brief: string
    decisions: string[]
    openQuestions: string[]
  }
  revision: number
}

export type ParsedTeamAssignmentPayload = Partial<Omit<TeamAssignmentPromptPayload, 'sharedContext'>> & {
  sharedContext?: Partial<TeamAssignmentPromptPayload['sharedContext']>
}

export type ParsedTeamAssignmentPrompt =
  | { kind: 'not-assignment' }
  | { kind: 'invalid'; raw: string }
  | { kind: 'parsed'; payload: ParsedTeamAssignmentPayload; footer: string; raw: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizePayload(value: Record<string, unknown>): ParsedTeamAssignmentPayload {
  const shared = record(value.sharedContext)
  return {
    assignmentId: text(value.assignmentId),
    attempt: finiteNumber(value.attempt),
    title: text(value.title),
    goal: text(value.goal),
    permissionMode: text(value.permissionMode),
    expectedOutput: text(value.expectedOutput),
    contextRefs: textList(value.contextRefs),
    projectSummary: text(value.projectSummary),
    sharedContext: shared ? {
      brief: text(shared.brief),
      decisions: textList(shared.decisions),
      openQuestions: textList(shared.openQuestions),
    } : undefined,
    revision: finiteNumber(value.revision),
  }
}

/** The only producer for the renderer-recognized team assignment protocol. */
export function formatTeamAssignmentPrompt(payload: TeamAssignmentPromptPayload): string {
  return [TEAM_ASSIGNMENT_PREFIX, JSON.stringify(payload), TEAM_ASSIGNMENT_FOOTER].join('\n')
}

/**
 * Parse the persisted protocol defensively. JSON objects with missing fields are
 * still useful and render with placeholders; malformed and historical formats
 * retain their complete source text through the `invalid` branch.
 */
export function parseTeamAssignmentPrompt(value: unknown): ParsedTeamAssignmentPrompt {
  if (typeof value !== 'string' || !value.startsWith(TEAM_ASSIGNMENT_PREFIX)) {
    return { kind: 'not-assignment' }
  }
  const suffix = value.slice(TEAM_ASSIGNMENT_PREFIX.length, TEAM_ASSIGNMENT_PREFIX.length + 1)
  if (suffix && !/\s/.test(suffix)) return { kind: 'not-assignment' }

  const normalized = value.replace(/\r\n?/g, '\n')
  const body = normalized.slice(TEAM_ASSIGNMENT_PREFIX.length).trimStart()
  const lineEnd = body.indexOf('\n')
  const jsonText = (lineEnd < 0 ? body : body.slice(0, lineEnd)).trim()
  const footer = lineEnd < 0 ? '' : body.slice(lineEnd + 1).trim()
  try {
    const parsed = record(JSON.parse(jsonText))
    if (!parsed) return { kind: 'invalid', raw: value }
    return { kind: 'parsed', payload: normalizePayload(parsed), footer, raw: value }
  } catch {
    return { kind: 'invalid', raw: value }
  }
}
