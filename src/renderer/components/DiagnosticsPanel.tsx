import { useEffect, useState } from 'react'
import type { DiagnosticEntry } from '@shared/types'
import { AgentIcon } from './AgentIcon'

/**
 * 跨 Agent 迁移诊断面板 (cross-agent migration diagnostics).
 *
 * When a session is read from one agent's native store and reconstructed for
 * another (see main/history.ts), the parser may hit data it doesn't yet handle:
 * an unknown record / payload / content-block type, or a line that fails to
 * parse. Those gaps silently degrade the transplant (missing history, dropped
 * tool calls). The main process collects each gap into a diagnostics store; this
 * panel surfaces them with a clear problem description + raw sample so the user
 * can hit "复制全部日志" and paste the report straight back for a fix.
 *
 * 需求(此面板): 侧边栏入口。运行时若在会话跨 Agent 搬运中遇到未处理的新数据 /
 * 未知字段 / 异常，就收集到这里，把问题描述清楚，用户可一键复制发回。
 */
export function DiagnosticsPanel(): JSX.Element {
  const [items, setItems] = useState<DiagnosticEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  function reload(): void {
    setLoading(true)
    window.uniagent
      .listDiagnostics()
      // 迁移诊断 only surfaces anomalies; drop any legacy success (`export_ok`) row.
      .then((d) => setItems(d.filter((e) => e.code !== 'export_ok')))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    reload()
    // Live-refresh when a new gap is recorded while this panel is open.
    const off = window.uniagent.onDiagnostic(() => reload())
    return off
  }, [])

  async function copyAll(): Promise<void> {
    await window.uniagent.copyDiagnosticsReport()
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  async function clearAll(): Promise<void> {
    await window.uniagent.clearDiagnostics()
    setItems([])
    setExpanded({})
  }

  return (
    <div className="main-panel diagnostics-panel">
      <div className="main-panel-head">
        <span className="main-panel-title">迁移诊断</span>
        <div className="diag-head-actions">
          <button className="diag-btn" disabled={items.length === 0} onClick={copyAll}>
            {copied ? '已复制 ✓' : '复制全部日志'}
          </button>
          <button className="diag-btn diag-btn-ghost" disabled={items.length === 0} onClick={clearAll}>
            清空
          </button>
        </div>
      </div>
      <div className="diag-intro">
        会话在跨 Agent 搬运（如 Codex ↔ TraeX ↔ Claude）时遇到的<strong>未处理数据 / 未知字段 / 解析异常</strong>会记录在这里。
        点击「复制全部日志」把报告整段发回，即可按日志定位并修复。
      </div>
      <div className="drawer-list diag-list">
        {loading ? (
          <div className="drawer-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="drawer-empty">暂无诊断记录 — 目前没有遇到未处理的数据 👍</div>
        ) : (
          items.map((e) => {
            const open = !!expanded[e.id]
            return (
              <div key={e.id} className={`drawer-item diag-item diag-${e.level}`}>
                <span className="drawer-item-icon">
                  <AgentIcon agentId={e.agentId} size={15} />
                </span>
                <div className="drawer-item-main diag-main">
                  <div className="diag-line1">
                    <span className={`diag-badge diag-badge-${e.level}`}>
                      {e.level === 'error' ? '错误' : '警告'}
                    </span>
                    <span className="diag-code">{e.code}</span>
                    {e.field && <span className="diag-field">{e.field}</span>}
                    {e.count > 1 && <span className="diag-count">×{e.count}</span>}
                  </div>
                  <div className="diag-msg">{e.message}</div>
                  <div className="diag-meta">
                    {e.agentId}
                    {e.sessionId ? ` · ${e.sessionId.slice(0, 8)}` : ''} ·{' '}
                    {new Date(e.ts).toLocaleString()}
                  </div>
                  {e.sample && (
                    <>
                      <button
                        className="diag-sample-toggle"
                        onClick={() => setExpanded((p) => ({ ...p, [e.id]: !open }))}
                      >
                        {open ? '收起原始样本' : '查看原始样本'}
                      </button>
                      {open && <pre className="diag-sample">{e.sample}</pre>}
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="drawer-foot">共 {items.length} 条 · 复制后发回即可按日志修复</div>
    </div>
  )
}
