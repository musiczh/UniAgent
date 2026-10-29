import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path'

const manifestName = 'renderer-package.json'
const snapshots = new WeakMap()

async function listFiles(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = posix.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await listFiles(join(directory, entry.name), name))
    else if (entry.isFile()) result.push(name)
  }
  return result.sort()
}

export function rendererPackagePlugin() {
  let config
  return {
    name: 'uniagent-renderer-package',
    apply: 'build',
    configResolved(value) { config = value },
    async writeBundle(_options, bundle) {
      const output = dirname(resolve(config.root, config.build.outDir))
      const snapshot = await mkdtemp(join(output, '.renderer-package-'))
      if (config.publicDir) await cp(config.publicDir, snapshot, { recursive: true, dereference: true })
      // Use this build's in-memory output, never the directory containing old hashes.
      await Promise.all(Object.values(bundle).map(async entry => {
        const file = join(snapshot, entry.fileName)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, entry.type === 'chunk' ? entry.code : entry.source)
      }))
      const manifest = { directory: basename(snapshot), files: await listFiles(snapshot) }
      const temporary = join(snapshot, manifestName)
      await writeFile(temporary, JSON.stringify(manifest) + '\n')
      await rename(temporary, join(output, manifestName))
    }
  }
}

export default async function beforePack({ packager }) {
  const output = join(packager.projectDir, 'out')
  let manifest
  try { manifest = JSON.parse(await readFile(join(output, manifestName), 'utf8')) }
  catch (cause) { throw new Error('Renderer packaging snapshot is missing or invalid; run pnpm run build first', { cause }) }
  if (!/^\.renderer-package-[A-Za-z0-9]+$/.test(manifest.directory)
    || !Array.isArray(manifest.files) || manifest.files.length === 0
    || manifest.files.some(file => typeof file !== 'string' || isAbsolute(file)
      || file.includes('\\') || file.includes('\0') || file.startsWith('../') || posix.normalize(file) !== file)
    || !['index.html', 'boot.html', 'html-preview.html'].every(file => manifest.files.includes(file))) {
    throw new Error('Invalid renderer packaging snapshot or missing HTML entry')
  }
  const snapshot = join(output, manifest.directory)
  for (const file of manifest.files) {
    if (!(await stat(join(snapshot, file))).isFile()) throw new Error(`Missing renderer package file: ${file}`)
  }
  const renderer = packager.config.files.find(file => file.to === 'out/renderer')
  if (!renderer) throw new Error('Renderer package file mapping is missing')
  renderer.from = snapshot
  renderer.filter = manifest.files
  snapshots.set(packager, snapshot)
}

export async function cleanupRendererPackage(packager) {
  const snapshot = snapshots.get(packager)
  if (!snapshot) return
  snapshots.delete(packager)
  await rm(snapshot, { recursive: true, force: true })
}
