import { useRef, useState } from 'react'
import type { Project, ProjectGitInfo, WorkspaceSelection } from '@shared/types'
import { FolderIcon, UiIcon } from './Icons'
import { ProjectEditorDialog } from './ProjectEditorDialog'
import { usePickerMenuPlacement } from './usePickerMenuPlacement'
import type { Requirement } from '@shared/requirementTypes'
import { RequirementEditor } from './RequirementPicker'
import { AutoRoutingLabel } from './AutoRoutingLabel'

export function ProjectPicker({
  projects,
  projectId,
  disabled,
  workspaceSelection,
  gitInfo,
  onWorkspaceChange,
  onSelect,
  onProjectsChange,
  requirements,
  requirementId,
  requirementsLoading,
  requirementsError,
  onRequirementSelect,
  autoRouting
}: {
  projects: Project[]
  projectId: string
  disabled?: boolean
  workspaceSelection?: WorkspaceSelection
  gitInfo?: ProjectGitInfo
  onWorkspaceChange?: (mode: WorkspaceSelection['mode'], baseRef: string) => void
  onSelect: (project: Project) => void
  onProjectsChange: (projects: Project[]) => void
  requirements?: Requirement[]
  requirementId?: string
  requirementsLoading?: boolean
  requirementsError?: string
  onRequirementSelect?: (requirement: Requirement) => void
  autoRouting?: { selected: boolean; available: boolean; reason?: string; onSelect: () => void }
}): JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingRequirement, setEditingRequirement] = useState<Requirement | 'new' | null>(null)
  const selected = projects.find((project) => project.id === projectId) || (!projectId ? projects.find((project) => project.isDefault) : undefined)
  const selectedRequirement = requirements?.find(requirement => requirement.id === requirementId)
  const automatic = autoRouting?.selected === true
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const unbound = requirements?.filter(r => !projects.some(project => project.id === r.projectId) && r.status !== 'archived' && r.name.toLocaleLowerCase().includes(normalizedQuery)) || []
  const visible = normalizedQuery
    ? projects.filter((project) => `${project.name} ${project.primaryDirectory}`.toLocaleLowerCase().includes(normalizedQuery) || requirements?.some(r => r.projectId === project.id && r.status !== 'archived' && r.name.toLocaleLowerCase().includes(normalizedQuery)))
    : projects
  const useWorktree = workspaceSelection?.mode === 'worktree'
  const worktreeDisabled = disabled || !automatic && !gitInfo?.canCreateWorktree

  usePickerMenuPlacement(open, detailsRef, menuRef)

  return (
    <>
      <details ref={detailsRef} className="project-picker" name="new-task-menu" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className={`cfg-dir project-picker-trigger${!automatic && requirementId ? ' requirement-scope-trigger' : ''}`} title={automatic ? '判断归属后新建或继续已有任务' : requirementId ? selectedRequirement?.name : selected?.primaryDirectory} aria-disabled={disabled} onClick={(event) => { if (disabled) event.preventDefault() }}>
          {automatic ? <UiIcon name="router" size={14} /> : requirementId ? <UiIcon name="file" size={14} /> : <FolderIcon size={14} />}
          <span>{automatic ? '自动归属' : requirementId ? selectedRequirement?.name || '需求不可用' : selected?.name || '选择项目'}{useWorktree ? ' · 工作树' : ''}</span>
          <UiIcon name="chevron-right" size={12} />
        </summary>
        {open && <div ref={menuRef} className="project-picker-pop">
          <label className="project-picker-search"><UiIcon name="search" size={12} /><input value={query} placeholder={requirements ? '搜索项目或需求' : '搜索项目'} onChange={(event) => setQuery(event.target.value)} /></label>
          <div className={`project-picker-list${requirements ? ' scope-picker-list' : ''}`} role="listbox" aria-label={requirements ? '项目或需求' : '项目'}>
            {autoRouting && <button type="button" role="option" aria-selected={automatic} className={`scope-picker-auto${automatic ? ' is-selected' : ''}`} disabled={disabled || !autoRouting.available} title={autoRouting.available ? '判断归属后新建或继续已有任务' : autoRouting.reason || '请先在 superAgent配置中启用 RouterAgent'} onClick={() => { autoRouting.onSelect(); detailsRef.current?.removeAttribute('open') }}><UiIcon name="router" size={14} /><AutoRoutingLabel active={!disabled && autoRouting.available} />{!autoRouting.available ? <small>暂不可用</small> : automatic ? <UiIcon name="check" size={13} /> : <small className="scope-picker-auto-action">选择</small>}</button>}
            {visible.map((project) => <div key={project.id}>
              <button
                type="button"
                role="option"
                aria-selected={!automatic && !requirementId && project.id === selected?.id}
                className={!automatic && !requirementId && project.id === selected?.id ? 'is-selected' : ''}
                disabled={disabled}
                onClick={() => {
                  onSelect(project)
                  if (!workspaceSelection) detailsRef.current?.removeAttribute('open')
                }}
              >
                <FolderIcon size={14} />
                <span><strong>{project.name}</strong><small>{project.primaryDirectory}{project.additionalDirectories.length ? ` · +${project.additionalDirectories.length} 个目录` : ''}</small></span>
                {!automatic && !requirementId && project.id === selected?.id && <UiIcon name="check" size={13} />}
              </button>
              {requirements?.filter(r => r.projectId === project.id && r.status !== 'archived' && (!normalizedQuery || project.name.toLocaleLowerCase().includes(normalizedQuery) || r.name.toLocaleLowerCase().includes(normalizedQuery))).map(r => <button key={r.id} type="button" role="option" aria-selected={!automatic && r.id === requirementId} className={`scope-picker-requirement${!automatic && r.id === requirementId ? ' is-selected' : ''}`} disabled={disabled || requirementsLoading || !!requirementsError} onClick={() => { onRequirementSelect?.(r); detailsRef.current?.removeAttribute('open') }}><UiIcon name="file" size={14} /><span><strong>{r.name}</strong><small>需求{r.status === 'done' ? ' · 已完成' : ''}</small></span>{!automatic && r.id === requirementId && <UiIcon name="check" size={13} />}</button>)}
            </div>)}
            {unbound.map(r => <button key={r.id} type="button" role="option" aria-selected={!automatic && r.id === requirementId} disabled={disabled || requirementsLoading || !!requirementsError} onClick={() => { detailsRef.current?.removeAttribute('open'); setEditingRequirement(r) }}><UiIcon name="file" size={14} /><span><strong>{r.name}</strong><small>未绑定有效项目 · 点击设置</small></span></button>)}
            {requirementsLoading && <div className="project-picker-empty">正在读取需求…</div>}
            {requirementsError && <div className="project-picker-empty" role="alert">{requirementsError}</div>}
            {!visible.length && !unbound.length && !requirementsLoading && !requirementsError && <div className="project-picker-empty">{requirements ? '没有匹配的项目或需求' : '没有匹配的项目'}</div>}
          </div>
          <div className="project-picker-create-row">
            <button type="button" className="project-picker-create" disabled={disabled} onClick={() => { detailsRef.current?.removeAttribute('open'); setCreating(true) }}><UiIcon name="plus" size={13} /> 新建项目</button>
            {requirements && <button type="button" className="project-picker-create" disabled={disabled || requirementsLoading || !!requirementsError} onClick={() => { detailsRef.current?.removeAttribute('open'); setEditingRequirement('new') }}><UiIcon name="plus" size={13} />新建需求</button>}
          </div>
          {workspaceSelection && onWorkspaceChange && <div className="project-workspace-group">
            <div className={`project-workspace-option project-worktree-option ${useWorktree ? 'is-selected' : ''} ${worktreeDisabled ? 'is-disabled' : ''}`} title={automatic ? undefined : gitInfo?.unavailableReason}>
              <button type="button" className="project-worktree-choice" disabled={worktreeDisabled} role="checkbox" aria-checked={useWorktree} onClick={() => onWorkspaceChange(useWorktree ? 'local' : 'worktree', automatic ? 'HEAD' : workspaceSelection.baseRef || 'HEAD')}>
                <UiIcon name="fork" size={14} />
                <span>新工作树</span>
                {useWorktree && <UiIcon name="check" size={13} />}
              </button>
              {automatic ? <span className="project-worktree-hint">{useWorktree ? '分配后创建' : '分配后检查'}</span> : useWorktree ? <select aria-label="新工作树的基准分支" title="选择新工作树的基准分支" disabled={worktreeDisabled} value={workspaceSelection.baseRef || 'HEAD'}
                onChange={(event) => onWorkspaceChange('worktree', event.target.value)}>
                <option value="HEAD">{gitInfo?.currentBranch || '当前提交'}</option>
                {gitInfo?.branches.filter(branch => branch.name !== gitInfo.currentBranch || branch.ref === workspaceSelection.baseRef).map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}
              </select> : <span className="project-worktree-hint">{!gitInfo ? '正在检查…' : gitInfo.unavailableReason || '未启用'}</span>}
            </div>
          </div>}
        </div>}
      </details>
      {creating && <ProjectEditorDialog onClose={() => setCreating(false)} onSaved={(project) => {
        onProjectsChange([...projects, project])
        onSelect(project)
        window.dispatchEvent(new Event('uniagent-projects-changed'))
        setCreating(false)
      }} />}
      {editingRequirement && <RequirementEditor requirement={editingRequirement === 'new' ? undefined : editingRequirement} initialProjectId={selected?.id} onClose={() => setEditingRequirement(null)} onSaved={requirement => { setEditingRequirement(null); onRequirementSelect?.(requirement) }} />}
    </>
  )
}
