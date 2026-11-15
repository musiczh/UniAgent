import { createHash } from 'node:crypto'

export function manageRevision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value,(_key,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key,v[key]])) : v) ?? 'undefined').digest('hex') }
const SECRET_FIELDS = new Set(['apikey','appsecret','clientsecret','authtoken','privatekey','password','token','accesstoken','refreshtoken','authorization','cookie','credentials','env','headers','cadksessioncontext','sessioncontext'])
export function publicManagementValue(value: unknown): any {
  if (Array.isArray(value)) return value.map(publicManagementValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key,v]) => {
    const normalized = key.toLowerCase().replace(/[_-]/g,'')
    if (SECRET_FIELDS.has(normalized)) return ['apikey','appsecret','password','accesstoken','refreshtoken'].includes(normalized) ? [[key+'Configured',!!v]] : []
    return [[key,publicManagementValue(v)]]
  }))
  if (typeof value === 'string') return value.replace(/\bBearer\s+\S+/gi,'Bearer [redacted]').replace(/\b((?:[A-Z_]*API[_-]?KEY|APP[_-]?SECRET|ACCESS[_-]?TOKEN|PASSWORD)\s*[=:]\s*)[^\s,;]+/gi,'$1[redacted]')
  return value
}
