import { readFileSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'

/**
 * MiniMax Code runtime configuration access.
 *
 * MiniMax Code keeps its own model catalog and the per-model context window
 * in `$MINIMAX_DATA_DIR/config.yaml` (the same file the native app and CLI
 * read and write). The ACP surface exposes neither, so UniAgent reads the
 * catalog to learn what a model can do and writes the context window through
 * the very same key the native app uses.
 *
 * Nothing here is MiniMax-specific guesswork: every field mirrors the
 * native catalog schema (`limit.context`, `contextWindowOptions`,
 * `thinking_config.mode`, `thinking.effortOptions`, `variants`).
 */

export interface MCodeModelMeta {
  /** Catalog model id, e.g. `MiniMax-M3.1-Flash`. */
  modelId: string
  /** Native display name, e.g. `M3.1-Flash（订阅限免）`. */
  displayName?: string
  /** `limit.context` — the default context window. */
  defaultContextWindow?: number
  /** `contextWindowOptions` — every window the model accepts. */
  contextWindowOptions?: number[]
  /** Effective window: the stored override when present, else the default. */
  contextWindow?: number
  /** Largest window above the default, when the model offers one. */
  maxContextWindow?: number
  /** Whether the model offers more than one context window. */
  supportsMax: boolean
  /** `thinking_config.mode`: `switchable` models expose a thinking toggle. */
  thinkingMode?: 'switchable' | 'forced_on'
  /** `thinking.effortOptions` — reasoning levels the model accepts. */
  effortOptions?: string[]
  /** `thinking.defaultEffort`. */
  defaultEffort?: string
  /** `variants` keys, e.g. `none-thinking` / `thinking`. */
  variants?: string[]
}

export interface MCodeCatalog {
  models: Map<string, MCodeModelMeta>
  /** Where the credential comes from; decides which config key holds the window. */
  credentialSource: 'api' | 'managed'
  configPath: string
}

/** Match the native data directory; never redirect sessions into UniAgent's private runtime. */
export function mcodeDataDir(): string {
  const explicit = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim()
  if (explicit) return resolve(explicit)
  const profile = process.env.MAVIS_PROFILE?.trim()
  if (profile && !/^[A-Za-z0-9._-]+$/.test(profile)) throw new Error('MiniMax Code Profile 无效')
  return join(process.env.HOME || homedir(), profile ? `.minimax-${profile}` : '.minimax')
}

export function mcodeConfigPath(): string {
  return join(mcodeDataDir(), 'config.yaml')
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function positiveIntList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.map(positiveInt).filter((item): item is number => item !== undefined)
  return list.length ? list : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return list.length ? list : undefined
}

/** Read the native catalog. Returns undefined when the runtime has no catalog yet. */
export function readMCodeCatalogSync(configPath = mcodeConfigPath()): MCodeCatalog | undefined {
  let raw: string
  try { raw = readFileSync(configPath, 'utf8') } catch { return undefined }
  return parseMCodeCatalog(raw, configPath)
}

export function parseMCodeCatalog(raw: string, configPath = mcodeConfigPath()): MCodeCatalog | undefined {
  let doc: any
  try { doc = parseYaml(raw) } catch { return undefined }
  const root = asRecord(doc)
  if (!root) return undefined
  const provider = asRecord(root.provider)
  const minimax = asRecord(provider?.minimax)
  const models = asRecord(minimax?.models)
  const api = asRecord(root.minimax_api)
  const apiLimits = asRecord(api?.modelContextLimits)
  const managedLimits = asRecord(root.minimaxModelContextLimits)
  const credentialSource: 'api' | 'managed' = root.minimaxModelSource === 'minimax_api_key' ? 'api' : 'managed'
  const result = new Map<string, MCodeModelMeta>()
  for (const [modelId, value] of Object.entries(models || {})) {
    const model = asRecord(value)
    if (!model) continue
    const defaultContextWindow = positiveInt(model.limit?.context)
    const contextWindowOptions = positiveIntList(model.contextWindowOptions)
    const override = positiveInt((credentialSource === 'api' ? apiLimits : managedLimits)?.[modelId])
    const effective = override && contextWindowOptions?.includes(override) ? override : defaultContextWindow
    const larger = (contextWindowOptions || []).filter((option) => defaultContextWindow === undefined || option > defaultContextWindow)
    const thinking = asRecord(model.thinking)
    const thinkingConfig = asRecord(model.thinking_config)
    const mode = thinkingConfig?.mode === 'forced_on' ? 'forced_on' : thinkingConfig?.mode === 'switchable' ? 'switchable' : undefined
    result.set(modelId, {
      modelId,
      displayName: typeof model.name === 'string' ? model.name : undefined,
      defaultContextWindow,
      contextWindowOptions,
      contextWindow: effective,
      maxContextWindow: larger.length ? Math.max(...larger) : undefined,
      supportsMax: !!contextWindowOptions && contextWindowOptions.length > 1,
      thinkingMode: mode,
      effortOptions: stringList(thinking?.effortOptions),
      defaultEffort: typeof thinking?.defaultEffort === 'string' ? thinking.defaultEffort : undefined,
      variants: Object.keys(asRecord(model.variants) || {})
    })
  }
  return { models: result, credentialSource, configPath }
}

/** The window the catalog currently applies to a model, including the stored override. */
export function mcodeContextLimit(catalog: MCodeCatalog | undefined, modelId: string): number | undefined {
  return catalog?.models.get(modelId)?.contextWindow
}

// ---------------------------------------------------------------------------
// Writing the context window back into the native configuration.
//
// The native CLI and the desktop app both persist this as a plain YAML
// mapping, so UniAgent patches the file in place instead of re-serialising
// it: a full dump would rewrite the user's formatting, comments and anchors.
// ---------------------------------------------------------------------------

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function yamlKeyMatches(raw: string, key: string): boolean {
  return raw.replace(/^['"]|['"]$/g, '') === key
}

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : `'${key.replace(/'/g, "''")}'`
}

/** End of the block owned by the key at `start` (blank lines included). */
function blockEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start])
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }
    if (indentOf(line) <= base) break
    index++
  }
  return index
}

function findKeyLine(lines: string[], from: number, to: number, indent: number, key: string): number {
  for (let index = from; index < to; index++) {
    const line = lines[index]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (indentOf(line) !== indent) continue
    const match = /^([^\s:][^:]*):\s*(.*)$/.exec(line.trim())
    if (match && yamlKeyMatches(match[1], key)) return index
  }
  return -1
}

/**
 * Set `path` to `value` inside a YAML document, creating the missing levels.
 * Returns undefined when the document shape cannot be patched safely.
 */
export function upsertYamlNumber(text: string, path: string[], value: number): string | undefined {
  const lines = text.split('\n')
  let from = 0
  let to = lines.length
  let indent = 0
  for (let depth = 0; depth < path.length; depth++) {
    const key = path[depth]
    const index = findKeyLine(lines, from, to, indent, key)
    if (index < 0) {
      // The key is missing: create it (and the rest of the path) inside the
      // current block. `indent` is already the indent of that block's children.
      const created: string[] = []
      for (let rest = depth; rest < path.length; rest++) {
        const keyIndent = indent + 2 * (rest - depth)
        created.push(`${' '.repeat(keyIndent)}${yamlKey(path[rest])}:`)
      }
      created[created.length - 1] = `${created[created.length - 1].replace(/:$/, '')}: ${value}`
      // Keep the trailing newline structure of the file intact.
      let insertAt = to
      while (insertAt > 0 && !lines[insertAt - 1].trim()) insertAt--
      lines.splice(insertAt, 0, ...created)
      return lines.join('\n')
    }
    const line = lines[index]
    const match = /^([^\s:][^:]*):\s*(.*)$/.exec(line.trim())
    if (!match) return undefined
    if (depth === path.length - 1) {
      const leading = line.slice(0, line.length - line.trimStart().length)
      lines[index] = `${leading}${match[1]}: ${value}`
      return lines.join('\n')
    }
    if (match[2].trim()) return undefined
    from = index + 1
    to = blockEnd(lines, index)
    indent = indentOf(line) + 2
  }
  return undefined
}

/** The config key the native runtime reads the per-model window from. */
export function mcodeContextLimitPath(catalog: MCodeCatalog, modelId: string): string[] {
  return catalog.credentialSource === 'api'
    ? ['minimax_api', 'modelContextLimits', modelId]
    : ['minimaxModelContextLimits', modelId]
}

/**
 * Persist the context window for a model exactly like the native app does.
 * Returns true when the file changed.
 */
export async function writeMCodeContextLimit(
  modelId: string,
  limit: number,
  options: { catalog?: MCodeCatalog; configPath?: string } = {}
): Promise<boolean> {
  const configPath = options.configPath || options.catalog?.configPath || mcodeConfigPath()
  const catalog = options.catalog || parseMCodeCatalog(await readFile(configPath, 'utf8'), configPath)
  if (!catalog) throw new Error('无法读取 MiniMax Code 配置')
  const meta = catalog.models.get(modelId)
  if (!meta) throw new Error(`MiniMax Code 配置中没有模型 ${modelId}`)
  if (!meta.contextWindowOptions?.includes(limit)) {
    throw new Error(`模型 ${modelId} 不支持 ${limit} 的上下文窗口`)
  }
  const raw = await readFile(configPath, 'utf8')
  if (meta.contextWindow === limit) return false
  const patched = upsertYamlNumber(raw, mcodeContextLimitPath(catalog, modelId), limit)
  if (patched === undefined) throw new Error('MiniMax Code 配置结构无法安全更新')
  if (patched === raw) return false
  const temporary = `${configPath}.uniagent-${process.pid}`
  await writeFile(temporary, patched, { mode: 0o600 })
  await rename(temporary, configPath)
  return true
}

/** Read the effective window straight from the configuration file. */
export async function currentMCodeContextLimit(modelId: string, configPath = mcodeConfigPath()): Promise<number | undefined> {
  try {
    const catalog = parseMCodeCatalog(await readFile(configPath, 'utf8'), configPath)
    return mcodeContextLimit(catalog, modelId)
  } catch { return undefined }
}

export async function mcodeConfigExists(configPath = mcodeConfigPath()): Promise<boolean> {
  try { await stat(configPath); return true } catch { return false }
}
