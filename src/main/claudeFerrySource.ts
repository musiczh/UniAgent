import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetchSourceModelCatalog } from './codexSourceModels'
import { codexModelKey } from '../shared/codexModelIdentity'
import type { ModelDef, ReasoningEffort } from '../shared/types'
import type { ClaudeConnection } from './claudeSourceRuntime'

export function ferryHome(): string {
  if (process.env.FERRY_HOME) return process.env.FERRY_HOME
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ferry')
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ferry')
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ferry')
}

export function projectClaudeFerryModels(raw: any): ModelDef[] {
  if (!Array.isArray(raw?.data)) throw new Error('Ferry 模型目录格式无效')
  const models = new Map<string, ModelDef>()
  for (const entry of raw.data) {
    if (typeof entry?.id !== 'string' || !/^claude-[A-Za-z0-9._:-]+(?:\[1m\])?$/.test(entry.id) || entry.id.length > 120) continue
    const capabilities = entry.capabilities
    const efforts: ReasoningEffort[] = capabilities?.effort?.supported === true
      ? (['low', 'medium', 'high', 'xhigh', 'max'] as ReasoningEffort[]).filter(effort => capabilities.effort[effort]?.supported === true)
      : []
    const name = typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim() : entry.id
    const source = { kind: 'third-party' as const, sourceId: 'ferry' }
    const id = codexModelKey(entry.id, source)
    models.set(id, {
      id, label: name.startsWith('Ferry ') ? name : `Ferry ${name}`, efforts,
      defaultEffort: efforts.includes('high') ? 'high' : efforts[0],
      contextWindow: Number.isSafeInteger(entry.max_input_tokens) && entry.max_input_tokens > 0 ? entry.max_input_tokens : undefined,
      imageInput: capabilities?.image_input?.supported === true,
      supportsFast: false, supportsMax: false, modelSource: source
    })
  }
  return [...models.values()]
}

/** Read the running gateway's catalog; never rewrites Claude's native settings or starts Ferry. */
export class ClaudeFerrySource {
  models: ModelDef[] = []
  private baseUrl?: string
  private flight?: Promise<void>

  constructor(private readonly home = ferryHome()) {}

  refresh(): Promise<void> {
    return this.flight ??= this.load().finally(() => { this.flight = undefined })
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(join(this.home, 'runtime.json'), 'utf8')
      if (text.length > 65536) throw new Error('Ferry 运行状态过大')
      const { port } = JSON.parse(text)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ferry 端口无效')
      const baseUrl = `http://127.0.0.1:${port}`
      const models = projectClaudeFerryModels(await fetchSourceModelCatalog(`${baseUrl}/v1`, 'ferry', 1500))
      this.models = models
      this.baseUrl = baseUrl
    } catch {
      // Retain previously discovered rows so a transient failure does not erase a saved selection.
      this.baseUrl = undefined
    }
  }

  assertReady(model: string): void {
    if (!this.baseUrl || !this.models.some(value => value.id === codexModelKey(model, { kind: 'third-party', sourceId: 'ferry' }))) {
      throw new Error('Ferry 模型不可用，请确认本机 Ferry 已启动并刷新 Claude 状态')
    }
  }

  async connection(model: string): Promise<ClaudeConnection> {
    await this.refresh()
    this.assertReady(model)
    const selected = this.models.find(value => value.id === codexModelKey(model, { kind: 'third-party', sourceId: 'ferry' }))!
    return { preset: 'ferry', baseUrl: this.baseUrl!, apiKey: 'ferry', model,
      efforts: selected.efforts, defaultEffort: selected.defaultEffort }
  }
}
