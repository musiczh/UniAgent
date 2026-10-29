import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { embedStartupIcons } from '../src/renderer/startupMarkup'
import { APP_NAME } from '../src/shared/distribution'

// Exercise the real boot markup, CSP and lifecycle in an isolated Electron renderer.
const root = process.cwd(), directory = await mkdtemp(join(root, 'out/test/startup-dom-'))
let child: ReturnType<typeof spawn> | undefined
try {
  const css = await readFile('src/renderer/startup.css', 'utf8')
  const markup = embedStartupIcons(await readFile('src/renderer/startup.html', 'utf8'))
  const boot = (await readFile('src/renderer/boot.html', 'utf8'))
    .replace('<!-- uniagent-startup-style -->', `<style>${css}</style>`)
    .replace('<!-- uniagent-startup -->', markup + '<div class="app" style="position:fixed;inset:0;background:#203044">可用工作台</div>')
    .replace('./startup.ts', './fixture.js')
  await writeFile(join(directory, 'boot.html'), boot)
  await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `
      const realNow = performance.now.bind(performance);
      window.__startupResult = (async () => {
        const scenario = new URLSearchParams(location.search).get('scenario');
        const check = (condition, message) => { if (!condition) throw new Error(scenario+': '+message); };
        let now = 0, nextId = 0, completed = 0, offCount = 0, restarts = 0, failure;
        const frames = new Map(), listeners = new Set();
        const media = {matches:scenario === 'reduced',addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
        window.matchMedia = () => media;
        Object.defineProperty(performance,'now',{value:()=>now});
        Date.now = () => 1700000000000 + now;
        requestAnimationFrame = callback => { frames.set(++nextId,callback); return nextId; };
        cancelAnimationFrame = id => frames.delete(id);
        const advance = amount => {
          const end = now + amount;
          while (now < end) { now = Math.min(end,now+16); const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback(now)); }
        };
        window.uniagent = {
          onStartupFailed: callback => { failure=callback;return()=>{offCount++;}; },
          restartApp: async()=>{restarts++;throw new Error('fixture restart rejected');}
        };
        sessionStorage.clear();
        if (scenario === 'resume') sessionStorage.setItem('ua.startup-started-at','1699999995000');
        const screen = document.getElementById('ua-startup');
        const title = document.getElementById('ua-startup-title');
        const firstContent = !screen.hidden && title.textContent===${JSON.stringify(APP_NAME)} && getComputedStyle(title).opacity==='1' && title.getBoundingClientRect().width>0;
        check(firstContent,'brand content must be visible before startup JS initializes');
        const workspace = document.querySelector('.app');
        const brands = [...screen.querySelectorAll('.satellite')];
        check(brands.length===7,'all seven brands must be present');
        const snapshot = () => {
          const box = screen.querySelector('.cluster').getBoundingClientRect();
          return brands.map(element=>{
            const rect=element.getBoundingClientRect(),matrix=new DOMMatrix(getComputedStyle(element).transform);
            return {x:rect.left+rect.width/2-box.left-220,y:rect.top+rect.height/2-box.top-137.5,scale:Math.hypot(matrix.a,matrix.b)};
          });
        };
        const staticPositions = snapshot();
        check(brands.every(element=>element.getBoundingClientRect().width>0 && getComputedStyle(element).opacity!=='0'),'static brand icons are visible before initialization');
        const initializedAt = realNow();
        const {enterStartup,updateStartup} = await import('./src/renderer/startup');
        const initializationMs = realNow()-initializedAt;
        await Promise.all([...document.images].map(image=>image.decode()));
        check([...document.images].length===4 && [...document.images].every(image=>image.naturalWidth>0),'CSP must permit the four embedded shared icons');
        const before = snapshot();
        if (scenario !== 'resume') check(before.every((point,i)=>Math.hypot(point.x-staticPositions[i].x,point.y-staticPositions[i].y)<.03),'the static first frame already uses the expanded orbit positions');
        const checkOrbits = points => {
          const groups=[...screen.querySelectorAll('.orbit g')];
          points.forEach((point,i)=>{
            const group=groups[[0,1,0,1,0,1,0][i]], ellipse=group.querySelector('ellipse');
            const local=new DOMPoint(point.x+220,point.y+137.5).matrixTransform(group.transform.baseVal.consolidate().matrix.inverse());
            const residual=((local.x-ellipse.cx.baseVal.value)/ellipse.rx.baseVal.value)**2+((local.y-ellipse.cy.baseVal.value)/ellipse.ry.baseVal.value)**2;
            check(Math.abs(residual-1)<.001,'rendered loading icons follow the visible enlarged SVG tracks');
          });
        };
        checkOrbits(before);
        advance(1600);
        checkOrbits(snapshot());
        check(!screen.hidden && !screen.classList.contains('entering'),'elapsed loading time cannot trigger entry');
        if (scenario === 'reduced') {
          check(frames.size===0,'reduced motion must not schedule an orbit loop');
          updateStartup('正在初始化 Agent…');
          check(document.getElementById('ua-startup-stage').textContent==='正在初始化 Agent…','reduced-motion status must update immediately');
          enterStartup(()=>completed++);
          check(screen.hidden && completed===1 && frames.size===0,'reduced motion enters immediately after readiness');
        } else if (scenario === 'unload') {
          enterStartup(()=>completed++);advance(200);
          dispatchEvent(new Event('pagehide'));
          check(frames.size===0 && listeners.size===0 && offCount===1,'unloading cancels work and subscriptions');
          check(!document.querySelector('.startup-portal') && workspace.style.clipPath==='' && !document.body.classList.contains('startup-entering'),'unloading removes entry effects');
          check(completed===0,'unloading cannot announce startup completion');
          return {scenario,firstContent,initializationMs};
        } else if (scenario === 'resume') {
          const {STARTUP_ROUTES,sampleStartupMotion}=await import('./src/renderer/startupMotion');
          const expected=sampleStartupMotion(STARTUP_ROUTES[0],5000);
          check(Math.hypot(before[0].x-expected.screenX,before[0].y-expected.screenY)<.01,'navigation preserves the boot orbit clock');
        } else {
          const after=snapshot();
          check(after.every((point,i)=>Math.hypot(point.x-before[i].x,point.y-before[i].y)>30),'every brand keeps orbiting during loading');
          const cancelled=enterStartup(()=>completed++);advance(80);cancelled();
          check(!screen.classList.contains('entering') && workspace.style.opacity==='' && completed===0,'cancelled readiness returns to loading');
          check(screen.getAttribute('aria-busy')==='true' && frames.size===1,'cancel restores busy state and exactly one frame loop');
          const loading=snapshot();
          enterStartup(()=>completed++);cancelled();
          check(snapshot().every((point,i)=>Math.hypot(point.x-loading[i].x,point.y-loading[i].y)<.01),'entry continues from the current orbit position');
          check(screen.getAttribute('aria-busy')==='false','a stale cancellation cannot cancel a newer entry');
          if (scenario === 'fallback') {
            await new Promise(resolve=>setTimeout(resolve,2250));
            check(screen.hidden && completed===1 && frames.size===0,'a stopped frame source cannot leave the entry overlay stuck');
            check(workspace.style.clipPath==='' && workspace.style.opacity==='','the fallback reveals a clean workspace');
          } else if (scenario === 'preference') {
            advance(200);media.matches=true;listeners.forEach(callback=>callback());
            check(screen.hidden && completed===1 && frames.size===0,'changing motion preference during entry finishes once');
          } else if (scenario === 'failure') {
            advance(1450);failure();
            check(!screen.hidden && title.textContent==='启动异常' && !document.getElementById('ua-startup-restart').hidden,'failure keeps the restart UI visible');
            check(getComputedStyle(screen.querySelector('.core')).opacity==='1' && workspace.style.clipPath==='' && frames.size===0,'failure restores the core and removes masks');
            updateStartup('不要覆盖异常');enterStartup(()=>completed++);advance(4000);
            check(title.textContent==='启动异常' && completed===0,'failure cannot fall through to entry');
            document.getElementById('ua-startup-restart').click();await Promise.resolve();await Promise.resolve();
            check(restarts===1 && !document.getElementById('ua-startup-restart').disabled,'a rejected restart restores its button');
          } else {
            advance(550);
            const burst=snapshot();
            check(burst.every(point=>point.scale>1.99 && point.scale<=2.50001),'rendered icons stay within the approved 2× to 2.5× peak range');
            check(burst[2].scale>2.499 && new Set(burst.map(point=>point.scale.toFixed(2))).size===7,'the nearest icon reaches 2.5× while the other six use distinct sizes');
            check(Math.max(...burst.map(point=>point.x))-Math.min(...burst.map(point=>point.x))>1050,'the rendered burst uses the expanded range');
            check(brands.every(element=>{const box=element.getBoundingClientRect();return Math.min(box.left,box.top,innerWidth-box.right,innerHeight-box.bottom)>10;}),'larger rendered icons remain inside the window');
            check(new Set(burst.map(p=>(p.x<0?'L':'R')+(p.y<0?'U':'D'))).size===4 && burst.filter(p=>p.y>180).length>=2,'the real DOM burst covers all directions including down');
            check(getComputedStyle(title).opacity==='0','copy fades before downward trajectories cross it');
            advance(800);
            check(!screen.hidden && workspace.style.opacity==='1' && workspace.style.clipPath.startsWith('polygon'),'the real workspace appears through the portal');
            check(CSS.supports('clip-path',screen.style.clipPath),'the packaged Electron version supports the startup mask');
            advance(720);
            check(screen.hidden && completed===1 && frames.size===0,'the 2050ms entrance completes exactly once');
            check(workspace.style.clipPath==='' && workspace.style.transform==='' && workspace.style.opacity==='' && !document.body.classList.contains('startup-entering'),'completion leaves the workspace free of animation styles');
            check(!sessionStorage.getItem('ua.startup-started-at'),'completion clears the startup clock');
            enterStartup(()=>completed++);check(completed===2,'an already visible workspace completes immediately');
          }
        }
        dispatchEvent(new Event('pagehide'));
        check(frames.size===0 && listeners.size===0 && offCount===1,'all lifecycle work is disposed');
        return {scenario,firstContent,initializationMs,brands:brands.map(element=>element.dataset.agent)};
      })();
    ` }, bundle: true, platform: 'browser', format: 'esm', outfile: join(directory, 'fixture.js')
  })
  const resultPath = join(directory, 'result.json')
  await writeFile(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
    app.setPath('userData',${JSON.stringify(join(directory, 'user-data'))});app.disableHardwareAcceleration();
    app.whenReady().then(async()=>{
      app.dock?.hide();const window=new BrowserWindow({show:false,width:1280,height:820,useContentSize:true});
      const results=[];
      for(const scenario of ['normal','resume','reduced','preference','failure','unload','fallback']) {
        await window.loadFile(${JSON.stringify(join(directory, 'boot.html'))},{query:{scenario}});
        results.push(await window.webContents.executeJavaScript('window.__startupResult'));
      }
      fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(results));app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  const require = createRequire(resolve(root, 'package.json'))
  await new Promise<void>((resolveExit, reject) => {
    const env = { ...process.env, HOME: directory, UNIAGENT_USER_DATA: join(directory, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), ['--no-sandbox', join(directory, 'main.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-5000) })
    const timer = setTimeout(() => { child?.kill('SIGTERM'); reject(new Error('startup renderer fixture timed out: ' + stderr)) }, 25000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error('startup renderer exited ' + code + ': ' + stderr)) })
  })
  const results = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.deepEqual(results.map((result: { scenario: string }) => result.scenario), ['normal', 'resume', 'reduced', 'preference', 'failure', 'unload', 'fallback'])
  assert.ok(results.every((result: { firstContent: boolean }) => result.firstContent))
  console.log('startup animation: seven isolated Electron lifecycle scenarios passed; initialization ms: ' + results.map((result: { initializationMs: number }) => result.initializationMs.toFixed(1)).join(', '))
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true })
}
