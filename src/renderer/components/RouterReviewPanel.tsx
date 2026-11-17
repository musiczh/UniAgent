import { useCallback, useEffect, useRef, useState } from 'react'
import { routerActionLabels, routerDeliveryLabels, type RouterReviewDetail, type RouterReviewFilter, type RouterReviewPage, type RouterReviewDeletionItem } from '@shared/routerReview'
import { RouterFeedbackForm } from './RouterFeedbackForm'
import { SetSelect } from './SettingsPrimitives'
import { UiIcon } from './Icons'
import './router.css'

export function RouterReviewPanel({ initialRequestId, initialAttemptId, onBack, returnLabel = '返回配置', onOpenTask, onDirtyChange }: {
  initialRequestId?: string; initialAttemptId?: string; onBack: () => void; returnLabel?: string; onOpenTask?: (id: string) => void; onDirtyChange?: (dirty: boolean) => void
}): JSX.Element {
  const [selection, setSelection] = useState<{ id: string; attemptId?: string } | undefined>(initialRequestId ? { id: initialRequestId, attemptId: initialAttemptId } : undefined)
  const [page, setPage] = useState<RouterReviewPage>(), [detail, setDetail] = useState<RouterReviewDetail>(), [error, setError] = useState(''), [copyStatus, setCopyStatus] = useState(''), [copying, setCopying] = useState(false)
  const [filter, setFilter] = useState<RouterReviewFilter>('all'), [search, setSearch] = useState(''), [offset, setOffset] = useState(0), [logs, setLogs] = useState(false), [saved, setSaved] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([]), [deleting, setDeleting] = useState(false), [listLoading, setListLoading] = useState(true), [deleteNotice, setDeleteNotice] = useState(''), [deleteError, setDeleteError] = useState(''), [deleteRetry, setDeleteRetry] = useState<RouterReviewDeletionItem[]>()
  const deletingRef = useRef(false), selectAll = useRef<HTMLInputElement>(null)
  const dirty = useRef(false), listScroll = useRef(0), panel = useRef<HTMLDivElement>(null), version = useRef(0)
  const scroller = () => panel.current?.closest<HTMLElement>('.set-content') || panel.current?.parentElement
  const load = useCallback(async () => {
    const current = ++version.current; setError('')
    try {
      if (selection) { const next = await window.uniagent.getRouterReview(selection.id, selection.attemptId, logs); if (current === version.current) setDetail(previous => dirty.current && previous?.request.requestId === next.request.requestId && previous.attemptId === next.attemptId ? { ...previous, diagnostics: next.diagnostics } : next) }
      else { const next = await window.uniagent.listRouterReviews({ filter, search, offset, limit: 50 }); if (current === version.current) {
        const lastOffset = Math.max(0, Math.floor((next.total - 1) / 50) * 50)
        if (offset > lastOffset) { listScroll.current = 0; setOffset(lastOffset); return }
        setPage(next); setListLoading(false); setSelectedIds(ids => ids.filter(id => next.rows.some(row => row.request.requestId === id && row.deletable)))
        requestAnimationFrame(() => { const element = scroller(); if (element) element.scrollTop = listScroll.current }) } }
    } catch (cause) { if (current === version.current) setError(String(cause)) }
  }, [selection?.id, selection?.attemptId, filter, search, offset, logs])
  useEffect(() => { setListLoading(true); const timer = setTimeout(() => void load(), search ? 180 : 0); return () => { clearTimeout(timer); version.current++ } }, [load])
  useEffect(() => { setSelectedIds([]) }, [filter, search, offset])
  const eligibleIds = page?.rows.filter(row => row.deletable).map(row => row.request.requestId) || []
  const allSelected = !!eligibleIds.length && eligibleIds.every(id => selectedIds.includes(id))
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = !!selectedIds.length && !allSelected }, [selectedIds, allSelected, selection])
  function markDirty(value: boolean) { dirty.current = value; onDirtyChange?.(value) }
  function leave(run: () => void) { if (dirty.current && !window.confirm('反馈尚未保存，确定放弃修改？')) return; markDirty(false); run() }
  function open(id: string, attemptId?: string) { listScroll.current = scroller()?.scrollTop || 0; setDetail(undefined); setLogs(false); setSaved(false); setSelection({ id, attemptId }); scroller()?.scrollTo(0, 0) }
  function back() { leave(() => { if (selection && !initialRequestId) { setSelection(undefined); setDetail(undefined); setSaved(false) } else onBack() }) }
  async function copy() { setCopying(true); setCopyStatus(''); try { const result = await window.uniagent.copyRouterReviewPrompt(selection?.id); setCopyStatus(`已复制优化 Prompt，${result.count} 条记录已保存为本地快照。`) } catch (cause) { setCopyStatus(`复制失败：${String(cause)}`) } finally { setCopying(false) } }
  async function remove(clear = false, retry?: RouterReviewDeletionItem[]) {
    if (deletingRef.current) return
    deletingRef.current = true; setDeleting(true); setDeleteError(''); setDeleteNotice(''); setCopyStatus(''); setDeleteRetry(undefined)
    let items = retry
    try {
      if (!items) {
        const plan = await window.uniagent.getRouterReviewDeletion(clear ? undefined : selectedIds)
        if (!plan.items.length) { setDeleteError('没有可删除的记录，已刷新列表。'); await load(); return }
        const title = clear ? `清空全部 ${plan.items.length} 条历史路由记录？` : `删除选中的 ${plan.items.length} 条路由记录？`
        const scope = clear ? '将清空所有筛选、所有分页下的历史记录及其反馈、诊断日志，无法恢复。' : '将删除这些记录及其反馈、诊断日志，无法恢复。'
        if (!window.confirm(`${title}\n\n${scope}\n${plan.protectedCount ? `保留 ${plan.protectedCount} 条正在处理的记录。` : ''}已有任务和对话将保留。\n此前生成的优化 Prompt 导出快照不会同步删除。`)) return
        items = plan.items
      }
      const result = await window.uniagent.deleteRouterReviews(items)
      const removed = new Set([...result.deletedIds, ...result.failures.filter(row => row.removed).map(row => row.requestId)])
      setSelectedIds(ids => ids.filter(id => !removed.has(id)))
      if (result.deletedIds.length) setDeleteNotice(`已删除 ${result.deletedIds.length} 条路由记录`)
      const messages = result.failures.map(row => row.error)
      if (result.skippedIds.length) messages.push(`${result.skippedIds.length} 条记录的状态或反馈已变化，已保留，请重新选择。`)
      setDeleteError(messages.join('\n'))
      if (result.failures.length) setDeleteRetry(items.filter(item => result.failures.some(row => row.requestId === item.requestId)))
      await load()
    } catch (cause) { setDeleteError(`删除失败：${String(cause)}`); setDeleteRetry(items) }
    finally { deletingRef.current = false; setDeleting(false) }
  }
  return <div ref={panel} className="router-review-root">
    <header className="router-review-header"><div><div className="router-review-title"><button type="button" className="set-back" disabled={deleting} onClick={back}><UiIcon name="chevron-left" size={15}/>{selection && !initialRequestId ? '返回列表' : returnLabel}</button><h2>{selection ? '路由详情与反馈' : '路由记录与反馈'}</h2></div><p>查看历史输入、实际分配与分析日志，记录你的判断和预期结果。</p></div><div className="router-review-actions">{!selection && <button type="button" className="set-mini-btn danger" disabled={deleting || listLoading || !page?.deletableCount} onClick={() => void remove(true)}><UiIcon name="trash" size={14}/>清空记录</button>}<button type="button" className="set-mini-btn primary" disabled={copying || deleting || !selection && !page?.counts.all} onClick={() => void copy()}><UiIcon name="copy" size={14}/>{copying ? '正在导出…' : '一键复制优化 Prompt'}</button></div></header>
    {copyStatus && <p className="router-review-note" role="status">{copyStatus}</p>}
    {error && <div className="router-error" role="alert">{error}<button type="button" className="set-mini-btn" onClick={() => void load()}>重试</button></div>}
    {!selection ? <>
      <div className="router-review-toolbar"><div className="router-review-filters">{([['all', '全部'], ['unrated', '未评价'], ['bad', '不符合预期'], ['good', '符合预期']] as const).map(([value, label]) => <button type="button" key={value} disabled={deleting} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => { listScroll.current = 0; setOffset(0); setFilter(value) }}>{label}{page ? ` ${page.counts[value]}` : ''}</button>)}</div><input aria-label="搜索路由记录" value={search} disabled={deleting} onChange={event => { listScroll.current = 0; setOffset(0); setSearch(event.target.value) }} placeholder="搜索用户输入或目标任务"/></div>
      {deleteNotice && <p className="router-review-success" role="status">{deleteNotice}</p>}
      {deleteError && <div className="router-error" role="alert">{deleteError}{deleteRetry && <button type="button" className="set-mini-btn" disabled={deleting} onClick={() => void remove(false, deleteRetry)}>重试删除</button>}</div>}
      {page && <div className="router-review-bulkbar"><span>已选 {selectedIds.length} 条</span>{!!selectedIds.length && <button type="button" className="router-review-cancel" disabled={deleting} onClick={() => setSelectedIds([])}>取消选择</button>}<button type="button" className="set-mini-btn danger" disabled={deleting || listLoading || !selectedIds.length} onClick={() => void remove()}><UiIcon name="trash" size={14}/>{deleting ? '正在删除…' : `删除所选${selectedIds.length ? `（${selectedIds.length}）` : ''}`}</button></div>}
      {!page && !error && <p className="router-review-note">正在读取路由记录…</p>}
      {page && <div className="router-review-table"><div className="router-review-table-head"><span className="router-review-check-cell"><label className="router-review-select"><input ref={selectAll} type="checkbox" aria-label="选择本页可删除记录" checked={allSelected} disabled={deleting || listLoading || !eligibleIds.length} onChange={event => setSelectedIds(event.target.checked ? eligibleIds : [])}/></label>用户输入</span><span>实际路由结果</span><span>路由理由</span><span>用户反馈</span></div>{page.rows.map(row => {
        const input = Array.from(row.request.prompt)
        return <div className={`router-review-table-row${selectedIds.includes(row.request.requestId) ? ' is-selected' : ''}`} key={row.request.requestId}><div className="router-review-check-cell"><label className="router-review-select"><input type="checkbox" aria-label={`选择：${row.request.prompt}`} checked={selectedIds.includes(row.request.requestId)} disabled={deleting || listLoading || !row.deletable} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, row.request.requestId] : ids.filter(id => id !== row.request.requestId))}/></label><div><div className="router-review-input-text">{input.length > 120 ? `${input.slice(0, 120).join('')}…` : row.request.prompt}</div><small>{new Date(row.request.createdAt).toLocaleString()}</small></div></div><div>{row.request.decision ? routerActionLabels[row.request.decision.action] : '尚未返回分配结果'}<small>{row.request.targetTitle}</small><small>{[row.request.projectName, row.request.requirementName].filter(Boolean).join(' / ')}</small></div><div><div className="router-review-reason-text">{row.request.decision?.reason || row.request.error || row.request.question || '等待路由'}</div>{!row.deletable && <small>正在处理，暂不可删除</small>}</div><div><span className={`router-review-badge${row.feedback ? row.feedback.matches ? ' good' : ' bad' : ''}`}>{row.feedback ? row.feedback.matches ? '符合预期' : '不符合预期' : '未评价'}</span><button type="button" className="set-mini-btn" disabled={deleting} onClick={() => open(row.request.requestId, row.attemptId)}>详情与反馈<UiIcon name="chevron-right" size={13}/></button></div></div>
      })}{!page.rows.length && <p className="router-review-empty">暂无符合条件的路由记录</p>}</div>}
      {page && page.total > 50 && <div className="router-review-pagination"><button type="button" className="set-mini-btn" disabled={deleting || !offset} onClick={() => { listScroll.current = 0; setOffset(value => Math.max(0, value - 50)) }}>上一页</button><span>{offset + 1}—{Math.min(offset + 50, page.total)} / {page.total}</span><button type="button" className="set-mini-btn" disabled={deleting || offset + 50 >= page.total} onClick={() => { listScroll.current = 0; setOffset(value => value + 50) }}>下一页</button></div>}
    </> : !detail ? !error && <p className="router-review-note">正在读取反馈与日志…</p> : <>
      <div className="router-review-toolbar"><div className="router-review-filters"><button type="button" aria-pressed={!logs} className={!logs ? 'selected' : ''} onClick={() => setLogs(false)}>用户反馈</button><button type="button" aria-pressed={logs} className={logs ? 'selected' : ''} onClick={() => setLogs(true)}>分析日志</button></div>{detail.attempts.length > 1 && <SetSelect ariaLabel="路由回合" value={detail.attemptId || ''} onChange={id => leave(() => { setDetail(undefined); setSelection({ id: detail.request.requestId, attemptId: id }); setSaved(false) })}>{detail.attempts.filter(row => row.endedAt).map((row, index) => <option key={row.id} value={row.id}>第 {index + 1} 次路由 · {new Date(row.startedAt).toLocaleString()}</option>)}</SetSelect>}</div>
      {logs && <div className="router-review-logs">{detail.diagnostics ? <><p className="router-review-note">Agent 分析：{detail.diagnostics.reasoning === 'provided' ? '已保存后端返回的分析' : '后端未提供'}。底层完整组装上下文：未提供；以下保留实际查询快照。</p>{detail.diagnostics.sections.map(section => <RouterLogSection key={section.title} title={section.title} text={section.text}/>)}</> : <p className="router-review-note">{detail.traceAvailable ? '正在读取分析日志…' : '该历史记录未采集完整上下文快照，已有回执可在用户反馈页查看。'}</p>}</div>}
      <div style={{ display: logs ? 'none' : undefined }}>
        <section className="router-review-section"><h3>分配信息</h3><div className="router-review-card"><dl><dt>用户输入</dt><dd>{detail.request.prompt}</dd><dt>分配方式</dt><dd>{detail.request.decision ? routerActionLabels[detail.request.decision.action] : '尚未返回分配结果'}</dd><dt>目标任务</dt><dd>{detail.request.targetTitle || '未指定'}</dd><dt>所属归属</dt><dd>{[detail.request.projectName, detail.request.requirementName].filter(Boolean).join(' / ') || '未确定'}</dd><dt>路由理由</dt><dd>{detail.request.decision?.reason || detail.request.error || detail.request.question || '等待路由'}</dd><dt>投递状态</dt><dd>{routerDeliveryLabels[detail.request.delivery]}</dd></dl>{detail.request.targetId && onOpenTask && <button type="button" className="set-mini-btn" onClick={() => leave(() => onOpenTask(detail.request.targetId!))}>打开目标任务</button>}</div></section>
        <section className="router-review-section"><h3>用户反馈</h3><div className="router-review-card">{['queued', 'routing', 'committing'].includes(detail.request.state) ? <p className="router-review-note">本次路由尚未结束，请稍后刷新再反馈。<button type="button" className="set-mini-btn" onClick={() => void load()}>刷新</button></p> : <RouterFeedbackForm key={`${detail.request.requestId}-${detail.attemptId}-${detail.revision}`} detail={detail} onDirty={markDirty} onCancel={back} onReload={value => { markDirty(false); setDetail(value); setSaved(false) }} onSaved={value => { markDirty(false); setDetail(value); setSaved(true) }}/>}</div>{saved && <p className="router-review-success" role="status">反馈已保存到本地</p>}<p className="router-review-note">反馈用于后续分析，保存反馈不会改动已执行的分配。</p></section>
      </div>
    </>}
  </div>
}

function RouterLogSection({ title, text }: { title: string; text: string }): JSX.Element {
  const [open, setOpen] = useState(false), [limit, setLimit] = useState(20000)
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{title}</summary>{open && <><pre>{text.slice(0, limit)}</pre>{text.length > limit && <button type="button" className="set-mini-btn" onClick={() => setLimit(value => value + 20000)}>继续显示日志</button>}</>}</details>
}
