import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Isolated renderer unit tests: no installed App, real accounts or Agent turns.
const root = process.cwd()
await mkdir(join(root, 'out/test'), { recursive: true })
const directory = await mkdtemp(join(root, 'out/test/markdown-editor-'))
const resultFile = join(directory, 'result.json')
const require = createRequire(resolve(root, 'package.json'))
let child
try {
  await build({
    entryPoints: [join(root, 'test/fixtures/markdown-editor.tsx')], bundle: true, platform: 'browser',
    format: 'iife', globalName: 'MarkdownEditorTests', outfile: join(directory, 'renderer.js'),
    plugins: [{ name: 'fixture-no-startup', setup(builder) {
      builder.onLoad({ filter: /\/src\/renderer\/startup\.ts$/ }, () => ({ contents: 'export function updateStartup() {} export function enterStartup() {}', loader: 'js' }))
    } }]
  })
  await writeFile(join(directory, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>html,body{overflow:auto;height:auto;padding:0}</style><script src="renderer.js"></script>')
  await writeFile(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron'); const fs=require('node:fs');
    app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))}); app.disableHardwareAcceleration();
    app.whenReady().then(async()=>{
      app.dock?.hide();
      const win=new BrowserWindow({show:false,width:1000,height:900});
      await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
      const result=await win.webContents.executeJavaScript('MarkdownEditorTests.run().then(results=>({results})).catch(error=>({error:error.stack}))');
      if (!result.error) {
        try {
          const {runImeRegression}=await import(${JSON.stringify(join(root, 'test/fixtures/markdown-ime-driver.mjs'))});
          result.results.push(...await runImeRegression(win));
        } catch(error) { result.error=error.stack; }
      }
      fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result)); app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  await new Promise((resolveExit, reject) => {
    const env = { ...process.env, HOME: directory, UNIAGENT_USER_DATA: join(directory, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), [join(directory, 'main.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Markdown renderer fixture timed out: ' + stderr)) }, 45000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error('Markdown fixture exited ' + code + ': ' + stderr)) })
  })
  const result = JSON.parse(await readFile(resultFile, 'utf8'))
  assert.equal(result.error, undefined, result.error)
  assert.ok(result.results.length >= 10, 'all renderer suites must finish')
  console.log(result.results.map(value => 'passed: ' + value).join('\n'))
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true })
}
