import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewChangeItem, ReviewChangeSet, ReviewFilePair, ReviewScope } from '@shared/types'
import { buildRows, changeBlockStarts, collapseEq, nextChangePosition, parseUnifiedDiff, totalStat, type FileDiff, type Row } from './diffModel'
import { codeLanguageFromPath, highlightedLine } from './CodeHighlight'
import { Chevron, DiffLayoutIcon, FoldRowsIcon, RefreshIcon, UiIcon } from './Icons'

/**
 * Doc10 (FR-E1 变更集视图) — Android-Studio-style side-by-side review. Replaces
 * the old single-column `DiffSidebar` with a full-screen overlay: left = changed
 * files, right = two synced panes (改造前 / 改造后) showing the *complete* file
 * (reconstructed from disk + the unified diff via `review:getFilePair`). Supports
 * 完整/只看变更 folding, 并排/统一 views, and ↑/↓ per-change navigation.
 *
 * Doc(变更文件列表改 git-diff 驱动) — the file list is now driven by the workdir's
 * LIVE git change set (`review:getChangeSet`): tracked changes → "Changes",
 * untracked files → "Unversioned Files",复刻 AS 的 Changes 树. Falls back to the
 * aggregated turn diff (parseUnifiedDiff) when the workdir isn't a git repo.
 */
export function ReviewPanel({
  diff,
  sessionId,
  scope = { kind: 'workspace' },
  onScopeChange,
  previousTurnId,
  repositoryChangeSet,
  initialFile,
  initialChangeSet,
  onChangeSet,
  onClose,
  coverSidebar = false,
  onToggleCover
}: {
  diff: string
  sessionId: string
  scope?: ReviewScope
  onScopeChange: (scope: ReviewScope) => void
  previousTurnId?: string
  repositoryChangeSet?: ReviewChangeSet | null
  /** 需求一(补1) — open with this file preselected (falls back to first). */
  initialFile?: string
  initialChangeSet?: ReviewChangeSet | null
  onChangeSet?: (changeSet: ReviewChangeSet) => void
  onClose: () => void
  /** 需求补9 — 铺满全窗（覆盖左侧侧栏）当前是否开启。 */
  coverSidebar?: boolean
  /** 需求补9 — 切换铺满全窗 / 保留侧栏。 */
  onToggleCover?: () => void
}): JSX.Element {
  const isTurnScope = scope.kind === 'turn'
  const scopeKey = reviewScopeIdentity(scope)
  // Doc(变更文件列表改 git-diff 驱动) — the live git change set. null = not fetched
  // yet; isGitRepo:false = fall back to the aggregated-diff list below. In turn
  // scope we NEVER fetch the workspace change set — the turn diff is authoritative.
  const [scopedResult, setScopedResult] = useState<{ key: string; value: ReviewChangeSet } | null>(null)
  const seededChangeSet = scope.kind === 'workspace' ? initialChangeSet ?? null : null
  const changeSet = scopedResult?.key === scopeKey ? scopedResult.value : seededChangeSet
  const [refreshTick, setRefreshTick] = useState(0)
  const [closing, setClosing] = useState(false)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => onCloseRef.current(), 160)
    return () => window.clearTimeout(timer)
  }, [closing])

  const requestClose = useCallback((): void => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) onClose()
    else setClosing(true)
  }, [onClose])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const requestScope: ReviewScope = scope
    window.uniagent.reviewGetChangeSet(sessionId, requestScope).then((cs) => {
      if (!cancelled) {
        setScopedResult({ key: scopeKey, value: cs })
        if (requestScope.kind === 'workspace') onChangeSet?.(cs)
      }
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshTick, scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // The selected change set is authoritative for every git-backed scope. Only a
  // turn artifact (or the legacy workspace fallback) may use the aggregate diff.
  const scopedFiles = useMemo<FileDiff[]>(
    () => (changeSet ? changeSet.items.map(changeItemToFileDiff) : []),
    [changeSet]
  )
  const aggFiles = useMemo(() => parseUnifiedDiff(diff), [diff])
  const usingGit = !isTurnScope && !!changeSet?.isGitRepo
  // A missing/legacy artifact is represented as an empty non-git change set. In
  // that one case keep the turn's own patch as the safe fallback; never query or
  // display workspace changes for a turn.
  const files = isTurnScope
    ? changeSet?.items.length ? scopedFiles : aggFiles
    : changeSet ? scopedFiles : scope.kind === 'workspace' ? aggFiles : []
  const total = useMemo(() => totalStat(files), [files])
  // Doc — the tracked flag per path (for grouping), keyed for O(1) lookup.
  const trackedByPath = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const it of changeSet?.items || []) m.set(it.path, it.tracked)
    return m
  }, [changeSet])

  const [active, setActive] = useState(0)
  const [mode, setMode] = useState<'full' | 'changed'>(
    () => (localStorage.getItem('ua.review.mode') as 'full' | 'changed') || 'full'
  )
  const [view, setView] = useState<'split' | 'unified'>(
    () => (localStorage.getItem('ua.review.view') as 'split' | 'unified') || 'split'
  )
  const [pairs, setPairs] = useState<Record<string, ReviewFilePair>>({})
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  const leftScrollRef = useRef<HTMLDivElement>(null)
  const rightScrollRef = useRef<HTMLDivElement>(null)
  const splitDragging = useRef(false)
  const syncingScroll = useRef(false)
  const syncFrame = useRef<number>()
  const [splitPercent, setSplitPercent] = useState(50)

  const activeFile = files[active]
  const language = codeLanguageFromPath(activeFile?.path || '')
  const pairCacheKey = activeFile ? `${scopeKey}:${activeFile.path}` : ''
  const pair = pairCacheKey ? pairs[pairCacheKey] : undefined

  // Persist mode/view choices across launches.
  useEffect(() => localStorage.setItem('ua.review.mode', mode), [mode])
  useEffect(() => localStorage.setItem('ua.review.view', view), [view])

  // Lazily fetch the before/after pair for the active file (cache by path).
  useEffect(() => {
    if (!activeFile) return
    if (pairs[pairCacheKey]) return
    let cancelled = false
    setLoading(true)
    // 需求二 — pass the review scope so a turn-scoped request reads that turn's
    // FROZEN full-file snapshot (artifact before/after) instead of reconstructing
    // from hunks; workspace scope reads HEAD + disk. Omitting scope silently fell
    // back to patch-only, which is why "完整" showed ⋯ for turn review.
    const reqScope: ReviewScope = scope
    const pairKind = activeFile.kind === 'rename' ? 'modify' : activeFile.kind
    window.uniagent
      .reviewGetFilePair({
        sessionId,
        path: activeFile.path,
        unifiedDiff: activeFile.diff,
        kind: pairKind,
        oldPath: activeFile.oldPath,
        scope: reqScope
      })
      .then((p) => {
        if (!cancelled) setPairs((prev) => ({ ...prev, [pairCacheKey]: p }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeFile, sessionId, pair, pairCacheKey, scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset per-file cache + selection when the change set refreshes.
  useEffect(() => {
    setPairs({})
    setActive(0)
  }, [scopedResult, scopeKey])

  // 需求一(补1) — preselect the requested file when opening (or when the file
  // list / initialFile changes). Falls back to the first file when it isn't in
  // this scope's change set.
  useEffect(() => {
    if (!initialFile) return
    const idx = files.findIndex((f) => f.path === initialFile)
    setActive(idx >= 0 ? idx : 0)
  }, [initialFile, files])

  // 需求二 — "完整" is only meaningful when we have the real full file. A degraded
  // pair (only patch hunks could be reconstructed) or binary/oversized files have
  // no complete text, so the 完整 toggle is disabled and we stay in changed-only.
  const fullUnavailable = !!pair && (pair.degraded || !!pair.binary || !!pair.tooLarge)
  const effectiveMode: 'full' | 'changed' = fullUnavailable ? 'changed' : mode

  const rows = useMemo<Row[]>(() => {
    if (!pair || pair.binary || pair.tooLarge) return []
    const base = buildRows(pair.before, pair.after)
    return effectiveMode === 'changed' ? collapseEq(base, 3) : base
  }, [pair, effectiveMode])

  // 需求二(按改动块导航) — anchors are the START of each contiguous add/del run
  // (index into the RENDERED rows), so ↑/↓ move one edit block at a time.
  const changeIdx = useMemo(() => changeBlockStarts(rows), [rows])
  const [navPos, setNavPos] = useState(-1)
  // No block has been visited after a file / mode / view change.
  useEffect(() => setNavPos(-1), [active, effectiveMode, view, refreshTick, changeSet])

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!splitDragging.current) return
      const rect = splitRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 6) return
      const next = ((event.clientX - rect.left - 3) / (rect.width - 6)) * 100
      setSplitPercent(Math.min(75, Math.max(25, next)))
    }
    const onUp = (): void => {
      splitDragging.current = false
      document.body.classList.remove('resizing-review')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (syncFrame.current !== undefined) cancelAnimationFrame(syncFrame.current)
      document.body.classList.remove('resizing-review')
    }
  }, [])

  function syncVertical(source: HTMLDivElement, target: HTMLDivElement | null): void {
    if (!target || syncingScroll.current) return
    syncingScroll.current = true
    target.scrollTop = source.scrollTop
    if (syncFrame.current !== undefined) cancelAnimationFrame(syncFrame.current)
    syncFrame.current = requestAnimationFrame(() => { syncingScroll.current = false })
  }

  function gotoChange(dir: 1 | -1): void {
    if (!changeIdx.length) return
    const next = nextChangePosition(navPos, dir, changeIdx.length)
    setNavPos(next)
    const scroller = view === 'split' ? leftScrollRef.current : scrollRef.current
    const el = scroller?.querySelector<HTMLElement>(`[data-row="${changeIdx[next]}"]`)
    if (scroller && el) {
      scroller.scrollTo({
        top: el.offsetTop - (scroller.clientHeight - el.offsetHeight) / 2,
        behavior: 'smooth'
      })
    }
  }

  const repository = changeSet?.isGitRepo ? changeSet : repositoryChangeSet
  const scopeCopy = reviewScopeCopy(scope, previousTurnId, repository?.upstream)

  // Keyboard: Esc closes, ↑/↓ (or F7/⇧F7) jump between changes.
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        requestClose()
      }
      else if (e.key === 'ArrowDown' || e.key === 'F7') {
        if (e.shiftKey && e.key === 'F7') return
        e.preventDefault()
        gotoChange(1)
      } else if (e.key === 'ArrowUp' || (e.shiftKey && e.key === 'F7')) {
        e.preventDefault()
        gotoChange(-1)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }) // re-bind each render so gotoChange closes over fresh navPos/changeIdx

  return (
    <div className={`review-overlay ${coverSidebar ? 'is-cover' : ''} ${closing ? 'is-closing' : ''}`}>
      <header className="scene-head">
        <div className="titles">
          <h1>代码审查</h1>
          <p>{scopeCopy.subtitle}</p>
        </div>
        <div className="head-actions">
          <ReviewScopePicker
            scope={scope}
            previousTurnId={previousTurnId}
            repositoryChangeSet={repository}
            onChange={onScopeChange}
          />
          {onToggleCover && (
            <button
              className="scene-icon-btn overlay-toggle"
              data-overlay
              title={coverSidebar ? '恢复左侧侧栏' : '铺满全窗（覆盖左侧侧栏）'}
              aria-label={coverSidebar ? '恢复左侧侧栏' : '铺满全窗'}
              onClick={onToggleCover}
            >
              <UiIcon name={coverSidebar ? 'collapse' : 'expand'} size={16} />
            </button>
          )}
          <button
            className="scene-back-btn"
            title="返回会话 (Esc)"
            aria-label="返回会话"
            onClick={requestClose}
          >
            <UiIcon name="back" size={15} /> 返回会话
          </button>
        </div>
      </header>
      <div className="review">
        <div className="files">
          <div className="files-head">
            <span className="files-title">变更文件</span>
            <span className="files-count">
              {files.length} files · <span className="p">+{total.added}</span>{' '}
              <span className="m">−{total.removed}</span>
            </span>
            <button
              className="files-refresh"
              title={`刷新（重新读取${scopeCopy.label}范围）`}
              aria-label="刷新变更"
              onClick={() => setRefreshTick((n) => n + 1)}
            >
              <RefreshIcon size={14} />
            </button>
          </div>
          <div className="files-list">
            {files.length === 0 ? (
              <div className="files-empty">
                {scopeCopy.empty}
              </div>
            ) : usingGit ? (
              <ChangeTree
                files={files}
                trackedByPath={trackedByPath}
                active={active}
                onSelect={setActive}
              />
            ) : (
              files.map((f, i) => (
                <FileRow key={f.path + i} f={f} active={i === active} onClick={() => setActive(i)} />
              ))
            )}
          </div>
        </div>

        <div className="viewer">
          <div className="viewer-toolbar">
            <span className="crumb">
              <span className="rfile">{activeFile ? activeFile.path : '—'}</span>
            </span>
            <span className="tb-spacer" />
            <button
              className="tb-toggle"
              disabled={fullUnavailable}
              data-tip={
                fullUnavailable
                  ? '完整（历史无快照）'
                  : effectiveMode === 'full'
                    ? '切换到只看变更'
                    : '切换到完整文件'
              }
              aria-label={effectiveMode === 'full' ? '切换到只看变更' : '切换到完整文件'}
              onClick={() => { if (!fullUnavailable) setMode(effectiveMode === 'full' ? 'changed' : 'full') }}
            >
              <FoldRowsIcon mode={effectiveMode} />
            </button>
            <button
              className="tb-toggle"
              data-tip={view === 'split' ? '切换到统一差异视图' : '切换到拆分差异视图'}
              aria-label={view === 'split' ? '切换到统一差异视图' : '切换到拆分差异视图'}
              onClick={() => setView(view === 'split' ? 'unified' : 'split')}
            >
              <DiffLayoutIcon view={view} />
            </button>
            <div className="nav-group">
              <button className="tb-btn" title="上一处变更" aria-label="上一处变更" onClick={() => gotoChange(-1)}>
                <UiIcon name="arrow-up" size={14} />
              </button>
              <span className="diff-counter">
                {changeIdx.length ? `${Math.max(navPos + 1, 0)} / ${changeIdx.length}` : '0 / 0'}
              </span>
              <button className="tb-btn" title="下一处变更" aria-label="下一处变更" onClick={() => gotoChange(1)}>
                <UiIcon name="arrow-down" size={14} />
              </button>
            </div>
          </div>

          {pair?.degraded && !pair.binary && !pair.tooLarge && (
            <div className="review-degraded">⚠︎ 无法完整还原，仅显示补丁上下文</div>
          )}

          {view === 'split' ? (
            <div
              className="split-review"
              ref={splitRef}
              style={{ gridTemplateColumns: `${splitPercent}fr 6px ${100 - splitPercent}fr` }}
            >
              <div className="ph split-left-head">
                <span className="tag old">改造前</span> 基线
              </div>
              <div
                className="review-splitter"
                role="separator"
                aria-label="调整前后视图宽度"
                aria-orientation="vertical"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(splitPercent)}
                tabIndex={0}
                title="拖动调整宽度"
                onMouseDown={(event) => {
                  event.preventDefault()
                  splitDragging.current = true
                  document.body.classList.add('resizing-review')
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    setSplitPercent((value) => Math.min(75, Math.max(25, value + (event.key === 'ArrowLeft' ? -5 : 5))))
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault()
                    setSplitPercent(event.key === 'Home' ? 25 : 75)
                  }
                }}
              />
              <div className="ph split-right-head">
                <span className="tag new">改造后</span> {scopeCopy.afterLabel}
              </div>
              {!activeFile || !pair || pair.binary || pair.tooLarge ? (
                <div className="review-notice split-notice">
                  {!activeFile
                    ? '选择左侧文件查看对比'
                    : !pair || loading
                      ? '加载中…'
                      : pair.binary
                        ? '二进制文件，不显示正文'
                        : '文件过大，不显示正文'}
                </div>
              ) : (
                <>
                  <div
                    className="split-scroll split-left-scroll"
                    ref={leftScrollRef}
                    onScroll={(event) => syncVertical(event.currentTarget, rightScrollRef.current)}
                  >
                    <SplitDiffGrid rows={rows} side="left" language={language} onExpandFold={() => setMode('full')} />
                  </div>
                  <div
                    className="split-scroll split-right-scroll"
                    ref={rightScrollRef}
                    onScroll={(event) => syncVertical(event.currentTarget, leftScrollRef.current)}
                  >
                    <SplitDiffGrid rows={rows} side="right" language={language} onExpandFold={() => setMode('full')} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="diff-scroll" ref={scrollRef}>
              {!activeFile ? (
                <div className="review-notice">选择左侧文件查看对比</div>
              ) : !pair || loading && !pair ? (
                <div className="review-notice">加载中…</div>
              ) : pair.binary ? (
                <div className="review-notice">二进制文件，不显示正文</div>
              ) : pair.tooLarge ? (
                <div className="review-notice">文件过大，不显示正文</div>
              ) : (
                <DiffGrid rows={rows} view="unified" language={language} onExpandFold={() => setMode('full')} />
              )}
            </div>
          )}

          <div className="legend">
            <span>
              <span className="sw sw-del" />删除 / 旧行
            </span>
            <span>
              <span className="sw sw-add" />新增 / 新行
            </span>
            <span className="legend-hint">↑/↓ 逐差异跳转 · Esc 关闭</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function reviewScopeIdentity(scope: ReviewScope): string {
  if (scope.kind === 'turn') return `turn:${scope.turnId}`
  if (scope.kind === 'commit') return `commit:${scope.sha}`
  return scope.kind
}

function reviewScopeCopy(
  scope: ReviewScope,
  previousTurnId?: string,
  upstream?: string
): { label: string; subtitle: string; empty: string; afterLabel: string } {
  if (scope.kind === 'turn') {
    const previous = scope.turnId === previousTurnId
    return previous
      ? { label: '上一轮', subtitle: '仅上一轮改动', empty: '上一轮没有文件改动', afterLabel: '上一轮结束' }
      : { label: '本轮', subtitle: '仅所选轮次改动', empty: '本轮没有文件改动', afterLabel: '本轮结束' }
  }
  if (scope.kind === 'workspace') {
    return { label: '未提交', subtitle: '工作区全部未提交改动', empty: '工作区没有未提交改动', afterLabel: '当前工作区' }
  }
  if (scope.kind === 'unstaged') {
    return { label: '未暂存', subtitle: '未暂存及未跟踪的工作区改动', empty: '工作区没有未暂存改动', afterLabel: '当前工作区' }
  }
  if (scope.kind === 'staged') {
    return { label: '已暂存', subtitle: '已加入暂存区的改动', empty: '暂存区没有改动', afterLabel: '暂存区' }
  }
  if (scope.kind === 'commit') {
    return {
      label: '已提交',
      subtitle: `提交 ${scope.sha.slice(0, 7)} 的改动`,
      empty: '该提交没有文件改动',
      afterLabel: '提交结果'
    }
  }
  return {
    label: '分支',
    subtitle: upstream ? `当前分支相对 ${upstream} 的改动` : '当前分支相对上游的改动',
    empty: '当前分支没有本地提交改动',
    afterLabel: '当前分支'
  }
}

function ReviewScopePicker({
  scope,
  previousTurnId,
  repositoryChangeSet,
  onChange
}: {
  scope: ReviewScope
  previousTurnId?: string
  repositoryChangeSet?: ReviewChangeSet | null
  onChange: (scope: ReviewScope) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [commitsOpen, setCommitsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const scopeKey = reviewScopeIdentity(scope)
  const isGitRepo = repositoryChangeSet?.isGitRepo === true
  const upstream = repositoryChangeSet?.upstream?.trim()
  const commits = repositoryChangeSet?.commits ?? []
  const gitScopeTitle = isGitRepo ? '当前分支未配置远程跟踪分支' : '当前目录不是 Git 仓库'
  const copy = reviewScopeCopy(scope, previousTurnId, upstream)

  const commit = (next: ReviewScope): void => {
    setOpen(false)
    setCommitsOpen(false)
    onChange(next)
  }

  useEffect(() => {
    if (!open) {
      setCommitsOpen(false)
      return
    }
    const onOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (commitsOpen) setCommitsOpen(false)
        else setOpen(false)
        return
      }
      if (!rootRef.current?.contains(event.target as Node) ||
          !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const options = [...rootRef.current.querySelectorAll<HTMLButtonElement>(
        '.review-scope-menu button:not(:disabled)'
      )]
      if (!options.length) return
      event.preventDefault()
      event.stopPropagation()
      const current = options.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : current < 0
            ? event.key === 'ArrowDown' ? 0 : options.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      options[next].focus()
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, commitsOpen])

  return (
    <div className="review-scope-picker" ref={rootRef}>
      <button
        type="button"
        className={`scope-pill review-scope-trigger ${scope.kind === 'turn' ? 'blue' : 'dim'}`}
        aria-label={`审查范围：${copy.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{copy.label}</span>
        <UiIcon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="review-scope-menu" role="menu" aria-label="选择审查范围">
          <ScopeMenuItem
            label="上一轮"
            selected={scope.kind === 'turn' && scope.turnId === previousTurnId}
            disabled={!previousTurnId}
            title={previousTurnId ? undefined : '暂无可用的上一轮'}
            onClick={() => previousTurnId && commit({ kind: 'turn', turnId: previousTurnId })}
          />
          <div className="review-scope-separator" role="separator" />
          <ScopeMenuItem
            label="未提交"
            selected={scopeKey === 'workspace'}
            onClick={() => commit({ kind: 'workspace' })}
          />
          <ScopeMenuItem
            label="未暂存"
            selected={scopeKey === 'unstaged'}
            disabled={!isGitRepo}
            title={isGitRepo ? undefined : gitScopeTitle}
            onClick={() => commit({ kind: 'unstaged' })}
          />
          <ScopeMenuItem
            label="已暂存"
            selected={scopeKey === 'staged'}
            disabled={!isGitRepo}
            title={isGitRepo ? undefined : gitScopeTitle}
            onClick={() => commit({ kind: 'staged' })}
          />
          <div className="review-scope-separator" role="separator" />
          <div
            className="review-scope-submenu-row"
            onMouseEnter={() => { if (upstream) setCommitsOpen(true) }}
            onMouseLeave={() => setCommitsOpen(false)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCommitsOpen(false)
            }}
          >
            <ScopeMenuItem
              label="已提交"
              selected={scope.kind === 'commit'}
              disabled={!isGitRepo || !upstream}
              title={upstream ? undefined : gitScopeTitle}
              hasSubmenu
              expanded={commitsOpen}
              onFocus={() => { if (upstream) setCommitsOpen(true) }}
              onClick={() => { if (upstream) setCommitsOpen((value) => !value) }}
            />
            {commitsOpen && upstream && (
              <div className="review-scope-commits" role="menu" aria-label="选择本地提交">
                {commits.length === 0 ? (
                  <button type="button" className="review-scope-option review-scope-empty" role="menuitem" disabled>
                    暂无本地提交
                  </button>
                ) : commits.map((item) => (
                  <button
                    type="button"
                    className={`review-scope-option review-scope-commit ${scope.kind === 'commit' && scope.sha === item.sha ? 'is-selected' : ''}`}
                    role="menuitemradio"
                    aria-checked={scope.kind === 'commit' && scope.sha === item.sha}
                    key={item.sha}
                    title={`${item.sha} ${item.title}`}
                    onClick={() => commit({ kind: 'commit', sha: item.sha })}
                  >
                    <span className="review-scope-check" aria-hidden>
                      {scope.kind === 'commit' && scope.sha === item.sha ? '✓' : ''}
                    </span>
                    <span className="review-scope-sha">{item.sha.slice(0, 7)}</span>
                    <span className="review-scope-commit-title">{item.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <ScopeMenuItem
            label="分支"
            selected={scopeKey === 'branch'}
            disabled={!isGitRepo || !upstream}
            title={upstream ? undefined : gitScopeTitle}
            onClick={() => { if (upstream) commit({ kind: 'branch' }) }}
          />
        </div>
      )}
    </div>
  )
}

function ScopeMenuItem({
  label,
  selected,
  disabled = false,
  title,
  hasSubmenu = false,
  expanded,
  onFocus,
  onClick
}: {
  label: string
  selected: boolean
  disabled?: boolean
  title?: string
  hasSubmenu?: boolean
  expanded?: boolean
  onFocus?: () => void
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`review-scope-option ${selected ? 'is-selected' : ''}`}
      role={hasSubmenu ? 'menuitem' : 'menuitemradio'}
      aria-checked={hasSubmenu ? undefined : selected}
      aria-haspopup={hasSubmenu ? 'menu' : undefined}
      aria-expanded={hasSubmenu ? expanded : undefined}
      aria-disabled={disabled}
      disabled={disabled}
      title={title}
      onFocus={onFocus}
      onClick={onClick}
    >
      <span className="review-scope-check" aria-hidden>{selected ? '✓' : ''}</span>
      <span className="review-scope-option-label">{label}</span>
      {hasSubmenu && <UiIcon name="chevron-right" size={12} />}
    </button>
  )
}

function FileRow({ f, active, onClick }: { f: FileDiff; active: boolean; onClick: () => void }): JSX.Element {
  const badge = f.kind === 'add' ? 'a' : f.kind === 'delete' ? 'd' : 'm'
  const badgeText = f.kind === 'add' ? 'A' : f.kind === 'delete' ? 'D' : f.kind === 'rename' ? 'R' : 'M'
  const slash = f.path.lastIndexOf('/')
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? f.path.slice(slash + 1) : f.path
  return (
    <div className={`file-row ${active ? 'active' : ''}`} onClick={onClick} title={f.path}>
      <span className={`file-badge ${badge}`}>{badgeText}</span>
      <span className="file-name">
        {dir && <span className="dir">{dir}</span>}
        {name}
      </span>
      <span className="file-stat">
        {f.added > 0 && <span className="p">+{f.added}</span>}
        {f.removed > 0 && <span className="m">−{f.removed}</span>}
      </span>
    </div>
  )
}

/**
 * Doc(变更文件列表改 git-diff 驱动) — map a git ReviewChangeItem to the FileDiff the
 * viewer already consumes, preserving rename so every file list renders R.
 */
function changeItemToFileDiff(it: ReviewChangeItem): FileDiff {
  return {
    path: it.path,
    ...(it.oldPath ? { oldPath: it.oldPath } : {}),
    kind: it.kind,
    diff: it.unifiedDiff || '',
    added: it.added,
    removed: it.removed
  }
}

/**
 * Doc(变更文件列表改 git-diff 驱动) — the Android-Studio-style change tree: two
 * collapsible groups (Changes / Unversioned Files), each with its files grouped
 * by directory. Selecting a leaf loads it into the right-hand comparator.
 */
function ChangeTree({
  files,
  trackedByPath,
  active,
  onSelect
}: {
  files: FileDiff[]
  trackedByPath: Map<string, boolean>
  active: number
  onSelect: (index: number) => void
}): JSX.Element {
  const [openChanges, setOpenChanges] = useState(true)
  const [openUnversioned, setOpenUnversioned] = useState(true)
  // Preserve the file's index in `files` (that's what `active` refers to).
  const withIdx = files.map((f, i) => ({ f, i }))
  const tracked = withIdx.filter(({ f }) => trackedByPath.get(f.path) !== false)
  const untracked = withIdx.filter(({ f }) => trackedByPath.get(f.path) === false)

  return (
    <div className="change-tree">
      <Group
        title="Changes"
        count={tracked.length}
        open={openChanges}
        onToggle={() => setOpenChanges((v) => !v)}
        items={tracked}
        active={active}
        onSelect={onSelect}
      />
      <Group
        title="Unversioned Files"
        count={untracked.length}
        open={openUnversioned}
        onToggle={() => setOpenUnversioned((v) => !v)}
        items={untracked}
        active={active}
        onSelect={onSelect}
      />
    </div>
  )
}

function Group({
  title,
  count,
  open,
  onToggle,
  items,
  active,
  onSelect
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  items: { f: FileDiff; i: number }[]
  active: number
  onSelect: (index: number) => void
}): JSX.Element | null {
  if (count === 0) return null
  return (
    <div className={`change-group ${open ? 'open' : 'closed'}`}>
      <div className="group-head" onClick={onToggle}>
        <span className="group-caret"><Chevron open={open} size={12} /></span>
        <span className="group-title">{title}</span>
        <span className="group-count">{count} files</span>
      </div>
      {open && (
        <div className="group-body">
          {items.map(({ f, i }) => (
            <div
              key={f.path + i}
              className={`file-row tree-leaf ${i === active ? 'active' : ''}`}
              onClick={() => onSelect(i)}
              title={f.path}
            >
              <FileBadgeName f={f} />
              <span className="file-stat">
                {f.added > 0 && <span className="p">+{f.added}</span>}
                {f.removed > 0 && <span className="m">−{f.removed}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FileBadgeName({ f }: { f: FileDiff }): JSX.Element {
  const badge = f.kind === 'add' ? 'a' : f.kind === 'delete' ? 'd' : 'm'
  const badgeText = f.kind === 'add' ? 'A' : f.kind === 'delete' ? 'D' : f.kind === 'rename' ? 'R' : 'M'
  const slash = f.path.lastIndexOf('/')
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? f.path.slice(slash + 1) : f.path
  return (
    <>
      <span className={`file-badge ${badge}`}>{badgeText}</span>
      <span className="file-name">
        {dir && <span className="dir">{dir}</span>}
        {name}
      </span>
    </>
  )
}

/** The two synced code panes — one 4-track grid keeps rows aligned. */
export function DiffGrid({
  rows,
  view,
  language,
  onExpandFold
}: {
  rows: Row[]
  view: 'split' | 'unified'
  language: string
  onExpandFold: () => void
}): JSX.Element {
  const cols = view === 'unified' ? '46px 46px 1fr' : '46px 1fr 46px 1fr'
  return (
    <div className={`diff-grid language-${language}`} style={{ gridTemplateColumns: cols }}>
      {rows.map((r, i) => (
        <GridRow key={i} row={r} idx={i} view={view} language={language} onExpandFold={onExpandFold} />
      ))}
    </div>
  )
}

export function SplitDiffGrid({
  rows,
  side,
  language,
  onExpandFold
}: {
  rows: Row[]
  side: 'left' | 'right'
  language: string
  onExpandFold: () => void
}): JSX.Element {
  return (
    <div className={`diff-grid split-diff-grid language-${language}`}>
      {rows.map((row, idx) => {
        if (row.t === 'coarse') {
          const count = side === 'left' ? row.before : row.after
          return <div className="fold" key={idx}>文件较大，省略 {count} 行未逐行比较</div>
        }
        if (row.t === 'fold') {
          return (
            <div className="fold" key={idx} onClick={onExpandFold} title="点击展开未变更区域">
              <span className="ico">⋯</span>
              <span>展开 {row.count} 行未变更</span>
              <span className="line" />
            </div>
          )
        }
        let tone: 'empty' | 'eq' | 'del' | 'add'
        let number: number | undefined
        let code: string | undefined
        if (side === 'left') {
          if (row.t === 'add') {
            tone = 'empty'
          } else {
            tone = row.t
            number = row.lno
            code = row.l
          }
        } else if (row.t === 'del') {
          tone = 'empty'
        } else {
          tone = row.t
          number = row.rno
          code = row.r
        }
        return (
          <div className="split-diff-row" data-row={idx} key={idx}>
            <div className={`ln ${tone}`}>{number}</div>
            <div className={`code ${tone}`}>{highlightedLine(code || '', language)}</div>
          </div>
        )
      })}
    </div>
  )
}

function GridRow({
  row,
  idx,
  view,
  language,
  onExpandFold
}: {
  row: Row
  idx: number
  view: 'split' | 'unified'
  language: string
  onExpandFold: () => void
}): JSX.Element {
  if (row.t === 'coarse') {
    return (
      <div className="fold">
        文件较大，中间差异已省略（旧 {row.before} 行 / 新 {row.after} 行）
      </div>
    )
  }
  if (row.t === 'fold') {
    return (
      <div className="fold" onClick={onExpandFold} title="点击展开未变更区域">
        <span className="ico">⋯</span>
        <span>展开 {row.count} 行未变更</span>
        <span className="line" />
      </div>
    )
  }

  if (view === 'unified') {
    if (row.t === 'add') {
      return (
        <>
          <div className="ln add" data-row={idx} />
          <div className="ln add">{row.rno}</div>
          <div className="code add">+ {highlightedLine(row.r || '', language)}</div>
        </>
      )
    }
    if (row.t === 'del') {
      return (
        <>
          <div className="ln del" data-row={idx}>
            {row.lno}
          </div>
          <div className="ln del" />
          <div className="code del">- {highlightedLine(row.l || '', language)}</div>
        </>
      )
    }
    return (
      <>
        <div className="ln">{row.lno}</div>
        <div className="ln rgt">{row.rno}</div>
        <div className="code"> {highlightedLine(row.l || '', language)}</div>
      </>
    )
  }

  // split view
  if (row.t === 'add') {
    return (
      <>
        <div className="ln empty" data-row={idx} />
        <div className="code empty" />
        <div className="ln rgt add">{row.rno}</div>
        <div className="code rgt add">{highlightedLine(row.r || '', language)}</div>
      </>
    )
  }
  if (row.t === 'del') {
    return (
      <>
        <div className="ln del" data-row={idx}>
          {row.lno}
        </div>
        <div className="code del">{highlightedLine(row.l || '', language)}</div>
        <div className="ln rgt empty" />
        <div className="code rgt empty" />
      </>
    )
  }
  return (
    <>
      <div className="ln">{row.lno}</div>
      <div className="code">{highlightedLine(row.l || '', language)}</div>
      <div className="ln rgt">{row.rno}</div>
      <div className="code rgt">{highlightedLine(row.r || '', language)}</div>
    </>
  )
}
