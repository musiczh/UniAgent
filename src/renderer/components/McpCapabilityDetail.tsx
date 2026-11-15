import type { CapabilityInventoryDetail, CapabilityMcpTool } from '@shared/capabilitySync'
import { UiIcon } from './Icons'
import './McpCapabilityDetail.css'

function configuration(detail: CapabilityInventoryDetail): Record<string, unknown> {
  try {
    const value = JSON.parse(detail.manifestText || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []

export function McpCapabilityDetail({ detail, loading, onReadTools }: {
  detail: CapabilityInventoryDetail; loading: boolean; onReadTools: () => void
}): JSX.Element {
  const config = configuration(detail)
  const catalog = detail.mcp?.catalog
  const configured = names(config.enabled_tools).length ? names(config.enabled_tools) : names(config.tools)
  const tools: CapabilityMcpTool[] = catalog?.status === 'loaded' ? catalog.tools : configured.map(name => ({ name, parameters: [] }))
  const command = typeof config.command === 'string' ? config.command : undefined
  const url = typeof config.url === 'string' ? config.url : undefined
  const rows = [
    ['连接方式', command ? 'stdio · 本地进程' : url ? config.type === 'sse' || config.transport === 'sse' ? 'SSE · 远程服务' : 'HTTP · 远程服务' : config.transport],
    ['启动程序', command], ['服务地址', url],
    ['服务名称', catalog?.serverName], ['服务版本', catalog?.version],
    ['工具审批', config.default_tools_approval_mode === 'prompt' ? '每次询问' : config.default_tools_approval_mode],
    ['认证方式', catalog?.authStatus === 'oAuth' ? 'OAuth' : catalog?.authStatus === 'bearerToken' ? 'Bearer Token' : undefined]
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && !!row[1])
  const states = { notStarted: '尚未启动', starting: '连接中', connected: '已连接', authenticationRequired: '需要登录', failed: '连接失败', cancelled: '连接已取消', disabled: '已停用' }
  const state = catalog?.connectionStatus ? states[catalog.connectionStatus] : undefined
  return <div className="cd-mcp-content">
    <div className="cd-section-h">连接信息 {state && <span className="cd-mcp-state">{state}</span>}</div>
    {catalog?.description && <p className="cd-mcp-description">{catalog.description}</p>}
    {rows.length > 0 && <dl className="cd-mcp-summary">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    <div className="cd-mcp-tools-heading"><div className="cd-section-h">工具清单 <span className="cd-section-note">{catalog?.status === 'loaded' ? `已读取 ${tools.length}` : configured.length ? `配置允许 ${tools.length}` : '尚未读取'}</span></div>
      {detail.mcp?.catalogSupported && <button type="button" className="settings-mini-btn" data-mcp-read-tools disabled={loading || config.enabled === false} onClick={onReadTools}>
        <UiIcon name="refresh" size={12}/>{loading ? '读取中…' : catalog ? '刷新工具信息' : '读取工具信息'}
      </button>}
    </div>
    {loading && <p className="cd-mcp-note" role="status">正在读取服务提供的工具名称、说明和参数…</p>}
    {catalog && catalog.status !== 'loaded' && <p className="cd-mcp-note cd-mcp-error" role="alert">{catalog.status === 'not-found' ? '未在 Agent 的当前工具目录中找到此服务。' : '工具信息读取失败，请检查服务运行状态和认证后重试。'}已保留配置中声明的工具。</p>}
    {!catalog && configured.length > 0 && <p className="cd-mcp-note">以下名称来自配置；读取服务后可查看用途说明和输入参数。</p>}
    {config.enabled === false && <p className="cd-mcp-note">此服务已在配置中停用。</p>}
    {tools.map(tool => <details key={tool.name} className="cd-mcp-tool">
      <summary><span><b>{tool.title || tool.name}</b>{tool.title && tool.title !== tool.name && <code>{tool.name}</code>}{tool.description && <small>{tool.description}</small>}</span><UiIcon name="chevron-right" size={14}/></summary>
      <div className="cd-mcp-tool-body">
        {tool.description && <p className="cd-mcp-description">{tool.description}</p>}
        {tool.parameters.length ? <div className="cd-mcp-parameters" role="table" aria-label={`${tool.name} 输入参数`}>
          {tool.parameters.map(parameter => <div role="row" key={parameter.name}><div role="cell"><code>{parameter.name}</code><span>{parameter.type}{parameter.required ? ' · 必填' : ' · 可选'}</span></div><p role="cell">{parameter.description || '未提供参数说明。'}</p></div>)}
        </div> : <p className="cd-mcp-note">{catalog?.status === 'loaded' ? '没有可展开的参数说明。' : '尚未读取此工具的参数说明。'}</p>}
      </div>
    </details>)}
    {!tools.length && !loading && <p className="cd-mcp-note">{catalog?.status === 'loaded' ? '此服务当前未返回工具。' : detail.mcp?.catalogSupported ? '读取工具信息，查看此 MCP 提供的能力。' : '当前 Agent 尚未提供可读取的工具定义。'}</p>}
    {detail.manifestText && <details className="cd-mcp-config"><summary><span>原始配置<UiIcon name="chevron-right" size={13}/></span><code>{detail.manifestFile || 'JSON'}</code></summary><pre className="cd-code">{detail.manifestText}</pre></details>}
  </div>
}
