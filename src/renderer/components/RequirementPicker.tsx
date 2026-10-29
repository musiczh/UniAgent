import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Requirement } from '@shared/requirementTypes'
import { useRequirements } from '../useRequirements'
import { UiIcon } from './Icons'
import { usePickerMenuPlacement } from './usePickerMenuPlacement'

export function RequirementEditor({ requirement, onClose, onSaved }: {
  requirement?: Requirement; onClose: () => void; onSaved: (r: Requirement) => void
}): JSX.Element {
  const [name, setName] = useState(requirement?.name || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  async function save(): Promise<void> {
    if (saving.current || !name.trim()) return
    saving.current = true; setBusy(true); setError('')
    try {
      const r = requirement ? await window.uniagent.updateRequirement(requirement.id, { name }) : await window.uniagent.createRequirement({ name })
      onSaved(r)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { saving.current = false; setBusy(false) }
  }
  return createPortal(<div className="modal-overlay project-editor-overlay" role="dialog" aria-modal="true" aria-label={requirement ? '编辑需求' : '新建需求'}>
    <form className="project-editor" onSubmit={e => { e.preventDefault(); void save() }}>
      <div className="project-editor-head"><h2>{requirement ? '编辑需求' : '新建需求'}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭"><UiIcon name="close" size={18} /></button></div>
      <label className="project-editor-field"><span>需求名称</span><span className="project-editor-input"><UiIcon name="file" size={16} /><input autoFocus maxLength={70} value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="例如：需求空间功能" /></span></label>
      <p className="requirement-hint">需求独立于空间，目录按需求命名。创建后自动生成 context.md，后续会话共享其中的背景、进展与产出。</p>
      {requirement && <p className="requirement-hint">改名将同步重命名需求目录；有运行中会话时暂不可改名。</p>}
      {error && <p role="alert" className="requirement-error">{error}</p>}
      <div className="project-editor-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="is-primary" disabled={busy || !name.trim()}>{busy ? '保存中…' : requirement ? '保存' : '创建需求'}</button></div>
    </form>
  </div>, document.body)
}

export function RequirementPicker({ value, onChange, disabled }: { value?: string; onChange: (id?: string) => void; disabled?: boolean }): JSX.Element {
  const { requirements, error, loading } = useRequirements()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [createError, setCreateError] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDetailsElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const createRequest = useRef<symbol>()
  usePickerMenuPlacement(open, ref, menuRef)
  const selected = requirements.find(r => r.id === value)
  const visible = requirements.filter(r => r.status !== 'archived' && r.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const cancelCreate = (): void => { createRequest.current = undefined; setBusy(false); setCreating(false); setDraft(''); setCreateError('') }
  const choose = (id?: string): void => { cancelCreate(); onChange(id); ref.current?.removeAttribute('open') }
  async function create(): Promise<void> {
    const name = draft.trim()
    if (createRequest.current || disabled || !name) return
    const request = Symbol()
    createRequest.current = request
    setBusy(true); setCreateError('')
    try {
      const r = await window.uniagent.createRequirement({ name })
      if (createRequest.current === request && ref.current?.open) choose(r.id)
    } catch (e) { if (createRequest.current === request && ref.current?.open) setCreateError(e instanceof Error ? e.message : String(e)) }
    finally { if (createRequest.current === request) { createRequest.current = undefined; setBusy(false) } }
  }
  return <>
    <details className="project-picker requirement-picker" name="new-task-menu" ref={ref} onToggle={e => { setOpen(e.currentTarget.open); if (!e.currentTarget.open) cancelCreate() }}>
      <summary className="cfg-dir project-picker-trigger" aria-disabled={disabled} onClick={e => { if (disabled) e.preventDefault() }} title={selected?.dir}>
        <UiIcon name="file" size={14} /><span>{selected?.name || (value ? '需求不可用' : '选择需求')}</span><UiIcon name="chevron-right" size={12} />
      </summary>
      <div className="project-picker-pop" ref={menuRef}>
        <label className="project-picker-search"><UiIcon name="search" size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索需求" /></label>
        <div className="project-picker-list" role="listbox" aria-label="需求">
          <button type="button" role="option" aria-selected={!value} disabled={disabled} onClick={() => choose()}><UiIcon name="minus" size={16} /><span><strong>不归入需求</strong><small>普通会话</small></span></button>
          {visible.map(r => <button type="button" key={r.id} role="option" aria-selected={r.id === value} className={r.id === value ? 'is-selected' : ''} disabled={disabled} onClick={() => choose(r.id)}><UiIcon name="file" size={16} /><span><strong>{r.name}{r.status === 'done' ? ' · 已完成' : ''}</strong><small>{r.dir}</small></span>{r.id === value && <UiIcon name="check" size={15} />}</button>)}
          {loading && <div className="project-picker-empty">加载中…</div>}
          {error && <div className="project-picker-empty" role="alert">{error}</div>}
          {!loading && !error && !visible.length && <div className="project-picker-empty">没有匹配的需求</div>}
        </div>
        {creating ? <div className="requirement-create-inline">
          <span className="requirement-create-input"><UiIcon name="file" size={15} /><input autoFocus maxLength={70} value={draft} disabled={busy} placeholder="新需求名称，回车创建" onChange={e => { setDraft(e.target.value); setCreateError('') }} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); void create() } else if (e.key === 'Escape') { e.preventDefault(); cancelCreate() } }} onBlur={() => { if (!draft.trim() && !busy) cancelCreate() }} /></span>
          <button type="button" className="requirement-create-ok" aria-label="创建并选择" disabled={busy || !draft.trim()} onMouseDown={e => e.preventDefault()} onClick={() => void create()}><UiIcon name="check" size={15} /></button>
        </div> : <button type="button" className="project-picker-create" disabled={disabled || loading || !!error} onClick={() => setCreating(true)}><UiIcon name="plus" size={15} />新建需求</button>}
        {createError && <p role="alert" className="requirement-create-error">{createError}</p>}
      </div>
    </details>
  </>
}

export function confirmArchiveRequirement(r: Requirement): boolean {
  return window.confirm('确定归档需求「' + r.name + '」？\n\n归档表示需求已结束，将移入「已归档需求」。只修改需求状态，不归档或删除其下会话。后续可在设置中恢复。')
}
