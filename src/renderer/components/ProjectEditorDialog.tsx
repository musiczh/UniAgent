import { useEffect, useState } from 'react'
import type { Project, ProjectInput } from '@shared/types'
import { FolderIcon, UiIcon } from './Icons'

export function ProjectEditorDialog({
  project,
  onClose,
  onSaved
}: {
  project?: Project
  onClose: () => void
  onSaved: (project: Project) => void
}): JSX.Element {
  const [name, setName] = useState(project?.name || '')
  const [primaryDirectory, setPrimaryDirectory] = useState(project?.primaryDirectory || '')
  const [additionalDirectories, setAdditionalDirectories] = useState(project?.additionalDirectories || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setName(project?.name || '')
    setPrimaryDirectory(project?.primaryDirectory || '')
    setAdditionalDirectories(project?.additionalDirectories || [])
    setError('')
  }, [project])

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
    if (!name.trim() || !primaryDirectory || saving) return
    const input: ProjectInput = { name: name.trim(), primaryDirectory, additionalDirectories }
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
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay project-editor-overlay" role="dialog" aria-modal="true" aria-label={project ? '编辑空间' : '创建空间'}>
      <div className="project-editor">
        <div className="project-editor-head">
          <h2>{project ? '编辑空间' : '创建空间'}</h2>
          <button type="button" onClick={onClose} aria-label="关闭"><UiIcon name="close" size={17} /></button>
        </div>
        <label className="project-editor-field">
          <span>空间名称</span>
          <span className="project-editor-input"><FolderIcon size={16} /><input autoFocus value={name} placeholder="空间名称" onChange={(event) => setName(event.target.value)} /></span>
        </label>
        <div className="project-editor-field">
          <span>目录</span>
          <div className="project-directory-list">
            <div className="project-directory-row is-primary">
              <FolderIcon size={16} />
              <span title={primaryDirectory}>{primaryDirectory || '请选择主目录'}</span>
              <em>主目录</em>
              <button type="button" onClick={() => void choosePrimary()}>选择</button>
            </div>
            {additionalDirectories.map((directory) => (
              <div className="project-directory-row" key={directory}>
                <FolderIcon size={16} />
                <span title={directory}>{directory}</span>
                <button type="button" onClick={() => makePrimary(directory)}>设为主目录</button>
                <button type="button" className="is-danger" onClick={() => setAdditionalDirectories((current) => current.filter((item) => item !== directory))}>移除</button>
              </div>
            ))}
            <button type="button" className="project-add-directory" onClick={() => void addDirectory()}><UiIcon name="plus" size={15} /> 添加目录</button>
          </div>
        </div>
        {error && <div className="project-editor-error" role="alert">{error}</div>}
        <div className="project-editor-actions">
          <button type="button" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="is-primary" disabled={!name.trim() || !primaryDirectory || saving} onClick={() => void save()}>{saving ? '保存中…' : project ? '保存' : '创建空间'}</button>
        </div>
      </div>
    </div>
  )
}

function projectError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (message.includes('space_has_team_projects')) return '空间仍被团队项目使用，请停止并归档相关项目后再修改目录。'
  if (message.includes('project_has_active_sessions')) return '空间仍有运行中的会话，请等待会话结束后再修改目录。'
  if (message.includes('project_directory_duplicate')) return '同一个目录不能重复添加。'
  if (message.includes('project_directory_unavailable')) return '目录不存在或不可访问，请重新选择。'
  return message || '空间保存失败。'
}
