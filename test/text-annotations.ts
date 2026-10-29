import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([
  { sessionId: 'table-annotations', seq: 1, ts: 1, type: 'user_message', payload: { text: '清理建议' } },
  { sessionId: 'table-annotations', seq: 2, ts: 2, type: 'agent_message', payload: {
    text: [
      '| 路径与内容 | 占用 | 清理条件与影响 |',
      '| --- | --- | --- |',
      '| UpStep 的 Rust 构建目录 | **11.1 GB** | `target` 类似 Android 的 `build` 目录 |',
      '| Codex 临时安装目录 | **8.5 GB** | 保留 `codex-primary-runtime` |',
      '| Go 依赖缓存 | **8.0 GB** | 可以重新下载 |',
    ].join('\n'), phase: 'final_answer',
  } },
  { sessionId: 'table-annotations', seq: 3, ts: 3, type: 'turn_completed', payload: {} },
], 'idle', 'table-annotations', {
  setup: `
    import {applyAnnotations, captureSelection, stripAnnotations} from './src/renderer/textAnnotations';
    window.annotationFixture = {applyAnnotations, captureSelection, stripAnnotations};
  `,
  inspect: `(() => {
    const {applyAnnotations, captureSelection, stripAnnotations} = window.annotationFixture;
    const root = document.querySelector('.agent-md');
    const table = root.querySelector('table');
    const originalHTML = root.innerHTML;
    const plain = root.textContent;
    const rows = [...table.querySelectorAll('tbody tr')];
    const start = plain.indexOf('UpStep');
    const end = plain.indexOf('codex-primary-runtime') + 'codex-primary-runtime'.length;
    const annotation = {id:'cross-row', seq:2, start, end, quote:plain.slice(start,end).trim(), comment:'检查这些目录'};
    const grid = () => {
      const header = [...table.querySelectorAll('th')].map(cell => cell.getBoundingClientRect());
      return rows.every(row => [...row.cells].every((cell, i) => {
        const rect = cell.getBoundingClientRect();
        return Math.abs(rect.x - header[i].x) < 1 && Math.abs(rect.width - header[i].width) < 1;
      }));
    };
    const plainWithoutBadges = () => {
      const copy = root.cloneNode(true);
      copy.querySelectorAll('.ua-anno-badge').forEach(badge => badge.remove());
      return copy.textContent;
    };
    const invalidMarks = () => table.querySelectorAll(
      'table > mark, thead > mark, tbody > mark, tfoot > mark, tr > mark'
    ).length;
    const baselineAligned = grid();
    applyAnnotations(root, [annotation], true);
    const crossRow = {
      aligned:grid(), invalidMarks:invalidMarks(), text:plainWithoutBadges(),
      cells:rows.slice(0,2).map(row => [...row.cells].map(cell => !!cell.querySelector('mark'))),
      badges:root.querySelectorAll('.ua-anno-badge').length,
      badgeInLastCell:rows[1].lastElementChild.contains(root.querySelector('.ua-anno-badge')),
      editable:[...root.querySelectorAll('mark')].every(mark => mark.getAttribute('role') === 'button' && mark.tabIndex === 0),
      codePreserved:root.querySelectorAll('code').length,
    };
    const markedHTML = root.innerHTML;
    applyAnnotations(root, [annotation], true);
    const idempotent = root.innerHTML === markedHTML;
    const range = document.createRange();
    range.selectNodeContents(root.querySelector('tbody tr td mark'));
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    const captured = captureSelection();
    selection.removeAllRanges();
    const toRowEnd = {...annotation, end:plain.indexOf('Go 依赖缓存')};
    applyAnnotations(root, [toRowEnd]);
    const structuralEnd = {aligned:grid(), invalidMarks:invalidMarks(),
      badgeInLastCell:rows[1].lastElementChild.contains(root.querySelector('.ua-anno-badge'))};
    const secondStart = plain.indexOf('8.0 GB');
    const second = {id:'second', seq:2, start:secondStart, end:secondStart + '8.0 GB'.length, quote:'8.0 GB', comment:''};
    applyAnnotations(root, [annotation, second]);
    const multiple = {aligned:grid(), invalidMarks:invalidMarks(),
      badges:[...root.querySelectorAll('.ua-anno-badge')].map(badge => badge.textContent),
      secondText:root.querySelector('mark[data-anno-id="second"]').textContent};
    const overlap = {...annotation, id:'overlap', start:start + 2, end:end - 2};
    applyAnnotations(root, [annotation, overlap], true);
    const overlapping = {text:plainWithoutBadges(), aligned:grid(), badges:root.querySelectorAll('.ua-anno-badge').length};
    applyAnnotations(root, [annotation, overlap], true);
    const overlappingIdempotent = root.querySelectorAll('.ua-anno-badge').length === 2 && plainWithoutBadges() === plain;
    applyAnnotations(root, [{...annotation, filePath:'/tmp/table.md'}]);
    const file = {aligned:grid(), invalidMarks:invalidMarks(), marks:root.querySelectorAll('mark').length};
    applyAnnotations(root, [{...annotation, filePath:'/tmp/table.md', quote:'outdated text'}]);
    const staleFileMarks = root.querySelectorAll('mark, .ua-anno-badge').length;
    const structuralStart = plain.indexOf('Codex 临时安装目录') - 1;
    applyAnnotations(root, [{...annotation, start:structuralStart, end:structuralStart + 1}]);
    const whitespaceOnly = root.querySelectorAll('mark, .ua-anno-badge').length;
    applyAnnotations(root, [second]);
    applyAnnotations(root, []);
    const clearedHTML = root.innerHTML;
    const inline = document.createElement('div');
    inline.innerHTML = '<p><strong>first</strong> <code>second</code></p>';
    root.appendChild(inline);
    applyAnnotations(inline, [{id:'inline', seq:2, start:0, end:12, quote:'first second', comment:''}]);
    const inlineWhitespaceMarked = inline.querySelector('p > mark')?.textContent === ' ';
    stripAnnotations(inline);
    return {plain, baselineAligned, crossRow, idempotent, captured, structuralEnd, multiple, file,
      staleFileMarks, whitespaceOnly, clearedHTML, originalHTML, inlineWhitespaceMarked, overlapping, overlappingIdempotent};
  })()`
})

assert.equal(result.baselineAligned, true, 'the unannotated Markdown table has aligned columns')
assert.equal(result.crossRow.aligned, true, 'a cross-row annotation must preserve the table grid')
assert.equal(result.crossRow.invalidMarks, 0, 'table structure must not contain highlight elements')
assert.equal(result.crossRow.text, result.plain, 'highlighting must preserve text and character offsets')
assert.deepEqual(result.crossRow.cells, [[true, true, true], [true, true, true]], 'every selected cell retains its highlight')
assert.equal(result.crossRow.badges, 1)
assert.equal(result.crossRow.badgeInLastCell, true)
assert.equal(result.crossRow.editable, true)
assert.equal(result.crossRow.codePreserved, 3)
assert.equal(result.idempotent, true, 'reapplying an annotation must not accumulate marks or badges')
assert.equal(result.captured.seq, 2)
assert.equal(result.captured.start, result.plain.indexOf('UpStep'))
assert.equal(result.captured.quote, 'UpStep 的 Rust 构建目录')
assert.equal(result.captured.selectedMessageText, result.plain, 'capture excludes badges and retains structural whitespace')
assert.deepEqual(result.structuralEnd, { aligned: true, invalidMarks: 0, badgeInLastCell: true },
  'a range ending between rows puts its badge in the last selected cell')
assert.deepEqual(result.multiple, { aligned: true, invalidMarks: 0, badges: ['1', '2'], secondText: '8.0 GB' },
  'ignoring table separators must not shift later annotation offsets or badge numbers')
assert.equal(result.file.aligned, true)
assert.equal(result.file.invalidMarks, 0)
assert.ok(result.file.marks > 0, 'file-reader annotations share the safe table highlighting')
assert.equal(result.staleFileMarks, 0, 'stale file quotes remain unhighlighted')
assert.equal(result.whitespaceOnly, 0, 'structural whitespace alone does not create a mark or badge')
assert.equal(result.clearedHTML, result.originalHTML, 'clearing annotations restores the original Markdown DOM')
assert.equal(result.inlineWhitespaceMarked, true, 'visible spaces between inline elements remain highlightable')
assert.deepEqual(result.overlapping, {text:result.plain, aligned:true, badges:2}, 'overlapping inline threads preserve both anchors and table layout')
assert.equal(result.overlappingIdempotent, true)
console.log('text annotations: table layout, offsets, badges, reapplication and cleanup passed')
