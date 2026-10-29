import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

await mkdir(resolve('out/test'), { recursive: true })
const root = await mkdtemp(resolve('out/test/detail-window-'))
let child
try {
  await mkdir(join(root, 'preload'))
  await mkdir(join(root, 'renderer'))
  await writeFile(join(root, 'preload/index.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
    const received=[]; ipcRenderer.on('detail:event',(_e,p)=>received.push(p));
    contextBridge.exposeInMainWorld('fixture',{action:(...args)=>ipcRenderer.invoke('detailWindow:action',...args),received:()=>received});`)
  await writeFile(join(root, 'renderer/detail.html'), '<html><body>解释</body></html>')
  await writeFile(join(root, 'renderer/index.html'), '<html><body>主窗口</body></html>')
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import assert from 'node:assert/strict';
    import {app,BrowserWindow} from 'electron';
    import {join} from 'node:path';
    import {DetailWindow} from './src/main/detailWindow';
    import {IPC} from './src/shared/types';
    const root=${JSON.stringify(root)};
    app.setPath('userData',join(root,'user-data')); app.disableHardwareAcceleration();
    void app.whenReady().then(async()=>{ app.dock?.hide();
    let explains=0,closed=0,sent=[],ready=Promise.resolve();
    const main=new BrowserWindow({show:false,width:600,height:600,x:40,y:80,webPreferences:{preload:join(root,'preload/index.cjs')}});
    await main.loadFile(join(root,'renderer/index.html'));
    const owner={assertUserSessionEnabled:id=>assert.equal(id,'parent'),explainDetailSelection:async()=>{explains++},
      getDetailEvents:()=>[],getDetailStatus:()=> 'idle',sendDetailMessage:(id,text)=>sent.push([id,text]),
      interruptDetail:()=>{},closeDetail:()=>{closed++},promoteDetailToSide:async()=>true};
    const manager=new DetailWindow({owner:owner as any,main:()=>main,ui:path=>join(root,path),ready:async()=>{await ready}});
    manager.register();
    await manager.open('parent',{selectedText:'原文',selectedMessageText:'完整原文',sourceConversationId:'parent',targetedReplyLabel:'所选文本'});
    const detail=BrowserWindow.getAllWindows().find(window=>window!==main)!; detail.hide();
    const invoke=(action,value?)=>detail.webContents.executeJavaScript('window.fixture.action('+JSON.stringify(action)+(value===undefined?'':','+JSON.stringify(value))+')');
    assert.equal(detail.getParentWindow(),null); assert.equal(detail.isModal(),false);
    const bounds=main.getBounds(); detail.setPosition(bounds.x+bounds.width+30,bounds.y);
    assert.ok(detail.getBounds().x>=bounds.x+bounds.width,'native bounds can leave the main window');
    const initial=await invoke('initial'); assert.equal(initial.sessionId,'parent'); assert.equal(initial.quote,'原文');
    await invoke('explain'); await invoke('explain'); assert.equal(explains,1,'renderer remount cannot start a duplicate turn');
    await invoke('send','追问'); assert.deepEqual(sent,[['parent','追问']]);
    await assert.rejects(main.webContents.executeJavaScript('window.fixture.action("events")'),/untrusted_detail_window/);
    const reloaded=new Promise(resolve=>detail.webContents.once('did-finish-load',resolve)); detail.reload(); await reloaded;
    await invoke('explain'); assert.equal(explains,1,'reload preserves the existing branch');
    manager.close('other'); assert.equal(detail.isDestroyed(),false);
    const didClose=new Promise(resolve=>detail.once('closed',resolve)); manager.close('parent'); await didClose;
    assert.equal(detail.isDestroyed(),true); assert.equal(closed,1);
    assert.equal(main.isDestroyed(),false,'closing explanation never terminates the main window');
    let release; ready=new Promise(resolve=>release=resolve);
    const pending=manager.open('parent',{selectedText:'选区',selectedMessageText:'完整选区',sourceConversationId:'parent',targetedReplyLabel:'所选文本'});
    manager.close('parent'); release(); await pending;
    assert.equal(BrowserWindow.getAllWindows().length,1,'source switch cancels a window still preparing');
    main.close(); console.log('detached explanation: independent bounds, source binding, once-only turn, reload and close passed'); app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});
  ` }, bundle: true, platform: 'node', format: 'esm', external: ['electron'], outfile: join(root, 'fixture.mjs') })
  const require = createRequire(import.meta.url)
  await new Promise((resolveExit, reject) => {
    const env = { ...process.env, HOME: root, UNIAGENT_USER_DATA: join(root, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), [join(root, 'fixture.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('detached window fixture timed out: ' + output.slice(-2000))) }, 25000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? (console.log(output.split('\n').find(line => line.startsWith('detached explanation:'))), resolveExit()) : reject(new Error(output.slice(-3000))) })
  })
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await rm(root, { recursive: true, force: true })
}
