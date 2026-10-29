import { CODEX_SOURCE_NAMES } from '@shared/codexSources'
import type { CodexModelSourceRef, UAEvent } from '@shared/types'
import type { ReactNode } from 'react'
import { Chevron, UiIcon } from './Icons'

function sourceName(ref?: CodexModelSourceRef): string {
  if (!ref || ref.kind === 'native') return 'OpenAI 官方'
  if (ref.kind === 'local') return '本地大模型'
  return (CODEX_SOURCE_NAMES as Record<string, string>)[ref.sourceId || ''] || ref.sourceId || '第三方厂商'
}

function formatDuration(startedAt?: number, endedAt?: number): string {
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number' || endedAt < startedAt) return ''
  return `${((endedAt - startedAt) / 1000).toFixed(1)}s`
}

type StepState = 'pending' | 'active' | 'done' | 'failed'

function StepRow({ state, children }: { state: StepState; children: ReactNode }): JSX.Element {
  return (
    <div className={`ms-step ${state}`}>
      {state === 'active'
        ? <span className="ms-spinner" aria-hidden />
        : state === 'done'
          ? <UiIcon name="check" size={13} />
          : state === 'failed'
            ? <UiIcon name="close" size={13} />
            : <span className="ms-step-dot" aria-hidden />}
      <span className="ms-step-text">{children}</span>
    </div>
  )
}

/**
 * Codex 跨来源模型切换的进度卡片（对应 model_switch 事件）。一次切换全程共用一个
 * payload.id，running → success/failed 快照原地合并；切换期间 codex 的 resume
 * 模型不一致原始警告折叠在卡片底部，不再散落时间线。
 */
export function ModelSwitchCard({ ev }: { ev: UAEvent }): JSX.Element {
  const p = ev.payload || {}
  const state: 'running' | 'success' | 'failed' =
    ev.state === 'success' ? 'success' : ev.state === 'failed' ? 'failed' : 'running'
  const step: string = typeof p.step === 'string' ? p.step : 'apply'
  const compacted = p.compacted === true
  const showCompactStep = compacted || (state !== 'success' && step === 'compact')
  const hints: string[] = Array.isArray(p.hints) ? p.hints.filter((item): item is string => typeof item === 'string' && !!item) : []
  const duration = formatDuration(p.startedAt, p.endedAt)

  const compactState: StepState =
    compacted ? 'done'
      : state === 'failed' && step === 'compact' ? 'failed'
        : step === 'compact' ? 'active' : 'pending'
  const applyState: StepState =
    state === 'success' ? 'done'
      : state === 'failed' ? (step === 'compact' && !compacted ? 'pending' : 'failed')
        : step === 'compact' ? 'pending' : 'active'

  const statusText =
    state === 'success' ? `已完成${duration ? ` · 用时 ${duration}` : ''}`
      : state === 'failed' ? '失败 · 已保留原模型'
        : step === 'compact' ? '进行中 · 正在压缩上下文'
          : step === 'prepare' ? '进行中 · 正在检查上下文容量'
            : '进行中 · 正在应用新模型'

  const process = <>
    <div className="ms-steps">
      {showCompactStep && <StepRow state={compactState}>压缩上下文，适配目标模型容量</StepRow>}
      <StepRow state={applyState}>应用新模型并恢复会话</StepRow>
    </div>
    {hints.length > 0 && (
      <details className="ms-foot">
        <summary><Chevron size={10} />原始提示（{hints.length}）</summary>
        <div className="ms-hints">
          {hints.map((hint, index) => <div key={index} className="ms-hint">{hint}</div>)}
        </div>
      </details>
    )}
  </>

  return (
    <div className={`ms-card state-${state}`} role="status" aria-live="polite">
      <div className="ms-head">
        <UiIcon name="swap-horizontal" size={14} />
        <span className="ms-title">模型切换</span>
        <span className={`ms-status ${state}`}>
          {state === 'running' && <span className="ms-spinner small" aria-hidden />}
          {state === 'success' && <UiIcon name="check" size={11} />}
          {state === 'failed' && <UiIcon name="close" size={11} />}
          {statusText}
        </span>
      </div>
      <div className="ms-models">
        <div className="ms-model">
          <span className="ms-chip from">{p.fromLabel || p.fromModel || '默认模型'}</span>
          <span className="ms-source">{sourceName(p.fromSource)}</span>
        </div>
        <span className="ms-arrow" aria-hidden><UiIcon name="arrow-right" size={16} /></span>
        <div className="ms-model">
          <span className="ms-chip to">{p.toLabel || p.toModel || '默认模型'}</span>
          <span className="ms-source">{sourceName(p.toSource)}</span>
        </div>
      </div>
      {state === 'success'
        ? <details className="ms-process"><summary><Chevron size={10} />过程详情</summary>{process}</details>
        : process}
      {state === 'failed' && !!p.error && (
        <div className="ms-error">{String(p.error)}</div>
      )}
    </div>
  )
}
