import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { buildMarkdownWorker } from '../../scripts/markdown-runtime.mjs'

export function rendererRuntimePlugin(directory) {
  return { name: 'offline-renderer-runtimes', setup(builder) {
    builder.onResolve({ filter: /^virtual:uniagent-mermaid-runtime-url$/ }, () => ({ path: 'mermaid-url', namespace: 'mermaid-url' }))
    builder.onLoad({ filter: /.*/, namespace: 'mermaid-url' }, async () => {
      const file = join(directory, 'mermaid-runtime.mjs')
      await build({ entryPoints: ['mermaid'], bundle: true, platform: 'browser', format: 'esm', minify: true, outfile: file })
      return { contents: `export default ${JSON.stringify(pathToFileURL(file).href)}` }
    })
    builder.onResolve({ filter: /^virtual:uniagent-markdown-worker-url$/ }, () => ({ path: 'markdown-worker-url', namespace: 'markdown-worker-url' }))
    builder.onLoad({ filter: /.*/, namespace: 'markdown-worker-url' }, async () => {
      const file = join(directory, 'markdown-highlight-worker.js')
      await writeFile(file, await buildMarkdownWorker())
      return { contents: `export default ${JSON.stringify(pathToFileURL(file).href)}` }
    })
  } }
}

// Portals and passive effects need a real DOM; SSR cannot render the request dock.
export async function renderEventStream(events, status, sessionId, { setup = '', inspect, fileLinks = false, keyEvents = [], mouseEvents = [], screenshot, buildPlugins = [] } = {}) {
  const root = process.cwd()
  await mkdir(join(root, 'out/test'), { recursive: true })
  if (screenshot) await mkdir(dirname(screenshot.path), { recursive: true })
  const directory = await mkdtemp(join(root, 'out/test/request-dom-'))
  const resultFile = join(directory, 'result.json')
  const fileLinkProps = fileLinks
    ? ', onOpenFile: (path, line) => { (window.__openedFiles ||= []).push([path, line]) }'
    : ''
  let child
  try {
    await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {EventStream} from './src/renderer/components/EventStream';
          import './src/renderer/styles.css';
          window.uniagent = new Proxy({}, {get: (_, key) => String(key).startsWith('on') ? () => () => {} : async () => null});
          window.__fixtureErrors = [];
          window.addEventListener('error', event => window.__fixtureErrors.push(event.error?.stack || event.message));
          window.addEventListener('unhandledrejection', event => window.__fixtureErrors.push(String(event.reason)));
          ${setup}
          createRoot(document.getElementById('root')).render(React.createElement(EventStream, {...${JSON.stringify({ events, status, sessionId })}${fileLinkProps}, onRespond:async()=>{}, ...(window.__eventStreamProps || {}), requestDockRef:{current:document.getElementById('dock')}}));`,
        resolveDir: root, loader: 'tsx'
      },
      bundle: true, platform: 'browser', format: 'iife', outfile: join(directory, 'renderer.js'),
      plugins: [...buildPlugins, { name: 'offline-startup', setup(builder) {
        // Component fixtures do not mount the App's startup splash document.
        builder.onLoad({ filter: /\/src\/renderer\/startup\.ts$/ }, () => ({
          contents: 'export function updateStartup() {} export function enterStartup(onComplete) { onComplete(); return () => {} }', loader: 'js'
        }))
      } }, rendererRuntimePlugin(directory)]
    })
    await writeFile(join(directory, 'index.html'), '<link rel="stylesheet" href="renderer.css"><div id="root"></div><div id="dock"></div><script src="renderer.js"></script>')
    await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
      const fs=require('node:fs'); app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
      app.disableHardwareAcceleration();
      app.whenReady().then(async()=>{app.dock?.hide();const window=new BrowserWindow({show:false,...${JSON.stringify(screenshot ? {width:screenshot.width,height:screenshot.height} : {})}});
        await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
        await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,100))');
        if (${JSON.stringify(keyEvents)}.length || ${JSON.stringify(mouseEvents)}.length) {
          window.webContents.debugger.attach('1.3');
          await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
          for (const event of ${JSON.stringify(mouseEvents)}) {
            const input = typeof event === 'string' ? await window.webContents.executeJavaScript(event) : event;
            await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', input);
            await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          }
          for (const event of ${JSON.stringify(keyEvents)}) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', event);
        }
        const markup=await window.webContents.executeJavaScript(${JSON.stringify(inspect || 'document.body.innerHTML')}).catch(async error=>{
          const errors=await window.webContents.executeJavaScript('window.__fixtureErrors');
          throw new Error(error.message+'; renderer errors: '+JSON.stringify(errors));
        });
        if (${JSON.stringify(!!screenshot)}) {
          await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          fs.writeFileSync(${JSON.stringify(screenshot?.path || '')}, (await window.webContents.capturePage()).toPNG());
        }
        if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
        fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(markup));app.quit();
      }).catch(error=>{console.error(error);app.exit(1)});`)
    const require = createRequire(resolve(root, 'package.json'))
    await new Promise((resolveExit, reject) => {
      const env = { ...process.env, HOME: directory, UNIAGENT_USER_DATA: join(directory, 'user-data') }
      delete env.ELECTRON_RUN_AS_NODE
      child = spawn(require('electron'), ['--no-sandbox', join(directory, 'main.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('request DOM fixture timed out')) }, 30_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error(`request DOM fixture exited ${code}: ${stderr}`)) })
    })
    return JSON.parse(await readFile(resultFile, 'utf8'))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolveExit => {
        child.once('exit', resolveExit)
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
        child.once('exit', () => clearTimeout(timer))
      })
    }
    await rm(directory, { recursive: true, force: true })
  }
}
