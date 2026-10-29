import { useEffect, useState, type KeyboardEvent } from 'react'
import type { GoalState, GoalStatus, NativeThreadAction } from '@shared/nativeCapabilities'
import { Chevron, UiIcon } from './Icons'

const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  usageLimited: '用量受限',
  budgetLimited: '预算受限',
  complete: '已完成'
}

export function goalStatusLabel(status: GoalStatus): string {
  return GOAL_STATUS_LABEL[status]
}

export function GoalStatusBar({ goal, running = false, provider, onRunNativeAction }: { goal: GoalState; running?: boolean; provider?: string; onRunNativeAction?: (action: NativeThreadAction) => void | Promise<void> }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const native = goal.continuation === 'native'
  const cumulative = native && provider !== 'kimi' && provider !== 'grok'
  const live = running && goal.status === 'active' && (!native || goal.autonomous === true)
  const statusLabel = native && goal.status === 'active' ? goal.autonomous ? '自动执行' : '待继续' : goalStatusLabel(goal.status)
  useEffect(() => {
    if (native || !live || !expanded) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [native, expanded, live, goal.updatedAt, goal.timeUsedSeconds])

  const toggleExpanded = (): void => setExpanded((open) => !open)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggleExpanded()
  }
  async function update(action: NativeThreadAction): Promise<void> {
    if (pending || !onRunNativeAction) return
    setPending(action.type === 'goal.clear' ? '清除中…' : action.type === 'goal.update' && action.action === 'pause' ? '暂停中…' : '继续中…')
    setError(undefined)
    try { await onRunNativeAction(action) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setPending(undefined) }
  }

  return (
    <div
      className="goal-status-bar conversation-column"
      role="button"
      tabIndex={0}
      aria-label={expanded ? '折叠 Goal' : '展开 Goal'}
      title={expanded ? '折叠 Goal' : '展开 Goal'}
      aria-expanded={expanded}
      onClick={toggleExpanded}
      onKeyDown={handleKeyDown}
    >
      <div className="goal-status-head">
        <span className="goal-status-icon" aria-hidden><UiIcon name="zap" size={14} /></span>
        <div className="goal-status-copy">
          <span className="goal-status-title">Goal</span>
        </div>
        <span className={`goal-status goal-status-${goal.status}`} role="status" aria-live="polite">
          {statusLabel}
          {goal.status === 'complete' && ` · ${cumulative ? '会话累计 ' : ''}${formatGoalTokens(goal.tokensUsed)} Token`}
        </span>
        <span className="goal-toggle-btn" aria-hidden="true">
          <Chevron open={expanded} size={12} />
        </span>
      </div>
      {expanded && (
        <div className="goal-status-details">
          <strong className="goal-status-objective">{goal.objective}</strong>
          <GoalUsageRecord goal={goal} now={now} live={live} provider={provider} />
          {native && onRunNativeAction && <div className="native-goal-controls" onClick={(event) => event.stopPropagation()}>
            {goal.status !== 'complete' && <button className="settings-mini-btn" disabled={!!pending || running && !goal.autonomous} onClick={() => void update({ type: 'goal.update', action: goal.autonomous ? 'pause' : 'resume' })}>{pending && pending !== '清除中…' ? pending : goal.autonomous ? '暂停' : '继续'}</button>}
            <button className="settings-mini-btn" disabled={!!pending} onClick={() => void update({ type: 'goal.clear' })}>{pending === '清除中…' ? pending : '清除 Goal'}</button>
          </div>}
          {error && <div className="composer-send-error" role="alert" onClick={(event) => event.stopPropagation()}>{error}</div>}
        </div>
      )}
    </div>
  )
}

function formatGoalTokens(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

export function GoalUsageRecord({ goal, now, live, provider }: { goal: GoalState; now: number; live: boolean; provider?: string }): JSX.Element {
  const native = goal.continuation === 'native'
  const measured = provider === 'kimi' || provider === 'grok'
  const roundProgress = goalRoundProgress(goal)
  return <div className="goal-status-usage" aria-label="Goal 执行记录">
    <span>{native && !measured ? '会话累计' : '已使用'} {formatGoalTokens(goal.tokensUsed)} Token</span>
    {roundProgress && <span>{roundProgress}</span>}
    {(!native || measured) && <span>执行时间 {displayedGoalTimeSeconds(goal, now, live).toLocaleString('en-US')} 秒</span>}
  </div>
}

export function displayedGoalTimeSeconds(goal: GoalState, now: number, live: boolean): number {
  const snapshotSeconds = Math.max(0, Math.round(goal.timeUsedSeconds))
  if (goal.continuation === 'native' || !live || goal.status !== 'active' || !Number.isFinite(goal.updatedAt) || goal.updatedAt <= 0) return snapshotSeconds
  const updatedAt = goal.updatedAt < 1_000_000_000_000 ? goal.updatedAt * 1000 : goal.updatedAt
  return snapshotSeconds + Math.floor(Math.max(0, now - updatedAt) / 1000)
}

export function goalRoundProgress(goal: GoalState): string | undefined {
  if (goal.continuation !== 'native' || !goal.roundLimit) return undefined
  const { roundsStarted, maxRounds } = goal.roundLimit
  return `已运行 ${roundsStarted.toLocaleString('en-US')}${maxRounds === null ? '' : ` / ${maxRounds.toLocaleString('en-US')}`} 回合`
}
