import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'auto-routing-entry', {
  setup: `
    import {useState} from 'react';
    import {ProjectPicker} from './src/renderer/components/ProjectPicker';
    import './src/renderer/components/requirements.css';
    const projects=[{id:'project',name:'默认项目',primaryDirectory:'/fixture',additionalDirectories:[],isDefault:true}];
    const selections=[],errors=[];
    window.addEventListener('error',event=>errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    function Fixture(){
      const [selected,setSelected]=useState(false),[available,setAvailable]=useState(true),[disabled,setDisabled]=useState(false);
      window.setAutoAvailable=setAvailable;window.setPickerDisabled=setDisabled;
      return React.createElement(ProjectPicker,{projects,projectId:'project',requirements:[],disabled,
        autoRouting:{selected,available,reason:'路由服务暂不可用',onSelect:()=>{selections.push('auto');setSelected(true)}},
        onSelect:()=>{selections.push('project');setSelected(false)},onProjectsChange:()=>{}});
    }
    const host=document.body.appendChild(document.createElement('div'));
    host.style.cssText='position:fixed;left:20px;bottom:20px';
    createRoot(host).render(React.createElement(Fixture));
    window.autoEntryFixture={host,selections,errors};
  `,
  inspect: `(async()=>{
    const f=window.autoEntryFixture,checks={};
    const wait=async probe=>{for(let i=0;i<150;i++){if(probe())return;await new Promise(r=>setTimeout(r,10))}throw Error('auto entry timeout: '+f.errors)};
    const picker=()=>f.host.querySelector('.project-picker'),auto=()=>f.host.querySelector('.scope-picker-auto');
    const open=async()=>{picker().querySelector('summary').click();await wait(()=>f.host.querySelector('[data-positioned]'))};
    await wait(()=>picker());await open();
    const pop=f.host.querySelector('.project-picker-pop');
    checks.removedHint=!pop.querySelector('.scope-picker-hint')&&!pop.textContent.includes('选空间放在');
    checks.projectTypography=!!auto().querySelector('strong');
    if(!checks.projectTypography)return{checks,errors:f.errors};
    await wait(()=>auto().querySelectorAll('.scope-picker-auto-particle').length===40);
    const title=auto().querySelector('strong'),project=pop.querySelector('button:not(.scope-picker-auto)');
    const textStyle=getComputedStyle(title),projectStyle=getComputedStyle(project.querySelector('strong'));
    checks.projectTypography=['fontSize','fontWeight','lineHeight'].every(key=>textStyle[key]===projectStyle[key]);
    checks.projectSpacing=auto().offsetHeight===project.offsetHeight&&getComputedStyle(auto()).padding===getComputedStyle(project).padding;
    checks.unselectedAppearance=auto().getAttribute('aria-selected')==='false'&&getComputedStyle(auto()).backgroundColor==='rgba(0, 0, 0, 0)'&&auto().querySelector('.scope-picker-auto-action')?.textContent==='选择';
    checks.coloredIcon=getComputedStyle(auto().querySelector('.ui-icon-router')).color!==getComputedStyle(project.querySelector('.ui-icon')).color;
    const layer=auto().querySelector('.scope-picker-auto-particles'),bounds=layer.getBoundingClientRect(),textRect=title.getBoundingClientRect();
    checks.decorativeLayer=layer.getAttribute('aria-hidden')==='true'&&getComputedStyle(layer).pointerEvents==='none'&&getComputedStyle(layer).overflow==='hidden';
    checks.glyphHeight=bounds.top>=textRect.top&&bounds.bottom<=textRect.bottom&&bounds.height<=parseFloat(textStyle.fontSize)+.01;
    const particles=[...layer.children],animations=particles.map(particle=>particle.getAnimations()[0]);
    checks.infiniteAnimation=animations.every(animation=>animation?.playState==='running'&&animation.effect.getTiming().iterations===Infinity);
    checks.squareSize=particles.every(particle=>getComputedStyle(particle).borderRadius==='0px'&&[1.75,2.25].includes(parseFloat(getComputedStyle(particle).width)));
    checks.direction=animations.every((animation,index)=>{
      animation.pause();const timing=animation.effect.getTiming();
      animation.currentTime=timing.delay+Number(timing.duration)*1.01;const start=new DOMMatrix(getComputedStyle(particles[index]).transform);
      animation.currentTime=timing.delay+Number(timing.duration)*1.95;const end=new DOMMatrix(getComputedStyle(particles[index]).transform);
      return end.e>start.e;
    });
    let bounded=true,minimumVisible=40,minimumLeftShare=1;
    for(let time=0;time<=8000;time+=50){
      animations.forEach(animation=>{animation.currentTime=time});let visible=0,left=0;
      particles.forEach(particle=>{
        const rect=particle.getBoundingClientRect();
        bounded&&=rect.top>=bounds.top-.01&&rect.bottom<=bounds.bottom+.01&&rect.right<=textRect.right+2.01;
        if(Number(getComputedStyle(particle).opacity)>=.15){visible++;if((rect.left+rect.right)/2<textRect.left+textRect.width/2)left++}
      });
      minimumVisible=Math.min(minimumVisible,visible);minimumLeftShare=Math.min(minimumLeftShare,left/visible);
    }
    checks.bounded=bounded;checks.continuous=minimumVisible>=6;checks.leftDense=minimumLeftShare>.55;
    animations.forEach(animation=>{animation.currentTime=0;animation.play()});
    auto().click();await wait(()=>!picker().open&&!auto());
    checks.closedCleanup=!layer.children.length;
    await open();await wait(()=>auto().querySelectorAll('.scope-picker-auto-particle').length===40);
    checks.selectedState=auto().getAttribute('aria-selected')==='true'&&!!auto().querySelector('.ui-icon-check')&&!auto().querySelector('.scope-picker-auto-action')&&pop!==f.host.querySelector('.project-picker-pop');
    checks.singleSelection=f.host.querySelectorAll('[role=option][aria-selected=true]').length===1;
    window.setAutoAvailable(false);await wait(()=>auto().disabled&&!auto().querySelector('.scope-picker-auto-particle'));
    auto().click();checks.unavailableBlocked=f.selections.length===1&&auto().textContent.includes('暂不可用')&&auto().title==='路由服务暂不可用';
    const manual=f.host.querySelector('.project-picker-list button:not(.scope-picker-auto)');manual.click();await wait(()=>!picker().open);
    checks.manualStillAvailable=f.selections.join(',')==='auto,project';
    window.setAutoAvailable(true);await open();await wait(()=>auto().querySelectorAll('.scope-picker-auto-particle').length===40);
    window.setPickerDisabled(true);await wait(()=>auto().disabled&&!auto().querySelector('.scope-picker-auto-particle'));
    checks.disabledCleanup=true;auto().click();checks.disabledBlocked=f.selections.length===2;
    window.setPickerDisabled(false);await wait(()=>auto().querySelectorAll('.scope-picker-auto-particle').length===40);
    checks.reenabledWithoutDuplicates=auto().querySelectorAll('.scope-picker-auto-particle').length===40;
    return{checks,minimumVisible,minimumLeftShare,errors:f.errors};
  })()`
})

for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
assert.deepEqual(result.errors, [])
console.log('PASS Auto routing entry: project typography, dense bounded pixels, continuous motion, selection, availability and cleanup')
