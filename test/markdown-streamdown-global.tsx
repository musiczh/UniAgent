import assert from 'node:assert/strict'
import { splitMarkdownMetadata } from '../src/renderer/htmlPreview'
import { renderEventStream } from './regression/render-event-stream.mjs'

const source = '---\ntype: Architecture\nstatus: done\ntags: [architecture, capcode]\n---\n\n# 阅读标题\n\n## 章节\n\n### 小节\n\n统一正文。'
assert.equal(splitMarkdownMetadata(source).body, '# 阅读标题\n\n## 章节\n\n### 小节\n\n统一正文。')
assert.deepEqual(splitMarkdownMetadata(source).metadata?.tags, ['architecture', 'capcode'])
for (const value of ['', '---\nstatus: done', '---\n- just a list\n---\nbody', '---\ninvalid: [\n---\nbody']) {
  assert.deepEqual(splitMarkdownMetadata(value), { body: value }, 'invalid metadata stays visible as source content')
}
assert.equal(splitMarkdownMetadata(source.replaceAll('\n', '\r\n')).metadata?.status, 'done')
assert.equal(splitMarkdownMetadata('---\ntype: Code\n---\n\n    keep indentation').body, '    keep indentation')

const result = await renderEventStream([], 'idle', 'markdown-global', {
  setup: `
    import {Markdown} from './src/renderer/components/Markdown';
    import {COLOR_THEMES} from './src/shared/colorThemes';
    import {applyColorTheme} from './src/renderer/colorTheme';
    import {captureSelection} from './src/renderer/textAnnotations';
    import './src/renderer/components/AutomationsPanel.css';
    const wrappers=['fb-markdown','immersive-reader-document','auto-prompt-preview','ai-comment-conversation','process-step-markdown','chain-body','team-task-body','team-waiting-report','question-prompt','task-history-message','process-notice-body','live-reason-body','reasoning-body'];
    const host=document.body.appendChild(document.createElement('div'));
    host.style.cssText='position:fixed;inset:0;overflow:auto;background:var(--bg);z-index:9999';
    const root=createRoot(host), errors=[];
    window.addEventListener('error',event=>errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    const sample=${JSON.stringify(source)};
    const answer='可选文字与 \\u0060inline\\u0060。\\n\\n\\u0060\\u0060\\u0060kotlin\\nval mode = "compact"\\nstartTask(mode)\\n\\u0060\\u0060\\u0060'.replaceAll('\\u0060',String.fromCharCode(96));
    const mount=(text=answer,annotations=[])=>root.render(React.createElement('div',null,
      React.createElement('div',{id:'outside-markdown',className:'text-3xl p-4'},'outside'),
      ...wrappers.map(name=>React.createElement('section',{key:name,className:name,'data-format':name},React.createElement(Markdown,{text:sample}))),
      React.createElement('section',{key:'capability',className:'cap-detail','data-format':'capability'},React.createElement('div',{className:'cap-detail-md'},React.createElement(Markdown,{text:sample}))),
      React.createElement('section',{key:'annotations',id:'annotation-host','data-seq':'2'},React.createElement(Markdown,{text,annotations,onEditAnnotation:()=>{}}))));
    mount();
    window.fixture={host,wrappers,mount,answer,errors,detach:()=>root.render(null),themes:COLOR_THEMES,applyColorTheme,captureSelection};
  `,
  inspect: `(async()=>{
    const f=window.fixture,tick=()=>new Promise(resolve=>setTimeout(resolve,30));
    const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return true;await tick()}return false};
    await wait(()=>f.host.querySelectorAll('[data-format]').length===14);
    const format=[...f.host.querySelectorAll('[data-format]')].map(section=>{
      const md=section.querySelector('.agent-md'),css=getComputedStyle(md);
      return {entry:section.dataset.format,body:css.fontSize,line:css.lineHeight,headings:[...md.querySelectorAll('h1,h2,h3')].map(h=>getComputedStyle(h).fontSize),metadata:md.querySelector('.md-frontmatter summary').textContent};
    });
    const outside=getComputedStyle(f.host.querySelector('#outside-markdown'));
    const isolated=outside.fontSize==='13px'&&outside.paddingTop==='0px';
    const documentEntry=f.host.querySelector('[data-format]');documentEntry.dataset.seq='3';
    const documentRange=document.createRange();documentRange.selectNodeContents(documentEntry.querySelector('p'));
    const documentSelection=window.getSelection();documentSelection.removeAllRanges();documentSelection.addRange(documentRange);
    const beforeMetadata=f.captureSelection();documentEntry.querySelector('details').open=true;
    const afterMetadata=f.captureSelection();documentSelection.removeAllRanges();
    const metadataOffsetsSame=beforeMetadata.start===afterMetadata.start&&beforeMetadata.end===afterMetadata.end
      &&!afterMetadata.selectedMessageText.includes('Architecture')&&!afterMetadata.selectedMessageText.includes('type:');
    const answer=()=>f.host.querySelector('#annotation-host .agent-md');
    answer().scrollIntoView();
    const highlighted=await wait(()=>!!answer().querySelector('pre [style*="--shiki-dark"]'));
    const colors=[];
    for(const theme of f.themes){
      f.applyColorTheme(theme.id);await tick();
      const token=answer().querySelector('pre [style*="--shiki-dark"]');
      colors.push({theme:theme.id,color:token?getComputedStyle(token).color:null,scheme:getComputedStyle(answer()).colorScheme});
    }
    f.applyColorTheme('graphite');
    const annotation={id:'selected',seq:2,start:0,end:4,quote:'可选文字',comment:'保留高亮'};
    f.mount(f.answer,[annotation]);
    await wait(()=>!!answer().querySelector('mark'));
    const initial=answer().querySelector('mark')?.textContent;
    f.mount(f.answer.replace('与','追加与'),[annotation]);
    await wait(()=>answer().querySelector('p')?.textContent.includes('追加'));
    await tick();
    const updatedParagraph=answer().querySelector('p').cloneNode(true);updatedParagraph.querySelectorAll('.ua-anno-badge').forEach(node=>node.remove());
    const updated={mark:answer().querySelector('mark')?.textContent,text:updatedParagraph.textContent,badges:answer().querySelectorAll('.ua-anno-badge').length};
    const paragraph=answer().querySelector('p');
    const range=document.createRange();range.selectNodeContents(paragraph);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    const captured=f.captureSelection();selection.removeAllRanges();
    f.mount(f.answer,[]);await wait(()=>!answer().querySelector('mark'));
    const cleared=answer().querySelectorAll('mark,.ua-anno-badge').length;
    f.mount('整段文本',[{id:'whole',seq:2,start:0,end:5,quote:'整段文本',comment:''}]);
    await wait(()=>!!answer().querySelector('mark'));
    f.mount('',[]);await tick();
    f.mount('整段文本',[{id:'whole',seq:2,start:0,end:5,quote:'整段文本',comment:''}]);
    await wait(()=>!!answer().querySelector('mark'));
    f.detach();await tick();
    return {format,isolated,metadataOffsetsSame,highlighted,colors,initial,updated,captured,cleared,errors:f.errors};
  })()`,
})

assert.equal(result.format.length, 14)
for (const format of result.format) {
  assert.deepEqual([format.body, format.line, ...format.headings], ['15px', '24.75px', '30px', '24px', '20px'], format.entry)
  assert.match(format.metadata, /Architecture.*done.*architecture · capcode/)
}
assert.equal(result.isolated, true, 'Streamdown utilities cannot restyle the surrounding App')
assert.equal(result.metadataOffsetsSame, true, 'expanding document metadata cannot shift comment offsets')
assert.equal(result.highlighted, true, 'the real worker returns official code highlighting')
assert.equal(result.colors.length, 9)
const light = result.colors.filter(item => item.scheme === 'light').map(item => item.color)
const dark = result.colors.filter(item => item.scheme === 'dark').map(item => item.color)
assert.ok(light.length > 0 && dark.length > 0)
assert.ok(light.every(color => color === light[0]) && dark.every(color => color === dark[0]))
assert.notEqual(light[0], dark[0], 'syntax colors follow the App theme')
assert.equal(result.initial, '可选文字')
assert.deepEqual(result.updated, { mark: '可选文字', text: '可选文字追加与 inline。', badges: 1 })
assert.equal(result.captured.start, 0)
assert.equal(result.captured.quote, '可选文字追加与 inline。')
assert.equal(result.captured.selectedMessageText.includes('kotlin'), false, 'code toolbar labels are excluded from comments')
assert.equal(result.cleared, 0)
assert.deepEqual(result.errors, [], 'asynchronous highlighting and annotated source updates do not corrupt React nodes')
console.log('markdown-streamdown-global: 14 entries, scoped CSS, metadata, worker, themes and annotation updates passed')
