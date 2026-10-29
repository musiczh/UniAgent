import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'completed', 'question-controls', {
  keyEvents: [
    { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  ],
  setup: `
    import { QuestionForm } from './src/renderer/components/EventStream';
    const fixtures=document.createElement('div');fixtures.className='interaction-dock';fixtures.id='controls';document.body.append(fixtures);
    window.__answers=[];
    const params={questions:[{id:'scope',prompt:'选择核对范围',allowOther:true,options:[{label:'安装版本',description:'核对当前安装信息'},{label:'发布记录'}]}]};
    createRoot(fixtures).render(React.createElement(React.Fragment,null,
      ...['single','independent'].map(id=>React.createElement('div',{id,key:id},React.createElement(QuestionForm,{kind:'question',params,onSubmit:answer=>window.__answers.push({id,answer})}))),
      React.createElement('div',{id:'multi'},React.createElement(QuestionForm,{kind:'question',params:{questions:[{id:'evidence',prompt:'保留哪些证据？',multiSelect:true,minItems:1,maxItems:2,options:['安装信息','运行日志','发布记录']}]},onSubmit:answer=>window.__answers.push({id:'multi',answer})})),
      React.createElement('div',{id:'schema'},React.createElement(QuestionForm,{kind:'elicitation',params:{requestedSchema:{type:'object',required:['scope'],properties:{scope:{title:'工作区',description:'工作区',type:'string',enum:['current','all'],enumNames:['当前工作区','全部工作区']}}}},onSubmit:answer=>window.__answers.push({id:'schema',answer})})),
      React.createElement('fieldset',{id:'disabled',disabled:true},React.createElement(QuestionForm,{kind:'question',params,onSubmit:answer=>window.__answers.push({id:'disabled',answer})}))
    ));
  `,
  inspect: `(async()=>{
    const wait=()=>new Promise(resolve=>setTimeout(resolve,80));
    const single=document.querySelector('#single');const radios=single.querySelectorAll('input[type=radio]');
    const initial={labels:[...single.querySelectorAll('.question-detail-label')].map(node=>node.textContent),disabled:single.querySelector('.btn-send').disabled,appearance:getComputedStyle(radios[0]).appearance,background:getComputedStyle(radios[0]).backgroundColor,focus:document.activeElement===radios[0],outline:parseFloat(getComputedStyle(radios[0]).outlineWidth),promptLeft:single.querySelector('.question-prompt .agent-md').getBoundingClientRect().left,optionsLeft:single.querySelector('.question-options').getBoundingClientRect().left};
    radios[0].closest('label').click();await wait();
    radios[1].closest('label').click();await wait();
    const independent=document.querySelector('#independent input[type=radio]');independent.click();await wait();
    radios[1].focus();
    const selection={checked:[...radios].map(node=>node.checked),independent:independent.checked,focus:document.activeElement===radios[1],description:single.textContent.includes('核对当前安装信息')};
    single.querySelector('.btn-send').click();await wait();
    const other=single.querySelector('.question-other-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(other,'完整证据');other.dispatchEvent(new Event('input',{bubbles:true}));await wait();
    const custom={checked:radios[2].checked,othersCleared:!radios[0].checked&&!radios[1].checked};
    const customFont={input:getComputedStyle(other).fontSize,placeholder:getComputedStyle(other,'::placeholder').fontSize,option:getComputedStyle(single.querySelector('.question-opt-label')).fontSize};
    single.querySelector('.btn-send').click();await wait();
    const multi=document.querySelector('#multi');const checks=multi.querySelectorAll('input[type=checkbox]');
    const multiEmpty=multi.querySelector('.btn-send').disabled;
    for(const checkbox of checks){checkbox.closest('label').click();await wait()}
    const multiple={checked:[...checks].map(node=>node.checked),appearance:getComputedStyle(checks[0]).appearance,labels:[...multi.querySelectorAll('.question-detail-label')].map(node=>node.textContent)};
    multi.querySelector('.btn-send').click();await wait();
    for(const checkbox of checks){if(checkbox.checked){checkbox.click();await wait()}}
    const multiCleared=multi.querySelector('.btn-send').disabled;
    const schema=document.querySelector('#schema');schema.querySelector('input[type=radio]').closest('label').click();await wait();
    const schemaTitleCount=(schema.textContent.match(/工作区/g)||[]).length;
    const duplicateTitle=schema.querySelector('.question-title')!==null;
    schema.querySelector('.btn-send').click();await wait();
    const disabled=document.querySelector('#disabled input[type=radio]');disabled.click();await wait();
    const disabledState={disabled:disabled.matches(':disabled'),checked:disabled.checked};
    single.style.width='280px';
    const fits=[...single.querySelectorAll('.question-prompt,.question-answer-row,.question-options')].every(node=>node.scrollWidth<=node.clientWidth+1);
    return {initial,selection,custom,customFont,multiEmpty,multiple,multiCleared,duplicateTitle,schemaTitleCount,disabledState,fits,answers:window.__answers};
  })()`,
})

assert.deepEqual(result.initial.labels, [], '待回答表单不展示问题与回答标签')
assert.equal(result.initial.promptLeft, result.initial.optionsLeft, '问题正文与选项左侧对齐')
assert.equal(result.initial.disabled, true, '必填单选未选择时不能提交')
assert.equal(result.initial.appearance, 'none', '深色单选不使用系统白底外观')
assert.equal(result.initial.background, 'rgba(0, 0, 0, 0)')
assert.ok(result.initial.focus && result.initial.outline > 0, `Tab 进入控件时显示键盘焦点：${JSON.stringify(result.initial)}`)
assert.deepEqual(result.selection.checked, [false, true, false], '点击整行仍保持原生单选互斥')
assert.equal(result.selection.independent, true, '不同表单的同名字段互不影响')
assert.equal(result.selection.focus, true, '原生控件保留焦点')
assert.equal(result.selection.description, true, '填写时保留选项说明')
assert.deepEqual(result.custom, { checked: true, othersCleared: true })
assert.equal(result.customFont.input, result.customFont.option, '自定义回答输入内容与选项字号一致')
assert.equal(result.customFont.placeholder, result.customFont.option, '自定义回答占位文字与选项字号一致')
assert.ok(result.multiEmpty && result.multiCleared, '多选数量不足时不能提交')
assert.deepEqual(result.multiple.checked, [false, true, true], '沿用现有最多两项、保留最新选择的行为')
assert.equal(result.multiple.appearance, 'none', '深色复选框不使用系统白底外观')
assert.deepEqual(result.multiple.labels, [], '多选表单同样不展示问题与回答标签')
assert.deepEqual(result.disabledState, { disabled: true, checked: false })
assert.equal(result.fits, true, '问题与选项在窄列中不溢出')
assert.equal(result.duplicateTitle, false, '信息补充的字段标题与题干相同时只展示一次')
assert.equal(result.schemaTitleCount, 3, '保留题干与两个选项的完整内容')
assert.deepEqual(result.answers, [
  { id: 'single', answer: { answers: { scope: { answers: ['发布记录'] } } } },
  { id: 'single', answer: { answers: { scope: { answers: ['完整证据'] } } } },
  { id: 'multi', answer: { answers: { evidence: { answers: ['运行日志', '发布记录'] } } } },
  { id: 'schema', answer: { action: 'accept', content: { scope: 'current' } } },
])
console.log('question controls: native selection, custom answers, limits, focus, disabled state and dark appearance verified')
