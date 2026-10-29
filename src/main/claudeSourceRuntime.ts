import { mkdtemp, writeFile, rm, chmod, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveUserDataHome } from './userData'
import type { ReasoningEffort, SessionConfig } from '../shared/types'
import { parseCodexModelKey } from '../shared/codexModelIdentity'
import { claudeSourceEffort, claudeSourceUsesAuthToken, type ClaudeSourcePreset } from '../shared/claudeSources'

export interface ClaudeConnection { baseUrl: string; apiKey: string; model: string; preset: ClaudeSourcePreset }
export interface ClaudeSourceRuntime {
  model: string
  settings: Record<string, unknown>
  env: NodeJS.ProcessEnv
  args: string[]
  redact: (value: string) => string
  dispose: () => Promise<void>
}
let resolveConnection: ((config: SessionConfig) => Promise<ClaudeConnection>) | undefined
const active = new Set<ClaudeSourceRuntime>()
const runtimeRoot = (): string => join(resolveUserDataHome(), 'claude-sources', 'runtime')

export async function cleanupStaleClaudeRuntimes(): Promise<void> {
  let directories: string[]
  try { directories = await readdir(runtimeRoot()) } catch { return }
  for (const directory of directories) {
    const match = /^(\d+)-[a-zA-Z0-9]+$/.exec(directory)
    if (!match) continue
    try { process.kill(Number(match[1]), 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(join(runtimeRoot(), directory), { recursive: true, force: true }) }
  }
}

export async function closeClaudeSourceRuntimes(): Promise<void> {
  await Promise.all([...active].map(runtime => runtime.dispose()))
}

export function configureClaudeSourceRuntime(resolve: typeof resolveConnection): void { resolveConnection = resolve }

export function isClaudeThirdParty(config: SessionConfig): boolean {
  return config.agentId === 'claude' && (config.modelSource?.kind === 'third-party' || !!(config.model && parseCodexModelKey(config.model)))
}

export async function prepareClaudeSourceRuntime(config: SessionConfig): Promise<ClaudeSourceRuntime | undefined> {
  if (!isClaudeThirdParty(config)) return undefined
  if (!resolveConnection) throw new Error('Claude 第三方来源尚未就绪')
  return createClaudeSourceRuntime(await resolveConnection(config), config.effort)
}

export async function createClaudeSourceRuntime(connection: ClaudeConnection, effort?: ReasoningEffort): Promise<ClaudeSourceRuntime> {
  const { model, apiKey, baseUrl, preset } = connection
  const support = claudeSourceEffort(model, preset)
  const bearer = claudeSourceUsesAuthToken(preset)
  const resolved = effort && support.efforts.includes(effort) ? effort : support.defaultEffort ?? 'auto'
  // MiMo 的 "off" 是思考开关而非档位：CLI 的 CLAUDE_CODE_EFFORT_LEVEL 没有 off 值，
  // 且对第三方端点恒发 adaptive thinking，只能用 EXTRA_BODY 覆盖请求体来关闭思考。
  const thinkingOff = resolved === 'off'
  // CLI settings.env overrides project/user env as well as inherited process env.
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: bearer ? '' : apiKey,
    ANTHROPIC_AUTH_TOKEN: bearer ? apiKey : '',
    CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '', ANTHROPIC_CUSTOM_HEADERS: '',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: thinkingOff ? 'auto' : resolved,
    ...(thinkingOff ? { CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ thinking: { type: 'disabled' } }) } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  }
  for (const alias of ['OPUS', 'SONNET', 'HAIKU', 'FABLE']) env[`ANTHROPIC_DEFAULT_${alias}_MODEL`] = model
  const settings = { env, apiKeyHelper: '', model }
  const root = runtimeRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const directory = await mkdtemp(join(root, `${process.pid}-`))
  try {
    await chmod(directory, 0o700)
    const file = join(directory, 'settings.json')
    await writeFile(file, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
    const runtime: ClaudeSourceRuntime = { model, settings, env, args: ['--settings', file],
      redact: value => value.split(apiKey).join('[API Key]').split(JSON.stringify(apiKey).slice(1, -1)).join('[API Key]'),
      dispose: async () => { await rm(directory, { recursive: true, force: true }); active.delete(runtime) } }
    active.add(runtime)
    return runtime
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}
