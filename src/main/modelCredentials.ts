import { createHmac, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@iarna/toml'
import { CLAUDE_SOURCE_PRESETS, type ModelSourceClient, type ReusableCredential, type CredentialSelection } from '../shared/claudeSources'
import { CODEX_SOURCE_PRESETS, isCodexSourceModelId, type CodexSourceInput } from '../shared/codexSources'
import { validateSourceInput } from './codexSourceConfig'

interface Candidate { id: string; label: string; source: CodexSourceInput }
const urlKey = (value: string): string => value.replace(/\/+$/, '')

export async function kimiCredentialCandidates(home = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')): Promise<Candidate[]> {
  const file = join(home, 'config.toml')
  try {
    if ((await stat(file)).size > 2 * 1024 * 1024) return []
    const config = parse(await readFile(file, 'utf8')) as any
    return Object.entries(config.providers || {}).flatMap(([name, raw]) => {
      const provider = raw as any
      if (!provider || provider.type !== 'kimi' || provider.oauth || provider.api_key_env || provider.custom_headers) return []
      const apiKey = provider.api_key || provider.env?.KIMI_API_KEY
      const baseUrl = provider.base_url || provider.env?.KIMI_BASE_URL
      if (typeof apiKey !== 'string' || !apiKey.trim() || typeof baseUrl !== 'string' || urlKey(baseUrl) !== CODEX_SOURCE_PRESETS['kimi-code'].baseUrl) return []
      const models = Object.values(config.models || {}).filter((model: any) => model?.provider === name && !model.base_url && !model.protocol)
        .map((model: any) => model.model).filter(isCodexSourceModelId)
      try {
        const source = validateSourceInput({ id: 'kimi', preset: 'kimi-code', enabled: true, baseUrl, apiKey,
          models: models.length ? [...new Set(models)] : [...CODEX_SOURCE_PRESETS['kimi-code'].models] })
        return [{ id: `kimi-agent:${name}`, label: `Kimi Code Agent · ${name}`, source }]
      } catch { return [] }
    })
  } catch { return [] }
}

export class ModelCredentials {
  private readonly salt = randomBytes(32)
  constructor(private readonly read: {
    codex: () => Promise<CodexSourceInput[]>
    claude: () => Promise<CodexSourceInput[]>
    deepseek: () => Promise<{ baseUrl: string; apiKey: string }>
    kimi?: () => Promise<Candidate[]>
  }) {}

  private async candidates(client: ModelSourceClient): Promise<Candidate[]> {
    if (client !== 'claude' && client !== 'codex') throw new Error('未知的 Agent')
    const other = client === 'claude' ? 'codex' : 'claude'
    const [sources, kimi, deepseek] = await Promise.all([
      this.read[other]().catch(() => []), (this.read.kimi || kimiCredentialCandidates)(), this.read.deepseek().catch(() => undefined)
    ])
    const candidates: Candidate[] = [...kimi, ...sources.map(source => ({ id: `${other}:${source.id}`, label: `${other === 'claude' ? 'Claude Code' : 'Codex'} · ${CODEX_SOURCE_PRESETS[source.preset].label}`, source }))]
    if (deepseek?.apiKey && ['https://api.deepseek.com', 'https://api.deepseek.com/anthropic'].includes(urlKey(deepseek.baseUrl))) {
      candidates.push({ id: 'deepseek-agent', label: 'DeepSeek Harness Agent', source: { ...CODEX_SOURCE_PRESETS.deepseek, preset: 'deepseek', enabled: true, apiKey: deepseek.apiKey } })
    }
    return candidates.filter(({ source }) => {
      const expected = [CODEX_SOURCE_PRESETS[source.preset]?.baseUrl, (CLAUDE_SOURCE_PRESETS as any)[source.preset]?.baseUrl]
      return !!source.apiKey && expected.includes(urlKey(source.baseUrl)) && (client === 'codex' || Object.hasOwn(CLAUDE_SOURCE_PRESETS, source.preset))
    })
  }

  private revision(candidate: Candidate): string {
    return createHmac('sha256', this.salt).update(JSON.stringify(candidate)).digest('hex')
  }

  async list(client: ModelSourceClient): Promise<ReusableCredential[]> {
    return (await this.candidates(client)).map(candidate => ({ id: candidate.id, revision: this.revision(candidate), label: candidate.label,
      preset: candidate.source.preset, models: candidate.source.models }))
  }

  async resolve(client: ModelSourceClient, selection: CredentialSelection): Promise<CodexSourceInput> {
    if (!selection || typeof selection.id !== 'string' || typeof selection.revision !== 'string') throw new Error('请选择要复用的来源')
    const candidate = (await this.candidates(client)).find(item => item.id === selection.id)
    if (!candidate || this.revision(candidate) !== selection.revision) throw new Error('原配置已变化或无法读取，请刷新后重新导入')
    const preset = client === 'claude' ? (CLAUDE_SOURCE_PRESETS as any)[candidate.source.preset] : CODEX_SOURCE_PRESETS[candidate.source.preset]
    return validateSourceInput({ ...candidate.source, baseUrl: preset.baseUrl, enabled: true })
  }

  async input(client: ModelSourceClient, input: CodexSourceInput): Promise<CodexSourceInput> {
    if (!input?.credential) return input
    const source = await this.resolve(client, input.credential)
    if (source.id !== input.id || source.preset !== input.preset || urlKey(input.baseUrl) !== source.baseUrl) throw new Error('复用密钥仅限对应厂商的官方接口；修改地址后请重新填写 API Key')
    return { ...input, apiKey: input.apiKey || source.apiKey, credential: undefined }
  }
}
