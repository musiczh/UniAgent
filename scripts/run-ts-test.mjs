import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'

const source = process.argv[2]
if (!source) throw new Error('pass a TypeScript test file')

const rootRequire = createRequire(import.meta.url)
const electronVitePath = rootRequire.resolve('electron-vite')
const electronViteRequire = createRequire(electronVitePath)
const { build } = electronViteRequire('esbuild')
const outputDir = resolve('out/test')
const output = join(outputDir, `${basename(source).replace(/\.[^.]+$/, '')}-${process.pid}.mjs`)

try {
  await mkdir(outputDir, { recursive: true })
  await build({
    entryPoints: [resolve(source)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: output,
    plugins: [{
      name: 'offline-startup',
      setup(build) {
        // Node component tests do not own the browser's startup splash lifecycle.
        build.onLoad({ filter: /\/src\/renderer\/startup\.ts$/ }, () => ({
          contents: 'export function updateStartup() {} export function enterStartup(onComplete) { onComplete(); return () => {} }',
          loader: 'js'
        }))
      }
    }]
  })
  await run(process.execPath, [output])
} finally {
  await rm(output, { force: true })
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}
