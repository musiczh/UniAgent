import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RestartTarget } from './appRestart'
import { APP_NAME, APP_BUNDLE_ID } from '../shared/distribution'

const exec = promisify(execFile)
export async function inspectRestartTarget(input: string): Promise<RestartTarget> {
  if (process.platform !== 'darwin' || !isAbsolute(input) || !input.endsWith('.app')) throw new Error(`请选择已准备好的 macOS ${APP_NAME}.app`)
  const bundle = await realpath(input)
  const contents = join(bundle, 'Contents')
  const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(contents, 'Info.plist')], { timeout: 10000 })
  const info = JSON.parse(stdout)
  if (info.CFBundleIdentifier !== APP_BUNDLE_ID || info.CFBundleExecutable !== APP_NAME) throw new Error(`目标不是 ${APP_NAME} 应用`)
  const protocol = JSON.parse(await readFile(join(contents, 'Resources', 'app-restart-protocol.json'), 'utf8').catch(() => '{"version":0}'))
  if (protocol.version !== 1) throw new Error('目标版本不支持重启续聊，请先使用包含此功能的新包')
  const executable = await realpath(join(contents, 'MacOS', APP_NAME))
  if (executable !== join(contents, 'MacOS', APP_NAME)) throw new Error('目标可执行文件不能是外部链接')
  await access(executable, constants.X_OK)
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30000 })
  const hash = createHash('sha256')
  for (const file of [join(contents, 'Resources', 'app.asar'), executable]) {
    for await (const chunk of createReadStream(file)) hash.update(chunk)
  }
  return { bundle, executable, sha256: hash.digest('hex'), version: String(info.CFBundleShortVersionString || info.CFBundleVersion) }
}
