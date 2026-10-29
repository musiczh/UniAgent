import type { ComposerCommand, NativeCapabilitySnapshot } from '@shared/nativeCapabilities'
import { UiIcon } from './Icons'

export function NativeActionMenu({
  actions,
  disabled,
  reviewDisabled,
  onSelectCommand,
  onOpenReview
}: {
  actions: NativeCapabilitySnapshot['actions']
  disabled: boolean
  reviewDisabled?: boolean
  onSelectCommand: (command: ComposerCommand) => void
  onOpenReview: () => void
}): JSX.Element | null {
  if (!actions.goal && !actions.review && !actions.plan) return null
  return (
    <div className="sb-menu-group native-action-menu">
      <div className="sb-menu-label">功能</div>
      {actions.goal && (
        <button type="button" className="sb-menu-item native-action-item" disabled={disabled} onClick={() => onSelectCommand('goal')}>
          <UiIcon name="target" size={14} />
          <span className="sb-entry-body">Goal<small>设置长任务目标</small></span>
        </button>
      )}
      {actions.review && (
        <button type="button" className="sb-menu-item native-action-item" disabled={reviewDisabled ?? disabled} onClick={onOpenReview}>
          <UiIcon name="file-diff" size={14} />
          <span className="sb-entry-body">Review<small>审查当前改动</small></span>
        </button>
      )}
      {actions.plan && (
        <button type="button" className="sb-menu-item native-action-item" disabled={disabled} onClick={() => onSelectCommand('plan')}>
          <UiIcon name="templates" size={14} />
          <span className="sb-entry-body">Plan<small>切换规划模式</small></span>
        </button>
      )}
    </div>
  )
}
