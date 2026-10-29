import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HandoffPreset } from '../shared/types'
import { resolveUserDataHome } from './userData.ts'

/**
 * Doc11 — handoff preset store (可复用任务模板). Persists reusable "create task"
 * templates so a common follow-up ("review this diff", "write tests for the
 * change") is one click / one MCP call.
 */
// Seeded on first run so the panel + MCP tool have useful starting templates.
const DEFAULT_PRESETS: HandoffPreset[] = [
  {
    id: 'builtin-code-review',
    name: '代码评审',
    prompt: '请审查本次的代码改动：指出潜在 bug、边界问题、可读性与安全隐患，并给出改进建议。'
  },
  {
    id: 'builtin-write-tests',
    name: '补充单元测试',
    prompt: '为本次改动补充单元测试，覆盖主要分支与边界条件，并说明测试思路。'
  },
  {
    id: 'builtin-explain',
    name: '解释这段代码',
    prompt: '请解释下面这段代码的作用、关键逻辑与可能的坑。'
  }
]

export class PresetStore {
  private file: string
  private ready = false

  constructor(fileOverride?: string) {
    this.file = fileOverride || join(resolveUserDataHome(), 'presets.json')
  }

  private ensureDir(): void {
    if (this.ready) return
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
    } catch {
      /* ignore */
    }
    this.ready = true
  }

  list(): HandoffPreset[] {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        if (Array.isArray(raw)) return raw.filter(isPreset)
      }
    } catch {
      /* fall through */
    }
    // First run: seed defaults so the feature is discoverable.
    this.writeAll(DEFAULT_PRESETS)
    return [...DEFAULT_PRESETS]
  }

  /** Upsert a preset by id (mint one when absent). Returns the full list. */
  save(preset: HandoffPreset): HandoffPreset[] {
    const list = this.list()
    const id = preset.id || `p_${randomUUID().slice(0, 8)}`
    const next: HandoffPreset = { ...preset, id }
    const idx = list.findIndex((p) => p.id === id)
    if (idx >= 0) list[idx] = next
    else list.push(next)
    this.writeAll(list)
    return list
  }

  /** Delete a preset by id. Returns the remaining list. */
  remove(id: string): HandoffPreset[] {
    const list = this.list().filter((p) => p.id !== id)
    this.writeAll(list)
    return list
  }

  private writeAll(list: HandoffPreset[]): void {
    this.ensureDir()
    try {
      writeFileSync(this.file, JSON.stringify(list, null, 2), 'utf8')
    } catch {
      /* best effort */
    }
  }
}

function isPreset(x: any): x is HandoffPreset {
  return x && typeof x === 'object' && typeof x.id === 'string' && typeof x.prompt === 'string'
}
