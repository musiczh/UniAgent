import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { rendererRuntimePlugin } from './regression/render-event-stream.mjs'

await mkdir(resolve('out/test'), { recursive: true })
const root = await mkdtemp(resolve('out/test/detail-window-'))
let child
try {
  await mkdir(join(root, 'preload'))
  await mkdir(join(root, 'renderer'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import './src/preload/index';
    import {contextBridge,ipcRenderer} from 'electron';
    contextBridge.exposeInMainWorld('fixture',{action:(...args)=>ipcRenderer.invoke('detailWindow:action',...args)});
  ` }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(root, 'preload/index.cjs') })
  await build({ entryPoints: ['src/renderer/detail.tsx'], bundle: true, splitting: true, format: 'esm', jsx: 'automatic',
    outdir: join(root, 'renderer'), entryNames: 'detail', plugins: [{ name: 'slow-detail-graph', setup(build) {
      build.onLoad({ filter: /\/components\/DetailChatPopover\.tsx$/ }, async ({path}) => ({ loader: 'tsx', resolveDir: resolve('src/renderer/components'), contents: `
        window.detailGraphEvaluatedAt=performance.now();
        const until=performance.now()+400; while(performance.now()<until) {}
      ` + await readFile(path, 'utf8') }))
    } }, rendererRuntimePlugin(join(root, 'renderer'))] })
  const html = (await readFile('src/renderer/detail.html', 'utf8'))
    .replace('./detail.tsx', './detail.js').replace('</head>', '<link rel="stylesheet" href="./detail.css"></head>')
  await writeFile(join(root, 'renderer/detail.html'), html)
  await writeFile(join(root, 'renderer/index.html'), '<html><body>主窗口</body></html>')
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import assert from 'node:assert/strict';
    import {app,BrowserWindow} from 'electron';
    import {join} from 'node:path';
    import {DetailWindow} from './src/main/detailWindow';
    import {IPC} from './src/shared/types';
    import {ASSISTANT_IPC} from './src/shared/assistant';
    const root=${JSON.stringify(root)};
    app.setPath('userData',join(root,'user-data')); app.disableHardwareAcceleration();
    void app.whenReady().then(async()=>{ app.dock?.hide();
    let explains=0,closed=0,sent=[],theme='ui-paper',releaseReady;
    let ready=new Promise(resolve=>releaseReady=resolve);
    const main=new BrowserWindow({show:false,width:600,height:600,x:40,y:80,webPreferences:{preload:join(root,'preload/index.cjs')}});
    await main.loadFile(join(root,'renderer/index.html'));
    const reply={sessionId:'parent',seq:1,ts:1,type:'agent_message',state:'success',payload:{id:'answer',text:'解释内容',phase:'final_answer'}};
    const owner={assertUserSessionEnabled:id=>assert.equal(id,'parent'),explainDetailSelection:async()=>{
        explains++; manager.forward(IPC.detailEvent,{sessionId:'parent',event:reply});
        manager.forward(IPC.detailStatus,{sessionId:'parent',status:'idle'});
      },
      getDetailEvents:()=>explains?[reply]:[],getDetailStatus:()=>explains?'idle':'running',sendDetailMessage:(id,text)=>sent.push([id,text]),
      interruptDetail:()=>{},closeDetail:()=>{closed++},promoteDetailToSide:async()=>true};
    const manager=new DetailWindow({owner:owner as any,main:()=>main,ui:path=>join(root,path),ready:async()=>{await ready},theme:()=>theme as any});
    manager.register();
    const openedAt=Date.now();
    const opening=manager.open('parent',{selectedText:'原文',selectedMessageText:'完整原文',sourceConversationId:'parent',targetedReplyLabel:'所选文本'});
    await Promise.resolve();
    const detail=BrowserWindow.getAllWindows().find(window=>window!==main)!;
    assert.equal(detail.isVisible(),true,'clicking explain must show the window without waiting for the renderer to load');
    const shownMs=Date.now()-openedAt;
    await opening;
    const waitFor=condition=>detail.webContents.executeJavaScript(
      'new Promise((resolve,reject)=>{const deadline=Date.now()+5000; const check=()=>{if('+condition+'){resolve();return} if(Date.now()>deadline){reject(new Error("explanation did not finish loading"));return} setTimeout(check,10)};check()})');
    await waitFor('window.detailGraphEvaluatedAt && document.querySelector(".detail-foot-input")');
    const paint=await detail.webContents.executeJavaScript(
      '(()=>{const paint=performance.getEntriesByName("first-contentful-paint")[0];return {paint:paint?.startTime,graph:window.detailGraphEvaluatedAt,origin:performance.timeOrigin}})()');
    assert.ok(paint.paint<paint.graph,'the loading UI must paint before evaluating the slow conversation graph: '+JSON.stringify(paint));
    assert.equal(detail.isVisible(),true,'the explanation is visible before any agent readiness check');
    assert.equal(explains,0,'the original toolbar and composer render before agent readiness');
    assert.equal(detail.getParentWindow(),null,'showing earlier must preserve the original independent window');
    assert.equal(detail.isModal(),false); assert.equal(main.isEnabled(),true);
    assert.equal(detail.isResizable(),false,'showing earlier must preserve the original fixed size');
    assert.deepEqual(detail.getSize(),[396,480]); assert.deepEqual(detail.getMinimumSize(),[396,480]);
    const corner=(await detail.webContents.capturePage()).toBitmap()[3];
    assert.ok(corner<255,'the original rounded UI keeps transparent corners: alpha='+corner);
    const layout=await detail.webContents.executeJavaScript('(()=>{const r=document.querySelector(".detail-pop").getBoundingClientRect();return {width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})()');
    assert.equal(layout.width,layout.viewportWidth); assert.equal(layout.height,layout.viewportHeight);
    const toolbar=await detail.webContents.executeJavaScript('Array.from(document.querySelectorAll(".detail-icon-btn")).map(button=>button.getAttribute("aria-label"))');
    assert.deepEqual(toolbar,['保留为侧边对话','保存为新会话','关闭解释']);
    assert.equal(await detail.webContents.executeJavaScript('document.querySelector(".detail-title-text").textContent'),'原文');
    await waitFor('document.documentElement.dataset.colorTheme === "ui-paper"');
    theme='ui-ink'; detail.webContents.send(ASSISTANT_IPC.manageChanged,'settings');
    await waitFor('document.documentElement.dataset.colorTheme === "ui-ink"');
    releaseReady();
    await waitFor('document.querySelector(".detail-stream").textContent.includes("解释内容")');
    assert.equal(explains,1,'the real preload starts exactly one explanation after the UI subscribes');
    detail.hide();
    const invoke=(action,value?)=>detail.webContents.executeJavaScript('window.fixture.action('+JSON.stringify(action)+(value===undefined?'':','+JSON.stringify(value))+')');
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
    let rejectLoad;
    app.once('browser-window-created',(_event,window)=>{
      window.loadFile=()=>new Promise((_resolve,reject)=>{rejectLoad=reject});
    });
    const loading=manager.open('parent',{selectedText:'加载中关闭',selectedMessageText:'完整选区',sourceConversationId:'parent',targetedReplyLabel:'所选文本'});
    await Promise.resolve();
    const loadingWindow=BrowserWindow.getAllWindows().find(window=>window!==main)!;
    const loadingClosed=new Promise(resolve=>loadingWindow.once('closed',resolve));
    manager.close('parent'); await loadingClosed; rejectLoad(new Error('ERR_ABORTED'));
    await loading;
    assert.equal(BrowserWindow.getAllWindows().length,1,'closing during page loading must not reopen the window or report a load failure');
    let failureClosed;
    app.once('browser-window-created',(_event,window)=>{
      window.loadFile=()=>Promise.reject(new Error('fixture_load_failed'));
      failureClosed=new Promise(resolve=>window.once('closed',resolve));
    });
    await assert.rejects(manager.open('parent',{selectedText:'加载失败',selectedMessageText:'完整选区',sourceConversationId:'parent',targetedReplyLabel:'所选文本'}),/fixture_load_failed/);
    await failureClosed;
    assert.equal(BrowserWindow.getAllWindows().length,1,'a genuine page loading failure must close its window and remain observable');
    main.close(); console.log('detached explanation: real preload, original window and toolbar, first paint before conversation loading, theme sync, source binding, once-only turn, reload and close passed; show='+shownMs+'ms, content='+Math.round(paint.origin+paint.paint-openedAt)+'ms'); app.quit();
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
