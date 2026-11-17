import { mkdtemp, rm } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { execFile, spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { privateNodeBin } from './deepseekNodeRuntime'
import { resolveUserDataHome } from './userData'

const execFileP = promisify(execFile)

/**
 * DeepSeek session bundles are a concatenated-frame Zstandard container: every
 * appended event batch is its own frame. Node's Zstandard API decodes a single
 * frame per call, so decoding such a bundle directly yields only the session
 * header. Walk the frame structure and decode every frame separately instead.
 * The final frame may still be torn while a session is being written; it is
 * skipped and recovered by the next refresh.
 */
const ZSTD_FRAME_DECODER = `
const fs = require('node:fs')
const { zstdDecompressSync } = require('node:zlib')
function decodeZstd(input, strict = false) {
  const chunks = []
  let offset = 0
  let decodedEnd = 0
  while (offset < input.length) {
    const start = offset
    if (input.length - offset < 4 || input.readUInt32LE(offset) !== 0xfd2fb528) {
      throw new Error('invalid frame magic at byte ' + offset)
    }
    offset += 4
    if (offset === input.length) break
    const descriptor = input[offset++]
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit at byte ' + (offset - 1))
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (input.length - offset < headerBytes) break
    offset += headerBytes
    let lastBlock = false
    let torn = false
    while (!lastBlock) {
      if (input.length - offset < 3) { torn = true; break }
      const block = input.readUIntLE(offset, 3)
      offset += 3
      lastBlock = (block & 1) !== 0
      const blockType = (block >>> 1) & 3
      if (blockType === 3) throw new Error('reserved block type at byte ' + (offset - 3))
      const payloadBytes = blockType === 1 ? 1 : block >>> 3
      if (input.length - offset < payloadBytes) { torn = true; break }
      offset += payloadBytes
    }
    if (torn) break
    if (checksum) {
      if (input.length - offset < 4) break
      offset += 4
    }
    chunks.push(zstdDecompressSync(input.subarray(start, offset)))
    decodedEnd = offset
  }
  if (strict && (decodedEnd !== input.length || chunks.length === 0)) throw new Error('incomplete Zstandard frame')
  return Buffer.concat(chunks)
}
`
const ZSTD_DECODE_SCRIPT = `${ZSTD_FRAME_DECODER}
process.stdout.write(decodeZstd(fs.readFileSync(process.argv[1]), process.argv[2] === 'strict'))
`
const ZSTD_BATCH_DECODE_SCRIPT = `${ZSTD_FRAME_DECODER}
const jobs = JSON.parse(fs.readFileSync(0, 'utf8'))
for (const job of jobs) {
  try {
    fs.writeFileSync(job.dst, decodeZstd(fs.readFileSync(job.src), true), { mode: 0o600 })
  } catch (error) {
    fs.writeFileSync(job.error, String((error && error.message) || error))
  }
}
`

let decoderNodePromise: Promise<string> | undefined

/**
 * External Node runtime with Zstandard support. Electron's bundled Node predates
 * the API, so the ledger decoder runs in the Node that DeepSeek itself requires:
 * the app-private runtime when one was installed, otherwise the user's `node`.
 */
function decoderNode(): Promise<string> {
  decoderNodePromise ??= (async () => {
    const override = process.env.UNIAGENT_TOKEN_NODE_BIN
    if (override) {
      if (await nodeSupportsZstd(override)) return override
      throw new Error('native_usage_decoder_unavailable')
    }
    const candidates: string[] = []
    try {
      const bin = privateNodeBin(join(resolveUserDataHome(), 'deepseek'))
      if (bin) candidates.push(join(bin, process.platform === 'win32' ? 'node.exe' : 'node'))
    } catch { /* a damaged private-runtime record must not break the stats panel */ }
    candidates.push('node')
    for (const candidate of candidates) if (await nodeSupportsZstd(candidate)) return candidate
    throw new Error('native_usage_decoder_unavailable')
  })().catch((error: unknown) => {
    // Allow a later install/repair of Node to be picked up without an app restart.
    decoderNodePromise = undefined
    throw error
  })
  return decoderNodePromise
}

async function nodeSupportsZstd(command: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(command, ['-p', "typeof require('node:zlib').zstdDecompressSync"], { timeout: 8_000 })
    return stdout.trim() === 'function'
  } catch {
    return false
  }
}

function jsonLine(line: string): any | undefined {
  let item: any
  try { item = JSON.parse(line) } catch { return undefined }
  return item && typeof item === 'object' && !Array.isArray(item) ? item : undefined
}

async function* zstdJsonLines(file: string): AsyncGenerator<any> {
  const command = await decoderNode()
  const child = spawn(command, ['-e', ZSTD_DECODE_SCRIPT, file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < 2_000) stderr = (stderr + chunk).slice(0, 2_000) })
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => {
      // A failed spawn never opens stdout; close the reader instead of waiting forever.
      // Re-probe next time: the runtime may have been removed or replaced.
      decoderNodePromise = undefined
      child.stdout?.destroy()
      resolve({ code: null, error })
    })
    child.once('close', (code) => resolve({ code }))
  })
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const item = jsonLine(line)
      if (item) yield item
    }
    const { code, error } = await completion
    if (error || code !== 0) {
      const reason = error ? (error as NodeJS.ErrnoException).code || error.message : code
      throw new Error(`native_usage_decode_failed:${reason}${stderr ? `:${stderr.trim().slice(-200)}` : ''}`)
    }
  } finally {
    lines.close()
    child.stdout?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

export async function* nativeJsonLines(file: string): AsyncGenerator<any> {
  if (file.endsWith('.zstd') || file.endsWith('.zst')) {
    yield* zstdJsonLines(file)
    return
  }
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const item = jsonLine(line)
      if (item) yield item
    }
  } finally {
    lines.close()
  }
}

/** Codex compresses closed rollouts as `rollout-*.jsonl.zst`. */
export const isCompressedRollout = (file: string): boolean =>
  file.endsWith('.jsonl.zst') || file.endsWith('.jsonl.zstd')

/**
 * Decode a compressed rollout into a plaintext temp file. Codex uses one
 * Zstandard frame per file; the shared decoder also handles concatenated frames.
 */
async function decodeRolloutToFile(file: string, target: string): Promise<void> {
  const command = await decoderNode()
  const child = spawn(command, ['-e', ZSTD_DECODE_SCRIPT, file, 'strict'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < 2_000) stderr = (stderr + chunk).slice(0, 2_000) })
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => {
      decoderNodePromise = undefined
      child.stdout?.destroy()
      resolve({ code: null, error })
    })
    child.once('close', (code) => resolve({ code }))
  })
  try {
    await pipeline(child.stdout!, createWriteStream(target, { mode: 0o600 }))
    const { code, error } = await completion
    if (error || code !== 0) {
      const reason = error ? (error as NodeJS.ErrnoException).code || error.message : code
      throw new Error(`native_usage_decode_failed:${reason}${stderr ? `:${stderr.trim().slice(-200)}` : ''}`)
    }
  } finally {
    child.stdout?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

export interface RolloutDecodeRequest { src: string; dst: string; error: string }

/**
 * Decode many compressed rollouts in ONE external Node process. Spawning one
 * process per rollout dominates a cold full-history scan (1382 files here);
 * batching keeps that scan to seconds instead of minutes.
 */
export async function decodeRolloutBatch(jobs: RolloutDecodeRequest[]): Promise<void> {
  if (!jobs.length) return
  const command = await decoderNode()
  const child = spawn(command, ['-e', ZSTD_BATCH_DECODE_SCRIPT], {
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: 300_000
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < 2_000) stderr = (stderr + chunk).slice(0, 2_000) })
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => {
      decoderNodePromise = undefined
      resolve({ code: null, error })
    })
    child.once('close', (code) => resolve({ code }))
  })
  try {
    child.stdin?.end(JSON.stringify(jobs))
    const { code, error } = await completion
    if (error || code !== 0) {
      const reason = error ? (error as NodeJS.ErrnoException).code || error.message : code
      throw new Error(`native_usage_decode_failed:${reason}${stderr ? `:${stderr.trim().slice(-200)}` : ''}`)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

/** Decode away from Electron's main thread and keep the native file untouched. */
export async function withDecodedHistoryFile<T>(file: string, run: (path: string) => Promise<T>): Promise<T> {
  if (!isCompressedRollout(file)) return run(file)
  const directory = await mkdtemp(join(tmpdir(), 'ua-history-decode-'))
  try {
    const target = join(directory, 'rollout.jsonl')
    await decodeRolloutToFile(file, target)
    return await run(target)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
}
