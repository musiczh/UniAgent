import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Portals and passive effects need a real DOM; SSR cannot render the request dock.
export async function renderEventStream(events, status, sessionId, { setup = '', inspect, fileLinks = false, keyEvents = [] } = {}) {
  const root = process.cwd()
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
          ${setup}
          createRoot(document.getElementById('root')).render(React.createElement(EventStream, {...${JSON.stringify({ events, status, sessionId })}${fileLinkProps}, onRespond:async()=>{}, ...(window.__eventStreamProps || {}), requestDockRef:{current:document.getElementById('dock')}}));`,
        resolveDir: root, loader: 'tsx'
      },
      bundle: true, platform: 'browser', format: 'iife', outfile: join(directory, 'renderer.js')
    })
    await writeFile(join(directory, 'index.html'), '<link rel="stylesheet" href="renderer.css"><div id="root"></div><div id="dock"></div><script src="renderer.js"></script>')
    await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
      const fs=require('node:fs'); app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
      app.disableHardwareAcceleration();
      app.whenReady().then(async()=>{app.dock?.hide();const window=new BrowserWindow({show:false});
        await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
        await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,100))');
        if (${JSON.stringify(keyEvents)}.length) {
          window.webContents.debugger.attach('1.3');
          await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
          for (const event of ${JSON.stringify(keyEvents)}) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', event);
        }
        const markup=await window.webContents.executeJavaScript(${JSON.stringify(inspect || 'document.body.innerHTML')});
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
