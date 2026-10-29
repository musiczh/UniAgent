import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectRestartTarget } from '../src/main/appRestartTarget'
import { APP_NAME, APP_BUNDLE_ID } from '../src/shared/distribution'

const exec = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'uniagent-restart-target-'))
const bundle = join(dir, APP_NAME + '.app')
const contents = join(bundle, 'Contents')
const executable = join(contents, 'MacOS', APP_NAME)
const info = { CFBundleIdentifier: APP_BUNDLE_ID, CFBundleExecutable: APP_NAME, CFBundleName: APP_NAME,
  CFBundleVersion: '1.0.10', CFBundleShortVersionString: '1.0.10', CFBundlePackageType: 'APPL' }
try {
  await assert.rejects(inspectRestartTarget('relative.app'), /请选择/)
  await mkdir(join(contents, 'Resources'), { recursive: true })
  await mkdir(join(contents, 'MacOS'))
  await writeFile(join(contents, 'Info.plist'), JSON.stringify({ ...info, CFBundleIdentifier: 'wrong.app' }))
  await assert.rejects(inspectRestartTarget(bundle), /不是 UniAgent/)
  await writeFile(join(contents, 'Info.plist'), JSON.stringify({ ...info, CFBundleIdentifier: APP_BUNDLE_ID === 'com.uniagent.app' ? 'com.uniagent.public' : 'com.uniagent.app' }))
  await assert.rejects(inspectRestartTarget(bundle), /不是 UniAgent/, 'the other distribution cannot be used as a restart target')
  await writeFile(join(contents, 'Info.plist'), JSON.stringify(info))
  await exec('/usr/bin/plutil', ['-convert', 'xml1', join(contents, 'Info.plist')])
  await assert.rejects(inspectRestartTarget(bundle), /不支持重启续聊/)
  await writeFile(join(contents, 'Resources/app-restart-protocol.json'), '{"version":1}')
  await symlink('/usr/bin/true', executable)
  await assert.rejects(inspectRestartTarget(bundle), /外部链接/)
  await rm(executable)
  await copyFile('/usr/bin/true', executable)
  await writeFile(join(contents, 'Resources/app.asar'), 'fixture asar version one')
  const sign = () => exec('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle])
  await sign()
  const first = await inspectRestartTarget(bundle)
  assert.equal(first.version, '1.0.10')
  assert.match(first.sha256, /^[a-f0-9]{64}$/)
  assert.equal(first.executable, await realpath(executable))
  assert.deepEqual(await inspectRestartTarget(bundle), first)
  await writeFile(join(contents, 'Resources/app.asar'), 'fixture asar version two')
  await assert.rejects(inspectRestartTarget(bundle), /codesign|sealed|modified/i)
  await sign()
  assert.notEqual((await inspectRestartTarget(bundle)).sha256, first.sha256)
  console.log('restart target identity, protocol, symlink, real signature and package fingerprint: passed')
} finally { await rm(dir, { recursive: true, force: true }) }
