import * as TOML from '@iarna/toml'
import { isDeepStrictEqual } from 'node:util'
import { CODEX_SOURCE_PRESETS, isCodexSourceModelId, type CodexSourceInput, type CodexSourceModelQueryInput, type CodexSourcePreset } from '../shared/codexSources'

export type ConfigScalar = string | boolean | null
export interface ConfigField { path: string[]; before: ConfigScalar; applied: ConfigScalar; initial?: ConfigScalar }
const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
function checkPath(path: string[]): void {
  if (!path.length || path.some(key => !/^[\w-]+$/.test(key) || forbidden.has(key))) throw new Error('不支持的 Codex 配置字段')
}
export function parseCodexConfig(text: string): Record<string, any> {
  try { return TOML.parse(text) as Record<string, any> } catch { throw new Error('Codex 配置不是有效 TOML，未修改文件') }
}
export function configValue(config: Record<string, any>, path: string[]): ConfigScalar {
  checkPath(path)
  let value: any = config
  for (const key of path) value = value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined
  if (value === undefined) return null
  if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error('Codex 配置字段类型不支持安全更新')
  return value
}

// Let the installed TOML parser decode dotted/quoted keys; do not invent a lexer.
function keyPath(key: string): string[] | null {
  try {
    let value: any = TOML.parse(`${key} = false`)
    const path: string[] = []
    while (value && typeof value === 'object' && Object.keys(value).length === 1) {
      const name = Object.keys(value)[0]
      if (forbidden.has(name)) return null
      path.push(name)
      value = value[name]
    }
    return value === false ? path : null
  } catch { return null }
}

export function patchCodexConfig(text: string, changes: { path: string[]; value: ConfigScalar }[]): string {
  for (const { path, value } of changes) {
    checkPath(path)
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean') throw new Error('无效的 Codex 配置值')
    const expected = parseCodexConfig(text)
    const before = configValue(expected, path)
    if (before === value) continue
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)
    let table: string[] = []
    let tableLine = -1
    let found = -1
    for (let index = 0; index < lines.length; index++) {
      const header = lines[index].match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/)
      if (header) {
        table = keyPath(header[1]) || ['!unsupported']
        if (isDeepStrictEqual(table, path.slice(0, -1))) tableLine = index
      } else if (/^\s*\[\[/.test(lines[index])) table = ['!array']
      const assignment = lines[index].match(/^\s*([^=]+?)\s*=\s*(.*)$/)
      const key = assignment && keyPath(assignment[1])
      if (key && isDeepStrictEqual([...table, ...key], path)) {
        if (found !== -1) throw new Error('Codex 配置字段布局有歧义，未修改文件')
        found = index
      }
    }
    if (found >= 0) {
      const line = lines[found].match(/^(\s*[^=]+?\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*'|true|false)(\s*(?:#.*)?)$/)
      if (!line) throw new Error('该 Codex 配置字段使用复杂 TOML 写法，请改为单行后重试')
      if (value === null) lines.splice(found, 1)
      else lines[found] = line[1] + JSON.stringify(value) + line[3]
    } else {
      if (before !== null) throw new Error('无法安全定位 Codex 配置字段，未修改文件')
      if (value === null) continue
      const line = `${path.at(-1)} = ${JSON.stringify(value)}`
      if (path.length === 1) lines.unshift(line)
      else if (tableLine >= 0) lines.splice(tableLine + 1, 0, line)
      else lines.push('', `[${path.slice(0, -1).join('.')}]`, line, '')
    }
    let parent = expected
    for (const key of path.slice(0, -1)) {
      if (parent[key] === undefined) parent[key] = {}
      if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) throw new Error('Codex 配置表不支持安全更新')
      parent = parent[key]
    }
    if (value === null) delete parent[path.at(-1)!]
    else parent[path.at(-1)!] = value
    const output = lines.join(newline)
    // ponytail: targeted scalar edits only; reject exotic layouts unless a TOML CST editor becomes necessary.
    if (!isDeepStrictEqual(parseCodexConfig(output), expected)) throw new Error('无法保留其余 Codex 配置，未修改文件')
    text = output
  }
  return text
}

export function restoreCodexConfig(text: string, fields: ConfigField[]): string {
  const config = parseCodexConfig(text)
  for (const field of fields) {
    const current = configValue(config, field.path)
    if (current !== field.before && current !== field.applied && current !== field.initial) {
      throw new Error('Codex 接管字段被其他程序修改，未覆盖；请检查配置后重试')
    }
  }
  return patchCodexConfig(text, fields.map(field => ({ path: field.path, value: field.before })))
}

export function validateSourceInput(value: unknown): CodexSourceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的来源配置')
  const input = value as Record<string, unknown>
  if (typeof input.preset !== 'string' || !Object.hasOwn(CODEX_SOURCE_PRESETS, input.preset)) throw new Error('未知的接入方式')
  const preset = input.preset as CodexSourcePreset
  if (CODEX_SOURCE_PRESETS[preset].id !== input.id || typeof input.enabled !== 'boolean') throw new Error('来源与接入方式不匹配')
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048 || /[\x00-\x20\x7f]/.test(input.baseUrl)) throw new Error('接口地址无效')
  let url: URL
  try { url = new URL(input.baseUrl) } catch { throw new Error('请填写完整的接口地址') }
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口需使用 HTTPS（本机地址可用 HTTP），且不能包含账号、密码或查询参数')
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === '11436') throw new Error('接入商地址不能指向 UniAgent 接入服务自身')
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 100 || input.models.some(model => !isCodexSourceModelId(model))) throw new Error('请填写 1–100 个有效模型 ID')
  if (new Set(input.models).size !== input.models.length) throw new Error('模型 ID 不能重复')
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[^\x20-\x7e]/.test(input.apiKey))) throw new Error('API Key 格式无效，不能包含换行或控制字符')
  return { id: CODEX_SOURCE_PRESETS[preset].id, preset, enabled: input.enabled, baseUrl: url.toString().replace(/\/+$/, ''), models: [...input.models] as string[], ...(typeof input.apiKey === 'string' ? { apiKey: input.apiKey.trim() } : {}) }
}

export function validateSourceModelQuery(value: unknown): CodexSourceModelQueryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的来源配置')
  const source = validateSourceInput({ ...value, enabled: true, models: ['model-query'] })
  return {
    id: source.id, preset: source.preset, baseUrl: source.baseUrl,
    ...(source.apiKey === undefined ? {} : { apiKey: source.apiKey })
  }
}
