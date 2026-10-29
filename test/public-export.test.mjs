import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { exportPublic, publicPackage, publicSource, stripInternalRegions } from '../scripts/export-public.mjs'

assert.equal(stripInternalRegions('a/* @internal:start x */secret/* @internal:end x */b'), 'ab')
assert.equal(stripInternalRegions('a{/* @internal:start x */}secret{/* @internal:end x */}b'), 'ab')
assert.equal(stripInternalRegions('control={/* @internal:start x */private?left:/* @internal:end x */generic}'), 'control={generic}', 'inline JSX expression comments preserve their expression braces')
for (const source of ['/* @internal:start x */', '/* @internal:end x */', '/* @internal:start x *//* @internal:end y */', '/* @internal:start x *//* @internal:start y */']) {
  assert.throws(() => stripInternalRegions(source), /internal region/)
}
const privateUrl = 'https://' + 'code.byted.org/private'
assert.throws(() => publicSource(`const url=${JSON.stringify(privateUrl)}`, 'src/main/new-private.ts'), /Private runtime dependency/)
assert.equal(publicSource("const file='.uniagent-public/manifest.json'", 'src/main/requirementSpace.ts'), "const file='.uniagent-public/manifest.json'", 'project metadata format is shared by both editions')
assert.equal(publicSource("const home=resolveUserDataHome(join(homedir(), '.uniagent-public'))", 'src/main/requirementStore.ts'), "const home=resolveUserDataHome(join(homedir(), '.uniagent-public'))", 'application profiles remain isolated')
const agents = publicSource("export const BUILTIN_AGENTS=[{id:'codex',name:'Codex'},{id:'traex',name:'private'},{id:'nika',name:'internal'},{id:'claude',name:'Claude'}]", 'src/main/agents.ts')
assert.deepEqual(Function(agents.replace('export ', '') + ';return BUILTIN_AGENTS')().map(agent => agent.id), ['codex', 'claude'])

const root = await mkdtemp(join(tmpdir(), 'uniagent-public-export-'))
const sourceRoot = join(root, 'source')
await mkdir(sourceRoot)
const git = (...args) => execFileSync('git', ['-C', sourceRoot, ...args], { stdio: 'pipe' })
try {
  git('init')
  for (const [path, value] of Object.entries({
    'package.json': JSON.stringify({ version: '1.1.0', keywords: ['codex', 'traex'], scripts: { build: 'build', 'test:packaged': 'node test/cdp-fixture.mjs release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent codex' }, build: {} }),
    'src/shared/distribution.ts': 'export const INTERNAL_DISTRIBUTION=true',
    'src/main/releaseSource.ts': "export * from './bitsReleaseSource'",
    'src/main/kaboo.ts': 'private service',
    'src/main/localModelCli.ts': 'private package',
    'src/main/nika/runner.ts': 'private runtime',
    'src/renderer/components/NikaSettings.tsx': 'private setup',
    'test/nika-runner.ts': 'private runtime regression',
    'src/main/example.ts': "export const directory='.uniagent-public'",
    'src/renderer/boot.html': '<title>UniAgent</title><h1 id="ua-startup-title">UniAgent</h1>',
    'scripts/pack-debug.mjs': await readFile(new URL('../scripts/pack-debug.mjs', import.meta.url), 'utf8'),
    'scripts/sync-download-page.mjs': 'private website publisher',
    'test/cdp-fixture.mjs': `export const program='UniAgent';export const binary='release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent';export const allowed=value=>value.endsWith('/Contents/MacOS/UniAgent');export const renderer=value=>value.replace('/MacOS/UniAgent','/Resources/renderer');if(process.argv[1]?.endsWith('cdp-fixture.mjs'))console.log(JSON.stringify(process.argv.slice(2)))`,
    'docs/private.md': 'internal document',
    'untracked.txt': 'untracked file'
  })) { await mkdir(dirname(join(sourceRoot, path)), { recursive: true }); await writeFile(join(sourceRoot, path), value) }
  git('add', 'package.json', 'src', 'docs', 'scripts', 'test')
  git('-c', 'user.name=Public Export Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture')
  const first = await exportPublic({ sourceRoot, destination: join(root, 'first') })
  const second = await exportPublic({ sourceRoot, destination: join(root, 'second') })
  assert.equal(first.fingerprint, second.fingerprint, 'same committed source is deterministic')
  for (const path of ['src/main/kaboo.ts', 'src/main/localModelCli.ts', 'src/main/nika/runner.ts', 'src/renderer/components/NikaSettings.tsx', 'test/nika-runner.ts', 'scripts/sync-download-page.mjs', 'docs/private.md', 'untracked.txt', '.git']) {
    await assert.rejects(readFile(join(first.destination, path)), { code: 'ENOENT' })
  }
  const pkg = JSON.parse(await readFile(join(first.destination, 'package.json')))
  assert.equal(pkg.repository.url, 'git+https://github.com/musiczh/UniAgent.git')
  assert.equal(pkg.homepage, 'https://musiczh.github.io/UniAgent/')
  assert.equal(pkg.name, 'uniagent-public')
  assert.equal(pkg.productName, 'UniAgent Public')
  assert.equal(pkg.build.appId, 'com.uniagent.public')
  assert.equal(pkg.build.productName, 'UniAgent Public')
  assert.equal(pkg.build.dmg.artifactName, 'UniAgent-Public-${version}-${arch}.${ext}')
  assert.equal(await readFile(join(first.destination, 'src/renderer/boot.html'), 'utf8'), '<title>UniAgent Public</title><h1 id="ua-startup-title">UniAgent Public</h1>')
  assert.deepEqual(pkg.keywords, ['codex'])
  const distributionJs = ts.transpileModule(await readFile(join(first.destination, 'src/shared/distribution.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText
  const distribution = await import('data:text/javascript;base64,' + Buffer.from(distributionJs).toString('base64'))
  for (const id of ['traex', 'nika']) {
    assert.equal(distribution.isDistributionAgent(id), false)
    assert.equal(distribution.isDistributionAgent('custom', id), false)
  }
  for (const id of ['codex', 'claude', 'grok', 'kimi', 'deepseek', 'mcode', 'zcode']) assert.equal(distribution.isDistributionAgent(id), true)
  const cdp = await import(pathToFileURL(join(first.destination, 'test/cdp-fixture.mjs')))
  assert.equal(cdp.program, 'UniAgent Public')
  assert.equal(cdp.binary, 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
  assert.equal(cdp.allowed(cdp.binary), true)
  assert.equal(cdp.allowed('/private/Contents/MacOS/' + 'UniAgent'), false)
  assert.equal(cdp.renderer(cdp.binary), 'release/mac-arm64/UniAgent Public.app/Contents/Resources/renderer')
  const argv = JSON.parse(execFileSync('/bin/sh', ['-c', pkg.scripts['test:packaged']], { cwd: first.destination, encoding: 'utf8' }))
  assert.deepEqual(argv, [cdp.binary, 'codex'], 'a packaged verification command must pass the path containing spaces as one argument')
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    // Exercise the real debug script with a local builder fixture, without compiling Electron twice.
    const bin = join(root, 'bin'), pnpm = join(bin, 'pnpm')
    await mkdir(bin)
    await writeFile(pnpm, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const output=process.argv.find(value=>value.startsWith('--config.directories.output='));
if(output){const name=JSON.parse(fs.readFileSync('package.json')).build.productName;const resource=path.join(output.split('=')[1],'mac-arm64',name+'.app','Contents/Resources');fs.mkdirSync(resource,{recursive:true});fs.writeFileSync(path.join(resource,'app.asar'),'debug app fixture');}
`)
    await chmod(pnpm, 0o755)
    const historical = join(first.destination, 'release/mac-arm64/UniAgent Public.app/Contents/Resources')
    await mkdir(historical, { recursive: true })
    await writeFile(join(historical, 'app.asar'), 'existing public build')
    execFileSync(process.execPath, ['scripts/pack-debug.mjs'], { cwd: first.destination, env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdio: 'pipe' })
    const output = (await readdir(join(first.destination, 'debug'))).find(name => name.startsWith('roundtable-'))
    const info = JSON.parse(await readFile(join(first.destination, 'debug', output, 'build-info.json'), 'utf8'))
    assert.ok(info.app.endsWith('/UniAgent Public.app'))
    assert.equal(info.historicalUnchanged, true)
    assert.equal(await readFile(join(historical, 'app.asar'), 'utf8'), 'existing public build')
  }
  await writeFile(join(sourceRoot, 'src/main/example.ts'), 'uncommitted change')
  const committed = await exportPublic({ sourceRoot, destination: join(root, 'committed') })
  assert.equal(committed.fingerprint, first.fingerprint, 'uncommitted edits cannot enter a release export')
  await assert.rejects(exportPublic({ sourceRoot, destination: first.destination }), /must be empty/)
  await assert.rejects(exportPublic({ sourceRoot, destination: sourceRoot }), /Unsafe export destination/)
  assert.equal(publicPackage({ version: '1.1.0', keywords: [], scripts: {}, build: {} }, '1.2.0').version, '1.2.0')
} finally { await rm(root, { recursive: true, force: true }) }
console.log('Public source export: deterministic commits, private modules/history exclusion and fail-closed boundaries passed')
