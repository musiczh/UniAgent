import assert from 'node:assert/strict'
import React from 'react'
import DOMPurify from 'dompurify'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeAnswer, normalizeQuestions, OTHER_VALUE, questionAnswerKind, questionAnswerValues } from '../src/shared/questions.ts'
import { QuestionForm } from '../src/renderer/components/EventStream.tsx'
import { redactInteractionAnswer } from '../src/shared/interactionRequests.ts'
import type { UAEvent } from '../src/shared/types.ts'

// The existing Markdown renderer needs a browser DOM; the SSR probe checks its content, not sanitization.
Object.assign(DOMPurify,{sanitize:(html:string)=>html})

const detail='# Full native plan\n\n'+Array.from({length:45},(_,i)=>`${i+1}. Keep requirement ${i+1} and its full explanation.`).join('\n')+'\n\nFINAL_PLAN_MARKER'
const params={questions:[{id:'plan',question:'Approve implementation?',detail,allowOther:true,intent:{kind:'plan-review'},options:[{label:'Approve plan'},{label:'Revise plan'}]}]}
const fields=normalizeQuestions('deepseek',params)
assert.equal(fields[0].detail,detail,'native Plan detail must survive shared normalization in full')
assert.equal(questionAnswerKind('question','_uniagent/ask_user_question'),'deepseek')
assert.equal(questionAnswerKind('question','_x.ai/ask_user_question'),'grok')
const other=encodeAnswer('deepseek',fields,{plan:{choice:[OTHER_VALUE],text:'',other:'Approve plan'}})
assert.deepEqual(other,{answers:[{id:'plan',selected:[],custom:'Approve plan'}]},'typing Other equal to an option label must never grant native plan selection')
const selected=encodeAnswer('deepseek',fields,{plan:{choice:['Approve plan'],text:'',other:''}})
assert.deepEqual(selected,{answers:[{id:'plan',selected:['Approve plan']}]})
assert.deepEqual(questionAnswerValues('deepseek',fields[0],other),['Approve plan'])
assert.deepEqual(questionAnswerValues('question',fields[0],other),['Approve plan'],'native arrays must display through existing interaction callers')
const rawField={...fields[0],options:[{value:'approve',label:'Approve plan'}]}
assert.deepEqual(questionAnswerValues('deepseek',rawField,{answers:[{id:'plan',selected:[],custom:'approve'}]}),['approve'],'custom answers must retain literal text rather than become option labels')
assert.deepEqual(encodeAnswer('question',fields,{plan:{choice:[OTHER_VALUE],text:'',other:'Approve plan'}}),{answers:{plan:{answers:['Approve plan']}}},'legacy Codex shape remains supported')
const text=normalizeQuestions('deepseek',{questions:[{id:'note',question:'Explain'}]})
assert.deepEqual(encodeAnswer('deepseek',text,{note:{choice:[],text:'my explanation',other:''}}),{answers:[{id:'note',selected:[],custom:'my explanation'}]})
const markup=renderToStaticMarkup(React.createElement(QuestionForm,{kind:'question',method:'_uniagent/ask_user_question',params,answer:other,readOnly:true}))
const editable=renderToStaticMarkup(React.createElement(QuestionForm,{kind:'question',method:'_uniagent/ask_user_question',params,onSubmit:()=>{}}))
assert.match(editable,/<h1[^>]*>Full native plan/,'the active Plan decision uses the existing Markdown renderer')
assert.match(editable,/FINAL_PLAN_MARKER/,'the active Plan decision includes the final paragraph')
assert.match(editable,/Keep requirement 45 and its full explanation/)
assert.match(markup,/Approve implementation\?/,'readonly history keeps the original question')
assert.doesNotMatch(markup,/Full native plan|FINAL_PLAN_MARKER/,'readonly history summarizes the question and answer without duplicating Plan detail')
assert.match(markup,/question-readonly-answer[^>]*>Approve plan/,'native Other answer survives renderer round trip')
const secretAnswer={answers:[{id:'secret',selected:[],custom:'SENSITIVE_CUSTOM_SENTINEL'},{id:'public',selected:['Visible'],custom:'public note'}]}
const secretEvent:UAEvent={sessionId:'session',seq:1,ts:1,type:'approval_request',state:'success',payload:{kind:'question',method:'_uniagent/ask_user_question',params:{questions:[{id:'secret',question:'Credential',isSecret:true},{id:'public',question:'Visible answer',options:[{label:'Visible'}]}]},submittedAnswer:secretAnswer}}
const redacted=redactInteractionAnswer(secretEvent)
assert.equal(Array.isArray(redacted.payload.submittedAnswer.answers),true,'native secret redaction must preserve its wire array')
assert.equal(JSON.stringify(redacted).includes('SENSITIVE_CUSTOM_SENTINEL'),false,'secret custom text must never persist')
assert.deepEqual(redacted.payload.submittedAnswer.answers[1],secretAnswer.answers[1],'public native answers remain unchanged')
assert.equal(secretAnswer.answers[0].custom,'SENSITIVE_CUSTOM_SENTINEL','redaction must not mutate the native delivery payload')

// Exercise the real submit callback with hook state; SSR above covers the active detail and readonly summary.
function submitOther(method:string):unknown {
  const internals=(React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previous=internals.ReactCurrentDispatcher.current
  let stateIndex=0
  let submitted:unknown
  internals.ReactCurrentDispatcher.current={
    useMemo:(compute:()=>unknown)=>compute(),useId:()=> 'question-test',
    useState:(initial:unknown)=> [stateIndex++===0?{plan:{choice:[OTHER_VALUE],text:'',other:'Approve plan'}}:initial,()=>{}]
  }
  let tree:React.ReactElement
  try { tree=QuestionForm({kind:'question',method,params,onSubmit:answer=>submitted=answer}) }
  finally { internals.ReactCurrentDispatcher.current=previous }
  const find=(node:any):any=> {
    if(Array.isArray(node)) return node.map(find).find(Boolean)
    if(!node?.props) return
    if(node.type==='button'&&node.props.children==='提交回答') return node
    return find(node.props.children)
  }
  const button=find(tree)
  assert.equal(button.props.disabled,false)
  button.props.onClick()
  return submitted
}
assert.deepEqual(submitOther('_uniagent/ask_user_question'),other,'QuestionForm submit must select DeepSeek native encoding by exact method')
assert.deepEqual(submitOther('item/tool/requestUserInput'),{answers:{plan:{answers:['Approve plan']}}},'legacy QuestionForm submit keeps the dictionary encoding')
console.log('deepseek-question-answer: native Other provenance, legacy compatibility and complete Markdown Plan rendering verified')
