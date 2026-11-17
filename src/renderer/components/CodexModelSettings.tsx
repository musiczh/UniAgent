import { type MutableRefObject } from 'react'
import { ModelSourceSettings } from './ModelSourceSettings'

export function CodexModelSettings({ onModelsChanged, navigationGuard }: {
  onModelsChanged: () => Promise<void>
  navigationGuard: MutableRefObject<(() => boolean) | null>
}): JSX.Element {
  return <ModelSourceSettings onModelsChanged={onModelsChanged} navigationGuard={navigationGuard} />
}
