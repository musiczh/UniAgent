import type { ParsedTeamEventPrompt } from '@shared/teamEventPrompt'
import { UiIcon } from './Icons'
import './teamEventCard.css'

const eventLabels: Record<string, string> = {
  recovery: '项目恢复',
  result: '成员交付',
  blocked: '成员受阻',
  interaction: '团队提问',
  user: '用户补充',
  progress: '进度更新',
}

const stateLabels: Record<string, string> = {
  pending: '待处理',
  delivered: '已送达',
  consumed: '已处理',
}

function label(labels: Record<string, string>, value: string | undefined, missing: string): string {
  return value ? Object.hasOwn(labels, value) ? labels[value] : value : missing
}

export function TeamEventCard({ parsed, hideDeliveries = false }: {
  parsed: Exclude<ParsedTeamEventPrompt, { kind: 'not-event' }>
  hideDeliveries?: boolean
}): JSX.Element | null {
  if (parsed.kind === 'invalid') return <div className="team-event-notice">
    <article className="team-event-card is-invalid" aria-label="团队数据解析失败">
      <header className="team-event-head"><UiIcon name="alert-circle" size={15} /><strong>团队数据解析失败</strong></header>
      <details className="team-event-more">
        <summary><UiIcon name="chevron-right" size={13} />查看原文</summary>
        <pre className="team-event-raw">{parsed.raw}</pre>
      </details>
    </article>
  </div>

  const { payload } = parsed
  // Member delivery rows already own their reports; only other team updates need this card.
  const events = payload.events?.filter(item => !hideDeliveries ||
    !item.assignmentId || !['result', 'blocked'].includes(item.kind || ''))
  if (payload.events?.length && !events?.length) return null
  const versions = [
    payload.runId === undefined ? '' : `第 ${payload.runId} 轮`,
    payload.revision === undefined ? '' : `第 ${payload.revision} 版`,
  ].filter(Boolean).join(' · ')

  return <div className="team-event-notice">
    <article className="team-event-card" aria-label="团队动态">
      <header className="team-event-head">
        <UiIcon name="users" size={15} /><strong>团队动态</strong>
        {events && <span className="team-event-count">{events.length} 条事件</span>}
      </header>
      <div className="team-event-list">
        {events?.length ? events.map((item, index) => <section className="team-event-item" key={item.eventId || index}>
          <div className="team-event-item-head">
            <span className="team-event-kind">{label(eventLabels, item.kind, '未提供事件类型')}</span>
            <span className="team-event-state" data-state={item.state}>{label(stateLabels, item.state, '未提供状态')}</span>
          </div>
          <p className="team-event-summary">{item.summary ?? '未提供事件摘要'}</p>
        </section>) : <p className="team-event-empty">{events ? '暂无事件' : '未提供事件列表'}</p>}
      </div>
      <details className="team-event-more">
        <summary><UiIcon name="chevron-right" size={13} /><span>项目摘要与详情</span><span className="team-event-version">{versions}</span></summary>
        <dl className="team-event-facts">
          <div><dt>项目摘要</dt><dd>{payload.summary ?? '未提供项目摘要'}</dd></div>
          {payload.projectId !== undefined && <div><dt>项目编号</dt><dd className="mono">{payload.projectId}</dd></div>}
          {payload.inboxSeq !== undefined && <div><dt>收件序号</dt><dd>{payload.inboxSeq}</dd></div>}
          {events?.map((item, index) => <div className="team-event-record" key={item.eventId || index}>
            <dt>{events.length > 1 ? `事件 ${index + 1}` : '事件编号'}</dt>
            <dd>{item.eventId && <span className="mono">{item.eventId}</span>}
              {item.seq !== undefined && <span>事件序号：{item.seq}</span>}
              {item.runId !== undefined && <span>事件轮次：{item.runId}</span>}
              {item.assignmentId && <span>派单编号：<span className="mono">{item.assignmentId}</span></span>}
              {item.attempt !== undefined && <span>尝试：第 {item.attempt} 次</span>}
              {item.resultRef && <span>成果引用：<span className="mono">{item.resultRef}</span></span>}
            </dd>
          </div>)}
        </dl>
      </details>
    </article>
  </div>
}
