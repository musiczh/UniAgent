import { useState } from 'react'
import type { Requirement, RequirementStatus } from '@shared/requirementTypes'
import { useRequirements } from '../useRequirements'
import { RequirementEditor, confirmArchiveRequirement } from './RequirementPicker'
import { ToggleSwitch, UiIcon } from './Icons'
import { SetRow } from './SettingsPrimitives'
import { settingSection } from '@shared/settingsDefinition'

export function RequirementSettings({ enabled, onToggle, onBrowse }: {
  enabled: boolean
  onToggle: (checked: boolean) => void
  onBrowse?: (id: string) => void
}): JSX.Element {
  const { requirements, loading, error: loadError } = useRequirements()
  const [editing, setEditing] = useState<Requirement | 'new' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const field = settingSection('/requirements/preferences').fields.requirementsEnabled
  async function run(action: () => Promise<unknown>): Promise<void> {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  function status(r: Requirement, value: RequirementStatus): void {
    if (value === 'archived' && !confirmArchiveRequirement(r)) return
    void run(() => window.uniagent.updateRequirement(r.id, { status: value }))
  }
  const switchRow = (
    <div className="set-group">
      <div className="set-card">
        <SetRow
          label={field.label}
          sub={field.description}
          control={<ToggleSwitch checked={enabled} label={field.label} onChange={onToggle} />}
        />
      </div>
    </div>
  )
  if (!enabled) {
    return <>
      {switchRow}
      <p className="set-detail-sub">需求功能已停用。已有需求数据与会话关联完整保留，重新开启后即可继续使用。</p>
    </>
  }
  return <>
    {switchRow}
    <div className="set-group"><div className="set-group-t"><span className="set-group-t-label">需求 · 共 {requirements.length} 个</span><span className="set-group-t-action"><button className="set-add-btn" disabled={busy} onClick={() => setEditing('new')}><UiIcon name="plus" size={13} />新建需求</button></span></div>
      <div className="set-card">
        {requirements.map(r => <div className="project-settings-row" key={r.id}>
          <div className="project-settings-icon"><UiIcon name="file" size={17} /></div>
          <div className="project-settings-main"><div className="r-label">{r.name}<span className="auto-badge kind">{{ active: '进行中', done: '已完成', archived: '已归档' }[r.status]}</span></div><div className="r-sub" title={r.dir}>{r.dir}</div></div>
          <div className="project-settings-actions">
            {onBrowse && <button className="set-mini-btn ghost" onClick={() => onBrowse(r.id)}>查看详情</button>}
            <button className="set-mini-btn ghost" disabled={busy} onClick={() => void run(() => window.uniagent.openRequirementDir(r.id))}>打开目录</button>
            <button className="set-mini-btn ghost" disabled={busy} onClick={() => setEditing(r)}>编辑</button>
            {r.status !== 'archived' ? <button className="set-mini-btn ghost" disabled={busy} onClick={() => status(r, 'archived')}>归档</button> : <button className="set-mini-btn ghost" disabled={busy} onClick={() => status(r, 'active')}>恢复</button>}
          </div>
        </div>)}
        {!requirements.length && <div className="set-detail-sub requirement-empty">{loading ? '加载中…' : '还没有需求。在这里或新建任务时创建。'}</div>}
      </div>
    </div>
    <p className="set-detail-sub">每个需求拥有独立目录与 context.md。同一需求可关联不同项目的会话；归档需求不会归档会话。</p>
    {(error || loadError) && <p className="requirement-error" role="alert">{error || loadError}</p>}
    {editing && <RequirementEditor requirement={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
  </>
}
