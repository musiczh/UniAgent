import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveUserDataHome } from './userData.ts'
import type { UASubAgent, UAEvent } from '../shared/types.ts'

const writes = new Map<string,Promise<void>>()
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,128}$/.test(id)
function childPath(parent: string, child: string, env: NodeJS.ProcessEnv): {root:string;path:string} {
  if (!validId(parent) || !validId(child)) throw new Error('无效的 Grok 子 Agent 归属')
  const root = join(env.UNIAGENT_USER_DATA || (env.HOME ? join(env.HOME,'.uniagent-public') : resolveUserDataHome()),'grok-child-history')
  return {root,path:join(root,createHash('sha256').update(JSON.stringify([parent,child])).digest('hex')+'.json')}
}

/** Only notifications received on the owned parent connection enter this cache. */
export function saveGrokChildHistory(parent: string, child: UASubAgent, events: UAEvent[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  if (child.parentThreadId !== parent || !validId(child.nativeTaskId)) return Promise.reject(new Error('Grok 子 Agent 归属不匹配'))
  const {root,path} = childPath(parent,child.agentThreadId,env)
  const snapshot = JSON.stringify({parent,child:child.agentThreadId,nativeTaskId:child.nativeTaskId,events:events.slice(-5000)})
  if (Buffer.byteLength(snapshot) > 8 * 1024 * 1024) return Promise.reject(new Error('Grok 子 Agent 历史超过缓存上限'))
  const pending = (writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(root,{recursive:true,mode:0o700})
    const temp = path+'.'+randomUUID()+'.tmp'
    await writeFile(temp,snapshot,{flag:'wx',mode:0o600});await rename(temp,path)
  }).finally(() => {if(writes.get(path) === pending) writes.delete(path)})
  writes.set(path,pending);return pending
}

/** Cold detail reads never open a second ACP connection or resume a child. */
export async function readGrokChildHistory(parent: string, child: UASubAgent, env: NodeJS.ProcessEnv = {}): Promise<UAEvent[]> {
  if (child.parentThreadId !== parent || !validId(child.nativeTaskId)) return []
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    const {path} = childPath(parent,child.agentThreadId,env)
    await writes.get(path)
    file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) return []
    const saved = JSON.parse(await file.readFile('utf8'))
    if (saved.parent !== parent || saved.child !== child.agentThreadId || saved.nativeTaskId !== child.nativeTaskId || !Array.isArray(saved.events)) return []
    return saved.events.filter((event:any) => event && typeof event.type === 'string' && event.payload && typeof event.payload === 'object')
  } catch {return []}
  finally {await file?.close()}
}

export async function flushGrokChildHistory(): Promise<void> { await Promise.allSettled([...writes.values()]) }
