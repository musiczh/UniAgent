import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('capability filesystem addon can only be built on macOS arm64')
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(projectRoot, 'native', 'capability-fs-addon.c')
const outputDirectory = join(projectRoot, 'out', 'native')
const output = join(outputDirectory, 'ua-capability-fs.node')
const testOutput = join(outputDirectory, 'ua-capability-fs-test.node')
const configuredNodeInclude = process.env.NODE_INCLUDE_DIR
const installedNodeInclude = join(dirname(dirname(realpathSync(process.execPath))), 'include', 'node')
const nodeInclude = [configuredNodeInclude, installedNodeInclude]
  .find((candidate) => candidate && existsSync(join(candidate, 'node_api.h')))

if (!nodeInclude) {
  throw new Error('failed to find Node-API headers; set NODE_INCLUDE_DIR to a directory containing node_api.h')
}

mkdirSync(outputDirectory, { recursive: true })

function buildAddon(target, extraFlags = []) {
  const temporary = join(outputDirectory, `.ua-capability-fs-${process.pid}-${randomUUID()}.node`)
  try {
    const result = spawnSync('xcrun', [
      '--sdk', 'macosx', 'clang',
      '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wpedantic', '-O2',
      '-fstack-protector-strong', '-fvisibility=hidden', '-DNAPI_VERSION=8', `-I${nodeInclude}`,
      ...extraFlags,
      '-arch', 'arm64', '-mmacosx-version-min=11.0', '-bundle', '-undefined', 'dynamic_lookup',
      source, '-o', temporary, '-lproc', '-Wl,-dead_strip'
    ], { encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 60_000 })
    if (result.error || result.status !== 0) {
      const detail = `${result.stderr || result.stdout || result.error?.message || 'unknown compiler failure'}`.slice(0, 4096).trim()
      throw new Error(`failed to build capability filesystem addon: ${detail}`)
    }
    chmodSync(temporary, 0o644)
    renameSync(temporary, target)
    console.log(`built ${target}`)
  } finally {
    rmSync(temporary, { force: true })
  }
}

buildAddon(output)
buildAddon(testOutput, ['-DUA_ATOMIC_FS_TESTING=1'])
