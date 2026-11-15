import type { RequirementTaskCounts } from '../scopeBrowser'
import './requirementTaskBadges.css'

export function RequirementTaskBadges({ count }: { count?: Partial<Pick<RequirementTaskCounts, 'running' | 'acceptance'>> }): JSX.Element | null {
  if (!count?.running && !count?.acceptance) return null
  return <>{(['running', 'acceptance'] as const).map(kind => {
    const value = count[kind]
    if (!value) return null
    const label = `${value} 个任务${kind === 'running' ? '运行中' : '待验收'}`
    const size = Math.max(22, 18 + String(value).length * 4) - (kind === 'acceptance' ? 4 : 0)
    return <span key={kind} className={`requirement-count ${kind}`} data-task-count={kind} title={label} aria-label={label} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        {kind === 'running' ? <><circle className="ring-track" cx="12" cy="12" r="10"/><circle className="ring-arc" cx="12" cy="12" r="10"/></> : <><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="8" y="2" width="8" height="5" rx="1.5"/></>}
      </svg>
      <b>{value}</b>
    </span>
  })}</>
}
