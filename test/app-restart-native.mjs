import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'uniagent-relaunch-test-'))
try {
  const file = join(dir, 'relaunch.mjs')
  await build({ entryPoints: ['src/main/appRelaunch.ts'], bundle: true, platform: 'node', format: 'esm', outfile: file,
    plugins: [{ name: 'native-relaunch-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const app = { relaunch(options) { globalThis.relaunchCalls.push(['relaunch', options]) }, quit() { globalThis.relaunchCalls.push(['quit']) } };
      ` }))
    } }] })
  globalThis.relaunchCalls = []
  const { relaunchApp } = await import(pathToFileURL(file))
  const options = { execPath: '/fixture/UniAgent.app/Contents/MacOS/UniAgent', args: ['--uniagent-resume-restart=fixture'] }
  relaunchApp(options)
  assert.deepEqual(globalThis.relaunchCalls, [['relaunch', options], ['quit']])
  assert.throws(() => relaunchApp(), /已经安排重启/)
  assert.equal(globalThis.relaunchCalls.length, 2, 'ordinary and managed restarts share one native latch')
  console.log('native relaunch preserves the selected target, uses normal quit and is scheduled once: passed')
} finally {
  delete globalThis.relaunchCalls
  await rm(dir, { recursive: true, force: true })
}
