import { QoderModelSettings } from './QoderModelSettings'
import { useState, type MutableRefObject } from 'react'
import { CodexSourceSettings } from './CodexSourceSettings'
import { AgentIcon } from './AgentIcon'

export function CodexModelSettings({ onModelsChanged, navigationGuard }: {
  onModelsChanged: () => Promise<void>
  navigationGuard: MutableRefObject<(() => boolean) | null>
}): JSX.Element {
  const [client, setClient] = useState<'claude' | 'codex' | 'qoder'>('claude')

  return <>
    <header className="set-detail-top codex-model-heading">
      <div className="set-detail-title"><div className="sdt-main">
        <h2>模型配置</h2>
        <div className="set-detail-sub">配置后直接加入对应 Agent 的模型列表，在会话中自由选择。</div>
      </div></div>
    </header>
    <div className="codex-model-tabs" role="tablist" aria-label="Agent">
      {(['claude', 'codex', 'qoder'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={client === value} className={client === value ? 'active' : ''} onClick={() => {
        if (client !== value && navigationGuard.current?.() === false) return
        setClient(value)
      }}><AgentIcon agentId={value} size={18} /> {value === 'claude' ? 'Claude Code' : value === 'qoder' ? 'Qoder' : 'Codex'}</button>)}
    </div>
    <div role="tabpanel" className="codex-model-pane">
      {client === 'qoder' ? <QoderModelSettings navigationGuard={navigationGuard} onModelsChanged={onModelsChanged} /> : <CodexSourceSettings key={client} client={client} navigationGuard={navigationGuard} onModelsChanged={onModelsChanged} />}
    </div>
  </>
}
