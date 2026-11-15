import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([
  { sessionId: 'color-test', seq: 1, ts: 1, type: 'user_message', state: 'success', payload: { text: '保留原来的黑色。' } },
  { sessionId: 'color-test', seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { text: '**正文加粗**\n\n普通正文。\n\n```kotlin\nval theme = "graphite"\n```' } }
], 'idle', 'color-test', {
  setup: `
    import { flushSync } from 'react-dom';
    import { ColorThemePicker } from './src/renderer/components/ColorThemePicker';
    import { COLOR_THEMES } from './src/shared/colorThemes';
    import { applyColorTheme } from './src/renderer/colorTheme';
    window.__themes = COLOR_THEMES;
    window.__applyTheme = applyColorTheme;
    const host = document.body.appendChild(document.createElement('section'));
    host.className = 'settings-inner';
    host.style.width = '880px';
    const pickerRoot = createRoot(host);
    window.__settings = {schemaVersion:1, autoUpdateAgentsOnLaunch:false, autoCheckUpdate:true, theme:'system'};
    window.__requests = [];
    window.__saveMode = 'success';
    window.uniagent = new Proxy({setAppSettings:async patch => {
      window.__requests.push(patch);
      if(window.__saveMode === 'failure') throw new Error('fixture write failure');
      if(window.__saveMode === 'pending') await new Promise(resolve=>window.__finishSave=resolve);
      window.__settings = {...window.__settings, ...patch};
      return window.__settings;
    }}, {get:(target,key)=>target[key] || (String(key).startsWith('on') ? ()=>()=>{} : async()=>null)});
    let key = 0;
    window.__mountPicker = (ready=true, remount=false) => flushSync(()=>pickerRoot.render(
      React.createElement('div',{className:'set-card'},React.createElement(ColorThemePicker,{
        key:remount ? ++key : key, settings:ready ? window.__settings : null,
        onSaved:settings=>{window.__settings=settings; window.__mountPicker()}
      }))
    ));
    window.__mountPicker();
    const shell = document.body.appendChild(document.createElement('div'));
    shell.innerHTML = '<div class="app" style="height:200px;width:1100px"><aside class="sidebar"><div class="session-item active">会话</div></aside><main class="main"><div class="session-view"><div class="session-header"><button class="summary-toggle">分叉</button></div><div class="composer-wrap"><textarea class="composer-input"></textarea><button class="composer-send-btn">↑</button></div></div></main></div>';
    shell.id='geometry-fixture';
  `,
  inspect: `(async()=>{
    const failures=[];
    const check=(value,label)=>{if(!value)failures.push(label)};
    const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const button=name=>document.querySelector('.color-theme-option[aria-label="'+name+'"]');
    const current=()=>document.querySelector('.color-theme-option[aria-pressed="true"]')?.getAttribute('aria-label');
    const geometry=()=>[...document.querySelectorAll('#geometry-fixture .sidebar,#geometry-fixture .session-header,#geometry-fixture .composer-wrap,#geometry-fixture .composer-input,#geometry-fixture .summary-toggle,.agent-md pre')].map(el=>{
      const s=getComputedStyle(el);return [el.offsetWidth,el.offsetHeight,s.padding,s.margin,s.fontSize,s.lineHeight,s.borderRadius,s.borderWidth,s.boxShadow];
    });
    const colors=()=>['body','.agent-md strong','[data-streamdown="code-block-body"]','.user-msg .bubble','#geometry-fixture .sidebar'].map(selector=>{const s=getComputedStyle(document.querySelector(selector));return [s.color,s.backgroundColor]});
    const luminance=rgb=>rgb.match(/[\\d.]+/g).slice(0,3).map(Number).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
    check(current()==='经典黑色','legacy selects classic black');
    check(document.querySelectorAll('.color-theme-option').length===9,'nine choices');
    const originalGeometry=geometry(),originalColors=colors();
    const previews=()=>[...document.querySelectorAll('.color-theme-preview')].map(el=>getComputedStyle(el).backgroundColor);
    const originalPreviews=previews();
    button('经典黑色').click();await settle();check(window.__requests.length===0,'selected item does not save');
    const backgrounds=[];
    for(const theme of window.__themes){
      button(theme.name).click();await settle();
      check(current()===theme.name,'selected '+theme.id);
      check(document.querySelectorAll('.color-theme-option[aria-pressed="true"]').length===1,'unique selection '+theme.id);
      check(JSON.stringify(geometry())===JSON.stringify(originalGeometry),'geometry retained '+theme.id);
      check(JSON.stringify(previews())===JSON.stringify(originalPreviews),'independent palette previews '+theme.id);
      const actual=colors();backgrounds.push(actual[0][1]);
      if(theme.id!=='graphite'){
        check(document.documentElement.dataset.colorTheme===theme.id,'applied '+theme.id);
        check(contrast(actual[1][0],actual[0][1])>=4.5,'strong text contrast '+theme.id);
        check(contrast(actual[2][0],actual[2][1])>=4.5,'code contrast '+theme.id);
        check(contrast(actual[3][0],actual[3][1])>=4.5,'bubble contrast '+theme.id);
      }
      check(document.querySelector('.color-theme-options').scrollWidth<=document.querySelector('.color-theme-options').clientWidth,'picker fits '+theme.id);
    }
    check(new Set(backgrounds).size===9,'all nine canvas colors differ');
    button('经典黑色').click();await settle();
    check(!document.documentElement.hasAttribute('data-color-theme'),'classic removes all overrides');
    check(JSON.stringify(colors())===JSON.stringify(originalColors),'classic restores original computed colors');
    window.__mountPicker(true,true);await settle();check(current()==='经典黑色','reopen restores saved choice');
    window.__saveMode='failure';button('瓷白').click();await settle();
    check(current()==='经典黑色'&&!document.documentElement.hasAttribute('data-color-theme'),'failed save preserves appearance');
    check(document.querySelector('[role="alert"]')?.textContent.includes('保存失败'),'save failure visible');
    window.__saveMode='pending';const count=window.__requests.length;button('瓷白').click();button('锌匣').click();await settle();
    check(window.__requests.length===count+1,'one in-flight save');
    check([...document.querySelectorAll('.color-theme-option')].every(el=>el.disabled),'save temporarily disables choices');
    window.__finishSave();await settle();check(current()==='瓷白','pending save settles');
    check(!document.querySelector('[role="alert"]'),'retry clears failure');
    button('墨石').focus();check(document.activeElement===button('墨石'),'choices can receive keyboard focus');
    window.__mountPicker(false,true);await settle();check([...document.querySelectorAll('.color-theme-option')].every(el=>el.disabled),'wait for settings before saving');
    window.__applyTheme('unknown');check(!document.documentElement.hasAttribute('data-color-theme'),'invalid theme restores black');
    return failures;
  })()`
})
assert.deepEqual(result, [])
console.log('color theme UI: real clicks, nine palettes, unchanged geometry, contrast, restore, save failure, pending save and keyboard focus passed')
