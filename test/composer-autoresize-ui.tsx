import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'composer-autoresize', {
  setup: `
    import {useAutoResize} from './src/renderer/hooks';
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;top:40px;left:40px;width:650px';const root=createRoot(host);
    function Input(){const ref=React.useRef(null);useAutoResize(ref,('输入内容会在队列布局变化时重新排版 ').repeat(12),.5,46);return <textarea ref={ref} value={('输入内容会在队列布局变化时重新排版 ').repeat(12)} readOnly style={{width:'100%',font:'14px/20px sans-serif',boxSizing:'border-box'}}/>}root.render(<Input/>);
    window.autoresizeFixture={host,unmount:()=>root.unmount()};
  `,
  inspect: `(async()=>{const f=window.autoresizeFixture,tick=ms=>new Promise(r=>setTimeout(r,ms)),input=()=>f.host.querySelector('textarea');await tick(80);const initial=input().getBoundingClientRect().height;f.host.style.width='180px';await tick(100);const narrow=input().getBoundingClientRect().height;const checks={wrapsAtNewWidth:narrow>initial&&narrow<=window.innerHeight*.5};f.host.style.width='500px';await tick(5);f.host.style.width='220px';await tick(5);f.host.style.width='650px';await tick(100);checks.rapidResizeConverges=Math.abs(input().getBoundingClientRect().height-initial)<2;f.host.style.width='160px';f.unmount();await tick(60);checks.unmountClearsInput=!f.host.querySelector('textarea');return{checks,initial,narrow,errors:window.__fixtureErrors}})()`
})
for (const [name, value] of Object.entries(result.checks)) assert.equal(value, true, name)
assert.deepEqual(result.errors, [])
console.log('PASS input width reflow, rapid resize convergence and unmount without ResizeObserver loops')
