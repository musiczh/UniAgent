import type { TeamProject } from '@shared/teamTypes'
import { teamCanArchive } from '../teamSessions'
import { useRequirements } from '../useRequirements'
import { confirmArchiveRequirement } from './RequirementPicker'
import type { Requirement } from '@shared/requirementTypes'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { AgentDef, Project, Session, SessionConfig } from '@shared/types'
import { isToolSession, sessionDedupKey } from '@shared/types'
import { isSessionBusy, type SessionActivityStatus } from '@shared/sessionStatus'
import { AgentIcon } from './AgentIcon'
import { Chevron, ClockIcon, FolderIcon, UiIcon } from './Icons'
import { ViewDropdown } from './ViewDropdown'
import { isSidebarSessionEligible } from '../sessionVisibility'

export type ReplyUnreadKind = 'main' | 'side'

const SESSION_ORDER_KEY = 'ua.sidebar.sessionOrder'
const AGENT_GROUP_ORDER_KEY = 'ua.sidebar.agentGroupOrder'
const PROJECT_GROUP_ORDER_KEY = 'ua.sidebar.projectGroupOrder'
const PINNED_AGENT_GROUPS_KEY = 'ua.sidebar.pinnedAgentGroups'
const PINNED_PROJECT_GROUPS_KEY = 'ua.sidebar.pinnedProjectGroups'
const PINNED_SESSION_GROUP_KEY = 'sessions:pinned'
const ASSISTANT_SESSION_GROUP_KEY = 'sessions:assistant'

function isAssistantSession(session: Session): boolean {
  return !!session.config.assistantSnapshot && !session.teamBinding && !session.handoffId
}

type DragItem = { kind: 'session' | 'group'; id: string; scope: string }
type DragStart = {
  preview: string[]
  storageKey: string
  setter: (order: string[]) => void
}

/**
 * The left session list, codex-styled. Three organizing views (G2-5): a flat
 * "全部" list plus Agent and project groups (需求1.2 — grouped rows are indented under a
 * collapsible, icon-bearing header, and drop their own per-row icon). Each row
 * shows a live activity indicator (需求1.4 — a spinner while running, a small
 * blue/cyan "unread" dot once a main/side turn finishes, cleared on click). Rows support batch
 * multi-select via the right-click menu (需求1.3) that surfaces checkboxes and
 * a floating archive/delete action bar; hovering a single row exposes inline
 * pin + archive, with all actions in the right-click menu. An "已归档" drawer
 * at the bottom lists archived sessions.
 */
export function SessionList({
  sessions,
  assistantPrivateSessionIds = [],
  teamProjects = [],
  agents,
  activeId,
  statusBySession,
  pendingInteractionBySession = {},
  unreadBySession,
  onSelect,
  onArchive,
  onUnarchive,
  onDelete,
  onArchiveMany,
  onDeleteMany,
  onRename,
  onPin,
  onQuickCreate,
  onOpenRequirement,
  requirementsEnabled = false
}: {
  sessions: Session[]
  assistantPrivateSessionIds?: string[]
  teamProjects?: TeamProject[]
  agents: AgentDef[]
  activeId: string | null
  statusBySession: Record<string, SessionActivityStatus>
  pendingInteractionBySession?: Record<string, boolean>
  unreadBySession: Partial<Record<string, ReplyUnreadKind>>
  onSelect: (id: string) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  onArchiveMany: (ids: string[]) => void
  onDeleteMany: (ids: string[]) => void
  onRename: (id: string, title: string) => void
  onPin: (id: string, pinned: boolean) => void
  onQuickCreate?: (seed: (Partial<Pick<SessionConfig, 'agentId' | 'projectId' | 'requirementId'>> & { teamId?: string })) => void
  onOpenRequirement?: (path: string, root: string) => void
  /** 需求总开关关闭时隐藏「按需求」视图并回退到「全部」。 */
  requirementsEnabled?: boolean
}): JSX.Element {
  const projectFor = (s: Session) => teamProjects.find(p => p.id === s.teamBinding?.teamProjectId)
  const canArchive = (s: Session) => !s.teamBinding || !!projectFor(s) && teamCanArchive(projectFor(s)!)
  const canDelete = (s: Session) => !s.teamBinding || !!projectFor(s) && (!!projectFor(s)!.archivedAt || teamCanArchive(projectFor(s)!))
  const executorKey = (s: Session) => projectFor(s) ? 'team:' + projectFor(s)!.teamId : s.config.agentId
  const [view, setView] = useState<'all' | 'byAgent' | 'byProject' | 'byRequirement'>('all')
  // 需求开关关闭时显式回退到「全部」（重开后保持「全部」，用户按需再选）。
  useEffect(() => { if (!requirementsEnabled && view === 'byRequirement') setView('all') }, [requirementsEnabled, view])
  const { requirements, error: requirementLoadError } = useRequirements()
  const [requirementError, setRequirementError] = useState('')
  const [archivingRequirement, setArchivingRequirement] = useState<string | null>(null)
  const [showArchivedRequirements, setShowArchivedRequirements] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ [ASSISTANT_SESSION_GROUP_KEY]: true })
  const [projects, setProjects] = useState<Project[]>([])
  // 需求1.3: right-click explicitly enters batch mode; an empty selection stays
  // in that mode until the user cancels, so checkboxes do not flicker away.
  const [multiSelect, setMultiSelect] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 需求4: right-click context menu anchored to a row (rename / pin / archive…).
  const [menu, setMenu] = useState<{ kind: 'session' | 'requirement'; id: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLDivElement | null>(null)
  // 需求4: inline rename editor — holds the session id being renamed.
  const [renaming, setRenaming] = useState<string | null>(null)
  // Exit animation: rows tagged here play a distinct archive/delete motion
  // before the underlying archive/delete commits (see runExit).
  const [exiting, setExiting] = useState<Record<string, 'archive' | 'delete'>>({})
  const [sessionOrder, setSessionOrder] = useState(() => readOrder(SESSION_ORDER_KEY))
  const [agentGroupOrder, setAgentGroupOrder] = useState(() => readOrder(AGENT_GROUP_ORDER_KEY))
  const [projectGroupOrder, setProjectGroupOrder] = useState(() => readOrder(PROJECT_GROUP_ORDER_KEY))
  const [pinnedAgentGroups, setPinnedAgentGroups] = useState(() => readOrder(PINNED_AGENT_GROUPS_KEY))
  const [pinnedProjectGroups, setPinnedProjectGroups] = useState(() => readOrder(PINNED_PROJECT_GROUPS_KEY))
  const [dragging, setDragging] = useState<DragItem | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<DragStart | null>(null)
  const layoutRects = useRef({ session: new Map<string, DOMRect>(), group: new Map<string, DOMRect>() })
  const layoutView = useRef(view)

  const eligible = useMemo(
    () => sessions.filter((session) => !!session.teamBinding || isSidebarSessionEligible(session, agents)),
    [sessions, agents]
  )
  const active = useMemo(() => eligible.filter((s) => !s.archived), [eligible])
  const archived = useMemo(
    () => eligible.filter((s) => s.archived && (view === 'all' || !isAssistantSession(s))),
    [eligible, view]
  )
  const tools = useMemo(
    () => sessions.filter(isToolSession).sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)),
    [sessions]
  )
  const activeToolId = tools.some((session) => session.id === activeId) ? activeId : null
  useEffect(() => {
    if (activeToolId) { setShowTools(true); setShowArchived(false) }
  }, [activeToolId])

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!menu || !element) return
    const { width, height } = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`
    element.querySelector<HTMLButtonElement>('button')?.focus()
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const dismiss = (): void => setMenu(null)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu])

  useEffect(() => {
    let disposed = false
    const loadProjects = (): void => {
      void window.uniagent.listProjects().then((next) => {
        if (!disposed) setProjects(next)
      }).catch(() => { /* default-project fallback keeps the sidebar usable */ })
    }
    loadProjects()
    window.addEventListener('uniagent-projects-changed', loadProjects)
    return () => {
      disposed = true
      window.removeEventListener('uniagent-projects-changed', loadProjects)
    }
  }, [])

  // Drop an exit-animation flag once its row has actually left — never on a
  // timer. Clearing early would spring the still-present row back to full height
  // for a frame (the "flash"). Archive moves a row active→drawer, so its flag
  // clears when it leaves `active`; delete removes it from `sessions`, so its
  // flag clears when it leaves `eligible` (covers deletes from the drawer too).
  const activeIds = useMemo(() => new Set(active.map((s) => s.id)), [active])
  const eligibleIds = useMemo(() => new Set(eligible.map((s) => s.id)), [eligible])
  useEffect(() => {
    setExiting((prev) => {
      const next: Record<string, 'archive' | 'delete'> = {}
      let changed = false
      for (const [id, mode] of Object.entries(prev)) {
        if (mode === 'archive' ? activeIds.has(id) : eligibleIds.has(id)) next[id] = mode
        else changed = true
      }
      return changed ? next : prev
    })
  }, [activeIds, eligibleIds])

  // Keep the existing activity/order rules within each band, then render pinned
  // sessions once in their own fixed group above every regular view.
  const sortedActive = useMemo(() => {
    return [...active].sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    )
  }, [active])
  const orderedActive = useMemo(
    () => applyOrder(sortedActive, sessionOrder, (session) => session.id),
    [sortedActive, sessionOrder]
  )
  const assistantActive = useMemo(() => orderedActive.filter(isAssistantSession), [orderedActive])
  const taskActive = useMemo(() => orderedActive.filter((session) => !isAssistantSession(session)), [orderedActive])
  const { pinned: pinnedActive, regular: regularActive } = useMemo(
    () => splitPinnedSessions(taskActive),
    [taskActive]
  )

  // Pinned sessions are intentionally excluded from ordinary Agent/project
  // groups so each session appears exactly once in every view.
  const groups = useMemo(() => {
    return applyOrder(
      groupSessionsByAgent(regularActive, [...agents, ...teamProjects.map(p => ({ id: 'team:' + p.teamId }))], pinnedAgentGroups, executorKey),
      agentGroupOrder,
      ([key]) => key
    )
  }, [regularActive, agents, pinnedAgentGroups, agentGroupOrder, teamProjects])

  // Project identity is the grouping boundary. Different projects may share a
  // primary directory, while legacy/orphan sessions belong to the default project.
  const projectGroups = useMemo(
    () => applyOrder(
      groupSessionsByProject(regularActive, projects, pinnedProjectGroups),
      projectGroupOrder,
      (group) => group.project.id
    ),
    [regularActive, pinnedProjectGroups, projectGroupOrder, projects]
  )

  useLayoutEffect(() => {
    const root = listRef.current
    if (!root) return
    const sameView = layoutView.current === view
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

    for (const kind of ['session', 'group'] as const) {
      const next = new Map<string, DOMRect>()
      for (const element of root.querySelectorAll<HTMLElement>(`[data-sort-kind="${kind}"]`)) {
        const key = element.dataset.sortKey
        if (!key) continue
        element.getAnimations().find((animation) => animation.id === 'sidebar-reorder')?.cancel()
        const rect = element.getBoundingClientRect()
        const previous = layoutRects.current[kind].get(key)
        if (sameView && dragging?.kind === kind && previous && previous.top !== rect.top && !reduceMotion) {
          const animation = element.animate(
            [{ transform: `translateY(${previous.top - rect.top}px)` }, { transform: 'translateY(0)' }],
            { duration: 140, easing: 'cubic-bezier(.2,.8,.2,1)' }
          )
          animation.id = 'sidebar-reorder'
        }
        next.set(key, rect)
      }
      layoutRects.current[kind] = next
    }
    layoutView.current = view
  }, [view, orderedActive, groups, projectGroups, collapsed])

  const batchMode = multiSelect

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const clearSelection = (): void => {
    setSelected(new Set())
    setMultiSelect(false)
  }
  const enterMultiSelect = (id: string): void => {
    setSelected(new Set([id]))
    setMultiSelect(true)
    setMenu(null)
  }

  // Play the archive/delete exit motion on the row(s), then commit. We keep the
  // exiting class applied (CSS holds the collapsed final frame) until the parent's
  // async archive/delete actually removes the row from `active` — clearing it on
  // a timer would spring the row back to full size during the async gap (a flash).
  const EXIT_MS: Record<'archive' | 'delete', number> = { archive: 320, delete: 300 }
  const runExit = (ids: string[], mode: 'archive' | 'delete', commit: (ids: string[]) => void): void => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      commit(ids)
      return
    }
    setExiting((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = mode
      return next
    })
    setTimeout(() => commit(ids), EXIT_MS[mode])
  }

  const closeMenu = (): void => setMenu(null)
  const finishDrag = (committed = false): void => {
    finishOrderDrag(dragStartRef.current, committed)
    setDragging(null)
    dragStartRef.current = null
  }

  const dragProps = (
    item: DragItem,
    ids: string[],
    storageKey: string,
    setter: (order: string[]) => void,
    disabled = false
  ) => ({
    draggable: !disabled,
    onDragStart: (event: DragEvent<HTMLDivElement>): void => {
      if (disabled || (event.target as HTMLElement).closest('button, input')) {
        event.preventDefault()
        return
      }
      dragStartRef.current = { preview: ids, storageKey, setter }
      setDragging(item)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', item.id)
    },
    onDragOver: (event: DragEvent<HTMLDivElement>): void => {
      if (dragging?.kind !== item.kind || dragging.scope !== item.scope) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      if (dragging.id === item.id) return
      const rect = event.currentTarget.getBoundingClientRect()
      const order = moveItem(ids, dragging.id, item.id, event.clientY > rect.top + rect.height / 2)
      if (dragStartRef.current) dragStartRef.current.preview = order
      setter(order)
    },
    onDrop: (event: DragEvent<HTMLDivElement>): void => {
      if (dragging?.kind !== item.kind || dragging.scope !== item.scope) return
      event.preventDefault()
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      const order = dragging.id === item.id
        ? ids
        : moveItem(ids, dragging.id, item.id, event.clientY > rect.top + rect.height / 2)
      persistOrder(storageKey, order, setter)
      finishDrag(true)
    },
    onDragEnd: () => finishDrag()
  })

  const beginRename = (s: Session): void => {
    setMenu(null)
    setRenaming(s.id)
  }
  const renderTitle = (s: Session): JSX.Element => renaming === s.id ? (
    <input
      className="si-rename"
      aria-label="会话标题"
      autoFocus
      maxLength={80}
      defaultValue={s.title}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          if (e.key === 'Escape') e.currentTarget.value = ''
          e.currentTarget.blur()
        }
      }}
      onBlur={(e) => {
        const title = e.currentTarget.value.trim()
        setRenaming(null)
        if (title && title !== s.title) onRename(s.id, title)
      }}
    />
  ) : (
    <span className="si-title" onClick={s.archived ? () => onSelect(s.id) : undefined}>
      {s.title}
    </span>
  )
  const renderRenameAction = (s: Session): JSX.Element => (
    <button
      type="button"
      className="si-act"
      title="修改标题"
      aria-label="修改会话标题"
      onClick={(e) => {
        e.stopPropagation()
        beginRename(s)
      }}
    >
      <UiIcon name="edit" size={14} />
    </button>
  )

  const renderRow = (
    s: Session,
    opts?: { hideIcon?: boolean; indent?: boolean; scope?: string }
  ): JSX.Element => {
    const agent = agents.find((a) => a.id === s.config.agentId)
    const status = statusBySession[s.id] || s.status
    const checked = selected.has(s.id)
    const isRenaming = renaming === s.id
    const scope = opts?.scope || 'sessions:all'
    const isDragging = dragging?.kind === 'session' && dragging.id === s.id
    const exit = exiting[s.id]
    return (
      <div
        key={sessionDedupKey(s)}
        tabIndex={0}
        data-session-id={s.id}
        data-sort-kind="session"
        data-sort-key={`${scope}:${s.id}`}
        {...dragProps(
          { kind: 'session', id: s.id, scope },
          orderedActive.map((session) => session.id),
          SESSION_ORDER_KEY,
          setSessionOrder,
          batchMode || isRenaming
        )}
        className={`session-item ${activeId === s.id ? 'active' : ''} ${
          opts?.indent ? 'indented' : ''
        } ${checked ? 'selected' : ''} ${s.pinned ? 'pinned' : ''} ${
          isDragging ? 'dragging' : ''
        } ${exit ? `exiting-${exit}` : ''}`}
        onClick={() => (batchMode ? toggleSelect(s.id) : onSelect(s.id))}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          menuTriggerRef.current = e.currentTarget
          setMenu({ kind: 'session', id: s.id, x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
          e.preventDefault()
          e.stopPropagation()
          menuTriggerRef.current = e.currentTarget
          const rect = e.currentTarget.getBoundingClientRect()
          setMenu({ kind: 'session', id: s.id, x: rect.left, y: rect.bottom })
        }}
      >
        {batchMode && <button
          className={`si-check ${checked ? 'on' : ''}`}
          title={checked ? '取消选择' : '选择'}
          aria-label={checked ? '取消选择' : '选择'}
          onClick={(e) => {
            e.stopPropagation()
            toggleSelect(s.id)
          }}
        >
          {checked ? <UiIcon name="check" size={11} /> : null}
        </button>}
        {!opts?.hideIcon && (
          <span className="si-icon">
            <>{s.teamBinding ? <UiIcon name="users" size={15} /> : <AgentIcon agentId={s.config.agentId} adapter={agent?.adapter} />}</>
          </span>
        )}
        {/* 需求5 — flag a read-only imported snapshot vs a writable fork. */}
        {s.readOnly ? (
          <span className="si-tag si-tag-ro" title="只读快照：可分叉或直接导入后续跑">
            只读
          </span>
        ) : s.forkedFrom ? (
          <span
            className="si-tag si-tag-fork"
            title={s.forkedFrom.mode === 'same'
              ? '原 Agent 无损分叉'
              : s.forkedFrom.mode === 'compatible'
                ? '兼容模式分叉（可能有损）'
                : '换 Agent 分叉（可能有损）'}
          >
            <UiIcon name="fork" size={11} />{s.forkedFrom.mode === 'cross' ? '换' : s.forkedFrom.mode === 'compatible' ? '兼' : ''}
          </span>
        ) : null}
        {/* 需求5 — a wait=true handoff blocks its calling agent on this session's
            result. Show a clickable「等待中」badge; clicking jumps here so the
            user can watch the awaited session's progress. */}
        {s.handoffWaiting && (
          <button
            type="button"
            className="si-tag si-tag-waiting"
            title="有外部任务正在等待此会话的结果，点击查看进度"
            aria-label="查看等待中的会话进度"
            onClick={(e) => {
              e.stopPropagation()
              onSelect(s.id)
            }}
          >
            <ClockIcon size={11} /> 等待中
          </button>
        )}
        {assistantPrivateSessionIds.includes(s.id) && (
          <span className="si-tag si-tag-feishu" title={s.config.assistantChannel === 'weixin' ? '个人助手的微信对话：回复发送到此微信，/new、/clear 只切换微信对话' : '个人助手的飞书私聊会话：App 中的输入与回复同步到此私聊，/new、/clear 后切换到新会话'} aria-label={s.config.assistantChannel === 'weixin' ? '已绑定微信私聊' : '已绑定飞书私聊'}>
            <UiIcon name={s.config.assistantChannel === 'weixin' ? 'message-square' : 'feishu'} size={11} />{s.config.assistantChannel === 'weixin' ? '微信' : '飞书'}
          </span>
        )}
        {renderTitle(s)}
        {s.handoffId && (
          <span className="si-mcp-source" role="img" title="通过 MCP 创建" aria-label="通过 MCP 创建">
            <UiIcon name="plug" size={13} />
          </span>
        )}
        <StatusIndicator status={status} hasPendingInteraction={pendingInteractionBySession[s.id]} unread={unreadBySession[s.id]} />
        {!batchMode && <span className="si-actions">
          <button
            type="button"
            className={`si-act si-pin-act ${s.pinned ? 'pinned' : ''}`}
            title={s.pinned ? '取消置顶' : '置顶'}
            aria-label={s.pinned ? '取消置顶会话' : '置顶会话'}
            aria-pressed={!!s.pinned}
            onClick={(e) => {
              e.stopPropagation()
              onPin(s.id, !s.pinned)
            }}
          >
            <UiIcon name="pin" size={14} />
          </button>
          <button
            className="si-act"
            title="归档"
            aria-label="归档会话" disabled={!canArchive(s)}
            onClick={(e) => {
              e.stopPropagation()
              runExit([s.id], 'archive', ([id]) => onArchive(id))
            }}
          >
            <UiIcon name="archive" size={14} />
          </button>
        </span>}
      </div>
    )
  }

  const assistantCollapsed = !!collapsed[ASSISTANT_SESSION_GROUP_KEY]
  const toggleAssistantGroup = (): void => setCollapsed((prev) => ({
    ...prev,
    [ASSISTANT_SESSION_GROUP_KEY]: !prev[ASSISTANT_SESSION_GROUP_KEY]
  }))
  const renderAssistantGroup = (): JSX.Element | null => {
    if (assistantActive.length === 0) return null
    return (
      <div className="sl-group sl-pinned-group">
        <div
          className="sl-group-head"
          role="button"
          tabIndex={0}
          aria-expanded={!assistantCollapsed}
          onClick={toggleAssistantGroup}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggleAssistantGroup()
            }
          }}
        >
          <span className="sl-group-caret"><Chevron open={!assistantCollapsed} /></span>
          <span className="sl-group-icon"><UiIcon name="agent" size={14} /></span>
          <span className="sl-group-name" style={{ textTransform: 'none' }}>助手session</span>
          <span className="sl-group-count">{assistantActive.length}</span>
        </div>
        {!assistantCollapsed && (
          <div className="sl-group-body">
            {assistantActive.map((session) => renderRow(session, {
              indent: true,
              scope: ASSISTANT_SESSION_GROUP_KEY
            }))}
          </div>
        )}
      </div>
    )
  }

  const pinnedCollapsed = !!collapsed[PINNED_SESSION_GROUP_KEY]
  const renderPinnedGroup = (): JSX.Element | null => {
    if (pinnedActive.length === 0) return null
    return (
      <div className="sl-group sl-pinned-group">
        <div
          className="sl-group-head"
          onClick={() => setCollapsed((prev) => ({
            ...prev,
            [PINNED_SESSION_GROUP_KEY]: !prev[PINNED_SESSION_GROUP_KEY]
          }))}
        >
          <span className="sl-group-caret">
            <Chevron open={!pinnedCollapsed} />
          </span>
          <span className="sl-group-icon">
            <UiIcon name="pin" size={13} className="sl-pinned-group-pin" />
          </span>
          <span className="sl-group-name">置顶</span>
          <span className="sl-group-count">{pinnedActive.length}</span>
        </div>
        {!pinnedCollapsed && (
          <div className="sl-group-body">
            {pinnedActive.map((session) => renderRow(session, {
              indent: true,
              scope: PINNED_SESSION_GROUP_KEY
            }))}
          </div>
        )}
      </div>
    )
  }
  const renderRequirementGroup = (requirement: Requirement | undefined, list: Session[]): JSX.Element => {
    const key = 'requirement:' + (requirement?.id || 'none')
    const isCollapsed = !!collapsed[key]
    return <div className="sl-group" key={key}>
      <div className="sl-group-head" role="button" tabIndex={0} aria-expanded={!isCollapsed} onContextMenu={e => { if (!requirement) return; e.preventDefault(); e.stopPropagation(); menuTriggerRef.current = e.currentTarget; setMenu({ kind: 'requirement', id: requirement.id, x: e.clientX, y: e.clientY }) }} onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { if (!requirement) return; e.preventDefault(); menuTriggerRef.current = e.currentTarget; setMenu({ kind: 'requirement', id: requirement.id, x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom }) } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(prev => ({ ...prev, [key]: !prev[key] })) } }} onClick={() => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))}>
        <span className="sl-group-caret"><Chevron open={!isCollapsed} /></span><span className="sl-group-icon"><UiIcon name="file" size={14} /></span>
        <span className="sl-group-name" title={requirement?.dir}>{requirement?.name || '未归入需求'}</span><span className="sl-group-count">{list.length}</span>
        {requirement && requirement.status !== 'archived' && <button type="button" className="sl-group-add" title={'在 ' + requirement.name + ' 新建任务'} aria-label={'在 ' + requirement.name + ' 新建任务'} onClick={e => { e.stopPropagation(); onQuickCreate?.({ requirementId: requirement.id }) }}><UiIcon name="plus" size={14} /></button>}
      </div>
      {!isCollapsed && <div className="sl-group-body">{list.map(s => renderRow(s, { indent: true, scope: key }))}</div>}
    </div>
  }
  const requirementGroups = requirements.map(requirement => ({ requirement, list: taskActive.filter(s => s.config.requirementId === requirement.id) }))
  const unassignedRequirements = taskActive.filter(s => !requirements.some(r => r.id === s.config.requirementId))
  const archivedRequirementGroups = requirementGroups.filter(g => g.requirement.status === 'archived')
  async function archiveRequirement(requirement: Requirement): Promise<void> {
    if (archivingRequirement || !confirmArchiveRequirement(requirement)) return
    setArchivingRequirement(requirement.id); setRequirementError('')
    try { await window.uniagent.updateRequirement(requirement.id, { status: 'archived' }) }
    catch (e) { setRequirementError(e instanceof Error ? e.message : String(e)) }
    finally { setArchivingRequirement(null) }
  }
  const viewEmpty = view === 'byRequirement' ? false : view === 'all'
    ? active.length === 0
    : view === 'byAgent'
      ? pinnedActive.length === 0 && groups.length === 0
      : pinnedActive.length === 0 && projectGroups.length === 0

  return (
    <div ref={listRef} className="session-list">
      <ViewDropdown
        ariaLabel="会话视图"
        value={view}
        onChange={setView}
        options={[
          { value: 'all', label: '全部' },
          { value: 'byAgent', label: 'Agent' },
          { value: 'byProject', label: '空间' },
          ...(requirementsEnabled ? [{ value: 'byRequirement' as const, label: '需求' }] : [])
        ]}
      />

      {(requirementError || (view === 'byRequirement' && requirementLoadError)) && <div className="requirement-error" role="alert">{requirementError || requirementLoadError}</div>}
      {batchMode && (
        <div className="sl-batch-bar">
          <span className="sl-batch-count">已选 {selected.size} 项</span>
          <div className="sl-batch-acts">
            <button
              className="sl-batch-btn"
              disabled={selected.size === 0 || [...selected].some(id => { const session = sessions.find(s => s.id === id); return !session || !canArchive(session) })}
              title="专家团需先停止并结束所有成员任务才能归档"
              onClick={() => {
                runExit([...selected], 'archive', (ids) => onArchiveMany(ids))
                clearSelection()
              }}
            >
              归档
            </button>
            <button
              className="sl-batch-btn danger" disabled={selected.size === 0 || [...selected].some(id => { const session = sessions.find(s => s.id === id); return !session || !canDelete(session) })} title="运行中的专家团需先停止才能删除"
              onClick={() => {
                if (confirm(`删除选中的 ${selected.size} 个会话？此操作不可撤销。`)) {
                  runExit([...selected], 'delete', (ids) => onDeleteMany(ids))
                  clearSelection()
                }
              }}
            >
              删除
            </button>
            <button className="sl-batch-btn ghost" onClick={clearSelection}>
              取消
            </button>
          </div>
        </div>
      )}

      {viewEmpty ? (
        <div className="sl-empty">
          {view === 'all' ? '还没有会话，点击 ＋ 新建任务' : '还没有会话分组'}
        </div>
      ) : (
        <div className="sl-body">
          {view === 'all' && renderAssistantGroup()}
          {view !== 'byRequirement' && renderPinnedGroup()}
          {view === 'byRequirement' ? <>
            {requirementGroups.filter(g => g.requirement.status !== 'archived').map(g => renderRequirementGroup(g.requirement, g.list))}
            {unassignedRequirements.length > 0 && renderRequirementGroup(undefined, unassignedRequirements)}
            {archivedRequirementGroups.length > 0 && <div className="sl-archive">
              <button type="button" className={'sl-archive-head' + (showArchivedRequirements ? ' is-open' : '')} aria-expanded={showArchivedRequirements} onClick={() => setShowArchivedRequirements(v => !v)}><span className="sl-archive-caret"><Chevron open={showArchivedRequirements} /></span><span>已归档需求</span><span className="sl-group-count">{archivedRequirementGroups.length}</span></button>
              {showArchivedRequirements && <div className="sl-archive-body">{archivedRequirementGroups.map(g => renderRequirementGroup(g.requirement, g.list))}</div>}
            </div>}
            {!requirements.length && !unassignedRequirements.length && <div className="sl-empty">还没有需求，可在新建任务时创建</div>}
          </> : view === 'all' ? regularActive.map((s) => renderRow(s)) : view === 'byAgent' ? (
            groups.map(([agentId, list]) => {
            const team = teamProjects.find(p => 'team:' + p.teamId === agentId)
            const agent = team ? { name: team.team.name, adapter: undefined } : agents.find((a) => a.id === agentId)
            const isCollapsed = !!collapsed[agentId]
            const isPinned = pinnedAgentGroups.includes(agentId)
            const groupDragProps = dragProps(
              { kind: 'group', id: agentId, scope: 'groups:agent' },
              groups.map(([key]) => key),
              AGENT_GROUP_ORDER_KEY,
              setAgentGroupOrder
            )
            return (
              <div
                key={agentId}
                data-sort-kind="group"
                data-sort-key={`agent:${agentId}`}
                className={`sl-group ${
                  dragging?.kind === 'group' && dragging.id === agentId ? 'dragging' : ''
                }`}
                onDragOver={groupDragProps.onDragOver}
                onDrop={groupDragProps.onDrop}
              >
                <div
                  className="sl-group-head"
                  {...groupDragProps}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [agentId]: !prev[agentId] }))}
                >
                  <span className="sl-group-caret">
                    <Chevron open={!isCollapsed} />
                  </span>
                  <span className="sl-group-icon">
                    <>{team ? <UiIcon name="users" size={14} /> : <AgentIcon agentId={agentId} adapter={agent?.adapter} size={14} />}</>
                  </span>
                  <span className="sl-group-name">{agent?.name || agentId}</span>
                  <span className="sl-group-count">{list.length}</span>
                  <button
                    className={`sl-group-pin ${isPinned ? 'pinned' : ''}`}
                    type="button"
                    title={isPinned ? '取消固定分组' : '固定分组'}
                    aria-label={isPinned ? `取消固定 ${agent?.name || agentId} 分组` : `固定 ${agent?.name || agentId} 分组`}
                    aria-pressed={isPinned}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleStoredItem(PINNED_AGENT_GROUPS_KEY, pinnedAgentGroups, agentId, setPinnedAgentGroups)
                    }}
                  >
                    <UiIcon name="pin" size={13} />
                  </button>
                  <button
                    className="sl-group-add"
                    type="button"
                    title={`使用 ${agent?.name || agentId} 新建任务`}
                    aria-label={`使用 ${agent?.name || agentId} 新建任务`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onQuickCreate?.(team ? { teamId: team.teamId } : { agentId })
                    }}
                  >
                    <UiIcon name="plus" size={14} />
                  </button>
                </div>
                {!isCollapsed && (
                  <div className="sl-group-body">
                    {list.map((s) =>
                      renderRow(s, { hideIcon: true, indent: true, scope: `agent:${agentId}` })
                    )}
                  </div>
                )}
              </div>
            )
            })
          ) : (
            projectGroups.map(({ project, sessions: list }) => {
            const key = 'project:' + project.id
            const isCollapsed = !!collapsed[key]
            const isPinned = pinnedProjectGroups.includes(project.id)
            const directorySummary = [project.primaryDirectory, ...project.additionalDirectories].filter(Boolean).join('\n')
            const groupDragProps = dragProps(
              { kind: 'group', id: project.id, scope: 'groups:project' },
              projectGroups.map((group) => group.project.id),
              PROJECT_GROUP_ORDER_KEY,
              setProjectGroupOrder
            )
            return (
              <div
                key={key}
                data-sort-kind="group"
                data-sort-key={key}
                className={`sl-group ${
                  dragging?.kind === 'group' && dragging.id === project.id ? 'dragging' : ''
                }`}
                onDragOver={groupDragProps.onDragOver}
                onDrop={groupDragProps.onDrop}
              >
                <div
                  className="sl-group-head"
                  {...groupDragProps}
                  title={directorySummary || project.name}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
                >
                  <span className="sl-group-caret">
                    <Chevron open={!isCollapsed} />
                  </span>
                  <span className="sl-group-icon" aria-hidden>
                    <FolderIcon size={14} />
                  </span>
                  <span className="sl-group-name" title={directorySummary || project.name}>
                    {project.name}
                  </span>
                  <span className="sl-group-count">{list.length}</span>
                  <button
                    className={`sl-group-pin ${isPinned ? 'pinned' : ''}`}
                    type="button"
                    title={isPinned ? '取消固定分组' : '固定分组'}
                    aria-label={isPinned ? `取消固定 ${project.name} 分组` : `固定 ${project.name} 分组`}
                    aria-pressed={isPinned}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleStoredItem(PINNED_PROJECT_GROUPS_KEY, pinnedProjectGroups, project.id, setPinnedProjectGroups)
                    }}
                  >
                    <UiIcon name="pin" size={13} />
                  </button>
                  <button
                    className="sl-group-add"
                    type="button"
                    title={`在 ${project.name} 新建任务`}
                    aria-label={`在 ${project.name} 新建任务`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onQuickCreate?.({ projectId: project.id })
                    }}
                  >
                    <UiIcon name="plus" size={14} />
                  </button>
                </div>
                {!isCollapsed && (
                  <div className="sl-group-body">
                    {/* Keep the per-row Agent icon because one project can mix Agents. */}
                    {list.map((s) => renderRow(s, { indent: true, scope: key }))}
                  </div>
                )}
              </div>
            )
            })
          )}
        </div>
      )}

      {(tools.length > 0 || archived.length > 0) && (
        <div className="sl-archive">
          <div className="sl-drawer-heads">
            {tools.length > 0 && (
              <button
                type="button"
                className={`sl-archive-head${showTools ? ' is-open' : ''}`}
                aria-expanded={showTools}
                onClick={() => { setShowTools((value) => !value); setShowArchived(false) }}
              >
                <span className="sl-archive-caret"><Chevron open={showTools} /></span>
                <UiIcon name="plug" size={13} />
                <span>工具会话</span>
                <span className="sl-group-count">{tools.length}</span>
              </button>
            )}
            {archived.length > 0 && (
              <button
                type="button"
                className={`sl-archive-head${showArchived ? ' is-open' : ''}`}
                aria-expanded={showArchived}
                onClick={() => { setShowArchived((value) => !value); setShowTools(false) }}
              >
                <span className="sl-archive-caret"><Chevron open={showArchived} /></span>
                <span>已归档</span>
                <span className="sl-group-count">{archived.length}</span>
              </button>
            )}
          </div>
          {showTools && (
            <div className="sl-tool-body">
              {tools.map((session) => (
                <button
                  type="button"
                  key={sessionDedupKey(session)}
                  data-session-id={session.id}
                  className={`session-item tool-session${activeId === session.id ? ' active' : ''}`}
                  onClick={() => onSelect(session.id)}
                >
                  <span className="si-icon"><AgentIcon agentId={session.config.agentId} adapter={agents.find((agent) => agent.id === session.config.agentId)?.adapter} /></span>
                  <span className="si-title">{session.title}</span>
                  <span className="si-mcp-source" title="工具创建 · 只读"><UiIcon name="plug" size={13} /></span>
                  <StatusIndicator status={statusBySession[session.id] || session.status} hasPendingInteraction={pendingInteractionBySession[session.id]} />
                </button>
              ))}
            </div>
          )}
          {showArchived && (
            <div className="sl-archive-body">
              {archived.map((s) => {
                const agent = agents.find((a) => a.id === s.config.agentId)
                return (
                  <div
                    key={sessionDedupKey(s)}
                    tabIndex={0}
                    data-session-id={s.id}
                    className={`session-item archived ${
                      exiting[s.id] ? `exiting-${exiting[s.id]}` : ''
                    }`}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      menuTriggerRef.current = e.currentTarget
                      setMenu({ kind: 'session', id: s.id, x: e.clientX, y: e.clientY })
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
                      e.preventDefault()
                      e.stopPropagation()
                      menuTriggerRef.current = e.currentTarget
                      const rect = e.currentTarget.getBoundingClientRect()
                      setMenu({ kind: 'session', id: s.id, x: rect.left, y: rect.bottom })
                    }}
                  >
                    <span className="si-icon">
                      <>{s.teamBinding ? <UiIcon name="users" size={15} /> : <AgentIcon agentId={s.config.agentId} adapter={agent?.adapter} />}</>
                    </span>
                    {renderTitle(s)}
                    {s.handoffId && (
                      <span className="si-mcp-source" role="img" title="通过 MCP 创建" aria-label="通过 MCP 创建">
                        <UiIcon name="plug" size={13} />
                      </span>
                    )}
                    <span className="si-actions">
                      {renderRenameAction(s)}
                      <button
                        className="si-act"
                        title="恢复"
                        aria-label="恢复会话"
                        onClick={(e) => {
                          e.stopPropagation()
                          onUnarchive(s.id)
                        }}
                      >
                        <UiIcon name="restore" size={15} />
                      </button>
                      <button
                        className="si-act si-del"
                        title="删除"
                        aria-label="删除会话" disabled={!canDelete(s)}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm(`删除会话「${s.title}」？此操作不可撤销。`))
                            runExit([s.id], 'delete', ([id]) => onDelete(id))
                        }}
                      >
                        <UiIcon name="trash" size={15} />
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {menu &&
        (() => {
          const s = menu.kind === 'session' ? sessions.find((x) => x.id === menu.id) : undefined
          const requirement = menu.kind === 'requirement' ? requirements.find((r) => r.id === menu.id) : undefined
          if (!s && !requirement) return null
          return (
            <>
              {/* Click-away + right-click-away layer closes the menu. */}
              <div
                className="ctx-backdrop"
                onClick={closeMenu}
                onContextMenu={(e) => {
                  e.preventDefault()
                  closeMenu()
                }}
              />
              <div
                ref={menuRef}
                className="ctx-menu"
                role="menu"
                aria-label={requirement ? '需求操作' : '会话操作'}
                style={{ left: menu.x, top: menu.y }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    closeMenu()
                    menuTriggerRef.current?.focus()
                  } else if (e.key === 'Tab') {
                    closeMenu()
                  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault()
                    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
                    const index = items.indexOf(document.activeElement as HTMLButtonElement)
                    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
                      : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                    items[next]?.focus()
                  }
                }}
              >
                {requirement ? <>
                  <button type="button" role="menuitem" className="ctx-item" onClick={() => { closeMenu(); onOpenRequirement?.(requirement.docPath, requirement.dir) }}>
                    <UiIcon name="file" size={15} /> 打开需求上下文
                  </button>
                  {requirement.status !== 'archived' && <button type="button" role="menuitem" className="ctx-item danger" disabled={!!archivingRequirement} onClick={() => { closeMenu(); void archiveRequirement(requirement) }}>
                    <UiIcon name="archive" size={15} /> 归档需求
                  </button>}
                </> : <>
                <button type="button" role="menuitem" className="ctx-item" onClick={() => beginRename(s!)}>
                  <UiIcon name="edit" size={15} /> 重命名
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ctx-item"
                  onClick={() => {
                    onPin(s!.id, !s!.pinned)
                    closeMenu()
                  }}
                >
                  <UiIcon name="pin" size={15} /> {s!.pinned ? '取消置顶' : '置顶'}
                </button>
                {!s!.archived && !batchMode && <button type="button" role="menuitem" className="ctx-item" onClick={() => enterMultiSelect(s!.id)}>
                  <UiIcon name="checkbox" size={15} /> 多选
                </button>}
                <div className="ctx-sep" role="separator" />
                {s!.archived ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="ctx-item"
                    onClick={() => {
                      onUnarchive(s!.id)
                      closeMenu()
                    }}
                  >
                    <UiIcon name="restore" size={15} /> 恢复
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="ctx-item" disabled={!canArchive(s!)}
                    onClick={() => {
                      closeMenu()
                      runExit([s!.id], 'archive', ([id]) => onArchive(id))
                    }}
                  >
                    <UiIcon name="archive" size={15} /> 归档会话
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="ctx-item danger" disabled={!canDelete(s!)} title={s!.teamBinding && !canDelete(s!) ? '运行中的专家团需先停止才能删除' : undefined}
                  onClick={() => {
                    closeMenu()
                    if (confirm(`删除会话「${s!.title}」？此操作不可撤销。`))
                      runExit([s!.id], 'delete', ([id]) => onDelete(id))
                  }}
                >
                  <UiIcon name="trash" size={15} /> 删除
                </button>
                </>}
              </div>
            </>
          )
        })()}
    </div>
  )
}

/**
 * Codex-style activity indicator (需求1.4): a spinning ring while a turn is in
 * flight, a pulsing 问号气泡 while a question/授权 request awaits the user
 * (including async questions during a running turn), a small blue/cyan "unread" dot
 * once a main/side turn finishes, and nothing when idle + read.
 */
export function StatusIndicator({ status, hasPendingInteraction, unread }: { status: SessionActivityStatus; hasPendingInteraction?: boolean; unread?: ReplyUnreadKind }): JSX.Element | null {
  // Pending questions take priority even when the agent keeps running.
  if (hasPendingInteraction || status === 'awaiting-approval')
    return (
      <svg
        className="si-ask"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <title>等待你的回答</title>
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
        <path d="M9.2 9.4a2.8 2.8 0 0 1 5 1.4c0 1.6-2 2-2 3" strokeWidth="1.7" />
        <path d="M12.1 15.2h.01" strokeWidth="2.2" />
      </svg>
    )
  if (status === 'error') return <span className="si-error" title="会话出错" />
  if (status === 'waiting_members') return <span className="si-spinner" title="等待组员交付" />
  if (isSessionBusy(status)) return <span className="si-spinner" title={status} />
  if (unread) return <span className={`si-unread ${unread === 'side' ? 'side' : ''}`} title={unread === 'side' ? '侧边对话有新回复' : '有新回复'} />
  return null
}

export interface SidebarProjectGroup {
  project: Project
  sessions: Session[]
}

export function splitPinnedSessions(sessions: readonly Session[]): {
  pinned: Session[]
  regular: Session[]
} {
  const pinned: Session[] = []
  const regular: Session[] = []
  for (const session of sessions) (session.pinned ? pinned : regular).push(session)
  return { pinned, regular }
}

export function groupSessionsByAgent(
  sessions: readonly Session[],
  agents: readonly Pick<AgentDef, 'id'>[],
  pinnedAgentIds: readonly string[],
  keyFor: (session: Session) => string = session => session.config.agentId
): [string, Session[]][] {
  const groups = new Map<string, Session[]>()
  for (const session of sessions) {
    const key = keyFor(session)
    const list = groups.get(key) || []
    list.push(session)
    groups.set(key, list)
  }
  const knownAgentIds = new Set(agents.map((agent) => agent.id))
  for (const agentId of pinnedAgentIds) {
    if (knownAgentIds.has(agentId) && !groups.has(agentId)) groups.set(agentId, [])
  }
  return [...groups.entries()]
}

export function groupSessionsByProject(
  sessions: readonly Session[],
  projects: readonly Project[],
  pinnedProjectIds: readonly string[] = []
): SidebarProjectGroup[] {
  const fallback: Project = projects.find((project) => project.isDefault) || {
    id: 'default',
    name: '默认空间',
    primaryDirectory: '',
    additionalDirectories: [],
    createdAt: 0,
    updatedAt: 0,
    isDefault: true
  }
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const pinned = new Set(pinnedProjectIds)
  const groups = new Map(projects
    .filter((project) => pinned.has(project.id))
    .map((project) => [project.id, { project, sessions: [] as Session[] }]))
  if (pinned.has(fallback.id) && !groups.has(fallback.id)) groups.set(fallback.id, { project: fallback, sessions: [] })
  for (const session of sessions) {
    const project = projectsById.get(session.config.projectId || '') || fallback
    const group: SidebarProjectGroup = groups.get(project.id) || { project, sessions: [] }
    group.sessions.push(session)
    groups.set(project.id, group)
  }
  return [...groups.values()].sort((left, right) => {
    if (left.project.id === fallback.id) return right.project.id === fallback.id ? 0 : -1
    if (right.project.id === fallback.id) return 1
    return left.project.name.localeCompare(right.project.name)
  })
}

export function readOrder(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
      : []
  } catch {
    return []
  }
}

export function persistOrder(
  key: string,
  order: string[],
  setter: (order: string[]) => void
): void {
  setter(order)
  localStorage.setItem(key, JSON.stringify(order))
}

export function toggleStoredItem(
  key: string,
  items: string[],
  id: string,
  setter: (items: string[]) => void
): void {
  persistOrder(key, items.includes(id) ? items.filter((item) => item !== id) : [...items, id], setter)
}

export function finishOrderDrag(drag: DragStart | null, committed: boolean): void {
  if (!committed && drag) persistOrder(drag.storageKey, drag.preview, drag.setter)
}

export function applyOrder<T>(items: T[], order: string[], key: (item: T) => string): T[] {
  if (order.length === 0) return items
  const positions = new Map(order.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const aPosition = positions.get(key(a))
    const bPosition = positions.get(key(b))
    if (aPosition === undefined) return bPosition === undefined ? 0 : -1
    if (bPosition === undefined) return 1
    return aPosition - bPosition
  })
}

export function moveItem(items: string[], source: string, target: string, after: boolean): string[] {
  const next = items.filter((item) => item !== source)
  const targetIndex = next.indexOf(target)
  if (targetIndex < 0) return items
  next.splice(targetIndex + Number(after), 0, source)
  return next.every((item, index) => item === items[index]) ? items : next
}
