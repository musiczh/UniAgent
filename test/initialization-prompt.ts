import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution'
import assert from 'node:assert/strict'
import { agentInitializationPrompt } from '../src/renderer/App.tsx'

const traex = agentInitializationPrompt('traex', 'TraeX')
if (INTERNAL_DISTRIBUTION) {
assert.match(traex, /traex_install\.sh/)
assert.match(traex, /traecli login status/)
assert.match(traex, /旧版 Coco/)

} else {
  assert.doesNotMatch(traex, /traex_install|sso|bytedance/)
}

const grok = agentInitializationPrompt('grok', 'Grok')
assert.match(grok, /command -v grok/)
assert.match(grok, /grok update --check --json/)
assert.match(grok, /ACP initialize \+ session\/new/)
const kimi = agentInitializationPrompt('kimi', 'Kimi Code')
assert.match(kimi, /kimi web --no-open/)
assert.match(kimi, /已有有效配置和登录态直接复用/)
assert.match(kimi, /@moonshot-ai\/kimi-code@2\.4\.0/)
assert.match(kimi, /不安装桌面 App/)
assert.doesNotMatch(kimi, /重新探测 ACP/)

// Agents without a dedicated guide still receive the generic official-install path.
const codex = agentInitializationPrompt('codex', 'Codex')
assert.match(codex, /仅使用该 Agent 的官方安装方式；完成必要登录后执行版本、登录态和健康检查/)

for (const prompt of [traex, grok, codex]) {
  assert.match(prompt, /不要修改 UniAgent 项目代码/)
  assert.match(prompt, /重新探测/)
}

console.log('initialization prompts: all checks passed')
