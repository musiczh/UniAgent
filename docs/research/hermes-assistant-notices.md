# Hermes 个人助手参考与许可

参考仓库：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/c0ef5af5205dbdc25e9e44acd66873b4bb3503c9)，固定提交 `c0ef5af5205dbdc25e9e44acd66873b4bb3503c9`。

本实现以 TypeScript 重写，未集成或启动 Hermes 运行时。参考：

- `tools/memory_tool.py`：单一工具的 add/replace/remove/batch、文档职责、操作范围。
- `tools/memory_tool_store.py`：字符预算、精确替换、重复处理及辅助内容检测。
- `agent/background_review.py`：USER/MEMORY 路由和 `Nothing to save.` 复盘提示。
- `tools/session_search_tool.py`：browse/discover/read/scroll 检索形态。
- `gateway/slash_commands_session.py`：new/clear 对话边界。
- `agent/prompt_builder.py`：助手执行、结果核实、记忆与历史召回提示。
- `agent/system_prompt.py`：固定行为与每轮记忆/环境分层注入，SOUL 不替代系统规则。

提示词为中文行为改写；UniAgent 增加 SQLite revision、后台暂存提交和宿主 capability 校验。Hermes 当前后台对 replace/remove 有独立待审批门禁；UniAgent 按用户授权的自动管理需求允许暂存这些操作，用户编辑优先并可回滚，不声称与 Hermes 门禁完全相同。下面保留来源完整 MIT notice。

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
