import { useEffect, useRef, useState } from 'react'
import type { RouterRequest } from '@shared/router'
import { type RouterExpectedResult, type RouterReviewDetail, type RouterReviewTarget } from '@shared/routerReview'
import { SetSelect } from './SettingsPrimitives'
import { UiIcon } from './Icons'

export function RouterFeedbackForm({ detail, compact = false, onSaved, onReload, onCancel, onDirty }: {
  detail: RouterReviewDetail; compact?: boolean; onSaved: (value: RouterReviewDetail) => void; onReload: (value: RouterReviewDetail) => void; onCancel?: () => void; onDirty?: (dirty: boolean) => void
}): JSX.Element {
  const [matches, setMatches] = useState<boolean | undefined>(detail.feedback?.matches)
  const [reason, setReason] = useState(detail.feedback?.reason || '')
  const [expected, setExpected] = useState<RouterExpectedResult | undefined>(detail.feedback?.expected)
  const [expanded, setExpanded] = useState(false)
  const [targets, setTargets] = useState<RouterReviewTarget[]>([]), [targetError, setTargetError] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const mounted = useRef(true), flight = useRef(false)
  const dirty = matches !== detail.feedback?.matches || reason !== (detail.feedback?.reason || '') || JSON.stringify(expected) !== JSON.stringify(detail.feedback?.expected)
  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (compact && !expanded) return
    let current = true
    setTargetError('')
    void window.uniagent.getRouterReviewTargets().then(value => { if (current) setTargets(value) }).catch(() => { if (current) setTargetError('目标列表暂不可用，仍可保存是否符合预期。') })
    return () => { current = false }
  }, [compact, expanded])
  const spaces = targets.filter(row => row.kind === 'space'), requirements = targets.filter(row => row.kind === 'requirement')
  const tasks = targets.filter(row => row.kind === 'task' && (!expected?.projectId || row.projectId === expected.projectId) && (expected?.scope === 'space' ? !row.requirementId : !expected?.requirementId || row.requirementId === expected.requirementId))
  const setKind = (kind: RouterExpectedResult['kind']) => setExpected({ kind, ...(kind === 'create_task' ? { scope: 'space' as const } : {}) })
  function options(rows: RouterReviewTarget[], id?: string, label?: string) {
    return <><option value="">请选择（可选）</option>{id && !rows.some(row => row.id === id) && <option value={id}>{label || id}（已不存在）</option>}{rows.map(row => <option key={row.id} value={row.id}>{row.title}{row.archived ? '（已归档）' : ''}</option>)}</>
  }
  async function save(verdict = matches) {
    if (verdict === undefined || flight.current) return
    flight.current = true; setSaving(true); setError('')
    try { const value = await window.uniagent.saveRouterFeedback({ requestId: detail.request.requestId, attemptId: detail.attemptId, expectedRevision: detail.revision, matches: verdict, reason: compact && verdict ? undefined : reason, expected: verdict ? undefined : expected }); if (mounted.current) onSaved(value) }
    catch (cause) { if (mounted.current) setError(String(cause).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
    finally { flight.current = false; if (mounted.current) setSaving(false) }
  }
  async function reload() {
    if (flight.current || dirty && !window.confirm('重新读取会替换未保存的反馈，确定继续？')) return
    flight.current = true; setSaving(true)
    try { const value = await window.uniagent.getRouterReview(detail.request.requestId, detail.attemptId); if (mounted.current) onReload(value) }
    catch (cause) { if (mounted.current) setError(String(cause)) }
    finally { flight.current = false; if (mounted.current) setSaving(false) }
  }
  return <div className={`router-feedback-form${compact ? ' compact' : ''}`}>
    {!compact && <label className="router-feedback-label">是否符合预期</label>}
    <div className="router-feedback-verdict">{[true, false].map(value => {
      const saved = compact && detail.feedback?.matches === value && !dirty && !expanded
      return <button key={String(value)} type="button" className={`set-mini-btn${matches === value ? ' primary' : ''}${saved && value ? ' saved-good' : ''}`} aria-pressed={matches === value} aria-expanded={compact && !value ? expanded : undefined} disabled={saving} onClick={() => { setMatches(value); if (compact) { setExpanded(!value); if (value) void save(value) } }}>{(!compact || saved) && <UiIcon name={compact || value ? 'check' : 'close'} size={compact ? 11 : 14}/>}<span>{value ? '符合预期' : '不符合预期'}</span></button>
    })}{compact && detail.feedback && !dirty && !expanded && <span className="router-feedback-saved" role="status">已保存</span>}</div>
    {(!compact || expanded) && <>
    <div className="router-feedback-field"><label htmlFor={`router-feedback-reason-${detail.request.requestId}`}>原因 <span>可选</span></label><textarea id={`router-feedback-reason-${detail.request.requestId}`} value={reason} maxLength={4000} disabled={saving} onChange={event => setReason(event.target.value)} placeholder="哪里与预期不一致？可留空"/></div>
    {matches === false && <div className="router-feedback-field"><label>预期结果 <span>可选</span></label>
      <div className="router-feedback-options">{([['create_task', '在项目或需求下创建任务'], ['reuse_task', '继续某个已有任务'], ['create_requirement', '需要新建需求']] as const).map(([kind, label]) => <button type="button" key={kind} disabled={saving} className={expected?.kind === kind ? 'selected' : ''} aria-pressed={expected?.kind === kind} onClick={() => setKind(kind)}><span className="router-feedback-radio"/>{label}</button>)}</div>
      {expected?.kind === 'create_task' && <div className="router-feedback-targets"><div className="router-feedback-verdict">{(['space', 'requirement'] as const).map(scope => <button key={scope} type="button" className={`set-mini-btn${expected.scope === scope ? ' primary' : ''}`} disabled={saving} onClick={() => setExpected({ kind: 'create_task', scope })}>{scope === 'space' ? '项目' : '需求'}</button>)}</div>
        <label>{expected.scope === 'requirement' ? '所属需求' : '所属项目'}<SetSelect ariaLabel="预期新建任务归属" disabled={saving || !!targetError} value={expected.scope === 'requirement' ? expected.requirementId || '' : expected.projectId || ''} onChange={id => setExpected({ kind: 'create_task', scope: expected.scope, ...(expected.scope === 'requirement' ? { requirementId: id || undefined } : { projectId: id || undefined }) })}>{options(expected.scope === 'requirement' ? requirements : spaces, expected.scope === 'requirement' ? expected.requirementId : expected.projectId, expected.scope === 'requirement' ? expected.requirementName : expected.projectName)}</SetSelect></label>
      </div>}
      {expected?.kind === 'reuse_task' && <div className="router-feedback-targets">
        <label>项目<SetSelect ariaLabel="预期任务项目" value={expected.projectId || ''} disabled={saving || !!targetError} onChange={id => setExpected({ kind: 'reuse_task', projectId: id || undefined })}>{options(spaces, expected.projectId, expected.projectName)}</SetSelect></label>
        <label>需求<SetSelect ariaLabel="预期任务需求" value={expected.scope === 'space' ? '@direct' : expected.requirementId || ''} disabled={saving || !!targetError || !expected.projectId} onChange={id => setExpected({ kind: 'reuse_task', projectId: expected.projectId, ...(id === '@direct' ? { scope: 'space' } : { requirementId: id || undefined }) })}>{options(requirements.filter(row => row.projectId === expected.projectId), expected.requirementId, expected.requirementName)}<option value="@direct">项目直属任务</option></SetSelect></label>
        <label>任务<SetSelect ariaLabel="预期继续任务" value={expected.taskId || ''} disabled={saving || !!targetError || !expected.projectId} onChange={id => setExpected({ ...expected, taskId: id || undefined })}>{options(tasks, expected.taskId, expected.taskTitle)}</SetSelect></label>
      </div>}
      {targetError && <p className="router-review-note">{targetError}</p>}
    </div>}
    </>}
    {error && <p className="router-error" role="alert">{error}{error.includes('反馈已变化') && <button type="button" className="set-mini-btn" disabled={saving} onClick={() => void reload()}>重新读取反馈</button>}</p>}
    {(!compact || expanded) && <div className="router-feedback-save"><span>原因与预期结果均可留空</span>{!compact && <button type="button" className="set-mini-btn" disabled={saving} onClick={onCancel}>取消</button>}<button type="button" className="set-mini-btn primary" disabled={matches === undefined || saving} onClick={() => void save()}>{saving ? '保存中…' : compact ? '保存' : '保存反馈'}</button></div>}
  </div>
}

export function RouterInlineFeedback({ request }: { request: RouterRequest }): JSX.Element {
  const [detail, setDetail] = useState<RouterReviewDetail>(), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true, waiting = true
    const load = async () => {
      try {
        const value = await window.uniagent.getRouterReview(request.requestId)
        if (!current) return
        waiting = value.attempts.length > 0 && !value.attempts.at(-1)?.endedAt
        setDetail(previous => previous && previous.attemptId === value.attemptId && previous.revision > value.revision ? previous : value)
        setError('')
      } catch (cause) { if (current) { waiting = false; setError(String(cause)) } }
    }
    void load()
    const stop = window.uniagent.onRouterChanged(() => { if (waiting) void load() })
    return () => { current = false; stop() }
  }, [request.requestId, request.roundId, request.version, retry])
  const ready = detail && (!detail.attempts.length || !!detail.attempts.at(-1)?.endedAt)
  return <div className="router-inline-feedback" data-motion-ignore aria-busy={!ready && !error}>
    {error && <p className="router-error" role="alert">{error}<button type="button" className="set-mini-btn" onClick={() => setRetry(value => value + 1)}>重新读取反馈</button></p>}
    {ready ? <RouterFeedbackForm key={`${detail.request.requestId}-${detail.attemptId}-${detail.revision}`} detail={detail} compact onSaved={setDetail} onReload={setDetail}/> : !error && <div className="router-feedback-verdict" aria-label="正在读取反馈"><button type="button" className="set-mini-btn" disabled>符合预期</button><button type="button" className="set-mini-btn" disabled>不符合预期</button></div>}
  </div>
}
