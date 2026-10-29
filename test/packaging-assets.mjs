import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'
import { build, loadConfigFromFile } from 'vite'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageConfig = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).build
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const { doMergeConfigs } = libraryRequire('./util/config/config.js')
const { getMainFileMatchers, getNodeModuleFileMatcher, getFileMatchers } = libraryRequire('./fileMatcher.js')
const { AsarPackager } = libraryRequire('./asar/asarUtil.js')
const { CancellationToken } = libraryRequire('builder-util-runtime')
const asar = builderRequire('@electron/asar')
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(project, 'electron.vite.config.ts'))

async function put(root, file, content) {
  await mkdir(dirname(join(root, file)), { recursive: true })
  await writeFile(join(root, file), content)
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ua-package-assets-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function packager(root) {
  const config = doMergeConfigs([structuredClone(packageConfig)])
  return { projectDir: root, config, info: {
    projectDir: root, config, buildResourcesDir: 'build', isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false }, cancellationToken: new CancellationToken()
  } }
}

async function files(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await files(file))
    else if (entry.isFile()) result.push(file)
  }
  return result
}

async function selectedRenderer(root, pack) {
  if (pack.config.beforePack) {
    const hook = await import(pathToFileURL(resolve(project, pack.config.beforePack)).href)
    await hook.default({ packager: pack })
  }
  const destination = join(root, 'app')
  const matchers = getMainFileMatchers(root, destination, value => value, {}, pack, join(root, 'release'), false)
  const selected = new Map()
  for (const matcher of matchers) {
    const filter = matcher.createFilter()
    for (const file of await files(matcher.from)) {
      const target = relative(join(destination, 'out/renderer'), resolve(matcher.to, relative(matcher.from, file)))
      if (!target.startsWith('..') && filter(file, lstatSync(file))) selected.set(target, file)
    }
  }
  return selected
}

test('packaging selects only the current build, including lazy chunks, workers and public files', async t => {
  const root = await fixture(t)
  await put(root, 'package.json', '{"type":"module"}')
  await put(root, 'src/index.html', '<script type="module" src="./index.js"></script>')
  await put(root, 'src/boot.html', '<script type="module" src="./boot.js"></script>')
  await put(root, 'src/index.js', 'import "./style.css"; window.loadDiagram = () => import("./diagram.js"); new Worker(new URL("./worker.js", import.meta.url), { type: "module" });')
  await put(root, 'src/boot.js', 'console.log("boot")')
  await put(root, 'src/worker.js', 'self.postMessage("worker ready")')
  await put(root, 'src/style.css', 'body { color: red }')
  await put(root, 'src/public/html-preview.html', '<p>offline preview</p>')
  await put(root, 'out/renderer/assets/obsolete.js', 'old open app resource')
  const counts = []
  for (const version of ['first', 'second', 'third']) {
    await put(root, 'src/diagram.js', `export const value = "${version}"`)
    const output = await build({
      configFile: false, root: join(root, 'src'), base: './', logLevel: 'silent',
      plugins: config.renderer.plugins.filter(plugin => plugin?.name === 'uniagent-renderer-package'),
      build: { outDir: join(root, 'out/renderer'), emptyOutDir: config.renderer.build.emptyOutDir,
        rollupOptions: { input: { index: join(root, 'src/index.html'), boot: join(root, 'src/boot.html') } } }
    })
    const pack = packager(root)
    const selected = await selectedRenderer(root, pack)
    assert.equal(selected.has('assets/obsolete.js'), false, 'old output must not be packaged')
    const expected = [...output.output.map(entry => entry.fileName), 'html-preview.html'].sort()
    assert.deepEqual([...selected.keys()].sort(), expected)
    const diagram = expected.find(name => /\/diagram-.*\.js$/.test(name))
    assert.ok(diagram, 'lazy diagram module is emitted')
    assert.ok(expected.some(name => /\/worker-.*\.js$/.test(name)), 'worker is emitted')
    assert.equal((await import(pathToFileURL(selected.get(diagram)).href)).value, version)
    assert.equal(await readFile(selected.get('html-preview.html'), 'utf8'), '<p>offline preview</p>')
    await writeFile(join(root, 'out/renderer/index.html'), 'later development output')
    assert.notEqual(await readFile(selected.get('index.html'), 'utf8'), 'later development output', 'the snapshot is independent of subsequent output changes')
    assert.equal(await readFile(join(root, 'out/renderer/assets/obsolete.js'), 'utf8'), 'old open app resource')
    const resources = join(root, version + '-resources')
    const unpack = getFileMatchers(pack.config, 'asarUnpack', join(resources, 'app'), {
      defaultSrc: root, globalOutDir: join(root, 'release'), customBuildOptions: {}, macroExpander: value => value
    })[0].createFilter()
    const packageFiles = [...selected.values()].sort()
    await new AsarPackager(root, resources, { smartUnpack: false }, unpack).pack([{
      src: dirname(selected.get('index.html')), destination: join(resources, 'app/out/renderer'),
      files: packageFiles, metadata: new Map(packageFiles.map(file => [file, lstatSync(file)]))
    }], { info: pack.info })
    for (const file of expected) {
      assert.equal(asar.statFile(join(resources, 'app.asar'), 'out/renderer/' + file).unpacked, true, 'renderer files retain their physical runtime path')
      assert.deepEqual(await readFile(join(resources, 'app.asar.unpacked/out/renderer', file)), await readFile(selected.get(file)))
    }
    counts.push(selected.size)
    const { cleanupRendererPackage } = await import('../scripts/package-files.mjs')
    await cleanupRendererPackage(pack)
    await assert.rejects(readFile(selected.get('index.html')), { code: 'ENOENT' }, 'the completed package releases its snapshot')
  }
  assert.equal(new Set(counts).size, 1, 'repeated builds do not accumulate packaged files')
})

test('packaging fails closed for missing snapshots, invalid paths and missing entries', async t => {
  const root = await fixture(t)
  const { default: beforePack } = await import('../scripts/package-files.mjs')
  await assert.rejects(beforePack({ packager: packager(root) }), /run pnpm run build first/)
  const directory = '.renderer-package-fixture'
  const entries = ['index.html', 'boot.html', 'html-preview.html']
  for (const file of entries) await put(root, `out/${directory}/${file}`, file)
  const manifestPath = join(root, 'out/renderer-package.json')
  for (const manifest of [
    { directory: '../outside', files: entries },
    { directory, files: [...entries, '../escape.js'] },
    { directory, files: [...entries, '/absolute.js'] },
    { directory, files: entries.filter(file => file !== 'boot.html') },
    { directory, files: [...entries, 'assets/missing.js'] }
  ]) {
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(beforePack({ packager: packager(root) }))
  }
})

test('dependency filters discard maps and known build-only files while preserving runtime files', async t => {
  const root = await fixture(t)
  const pack = packager(root)
  const matcher = getNodeModuleFileMatcher(root, join(root, 'app'), value => value, {}, pack.info)
  const filter = matcher.createFilter()
  for (const [file, included] of [
    ['node_modules/mermaid/dist/mermaid.js.map', false],
    ['node_modules/cytoscape-fcose/demo/demo.gif', false],
    ['node_modules/cytoscape-cose-bilkent/demo/index.html', false],
    ['node_modules/better-sqlite3/deps/sqlite3/sqlite3.c', false],
    ['node_modules/better-sqlite3/src/database.lzz', false],
    ['node_modules/better-sqlite3/build/Release/test_extension.node', false],
    ['node_modules/better-sqlite3/build/Release/better_sqlite3.node', true],
    ['node_modules/better-sqlite3/lib/index.js', true],
    ['node_modules/bindings/bindings.js', true],
    ['node_modules/protobufjs/minimal.js', true],
    ['node_modules/mermaid/dist/mermaid.core.mjs', true],
    ['node_modules/mermaid/LICENSE', true]
  ]) {
    await put(root, file, 'fixture')
    assert.equal(filter(join(root, file), lstatSync(join(root, file))), included, file)
  }
})
