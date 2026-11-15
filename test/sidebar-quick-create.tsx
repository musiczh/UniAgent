import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Catches always-visible buttons, sidebar-wide hover, layout shifts and lost create scope.
const result = await renderEventStream([], 'idle', 'sidebar-quick-create', {
  screenshot: { width: 1024, height: 640, path: 'out/test/sidebar-quick-create.png' },
  setup: `
    import {SpaceRequirementNavigation} from './src/renderer/components/WorkspaceBrowser';
    import {BROWSER_EXPANDED_KEY} from './src/renderer/scopeBrowser';
    localStorage.setItem(BROWSER_EXPANDED_KEY, JSON.stringify(['a']));
    const projects=[{id:'a',name:'空间 A',isDefault:true},{id:'b',name:'空间 B'}];
    const requirements=[{id:'r',name:'需求一',projectId:'a',status:'active'},{id:'old',name:'历史需求',projectId:'a',status:'archived'}];
    const created=[],snapshots={};
    const host=document.body.appendChild(document.createElement('aside'));
    host.className='sidebar';host.style.cssText='position:fixed;top:20px;left:20px;width:300px;height:580px';
    createRoot(host).render(<SpaceRequirementNavigation data={{projects,projectsLoading:false,projectsError:'',requirements,requirementsEnabled:true,requirementsLoading:false,requirementsError:''}} location={{kind:'requirement',id:'old'}} sessions={[]} pending={{}} unread={{}} status={{}} onNavigate={()=>{}} onCreate={seed=>created.push(seed)}/>);
    const row=name=>[...host.querySelectorAll('.scope-nav-row')].find(e=>e.querySelector('.scope-nav-name').textContent===name);
    const snapshot=label=>{snapshots[label]=[...host.querySelectorAll('.scope-nav-row')].map(e=>{
      const button=e.querySelector('.scope-quick-create'),style=getComputedStyle(button);
      const bounds=e.getBoundingClientRect(),title=e.querySelector('.scope-nav-name').getBoundingClientRect();
      return {name:e.querySelector('.scope-nav-name').textContent,visible:style.visibility==='visible'&&Number(style.opacity)>0,opacity:Number(style.opacity),disabled:button.disabled,box:[bounds.x,bounds.y,bounds.width,bounds.height,title.x,title.width]};
    })};
    const mouse=(name,target='row',type='mouseMoved')=>{
      const element=target==='row'?row(name).querySelector('.scope-nav-name'):row(name).querySelector('.scope-quick-create');
      const bounds=element.getBoundingClientRect();
      return {type,x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})};
    };
    window.quickCreateFixture={host,row,created,snapshots,snapshot,mouse};
  `,
  mouseEvents: [
    `(async()=>{const f=window.quickCreateFixture;await document.fonts.ready;await Promise.all(f.host.getAnimations().map(animation=>animation.finished));f.snapshot('default');return f.mouse('空间 A')})()`,
    `(()=>{const f=window.quickCreateFixture;f.snapshot('space-hover');return f.mouse('空间 A','button')})()`,
    `window.quickCreateFixture.mouse('空间 A','button','mousePressed')`,
    `window.quickCreateFixture.mouse('空间 A','button','mouseReleased')`,
    `(()=>{const f=window.quickCreateFixture;f.snapshot('space-click');return f.mouse('需求一')})()`,
    `(()=>{const f=window.quickCreateFixture;f.snapshot('requirement-hover');return f.mouse('需求一','button')})()`,
    `window.quickCreateFixture.mouse('需求一','button','mousePressed')`,
    `window.quickCreateFixture.mouse('需求一','button','mouseReleased')`,
    `({type:'mouseMoved',x:800,y:500})`,
    `(()=>{const f=window.quickCreateFixture;f.snapshot('outside');f.row('需求一').querySelector('.scope-nav-name').focus();return {type:'mouseMoved',x:800,y:500}})()`
  ],
  keyEvents: [{ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
  inspect: `(()=>{
    const f=window.quickCreateFixture;f.snapshot('keyboard');
    const button=f.row('需求一').querySelector('.scope-quick-create');
    return {snapshots:f.snapshots,created:f.created,keyboardFocused:document.activeElement===button,keyboardVisible:button.matches(':focus-visible')};
  })()`
})

const visible = (label: string) => result.snapshots[label].filter((row: any) => row.visible).map((row: any) => row.name)
assert.deepEqual(visible('default'), [], 'all visible rows start with hidden quick-create buttons')
assert.deepEqual(visible('space-hover'), ['空间 A'], 'hovering a space reveals only its button')
assert.deepEqual(visible('requirement-hover'), ['需求一'], 'hovering a requirement hides the previous space button')
assert.deepEqual(visible('outside'), [], 'leaving the sidebar hides buttons even after mouse clicks')
assert.deepEqual(result.created, [{ projectId: 'a' }, { projectId: 'a', requirementId: 'r' }], 'real pointer clicks keep the original task ownership')
assert.equal(result.keyboardFocused, true, 'hidden buttons remain reachable using Tab')
assert.equal(result.keyboardVisible, true)
assert.deepEqual(visible('keyboard'), ['需求一'], 'keyboard focus reveals only the focused button')
for (const rows of Object.values(result.snapshots) as any[][]) {
  assert.ok(rows.every(row => row.name !== '历史需求'), 'selected archived requirements expose neither a sidebar row nor a quick-create button')
  assert.deepEqual(rows.map(row => row.box), result.snapshots.default.map((row: any) => row.box), 'hover and focus never change row or title geometry')
}
console.log('PASS sidebar quick-create: default, row hover, mouse leave, native clicks, archived requirement exclusion, keyboard focus and stable layout')
