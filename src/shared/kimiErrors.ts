// Kimi detection surfaces machine-readable kimi_web_* codes. Translate them
// once so the agent list row, the installation card and the Kimi setup panel
// all show the same short Chinese copy.
export interface KimiErrorCopy { label: string; hint: string }
const copies: Record<string, KimiErrorCopy> = {
  cli_not_found: { label: '未找到 CLI', hint: '未找到官方 Kimi Code CLI，请安装后重新检测。' },
  version_unsupported: { label: '版本不兼容', hint: '当前 Kimi Code CLI 版本不受支持，请更新官方 CLI 后重新检测。' },
  server_source_unverified: { label: '本地服务未完成校验', hint: '检测到正在运行的 Kimi 服务未完成校验，请点「重试」重新检测。' },
  server_identity_invalid: { label: '本地服务未通过校验', hint: '本地 Kimi 服务未通过身份校验。请退出其它 Kimi Code 会话后点「重试」。' },
  token_unreadable: { label: '服务凭据不可读', hint: '无法安全读取 Kimi 服务凭据，请检查 ~/.kimi-code 目录权限后重新检测。' },
  official_api_unsupported: { label: '服务接口不兼容', hint: '本地 Kimi 服务接口不兼容，请更新官方 CLI 后重新检测。' },
  official_events_unsupported: { label: '服务事件不兼容', hint: '本地 Kimi 服务事件接口不兼容，请更新官方 CLI 后重新检测。' },
  startup_timeout: { label: '服务启动超时', hint: 'Kimi 服务启动超时，请稍后点「重试」。' },
  startup_port_invalid: { label: '服务启动异常', hint: 'Kimi 服务启动异常，请点「重试」重新检测。' },
  process_exited: { label: '服务意外退出', hint: 'Kimi 服务启动后立即退出，请点「重试」重新检测。' },
  spawn: { label: '服务启动失败', hint: '无法启动 Kimi 服务，请点「重试」重新检测。' },
  startup: { label: '服务启动失败', hint: 'Kimi 服务启动失败，请点「重试」重新检测。' },
  connection: { label: '连接失败', hint: '无法连接本地 Kimi 服务，请点「重试」重新检测。' },
  hello_timeout: { label: '连接超时', hint: '连接本地 Kimi 服务超时，请点「重试」重新检测。' },
  recovery_limit: { label: '自动恢复已达上限', hint: 'Kimi 服务在 5 分钟内已自动重启 2 次，会话已保留且未重发任务。请稍后重新检测。' },
  recovery_failed: { label: '自动恢复失败', hint: 'Kimi 本地服务重启后仍未通过健康检查，会话已保留且未重发任务。请检查本地 CLI 后重新检测。' },
  shutdown_incomplete: { label: '服务回收未完成', hint: '无法确认原 Kimi 服务及所属进程已退出，已停止自动重启。会话已保留，请检查本地服务。' }
}
export function kimiErrorCopy(message?: string): KimiErrorCopy | undefined {
  const kind = /^kimi_web_([a-z_]+)/.exec(message?.trim() || '')?.[1]
  return kind ? copies[kind] : undefined
}
