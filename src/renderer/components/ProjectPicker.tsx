import { useRef, useState } from 'react'
import type { Project, ProjectGitInfo, WorkspaceSelection } from '@shared/types'
import { FolderIcon, UiIcon } from './Icons'
import { ProjectEditorDialog } from './ProjectEditorDialog'
import { usePickerMenuPlacement } from './usePickerMenuPlacement'

export function ProjectPicker({
  projects,
  projectId,
  disabled,
  workspaceSelection,
  gitInfo,
  onWorkspaceChange,
  onSelect,
  onProjectsChange
}: {
  projects: Project[]
  projectId: string
  disabled?: boolean
  workspaceSelection?: WorkspaceSelection
  gitInfo?: ProjectGitInfo
  onWorkspaceChange?: (mode: WorkspaceSelection['mode'], baseRef: string) => void
  onSelect: (project: Project) => void
  onProjectsChange: (projects: Project[]) => void
}): JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const selected = projects.find((project) => project.id === projectId) || projects.find((project) => project.isDefault)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visible = normalizedQuery
    ? projects.filter((project) => `${project.name} ${project.primaryDirectory}`.toLocaleLowerCase().includes(normalizedQuery))
    : projects
  const useWorktree = workspaceSelection?.mode === 'worktree'
  const worktreeDisabled = disabled || !gitInfo?.canCreateWorktree

  usePickerMenuPlacement(open, detailsRef, menuRef)

  return (
    <>
      <details ref={detailsRef} className="project-picker" name="new-task-menu" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cfg-dir project-picker-trigger" title={selected?.primaryDirectory} aria-disabled={disabled} onClick={(event) => { if (disabled) event.preventDefault() }}>
          <FolderIcon size={14} />
          <span>{selected?.name || '选择空间'}{useWorktree ? ' · 工作树' : ''}</span>
          <UiIcon name="chevron-right" size={12} />
        </summary>
        {open && <div ref={menuRef} className="project-picker-pop">
          <label className="project-picker-search"><UiIcon name="search" size={12} /><input value={query} placeholder="搜索空间" onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="project-picker-list" role="listbox" aria-label="空间">
            {visible.map((project) => (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={project.id === selected?.id}
                className={project.id === selected?.id ? 'is-selected' : ''}
                disabled={disabled}
                onClick={() => {
                  onSelect(project)
                  if (!workspaceSelection) detailsRef.current?.removeAttribute('open')
                }}
              >
                <FolderIcon size={14} />
                <span><strong>{project.name}</strong><small>{project.primaryDirectory}{project.additionalDirectories.length ? ` · +${project.additionalDirectories.length} 个目录` : ''}</small></span>
                {project.id === selected?.id && <UiIcon name="check" size={13} />}
              </button>
            ))}
            {!visible.length && <div className="project-picker-empty">没有匹配的空间</div>}
          </div>
          <button type="button" className="project-picker-create" disabled={disabled} onClick={() => { detailsRef.current?.removeAttribute('open'); setCreating(true) }}><UiIcon name="plus" size={13} /> 新建空间</button>
          {workspaceSelection && onWorkspaceChange && <div className="project-workspace-group">
            <div className="project-workspace-label">工作方式</div>
            <button type="button" className={`project-workspace-option ${!useWorktree ? 'is-selected' : ''}`} disabled={disabled} role="radio" aria-checked={!useWorktree} onClick={() => onWorkspaceChange('local', workspaceSelection.baseRef || 'HEAD')}>
              <FolderIcon size={14} />
              <span><strong>当前分支</strong><small>{gitInfo?.currentBranch ? `在 ${gitInfo.currentBranch} 分支的当前目录工作` : gitInfo?.canCreateWorktree ? '在当前提交的目录工作' : '直接在空间主目录工作'}</small></span>
              {!useWorktree && <UiIcon name="check" size={13} />}
            </button>
            <div className={`project-workspace-option project-worktree-option ${useWorktree ? 'is-selected' : ''} ${worktreeDisabled ? 'is-disabled' : ''}`}>
              <button type="button" className="project-worktree-choice" disabled={worktreeDisabled} role="radio" aria-checked={useWorktree} onClick={() => onWorkspaceChange('worktree', workspaceSelection.baseRef || 'HEAD')}>
                <UiIcon name="fork" size={14} />
                <span><strong>新工作树</strong><small>发送时自动创建独立目录</small></span>
              </button>
              <select aria-label="新工作树的基准分支" title="选择新工作树的基准分支" disabled={worktreeDisabled} value={workspaceSelection.baseRef || 'HEAD'}
                onFocus={() => { if (!worktreeDisabled) onWorkspaceChange('worktree', workspaceSelection.baseRef || 'HEAD') }}
                onChange={(event) => onWorkspaceChange('worktree', event.target.value)}>
                <option value="HEAD">{gitInfo?.currentBranch || '当前提交'}</option>
                {gitInfo?.branches.filter(branch => branch.name !== gitInfo.currentBranch || branch.ref === workspaceSelection.baseRef).map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}
              </select>
              {useWorktree && <UiIcon name="check" size={13} />}
            </div>
            <div className="project-workspace-note">{!gitInfo ? '正在读取分支…' : gitInfo.unavailableReason || '只派生主目录，附加目录仍共享。'}</div>
          </div>}
        </div>}
      </details>
      {creating && <ProjectEditorDialog onClose={() => setCreating(false)} onSaved={(project) => {
        onProjectsChange([...projects, project])
        onSelect(project)
        window.dispatchEvent(new Event('uniagent-projects-changed'))
        setCreating(false)
      }} />}
    </>
  )
}
