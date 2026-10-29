import { readdirSync } from 'node:fs'

// Every top-level test is discovered, including old assert scripts without .test.
// Helpers / real-account drivers stay explicitly outside the offline release gate.
const excluded = {
  'beta-side-runner.ts': 'Retired beta extension path; stable ACP negative coverage is in acp-stability.ts and cdp-acp-stability.mjs',
  'deepseek-runner-extensions.ts': 'Retired beta extension path; stable ACP negative coverage is in acp-stability.ts and cdp-acp-stability.mjs',
  'deepseek-steer-attachments.ts': 'Retired beta extension path; stable ACP negative coverage is in acp-stability.ts and cdp-acp-stability.mjs',
  'grok-role-handoff.ts': 'Retired beta extension path; stable ACP negative coverage is in acp-stability.ts and cdp-acp-stability.mjs',
  'deepseek-bridge.ts': 'Retired SDK bridge; verify stable ACP with test:deepseek:native',
  'deepseek-controls.ts': 'Retired SDK controls; verify stable ACP with test:deepseek:native',
  'deepseek-role.ts': 'Retired SDK roles; verify stable ACP with test:deepseek:native',
  'deepseek-role-native.ts': 'Retired SDK roles; verify stable ACP with test:deepseek:native',
  'kimi-web-native.ts': 'Explicit installed CLI integration; requires UNIAGENT_KIMI_WEB_NATIVE_TEST=1 and isolated local model fixture',
  'kimi-installation-native.ts': 'Explicit isolated official binary download qualification; requires UNIAGENT_KIMI_INSTALL_NATIVE_TEST=1',
  'grok-goal-native.ts': 'Real Grok 1.0.62 with isolated HOME and local model fixture; requires UNIAGENT_GROK_NATIVE_TEST=1',
  'grok-native-cli.ts': 'Real Grok 1.0.62 with isolated HOME and local model fixture; requires UNIAGENT_GROK_NATIVE_TEST=1',
  'acceptance-process-sweeper.mjs': 'Shared packaged-app process cleanup helper, not a test',
  'headless.ts': 'Real CLI/model matrix; requires credentials and spends tokens',
  'headless-edge.ts': 'Real CLI/model matrix; requires credentials and spends tokens',
  'team-question-runtime.ts': 'Real Codex/model driver; requires credentials and spends tokens',
  'verify-clicks.mjs': 'Legacy driver attaches to an already running app',
  'mermaid-bundle.ts': 'Checks built renderer output; run after pack, not against stale out/'
}

export function discoverTests(directory = new URL('../', import.meta.url)) {
  return readdirSync(directory).filter(name => /\.(mjs|tsx?)$/.test(name)).sort().map(name => ({
    file: 'test/' + name,
    reason: excluded[name] || (/^(cdp-|repro-)/.test(name) ? 'Packaged/live UI driver; opt-in acceptance only' : undefined)
  }))
}

export const engineCases = [
  ['app-shell', '启动、导航、设置与键盘操作'],
  ['agent-turns', '四种 Agent：创建、流式回复、中断、继续与恢复'],
  ['session-history', '会话搜索、分组、归档、重命名、历史导入与分叉'],
  ['composer', '输入、附件、斜杠命令、审批与多问题回答'],
  ['rendering', 'Markdown、代码、Mermaid、HTML、图片、评论与沉浸阅读'],
  ['review-files', '文件浏览、Diff、Review 与回退'],
  ['capabilities', 'Skills / MCP / 插件发现、同步与冲突恢复'],
  ['collaboration', '角色、预设、交接、子 Agent 与侧聊'],
  ['teams-requirements', '团队圆桌与需求空间'],
  ['automation', '定时任务创建、修改、删除与触发'],
  ['feishu', '飞书配置、双向消息、问题卡片与文件回传'],
  ['usage-updates', 'Token / 费用 / 额度、通知与版本更新']
].map(([id, title]) => ({ id, title, status: 'not-run', specification: 'docs/testing/engine-cases.md#' + id }))
