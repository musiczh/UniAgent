import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Requirement } from '../../shared/requirementTypes'
import type { Session } from '../../shared/types'
import type { TeamProject } from '../../shared/teamTypes'
import type { CapabilityInventoryResult } from '../../shared/capabilitySync'
import { publicManagementValue } from './manage'

interface DocumentRef { id: string; title: string; source: string; ownerId: string; path?: string; root?: string; text?: string; sha256?: string }
interface DocumentDeps { requirements(): Requirement[]; sessions(): Session[]; teams(): TeamProject[]; capabilities(): Promise<CapabilityInventoryResult> }
const TEXT_EXTENSIONS = new Set(['.md','.markdown','.txt','.html','.htm','.csv','.tsv'])
const within = (root: string, path: string) => { const child = relative(root,path); return child !== '..' && !child.startsWith('..'+sep) && !isAbsolute(child) }
function count(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error('invalid_document_page')
  return Number(value)
}
export class ManagementDocuments {
  private refs = new Map<string, DocumentRef>()
  private incomplete = false
  constructor(private deps: DocumentDeps) {}
  private register(source: string, ownerId: string, title: string, fields: Partial<DocumentRef>): void {
    if (this.refs.size >= 1000) { this.incomplete = true; return }
    const id = 'doc_'+createHash('sha256').update(JSON.stringify([source,ownerId,fields.path || title])).digest('hex').slice(0,24)
    this.refs.set(id,{ id,source,ownerId,title,...fields })
  }
  private async collect(source?: string): Promise<void> {
    if (source && !['requirements','team_artifacts','session_attachments','capabilities'].includes(source)) throw new Error('invalid_document_source')
    this.refs.clear(); this.incomplete = false
    if (!source || source === 'requirements') for (const requirement of this.deps.requirements()) {
      this.register('requirements',requirement.id,requirement.name+' · context.md',{ path: requirement.docPath, root: requirement.dir })
      await this.walk(requirement.dir,requirement.dir,requirement.id,0)
    }
    if (!source || source === 'team_artifacts') for (const project of this.deps.teams()) for (const artifact of project.artifacts) {
      if (artifact.path) this.register('team_artifacts',project.id,artifact.title,{ path: artifact.path,
        root: artifact.snapshot ? dirname(artifact.path) : project.spaceRoots.find(root => within(root,artifact.path!)), sha256: artifact.sha256 })
      else if (artifact.text !== undefined) this.register('team_artifacts',project.id,artifact.title,{ text: artifact.text })
    }
    if (!source || source === 'session_attachments') for (const session of this.deps.sessions()) for (const message of session.submittedUserMessages || []) for (const attachment of message.attachments || []) {
      this.register('session_attachments',session.id,attachment.name || basename(attachment.path),{ path: attachment.path, root: dirname(attachment.path) })
    }
    if (!source || source === 'capabilities') {
      const inventory = await this.deps.capabilities()
      for (const agent of inventory.inventories) for (const item of agent.items) this.register('capabilities',agent.agentId,item.name,{ text: JSON.stringify({ id: item.id, agentId: agent.agentId, kind: item.kind, name: item.name, status: item.status, location: item.location, origin: item.origin }) })
    }
  }
  private async walk(root: string, directory: string, owner: string, depth: number): Promise<void> {
    if (depth > 2 || this.refs.size >= 1000) { this.incomplete = true; return }
    let entries
    try { if ((await lstat(directory)).isSymbolicLink() || !within(await realpath(root),await realpath(directory))) return; entries = await readdir(directory,{ withFileTypes: true }) }
    catch { this.incomplete = true; return }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const path = join(directory,entry.name)
      if (entry.isDirectory()) await this.walk(root,path,owner,depth+1)
      else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(path).toLowerCase())) this.register('requirements',owner,entry.name,{ path,root })
      if (this.refs.size >= 1000) { this.incomplete = true; break }
    }
  }
  private async content(ref: DocumentRef, offset: number, size = 16384): Promise<{ content: string; nextOffset?: number; totalBytes: number }> {
    if (ref.text !== undefined) {
      const buffer = Buffer.from(ref.text)
      if (offset > buffer.length) throw new Error('invalid_document_offset')
      const decoder = new StringDecoder('utf8'), content = decoder.write(buffer.subarray(offset,offset+size))
      const end = offset+Buffer.byteLength(content)
      return { content, nextOffset: end < buffer.length ? end : undefined, totalBytes: buffer.length }
    }
    if (!ref.path || !ref.root || !TEXT_EXTENSIONS.has(extname(ref.path).toLowerCase())) throw new Error('此资料是二进制附件或尚无文本内容，可使用元数据中的本地文件入口')
    const root = await realpath(ref.root), path = await realpath(ref.path)
    if (!within(root,path) || (await lstat(ref.path)).isSymbolicLink()) throw new Error('document_path_out_of_scope')
    const handle = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      const currentPath = await realpath(ref.path), current = await lstat(currentPath)
      if (!within(root,currentPath) || current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino) throw new Error('document_path_changed')
      if (!metadata.isFile() || metadata.size > 16*1024*1024 || offset > metadata.size) throw new Error('document_unavailable_or_too_large')
      if (ref.sha256) {
        const hash = createHash('sha256'), chunk = Buffer.alloc(65536)
        for (let position = 0; position < metadata.size;) { const { bytesRead } = await handle.read(chunk,0,chunk.length,position); if (!bytesRead) break; hash.update(chunk.subarray(0,bytesRead)); position+=bytesRead }
        if (hash.digest('hex') !== ref.sha256) throw new Error('document_snapshot_changed')
      }
      const buffer = Buffer.alloc(size), { bytesRead } = await handle.read(buffer,0,size,offset)
      const content = new StringDecoder('utf8').write(buffer.subarray(0,bytesRead)), end = offset+Buffer.byteLength(content)
      return { content, nextOffset: end < metadata.size ? end : undefined, totalBytes: metadata.size }
    } finally { await handle.close() }
  }
  async call(operation: string, params: Record<string,unknown>): Promise<unknown> {
    if (operation === 'read') {
      if (typeof params.id !== 'string' || !/^doc_[a-f0-9]{24}$/.test(params.id)) throw new Error('invalid_document_id')
      let ref = this.refs.get(params.id)
      if (!ref) { await this.collect(); ref = this.refs.get(params.id) }
      if (!ref) throw new Error('document_not_registered')
      if (ref.source === 'requirements') {
        const owner = this.deps.requirements().find(item => item.id === ref!.ownerId)
        if (!owner || owner.dir !== ref.root || !ref.path || !within(owner.dir,ref.path)) throw new Error('document_owner_changed')
      } else if (ref.source === 'session_attachments') {
        if (!this.deps.sessions().find(item => item.id === ref!.ownerId)?.submittedUserMessages?.some(message => message.attachments?.some(attachment => attachment.path === ref!.path))) throw new Error('document_owner_changed')
      } else if (ref.source === 'team_artifacts') {
        const owner = this.deps.teams().find(item => item.id === ref!.ownerId)
        if (!owner?.artifacts.some(artifact => ref!.path ? artifact.path === ref!.path && artifact.sha256 === ref!.sha256 : artifact.title === ref!.title && artifact.text === ref!.text)) throw new Error('document_owner_changed')
      }
      return { ...ref, text: undefined, root: undefined, ...await this.content(ref,count(params.offset,0,16*1024*1024),Math.max(4,count(params.limit,8192,16384))), offsetUnit: 'UTF-8 bytes', referenceData: true }
    }
    if (params.query !== undefined && (typeof params.query !== 'string' || params.query.length > 1000)) throw new Error('invalid_document_query')
    if (params.source !== undefined && typeof params.source !== 'string') throw new Error('invalid_document_source')
    await this.collect(params.source as string | undefined)
    const query = String(params.query || '').toLowerCase(), matches: Array<Record<string,unknown>> = [], refs = [...this.refs.values()]
    for (let i=0; i<refs.length; i+=8) {
      const batch = await Promise.all(refs.slice(i,i+8).map(async ref => {
        let excerpt = '', match = !query || ref.title.toLowerCase().includes(query)
        if (query && !match) try { const result = await this.content(ref,0); const index = result.content.toLowerCase().indexOf(query); match = index >= 0; if (match) excerpt = result.content.slice(Math.max(0,index-100),index+250); if (result.nextOffset !== undefined) this.incomplete = true }
        catch { this.incomplete = true }
        return match ? { id: ref.id, title: ref.title, source: ref.source, ownerId: ref.ownerId, path: ref.path, excerpt: String(publicManagementValue(excerpt)) } : undefined
      }))
      for (const row of batch) if (row) matches.push(row)
    }
    const offset = count(params.offset,0,100000), limit = Math.max(1,count(params.limit,30,100))
    return { total: matches.length, items: matches.slice(offset,offset+limit), nextOffset: offset+limit < matches.length ? offset+limit : undefined,
      incomplete: this.incomplete, searchWindow: query ? '已登记标题及各文本的前 16 KiB；命中后可按 UTF-8 byte cursor 分段读取全文' : undefined, referenceData: true }
  }
}
