import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { rendererRuntimePlugin } from './regression/render-event-stream.mjs'

const root = process.cwd()
const directory = await mkdtemp(join(root, 'out/test/automation-editor-'))
const resultFile = join(directory, 'result.json')
const screenshot = join(root, 'out/test/automation-time-picker.png')
let child
try {
  await build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {AutomationsPanel} from './src/renderer/components/AutomationsPanel';
      import './src/renderer/styles.css';
      window.tasks=[]; window.saved=[]; window.patches=[]; window.retries=[];
      window.requirements=[{id:'req',name:'测试需求',projectId:'default',status:'active'}];
      window.uniagent={
        listAutomations:async()=>structuredClone(window.tasks),
        listAgents:async()=>[{id:'codex',name:'Codex',adapter:'codex',defaultModel:'model-1',lifecycle:{availability:'available'},
          capabilities:{modelSelect:true,reasoningEffort:true,permissionModes:[{id:'read-only',label:'只读'}]},
          models:[{id:'model-1',label:'Model 1',efforts:['high'],defaultEffort:'high'}]}],
        listProjects:async()=>[{id:'default',name:'测试空间',primaryDirectory:'/test',additionalDirectories:[],isDefault:true},{id:'other',name:'另一个空间',primaryDirectory:'/other',additionalDirectories:[]}],
        listRequirements:async()=>{if(window.requirementsFail)throw Error('read failed');return structuredClone(window.requirements)},
        onRequirementsChanged:callback=>{window.notifyRequirements=callback;return()=>{}},
        getPrefs:async()=>({lastByAgent:{}}),
        onPrefsChanged:()=>()=>{},onAutomationsChanged:callback=>{window.notifyAutomations=callback;return ()=>{}},onLifecycleProgress:()=>()=>{},
        createAutomation:async input=>{window.saved.push(input);window.tasks.push({...input,id:'created-'+window.saved.length,source:'uniagent',status:'active',nextRunAt:input.schedule.startsWith('ONCE:')?Date.parse(input.schedule.slice(5)):Date.now()+86400000});},
        getAutomationDetail:async task=>structuredClone(window.tasks.find(item=>item.id===task.id)),
        retryAutomation:async task=>{
          window.retries.push(structuredClone(task));
          if(window.retryError)throw Error(window.retryError);
          const current=window.tasks.find(item=>item.id===task.id);
          Object.assign(current,{lastRunAt:Date.now(),lastRunStatus:'running',lastRunError:undefined,lastSessionId:undefined});
          window.notifyAutomations();
          if(window.retryWait)await new Promise(resolve=>{window.releaseRetry=resolve});
          current.lastSessionId='retry-session';
          window.notifyAutomations(); return structuredClone(current);
        },
        updateAutomation:async(task,patch)=>{window.patches.push(patch);Object.assign(window.tasks.find(item=>item.id===task.id),patch);return true;}
      };
      function Fixture(){const [enabled,setEnabled]=useState(true);window.setRequirementsEnabled=setEnabled;return <AutomationsPanel requirementsEnabled={enabled} onOpenSession={id=>{window.openedSession=id}} />}
      createRoot(document.getElementById('root')).render(<Fixture />);
    ` },
    bundle: true, platform: 'browser', format: 'iife', outfile: join(directory, 'renderer.js'),
    plugins: [rendererRuntimePlugin(directory)]
  })
  await writeFile(join(directory, 'index.html'), '<link rel="stylesheet" href="renderer.css"><div id="root" style="height:100vh;display:flex"></div><script src="renderer.js"></script>')
  const inspect = async function () {
    const check = (condition, message) => { if (!condition) throw new Error(message) }
    const wait = async probe => {
      const end = Date.now() + 5000
      while (!probe()) { check(Date.now() < end, 'automation editor state timed out: ' + probe.toString()); await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    const button = text => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text)
    const fill = (label, value) => {
      const element = document.querySelector('[aria-label="' + label + '"]')
      Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(() => button('＋ 新建任务') && !button('＋ 新建任务').disabled)
    button('＋ 新建任务').click()
    await wait(() => document.querySelector('.sched-time-picker'))
    const promptInput = () => document.querySelector('.auto-prompt-input')
    const promptPreview = () => document.querySelector('.auto-prompt-preview')
    const checkSectionTitles = () => {
      const titles = [...document.querySelectorAll('.auto-main-form .auto-card-head')]
      check(titles.map(title => title.firstChild.textContent.trim()).join('|') === '任务内容|执行配置|执行计划' && !titles.some(title => title.querySelector('span')),
        'editor sections must display plain titles without numbered badges')
      check(titles.every(title => Math.abs(title.getBoundingClientRect().left-document.querySelector('.auto-name-input').getBoundingClientRect().left)<1),
        'section titles must align with the form fields')
    }
    const checkPromptScrollbar = element => {
      const style = getComputedStyle(element)
      check(style.scrollbarWidth === 'thin' && style.scrollbarColor === style.borderTopColor+' rgba(0, 0, 0, 0)',
        'prompt edit and preview must use a thin border-colored thumb with a transparent track: '+style.scrollbarColor)
    }
    checkSectionTitles()
    checkPromptScrollbar(promptInput())
    const markdown = '## 巡检日报\n\n**重点**与 `period=day`。\n\n' + Array.from({length:16},(_,i)=>(i+1)+'. 检查项目状态 '+i).join('\n') + '\n\n<script>window.unsafePrompt=true</script>\n\n[危险链接](javascript:alert(1))'
    check(!promptInput().hidden && !promptPreview(), 'new tasks must start in edit mode')
    check(!document.querySelector('.auto-last-run'), 'new tasks must not present an execution result')
    const promptStyle = getComputedStyle(document.querySelector('.auto-prompt-input'))
    const promptMaxHeight = parseFloat(promptStyle.maxHeight)
    const chromeHeight = parseFloat(promptStyle.paddingTop)+parseFloat(promptStyle.paddingBottom)+parseFloat(promptStyle.borderTopWidth)+parseFloat(promptStyle.borderBottomWidth)
    check(promptStyle.resize === 'none' && Math.abs(parseFloat(promptStyle.maxHeight)-parseFloat(promptStyle.lineHeight)*10-chromeHeight)<1,
      'prompt must retain its ten-line scrolling limit without a resize handle')
    check(CSS.supports('field-sizing','content'), 'the packaged Chromium must support native content-sized inputs')
    fill('指令 / 提示词', markdown)
    await wait(() => promptInput().scrollHeight > promptInput().clientHeight)
    check(promptInput().offsetHeight <= Math.ceil(promptMaxHeight), 'long raw Markdown must grow only to the ten-line cap')
    promptInput().scrollTop = promptInput().scrollHeight
    check(promptInput().scrollTop > 0 && promptInput().value === markdown, 'long input must scroll without truncating the original value')
    fill('指令 / 提示词', '短指令')
    await wait(() => promptInput().offsetHeight < 100)
    check(promptInput().offsetHeight >= 60, 'short input must shrink to the existing minimum height')
    button('预览').click()
    await wait(() => promptPreview())
    checkPromptScrollbar(promptPreview())
    check(promptPreview().scrollHeight === promptPreview().clientHeight, 'short preview must not require internal scrolling')
    button('编辑').click()
    await wait(() => !promptInput().hidden && !promptPreview())
    const trigger = document.querySelector('.sched-time-picker')
    for (const target of [trigger.querySelector('span'), trigger.querySelector('svg'), trigger]) {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(() => document.querySelector('[role="dialog"][aria-label="选择触发时间"]'))
      check(trigger.getAttribute('aria-expanded') === 'true', 'the entire time field must open the popup')
      const popup = document.querySelector('.sched-time-popover')
      const rect = popup.getBoundingClientRect()
      check(rect.width > 200 && rect.height < 370 && rect.left >= 11 && rect.right <= innerWidth - 11 && rect.top >= 11 && rect.bottom <= innerHeight - 11,
        'custom time popup must stay compact and inside the viewport')
      check(getComputedStyle(popup).borderRadius === '12px', 'time popup must use the settings visual style')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wait(() => !document.querySelector('.sched-time-popover'))
      check(document.activeElement === trigger, 'Escape must return focus to the time field')
    }
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await wait(() => document.querySelector('.sched-time-popover'))
    const lists = document.querySelectorAll('.sched-time-options')
    check(lists[0].querySelectorAll('[role="option"]').length === 24 && lists[1].querySelectorAll('[role="option"]').length === 60,
      'all hours and minutes must be selectable')
    lists[0].querySelectorAll('button')[23].click()
    await wait(() => trigger.textContent.includes('23:00'))
    lists[1].querySelectorAll('button')[59].click()
    await wait(() => trigger.textContent.includes('23:59'))
    const selectedMinute = lists[1].querySelector('[aria-selected="true"]')
    selectedMinute.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    check(trigger.textContent.includes('23:59'), 'keyboard selection must not exceed the last minute')
    selectedMinute.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await wait(() => trigger.textContent.includes('23:00'))
    check(document.activeElement.textContent === '00', 'keyboard navigation must move focus with the selected minute')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await wait(() => !document.querySelector('.sched-time-popover'))
    trigger.click()
    await wait(() => button('完成'))
    button('完成').click()
    await wait(() => !document.querySelector('.sched-time-popover'))

    button('每天').click()
    button('法定工作日').click()
    fill('任务名称', '工作日巡检')
    fill('指令 / 提示词', markdown)
    await wait(() => button('创建并启用') && !button('创建并启用').disabled)
    button('创建并启用').click()
    await wait(() => window.saved.length === 1 && document.querySelector('.auto-name')?.textContent.includes('工作日巡检'))
    check(window.saved[0].dayMode === 'workday', 'create must pass the workday choice to the backend')
    check(window.saved[0].schedule === 'RRULE:FREQ=DAILY;BYHOUR=23;BYMINUTE=0', 'custom time selection must reach the saved schedule')
    check(window.saved[0].prompt === markdown, 'creation must save the full raw Markdown rather than preview HTML')
    check(document.querySelector('.auto-list-plan').textContent.includes('法定工作日'), 'list must expose the date filter')
    document.querySelector('.auto-name').click()
    await wait(() => button('非法定工作日'))
    checkSectionTitles()
    check(promptInput().hidden && promptPreview(), 'existing task details must default to Markdown preview')
    checkPromptScrollbar(promptPreview())
    check(promptPreview().querySelector('h2').textContent === '巡检日报' && promptPreview().querySelector('strong').textContent === '重点' && promptPreview().querySelector('code').textContent === 'period=day' && promptPreview().querySelectorAll('ol li').length === 16,
      'preview must render headings, emphasis, inline code and the full list')
    check(!promptPreview().querySelector('script,a[href^="javascript:"]') && !window.unsafePrompt, 'preview must reuse the Markdown sanitizer')
    check(promptPreview().offsetHeight <= Math.ceil(promptMaxHeight) && promptPreview().scrollHeight > promptPreview().clientHeight,
      'long rendered Markdown must stay inside the ten-line scrolling region')
    promptPreview().scrollTop = promptPreview().scrollHeight
    check(promptPreview().scrollTop > 0, 'rendered Markdown must remain scrollable to its final lines')
    check(!document.querySelector('.auto-hero-main p,.auto-task-hero .auto-run-summary,.auto-runtime-notes'), 'detail must omit the duplicated hero fields and former runtime notes')
    check(document.querySelector('.auto-last-run .auto-run-summary').textContent === '尚未运行' && !document.querySelector('.auto-last-run .auto-run-link'),
      'a task without execution history must have one empty-state summary and no session link')
    button('编辑').click()
    await wait(() => !promptInput().hidden && !promptPreview())
    check(promptInput().value === markdown && button('保存修改').disabled, 'switching to edit must preserve the original Markdown and leave the task clean')
    const updatedMarkdown = markdown + '\n\n新增末行，保存时须完整保留。'
    fill('指令 / 提示词', updatedMarkdown)
    button('预览').click()
    await wait(() => promptPreview()?.textContent.includes('新增末行'))
    check(!button('保存修改').disabled, 'previewing an edit must retain unsaved changes')
    check(button('法定工作日').getAttribute('aria-pressed') === 'true', 'detail must restore the stored date filter')
    button('非法定工作日').click()
    await wait(() => !button('保存修改').disabled)
    button('保存修改').click()
    await wait(() => window.patches.length === 1 && button('保存修改').disabled)
    check(window.patches[0].dayMode === 'non-workday', 'edit must persist the new date filter')
    check(window.patches[0].prompt === updatedMarkdown, 'saving from preview must preserve all raw Markdown and its final line')
    check(document.querySelector('.auto-schedule-rule').textContent.includes('同时满足'), 'the date filter must explain the intersection')
    button('返回').click()
    await wait(() => button('＋ 新建任务'))
    button('＋ 新建任务').click()
    await wait(() => button('一次性'))
    button('法定工作日').click()
    button('一次性').click()
    await wait(() => document.querySelector('.auto-date-picker'))
    check(!button('法定工作日'), 'one-off must hide the date filter')
    fill('任务名称', '一次性提醒')
    fill('指令 / 提示词', '只检查一次')
    const picker = document.querySelector('.auto-date-picker')
    picker.click()
    await wait(() => document.querySelector('[aria-label="选择执行日期"]'))
    const datePopup = document.querySelector('.auto-date-popover').getBoundingClientRect()
    check(datePopup.left >= 11 && datePopup.right <= innerWidth - 11 && datePopup.top >= 11 && datePopup.bottom <= innerHeight - 11,
      'date picker must remain inside the viewport')
    const today = new Date()
    const dayKey = date => date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0')
    for (const cell of document.querySelectorAll('[data-date]')) {
      if (cell.dataset.date < dayKey(today)) check(cell.disabled, 'past calendar days must be disabled')
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(() => !document.querySelector('.auto-date-popover'))
    check(document.activeElement === picker, 'date picker must restore focus after Escape')
    picker.click()
    await wait(() => button('今天'))
    button('今天').click()
    document.querySelector('.sched-time-picker').click()
    await wait(() => document.querySelector('.sched-time-options'))
    const timeLists = document.querySelectorAll('.sched-time-options')
    timeLists[0].querySelector('button').click()
    await wait(() => document.querySelector('.sched-time-picker').textContent.includes('00:'))
    timeLists[1].querySelector('button').click()
    await wait(() => document.querySelector('.sched-time-picker').textContent.includes('00:00'))
    button('完成').click()
    await wait(() => button('创建并启用').disabled)
    check(document.querySelector('[role="alert"]').textContent.includes('执行时间已过'), 'past one-off times must explain why creation is disabled')
    picker.click()
    await wait(() => document.querySelector('.auto-date-popover'))
    const future = new Date(today.getFullYear(), today.getMonth(), today.getDate()+2)
    const futureKey = dayKey(future)
    document.querySelector('[data-date="'+futureKey+'"]').click()
    await wait(() => !button('创建并启用').disabled)
    button('创建并启用').click()
    await wait(() => window.saved.length === 2 && document.querySelectorAll('.auto-task-row').length === 2)
    check(window.saved[1].dayMode === 'all', 'switching to one-off must clear the previous date filter')
    check(window.saved[1].schedule === 'ONCE:'+future.toISOString(), 'one-off creation must send the exact local date and selected time')
    const created = window.tasks.find(task => task.id === 'created-2')
    Object.assign(created, { status:'completed', nextRunAt:undefined, lastRunAt:Date.now(), lastRunStatus:'success', lastSessionId:'once-session' })
    window.notifyAutomations()
    await wait(() => [...document.querySelectorAll('.auto-task-row')].some(row => row.textContent.includes('一次性提醒') && row.textContent.includes('已结束')))
    const row = [...document.querySelectorAll('.auto-task-row')].find(row => row.textContent.includes('一次性提醒'))
    check(row.querySelector('[role="switch"]').disabled, 'completed one-off must not be enabled again with a toggle')
    row.querySelector('.auto-run-link').click()
    check(window.openedSession === 'once-session' && !document.querySelector('.auto-date-picker'), 'recent run link must open the execution session without opening task details')
    row.querySelector('.auto-name').click()
    await wait(() => document.querySelector('.auto-date-picker'))
    check(document.querySelector('.auto-date-picker').textContent.includes(futureKey), 'detail must restore the selected one-off date')
    check(button('一次性').getAttribute('aria-pressed') === 'true', 'detail must restore one-off mode')
    fill('任务名称','一次性结果保留')
    await wait(() => !button('保存修改').disabled)
    button('保存修改').click()
    await wait(() => window.patches.length === 2 && button('保存修改').disabled)
    check(!('schedule' in window.patches[1]), 'ordinary edits to a completed one-off must not change or rearm its schedule')
    button('返回').click()
    await wait(() => button('＋ 新建任务'))
    button('＋ 新建任务').click()
    await wait(() => document.querySelector('.auto-ownership summary'))
    fill('任务名称','需求定时检查');fill('指令 / 提示词','检查需求')
    const choose = async name => {
      document.querySelector('.auto-ownership summary').click()
      await wait(() => document.querySelector('.auto-ownership [role="listbox"]'))
      const option=[...document.querySelectorAll('.auto-ownership [role="option"]')].find(item=>item.textContent.includes(name))
      check(option && !option.disabled,'ownership option must be available: '+name);option.click()
      await wait(() => !document.querySelector('.auto-ownership [role="listbox"]'))
    }
    await choose('测试需求')
    check(document.querySelector('.auto-ownership summary').textContent.includes('测试需求'),'requirement must replace the space in the trigger')
    check(document.querySelector('.auto-ownership-space').textContent.includes('测试空间'),'requirement main space must stay visible')
    await wait(() => !button('创建并启用').disabled)
    button('创建并启用').click()
    await wait(() => window.saved.length===3 && document.querySelector('.auto-list'))
    check(JSON.stringify(window.saved[2].taskScope)==='{"kind":"requirement","requirementId":"req"}' && !window.saved[2].projectId,'requirement creation must send a single stable ownership without a space snapshot')
    const requirementRow=[...document.querySelectorAll('.auto-task-row')].find(item=>item.textContent.includes('需求定时检查'))
    check(requirementRow.querySelector('.auto-row-scope').textContent==='需求：测试需求','list must show requirement ownership')
    requirementRow.querySelector('.auto-name').click()
    await wait(() => document.querySelector('.auto-ownership-space'))
    await choose('另一个空间')
    button('放弃修改').click()
    await wait(() => document.querySelector('.auto-ownership summary').textContent.includes('测试需求'))
    window.requirements[0].projectId='other';window.notifyRequirements()
    await wait(() => document.querySelector('.auto-ownership-space').textContent.includes('另一个空间'))
    check(button('保存修改').disabled,'a changed main space must not dirty or rewrite a requirement plan')
    window.requirementsFail=true;window.notifyRequirements()
    await wait(() => document.querySelector('.auto-ownership-error'))
    fill('任务名称','需求定时检查更新')
    check(button('保存修改').disabled,'failed requirement reads must block saving a selected requirement')
    window.requirementsFail=false;button('重试').click()
    await wait(() => !document.querySelector('.auto-ownership-error') && !button('保存修改').disabled)
    window.setRequirementsEnabled(false)
    await wait(() => document.querySelector('.auto-save-feedback')?.textContent.includes('需求功能已停用') || document.body.textContent.includes('需求功能已停用'))
    check(button('保存修改').disabled,'turning requirements off must preserve and block the old requirement selection')
    await choose('测试空间')
    await wait(() => !button('保存修改').disabled)
    button('保存修改').click()
    await wait(() => window.patches.length===3 && button('保存修改').disabled)
    check(JSON.stringify(window.patches[2].taskScope)==='{"kind":"space","projectId":"default"}','switching back to space must persist the replacement scope')
    check(!document.querySelector('.auto-ownership-space'),'a space must clear the old requirement main-space hint')
    button('返回').click();await wait(() => document.querySelector('.auto-list'))
    window.setRequirementsEnabled(true)
    await wait(() => document.querySelector('.auto-list'))
    window.tasks = Array.from({ length: 8 }, (_, index) => ({ ...window.tasks[0], id:'list-'+index,
      name:index === 0 ? '每日大模型信息' : index === 1 ? '很长的任务名称'.repeat(16) : '任务 '+index,
      status:index === 0 ? 'active' : 'paused', prompt:'使用 experiment-monitor Skill（/Users/example/.agents/skills/experiment-monitor）',
      lastRunAt:index === 0 ? Date.now() : undefined, lastRunStatus:index === 0 ? 'error' : undefined,
      lastSessionId:undefined, lastRunError:index === 0 ? '所选 Agent 当前不可用，请等待就绪或重新选择' : undefined
    }))
    window.notifyAutomations()
    await wait(() => document.querySelectorAll('.auto-task-row').length === 8)
    const first = document.querySelector('.auto-task-row')
    check(first.querySelector('.auto-run-summary').textContent.includes('未能启动'), 'a failure before session creation must be distinguished from a failed execution')
    check(first.querySelector('.auto-run-summary').title === window.tasks[0].lastRunError, 'the recent-run summary must expose the recorded failure reason')
    for (const item of document.querySelectorAll('.auto-task-row')) {
      check(!item.querySelector('.auto-prompt') && !item.textContent.includes('/Users/example'), 'list rows must omit prompt previews and local skill paths')
      check([...item.querySelectorAll('.auto-badge')].every(badge => badge.textContent !== '已暂停'), 'the title must not repeat the switch state as a paused badge')
    }
    const firstStyle = getComputedStyle(first.querySelector('.auto-run-summary'))
    check(firstStyle.marginTop === '0px' && firstStyle.marginLeft === '0px' && firstStyle.paddingTop === '0px' && firstStyle.backgroundColor === 'rgba(0, 0, 0, 0)',
      'failed summary must not inherit the detail error banner spacing and background')
    Object.assign(window.tasks[0], { lastSessionId:'failed-session' })
    window.notifyAutomations()
    await wait(() => first.querySelector('.auto-run-summary').textContent.includes('执行失败'))
    first.querySelector('.auto-name').click()
    await wait(() => document.querySelector('.auto-run-error-detail'))
    const execution = () => document.querySelector('.auto-last-run')
    const retry = () => execution().querySelector('.auto-retry')
    check(retry() && !retry().disabled && retry().textContent.includes('重试'), 'a failed native run must offer retry beside the card title')
    check(document.querySelectorAll('.auto-run-summary').length === 1 && document.querySelectorAll('.auto-run-error-detail').length === 1,
      'detail must show the result and error only once')
    check(execution().querySelector('.auto-run-error-detail p').textContent === window.tasks[0].lastRunError, 'the side card must retain the full failure reason')
    check(execution().querySelector('.auto-run-summary small').textContent && execution().textContent.includes('执行失败'), 'the side card must include the recorded time and status')
    execution().querySelector('.auto-run-link').click()
    check(window.openedSession === 'failed-session', 'the side card session link must open the last execution')
    fill('任务名称','有未保存修改')
    await wait(() => execution().querySelector('.auto-run-link').disabled)
    check(retry().disabled && retry().title.includes('保存'), 'unsaved changes must disable retry with an explanation')
    retry().click()
    check(window.retries.length === 0, 'unsaved changes must never submit a retry')
    window.openedSession = null
    execution().querySelector('.auto-run-link').click()
    check(window.openedSession === null, 'unsaved edits must keep the session link protected')
    button('放弃修改').click()
    await wait(() => !execution().querySelector('.auto-run-link').disabled)
    for (const [status,label] of [['success','执行成功'],['running','正在执行'],['awaiting-approval','等待授权'],['unknown','状态未知']]) {
      Object.assign(window.tasks[0], {lastRunStatus:status,lastRunError:'旧错误不应展示'})
      window.notifyAutomations()
      await wait(() => execution().querySelector('.auto-run-summary > span').textContent === label)
      check(!execution().querySelector('.auto-run-error-detail'), 'non-error execution states must omit stale errors: '+status)
      check(!retry(), 'non-error execution states must not offer retry: '+status)
    }
    Object.assign(window.tasks[0], {lastRunStatus:'error',lastRunError:'未能创建执行会话',lastSessionId:undefined})
    window.notifyAutomations()
    await wait(() => execution().textContent.includes('未能启动'))
    check(!execution().querySelector('.auto-run-link') && execution().querySelector('.auto-run-error-detail p').textContent === '未能创建执行会话',
      'failure before session creation must show its reason without an invalid session link')
    check(retry() && !retry().disabled, 'failure before session creation must allow retry')
    window.retryError = 'Agent 验证失败'
    retry().click()
    await wait(() => document.querySelector('.auto-detail-error')?.textContent.includes('Agent 验证失败') && !retry().disabled)
    check(window.retries.length === 1 && execution().textContent.includes('未能启动'), 'a rejected retry must preserve the failure and release the button')
    window.retryError = null
    window.retryWait = true
    const failedRun = structuredClone(window.tasks[0])
    retry().click()
    retry().click()
    await wait(() => retry().textContent === '重试中…')
    await wait(() => window.tasks[0].lastRunStatus === 'running')
    check(retry().disabled && window.retries.length === 2, 'repeated clicks must submit only one retry')
    check(execution().textContent.includes('未能启动'), 'the previous failure must stay visible while submitting')
    check(button('保存修改').textContent === '保存修改', 'retry must not relabel the save action as saving')
    window.releaseRetry()
    await wait(() => execution().textContent.includes('正在执行') && !retry())
    check(window.retries[1].id === failedRun.id && window.retries[1].lastRunAt === failedRun.lastRunAt,
      'retry must submit the identity of the displayed failed execution')
    check(window.tasks[0].nextRunAt === failedRun.nextRunAt && window.tasks[0].status === failedRun.status, 'retry must preserve the planned time and enable state')
    execution().querySelector('.auto-run-link').click()
    check(window.openedSession === 'retry-session', 'successful retry must expose the new execution session')
    Object.assign(window.tasks[0], {lastRunStatus:'error',lastRunError:'再次执行失败'})
    window.notifyAutomations()
    await wait(() => retry() && !retry().disabled)
    Object.assign(window.tasks[0], {source:undefined,path:'/test/automation.toml'})
    window.notifyAutomations()
    button('返回').click()
    await wait(() => document.querySelector('.auto-list'))
    document.querySelector('.auto-task-row .auto-name').click()
    await wait(() => execution()?.textContent.includes('再次执行失败'))
    check(!retry(), 'CLI-owned schedules must not expose the UniAgent retry operation')
    button('返回').click()
    await wait(() => document.querySelector('.auto-list'))
    return { saved: window.saved, patches: window.patches }
  }
  const inspectListLayout = function () {
    const check = (condition, message) => { if (!condition) throw new Error(message) }
    const list = document.querySelector('.auto-list')
    check(list.scrollWidth <= list.clientWidth + 1, 'task list must not overflow horizontally')
    check(list.scrollHeight > list.clientHeight, 'many tasks must scroll instead of compressing their rows')
    for (const row of document.querySelectorAll('.auto-task-row')) {
      const bounds = row.getBoundingClientRect()
      check(bounds.height >= 70, 'task rows must retain their minimum height')
      for (const cell of row.children) {
        const rect = cell.getBoundingClientRect()
        check(rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right,
          'task row content must remain inside the card: ' + cell.className)
      }
      const title = row.querySelector('.auto-name').getBoundingClientRect()
      const badge = row.querySelector('.auto-badge').getBoundingClientRect()
      check(Math.abs((title.top + title.bottom - badge.top - badge.bottom) / 2) < 1, 'task name and source badge must share a centered line')
    }
  }
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron'); const fs=require('node:fs');
    app.setPath('userData',${JSON.stringify(join(directory, 'user-data'))}); app.disableHardwareAcceleration();
    app.whenReady().then(async()=>{app.dock?.hide();const window=new BrowserWindow({show:false,width:1000,height:850});
      await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
      const result=await window.webContents.executeJavaScript('('+${JSON.stringify(inspect.toString())}+')()');
      await window.webContents.executeJavaScript('('+${JSON.stringify(inspectListLayout.toString())}+')()');
      fs.writeFileSync(${JSON.stringify(join(root, 'out/test/automation-editor-wide.png'))},(await window.webContents.capturePage()).toPNG());
      window.setContentSize(620,850);
      await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await window.webContents.executeJavaScript('('+${JSON.stringify(inspectListLayout.toString())}+')()');
      await window.webContents.executeJavaScript('document.querySelector(".auto-name").click()');
      await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,100))');
      const overflow=await window.webContents.executeJavaScript('document.querySelector(".auto-config-scroll").scrollWidth-document.querySelector(".auto-config-scroll").clientWidth');
      if(overflow>1)throw new Error('automation editor overflows at a narrow width: '+overflow);
      fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result));
      fs.writeFileSync(${JSON.stringify(screenshot)},(await window.webContents.capturePage()).toPNG());app.quit();
    }).catch(error=>{fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({error:error.stack||String(error)}));console.error(error);app.exit(1)});`)
  const require = createRequire(resolve(root, 'package.json'))
  await new Promise((resolveExit, reject) => {
    const env = { ...process.env, HOME: directory, UNIAGENT_USER_DATA: join(directory, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), ['--no-sandbox', join(directory, 'main.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('automation editor fixture timed out')) }, 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', async code => {
      clearTimeout(timer)
      if (code === 0) resolveExit()
      else reject(new Error(`automation editor fixture exited ${code}: ${await readFile(resultFile, 'utf8').catch(() => stderr)}`))
    })
  })
  const result = JSON.parse(await readFile(resultFile, 'utf8'))
  assert.equal(result.saved[0].dayMode, 'workday')
  assert.equal(result.patches[0].dayMode, 'non-workday')
  assert.equal(result.saved[1].dayMode, 'all')
  assert.ok(result.saved[1].schedule.startsWith('ONCE:'))
  console.log('automation-editor-ui: ok')
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolveExit => {
      child.once('exit', resolveExit); child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
      child.once('exit', () => clearTimeout(timer))
    })
  }
  await rm(directory, { recursive: true, force: true })
}
