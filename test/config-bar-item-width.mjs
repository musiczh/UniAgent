import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Render the actual pickers and config-bar styles without changing the composer
// width. Labels stay on one line; long names may use ellipsis inside their item.

const root = process.cwd()
const directory = await mkdtemp(join(root, 'out/test/config-bar-'))
const resultFile = join(directory, 'result.json')
let child
try {
  await build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {RequirementPicker} from './src/renderer/components/RequirementPicker';
      import {ProjectPicker} from './src/renderer/components/ProjectPicker';
      import {UiIcon} from './src/renderer/components/Icons';
      import './src/renderer/styles.css';
      const scenario = new URLSearchParams(location.search).get('scenario');
      const longNames = scenario === 'long-names';
      const longName = '这是一个需要保持单行并显示省略号的超长需求和空间名称';
      window.uniagent = {
        listRequirements: async () => [{id:'long', name:longName, dir:'/requirements/long', status:'active'}],
        onRequirementsChanged: () => () => {},
        createRequirement: async ({name}) => ({id:'created', name, dir:'/requirements/' + name, status:'active'})
      };
      function Fixture() {
        return <div className="new-task">
          <div className="composer-box">
            <div className="composer-main"><textarea className="prompt-input" rows={2} readOnly /></div>
            <div className="config-bar">
              <details className="sb-menu sb-add"><summary className="sb-add-btn" aria-label="功能、模板与附件"><UiIcon name="plus" size={18} /></summary></details>
              <ProjectPicker projects={[{id:'project', name:longNames ? longName : 'capcut_creator_learn', primaryDirectory:'/workspace', additionalDirectories:[]}]} projectId="project" onSelect={()=>{}} onProjectsChange={()=>{}} />
              {scenario !== 'no-requirement' && <RequirementPicker value={longNames ? 'long' : undefined} onChange={()=>{}} />}
              <label className="cfg">
                <span>权限</span>
                <select defaultValue="full-access" aria-label="权限">
                  <option value="full-access">完全放开</option>
                </select>
              </label>
              <details className="sb-menu sb-agent">
                <summary className="sb-effort-btn nt-mode-trigger">
                  <span className="sb-effort-ico"><UiIcon name="identity" size={14} /></span>
                  <span className="sb-effort-model">M3.1-Flash（订阅限免）· thinking</span>
                  <span className="sb-effort-lvl">最大</span>
                </summary>
              </details>
              <span className="sb-spacer" />
              <button className="btn-send new-task-send-btn" aria-label="开始"><UiIcon name="arrow-up" size={16} /></button>
            </div>
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
      while (!probe()) { check(Date.now() < end, 'config bar state timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    await wait(() => document.querySelector('.config-bar .project-picker-trigger'))
    const scenario = new URLSearchParams(location.search).get('scenario')
    if (scenario === 'long-names') await wait(() => document.querySelector('.requirement-picker > summary')?.textContent.includes('这是一个'))
    const textLines = element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size
    }
    const bar = document.querySelector('.config-bar')
    const labels = Array.from(bar.querySelectorAll('.cfg > span, .cfg-dir > span, .sb-effort-model, .sb-effort-lvl'))
    check(labels.length >= 4, 'the fixture must expose every labelled control of the bar')
    const wrapped = labels.filter(label => textLines(label) > 1)
    check(wrapped.length === 0, 'labels must not wrap: ' + wrapped.map(label => label.textContent.trim() + '(' + textLines(label) + ' lines)').join(', '))
    for (const label of labels) {
      if (label.getBoundingClientRect().width + 1 >= label.scrollWidth) continue
      const style = getComputedStyle(label)
      check(style.overflow === 'hidden' && style.textOverflow === 'ellipsis', 'clipped names must show an ellipsis: ' + label.textContent)
    }
    const composer = document.querySelector('.composer-box')
    const composerRect = composer.getBoundingClientRect()
    check(Math.abs(composerRect.width - Math.min(720, innerWidth - 80)) <= 1, 'the existing composer width must stay unchanged')
    const barRect = bar.getBoundingClientRect()
    const controls = Array.from(bar.children).filter(child => !child.classList.contains('sb-spacer'))
    for (const control of controls) {
      const style = getComputedStyle(control)
      const minWidth = parseFloat(style.minWidth) || 0
      const width = control.getBoundingClientRect().width
      check(width + 0.5 >= minWidth, 'control ' + control.className + ' is narrower than its minimum width')
      check(width >= 24, 'control ' + control.className + ' collapsed to ' + width + 'px')
      check(control.getBoundingClientRect().height <= 40, 'control ' + control.className + ' grew taller than one row')
      const rect = control.getBoundingClientRect()
      check(rect.left >= barRect.left - 1 && rect.right <= barRect.right + 1, 'control ' + control.className + ' must remain inside the composer')
    }
    for (const picker of bar.querySelectorAll('.project-picker')) {
      const width = picker.getBoundingClientRect().width
      check(width >= 108 && width <= 220, 'pickers must keep their minimum width and bound long names')
    }
    const permission = bar.querySelector('.cfg')
    check(permission.getBoundingClientRect().width >= 108, 'permission control must keep its minimum width')
    const send = bar.querySelector('.new-task-send-btn').getBoundingClientRect()
    check(send.width === 30 && send.height === 30, 'send button must keep its existing circular size')
    const model = bar.querySelector('.sb-agent').getBoundingClientRect()
    check(model.width >= 160 && model.width <= 260, 'model item must keep its minimum width and bound long names')
    if (scenario !== 'no-requirement') check(model.top > controls[0].getBoundingClientRect().top + 10, 'crowded items must move intact to another row')
    const selectedRequirement = bar.querySelector('.requirement-picker > summary > span')
    if (scenario === 'long-names') check(selectedRequirement.scrollWidth > selectedRequirement.clientWidth, 'long requirement fixture must exercise ellipsis')
    return {
      width: innerWidth,
      height: innerHeight,
      scenario,
      composerWidth: composerRect.width,
      barHeight: bar.getBoundingClientRect().height,
      lines: labels.map(label => textLines(label)),
      passed: true
    }
  }
  await writeFile(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron'); const fs=require('node:fs');
    app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))}); app.disableHardwareAcceleration();
    app.whenReady().then(async()=>{
      app.dock?.hide(); const window=new BrowserWindow({show:false, useContentSize:true}); const results=[];
      for (const [width,height] of [[1280,820],[960,760],[820,720],[700,680],[560,640]]) {
        window.setContentSize(width,height);
        for (const scenario of ['default', 'long-names', 'no-requirement']) {
          await window.loadFile(${JSON.stringify(join(directory, 'index.html'))}, {query:{scenario}});
          results.push(await window.webContents.executeJavaScript(${JSON.stringify('(' + inspect.toString() + ')()')}));
        }
      }
      fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(results)); app.quit();
    }).catch(error=>{console.error(error); app.exit(1)});
  `)
  const require = createRequire(resolve(root, 'package.json'))
  await new Promise((resolveExit, reject) => {
    const env = { ...process.env, HOME: directory, UNIAGENT_USER_DATA: join(directory, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), ['--no-sandbox', join(directory, 'main.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('config bar fixture timed out: ' + stderr)) }, 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error('config bar fixture exited ' + code + ': ' + stderr)) })
  })
  const results = JSON.parse(await readFile(resultFile, 'utf8'))
  assert.equal(results.length, 15)
  for (const result of results) {
    assert.equal(result.passed, true)
    assert.ok(result.lines.every(lines => lines === 1), 'every label must render on one line at ' + result.width + 'px')
  }
  console.log('Config bar: 15 layouts passed; composer width unchanged, single-line labels, item bounds, long-name ellipsis and send-button size')
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true })
}
