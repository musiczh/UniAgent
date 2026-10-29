function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}
function rows(value: unknown): Record<string, any>[] { return Array.isArray(value) ? value.map(record) : [] }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function tokens(value: unknown): string { const n = number(value); return n === undefined ? '—' : Math.round(n).toLocaleString('en-US') }
function text(value: unknown): string { return String(value ?? '').replace(/[|\r\n]/g, ' ').trim() }

export function claudeContextOccupancy(report: unknown): { contextTokens: number; contextWindow?: number } | undefined {
  const value = record(report)
  const used = number(value.totalTokens ?? value.total_tokens)
  const window = number(value.rawMaxTokens ?? value.raw_max_tokens)
  return used === undefined ? undefined : { contextTokens: used, ...(window && window > 0 ? { contextWindow: window } : {}) }
}

export function formatClaudeNativeReport(kind: string, report: unknown): string {
  const value = record(report)
  if (kind === 'context_usage') {
    const occupancy = claudeContextOccupancy(value)
    const percentage = number(value.percentage)
    const lines = ['**Claude 上下文**', '',
      `${text(value.model) || '当前模型'} · 已用 ${tokens(occupancy?.contextTokens)} / ${tokens(occupancy?.contextWindow)} token${percentage === undefined ? '' : ` · ${percentage}%`}`]
    const categories = rows(value.categories)
    if (categories.length) lines.push('', '| 类别 | Token | 状态 |', '| --- | ---: | --- |', ...categories.map((row) => `| ${text(row.name)} | ${tokens(row.tokens)} | ${text(row.kind)} |`))
    const details = [
      ['MCP 工具', rows(value.mcpTools ?? value.mcp_tools).map((row) => `${text(row.serverName ?? row.server_name)} / ${text(row.name)} · ${tokens(row.tokens)} token`)],
      ['记忆文件', rows(value.memoryFiles ?? value.memory_files).map((row) => `${text(row.path)} · ${tokens(row.tokens)} token`)],
      ['子代理', rows(value.agents).map((row) => `${text(row.agentType ?? row.agent_type)} · ${tokens(row.tokens)} token`)],
      ['技能', rows(value.skills).map((row) => `${text(row.name ?? record(row.skillFrontmatter).name)} · ${tokens(row.tokens)} token`)]
    ] as Array<[string, string[]]>
    for (const [label, values] of details) if (values.length) lines.push('', `**${label}**`, '', ...values.map((line) => `- ${line}`))
    return lines.join('\n')
  }
  const session = record(value.session)
  const cost = number(session.total_cost_usd)
  const lines = ['**Claude 会话用量**', '',
    `会话累计费用 ${cost === undefined ? '—' : `$${cost.toFixed(4)}`} · API 用时 ${tokens(number(session.total_api_duration_ms) === undefined ? undefined : session.total_api_duration_ms / 1000)} 秒`,
    `文件改动 +${tokens(session.total_lines_added)} / −${tokens(session.total_lines_removed)}`]
  const modelUsage = Object.entries(record(session.model_usage))
  if (modelUsage.length) lines.push('', '| 模型 | 输入 | 输出 | 缓存读取 | 费用 |', '| --- | ---: | ---: | ---: | ---: |',
    ...modelUsage.map(([name, raw]) => {
      const row = record(raw), amount = number(row.costUSD)
      return `| ${text(name)} | ${tokens(row.inputTokens)} | ${tokens(row.outputTokens)} | ${tokens(row.cacheReadInputTokens)} | ${amount === undefined ? '—' : `$${amount.toFixed(4)}`} |`
    }))
  const rates = record(value.rate_limits)
  const limits = Array.isArray(rates.limits) ? rows(rates.limits).map((row) => ({ label: row.scope?.model?.display_name || row.kind, used: row.percent, reset: row.resets_at }))
    : Object.entries(rates).filter(([name, raw]) => name !== 'model_scoped' && number(record(raw).utilization) !== undefined)
      .map(([name, raw]) => ({ label: name, used: record(raw).utilization, reset: record(raw).resets_at }))
  for (const row of rows(rates.model_scoped)) limits.push({ label: row.display_name, used: row.utilization, reset: row.resets_at })
  if (limits.length) lines.push('', '**订阅额度**', '', ...limits.map((row) => `- ${text(row.label)} · 已用 ${number(row.used) ?? '—'}%${row.reset ? ` · 重置 ${text(row.reset)}` : ''}`))
  else lines.push('', 'Claude 未返回订阅额度。')
  const extra = record(value.extra_usage ?? rates.extra_usage)
  if (extra.is_enabled === true) lines.push('', `额外用量 · 已用 ${tokens(extra.used_credits)} / ${tokens(extra.monthly_limit)} ${text(extra.currency) || 'credits'}${number(extra.utilization) === undefined ? '' : ` · ${extra.utilization}%`}`)
  return lines.join('\n')
}
