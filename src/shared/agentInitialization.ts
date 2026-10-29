const INITIALIZATION_GUIDES: Record<string, string> = {
  zcode:
    '\nUniAgent 设置 → Agent → ZCode 提供程序一键安装；本任务是备选。先检查 PATH 的完整 zcode CLI、官方 App、已登记运行时及资源与 app-server 协议；可用时直接复用，不重复源码构建。'  +
    '\n官方源码：https://github.com/zai-org/ZCode.git；当前验证提交 3c5b227649371507ddc4eb46ac5133afe6db1cab，Node 24.14.0、pnpm 10.33.2。不要安装 npm 同名 zcode/zcode-cli 包。' +
    '\n1. 只读检查 Git、系统架构，以及 UniAgent 用户数据目录 zcode/runtime.json 和 zcode/runtime 下的安装。仅检查路径、版本和权限，不输出 Provider 文件或任何凭据。' +
    '\n2. 优先修复并重试 UniAgent 一键安装。确需手动准备时，在用户私有目录固定提交检出官方源码，用专用 Node 和 pnpm 从仓库根运行 pnpm install --filter @zcode/cli... --frozen-lockfile，再运行 pnpm --filter @zcode/cli... build。不得修改全局 Node、shell 配置或其它 CLI。' +
    '\n3. 保留完整源码构建目录、node_modules 和 dist 资源，不能只复制 zcode.cjs。检查 --version、--help 和隔离 app-server --stdio 的 storage ready、runtime/capabilities 与 session/list。' +
    '\n4. 保留原运行时、会话和 Provider 配置。需要登记运行时时，用 UniAgent 的运行时配置接口或兼容的 runtime.json；必须先校验路径，不能覆盖并发变更或活动会话。' +
    '\n5. API Key 只在 UniAgent ZCode 授权配置页面输入，不要要求在对话中粘贴，不读取或写入密钥。回到设置页重新检测，以引擎校验和模型配置检测分别确认结果。',
  deepseek: '\n官方资料：https://github.com/deepseek-ai/deepseek-harness。UniAgent 使用固定版本的独立 Host，程序、会话与连接单独管理。先只读检查 UniAgent 已有受管运行时、版本与失败阶段；保留已有程序、账号与数据，不用全局安装 dsh 代替受管 Host。优先回到设置 → Agent → DeepSeek Harness 重试一键安装；网络或权限阻塞时说明具体阶段。API Key 仅在专用设置表单输入，不读取、输出或在对话中收集凭据。',
  kimi:
    '\n目标：复用本机官方 Kimi Code CLI 的 kimi web REST／WebSocket API，不安装桌面 App，不使用 ACP，也不以云端推理 API 替代本机 Agent 服务。' +
    '\nUniAgent 设置 → Agent → Kimi Code 提供“一键安装”；此提示词是备用方式。先检查 PATH、~/.local/bin/kimi 和历史 .uniagent/runtimes/kimi-code/2.4.0/kimi 是否已有可复用的安装，避免重复安装。' +
    '\n官方说明：https://www.kimi.com/code/docs/kimi-code-cli/guides/getting-started.html' +
    '\n1. 只读检查系统、CPU、Node 版本、PATH、command -v kimi、入口真实路径、安装来源和 kimi --version。PATH 未命中时先定位已有官方安装，不重复安装。不要读取或回显 token、密码、模型 Key、OAuth 文件正文。' +
    '\n2. 当前 UniAgent 已验证官方 npm @moonshot-ai/kimi-code 2.4.0，要求 Node ≥ 22.19.0。仅在缺失时执行 npm install -g @moonshot-ai/kimi-code@2.4.0；先核对官方说明。已有其它版本时报告版本和兼容性，不擅自降级、覆盖、卸载或复制另一份 CLI。不要安装旧 Python kimi-cli。' +
    '\n3. 已有有效配置和登录态直接复用；只有登录未就绪时才引导 kimi login（不支持 --json），授权需要我参与时等待我完成。已有第三方模型配置不要强制改成 Kimi OAuth，不要求第二份 Key。' +
    '\n4. 保留原数据、Skills 和 MCP 配置，不修改 shell 别名、用户模型配置或 UniAgent 工程；不复制凭据，不打开 kimi web 页面，不让我手动管理端口，不启动或关闭已有服务。' +
    '\n5. 安装后复查入口和版本，提醒我回 UniAgent 点击“重新检测”。UniAgent 会自动连接或启动 kimi web --no-open，检查服务鉴权、OpenAPI／AsyncAPI、账号摘要和模型目录。安装命令成功、存在凭据文件或安装任务完成都不代表模型已可用；不要自行发送消耗额度的测试任务。' +
    '\n6. 遇到网络、权限或版本阻塞保留已完成步骤，报告唯一下一步，不删除重装。',
  grok:
    '\n官方资料：https://grok.com' +
    '\n按顺序执行：' +
    '\n1. 检查 PATH、command -v grok 和 grok --version；已有且健康时不要重复安装。' +
    '\n2. 若未安装，只使用 Grok CLI 官方安装说明；不要从未知脚本或镜像安装。' +
    '\n3. 刷新 PATH 后运行 grok login；浏览器授权需要我参与时，给出明确步骤并等待，任何 token 或凭据都不得回显。' +
    '\n4. 使用 grok update --check --json 检查版本，再通过最小 ACP initialize + session/new 验证 UniAgent 兼容性；不要发送消耗额度的测试 prompt。',
  mcode:
    '\n官方资料：https://agent.minimaxi.com/docs/cli/reference' +
    '\nMiniMax Code 的 CLI 命令名是 mcode，官方 npm 包为 @minimax-ai/code。' +
    '\n按顺序执行：' +
    '\n1. 检查 command -v mcode、mcode --version 与 node 版本；已有且健康时不要重复安装。' +
    '\n2. UniAgent 提供一键安装；本提示词是备选。缺失时按官方安装说明 https://github.com/MiniMax-AI/minimax-code#quick-start 准备本机可共用的程序，不安装到 UniAgent 私有目录。不要从未知脚本或镜像安装，不重复安装或降级已有程序。' +
    '\n3. 优先复用已有登录和 Provider；已可用则跳过。缺少连接时使用 mcode login --region cn（或 global）走官方浏览器授权，或提醒用户在 UniAgent 专用表单填写 API Key；不在对话中收集或回显密钥。保留原生数据目录、已有配置与会话。' +
    '\n4. 用 mcode provider list --json 确认凭据已生效，再用最小 ACP initialize + session/new 验证 UniAgent 兼容性；不要发送消耗额度的测试 prompt。' +
    '\n注意：mcode acp 不接受 --cwd / --permission 等参数，工作目录来自进程 cwd，权限档位通过会话的 set_config_option 下发。'
}

export function agentInitializationPrompt(targetAgentId: string, targetName: string): string {
  const guide = INITIALIZATION_GUIDES[targetAgentId]
  return '请直接在本机完成 ' + targetName + ' 的安装或配置，不要只复述教程或把可执行步骤留给我。先做只读检查，已满足的步骤跳过；不要修改 UniAgent 项目代码。' +
    '\n\n我已授权执行下方官方教程明确列出的联网下载、用户目录写入和 npm 全局安装，无需为这些动作重复询问。若操作需要 sudo/管理员权限、删除或覆盖现有非托管安装、改变其它 CLI 的别名，或写入密码/API key 等敏感凭据，必须先说明具体命令和影响并等待确认。浏览器、二维码或 SSO 授权需要我参与时，给出清晰步骤并在我完成后继续；任何凭据都不得回显。' +
    (guide || '\n检查系统、CPU 架构、PATH 与现有安装来源，仅使用该 Agent 的官方安装方式；完成必要登录后执行版本、登录态和健康检查。') +
    '\n\n所有检查通过后总结实际执行内容与版本，并提醒我回到 UniAgent 设置页点击“重新探测”。若受权限、网络或版本兼容阻塞，保留已完成步骤，只报告唯一的下一步。'
}
