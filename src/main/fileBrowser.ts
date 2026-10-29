import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  FileBrowserEntry,
  FileBrowserListResult,
  FilePreviewOptions,
  FilePreviewResult,
  PickedFile,
  UAEvent
} from '../shared/types'
import { codeLanguageFromExtension } from '../shared/codeLanguage'
import { viewImagePath } from '../shared/viewImage'

export type { FileBrowserEntry, FileBrowserListResult, FilePreviewOptions, FilePreviewResult }

export const MAX_PREVIEW_BYTES = 1.5 * 1024 * 1024
const MAX_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024
export const MAX_FORCE_LINES = 5_000
export const MAX_DIRECTORY_ENTRIES = 2_000
const DEFAULT_FORCE_LINES = 1_000
const BINARY_SNIFF_BYTES = 8 * 1024

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon'
}

export function isRecordedSessionImagePath(events: UAEvent[], path: string): boolean {
  return events.some((event) => {
    if (event.type === 'user_message' && Array.isArray(event.payload?.attachments)) {
      return event.payload.attachments.some((attachment: unknown) => {
        const value = attachment as { kind?: unknown; path?: unknown }
        return value?.kind === 'image' && value.path === path
      })
    }
    return event.type === 'tool_call' && event.state === 'success' && (
      event.payload?.name === 'image_generation' && event.payload?.result?.savedPath === path ||
      viewImagePath(event) === path
    )
  })
}

/** Build attachment metadata and, for a small supported image, its CSP-safe preview. */
export async function pickedFile(path: string, options: FilePreviewOptions = {}): Promise<PickedFile> {
  const name = basename(path) || path
  const ext = extensionOf(path)
  const mime = ext === 'ico' ? undefined : IMAGE_MIME[ext || '']
  const attachment: PickedFile = { kind: mime ? 'image' : 'file', path, name, ...(mime ? { mime } : {}) }
  if (!mime) return attachment

  const preview = await readFileForPreview(dirname(path), name, options)
  return preview.ok && preview.kind === 'image' && preview.dataUrl
    ? { ...attachment, previewDataUrl: preview.dataUrl }
    : attachment
}

type GuardResult =
  | { ok: true; root: string; target: string; rel: string }
  | { ok: false; error: 'missing-root' | 'invalid-path' | 'missing-target' | 'outside-root' }

interface PathIdentity { dev: number; ino: number }

/** Resolve an existing relative path through realpath, confined to the canonical root. */
export async function resolveWithinRoot(root: string | undefined, relPath: string): Promise<string | null> {
  const guarded = await guardPath(root, relPath)
  return guarded.ok ? guarded.target : null
}

export async function resolveHtmlWithinRoot(root: string | undefined, relPath: string): Promise<string | null> {
  if (!['.html', '.htm'].includes(extname(relPath).toLowerCase())) return null
  const target = await resolveWithinRoot(root, relPath)
  if (!target) return null
  try {
    return (await stat(target)).isFile() ? target : null
  } catch {
    return null
  }
}

export async function listDir(
  workdir: string | undefined,
  dirPath = ''
): Promise<FileBrowserListResult> {
  const normalized = normalizeRelative(dirPath)
  const fallback = { root: workdir || '', dirPath: normalized ?? '', entries: [] as FileBrowserEntry[] }
  if (!workdir) return { ok: false, ...fallback, error: '当前会话没有工作目录' }
  if (normalized === null) return { ok: false, ...fallback, error: '无效的相对路径' }

  const guarded = await guardPath(workdir, normalized)
  if (!guarded.ok) {
    return {
      ok: false,
      ...fallback,
      error: guarded.error === 'outside-root' ? '路径超出工作目录' : '无法读取目录'
    }
  }

  try {
    const before = await directoryIdentities(guarded.root, guarded.target)
    const directory = await openNoFollow(guarded.target, true)
    try {
      const directoryStat = await directory.stat()
      if (!directoryStat.isDirectory()) {
        return { ok: false, root: guarded.root, dirPath: guarded.rel, entries: [], error: '目标不是目录' }
      }

      const dirents = []
      const stream = await opendir(guarded.target)
      try {
        for await (const dirent of stream) {
          if (dirents.length === MAX_DIRECTORY_ENTRIES) {
            return {
              ok: false, root: guarded.root, dirPath: guarded.rel, entries: [],
              error: `目录条目过多（最多 ${MAX_DIRECTORY_ENTRIES} 项）`
            }
          }
          dirents.push(dirent)
        }
      } finally {
        await stream.close().catch(() => undefined)
      }

      const entries: FileBrowserEntry[] = []
      for (const dirent of dirents) {
        const path = guarded.rel ? `${guarded.rel}/${dirent.name}` : dirent.name
        const isSymlink = dirent.isSymbolicLink()
        const child = await guardPath(guarded.root, path)
        let kind: FileBrowserEntry['kind'] = dirent.isDirectory() ? 'dir' : 'file'
        let size: number | undefined

        if (child.ok) {
          const childHandle = await openNoFollow(child.target).catch(() => null)
          if (childHandle) {
            try {
              const childStat = await childHandle.stat()
              kind = childStat.isDirectory() ? 'dir' : 'file'
              if (childStat.isFile()) size = childStat.size
            } finally {
              await childHandle.close()
            }
          }
        }

        const ext = kind === 'file' ? extensionOf(dirent.name) : undefined
        entries.push({ name: dirent.name, path, kind, size, ext, isSymlink })
      }

      const after = await stat(guarded.target)
      const chainAfter = await directoryIdentities(guarded.root, guarded.target)
      if (!sameIdentities(before, chainAfter) ||
          after.dev !== directoryStat.dev || after.ino !== directoryStat.ino) {
        return { ok: false, root: guarded.root, dirPath: guarded.rel, entries: [], error: '无法读取目录' }
      }

      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return { ok: true, root: guarded.root, dirPath: guarded.rel, entries }
    } finally {
      await directory.close()
    }
  } catch {
    return { ok: false, root: guarded.root, dirPath: guarded.rel, entries: [], error: '无法读取目录' }
  }
}

export async function readFileForPreview(
  workdir: string | undefined,
  filePath: string,
  options: FilePreviewOptions = {}
): Promise<FilePreviewResult> {
  const normalized = normalizeRelative(filePath)
  const failed = (error: string): FilePreviewResult => ({
    ok: false, path: normalized ?? '', kind: 'binary', size: 0, error
  })
  if (!workdir) return failed('当前会话没有工作目录')
  if (!normalized) return failed(normalized === null ? '无效的相对路径' : '目标不是文件')

  const guarded = await guardPath(workdir, normalized)
  if (!guarded.ok) {
    return failed(guarded.error === 'outside-root' ? '路径超出工作目录' : '无法读取文件')
  }

  try {
    const parent = join(guarded.target, '..')
    const before = await directoryIdentities(guarded.root, parent)
    const handle = await openNoFollow(guarded.target)
    try {
      const fileStat = await handle.stat()
      if (!fileStat.isFile()) return failed('目标不是文件')
      const finish = async <T extends FilePreviewResult>(result: T): Promise<T> => {
        const after = await directoryIdentities(guarded.root, parent)
        const current = await lstat(guarded.target)
        if (!sameIdentities(before, after) || current.isSymbolicLink() ||
            current.dev !== fileStat.dev || current.ino !== fileStat.ino) throw new Error('path_changed')
        return result
      }

      const ext = extensionOf(guarded.target)
      const mime = ext && IMAGE_MIME[ext]
      if (mime) {
        if (fileStat.size > (options.force ? MAX_IMAGE_PREVIEW_BYTES : MAX_PREVIEW_BYTES)) {
          return finish({ ok: true, path: guarded.rel, kind: 'image', size: fileStat.size, tooLarge: true })
        }
        const bytes = await readBytes(handle, fileStat.size)
        return finish({
          ok: true, path: guarded.rel, kind: 'image', size: fileStat.size,
          dataUrl: `data:${mime};base64,${bytes.toString('base64')}`
        })
      }

      if (fileStat.size <= MAX_PREVIEW_BYTES) {
        const bytes = await readBytes(handle, fileStat.size)
        if (bytes.includes(0)) return finish({ ok: true, path: guarded.rel, kind: 'binary', size: fileStat.size })
        return finish(textResult(guarded.rel, fileStat.size, ext, bytes.toString('utf8'), guarded.target))
      }

      if (!options.force) {
        const sniff = await readBytes(handle, Math.min(fileStat.size, BINARY_SNIFF_BYTES))
        return finish(sniff.includes(0)
          ? { ok: true, path: guarded.rel, kind: 'binary', size: fileStat.size, tooLarge: true }
          : { ok: true, path: guarded.rel, kind: 'text', size: fileStat.size, tooLarge: true, language: codeLanguageFromExtension(ext) })
      }

      const lineLimit = boundedLineLimit(options.maxLines)
      const bytes = await readBytes(handle, MAX_PREVIEW_BYTES)
      if (bytes.includes(0)) {
        return finish({ ok: true, path: guarded.rel, kind: 'binary', size: fileStat.size, tooLarge: true })
      }
      return finish({
        ...textResult(guarded.rel, fileStat.size, ext, firstLines(bytes, lineLimit), guarded.target),
        tooLarge: true, truncated: true, lineLimit
      })
    } finally {
      await handle.close()
    }
  } catch {
    return failed('无法读取文件')
  }
}

async function guardPath(root: string | undefined, relPath: string): Promise<GuardResult> {
  if (!root) return { ok: false, error: 'missing-root' }
  const normalized = normalizeRelative(relPath)
  if (normalized === null) return { ok: false, error: 'invalid-path' }

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(resolve(root))
  } catch {
    return { ok: false, error: 'missing-root' }
  }

  const candidate = normalized ? join(canonicalRoot, ...normalized.split('/')) : canonicalRoot
  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(candidate)
  } catch {
    return { ok: false, error: 'missing-target' }
  }

  const fromRoot = relative(canonicalRoot, canonicalTarget)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return { ok: false, error: 'outside-root' }
  }
  return { ok: true, root: canonicalRoot, target: canonicalTarget, rel: normalized }
}

function normalizeRelative(input: string): string | null {
  if (typeof input !== 'string' || input.includes('\0') || win32.isAbsolute(input)) return null
  // Backslash is a valid filename character on POSIX; only treat it as a
  // separator on Windows, where it cannot be part of a filename.
  const slashPath = sep === '\\' ? input.replace(/\\/g, '/') : input
  if (slashPath.startsWith('/')) return null
  const parts = slashPath.split('/').filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) return null
  return parts.join('/')
}

async function openNoFollow(path: string, directory = false) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
  return open(path, flags)
}

async function directoryIdentities(root: string, target: string): Promise<PathIdentity[]> {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside_root')
  const paths = [root]
  let cursor = root
  for (const part of rel ? rel.split(sep) : []) {
    cursor = join(cursor, part)
    paths.push(cursor)
  }
  const identities: PathIdentity[] = []
  for (const path of paths) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_path')
    identities.push({ dev: info.dev, ino: info.ino })
  }
  return identities
}

function sameIdentities(left: PathIdentity[], right: PathIdentity[]): boolean {
  return left.length === right.length &&
    left.every((identity, index) => identity.dev === right[index]?.dev && identity.ino === right[index]?.ino)
}

async function readBytes(handle: Awaited<ReturnType<typeof open>>, count: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(count)
  const { bytesRead } = await handle.read(buffer, 0, count, 0)
  return buffer.subarray(0, bytesRead)
}

function firstLines(bytes: Buffer, maxLines: number): string {
  let newlines = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10 && ++newlines === maxLines) return bytes.subarray(0, i).toString('utf8')
  }
  return bytes.toString('utf8')
}

function boundedLineLimit(requested: number | undefined): number {
  if (!Number.isFinite(requested)) return DEFAULT_FORCE_LINES
  return Math.max(1, Math.min(MAX_FORCE_LINES, Math.trunc(requested!)))
}

function extensionOf(path: string): string | undefined {
  return extname(path).slice(1).toLowerCase() || undefined
}

function textResult(
  path: string,
  size: number,
  ext: string | undefined,
  text: string,
  sourcePath: string
): FilePreviewResult {
  const sourceDirectory = dirname(sourcePath)
  const htmlBaseUrl = ['html', 'htm'].includes(ext || '')
    ? pathToFileURL(sourceDirectory.endsWith(sep) ? sourceDirectory : `${sourceDirectory}${sep}`).href
    : undefined
  return {
    ok: true,
    path,
    kind: 'text',
    size,
    text,
    ...(htmlBaseUrl ? { htmlBaseUrl, htmlUrl: pathToFileURL(sourcePath).href } : {}),
    language: codeLanguageFromExtension(ext)
  }
}
