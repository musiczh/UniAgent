# UniAgent Public

macOS 多 Agent 桌面工作台。支持 Codex、Claude Code、Grok、Kimi Code、DeepSeek Harness、MiniMax Code 和 ZCode，保留各家原生协议、账号和能力。

官网：https://musiczh.github.io/UniAgent/

下载：https://github.com/musiczh/UniAgent/releases/latest

将 `UniAgent Public.app` 拖入 Applications，可与内网 `UniAgent.app` 同时安装。应用 ID、UniAgent 会话与设置、缓存和更新源彼此独立。本机原生 Agent 程序、配置、历史、Skills 和登录态继续共用；修改原生配置会同时影响两版。UniAgent 托管服务的连接配置、运行状态与输入账本仍各自保存。

## 开发

需要 Node.js 20+、pnpm 9+、Xcode Command Line Tools。

```bash
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm dev
pnpm test
pnpm run pack
```

会话、工具与插件、团队、飞书助手、定时任务、评论和本机用量沿用同一套公共实现。各 Agent 的安装、登录与模型计费由对应官方服务提供；API Key 只在专用设置表单输入。

公开源码由维护者的统一研发主线生成。外部贡献请提交 PR，维护者回流主线后同步，避免生成结果覆盖贡献。

MIT License；第三方通知见应用内许可证资源。
