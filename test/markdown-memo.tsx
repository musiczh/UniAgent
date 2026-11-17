import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Locks the streaming perf fix: historical Markdown replies must bail out of re-render
// while a sibling live reply streams. Counting actual MarkdownView invocations (via a spy
// on the memo inner type) is deterministic — React.Profiler cannot distinguish a memo
// bailout from its own commit. Without memo(Markdown) the historical count would track every
// sibling update, which is the assignment-card entrance jank source on long transcripts.
const result = await renderEventStream([], 'idle', 'markdown-memo', {
  setup: `
    import {Markdown} from './src/renderer/components/Markdown';
    const host=document.body.appendChild(document.createElement('div'));
    const historical='# 历史回复\\n\\n'+Array.from({length:40},(_,i)=>'- 稳定列表项 '+i+' 的中文内容').join('\\n');
    let histRenders=0,liveRenders=0;
    const inner=Markdown.type;
    Markdown.type=function Spy(props,ref){ if(props.text===historical)histRenders++; else liveRenders++; return inner.call(this,props,ref); };
    const Probe=()=>{const [tick,setTick]=React.useState(0);
      return React.createElement('div',null,
        React.createElement(Markdown,{text:historical}),
        React.createElement(Markdown,{text:'流式回复 '+tick}),
        React.createElement('button',{id:'bump',onClick:()=>setTick(t=>t+1)},'bump'))};
    const root=createRoot(host);root.render(React.createElement(Probe));
    window.__memo={isMemo:Markdown.$$typeof===Symbol.for('react.memo'),counts:()=>({histRenders,liveRenders}),bump:()=>host.querySelector('#bump').click(),reset:()=>{histRenders=0;liveRenders=0}};
  `,
  inspect: `(async()=>{const m=window.__memo;const tick=ms=>new Promise(r=>setTimeout(r,ms||40));await tick(120);
    const initial=m.counts();m.reset();
    m.bump();await tick(80);m.bump();await tick(80);
    return{isMemo:m.isMemo,initial,after:m.counts(),errors:window.__fixtureErrors}})()`
})
assert.deepEqual(result.errors, [])
assert.equal(result.isMemo, true, 'Markdown is memoized')
assert.ok(result.initial.histRenders >= 1 && result.initial.liveRenders >= 1, 'both mount once')
assert.equal(result.after.histRenders, 0, 'unchanged historical Markdown skips re-render on sibling updates')
assert.ok(result.after.liveRenders >= 2, 'changing live Markdown still re-renders')
console.log('PASS Markdown memo bails out for unchanged props while live replies update')