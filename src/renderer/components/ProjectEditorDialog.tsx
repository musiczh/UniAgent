import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { Project, ProjectInput } from '@shared/types'
import { FolderIcon, UiIcon } from './Icons'

interface ProjectEditorProps {
  project?: Project
  onClose?: () => void
  onSaved: (project: Project) => void
  inline?: boolean
  onRemove?: () => void
  busy?: boolean
  navigationGuard?: MutableRefObject<(() => boolean) | null>
}

export function ProjectEditorDialog(props: ProjectEditorProps): JSX.Element {
  return (
    <div className="modal-overlay project-editor-overlay" role="dialog" aria-modal="true" aria-label={props.project ? '编辑项目' : '创建项目'}>
      <div className="project-editor"><ProjectEditorForm {...props} /></div>
    </div>
  )
}

export function ProjectEditorForm({
  project,
  onClose,
  onSaved,
  inline = false,
  onRemove,
  busy = false,
  navigationGuard
}: ProjectEditorProps): JSX.Element {
  const [name, setName] = useState(project?.name || '')
  const [primaryDirectory, setPrimaryDirectory] = useState(project?.primaryDirectory || '')
  const [additionalDirectories, setAdditionalDirectories] = useState(project?.additionalDirectories || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const readOnly = project?.isDefault === true
  const disabled = saving || busy
  const dirty = !!project && (name.trim() !== project.name || primaryDirectory !== project.primaryDirectory ||
    JSON.stringify(additionalDirectories) !== JSON.stringify(project.additionalDirectories))

  function reset(): void {
    setName(project?.name || '')
    setPrimaryDirectory(project?.primaryDirectory || '')
    setAdditionalDirectories(project?.additionalDirectories || [])
    setError('')
  }

  useEffect(reset, [project])

  useEffect(() => {
    if (!navigationGuard) return
    const guard = () => !working.current && !busy && (!dirty || window.confirm('项目信息尚未保存，确定放弃修改？'))
    navigationGuard.current = guard
    return () => { if (navigationGuard.current === guard) navigationGuard.current = null }
  }, [dirty, busy, navigationGuard])

  async function choosePrimary(): Promise<void> {
    const directory = await window.uniagent.pickDirectory()
    if (!directory) return
    setAdditionalDirectories((current) => current.filter((item) => item !== directory))
    setPrimaryDirectory(directory)
  }

  async function addDirectory(): Promise<void> {
    const directory = await window.uniagent.pickDirectory()
    if (!directory || directory === primaryDirectory) return
    setAdditionalDirectories((current) => current.includes(directory) ? current : [...current, directory])
  }

  function makePrimary(directory: string): void {
    setAdditionalDirectories((current) => [primaryDirectory, ...current.filter((item) => item !== directory)].filter(Boolean))
    setPrimaryDirectory(directory)
  }

  async function save(): Promise<void> {
    if (!name.trim() || !primaryDirectory || working.current || busy || readOnly) return
    const input: ProjectInput = { name: name.trim(), primaryDirectory, additionalDirectories }
    working.current = true
    setSaving(true)
    setError('')
    try {
      const saved = project
        ? await window.uniagent.updateProject(project.id, input)
        : await window.uniagent.createProject(input)
      onSaved(saved)
    } catch (reason) {
      setError(projectError(reason))
    } finally {
      working.current = false
      setSaving(false)
    }
  }

  return (
    <div className={inline ? 'project-editor-inline' : undefined}>
        {!inline && <div className="project-editor-head">
          <h2>{project ? '编辑项目' : '创建项目'}</h2>
          <button type="button" onClick={onClose} disabled={disabled} aria-label="关闭"><UiIcon name="close" size={17} /></button>
        </div>}
        <label className="project-editor-field">
          <span>项目名称</span>
          <span className="project-editor-input"><FolderIcon size={16} /><input autoFocus={!inline} aria-label="项目名称" value={name} readOnly={readOnly} disabled={disabled} placeholder="项目名称" onChange={(event) => setName(event.target.value)} /></span>
        </label>
        <div className="project-editor-field">
          <span>目录</span>
          <div className="project-directory-list">
            <div className="project-directory-row is-primary">
              <FolderIcon size={16} />
              <span title={primaryDirectory}>{primaryDirectory || '请选择主目录'}</span>
              <em>主目录</em>
              {!readOnly && <button type="button" disabled={disabled} onClick={() => void choosePrimary()}>选择</button>}
            </div>
            {additionalDirectories.map((directory) => (
              <div className="project-directory-row" key={directory}>
                <FolderIcon size={16} />
                <span title={directory}>{directory}</span>
                {!readOnly && <>
                <button type="button" disabled={disabled} onClick={() => makePrimary(directory)}>设为主目录</button>
                <button type="button" className="is-danger" disabled={disabled} onClick={() => setAdditionalDirectories((current) => current.filter((item) => item !== directory))}>移除</button>
                </>}
              </div>
            ))}
            {!readOnly && <button type="button" className="project-add-directory" disabled={disabled} onClick={() => void addDirectory()}><UiIcon name="plus" size={15} /> 添加目录</button>}
          </div>
        </div>
        {error && <div className="project-editor-error" role="alert">{error}</div>}
        {inline && <p className="set-detail-sub project-info-note">{readOnly
          ? '默认项目不可编辑，主目录始终为用户目录。'
          : '目录变更沿用当前限制：运行中的会话、团队项目或工作树关联可能阻止修改。'}</p>}
        {!readOnly && <div className="project-editor-actions">
          {onRemove && <button type="button" className="project-info-remove" disabled={disabled} onClick={onRemove}><UiIcon name="trash" size={13} />删除项目</button>}
          <button type="button" onClick={inline ? reset : onClose} disabled={disabled}>{inline ? '取消修改' : '取消'}</button>
          <button type="button" className="is-primary" disabled={!name.trim() || !primaryDirectory || disabled || (inline && !dirty)} onClick={() => void save()}>{saving ? '保存中…' : project ? '保存' : '创建项目'}</button>
        </div>}
    </div>
  )
}

function projectError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (message.includes('space_has_team_projects')) return '项目仍被团队项目使用，请停止并归档相关团队项目后再修改目录。'
  if (message.includes('project_has_active_sessions')) return '项目仍有运行中的会话，请等待会话结束后再修改目录。'
  if (message.includes('project_directory_duplicate')) return '同一个目录不能重复添加。'
  if (message.includes('project_directory_unavailable')) return '目录不存在或不可访问，请重新选择。'
  return message || '项目保存失败。'
}
