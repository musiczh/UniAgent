import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { exportPublic } from './export-public.mjs'
import { buildPublicWebsite, PUBLIC_REPO, PUBLIC_SITE, PUBLIC_APP_NAME, PUBLIC_ARTIFACT_PREFIX } from './public-website.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repository = 'musiczh/UniAgent'
const gitConfig = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const artifactName = version => `${PUBLIC_ARTIFACT_PREFIX}-${version}-arm64.dmg`
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const save = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }) }

export function run(command, args, { cwd = root, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_TRACE: '0', GIT_CURL_VERBOSE: '0' }
  })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0] || ''} failed (${result.status ?? result.error?.code})${capture ? ': ' + (result.stderr || '').slice(-1000) : ''}`)
  return result.stdout?.trim() || ''
}
const git = (args, options) => run('git', [...gitConfig, ...args], options)

async function payloadDigest(prepared) {
  const hash = createHash('sha256')
  for (const path of [...prepared.paths].sort()) {
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\0') || path.includes('\\')) throw new Error('Unsafe managed public path')
    hash.update(path + '\0').update(await readFile(join(prepared.source, path))).update('\0')
  }
  return hash.digest('hex')
}

export function validateCompatibility(report, fingerprint, internal = true, now = Date.now()) {
  const expected = ['codex', 'claude', 'grok', 'kimi', 'deepseek', 'mcode', 'zcode', ...(internal ? ['nika', 'traex'] : [])]
  if (report?.sourceFingerprint !== fingerprint || !Number.isFinite(Date.parse(report.checkedAt)) ||
      now - Date.parse(report.checkedAt) > 24 * 60 * 60 * 1000 || Date.parse(report.checkedAt) > now + 60_000) throw new Error('Missing or stale Agent compatibility report for this source')
  for (const id of expected) {
    const agent = report.agents?.find(item => item.id === id)
    if (!agent || agent.status !== 'passed' || !agent.beforeVersion || !agent.latestVersion || agent.afterVersion !== agent.latestVersion ||
        !/^https:\/\//.test(agent.latestSource || '') || !/^https:\/\//.test(agent.protocolSource || '') ||
        !Array.isArray(agent.checks) || !agent.checks.length || agent.checks.some(check => check.exitCode !== 0 || !check.command)) throw new Error(`Agent compatibility is incomplete: ${id}`)
  }
}

export async function verifyDmg(source, manifest, command = run) {
  const dmg = join(source, 'release', artifactName(manifest.version))
  if ((await stat(dmg)).size !== manifest.size || sha256(await readFile(dmg)) !== manifest.sha256) throw new Error('Public DMG checksum mismatch')
  command('hdiutil', ['verify', dmg])
  const app = join(source, 'release/mac-arm64', PUBLIC_APP_NAME + '.app')
  command('codesign', ['--verify', '--deep', '--strict', app])
  const architecture = command('lipo', ['-archs', join(app, 'Contents/MacOS', PUBLIC_APP_NAME)], { capture: true })
  if (architecture !== 'arm64') throw new Error('Public App must contain only arm64')
  const actualVersion = command('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents/Info.plist')], { capture: true })
  if (actualVersion !== manifest.version) throw new Error('Public App version mismatch')
  for (const [field, expected] of Object.entries({ CFBundleIdentifier: 'com.uniagent.public', CFBundleExecutable: PUBLIC_APP_NAME, CFBundleName: PUBLIC_APP_NAME })) {
    if (command('plutil', ['-extract', field, 'raw', join(app, 'Contents/Info.plist')], { capture: true }) !== expected) throw new Error(`Public App identity mismatch: ${field}`)
  }
  const mount = await mkdtemp(join(dirname(source), 'dmg-mount-'))
  let mounted = false
  try {
    command('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]); mounted = true
    const apps = (await readdir(mount)).filter(name => name.endsWith('.app'))
    if (apps.length !== 1 || apps[0] !== PUBLIC_APP_NAME + '.app') throw new Error('Public DMG must contain exactly one UniAgent Public.app')
    command('codesign', ['--verify', '--deep', '--strict', join(mount, PUBLIC_APP_NAME + '.app')])
    const relative = 'Contents/Resources/app.asar'
    if (sha256(await readFile(join(app, relative))) !== sha256(await readFile(join(mount, PUBLIC_APP_NAME + '.app', relative)))) throw new Error('Mounted public App differs from the verified build')
  } finally { if (mounted) command('hdiutil', ['detach', mount]) }
}

async function stateDirectory(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid release version')
  const common = resolve(root, git(['rev-parse', '--git-common-dir'], { capture: true }))
  const directory = join(common, 'uniagent-public-release-state', 'v' + version)
  await mkdir(directory, { recursive: true })
  return directory
}

export async function preparePublic({ version, ref = 'HEAD', workingTree = false, build = false } = {}) {
  const directory = await stateDirectory(version)
  const source = await mkdtemp(join(directory, 'source-'))
  const exported = await exportPublic({ sourceRoot: root, destination: source, ref, workingTree, version })
  const commit = git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], { capture: true })
  const readSource = async path => workingTree ? readFile(join(root, path)) : execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
  const desktop = await readSource('docs/mockups/public-workbench-v1.1.0.png')
  const connection = await readSource('docs/mockups/public-feishu-v1.1.0.png')
  const webpage = buildPublicWebsite((await readSource('docs/share/uniagent-introduction/web-design-preview.html')).toString(), {
    version, desktopImage: 'data:image/png;base64,' + desktop.toString('base64'), connectionImage: 'data:image/png;base64,' + connection.toString('base64')
  })
  const site = join(directory, 'site-' + webpage.sha256.slice(0, 12))
  await mkdir(site, { recursive: true })
  await writeFile(join(site, 'index.html'), webpage.html)
  await writeFile(join(site, '.nojekyll'), '')
  await mkdir(join(source, 'docs/share/uniagent-introduction'), { recursive: true })
  await writeFile(join(source, 'docs/share/uniagent-introduction/web-design-preview.html'), webpage.html)
  const prepared = { schemaVersion: 1, version, source, site, paths: exported.paths, fingerprint: exported.fingerprint, webSha256: webpage.sha256, previewOnly: workingTree, built: false }
  if (build) {
    if (workingTree) throw new Error('Commit source changes before building a releasable public snapshot')
    run('pnpm', ['install', '--frozen-lockfile', '--registry=https://registry.npmjs.org', '--store-dir', join(directory, 'pnpm-store')], { cwd: source })
    run('pnpm', ['run', 'build'], { cwd: source })
    run('pnpm', ['exec', 'tsc', '--noEmit'], { cwd: source })
    run('pnpm', ['run', 'test:release'], { cwd: source })
    run('pnpm', ['exec', 'electron-builder', '--mac', 'dmg', '--arm64', '--publish', 'never'], { cwd: source })
    const dmg = join(source, 'release', artifactName(version))
    prepared.manifest = { schemaVersion: 1, version, platform: 'darwin', arch: 'arm64', path: `release/v${version}/${artifactName(version)}`, size: (await stat(dmg)).size, sha256: sha256(await readFile(dmg)) }
    await verifyDmg(source, prepared.manifest)
    await writeFile(join(site, 'latest.json'), JSON.stringify(prepared.manifest, null, 2) + '\n')
    await writeFile(join(directory, 'SHA256SUMS'), `${prepared.manifest.sha256}  ${artifactName(version)}\n`)
    prepared.built = true
  }
  prepared.payloadSha256 = await payloadDigest(prepared)
  await save(join(directory, 'prepared.json'), prepared)
  console.log(JSON.stringify({ version, source, site, fingerprint: prepared.fingerprint, webSha256: prepared.webSha256, built: prepared.built }))
  return prepared
}

export async function checkReview(version, { ref = 'HEAD' } = {}) {
  const directory = await stateDirectory(version)
  const prepared = await json(join(directory, 'prepared.json'))
  const approval = await json(join(directory, 'web-approval.json'))
  if (prepared.previewOnly || !prepared.built || approval.version !== version || approval.webSha256 !== prepared.webSha256 ||
      sha256(await readFile(join(prepared.site, 'index.html'))) !== prepared.webSha256 || await payloadDigest(prepared) !== prepared.payloadSha256) throw new Error('The complete public website and build require maintainer review')
  const current = await mkdtemp(join(directory, 'source-check-'))
  const exported = await exportPublic({ destination: current, ref, version })
  if (exported.fingerprint !== prepared.fingerprint) throw new Error('Committed public source changed after preparation; rebuild and review this version')
  const commit = git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], { capture: true })
  const read = path => execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
  const currentWebsite = buildPublicWebsite(read('docs/share/uniagent-introduction/web-design-preview.html').toString(), {
    version, desktopImage: 'data:image/png;base64,' + read('docs/mockups/public-workbench-v1.1.0.png').toString('base64'),
    connectionImage: 'data:image/png;base64,' + read('docs/mockups/public-feishu-v1.1.0.png').toString('base64')
  })
  if (currentWebsite.sha256 !== prepared.webSha256) throw new Error('Website changed after maintainer review')
  const internal = read('src/shared/distribution.ts').toString().includes('INTERNAL_DISTRIBUTION = true')
  validateCompatibility(await json(join(directory, 'compatibility.json')), prepared.fingerprint, internal)
  return prepared
}

export function validateLegacyRefs(remote, saved) {
  for (const ref of ['refs/heads/build-6a7ab81', 'refs/tags/v1.0.1']) {
    if (remote[ref] && remote[ref] !== saved[ref]) throw new Error(`Legacy ref changed since backup: ${ref}`)
  }
}

async function cleanupLegacy(backup) {
  git(['bundle', 'verify', join(backup, 'UniAgent.bundle')])
  const saved = Object.fromEntries(git(['--git-dir=' + join(backup, 'repository.git'), 'show-ref'], { capture: true }).split('\n').map(row => row.split(' ')).map(([sha, ref]) => [ref, sha]))
  const remote = Object.fromEntries(git(['ls-remote', PUBLIC_REPO + '.git'], { capture: true }).split('\n').map(row => row.split(/\s+/)).map(([sha, ref]) => [ref, sha]))
  validateLegacyRefs(remote, saved)
  const releases = await json(join(backup, 'releases.json'))
  const old = releases.find(release => release.tag_name === 'v1.0.1')
  if (!old) throw new Error('Missing legacy release backup')
  for (const asset of old.assets) {
    const path = join(backup, 'assets', asset.name)
    if ((await stat(path)).size !== asset.size || asset.digest && asset.digest !== 'sha256:' + sha256(await readFile(path))) throw new Error('Legacy asset backup is incomplete')
  }
  let existing
  try { existing = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/v1.0.1`], { capture: true })) }
  catch (error) { if (!error.message.includes('404')) throw error }
  if (existing) {
    if (existing.id !== old.id || JSON.stringify(existing.assets.map(asset => [asset.id, asset.name, asset.size]).sort()) !== JSON.stringify(old.assets.map(asset => [asset.id, asset.name, asset.size]).sort())) throw new Error('Legacy release changed since backup')
    run('gh', ['release', 'delete', 'v1.0.1', '--repo', repository, '--yes'])
  }
  for (const ref of ['refs/heads/build-6a7ab81', 'refs/tags/v1.0.1']) {
    if (remote[ref]) git(['push', `--force-with-lease=${ref}:${saved[ref]}`, PUBLIC_REPO + '.git', ':' + ref])
  }
}

async function syncSource(prepared, directory, { replaceHistory = false, backup } = {}) {
  const pending = await json(join(directory, 'source-published.json')).catch(() => undefined)
  if (pending) {
    if (pending.fingerprint !== prepared.fingerprint || pending.payloadSha256 !== prepared.payloadSha256) throw new Error('Published source changed; use a new version')
    await pushSourceReceipt(pending, directory)
    return pending.commit
  }
  const previous = await json(join(dirname(directory), 'last-published.json')).catch(() => undefined)
  const currentHead = git(['ls-remote', PUBLIC_REPO + '.git', 'refs/heads/master'], { capture: true }).split(/\s/)[0]
  if (replaceHistory) {
    if (!backup) throw new Error('Replacing public history requires the verified backup directory')
    git(['bundle', 'verify', join(backup, 'UniAgent.bundle')])
    const saved = await json(join(backup, 'repository.json'))
    if (saved.full_name !== repository) throw new Error('Backup repository does not match')
    const backupHead = git(['--git-dir=' + join(backup, 'repository.git'), 'rev-parse', 'refs/heads/master'], { capture: true })
    if (currentHead !== backupHead) throw new Error('Public master changed since backup; review it before replacing history')
  } else if (currentHead && previous?.commit !== currentHead) throw new Error('Public master has changes that must be backported before syncing')
  const checkout = await mkdtemp(join(directory, 'github-source-'))
  git(['init', '--initial-branch=master'], { cwd: checkout })
  git(['remote', 'add', 'origin', PUBLIC_REPO + '.git'], { cwd: checkout })
  if (currentHead && !replaceHistory) {
    git(['fetch', 'origin', 'master'], { cwd: checkout })
    git(['checkout', '-B', 'master', 'FETCH_HEAD'], { cwd: checkout })
    for (const path of git(['ls-files', '-z'], { cwd: checkout, capture: true }).split('\0').filter(Boolean)) await rm(join(checkout, path), { force: true })
  }
  for (const path of prepared.paths) {
    await mkdir(dirname(join(checkout, path)), { recursive: true })
    await cp(join(prepared.source, path), join(checkout, path))
  }
  await save(join(checkout, '.uniagent-public.json'), { schemaVersion: 1, version: prepared.version, fingerprint: prepared.fingerprint })
  git(['add', '-A'], { cwd: checkout })
  git(['-c', 'user.name=Music ZH', '-c', 'user.email=musiczh@users.noreply.github.com', 'commit', '-m', `chore(release): 发布 UniAgent ${prepared.version} 公开版`], { cwd: checkout })
  const commit = git(['rev-parse', 'HEAD'], { cwd: checkout, capture: true })
  const receipt = { commit, checkout, version: prepared.version, expectedHead: currentHead, replaceHistory, backup, fingerprint: prepared.fingerprint, payloadSha256: prepared.payloadSha256 }
  await save(join(directory, 'source-published.json'), receipt)
  await pushSourceReceipt(receipt, directory)
  return commit
}

async function pushSourceReceipt(receipt, directory) {
  const head = git(['ls-remote', 'origin', 'refs/heads/master'], { cwd: receipt.checkout, capture: true }).split(/\s/)[0]
  if (head !== receipt.commit) {
    if (head !== receipt.expectedHead) throw new Error('Public master changed during release; review before retrying')
    git(['push', ...(receipt.replaceHistory ? [`--force-with-lease=refs/heads/master:${receipt.expectedHead}`] : []), 'origin', 'HEAD:refs/heads/master'], { cwd: receipt.checkout })
  }
  const tag = 'v' + receipt.version
  const remoteTag = git(['ls-remote', 'origin', 'refs/tags/' + tag], { cwd: receipt.checkout, capture: true }).split(/\s/)[0]
  if (remoteTag && remoteTag !== receipt.commit) throw new Error('Existing public release tag points to a different commit')
  if (!remoteTag) {
    if (!git(['tag', '--list', tag], { cwd: receipt.checkout, capture: true })) git(['tag', tag, receipt.commit], { cwd: receipt.checkout })
    git(['push', 'origin', 'refs/tags/' + tag], { cwd: receipt.checkout })
  }
  await save(join(directory, 'source-published.json'), { ...receipt, published: true })
}

async function publishSite(prepared, directory) {
  const checkout = await mkdtemp(join(directory, 'github-pages-'))
  git(['init', '--initial-branch=gh-pages'], { cwd: checkout })
  git(['remote', 'add', 'origin', PUBLIC_REPO + '.git'], { cwd: checkout })
  const remote = git(['ls-remote', 'origin', 'refs/heads/gh-pages'], { cwd: checkout, capture: true })
  if (remote) { git(['fetch', 'origin', 'gh-pages'], { cwd: checkout }); git(['checkout', '-B', 'gh-pages', 'FETCH_HEAD'], { cwd: checkout }) }
  for (const name of ['index.html', 'latest.json', '.nojekyll']) await cp(join(prepared.site, name), join(checkout, name))
  git(['add', 'index.html', 'latest.json', '.nojekyll'], { cwd: checkout })
  if (git(['diff', '--cached', '--name-only'], { cwd: checkout, capture: true })) {
    git(['-c', 'user.name=Music ZH', '-c', 'user.email=musiczh@users.noreply.github.com', 'commit', '-m', `docs(site): 发布 UniAgent ${prepared.version} 官网`], { cwd: checkout })
    git(['push', 'origin', 'HEAD:refs/heads/gh-pages'], { cwd: checkout })
  }
  let pages
  try { pages = JSON.parse(run('gh', ['api', `repos/${repository}/pages`], { capture: true })) }
  catch (error) { if (!error.message.includes('404')) throw error }
  if (pages && (pages.source?.branch !== 'gh-pages' || pages.source?.path !== '/')) throw new Error('Existing Pages settings differ; review before replacing them')
  if (!pages) run('gh', ['api', '--method', 'POST', `repos/${repository}/pages`, '-f', 'build_type=legacy', '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'])
  run('gh', ['repo', 'edit', repository, '--homepage', PUBLIC_SITE])
}

export async function verifyPublishedSite(prepared, request = fetch, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const [page, manifest] = await Promise.all(['', 'latest.json'].map(path => request(PUBLIC_SITE + path, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15_000) })))
      if (page.ok && manifest.ok && sha256(Buffer.from(await page.arrayBuffer())) === prepared.webSha256 &&
          JSON.stringify(await manifest.json()) === JSON.stringify(prepared.manifest)) return
    } catch { /* Pages deployment may still be propagating. */ }
    if (attempt < 29) await wait(10_000)
  }
  throw new Error('GitHub Pages has not served the reviewed website and matching update manifest; retry the same release')
}

export async function publishPublic(version, options = {}) {
  const prepared = await checkReview(version)
  const directory = await stateDirectory(version)
  await verifyDmg(prepared.source, prepared.manifest)
  const commit = await syncSource(prepared, directory, options)
  const tag = 'v' + version
  let release
  try { release = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { capture: true })) }
  catch (error) { if (!error.message.includes('404')) throw error }
  if (!release) {
    const notes = join(directory, 'release-notes.md')
    await writeFile(notes, `${PUBLIC_APP_NAME} ${version}\n\n支持七种公开 Agent，包含会话、工具能力、飞书助手、评论、定时任务和本机用量。\n\n官网：${PUBLIC_SITE}\n\nSHA-256：${prepared.manifest.sha256}\n`)
    run('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--title', `${PUBLIC_APP_NAME} v${version}`, '--notes-file', notes])
    release = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { capture: true }))
  }
  const assets = [join(prepared.source, 'release', artifactName(version)), join(directory, 'SHA256SUMS'), join(prepared.site, 'latest.json')]
  for (const path of assets) {
    const name = path.split('/').at(-1)
    const existing = release.assets.find(asset => asset.name === name)
    if (existing && (existing.size !== (await stat(path)).size || existing.digest && existing.digest !== 'sha256:' + sha256(await readFile(path)))) throw new Error(`Existing release asset differs: ${name}`)
    if (!existing) run('gh', ['release', 'upload', tag, path, '--repo', repository])
  }
  const downloaded = await mkdtemp(join(directory, 'download-'))
  run('gh', ['release', 'download', tag, '--repo', repository, '--dir', downloaded])
  for (const path of assets) {
    const name = path.split('/').at(-1)
    if (sha256(await readFile(join(downloaded, name))) !== sha256(await readFile(path))) throw new Error(`GitHub downloaded asset checksum mismatch: ${name}`)
  }
  if (release.draft) run('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'])
  await publishSite(prepared, directory)
  await verifyPublishedSite(prepared)
  const receipt = await json(join(directory, 'source-published.json'))
  if (receipt.replaceHistory) await cleanupLegacy(receipt.backup)
  await save(join(dirname(directory), 'last-published.json'), { version, commit, fingerprint: prepared.fingerprint, manifest: prepared.manifest })
  console.log(`Published ${PUBLIC_APP_NAME} ${version}: ${PUBLIC_REPO}/releases/tag/${tag}; ${PUBLIC_SITE}`)
  return { commit, prepared }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    prepare: { type: 'boolean' }, build: { type: 'boolean' }, publish: { type: 'boolean' }, 'check-review': { type: 'boolean' },
    'approve-web': { type: 'string' }, 'working-tree': { type: 'boolean' }, version: { type: 'string' },
    'source-ref': { type: 'string' }, 'replace-history': { type: 'boolean' }, backup: { type: 'string' }
  } })
  const version = values.version || (await json(join(root, 'package.json'))).version
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid release version')
  if (values.prepare) await preparePublic({ version, ref: values['source-ref'] || 'HEAD', workingTree: values['working-tree'], build: values.build })
  else if (values['approve-web']) {
    const directory = await stateDirectory(version), prepared = await json(join(directory, 'prepared.json'))
    if (values['approve-web'] !== prepared.webSha256) throw new Error('Approval must match the reviewed complete HTML')
    await save(join(directory, 'web-approval.json'), { version, webSha256: prepared.webSha256, approvedAt: new Date().toISOString() })
  } else if (values['check-review']) await checkReview(version)
  else if (values.publish) await publishPublic(version, { replaceHistory: values['replace-history'], backup: values.backup })
  else throw new Error('Choose --prepare, --check-review, --approve-web SHA256, or --publish')
}
