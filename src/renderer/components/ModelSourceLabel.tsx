import type { ModelDef } from '@shared/types'

export function ModelSourceLabel({ model }: { model: Pick<ModelDef, 'label' | 'modelSource'> }): JSX.Element {
  if (model.modelSource?.sourceId === 'ferry' || !['third-party', 'local'].includes(model.modelSource?.kind || '')) return <>{model.label}</>
  return <span className="model-source-label"><img src="./app-icon.svg" width={16} height={16} alt="UniAgent 提供" title="通过 UniAgent 接入" draggable={false} /><span>{model.label}</span></span>
}
