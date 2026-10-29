import { createContext } from 'react'
import type { TeamAssignmentStatus } from '@shared/teamTypes'
import { parseTeamAssignmentPrompt, type ParsedTeamAssignmentPrompt, type ParsedTeamAssignmentPayload } from '@shared/teamAssignmentPrompt'
import { UiIcon } from './Icons'

export interface TeamAssignmentDisplayContextValue {
  sender: string
  recipient: string
  statusByAssignmentKey: Record<string, TeamAssignmentStatus>
}

export const TeamAssignmentDisplayContext = createContext<TeamAssignmentDisplayContextValue | undefined>(undefined)

const permissionLabels: Record<string, string> = {
  plan: '计划模式',
  'read-only': '只读',
  ask: '请求批准',
  'approve-for-me': '自动批准',
  'auto-edit': '自动编辑',
  'full-access': '完全访问',
}

function shown(value: string | number | undefined, empty = '—'): string {
  if (value === undefined) return empty
  return String(value)
}

function ContextDetails({ payload }: { payload: ParsedTeamAssignmentPayload }): JSX.Element {
  const shared = payload.sharedContext
  return <details className="team-assignment-more">
    <summary><span className="team-assignment-caret"><UiIcon name="chevron-right" size={13} /></span>任务上下文 / 技术详情</summary>
    <dl className="team-assignment-more-body">
      <div className="team-assignment-more-row"><dt>派单编号</dt><dd className="mono">{shown(payload.assignmentId)}</dd></div>
      <div className="team-assignment-more-row"><dt>项目修订</dt><dd>{payload.revision === undefined ? '—' : `第 ${payload.revision} 版`}</dd></div>
      <div className="team-assignment-more-row"><dt>上下文引用</dt><dd>{payload.contextRefs === undefined ? '—' : payload.contextRefs.length ? payload.contextRefs.join('、') : '无'}</dd></div>
      <div className="team-assignment-more-row"><dt>项目摘要</dt><dd className="pre">{payload.projectSummary === undefined ? '—' : payload.projectSummary || '（空）'}</dd></div>
      <div className="team-assignment-more-row"><dt>共享概要</dt><dd className="pre">{shared === undefined ? '—' : shared.brief || '（空）'}</dd></div>
      {shared?.decisions !== undefined && <div className="team-assignment-more-row"><dt>已确认结论</dt><dd className="pre">{shared.decisions.length ? shared.decisions.join('\n') : '无'}</dd></div>}
      {shared?.openQuestions !== undefined && <div className="team-assignment-more-row"><dt>开放问题</dt><dd className="pre">{shared.openQuestions.length ? shared.openQuestions.join('\n') : '无'}</dd></div>}
    </dl>
  </details>
}

export function TeamAssignmentCard({ parsed, context }: { parsed: Exclude<ParsedTeamAssignmentPrompt, { kind: 'not-assignment' }>; context: TeamAssignmentDisplayContextValue }): JSX.Element {
  if (parsed.kind === 'invalid') {
    return <div className="card team-assignment-wrap">
      <article className="team-assignment is-fallback" data-state="invalid">
        <div className="team-assignment-head">
          <span className="team-assignment-icon warn"><UiIcon name="alert-circle" size={14} /></span>
          <span className="team-assignment-route"><span className="team-assignment-verb">团队派单</span><span className="team-assignment-fallback-note">无法解析为结构化派单，按原文显示</span></span>
        </div>
        <div className="team-assignment-raw">{parsed.raw.slice('[团队派单]'.length).trimStart()}</div>
      </article>
    </div>
  }

  const { payload } = parsed
  const statusKey = payload.assignmentId && payload.attempt !== undefined
    ? `${payload.assignmentId}:${payload.attempt}`
    : payload.assignmentId
  const status = statusKey ? context.statusByAssignmentKey[statusKey] || 'dispatched' : 'dispatched'
  return <div className="card team-assignment-wrap">
    <article className="team-assignment" data-state={status} data-assignment-id={payload.assignmentId} aria-label="团队派单">
      <div className="team-assignment-head">
        <span className="team-assignment-icon"><UiIcon name="users" size={15} /></span>
        <span className="team-assignment-route"><span className="team-assignment-verb">团队派单</span><span className="team-assignment-from">{context.sender}</span><UiIcon name="arrow-right" size={16} /><span className="team-assignment-to">你 · {context.recipient}</span></span>
      </div>
      <h3 className="team-assignment-title">{payload.title || '未命名任务'}</h3>
      <div className="team-assignment-goal"><div className="team-assignment-goal-label">任务目标</div><div className="team-assignment-goal-body">{payload.goal ?? '—'}</div></div>
      <dl className="team-assignment-facts">
        <div className="team-assignment-fact"><dt>预期交付</dt><dd>{payload.expectedOutput ?? '—'}</dd></div>
        <div className="team-assignment-fact"><dt>权限</dt><dd>{payload.permissionMode ? permissionLabels[payload.permissionMode] || payload.permissionMode : '—'}</dd></div>
        <div className="team-assignment-fact"><dt>尝试</dt><dd>{payload.attempt === undefined ? '—' : `第 ${payload.attempt} 次`}</dd></div>
      </dl>
      <ContextDetails payload={payload} />
      {parsed.footer && <div className="team-assignment-footer">{parsed.footer}</div>}
    </article>
  </div>
}

export function teamAssignmentCardForText(text: unknown, context: TeamAssignmentDisplayContextValue): JSX.Element | null {
  const parsed = parseTeamAssignmentPrompt(text)
  return parsed.kind === 'not-assignment' ? null : <TeamAssignmentCard parsed={parsed} context={context} />
}
