import { stat, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, basename } from 'node:path'
import type { RequirementDocument, RequirementNavigation } from '../shared/requirementTypes'
import type { Project } from '../shared/types'

interface Dependencies {
  project(id: string): Project | undefined
  code(project: Project, links: NonNullable<RequirementDocument['codeLinks']>): Promise<Array<{ version?: string }>>
}
let provider: Dependencies | undefined
export function configureRequirementNavigation(value?: Dependencies): void { provider = value }

/** Only effective requirement records provide navigation; the original document owns its evidence. */
export async function requirementNavigation(documents: Array<Omit<RequirementDocument, 'content'>>, projectId?: string): Promise<RequirementNavigation> {
  const documentsByDate = documents.filter(doc => doc.status === 'active').sort((a,b) =>
    Number(b.sources.some(source => source.kind === 'user')) - Number(a.sources.some(source => source.kind === 'user')) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const code = new Map<string, RequirementNavigation['code'][number]>(), skills = new Map<string, RequirementNavigation['skills'][number]>()
  for (const doc of documentsByDate) {
    const metadata = { documentId: doc.id, basis: doc.memory?.basis || (doc.sources.some(source => source.kind === 'user') ? 'user' : doc.sources.some(source => source.kind === 'tool') ? 'tool' : 'agent'), freshness: doc.freshness } as const
    for (const link of doc.codeLinks || []) {
      const owner = link.projectId || projectId, key = JSON.stringify([owner,link.directory,link.path])
      if (!code.has(key)) code.set(key, { ...link, ...metadata, projectId: owner, availability: 'unknown' })
    }
    for (const link of doc.skillLinks || []) if (!skills.has(link.name)) skills.set(link.name, { ...link, ...metadata, availability: 'unknown' })
  }
  const selectedCode = [...code.values()].slice(0,30), selectedSkills = [...skills.values()].slice(0,30)
  await Promise.all(selectedCode.map(async link => {
    const project = link.projectId && provider?.project(link.projectId)
    if (!project || !provider) { if (provider) link.availability = 'unavailable'; return }
    const refs = await provider.code(project,[link]).catch(() => [])
    link.availability = refs[0]?.version ? 'available' : 'unavailable'
  }))
  await Promise.all(selectedSkills.map(async link => {
    if (!link.path) return
    link.availability = await Promise.all([stat(link.path),access(link.path,constants.R_OK)]).then(([info]) => info.isFile() && info.size <= 5*1024*1024 ? 'available' as const : 'unavailable' as const, () => 'unavailable' as const)
  }))
  return { code: selectedCode, skills: selectedSkills, more: code.size > selectedCode.length || skills.size > selectedSkills.length }
}

export function validSkillPath(path: unknown): boolean {
  return typeof path === 'string' && path.length <= 1000 && isAbsolute(path) && basename(path) === 'SKILL.md' && !/[\x00-\x1f]/.test(path)
}
