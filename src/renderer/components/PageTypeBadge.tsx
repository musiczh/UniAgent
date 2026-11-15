import { UiIcon, type UiIconName } from './Icons'
import './pageTypeBadge.css'

type PageType = 'task' | 'requirement' | 'space'

const PAGE_TYPES: Record<PageType, { label: string; icon: UiIconName }> = {
  task: { label: '任务', icon: 'templates' },
  requirement: { label: '需求', icon: 'file' },
  space: { label: '项目', icon: 'folder' }
}

/** Classify the page from its route, even before the object finishes loading. */
export function PageTypeBadge({ kind }: { kind: PageType }): JSX.Element {
  const { label, icon } = PAGE_TYPES[kind]
  return <span className={`page-type-badge ${kind}`} data-page-type={kind}><UiIcon name={icon} size={14}/>{label}</span>
}
