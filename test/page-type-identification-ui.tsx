import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Catch a missing/misclassified page marker at the real detail-page boundary,
// including when the same title is used for all three object types.
for (const size of [{ width: 1440, height: 960 }, { width: 1024, height: 640 }]) {
  const result = await renderEventStream([], 'idle', 'page-type-ui', {
    screenshot: { ...size, path: resolve(`out/test/page-type-identification-${size.width}.png`) },
    setup: `
      import {useState} from 'react';
      import {SessionTaskContent} from './src/renderer/components/TaskDetail';
      import {SessionHeader} from './src/renderer/components/SessionHeader';
      import {WorkspaceDetail,SpaceRequirementNavigation} from './src/renderer/components/WorkspaceBrowser';
      import {projectTaskBoard} from './src/shared/taskBoard';
      import {COLOR_THEMES} from './src/shared/colorThemes';
      import {applyColorTheme} from './src/renderer/colorTheme';
      localStorage.clear();
      const errors=[],navigations=[];window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const baseSession={id:'s',title:'同名对象',status:'completed',createdAt:1,config:{agentId:'codex',projectId:'p',requirementId:'r',workdir:'/fixture'}};
      const events=[{sessionId:'s',seq:1,ts:1,type:'user_message',state:'success',payload:{text:'任务输入'}},{sessionId:'s',seq:2,ts:2,type:'agent_message',state:'success',payload:{text:'当前回答'}}];
      window.uniagent=new Proxy({getTaskDecisions:async()=>[],getTaskLifecycle:async()=>null,getTaskBoard:async query=>projectTaskBoard([baseSession],()=>[],query),readRequirementOverview:async()=>({core:{content:'目标'},state:{content:'当前阶段'},documents:[]})},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
      function Fixture(){
        const [selection,setSelection]=useState({kind:'task',title:'同名对象',mode:'ready'});
        window.pageTypeNavigate=(kind,options={})=>{localStorage.clear();setSelection({kind,title:'同名对象',mode:'ready',...options})};
        const project={id:'p',name:selection.title,primaryDirectory:'/fixture',additionalDirectories:[],isDefault:true};
        const requirement={id:'r',name:selection.title,projectId:'p',status:selection.mode==='archived'?'archived':'active',dir:'/fixture/requirement',createdAt:1,updatedAt:1};
        const unavailable=['loading','missing'].includes(selection.mode);
        const data={projects:unavailable||selection.mode==='unbound'?[]:[project],requirements:unavailable?[]:[requirement],projectsLoading:selection.mode==='loading',requirementsLoading:selection.mode==='loading',projectsError:selection.mode==='missing'?'读取失败样例':'',requirementsError:selection.mode==='missing'?'读取失败样例':'',retryProjects:()=>{},retryRequirements:()=>{}};
        const location=selection.kind==='assistant'?{kind:'assistant'}:{kind:selection.kind==='task'?'requirement':selection.kind,id:selection.kind==='space'?'p':'r'};
        const session={...baseSession,title:selection.title};
        return <div className="app"><aside className="sidebar"><div className="sidebar-header"><span className="logo">UniAgent</span></div><SpaceRequirementNavigation data={data} location={location} sessions={[session]} pending={{}} unread={{}} status={{}} onNavigate={next=>window.pageTypeNavigate(next.kind)} onCreate={()=>{}}/></aside><main className="main">
          {selection.kind==='task'?<><SessionHeader session={session} agents={[]} projects={[project]} requirements={[requirement]}/><SessionTaskContent session={session} events={events} composer={<textarea aria-label="原输入框"/>}><div>原对话与回答</div></SessionTaskContent></>:<WorkspaceDetail key={selection.kind+selection.title+selection.mode} location={location} data={data} requirementsEnabled sessions={[session]} pending={{}} unread={{}} status={{}} sessionsLoading={false} onRetrySessions={async()=>{}} onNavigate={next=>{navigations.push(next);window.pageTypeNavigate(next.kind)}} onCreate={()=>{}} onOpenTask={()=>{}} onManage={()=>{}}/>}
        </main></div>
      }
      const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';createRoot(host).render(<Fixture/>);
      window.pageTypeFixture={host,errors,navigations,themes:COLOR_THEMES,applyTheme:applyColorTheme};
    `,
    inspect: `(async()=>{
      const f=window.pageTypeFixture,q=s=>f.host.querySelector(s),all=s=>[...f.host.querySelectorAll(s)],tick=()=>new Promise(r=>setTimeout(r,20));
      const wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label+': '+f.host.textContent)};
      const navigate=async(kind,options={})=>{window.pageTypeNavigate(kind,options);await tick();await wait(()=>q('main h1,main .topbar-title-main'),'detail heading');await tick()};
      const reference=variable=>{const node=f.host.appendChild(document.createElement('span'));node.style.color='var(--'+variable+')';const value=getComputedStyle(node).color;node.remove();return value};
      function heading(){
        const marker=q('main .page-type-badge'),title=q('main h1,main .topbar-title-main'),main=q('main');
        const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,height:r.height,width:r.width}};
        const detail=q('.workspace-detail'),scroll=q('.workspace-detail-scroll'),link=q('.scope-space-link'),actions=all('.scope-actions .scope-button').map(button=>({text:button.textContent.trim(),...rect(button),radius:getComputedStyle(button).borderRadius,hasPlus:!!button.querySelector('.ui-icon-plus')}));
        return {label:marker?.textContent||null,kind:marker?.dataset.pageType||null,title:title.textContent,visible:!!marker&&marker.getBoundingClientRect().width>0&&getComputedStyle(marker).visibility==='visible'&&getComputedStyle(marker).opacity==='1',nonInteractive:!!marker&&!marker.matches('button,a,[role=button],[role=status]')&&!marker.hasAttribute('tabindex'),iconHidden:marker?.querySelector('svg')?.getAttribute('aria-hidden'),marker:marker?rect(marker):null,titleRect:rect(title),overflow:main.scrollWidth>main.clientWidth,subtitle:q('.scope-heading p')?.textContent.trim()||'',headerPresent:!!q('.workspace-detail>.settings-head'),scrollInset:scroll?rect(scroll).top-rect(detail).top:null,actions,archived:q('.scope-heading .task-execution-status')?.textContent||'',space:link?{text:link.textContent,disabled:link.disabled,icon:!!link.querySelector('.ui-icon-folder'),...rect(link)}:null};
      }
      const regular=[],long=[],states=[],palette=[];
      for(const kind of ['task','requirement','space']){
        await navigate(kind);regular.push({kind,...heading(),tabLabels:[]});const current=regular.at(-1);
        for(const tab of all('main [role=tab]')){tab.click();await tick();current.tabLabels.push(heading().label)}
        for(const theme of f.themes){f.applyTheme(theme.id);await tick();palette.push({kind,theme:theme.id,color:q('main .page-type-badge')?getComputedStyle(q('main .page-type-badge')).color:null,blue:reference('blue'),purple:reference('purple'),dim:reference('text-dim')})}
        f.applyTheme('graphite');
        if(kind==='requirement'){const link=q('.scope-space-link');link?.focus();current.spaceFocusable=document.activeElement===link;link?.click();await tick();current.spaceNavigation=f.navigations.at(-1);current.spaceDestination=heading().kind;await navigate(kind)}
        if(kind==='task'){current.switchAbsent=!q('.task-view-switch');current.conversationHeaderPresent=!!q('.session-header');current.conversationMarkers=all('main .page-type-badge').length}
        const title='用于检验无空格超长标题在窄窗口中的换行'.repeat(12);await navigate(kind,{title});long.push({kind,...heading(),expectedTitle:title});
      }
      for(const kind of ['requirement','space'])for(const mode of ['loading','missing']){await navigate(kind,{mode});states.push({kind,mode,...heading(),createDisabled:!!q('.scope-actions button')?.disabled})}
      const ownershipStates=[];for(const mode of ['unbound','archived']){await navigate('requirement',{mode});ownershipStates.push({mode,...heading(),createDisabled:!!q('.scope-actions .primary')?.disabled});if(mode==='unbound'){q('.scope-space-link')?.click();ownershipStates.at(-1).navigations=f.navigations.length}}
      await navigate('assistant');const assistant=heading();await navigate('requirement');
      return {regular,long,states,palette,assistant,ownershipStates,errors:f.errors};
    })()`
  })

  test(`${size.width}: detail headings identify the object type independently of its title`, () => {
    assert.deepEqual(result.regular.map(({ label, kind, title }: any) => ({ label, kind, title })), [
      { label: '任务', kind: 'task', title: '同名对象' },
      { label: '需求', kind: 'requirement', title: '同名对象' },
      { label: '项目', kind: 'space', title: '同名对象' }
    ])
    for (const row of result.regular) {
      assert.equal(row.visible, true, 'type is visible immediately without hovering')
      assert.equal(row.nonInteractive, true, 'type is a label, not an action or execution status')
      assert.equal(row.iconHidden, 'true', 'visible text describes the type without repeating the icon to assistive technology')
      assert.equal(row.tabLabels.length >= 2, row.kind !== 'task')
      assert.ok(row.tabLabels.every((label: string) => label === row.label), 'type persists on every detail tab')
    }
    assert.equal(result.regular[0].conversationMarkers, 1, 'unified conversation retains the task identity')
    assert.equal(result.regular[0].switchAbsent, true)
    assert.equal(result.regular[0].conversationHeaderPresent, true)
    assert.equal(result.regular[1].subtitle, '', 'requirement ownership is inline instead of taking a subtitle row')
    assert.equal(result.regular[2].subtitle, '', 'space subtitle is merged into the type marker')
    assert.equal(result.assistant.label, null, 'personal assistant is not misclassified as a space')
    assert.deepEqual(result.errors, [])
  })

  test(`${size.width}: requirement header uses a working inline space link and equal compact actions`, () => {
    const requirement = result.regular[1]
    assert.equal(requirement.headerPresent, false, 'the repeated path header is removed')
    assert.ok(requirement.titleRect.top <= 30, 'content starts at the top inset without the old header gap')
    assert.equal(requirement.scrollInset, 24, 'the drag region stays above the scrolling viewport instead of covering its controls')
    assert.equal(requirement.space.text, '同名对象')
    assert.equal(requirement.space.icon, true)
    assert.equal(requirement.space.disabled, false)
    assert.ok(requirement.space.left >= requirement.titleRect.right, 'space is immediately after the requirement name')
    assert.ok(Math.abs(requirement.space.top - requirement.titleRect.top) <= 4)
    assert.equal(requirement.spaceFocusable, true)
    assert.deepEqual(requirement.spaceNavigation, { kind: 'space', id: 'p' })
    assert.equal(requirement.spaceDestination, 'space', 'clicking the ownership control opens the owning space')
    assert.deepEqual(requirement.actions.map(({ text, width, height, radius }: any) => ({ text, width, height, radius })), [
      { text: '新建任务', width: 65, height: 28, radius: '7px' },
      { text: '更多', width: 65, height: 28, radius: '7px' }
    ])
    assert.equal(requirement.actions[0].hasPlus, false)
    assert.equal(result.regular[2].headerPresent, true, 'space keeps its existing header')
    assert.equal(result.regular[2].space, null)
    assert.equal(result.assistant.headerPresent, true, 'assistant keeps its existing header')
    assert.equal(result.assistant.space, null)
    for (const row of result.long.filter((row: any) => row.kind === 'requirement')) {
      assert.equal(row.space.text, row.expectedTitle, 'long space names retain their full accessible text')
      assert.ok(row.space.width <= 190, 'long ownership labels cannot push the action buttons out of view')
      assert.ok(row.space.left >= row.titleRect.right)
      assert.ok(row.actions.every((button: any) => button.width === 65 && button.height === 28))
    }
    const [unbound, archived] = result.ownershipStates
    assert.equal(unbound.space.disabled, true)
    assert.equal(unbound.space.text, '尚未绑定')
    assert.equal(unbound.navigations, 1, 'unbound ownership cannot navigate')
    assert.equal(unbound.createDisabled, true)
    assert.equal(archived.archived, '已归档', 'archive status remains visible without the subtitle row')
    assert.equal(archived.createDisabled, true)
    assert.equal(archived.space.disabled, false, 'archiving a requirement preserves access to its owning space')
  })

  test(`${size.width}: long titles wrap while the marker stays readable and beside the first line`, () => {
    for (const row of result.long) {
      assert.equal(row.title, row.expectedTitle)
      assert.equal(row.visible, true)
      assert.equal(row.overflow, false, row.kind + ' must not push actions beyond the viewport')
      assert.ok(row.marker.width > 50 && row.marker.height === 24, 'type marker keeps its width and a single line')
      assert.ok(row.marker.right <= row.titleRect.left, 'label and title do not overlap')
      assert.ok(Math.abs(row.marker.top - row.titleRect.top) <= 4, 'type remains beside the first title line')
    }
  })

  test(`${size.width}: loading and unavailable objects still identify their page type`, () => {
    assert.deepEqual(result.states.map(({ kind, mode, label, createDisabled }: any) => ({ kind, mode, label, createDisabled })), [
      { kind: 'requirement', mode: 'loading', label: '需求', createDisabled: true },
      { kind: 'requirement', mode: 'missing', label: '需求', createDisabled: true },
      { kind: 'space', mode: 'loading', label: '项目', createDisabled: true },
      { kind: 'space', mode: 'missing', label: '项目', createDisabled: true }
    ])
  })

  test(`${size.width}: marker colors follow the active theme`, () => {
    assert.ok(result.palette.length >= 9)
    for (const row of result.palette) {
      assert.equal(row.color, row.kind === 'task' ? row.blue : row.kind === 'requirement' ? row.purple : row.dim, row.kind + ' / ' + row.theme)
    }
  })
}
