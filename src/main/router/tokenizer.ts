import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'

export class RouterTokenizer {
  constructor(private tokenizer: Tokenizer, readonly revision: string) {}
  count(text: string): number { return this.tokenizer.encode(text, { add_special_tokens: false }).ids.length }
  clip(text: string, limit: number): string {
    if (this.count(text) <= limit) return text
    const chars = [...text]
    let low = 0, high = chars.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      this.count(chars.slice(0, middle).join('')) <= limit ? low = middle : high = middle - 1
    }
    return chars.slice(0, low).join('')
  }
  page<T>(items: T[], offset: number, budget = 3500): { items: T[]; next: number | null } {
    const page: T[] = []
    let position = offset
    while (position < items.length && page.length < 20) {
      const next = [...page, items[position]]
      if (this.count(JSON.stringify(next)) > budget) break
      page.push(items[position++])
    }
    if (position === offset && position < items.length) throw new Error('context_item_too_large')
    return { items: page, next: position < items.length ? position : null }
  }
}
const loaded = new Map<string, Promise<RouterTokenizer>>()
export function loadRouterTokenizer(directory = resolve('resources/tokenizers/deepseek-v4')): Promise<RouterTokenizer> {
  let pending = loaded.get(directory)
  if (!pending) {
    pending = (async () => {
      const [json, config, manifestText] = await Promise.all(['tokenizer.json', 'tokenizer_config.json', 'manifest.json'].map(name => readFile(join(directory, name), 'utf8')))
      const manifest = JSON.parse(manifestText)
      for (const [name, data] of [['tokenizer.json', json], ['tokenizer_config.json', config]]) {
        if (createHash('sha256').update(data).digest('hex') !== manifest.sha256[name]) throw new Error('router_tokenizer_asset_changed')
      }
      return new RouterTokenizer(new Tokenizer(JSON.parse(json), JSON.parse(config)), manifest.family + ':' + manifest.sha256['tokenizer.json'])
    })()
    loaded.set(directory, pending)
    void pending.catch(() => loaded.delete(directory))
  }
  return pending
}
