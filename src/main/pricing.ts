import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveUserDataHome } from './userData.ts'

/**
 * Token pricing (Doc5 T1 §5). Prices live in a *user-editable* config file
 * `~/.uniagent/pricing.json`, seeded automatically by the app (detected models +
 * auto-discovered prices) and hand-tunable by the user. Units are USD per 1M
 * tokens. Fast rates are optional and never inferred from standard rates.
 *
 * Lookup precedence: manual > auto; within a source, exact modelId match beats
 * an alias/prefix fallback (opus / sonnet / haiku / gpt- …). Auto reconciliation
 * only ever fills auto/missing entries — it never overwrites a `source:"manual"`.
 */
interface ModelRates {
  /** $ / 1M input tokens (non-cached). null = unknown → unpriceable. */
  input: number | null
  /** $ / 1M cached-hit input tokens. */
  cachedInput: number | null
  /** $ / 1M output tokens. null → unpriceable. */
  output: number | null
}

export interface ModelPrice extends ModelRates {
  /** Explicit per-model Fast / priority prices, when known. */
  fast?: ModelRates
  source: 'manual' | 'auto'
  updatedAt?: string
  note?: string
  confidence?: 'low'
}

export interface PricingFile {
  version: number
  models: Record<string, ModelPrice>
}

const USER_DATA_HOME = resolveUserDataHome(join(homedir(), '.uniagent-public'))
const PRICING_FILE = join(USER_DATA_HOME, 'pricing.json')
const LITELLM_CACHE = join(USER_DATA_HOME, 'litellm_prices.json')
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const LITELLM_TTL_MS = 24 * 60 * 60 * 1000

/** Well-known aliases so `claude-opus-4-…` etc. resolve to a hand-set base price. */
const ALIASES = ['opus', 'sonnet', 'haiku']

function ensureDir(): void {
  try {
    mkdirSync(join(PRICING_FILE, '..'), { recursive: true })
  } catch {
    /* ignore */
  }
}

export function loadPricing(): PricingFile {
  try {
    if (existsSync(PRICING_FILE)) {
      const raw = JSON.parse(readFileSync(PRICING_FILE, 'utf8'))
      if (raw && typeof raw === 'object' && raw.models) return raw as PricingFile
    }
  } catch {
    /* fall through to empty */
  }
  return { version: 1, models: {} }
}

export function savePricing(file: PricingFile): void {
  ensureDir()
  try {
    writeFileSync(PRICING_FILE, JSON.stringify(file, null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

/**
 * Resolve a model's price. Exact id first (manual then auto), then alias/prefix
 * fallback. Returns null when nothing priceable is found.
 */
export function priceFor(modelId: string | undefined, file?: PricingFile): ModelPrice | null {
  if (!modelId) return null
  const p = file || loadPricing()
  const exact = p.models[modelId]
  if (exact && isPriceable(exact)) return exact
  // Alias/prefix fallback: any configured key contained in the modelId (or vice
  // versa) that is priceable. Prefer manual over auto.
  const id = modelId.toLowerCase()
  const cands: ModelPrice[] = []
  for (const [key, val] of Object.entries(p.models)) {
    if (!isPriceable(val)) continue
    const k = key.toLowerCase()
    if (id === k) continue // already tried exact
    if (id.includes(k) || k.includes(id) || ALIASES.some((a) => id.includes(a) && k.includes(a))) {
      cands.push(val)
    }
  }
  if (!cands.length) return null
  cands.sort((a, b) => (a.source === 'manual' ? -1 : 1) - (b.source === 'manual' ? -1 : 1))
  return cands[0]
}

function isPriceable(p: ModelPrice): boolean {
  return p != null && p.input != null && p.output != null
}

/**
 * Cost in USD for one turn (Doc5 T1 §5.3). Cached-hit input is billed at the
 * cheaper cachedInput rate (falling back to input when unset for standard mode).
 * Fast mode needs an exact model and all rates required by the observed usage.
 */
export function computeCost(
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
  modelId: string | undefined,
  file?: PricingFile,
  options?: { fastMode?: boolean; exactModel?: boolean }
): number | null {
  const prices = file || loadPricing()
  const exact = (options?.fastMode || options?.exactModel) && modelId
    ? prices.models[modelId] ?? Object.entries(prices.models).find(([id]) => id.toLowerCase() === modelId.toLowerCase())?.[1]
    : undefined
  const price = options?.fastMode ? exact?.fast : options?.exactModel ? exact : priceFor(modelId, prices)
  if (!price || price.input == null || price.output == null) return null
  if (options?.fastMode && usage.cachedInputTokens > 0 && price.cachedInput == null) return null
  const cachedRate = price.cachedInput ?? price.input
  const nonCached = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
  const cost =
    (nonCached / 1e6) * price.input +
    (usage.cachedInputTokens / 1e6) * cachedRate +
    (usage.outputTokens / 1e6) * price.output
  return Number.isFinite(cost) ? cost : null
}

/**
 * Reconcile pricing for a fresh set of detected model ids (Doc5 T1 §5.3):
 *  1. add any missing model to the file as an empty auto entry (so the user sees
 *     the full list to hand-fill);
 *  2. pull the public LiteLLM registry (cached, 24h), fill auto/null entries,
 *     and refresh exact-model Fast rates — never touching `source:"manual"`.
 * Best-effort: any failure (offline, parse) leaves entries null for hand-filling.
 */
export async function reconcilePricing(modelIds: string[]): Promise<PricingFile> {
  const file = loadPricing()
  const today = new Date().toISOString().slice(0, 10)
  let dirty = false

  // 1) Ensure every detected model is at least listed.
  for (const id of modelIds) {
    if (!id) continue
    if (!file.models[id]) {
      file.models[id] = { input: null, cachedInput: null, output: null, source: 'auto', updatedAt: today }
      dirty = true
    }
  }

  // 2) Fill auto/null entries from the public registry.
  const registry = await loadLiteLLM().catch(() => null)
  if (registry) {
    const exactRows = new Map(Object.entries(registry).map(([id, row]) => [id.toLowerCase(), row]))
    for (const [id, entry] of Object.entries(file.models)) {
      if (entry.source === 'manual') continue // never override manual
      // Existing prices only need exact Fast rates; avoid scanning the registry
      // for aliases on every already-priced model during startup.
      const hit = isPriceable(entry)
        ? matchRegistry({ [id]: exactRows.get(id.toLowerCase()) }, id)
        : matchRegistry(registry, id)
      if (hit) {
        const next = { ...entry }
        if (!isPriceable(entry)) {
          next.input = hit.input
          next.cachedInput = hit.cachedInput
          next.output = hit.output
          next.updatedAt = today
        }
        if (hit.fast) {
          next.fast = hit.fast
        } else {
          delete next.fast
        }
        if (JSON.stringify(entry) !== JSON.stringify(next)) {
          file.models[id] = next
          dirty = true
        }
      }
    }
  }

  if (dirty) savePricing(file)
  return file
}

/** Match a model id against the LiteLLM registry by exact key then alias. */
function matchRegistry(
  reg: Record<string, any>,
  modelId: string
): (ModelRates & { fast?: ModelRates }) | null {
  const toM = (v: any): number | null => (typeof v === 'number' ? v * 1e6 : null)
  const readRow = (row: any, exact: boolean): (ModelRates & { fast?: ModelRates }) | null => {
    if (!row || typeof row !== 'object') return null
    const input = toM(row.input_cost_per_token)
    const output = toM(row.output_cost_per_token)
    const cachedInput = toM(row.cache_read_input_token_cost)
    if (input == null && output == null) return null
    const fastInput = toM(row.input_cost_per_token_priority)
    const fastOutput = toM(row.output_cost_per_token_priority)
    const fast = exact && fastInput != null && fastOutput != null
      ? { input: fastInput, cachedInput: toM(row.cache_read_input_token_cost_priority), output: fastOutput }
      : undefined
    return { input, cachedInput, output, ...(fast ? { fast } : {}) }
  }
  if (reg[modelId]) {
    const r = readRow(reg[modelId], true)
    if (r) return r
  }
  const id = modelId.toLowerCase()
  // exact-insensitive / suffix match against keys
  for (const [key, row] of Object.entries(reg)) {
    const k = key.toLowerCase()
    if (k === id || k.endsWith('/' + id) || id.endsWith('/' + k)) {
      const r = readRow(row, k === id)
      if (r) return r
    }
  }
  // alias match (opus/sonnet/haiku) — pick the shortest key containing the alias.
  for (const alias of ALIASES) {
    if (!id.includes(alias)) continue
    let best: { key: string; row: any } | null = null
    for (const [key, row] of Object.entries(reg)) {
      if (!key.toLowerCase().includes(alias)) continue
      if (!best || key.length < best.key.length) best = { key, row }
    }
    if (best) {
      const r = readRow(best.row, false)
      if (r) return r
    }
  }
  return null
}

/** Load the LiteLLM price registry with a local 24h cache + graceful offline. */
async function loadLiteLLM(): Promise<Record<string, any> | null> {
  try {
    if (existsSync(LITELLM_CACHE)) {
      const age = Date.now() - statSync(LITELLM_CACHE).mtimeMs
      if (age < LITELLM_TTL_MS) {
        return JSON.parse(readFileSync(LITELLM_CACHE, 'utf8'))
      }
    }
  } catch {
    /* stale/corrupt cache → refetch */
  }
  try {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error('http ' + res.status)
    const json = await res.json()
    ensureDir()
    try {
      writeFileSync(LITELLM_CACHE, JSON.stringify(json), 'utf8')
    } catch {
      /* ignore cache write */
    }
    return json as Record<string, any>
  } catch {
    // Offline: fall back to a stale cache if present.
    try {
      if (existsSync(LITELLM_CACHE)) return JSON.parse(readFileSync(LITELLM_CACHE, 'utf8'))
    } catch {
      /* ignore */
    }
    return null
  }
}
