import type { SessionSearchRequest } from '../../shared/assistant'

const han = /\p{Script=Han}/u
export function searchTokens(text: string): string[] {
  const output: string[] = []
  const parts = text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) || []
  for (const part of parts) {
    if (han.test(part[0])) {
      const chars = [...part]
      for (let i = 0; i < chars.length; i++) {
        output.push('c' + chars[i].codePointAt(0)!.toString(16))
        if (i + 1 < chars.length) output.push('b' + chars[i].codePointAt(0)!.toString(16) + 'x' + chars[i + 1].codePointAt(0)!.toString(16))
      }
    } else output.push('e' + part)
  }
  return output
}
export function compileSearch(query: string): string {
  if (query.length > 500 || /[():{}]/.test(query)) throw new Error('invalid_search_query')
  const terms = query.match(/"[^"\n]+"|\b(?:AND|OR|NOT)\b|[^\s"]+/g) || []
  if (terms.join('').replace(/\s/g, '') !== query.replace(/\s/g, '')) throw new Error('invalid_search_query')
  let expectTerm = true
  let expression = ''
  for (const term of terms) {
    if (['AND', 'OR', 'NOT'].includes(term)) {
      if (expectTerm) throw new Error('invalid_search_query')
      expression += ' ' + term + ' '; expectTerm = true; continue
    }
    if (!expectTerm) expression += ' AND '
    const prefix = term.endsWith('*')
    if (term.includes('*') && (!prefix || term.slice(0, -1).includes('*') || han.test(term))) throw new Error('invalid_search_query')
    const tokens = searchTokens(term.replace(/^"|"$/g, '').replace(/\*$/, ''))
    if (!tokens.length) throw new Error('invalid_search_query')
    expression += term.startsWith('"') ? '"' + tokens.join(' ') + '"' : '(' + tokens.map(t => '"' + t + '"' + (prefix ? '*' : '')).join(' AND ') + ')'
    expectTerm = false
  }
  if (expectTerm) throw new Error('invalid_search_query')
  return expression
}
export function searchTime(value: string | undefined): number | undefined {
  if (!value) return undefined
  const relative = /^(\d+)\s*([hdw])$/.exec(value)
  if (relative) return Date.now() - Number(relative[1]) * ({ h: 3600000, d: 86400000, w: 604800000 }[relative[2]]!)
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : /^\d{4}-\d\d-\d\d$/.test(value) ? value + 'T00:00:00+08:00' : value + '+08:00'
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) throw new Error('invalid_search_time')
  return parsed
}
export function validateSearch(value: unknown): SessionSearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_search_request')
  const v = value as SessionSearchRequest
  const allowed = ['query', 'sessionId', 'aroundMessageId', 'limit', 'window', 'after', 'before', 'roles', 'sort', 'excludeSessionIds']
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('invalid_search_fields')
  for (const key of ['query', 'sessionId', 'aroundMessageId', 'after', 'before'] as const) if (v[key] !== undefined && typeof v[key] !== 'string') throw new Error('invalid_search_field')
  for (const key of ['limit','window'] as const) if (v[key] !== undefined && (!Number.isSafeInteger(v[key]) || v[key]! < 1 || v[key]! > 20)) throw new Error('invalid_search_limit')
  if (v.query && v.query.length > 500) throw new Error('invalid_search_query')
  if (v.roles && (!Array.isArray(v.roles) || v.roles.some(r => !['user', 'assistant', 'tool'].includes(r)))) throw new Error('invalid_search_roles')
  if (v.excludeSessionIds && (!Array.isArray(v.excludeSessionIds) || v.excludeSessionIds.length > 20 || v.excludeSessionIds.some(id => typeof id !== 'string'))) throw new Error('invalid_search_exclusion')
  if (v.sort && !['newest', 'oldest'].includes(v.sort)) throw new Error('invalid_search_sort')
  return v
}
