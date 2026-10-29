import type { CollaborationModeId } from '@shared/nativeCapabilities'
import { UiIcon } from './Icons'

export function PlanModeBadge({
  mode,
  onExit
}: {
  mode: CollaborationModeId
  onExit: () => void | Promise<void>
}): JSX.Element | null {
  if (mode !== 'plan') return null
  return (
    <span className="plan-mode-badge" data-collaboration-mode="plan">
      <UiIcon name="templates" size={12} />
      <span>Plan</span>
      <button type="button" aria-label="退出 Plan" title="退出 Plan" onClick={() => void onExit()}>
        <UiIcon name="close" size={10} />
      </button>
    </span>
  )
}
