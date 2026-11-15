import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'worktree-settings-ui', {
  setup: `
    import {useState} from 'react';
    import {flushSync} from 'react-dom';
    import {WorktreeSettings} from './src/renderer/components/WorktreeSettings';
    import {NewTaskPanel} from './src/renderer/components/NewTaskPanel';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    const noop=()=>{},listeners=new Set(),errors=[],saves=[],created=[];
    let settings={schemaVersion:1},failSave=false,failSettings=false,failCreate=false,gitFailure='',gitBranch='main',canCreate=true,finishGit;
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    const agents=[{id:'codex',name:'Codex',adapter:'codex',bin:'/fixture/codex',installed:true,builtin:true,models:[],capabilities:{modelSelect:false,reasoningEffort:false,permissionModes:[{id:'ask',label:'询问'}]},lifecycle:{availability:'available'}}];
    const projects=[{id:'a',name:'A',primaryDirectory:'/sample/a',additionalDirectories:[],isDefault:true},{id:'b',name:'B',primaryDirectory:'/sample/b',additionalDirectories:[]}];
    const api={homeDir:'/sample',getPrefs:async()=>({lastAgentId:'codex',lastByAgent:{}}),setPrefs:async()=>({lastByAgent:{}}),listProjects:async()=>projects,listRequirements:async()=>[],listPresets:async()=>[],getAppSettings:async()=>{if(failSettings)throw Error('settings');return settings},onUniAgentManagementChanged:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},setAppSettings:async patch=>{saves.push(patch);if(failSave)throw Error('disk');settings={...settings,...patch};listeners.forEach(cb=>cb('settings'));return settings},getProjectGitInfo:async()=>{if(finishGit===null)return new Promise(resolve=>finishGit=resolve);if(gitFailure==='throw')throw Error('Git IPC failed');if(gitFailure)return {branches:[],canCreateWorktree:false,inspectionFailed:true,unavailableReason:'Git 或主目录检测失败，请检查后重试'};return {canCreateWorktree:canCreate,currentBranch:gitBranch,branches:[{name:gitBranch,ref:'refs/heads/'+gitBranch},{name:'develop',ref:'refs/heads/develop'}],...(!canCreate?{unavailableReason:'主目录不是可用的 Git 仓库'}:{})}},getPersonalAssistant:async()=>undefined,getRouterSnapshot:async()=>({config:{enabled:false,version:1},available:false,requests:[]}),getNativeCapabilities:async input=>emptyNativeCapabilitySnapshot(input.agentId,input.workdir)};
    window.uniagent=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>noop:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='width:1000px;height:850px';const root=createRoot(host);let serial=0;
    function Settings(){const [value,setValue]=useState(settings);return React.createElement(WorktreeSettings,{settings:value,onSaved:setValue})}
    const mountTask=()=>flushSync(()=>root.render(React.createElement(NewTaskPanel,{key:++serial,agents,promptPrefill:{text:'test task'},onCreate:async config=>{if(failCreate)throw Error('服务暂不可用');created.push(config);return {id:'task-'+created.length,config,status:'idle',createdAt:0,title:'Fixture'}},onCommitCreatedSession:noop})));
    root.render(React.createElement(Settings));window.worktreeFixture={host,saves,created,errors,mountTask,failSave:value=>failSave=value,failSettings:value=>failSettings=value,failCreate:value=>failCreate=value,gitFailure:value=>gitFailure=value,push:value=>{settings={...settings,...value};listeners.forEach(cb=>cb('settings'))},deferGit:()=>finishGit=null,gitPending:()=>typeof finishGit==='function',finishGit:()=>{finishGit({canCreateWorktree:true,currentBranch:'main',branches:[{name:'main',ref:'refs/heads/main'}]});finishGit=undefined},nonGit:()=>{canCreate=false},branch:value=>gitBranch=value};
  `,
  inspect: `(async()=>{
    const f=window.worktreeFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,20)),wait=async p=>{for(let i=0;i<200;i++){if(p())return;await tick()}throw Error('worktree UI timeout '+JSON.stringify({created:f.created,saves:f.saves,gitPending:f.gitPending(),sendDisabled:q('.new-task-send-btn')?.disabled})+' '+f.host.textContent+' '+f.errors)};
    const toggle=label=>q('[aria-label="'+label+'"]'),send=()=>q('.new-task-send-btn'),open=async()=>{await wait(()=>q('.project-picker>summary'));q('.project-picker>summary').click();await wait(()=>q('.project-worktree-choice'))},choice=()=>q('.project-worktree-choice');
    await wait(()=>toggle('新任务默认使用工作树'));const r={defaults:[toggle('新任务默认使用工作树').getAttribute('aria-checked'),toggle('提交后自动同步回源分支').getAttribute('aria-checked')]};
    f.failSave(true);toggle('提交后自动同步回源分支').click();await wait(()=>q('[role=alert]'));r.failedSaveKept=toggle('提交后自动同步回源分支').getAttribute('aria-checked')==='false';f.failSave(false);toggle('提交后自动同步回源分支').click();await wait(()=>toggle('提交后自动同步回源分支').getAttribute('aria-checked')==='true');r.onlySyncPatch=f.saves[1];
    toggle('新任务默认使用工作树').click();await wait(()=>toggle('新任务默认使用工作树').getAttribute('aria-checked')==='true');r.enableWorktreePatch=f.saves[2];
    f.push({defaultTaskWorktree:undefined});f.mountTask();await wait(()=>send()&&!send().disabled);await open();r.missingDefault=choice().getAttribute('aria-checked');f.push({defaultTaskWorktree:true});
    f.deferGit();f.mountTask();await wait(()=>send()&&f.gitPending());r.waitsForGit=send().disabled;f.finishGit();await wait(()=>!send().disabled);await open();r.defaultSelected=choice().getAttribute('aria-checked');r.source=q('select[aria-label="新工作树的基准分支"]').selectedOptions[0].textContent;
    choice().click();await tick();f.push({defaultTaskWorktree:false});await tick();f.push({defaultTaskWorktree:true});await tick();r.manualChoiceKept=choice().getAttribute('aria-checked')==='false';q('.project-picker>summary').click();send().click();await wait(()=>f.created.length===1);r.explicitLocal=f.created[0].workspaceSelection.mode;
    f.mountTask();await wait(()=>send()&&!send().disabled);await open();const select=q('select[aria-label="新工作树的基准分支"]');select.value='refs/heads/develop';select.dispatchEvent(new Event('change',{bubbles:true}));await tick();q('.project-picker>summary').click();send().click();await wait(()=>f.created.length===2);r.explicitBranch=f.created[1].workspaceSelection.baseRef;
    f.push({defaultTaskWorktree:false});f.mountTask();await wait(()=>send()&&!send().disabled);await open();r.offDefault=choice().getAttribute('aria-checked');choice().click();await tick();r.manualEnable=choice().getAttribute('aria-checked');
    f.push({defaultTaskWorktree:true});f.nonGit();f.mountTask();await wait(()=>send()&&!send().disabled);await open();r.nonGit=choice().disabled&&choice().getAttribute('aria-checked')==='false';
    r.nonGitHasNoCreationError=!q('[role=alert]');q('.project-picker>summary').click();send().click();await wait(()=>f.created.length===3);r.nonGitLocal=f.created[2].workspaceSelection.mode==='local';
    f.gitFailure('result');f.mountTask();await open();await wait(()=>q('.project-worktree-hint')?.textContent.includes('Git 或主目录检测失败'));
    if(send().disabled)throw Error('Git 检测失败不应阻止普通任务发送');
    r.inspectionFailureLocal=choice().disabled&&choice().getAttribute('aria-checked')==='false'&&!q('[role=alert]');q('.project-picker>summary').click();send().click();await wait(()=>f.created.length===4);r.inspectionFailureSubmitted=f.created[3].workspaceSelection.mode==='local';
    f.failCreate(true);f.mountTask();await wait(()=>send()&&!send().disabled);send().click();await wait(()=>q('[role=alert]')?.textContent.includes('创建任务失败：服务暂不可用'));r.realFailureKeptDraft=window.__markdownInput.text(f.host)==='test task';
    f.failCreate(false);send().click();await wait(()=>f.created.length===5);r.realFailureRetry=f.created[4].workspaceSelection.mode==='local';
    f.gitFailure('throw');f.mountTask();await wait(()=>send()&&!send().disabled);await open();r.probeRejectionLocal=choice().disabled&&q('.project-worktree-hint').textContent==='Git IPC failed'&&!q('[role=alert]');q('.project-picker>summary').click();send().click();await wait(()=>f.created.length===6);r.probeRejectionSubmitted=f.created[5].workspaceSelection.mode==='local';
    f.gitFailure('');f.failSettings(true);f.mountTask();await wait(()=>q('[role=alert]')?.textContent.includes('工作树设置读取失败'));r.settingsFailureProtected=send().disabled&&!q('[role=alert]').textContent.includes('创建任务失败');
    return {...r,errors:f.errors};
  })()`
})
assert.deepEqual(result.defaults, ['false', 'false'])
assert.equal(result.failedSaveKept, true)
assert.deepEqual(result.onlySyncPatch, { autoSyncWorktree: true })
assert.deepEqual(result.enableWorktreePatch, { defaultTaskWorktree: true })
assert.equal(result.missingDefault, 'false')
assert.equal(result.manualEnable, 'true')
assert.equal(result.waitsForGit, true)
assert.equal(result.defaultSelected, 'true'); assert.equal(result.source, 'main')
assert.equal(result.manualChoiceKept, true); assert.equal(result.explicitLocal, 'local')
assert.equal(result.explicitBranch, 'refs/heads/develop')
assert.equal(result.offDefault, 'false'); assert.equal(result.nonGit, true)
for (const name of ['nonGitHasNoCreationError', 'nonGitLocal', 'inspectionFailureLocal', 'inspectionFailureSubmitted', 'realFailureKeptDraft', 'realFailureRetry', 'probeRejectionLocal', 'probeRejectionSubmitted', 'settingsFailureProtected']) assert.equal(result[name], true, name)
assert.deepEqual(result.errors, [])
console.log('PASS worktree settings/default UI: switches, save failure, pending Git, manual override, explicit branch, disabled preference and non-Git fallback')
