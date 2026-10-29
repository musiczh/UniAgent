# UniAgent 引擎验收用例

这些是补充验收，不冒充单元测试。优先运行已有安全脚本；只有脚本无法验证的交互才由引擎操作。离线回归报告中的这些项目始终是 not-run，不代表功能失败，也不代表通过。

## 执行契约

- 输入：本文件、当前 commit、App 版本、选择的用例 ID，以及最新 release/mac-arm64/UniAgent.app。默认每项上限 180 秒；真实 Agent 每家只用一个当前可用模型、一次短回复及一次中断，不穷举模型×权限。按改动选择场景；完整验收分批做。
- 只在隔离的临时 HOME、UNIAGENT_USER_DATA、Agent homes、工作目录、Git/npm 配置下运行打包 App。使用 verifier 自行分配的回环 CDP 端口。不要复用已经运行的 App、真实会话或真实项目。
- **禁止退出或终止 /Applications/UniAgent.app。** 只能清理本次从 release/ 启动且记录了身份的子进程。异常也必须在 finally 关闭 CDP、清理进程与临时文件。
- 真实模型登录、飞书测试群、系统通知授权、联网下载必须具备明确的测试账号/授权；缺少则 blocked，禁止读取或写入生产账号来凑通过。不得安装/更新真实 CLI、发布版本或替换 /Applications。
- 每项记录 expected、actual、证据路径和耗时。证据必须来自本次执行（截图、DOM/IPC 值、fixture 前后数据、退出码），不能凭代码阅读宣布通过。脱敏，禁止保存密钥或真实聊天正文。
- 结果写入独立的 out/test-results/engine-result.json：schemaVersion=1、version、revision、startedAt、results；results 每项包含 id、status（passed/failed/blocked/not-run）、durationMs、expected、actual、evidence（路径数组）。passed 必须有实际值和证据；blocked 写清缺失条件。不得改写 offline report 为“全功能通过”。

<a id="app-shell"></a>
## app-shell — 启动、导航、设置与键盘操作

1. 首次启动空数据目录，依次打开新任务、会话、能力、定时任务、设置；返回原页。分别选择浅/深色，关闭并重启**测试 App**。
2. 用 Tab、Enter、Escape 操作下拉、弹窗和关闭；缩窄窗口，观察输入框、滚动区和浮层。
3. 验证：无白屏/renderer error；导航与焦点可达；偏好重启保留；浮层可关闭，不遮挡输入。记录 DOM、偏好文件及截图。不是重设计 UI，只按实际 UI 验收。

<a id="agent-turns"></a>
## agent-turns — 四种 Agent 基本回合

1. 对 Codex、TraeX、Claude Code、Grok，逐一记录 available/未登录/未安装。每个 available Agent 用默认可用模型在临时项目创建任务：“只回复 REGRESSION_OK，不使用工具”。
2. 验证用户消息一次、最终回复包含标记、状态从运行变为完成/空闲；检查实际原生 sessionId 和错误事件。支持流式的 Provider 应观察到递增快照，不把用户提示里的标记当作回复。
3. 再发一条短消息，在执行中中断，检查队列与 UI 可继续操作；重启测试 App 验证历史不丢、不重复。缺少任一 Provider 单独 blocked，不冒充四家都通过。
4. 可用安全入口：node test/cdp-verify-goal.mjs release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent codex（换 traex/claude 前先核对脚本支持）；Grok 用 ACP 实际能力，不假定 Codex 专有命令。

<a id="session-history"></a>
## session-history — 会话与历史

1. 用临时数据建两个空间、三条会话；搜索、切换全部/按 Agent/按空间/按需求；置顶、重命名、归档、取消归档、删除一条。
2. 导入临时原生历史并打开；在可分叉节点创建分支。对只读工具会话先尝试发送，再启用并发送。
3. 验证侧栏/正文指向同一 sessionId；分组无遗漏和重复；已读/未读不串会话；只读不能发送；分支不改原记录；重启后标题、置顶、归档一致。删除只影响目标。记录操作前后 sessions.json 和事件序列。

<a id="composer"></a>
## composer — 输入、附件、审批

1. 输入中文并用 IME 确认，验证不误发送；Enter 发送、换行、多行 Markdown 列表、草稿切换。
2. 在临时项目附加一个文本和一张图片，预览/移除后发送；不支持图片的 Agent 应明确拒绝。输入 / 选择命令、Skill/MCP。忙碌时排队两条，修改、撤回、强制发送各一次。
3. 使用 fixture 触发一次权限审批及包含单选、多选、自由文本的问题；取消再重试、一次提交所有答案。
4. 验证附件路径、native turn 参数、问题 requestId、答案值和队列顺序；审批卡默认可见、不能重复提交；IME/空白消息不误发。优先 node test/cdp-native-capabilities.mjs release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent codex。

<a id="rendering"></a>
## rendering — 富文本与阅读

1. 使用固定 fixture 渲染标题、列表、表格、代码、Mermaid、内联 HTML 预览、生成图片及错误图片。图与 HTML 必须等到实际渲染完成。
2. 折叠/展开调用链；打开大图/沉浸阅读；选中文字评论，切换会话后返回。校验 Markdown 内本地文件跳转与行号。
3. 在 fixture 中放入脚本、onerror、javascript: URL，确认没有执行、没有任意外跳；点击普通 https 链接按现有安全策略处理。SSR 的 sanitize stub 不算这一项的安全验证。
4. 验证图表非空、滚动/选区/评论不串会话、代码不被截断、无控制台异常。构建后可执行 node scripts/run-ts-test.mjs test/mermaid-bundle.ts；文件与 HTML 可复用 node test/cdp-packaged-token-filebrowser.mjs release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent。

<a id="review-files"></a>
## review-files — 文件、Diff、Review 与回退

1. 临时 Git 仓库准备新增/修改/删除/重命名文件、二进制、超大文本、目录外软链接。
2. 浏览、搜索、按行定位；查看当前回合与历史回合 Diff，打开 Review；回退前先预览，先取消再确认一次。
3. 验证历史 Diff 不读成当前文件；文本/二进制降级正确；越界访问被拒绝；取消不改文件；确认只撤销目标回合，用户另外编辑不得静默覆盖。记录 fixture 文件 hash、Diff 和回退结果。优先复用 token-filebrowser packaged verifier。

<a id="capabilities"></a>
## capabilities — 能力与同步

1. 隔离 Agent homes 各放一个 Skill、MCP 配置和可识别插件；扫描、搜索、类型筛选、详情、Codex↔TraeX 对比。
2. 对一个差异执行预览→同步；再改目标文件制造过期计划/冲突；重试、取消。插件卸载/安装只允许 fixture command runner，不安装真实插件。
3. 验证发现的数据与磁盘一致；目标只有选中能力变化；未授权路径、符号链接逃逸、过期 revision 被拒绝；失败保留原文件并明确错误，不能报成功。记录两侧文件 hash、plan/job DTO 和错误码。脚本：node test/cdp-req2-capabilities.mjs release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent。

<a id="collaboration"></a>
## collaboration — 角色、预设、交接、子 Agent 与侧聊

1. 临时创建角色与任务模板，指定 Agent/模型/权限/项目。修改保存后创建任务，核对实际启动配置；删除模板后重启确认不复活。
2. 用一个短任务触发交接，查看状态/最终回复/中止；打开子 Agent 详情，再打开侧聊、发送一次、提升为主会话。
3. 验证角色固定策略不能被调用参数绕过；父子事件、token、错误各自归属；交接的处理中与终态不重复；只停止目标；侧聊恢复和提升不丢消息、不改主会话配置。记录 taskId、sessionId、关系与原生参数。

<a id="teams-requirements"></a>
## teams-requirements — 团队与需求空间

1. 临时项目创建团队和两个成员，开启一次有回合/预算上限的圆桌；成员发言、协调、暂停/恢复/停止。
2. 创建需求、关联两个会话/空间，写入目标、进展与日志，切换需求、归档、恢复。
3. 验证团队不会在同一 session 并发发回合，停止后不继续排队；成员权限和消息去向正确。需求 ID 稳定、正文和日志边界正确、跨会话共享，删除/切换不污染其它需求；重启数据一致。
4. 现有 cdp-team-*、cdp-requirements.mjs 只有在确认隔离启动/清理后才可运行，不能直接接管正在运行的 App。记录 team 状态、需求文件和会话关联。

<a id="automation"></a>
## automation — 定时任务

1. 在临时配置创建任务，修改提示词/目录/每周执行时间，查看详情；重复快速点保存；取消编辑；删除并重启。
2. 使用受控时钟/fixture scheduler 触发一次，不等待真实一天或向真实项目下发任务。
3. 验证列表和磁盘 RRULE/时区一致，未知原生配置保留；并发保存没有重复写；删除不会复活；只触发一次、失败可见。可直接运行 node test/cdp-automation-mutation.mjs release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent（详情/编辑/删除，不等于真实调度验证）。

<a id="feishu"></a>
## feishu — 飞书双向链路

1. 仅用授权测试 Bot/群。校验保存凭证后的连接状态，测试新话题配置卡、发一条带唯一标记的消息，以及一个多问题回答。
2. 重放同一个 messageId，重连，再从 App 回传测试文本、图片和文件；普通桌面消息尝试回传飞书。
3. 验证入站只执行一次，出站回到同一话题，问题答案齐全，路径受限，非飞书来源不能冒用回传授权；中断/禁用通知后无多余发送。记录脱敏 messageId、状态和文件 hash。无测试群则 blocked。

<a id="usage-updates"></a>
## usage-updates — 用量、通知与更新

1. 用固定 token fixture 查看日/周/自定义范围，输入 1M、缓存命中 0.8M、输出 0.1M，价格 10/1/20 美元每百万，预期费用 4.8；跨天、空数据、未知价格分别检查。
2. 稀疏额度推送后周/5 小时额度应保留；达到告警阈值、过期刷新时间、上下文压缩前后显示正确。
3. 授权测试 App 的系统通知：前台/锁屏策略、点击通知定位原 session；用 mock Bits 更新源模拟无更新、新版本、超时、错误 checksum。
4. 验证失败不显示成功、不覆盖安装包、不泄漏密钥；设置持久化。真实发布/签名/下载另由维护者手动授权，禁止为了验收执行 pnpm run release。
