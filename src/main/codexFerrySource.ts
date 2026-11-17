import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectModelCache } from './agents'
import { ferryHome } from './claudeFerrySource'
import { fetchSourceModelCatalog } from './codexSourceModels'
import { resolveUserDataHome } from './userData'
import { codexModelKey } from '../shared/codexModelIdentity'
import type { ModelDef } from '../shared/types'

const source = { kind: 'third-party' as const, sourceId: 'ferry' }

/** An external Ferry installation owns discovery and authentication. */
export class CodexFerrySource {
  models: ModelDef[] = []
  private baseUrl?: string
  private flight?: Promise<void>
  private catalog = ''
  private readonly directory = join(resolveUserDataHome(), 'codex-ferry')
  private catalogFile?: string

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
      const baseUrl = `http://127.0.0.1:${port}/v1`
      // Ferry returns Claude's `data` catalog for all other User-Agents.
      const raw = await fetchSourceModelCatalog(baseUrl, 'ferry', 1500, 'uniagent_codex/1.0.0') as any
      if (!Array.isArray(raw?.models)) throw new Error('Ferry Codex 模型目录格式无效')
      const entries = new Map<string, any>()
      for (const entry of raw.models) {
        if (typeof entry?.slug !== 'string' || !/^ferry-[A-Za-z0-9._:-]+$/.test(entry.slug) || entry.slug.length > 120 ||
            entry.hidden === true || entry.visibility && entry.visibility !== 'list') continue
        entries.set(entry.slug, entry)
      }
      const catalog = JSON.stringify({ models: [...entries.values()] })
      const models = projectModelCache([...entries.values()]).map(model => ({
        ...model, id: codexModelKey(model.id, source),
        label: model.label.startsWith('Ferry ') ? model.label : `Ferry ${model.label}`,
        contextWindow: Number.isSafeInteger(model.contextWindow) && model.contextWindow! > 0 ? model.contextWindow : undefined,
        imageInput: entries.get(model.id).input_modalities?.includes('image') === true,
        supportsFast: false, supportsMax: false, maxContextWindow: undefined, modelSource: source
      }))
      if (catalog !== this.catalog) {
        // Separate discoveries may share application data. Unique temporary
        // files avoid rename races; immutable catalogs preserve running turns.
        const catalogFile = join(this.directory, `catalog-${createHash('sha256').update(catalog).digest('hex')}.json`)
        const temporary = `${catalogFile}.${randomUUID()}.tmp`
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        try {
          await writeFile(temporary, catalog, { mode: 0o600, flag: 'wx' })
          await rename(temporary, catalogFile)
        } finally { await rm(temporary, { force: true }) }
        this.catalogFile = catalogFile
        this.catalog = catalog
      }
      this.models = models
      this.baseUrl = baseUrl
    } catch {
      // Preserve a saved selection during a transient failure, but never route
      // it through native Codex or another provider while Ferry is unavailable.
      this.baseUrl = undefined
    }
  }

  assertReady(model: string): void {
    if (!this.baseUrl || !this.catalogFile || !this.models.some(value => value.id === codexModelKey(model, source))) {
      throw new Error('Ferry 模型不可用，请确认本机 Ferry 已启动并刷新 Codex 状态')
    }
  }

  runtimeArgs(model: string): string[] {
    this.assertReady(model)
    const provider = 'uniagent-ferry'
    return [
      '-c', `model=${JSON.stringify(model)}`,
      '-c', `review_model=${JSON.stringify(model)}`,
      '-c', `model_provider=${JSON.stringify(provider)}`,
      '-c', `model_providers.${provider}.name="Ferry"`,
      '-c', `model_providers.${provider}.base_url=${JSON.stringify(this.baseUrl)}`,
      '-c', `model_providers.${provider}.wire_api="responses"`,
      '-c', `model_providers.${provider}.requires_openai_auth=false`,
      '-c', `model_providers.${provider}.experimental_bearer_token="ferry"`,
      '-c', `model_providers.${provider}.supports_websockets=false`,
      '-c', `model_providers.${provider}.supports_standalone_web_search=true`,
      '-c', `model_providers.${provider}.http_headers.x-openai-actor-authorization="ferry"`,
      '-c', `model_catalog_json=${JSON.stringify(this.catalogFile)}`,
      '-c', 'features.enable_request_compression=false'
    ]
  }
}
