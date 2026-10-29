import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

export const MAX_SKILL_MANIFEST_BYTES = 5 * 1024 * 1024

export type SkillDiscoveryScope = 'agent' | 'shared' | 'plugin'
export type SkillDiscoveryStatus = 'available' | 'invalid' | 'shadowed'
export type SkillDiscoveryIssue =
  | 'unsafe_skill_root'
  | 'unsafe_skill_entry'
  | 'invalid_skill_permissions'
  | 'skill_file_too_large'
  | 'shadowed_capability'

export interface SkillDiscovery {
  name: string
  scope: SkillDiscoveryScope
  status: SkillDiscoveryStatus
  issueCode?: SkillDiscoveryIssue
  fingerprint: string
  manifest?: string
  description?: string
  source?: string
  plugin?: string
  version?: string
  linked?: boolean
  linkPath?: string
  entryPath?: string
  targetPath?: string
  /** Stable logical identity. It deliberately contains no absolute path. */
  identity: string
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const safeLabel = (value: string, fallback: string): string =>
  value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback

async function assertSafeDirectoryChain(path: string, home: string): Promise<string[]> {
  const base = resolve(home), candidate = resolve(path), rel = relative(base, candidate)
  if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('unsafe_skill_root')
  const baseInfo = await lstat(base)
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error('unsafe_skill_root')
  const identities = [`${baseInfo.dev}:${baseInfo.ino}`]
  if (!rel) return identities
  let cursor = base
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part)
    const info = await lstat(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_skill_root')
    identities.push(`${info.dev}:${info.ino}`)
  }
  return identities
}

export async function secureManifest(path: string, home: string): Promise<{ text: string; fingerprint: string }> {
  const expectedChain = await assertSafeDirectoryChain(dirname(path), home)
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('unsafe_skill_entry')
    if (info.size > MAX_SKILL_MANIFEST_BYTES) throw new Error('skill_file_too_large')
    const text = await handle.readFile('utf8')
    const actualChain = await assertSafeDirectoryChain(dirname(path), home)
    if (actualChain.length !== expectedChain.length || actualChain.some((value, index) => value !== expectedChain[index])) {
      throw new Error('unsafe_skill_root')
    }
    return { text, fingerprint: hash(text) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).message === 'skill_file_too_large') throw error
    throw new Error('unsafe_skill_entry')
  } finally {
    await handle.close()
  }
}

export async function secureRegularText(path: string, home: string, maximum: number): Promise<string> {
  const expectedChain = await assertSafeDirectoryChain(dirname(path), home)
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('unsafe_skill_entry')
    if (info.size > maximum) throw new Error('skill_file_too_large')
    const text = await handle.readFile('utf8')
    const actualChain = await assertSafeDirectoryChain(dirname(path), home)
    if (actualChain.length !== expectedChain.length || actualChain.some((value, index) => value !== expectedChain[index])) {
      throw new Error('unsafe_skill_root')
    }
    return text
  } finally { await handle.close() }
}

function invalid(scope: SkillDiscoveryScope, name: string, identity: string, issueCode: SkillDiscoveryIssue, metadata: Partial<SkillDiscovery> = {}): SkillDiscovery {
  return { name, scope, status: 'invalid', issueCode, fingerprint: hash(`invalid\0${identity}\0${issueCode}`), identity, ...metadata }
}

async function rootState(root: string, home: string): Promise<'missing' | 'safe' | 'unsafe_skill_root'> {
  try {
    await assertSafeDirectoryChain(root, home)
    return 'safe'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return 'unsafe_skill_root'
  }
}

/** Discover ordinary agent/shared skills. Nested shared namespaces are supported. */
export async function discoverSkillRoot(
  home: string, root: string, scope: 'agent' | 'shared', maxDepth = scope === 'shared' ? 6 : 0
): Promise<SkillDiscovery[]> {
  const state = await rootState(root, home)
  if (state === 'missing') return []
  if (state !== 'safe') return [invalid(scope, 'Skills', `${scope}:root`, state)]
  const canonicalHome = await realpath(home)
  const found: SkillDiscovery[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) }
    catch { found.push(invalid(scope, 'Skills', `${scope}:scan:${relative(root, dir)}`, 'unsafe_skill_root')); return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      const rel = relative(root, path)
      const identity = `${scope}:skill:${rel.toLocaleLowerCase('en-US')}`
      if (entry.isFile()) continue
      if (entry.isSymbolicLink()) {
        let targetPath: string | undefined
        try {
          targetPath = resolve(dirname(path), await readlink(path))
          const target = await realpath(path)
          const relToHome = relative(canonicalHome, target)
          if (relToHome === '..' || relToHome.startsWith('..' + sep)) throw new Error('unsafe_skill_entry')
          const info = await lstat(target)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_skill_entry')
          const manifest = join(target, 'SKILL.md')
          const value = await secureManifest(manifest, canonicalHome)
          const description = value.text.match(/^description:\s*(.+)$/m)?.[1].trim().slice(0, 120)
          found.push({ name: safeLabel(entry.name, 'Invalid Skill'), scope, status: 'available', fingerprint: value.fingerprint,
            manifest, identity, description, linked: true, linkPath: path, entryPath: path, targetPath: target })
        } catch { found.push(invalid(scope, safeLabel(entry.name, 'Invalid Skill'), identity, 'unsafe_skill_entry', { linked: true, linkPath: path, entryPath: path, targetPath })) }
        continue
      }
      if (!entry.isDirectory()) continue
      const manifest = join(path, 'SKILL.md')
      try {
        const value = await secureManifest(manifest, home)
        const description = value.text.match(/^description:\s*(.+)$/m)?.[1].trim().slice(0, 120)
        found.push({ name: safeLabel(entry.name, 'Invalid Skill'), scope, status: 'available', fingerprint: value.fingerprint, manifest, identity, description, entryPath: path })
      } catch (error) {
        try {
          if ((await lstat(manifest)).isSymbolicLink()) {
            const targetPath = resolve(dirname(manifest), await readlink(manifest))
            try {
              const actual = await realpath(manifest)
              const value = await secureManifest(actual, canonicalHome)
              found.push({ name: safeLabel(entry.name, 'Invalid Skill'), scope, status: 'available', fingerprint: value.fingerprint,
                manifest: actual, identity, linked: true, linkPath: manifest, entryPath: manifest, targetPath: actual })
            } catch {
              found.push(invalid(scope, safeLabel(entry.name, 'Invalid Skill'), identity, 'unsafe_skill_entry',
                { linked: true, linkPath: manifest, entryPath: manifest, targetPath }))
            }
            continue
          }
        } catch { /* A missing ordinary manifest is handled by the namespace walk below. */ }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (depth < maxDepth) await walk(path, depth + 1)
          continue
        }
        const message = (error as Error).message as SkillDiscoveryIssue
        found.push(invalid(scope, safeLabel(entry.name, 'Invalid Skill'), identity,
          message === 'skill_file_too_large' ? message : 'unsafe_skill_entry'))
      }
    }
  }
  await walk(root, 0)
  return found
}

interface VersionParts { core: Array<number | string>; prerelease?: Array<number | string> }
function parseVersion(value: string): VersionParts {
  const normalized = value.replace(/^[vV]/, '')
  const [main, prerelease] = normalized.split('-', 2)
  const parts = (text: string): Array<number | string> => (text.match(/\d+|[A-Za-z]+/g) || [text]).map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase())
  return { core: parts(main), prerelease: prerelease == null ? undefined : parts(prerelease) }
}
function compareParts(left: Array<number | string>, right: Array<number | string>): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? 0, b = right[index] ?? 0
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a - b
    if (typeof a === 'number') return 1
    if (typeof b === 'number') return -1
    return a.localeCompare(b)
  }
  return 0
}
export function comparePluginVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right)
  const core = compareParts(a.core, b.core)
  if (core) return core
  if (!a.prerelease && b.prerelease) return 1
  if (a.prerelease && !b.prerelease) return -1
  return compareParts(a.prerelease || [], b.prerelease || []) || left.localeCompare(right, undefined, { numeric: true })
}

export function applySkillPrecedence(groups: SkillDiscovery[][]): SkillDiscovery[] {
  const seen = new Set<string>()
  const output: SkillDiscovery[] = []
  for (const group of groups) for (const item of group) {
    const key = item.name.toLocaleLowerCase('en-US')
    if (item.status !== 'available') { output.push(item); continue }
    if (seen.has(key)) {
      output.push({ ...item, status: 'shadowed', issueCode: 'shadowed_capability' })
      continue
    }
    seen.add(key); output.push(item)
  }
  return output
}
