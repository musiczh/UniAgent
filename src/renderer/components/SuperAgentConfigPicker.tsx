import { useEffect, useRef, useState } from 'react'
import type { AgentDef, SessionConfig } from '@shared/types'
import { superAgentModels, superAgentUnavailable } from '@shared/superAgent'
import { routerModels } from '@shared/router'
import { resolveModelEffort, resolveModelThinking } from '@shared/agentChoices'
import { AgentIcon } from './AgentIcon'
import { UiIcon } from './Icons'
import { AgentVersionWarning } from './AgentVersionWarning'
import { usePickerMenuPlacement } from './usePickerMenuPlacement'
import { ModelSourceLabel } from './ModelSourceLabel'

type Field = 'agent' | 'model' | 'effort'
export type SuperAgentChoice = Pick<SessionConfig, 'agentId' | 'model' | 'modelSource' | 'effort' | 'kimiThinking'>
const modelKey = (value: Pick<SuperAgentChoice, 'model' | 'modelSource'>) => JSON.stringify([value.model, value.modelSource?.kind || 'native', value.modelSource?.sourceId || ''])
const effortLabels: Record<string, string> = { off: '关闭', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极高' }
const superAgentEffortLabel = (value?: string): string => effortLabels[value || ''] || value || '默认'

/** Settings use one list at a time; capability and model identity stay shared with saving. */
export function SuperAgentConfigPicker({ agents, value, onChange, field, router = false, disabled = false, label, className = '' }: {
  agents: AgentDef[]; value: SuperAgentChoice; onChange: (value: SuperAgentChoice) => void; field?: Field; router?: boolean; disabled?: boolean; label: string; className?: string
}): JSX.Element {
  const root = useRef<HTMLDetailsElement>(null), menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false), [tab, setTab] = useState<Field>(field || 'agent')
  const agent = agents.find(item => item.id === value.agentId)
  const models = agent ? router ? routerModels(agent) : superAgentModels(agent) : []
  const model = models.find(item => modelKey({ model: item.id, modelSource: item.modelSource }) === modelKey(value))
  const thinking = agent?.adapter === 'kimi'
  const efforts = thinking ? model?.thinkingOptions || [] : model?.efforts || []
  const effort = thinking ? value.kimiThinking ?? model?.defaultThinking : value.effort ?? (!router ? model?.efforts.includes('low') ? 'low' : model?.efforts.includes('off') ? 'off' : model?.defaultEffort : undefined)
  const explicitEffort = thinking ? value.kimiThinking : value.effort
  const effortLabel = (value?: string) => thinking ? value || '默认' : superAgentEffortLabel(value)
  const title = tab === 'agent' ? 'Agent' : tab === 'model' ? '模型' : thinking ? 'Thinking' : '思考强度'
  const close = (focus = false) => { root.current?.removeAttribute('open'); if (focus) root.current?.querySelector('summary')?.focus() }
  usePickerMenuPlacement(open, root, menu)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => { if (disabled) close() }, [disabled])
  function choose(next: SuperAgentChoice, nextTab?: Field): void {
    onChange(next)
    if (!field && nextTab) setTab(nextTab)
    else close(true)
  }
  return <details ref={root} className={`sb-menu sb-agent run-config-picker superagent-config-picker ${className}`}
    data-agent-id={value.agentId} data-model={value.model || ''} data-model-source={value.modelSource?.sourceId || ''} data-effort={effort || ''}
    onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setTab(field || 'agent') }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
      if (!open && event.key === 'ArrowDown') {
        event.preventDefault(); if (disabled) return
        if (root.current) root.current.open = true
        setOpen(true)
        requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('[role=option]:not(:disabled)')?.focus())
        return
      }
      if (!open || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return
      const options = [...menu.current?.querySelectorAll<HTMLButtonElement>('[role=option]:not(:disabled)') || []]
      if (!options.length) return
      event.preventDefault()
      const index = options.indexOf(document.activeElement as HTMLButtonElement)
      options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length]?.focus()
    }}>
    <summary className="sb-effort-btn" aria-label={label} aria-disabled={disabled} aria-expanded={open} title={field === 'model' ? model?.label : [agent?.name, model?.label, effortLabel(effort)].filter(Boolean).join(' · ')} onClick={event => { if (disabled) event.preventDefault() }}>
      {(!field || field === 'agent') && <AgentIcon agentId={agent?.id} adapter={agent?.adapter} size={16}/>}
      <span className={`superagent-picker-value${field ? ' is-single' : ''}`}>{field === 'agent' ? agent?.name || '选择 Agent' : field === 'model' ? model?.label || '选择模型' : field === 'effort' ? effortLabel(effort) : <><span>{agent?.name || '选择 Agent'}</span>{agent && <><span className="title-generator-sep">·</span><span className="superagent-picker-model sb-effort-model">{model?.label || '选择模型'}</span><small className="sb-effort-lvl">{effortLabel(effort)}</small></>}</>}</span><UiIcon name="chevron-right" size={14}/>
    </summary>
    {open && <div ref={menu} className="sb-menu-pop superagent-picker-pop">
      {!field && <div className="superagent-picker-tabs" role="tablist" aria-label="生成配置">
        {(['agent','model','effort'] as const).map(key => <button key={key} type="button" role="tab" aria-selected={tab === key} disabled={key !== 'agent' && !agent || key === 'effort' && !efforts.length} onClick={() => setTab(key)}>{key === 'agent' ? 'Agent' : key === 'model' ? '模型' : thinking ? 'Thinking' : '思考参数'}</button>)}
      </div>}
      {field && <div className="superagent-picker-heading">选择{title}{tab === 'agent' && <small>支持系统提示词与图片输入</small>}</div>}
      <div className="superagent-picker-options" role="listbox" aria-label={title}>
        {tab === 'agent' ? agents.map(item => {
          const reason = superAgentUnavailable(item), choices = router ? routerModels(item) : superAgentModels(item)
          const selected = item.id === value.agentId
          return <button key={item.id} type="button" role="option" aria-selected={selected} data-title-agent={item.id} disabled={disabled || !!reason || !choices.length} className={`superagent-picker-option${selected ? ' is-sel' : ''}`} onClick={() => {
            if (selected) { if (!field) setTab('model'); else close(true); return }
            // Separate controls retain the existing explicit model-selection step.
            choose({ agentId: item.id }, 'model')
          }}><AgentIcon agentId={item.id} adapter={item.adapter} size={18}/><span>{item.name}{(reason || !choices.length) && <small>{reason || '当前没有可选的图片模型'}</small>}</span><UiIcon name="check" size={14}/></button>
        }) : tab === 'model' ? models.map(item => {
          const selected = model === item
          return <button key={modelKey({ model: item.id, modelSource: item.modelSource })} type="button" role="option" aria-selected={selected} data-title-model={item.id} data-title-model-source={item.modelSource?.sourceId || ''} disabled={disabled || !!superAgentUnavailable(agent)} className={`superagent-picker-option${selected ? ' is-sel' : ''}`} title={item.label} onClick={() => choose({ agentId: value.agentId, model: item.id, modelSource: item.modelSource,
            effort: thinking ? undefined : resolveModelEffort(item, value.effort, router && item.efforts.includes('max') ? 'max' : item.efforts.includes('low') ? 'low' : undefined),
            kimiThinking: thinking ? resolveModelThinking(item, value.kimiThinking) : undefined }, (thinking ? item.thinkingOptions?.length : item.efforts.length) ? 'effort' : undefined)}><span><ModelSourceLabel model={item}/></span><UiIcon name="check" size={14}/></button>
        }) : ['默认', ...efforts].map(item => <button key={item} type="button" role="option" aria-selected={item === '默认' ? !explicitEffort : item === explicitEffort} data-title-effort={item} disabled={disabled || !model || !!superAgentUnavailable(agent)} className={`superagent-picker-option${(item === '默认' ? !explicitEffort : item === explicitEffort) ? ' is-sel' : ''}`} onClick={() => choose({ ...value, effort: !thinking && item !== '默认' ? item as SuperAgentChoice['effort'] : undefined, kimiThinking: thinking && item !== '默认' ? item : undefined })}><span>{effortLabel(item)}</span><UiIcon name="check" size={14}/></button>)}
        {tab === 'agent' && !agents.length || tab === 'model' && !models.length ? <span className="sb-menu-empty">暂无支持系统提示词与图片的可用选项</span> : null}
      </div>
      <AgentVersionWarning agent={agent}/>
    </div>}
  </details>
}
