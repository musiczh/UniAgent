import { mkdir, open, writeFile, rename, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ACPConnection } from './acp/acpConnection.ts'
import { grokNativeHandshake, grokCapabilityAvailable } from './grokNativeCapabilities.ts'
import { resolveUserDataHome } from './userData.ts'

type ForkRecord = { sourceId: string; nativeId?: string; cwd: string; runtime: string; phase: 'creating' | 'created' | 'cached' | 'persistent' | 'deleting' | 'deleted'; createdAt: number }
const processStartedAt = Date.now()
const validId = (id: string): boolean => typeof id === 'string' && /^[\w-]{1,128}$/.test(id)
function ledgerRoot(env: NodeJS.ProcessEnv): string {
  return join(env.UNIAGENT_USER_DATA || (env.HOME ? join(env.HOME,'.uniagent-public') : resolveUserDataHome()),'grok-forks')
}
function runtimeKey(bin: string, env: NodeJS.ProcessEnv): string {
  return createHash('sha256').update(JSON.stringify([bin,env.GROK_HOME || process.env.GROK_HOME,env.HOME || process.env.HOME])).digest('hex')
}
async function saveRecord(path: string, record: ForkRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'})
  await rename(temporary,path)
}
async function readRecord(path: string): Promise<ForkRecord> {
  const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 8192) throw new Error('无效的 Grok 分叉归属记录')
    const record = JSON.parse(await file.readFile('utf8'))
    if (!validId(record?.sourceId) || record.nativeId !== undefined && !validId(record.nativeId) ||
        typeof record.cwd !== 'string' || !isAbsolute(record.cwd) || typeof record.runtime !== 'string' ||
        !Number.isFinite(record.createdAt) || !['creating','created','cached','persistent','deleting','deleted'].includes(record.phase)) throw new Error('无效的 Grok 分叉归属记录')
    return record
  } finally { await file.close() }
}
async function ownedRecord(id: string, bin: string, env: NodeJS.ProcessEnv): Promise<{path:string;record:ForkRecord}> {
  if (!validId(id)) throw new Error('无效的 Grok 分叉 ID')
  const root = ledgerRoot(env)
  for (const name of await readdir(root).catch(() => [])) {
    if (!/^[\da-f-]{36}\.json$/.test(name)) continue
    const path = join(root,name)
    const record = await readRecord(path).catch(() => undefined)
    if (!record) continue
    if (record.nativeId === id && record.runtime === runtimeKey(bin,env) && record.sourceId !== id) return {path,record}
  }
  throw new Error('此 Grok 会话不属于 UniAgent 创建的分叉')
}

/** Only the recorded fork is eligible for cleanup. Unknown outcomes are retained for inspection. */
export async function deleteOwnedGrokFork(id: string, bin: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const {path,record} = await ownedRecord(id,bin,env)
  if (record.phase === 'deleted') return
  if (!['created','cached','deleting'].includes(record.phase)) throw new Error('禁止清理持久化或未确认的 Grok 分叉')
  record.phase = 'deleting'; await saveRecord(path,record)
  const connection = new ACPConnection({bin,args:['--no-auto-update','agent','--no-leader','stdio'],cwd:record.cwd,env:{...process.env,...env},providerLabel:'Grok'})
  try {
    const initialize = await connection.initialize()
    if (!grokCapabilityAvailable(grokNativeHandshake(initialize),'fork')) throw new Error('当前版本尚未验证 Grok 分叉清理')
    const exists = async (): Promise<boolean> => {
      let cursor: string | undefined, found = false
      const cursors = new Set<string>()
      do {
        const listed = await connection.request('session/list',{...(cursor ? {cursor} : {})})
        if (!Array.isArray(listed?.sessions)) throw new Error('Grok 无法确认分叉清理结果')
        found ||= listed.sessions.some((session:any) => session.sessionId === id)
        cursor = typeof listed.nextCursor === 'string' && listed.nextCursor ? listed.nextCursor : undefined
        if (cursor && cursors.has(cursor)) throw new Error('Grok 会话清单分页异常')
        if (cursor) cursors.add(cursor)
      } while(cursor)
      return found
    }
    if (await exists()) {
      await promisify(execFile)(bin,['--no-auto-update','sessions','delete',id],{cwd:record.cwd,env:{...process.env,...env},timeout:15000,maxBuffer:1024*1024})
      if (await exists()) throw new Error('Grok 分叉删除尚未确认')
    }
  } finally {await connection.closeAndWait()}
  record.phase = 'deleted'; await saveRecord(path,record)
}

export async function retainGrokFork(id: string, bin: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const {path,record} = await ownedRecord(id,bin,env)
  if (record.phase === 'persistent') return
  if (!['created','cached'].includes(record.phase)) throw new Error('Grok 分叉尚未确认，不能转为持久会话')
  record.phase = 'persistent'; await saveRecord(path,record)
}

export async function cacheGrokFork(id: string, bin: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const {path,record} = await ownedRecord(id,bin,env)
  if (record.phase === 'created') {record.phase = 'cached';await saveRecord(path,record)}
}

/** Recover only prior-process cleanup; references and explicit Side caches always win. */
export async function recoverGrokForks(bin: string, references: ReadonlySet<string>, env: NodeJS.ProcessEnv = {}, before = processStartedAt): Promise<{cleaned:number;retained:number;failed:number}> {
  const report = {cleaned:0,retained:0,failed:0}
  const root = ledgerRoot(env)
  for (const name of await readdir(root).catch(() => [])) {
    if (!/^[\da-f-]{36}\.json$/.test(name)) continue
    try {
      const record = await readRecord(join(root,name))
      if (record.runtime !== runtimeKey(bin,env) || record.createdAt >= before || record.phase === 'deleted') continue
      if (!record.nativeId || !['created','deleting'].includes(record.phase) || references.has(record.nativeId)) {report.retained++;continue}
      await deleteOwnedGrokFork(record.nativeId,bin,env);report.cleaned++
    } catch {report.failed++}
  }
  return report
}

/** Verified Grok extension; the source is never resumed or prompted by this connection. */
export async function forkBetaSession(
  provider: 'kimi' | 'grok',
  sourceNativeId: string,
  bin: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ nativeId: string; cwd?: string; model?: string; kimiThinking?: string }> {
  if (provider !== 'grok') throw new Error('稳定 ACP 未开放分叉；session/fork 仍属于 UNSTABLE。')
  if (!validId(sourceNativeId) || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('无效的 Grok 分叉 ID 或工作目录')
  // Grok keys session storage by the supplied cwd spelling; /var and /private/var are not interchangeable here.
  await realpath(cwd)
  const workdir = cwd
  const connection = new ACPConnection({bin,args:['--no-auto-update','agent','--no-leader','stdio'],cwd:workdir,env:{...process.env,...extraEnv},providerLabel:'Grok'})
  let createdId: string | undefined
  try {
    const initialize = await connection.initialize()
    if (!grokCapabilityAvailable(grokNativeHandshake(initialize),'fork')) throw new Error('当前 Grok 版本未验证原生分叉，稳定 ACP 的 session/fork 仍属于 UNSTABLE。')
    const root = ledgerRoot(extraEnv)
    await mkdir(root,{recursive:true,mode:0o700})
    const path = join(root,`${randomUUID()}.json`)
    const record: ForkRecord = {sourceId:sourceNativeId,cwd:workdir,runtime:runtimeKey(bin,extraEnv),phase:'creating',createdAt:Date.now()}
    await saveRecord(path,record)
    const result = await connection.request('_x.ai/session/fork',{sourceSessionId:sourceNativeId,sourceCwd:workdir,newCwd:workdir})
    if (!validId(result?.newSessionId) || result.newSessionId === sourceNativeId) throw new Error('Grok 未返回独立分叉 ID；请核对后再重试')
    createdId = result.newSessionId
    record.nativeId = createdId; record.phase = 'created'; await saveRecord(path,record)
    const loaded = await connection.request('session/load',{sessionId:createdId,cwd:workdir,mcpServers:[]})
    if (loaded?.sessionId && loaded.sessionId !== createdId) throw new Error('Grok 分叉验证返回了其它会话')
    await connection.request('session/close',{sessionId:createdId},2000).catch(() => {})
    return {nativeId:createdId!,cwd:workdir}
  } catch (error) {
    await connection.closeAndWait()
    if (createdId) await deleteOwnedGrokFork(createdId,bin,extraEnv).catch(() => {})
    throw error
  } finally { await connection.closeAndWait() }
}
