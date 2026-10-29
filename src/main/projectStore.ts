import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Project, ProjectInput, SessionConfig } from '../shared/types.ts'
import { resolveUserDataHome } from './userData.ts'
import { assertWorktreeAvailable } from './worktreeService.ts'

export const DEFAULT_PROJECT_ID = 'default'

type StoredConfig = Partial<Pick<SessionConfig, 'projectId' | 'workdir' | 'additionalDirectories'>> &
  Omit<SessionConfig, 'projectId' | 'workdir' | 'additionalDirectories'>

export class ProjectStore {
  private readonly file: string
  private projects: Project[]

  constructor(directory = resolveUserDataHome()) {
    this.file = join(directory, 'projects.json')
    this.projects = this.read()
    const before = JSON.stringify(this.projects)
    this.ensureDefault()
    if (!existsSync(this.file) || before !== JSON.stringify(this.projects)) this.persist()
  }

  list(): Project[] {
    return this.projects.map(cloneProject)
  }

  defaultProject(): Project {
    return cloneProject(this.projects.find((project) => project.id === DEFAULT_PROJECT_ID)!)
  }

  get(id: string | undefined): Project | undefined {
    const project = this.projects.find((candidate) => candidate.id === id)
    return project ? cloneProject(project) : undefined
  }

  create(input: ProjectInput): Project {
    const now = Date.now()
    const normalized = validateInput(input)
    const project: Project = {
      id: randomUUID(),
      ...normalized,
      createdAt: now,
      updatedAt: now
    }
    this.projects.push(project)
    try {
      this.persist()
    } catch (error) {
      this.projects.pop()
      throw error
    }
    return cloneProject(project)
  }

  update(id: string, input: ProjectInput): Project {
    if (id === DEFAULT_PROJECT_ID) throw new Error('default_project_read_only')
    const index = this.projects.findIndex((project) => project.id === id)
    if (index < 0) throw new Error('project_not_found')
    const previous = this.projects[index]
    const next: Project = { ...previous, ...validateInput(input), updatedAt: Date.now() }
    this.projects[index] = next
    try {
      this.persist()
    } catch (error) {
      this.projects[index] = previous
      throw error
    }
    return cloneProject(next)
  }

  delete(id: string): void {
    if (id === DEFAULT_PROJECT_ID) throw new Error('default_project_cannot_delete')
    const index = this.projects.findIndex((project) => project.id === id)
    if (index < 0) throw new Error('project_not_found')
    const [removed] = this.projects.splice(index, 1)
    try {
      this.persist()
    } catch (error) {
      this.projects.splice(index, 0, removed)
      throw error
    }
  }

  /** Find a project whose primary root is this directory, creating a legacy one if absent. */
  ensureProjectForDirectory(directory: string): Project {
    const normalized = normalizeDirectory(directory || homedir())
    if (sameDirectory(normalized, homedir())) return this.defaultProject()
    const existing = this.projects.find((project) => sameDirectory(project.primaryDirectory, normalized))
    if (existing) return cloneProject(existing)
    const now = Date.now()
    const project: Project = {
      id: randomUUID(),
      name: uniqueName(basename(normalized) || normalized, this.projects),
      primaryDirectory: normalized,
      additionalDirectories: [],
      createdAt: now,
      updatedAt: now
    }
    this.projects.push(project)
    try {
      this.persist()
    } catch (error) {
      this.projects.pop()
      throw error
    }
    return cloneProject(project)
  }

  /** Resolve legacy/new config into the runtime snapshot consumed by adapters. */
  resolveSessionConfig(config: StoredConfig, validateDirectories = false): SessionConfig {
    const { workspaceSelection: _selection, ...runtimeConfig } = config
    const explicit = this.projects.find((project) => project.id === config.projectId)
    if (config.worktree && !explicit) {
      if (validateDirectories) throw new Error('工作树所属空间不存在，无法继续任务')
      return { ...runtimeConfig, projectId: config.worktree.projectId, workdir: config.worktree.workdir, additionalDirectories: [] }
    }
    const project = explicit || (!config.projectId && config.workdir
      ? this.ensureProjectForDirectory(config.workdir)
      : this.projects.find((candidate) => candidate.id === DEFAULT_PROJECT_ID)!)
    if (validateDirectories) validateProjectDirectories(project)
    if (config.worktree && validateDirectories) {
      if (config.worktree.projectId !== project.id || realpathSync(project.primaryDirectory) !== config.worktree.sourcePrimaryDirectory) {
        throw new Error('空间主目录已变化，无法继续使用原工作树')
      }
      if (config.worktree.state !== 'creating') assertWorktreeAvailable(config)
    }
    return {
      ...runtimeConfig,
      projectId: project.id,
      workdir: config.worktree?.workdir || project.primaryDirectory,
      additionalDirectories: [...project.additionalDirectories]
    }
  }

  private ensureDefault(): void {
    const home = normalizeDirectory(homedir())
    const now = Date.now()
    const index = this.projects.findIndex((project) => project.id === DEFAULT_PROJECT_ID)
    const value: Project = {
      id: DEFAULT_PROJECT_ID,
      name: '默认项目',
      primaryDirectory: home,
      additionalDirectories: [],
      createdAt: index >= 0 ? this.projects[index].createdAt : now,
      updatedAt: index >= 0 ? this.projects[index].updatedAt : now,
      isDefault: true
    }
    if (index >= 0) this.projects[index] = value
    else this.projects.unshift(value)
  }

  private read(): Project[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw.flatMap((value): Project[] => {
        const project = sanitizeProject(value)
        return project ? [project] : []
      })
    } catch {
      return []
    }
  }

  private persist(): void {
    atomicWrite(this.file, JSON.stringify(this.projects, null, 2))
  }
}

function validateInput(input: ProjectInput): Pick<Project, 'name' | 'primaryDirectory' | 'additionalDirectories'> {
  const name = input.name.trim()
  if (!name) throw new Error('project_name_required')
  const primaryDirectory = normalizeDirectory(input.primaryDirectory)
  const additionalDirectories = input.additionalDirectories.map(normalizeDirectory)
  const all = [primaryDirectory, ...additionalDirectories]
  if (new Set(all).size !== all.length) throw new Error('project_directory_duplicate')
  for (const directory of all) {
    if (!isAbsolute(directory)) throw new Error('project_directory_must_be_absolute')
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      throw new Error(`project_directory_unavailable: ${directory}`)
    }
  }
  return { name, primaryDirectory, additionalDirectories }
}

function validateProjectDirectories(project: Project): void {
  for (const directory of [project.primaryDirectory, ...project.additionalDirectories]) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      throw new Error(`项目「${project.name}」的目录不可用：${directory}`)
    }
  }
}

function sanitizeProject(value: unknown): Project | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim()) return undefined
  if (typeof row.primaryDirectory !== 'string' || !isAbsolute(row.primaryDirectory)) return undefined
  if (!Array.isArray(row.additionalDirectories) || row.additionalDirectories.some((item) => typeof item !== 'string' || !isAbsolute(item))) return undefined
  const createdAt = typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : Date.now()
  const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : createdAt
  const directories = [normalizeDirectory(row.primaryDirectory), ...row.additionalDirectories.map((item) => normalizeDirectory(item as string))]
  if (new Set(directories).size !== directories.length) return undefined
  return {
    id: row.id,
    name: row.name.trim(),
    primaryDirectory: directories[0],
    additionalDirectories: directories.slice(1),
    createdAt,
    updatedAt,
    ...(row.id === DEFAULT_PROJECT_ID ? { isDefault: true } : {})
  }
}

function normalizeDirectory(directory: string): string {
  if (!directory || !isAbsolute(directory)) throw new Error('project_directory_must_be_absolute')
  return resolve(directory)
}

function sameDirectory(left: string, right: string): boolean {
  return normalizeDirectory(left) === normalizeDirectory(right)
}

function uniqueName(seed: string, projects: Project[]): string {
  const names = new Set(projects.map((project) => project.name))
  if (!names.has(seed)) return seed
  let suffix = 2
  while (names.has(`${seed} ${suffix}`)) suffix += 1
  return `${seed} ${suffix}`
}

function cloneProject(project: Project): Project {
  return { ...project, additionalDirectories: [...project.additionalDirectories] }
}

export function atomicWrite(file: string, contents: string): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  const temp = join(directory, `.projects.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    const buffer = Buffer.from(contents, 'utf8')
    let offset = 0
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
    let directoryFd: number | undefined
    try {
      directoryFd = openSync(directory, constants.O_RDONLY)
      fsyncSync(directoryFd)
    } catch {
      // The rename is already visible; keep memory aligned with the committed file.
    } finally {
      if (directoryFd !== undefined) {
        try { closeSync(directoryFd) } catch { /* already committed */ }
      }
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* absent or already renamed */ }
    throw error
  }
}
