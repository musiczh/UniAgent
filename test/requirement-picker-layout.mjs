import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const directory = await mkdtemp(join(root, 'out/test/requirement-picker-'))
const resultFile = join(directory, 'result.json')
let child
try {
  await build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {RequirementPicker} from './src/renderer/components/RequirementPicker';
      import {ProjectPicker} from './src/renderer/components/ProjectPicker';
      import './src/renderer/styles.css';
      const rows = ['当前需求', '切换目标', ...Array.from({length: 20}, (_, i) => '需求 ' + i)].map((name, i) => ({id: String(i), name, dir:'/requirements/' + name, status:'active'}));
      window.uniagent = {
        listRequirements: async () => rows,
        onRequirementsChanged: () => () => {},
        createRequirement: async ({name}) => ({id:'created', name, dir:'/requirements/' + name, status:'active'})
      };
      function Fixture() {
        const [value, setValue] = useState('0');
        const [disabled, setDisabled] = useState(false);
        window.disablePicker = () => setDisabled(true);
        return <div className="composer-box big" style={{position:'absolute', bottom:30, right:12, width:'calc(100% - 24px)', padding:16}}>
          <div className="config-bar">
          <ProjectPicker projects={[{id:'project', name:'默认项目', primaryDirectory:'/workspace', additionalDirectories:[]}]} projectId="project" disabled={disabled} workspaceSelection={new URLSearchParams(location.search).has('workspace') ? {mode:'local', baseRef:'HEAD'} : undefined} onWorkspaceChange={()=>{}} onSelect={()=>{}} onProjectsChange={()=>{}} />
          <RequirementPicker value={value} disabled={disabled} onChange={id => {window.selectedRequirement = id; setValue(id)}} />
          </div>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    ` },
    bundle: true, platform: 'browser', format: 'iife', outfile: join(directory, 'renderer.js')
  })
  await writeFile(join(directory, 'index.html'), '<link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>')
  const inspect = async function () {
    const check = (condition, message) => { if (!condition) throw new Error(message) }
    const wait = async probe => {
      const end = Date.now() + 5000
      while (!probe()) { check(Date.now() < end, 'picker state timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    await wait(() => document.querySelector('.requirement-picker > summary')?.textContent.includes('当前需求'))
    const picker = document.querySelector('.requirement-picker')
    const summary = picker.querySelector('summary')
    summary.click()
    await wait(() => picker.open)
    // Wait for the native details toggle and React layout effect to run.
    await new Promise(resolve => setTimeout(resolve, 50))
    const menu = picker.querySelector('.project-picker-pop')
    check(getComputedStyle(menu).visibility === 'visible', 'clicking the selected requirement must show its menu')
    check(getComputedStyle(picker.querySelector('.project-picker-create')).color === 'rgb(236, 236, 237)', 'new requirement must retain its existing text color')
    const inViewport = () => {
      const rect = menu.getBoundingClientRect()
      check(rect.width > 0 && rect.height > 0 && rect.left >= 11 && rect.top >= 39 && rect.right <= innerWidth - 11 && rect.bottom <= innerHeight - 11, 'requirement menu must stay inside the viewport')
    }
    inViewport()
    check(menu.getBoundingClientRect().bottom < summary.getBoundingClientRect().top, 'menu must open above a trigger near the bottom')
    const first = picker.querySelector('[role="option"]')
    const rect = first.getBoundingClientRect()
    check(first.contains(document.elementFromPoint(rect.left + 20, rect.top + rect.height / 2)), 'requirement options must be reachable by pointer')
    const composer = document.querySelector('.composer-box')
    composer.style.bottom = 'auto'
    composer.style.top = '45px'
    window.dispatchEvent(new Event('resize'))
    await wait(() => menu.getBoundingClientRect().top >= picker.getBoundingClientRect().bottom)
    inViewport()
    const input = picker.querySelector('.project-picker-search input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '切换目标')
    input.dispatchEvent(new Event('input', {bubbles:true}))
    await wait(() => picker.querySelectorAll('[role="option"]').length === 2)
    picker.querySelector('[role="option"]:last-child').click()
    await wait(() => !picker.open && summary.textContent.includes('切换目标'))
    check(window.selectedRequirement === '1', 'choosing a requirement must update the selected value')
    summary.click()
    await wait(() => picker.open && getComputedStyle(menu).visibility === 'visible')
    picker.querySelector('[role="option"]').click()
    await wait(() => !picker.open && summary.textContent.includes('选择需求'))
    check(window.selectedRequirement === undefined, 'ordinary sessions must be able to clear the requirement')
    summary.click()
    await wait(() => picker.open)
    picker.querySelector('.project-picker-create').click()
    await wait(() => picker.querySelector('.requirement-create-input input'))
    inViewport()
    picker.removeAttribute('open')
    await wait(() => !picker.querySelector('.requirement-create-input'))
    document.querySelector('.project-picker:not(.requirement-picker) > summary').click()
    await wait(() => {
      const projectMenu = document.querySelector('.project-picker:not(.requirement-picker) .project-picker-pop')
      return projectMenu && getComputedStyle(projectMenu).visibility === 'visible'
    })
    summary.click()
    await wait(() => picker.open && !document.querySelector('.project-picker:not(.requirement-picker)').open)
    picker.removeAttribute('open')
    window.disablePicker()
    await wait(() => summary.getAttribute('aria-disabled') === 'true')
    summary.click()
    check(!picker.open, 'disabled picker must remain closed')
    return {width:innerWidth, height:innerHeight, passed:true}
  }
  const inspectProjectCreate = async function (stage) {
    const check = (condition, message) => { if (!condition) throw new Error(message) }
    const wait = async probe => {
      const end = Date.now() + 5000
      while (!probe()) { check(Date.now() < end, 'project creation state timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    await wait(() => document.querySelector('.project-picker:not(.requirement-picker) > summary'))
    const picker = document.querySelector('.project-picker:not(.requirement-picker)')
    if (stage === 'open') {
      picker.querySelector('summary').click()
      await wait(() => {
        const menu = picker.querySelector('.project-picker-pop')
        return menu && getComputedStyle(menu).visibility === 'visible'
      })
    }
    const create = picker.querySelector('.project-picker-create')
    if (stage === 'click') {
      create.click()
      await wait(() => document.querySelector('[role="dialog"][aria-label="创建项目"]'))
      check(!picker.open, 'creating a space must close the picker')
      document.querySelector('.project-editor-head [aria-label="关闭"]').click()
      await wait(() => !document.querySelector('.project-editor-overlay'))
      return
    }
    if (stage === 'disable') {
      window.disablePicker()
      await wait(() => create.disabled)
    }
    if (stage === 'disabled-click') {
      create.click()
      check(!document.querySelector('.project-editor-overlay'), 'disabled creation must not open a dialog')
    }
    const style = getComputedStyle(create)
    const option = picker.querySelector('[role="option"]')
    const optionStyle = getComputedStyle(option)
    const rect = create.getBoundingClientRect()
    for (const x of [rect.left + 2, rect.right - 2]) {
      check(create.contains(document.elementFromPoint(x, rect.top + rect.height / 2)), 'the entire create row must be reachable by pointer')
    }
    return {color:style.color, iconColor:getComputedStyle(create.querySelector('svg')).color, background:style.backgroundColor, radius:style.borderRadius, optionBackground:optionStyle.backgroundColor, optionRadius:optionStyle.borderRadius, left:rect.left, right:rect.right, y:rect.top + rect.height / 2}
  }
  await writeFile(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron'); const fs=require('node:fs'); const assert=require('node:assert/strict');
    app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))}); app.disableHardwareAcceleration();
    app.whenReady().then(async()=>{
      app.dock?.hide(); const window=new BrowserWindow({show:false, useContentSize:true}); const results=[];
      for (const [width,height] of [[1280,820],[520,420]]) {
        window.setContentSize(width,height);
        await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
        results.push(await window.webContents.executeJavaScript(${JSON.stringify('(' + inspect.toString() + ')()')}));
        for (const workspace of [false, true]) {
          await window.loadFile(${JSON.stringify(join(directory, 'index.html'))}, {query:workspace ? {workspace:'1'} : {}});
          const inspectCreate = stage => window.webContents.executeJavaScript('(' + ${JSON.stringify(inspectProjectCreate.toString())} + ')(' + JSON.stringify(stage) + ')');
          const initial = await inspectCreate('open');
          assert.equal(initial.color, 'rgb(91, 157, 255)', 'new space must use the existing blue');
          assert.equal(initial.iconColor, initial.color, 'the plus icon must inherit the blue');
          assert.equal(initial.background, 'rgba(0, 0, 0, 0)', 'the default row must stay transparent');
          assert.equal(initial.radius, initial.optionRadius, 'new space must share the list item corner radius');
          const debug = window.webContents.debugger;
          debug.attach('1.3');
          try {
            const movePointer = (x, y) => debug.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved', x, y});
            await movePointer(initial.left + 2, initial.y);
            const hovered = await inspectCreate('style');
            assert.equal(hovered.background, initial.optionBackground, 'hover must use the same full-row background as list items');
            assert.equal(hovered.color, initial.color, 'hover must keep the text blue');
            assert.equal(hovered.iconColor, initial.iconColor, 'hover must keep the plus icon blue');
            await movePointer(initial.right - 2, initial.y);
            assert.equal((await inspectCreate('style')).background, initial.optionBackground, 'the far edge of the row must also highlight');
            await movePointer(0, 0);
            assert.equal((await inspectCreate('style')).background, initial.background, 'leaving the row must clear its highlight');
            await inspectCreate('click');
            await inspectCreate('open');
            await inspectCreate('disable');
            await movePointer(initial.left + 2, initial.y);
            assert.equal((await inspectCreate('disabled-click')).background, initial.background, 'disabled creation must not show a hover highlight');
          } finally { debug.detach(); }
        }
      }
      fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(results)); app.quit();
    }).catch(error=>{console.error(error); app.exit(1)});
  `)
  const require = createRequire(resolve(root, 'package.json'))
  await new Promise((resolveExit, reject) => {
    const env = { ...process.env, HOME: directory, UNIAGENT_USER_DATA: join(directory, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), ['--no-sandbox', join(directory, 'main.cjs')], { env, stdio:['ignore','ignore','pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('requirement picker fixture timed out: ' + stderr)) }, 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error('requirement picker fixture exited ' + code + ': ' + stderr)) })
  })
  assert.deepEqual(JSON.parse(await readFile(resultFile, 'utf8')), [{width:1280,height:820,passed:true},{width:520,height:420,passed:true}])
  console.log('Requirement picker: layout and behavior passed; project creation: blue text/icon, full-row hover, mouse leave, dialog and disabled state passed at 2 sizes with/without workspace options')
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await rm(directory, {recursive:true,force:true})
}
