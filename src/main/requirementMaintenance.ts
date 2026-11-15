import { Worker } from 'node:worker_threads'
import type { Requirement, RequirementStoragePreview } from '../shared/requirementTypes'
import { documentContent, requirementDocumentPath, type RequirementSnapshot } from './requirementSpace'

// Legacy archives can be large. Scanning, compression, verification and cleanup stay off the UI thread.
const code = `
const { parentPort, workerData: input } = require('node:worker_threads')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
function safe(relative) {
  let target = input.root
  for (const part of ['', ...relative.split('/')]) {
    if (part === '..' || part.includes('\\\\')) throw Error('无效的旧资料路径')
    target = path.join(target, part)
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Error('旧资料包含符号链接，未清理')
  }
  return target
}
try {
  const paths = [...input.projections]
  // Early versions copied the same user input into many hash-named Markdown files.
  // Keep one original per byte-identical input and every explicitly referenced copy.
  const originals = new Set()
  if (fs.existsSync(safe('sources'))) for (const name of fs.readdirSync(safe('sources')).sort()) {
    if (!/^[a-f0-9]{20}\\.md$/.test(name) || input.references.some(uri=>uri.includes(name))) continue
    const text = fs.readFileSync(safe('sources/' + name), 'utf8')
    if (!text.startsWith('# 用户原始输入\\n\\n')) continue
    const fingerprint = hash(text)
    if (originals.has(fingerprint)) paths.push('sources/' + name)
    else originals.add(fingerprint)
  }
  for (const [dir, pattern] of [['.uniagent/revisions', /^[a-f0-9]{64}\\.json$/], ['.uniagent/bodies', /^[a-f0-9]{64}\\.md$/]]) {
    if (fs.existsSync(safe(dir))) for (const name of fs.readdirSync(safe(dir))) if (pattern.test(name)) paths.push(dir + '/' + name)
  }
  const entries = []
  let bytes = 0
  for (const relative of [...new Set(paths)].sort()) {
    const file = safe(relative)
    if (!fs.existsSync(file)) continue
    if (!fs.lstatSync(file).isFile()) throw Error('旧资料类型无效')
    bytes += fs.statSync(file).size
    if (bytes > 512000000) throw Error('旧资料超过单次 512 MB 整理范围')
    const content = fs.readFileSync(file)
    entries.push({ path: relative, hash: hash(content), content: content.toString('base64') })
  }
  const token = hash(JSON.stringify([input.revision, entries.map(({path,hash})=>[path,hash])]))
  const archive = '.uniagent/legacy-' + token.slice(0,20) + '.json.gz'
  if (input.action !== 'preview') {
    if (token !== input.token) throw Error('资料已变化，请重新预览清理范围')
    if (entries.length) {
      const archivePath = safe(archive)
      if (input.action === 'archive') {
        const compressed = zlib.gzipSync(JSON.stringify({ version: 1, revision: input.revision, entries }))
        const temp = archivePath + '.tmp'
        fs.writeFileSync(temp, compressed, {mode: 0o600})
        const fd = fs.openSync(temp, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(temp, archivePath)
      }
      const restored = JSON.parse(zlib.gunzipSync(fs.readFileSync(archivePath), { maxOutputLength: 720000000 }).toString())
      if (restored.revision !== input.revision || restored.entries.length !== entries.length || restored.entries.some((entry,i)=> entry.path !== entries[i].path || hash(Buffer.from(entry.content,'base64')) !== entries[i].hash)) throw Error('备份校验失败，未清理')
      if (input.action === 'cleanup') for (const entry of entries) fs.unlinkSync(safe(entry.path))
    }
  }
  parentPort.postMessage({files:entries.length,bytes,token,revision:input.revision,archive:entries.length?archive:undefined})
} catch(error) { parentPort.postMessage({error:error.message}) }
`
export async function maintainRequirement(r: Requirement, snapshot: RequirementSnapshot, action: 'preview' | 'archive' | 'cleanup', token?: string): Promise<RequirementStoragePreview> {
  const projections = Object.values(snapshot.documents).filter(doc => !['core', 'state'].includes(doc.kind)).map(requirementDocumentPath)
  const contents = await Promise.all(Object.values(snapshot.documents).map(doc=>documentContent(r,doc)))
  return new Promise((resolve, reject) => {
    const references = [...contents, ...Object.values(snapshot.documents).flatMap(doc=>doc.sources.map(source=>source.uri || ''))]
    const worker = new Worker(code, { eval: true, workerData: { root: r.dir, revision: snapshot.revision, projections, references, action, token } })
    worker.once('message', value => { value.error ? reject(new Error(value.error)) : resolve(value); void worker.terminate() })
    worker.once('error', reject)
    worker.once('exit', code => { if (code) reject(new Error('旧资料整理进程退出')) })
  })
}
