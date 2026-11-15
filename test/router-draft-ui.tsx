import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-draft', {
  setup: `
    import {NewTaskPanel} from './src/renderer/components/NewTaskPanel';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'model',label:'Model',efforts:[],imageInput:true}],capabilities:{imageAttachments:true,fileAttachments:true,permissionModes:[{id:'ask',label:'询问'}]},lifecycle:{availability:'available'}};
    const router={config:{enabled:true,agentId:'codex',model:'model',version:1},available:true,requests:[]};
    const requests=[],errors=[];
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    const prefs={lastAgentId:'codex',lastByAgent:{codex:{model:'model',permissionMode:'ask'}}};
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII=';
    let cachedImages=[],picked=[],held=false,releaseLoad,pastes=0,readFails=false;
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>prefs,setPrefs:async()=>prefs,getAppSettings:async()=>({defaultTaskWorktree:false}),listProjects:async()=>[{id:'default',name:'默认项目',primaryDirectory:'/fixture',additionalDirectories:[],isDefault:true}],listRequirements:async()=>[],listPresets:async()=>[],getRouterSnapshot:async()=>router,
      getRouterDraftImages:async()=>{const snapshot=structuredClone(cachedImages);if(held)await new Promise(resolve=>releaseLoad=resolve);if(readFails)throw Error('draft read unavailable');return snapshot},saveRouterDraftImages:async(images,append=false)=>{cachedImages=append?[...cachedImages,...structuredClone(images)]:structuredClone(images)},clearRouterDraftImages:async images=>{cachedImages=cachedImages.filter(row=>!images.some(image=>image.path===row.path))},pickFiles:async()=>picked,
      saveClipboardImage:async dataUrl=>{if(!dataUrl?.startsWith('data:image/'))throw Error('missing pasted pixels');return{kind:'image',path:'/fixture/pasted-'+(++pastes)+'.png',name:'pasted-'+pastes+'.png',mime:'image/png'}},
      getNativeCapabilities:async input=>emptyNativeCapabilitySnapshot(input.agentId,input.workdir),submitRouterInput:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject}))
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';let root;
    function mount(isRouter=true){root=createRoot(host);root.render(React.createElement(NewTaskPanel,{agents:[agent],enabledAgentIds:['codex'],...(isRouter?{routerMode:router}:{}),onOpenSettings:()=>{}}))}
    const storageMethods=Object.fromEntries(['getItem','setItem','removeItem'].map(name=>[name,Storage.prototype[name]]));
    mount();window.draftFixture={host,requests,errors,mount,image,pick:name=>picked=[{kind:'image',path:'/fixture/'+name,name,mime:'image/png',previewDataUrl:image}],cached:()=>structuredClone(cachedImages),readFailure:value=>{readFails=value},holdLoad:()=>{held=true;releaseLoad=undefined},loadWaiting:()=>!!releaseLoad,releaseLoad:()=>{held=false;releaseLoad?.()},unmount:()=>root.unmount(),blockStorage:()=>{for(const name of Object.keys(storageMethods))Storage.prototype[name]=function(key,...args){if(key==='ua.router-task-draft')throw Error('storage unavailable');return storageMethods[name].call(this,key,...args)}},restoreStorage:()=>Object.assign(Storage.prototype,storageMethods)};
  `,
  inspect: `(async()=>{
    const f=window.draftFixture,tick=()=>new Promise(r=>setTimeout(r,20)),wait=async check=>{for(let i=0;i<180;i++){if(check())return;await tick()}throw Error('Draft timeout: '+f.host.textContent+' / '+f.errors)};
    const send=()=>f.host.querySelector('.new-task-send-btn'),text=()=>window.__markdownInput.text(f.host),fill=async value=>{window.__markdownInput.fill(f.host,value);await tick()},remount=async isRouter=>{f.unmount();f.mount(isRouter);await wait(()=>f.host.querySelector('[contenteditable]'));await tick()};
    await wait(()=>send());await fill('离页后恢复的文字');await remount(true);
    const checks={restoresAfterUnmount:text()==='离页后恢复的文字'};
    if(!checks.restoresAfterUnmount)return{checks,errors:f.errors};
    await remount(false);checks.homeDoesNotInheritRouterDraft=text()==='';await fill('首页独立草稿');await remount(true);checks.homeDoesNotOverwriteRouterDraft=text()==='离页后恢复的文字';
    await fill('');await remount(true);checks.explicitClearPersists=text()==='';
    await fill('提交失败保留');await wait(()=>!send().disabled);send().click();await wait(()=>f.requests.length===1);f.requests[0].reject(Error('提交失败'));await wait(()=>f.host.textContent.includes('提交失败')&&!send().disabled);await remount(true);checks.failureRestored=text()==='提交失败保留';
    await wait(()=>!send().disabled);send().click();await wait(()=>f.requests.length===2);await fill('提交期间的新草稿');f.requests[1].resolve();await wait(()=>send().getAttribute('aria-label')==='新建任务');await remount(true);checks.pendingEditRestored=text()==='提交期间的新草稿';
    await wait(()=>!send().disabled);send().click();await wait(()=>f.requests.length===3);f.requests[2].resolve();await wait(()=>text()==='');await remount(true);checks.successDoesNotRestoreSentText=text()==='';
    await fill('离页期间提交成功');await wait(()=>!send().disabled);send().click();await wait(()=>f.requests.length===4);f.unmount();f.requests[3].resolve();await tick();f.mount();await wait(()=>send());checks.successWhileUnmountedClearsCache=text()==='';
    await fill('重进页面等待提交');await wait(()=>!send().disabled);send().click();await wait(()=>f.requests.length===5);await remount(true);f.requests[4].resolve();await tick();checks.reenteredPageClearsAcceptedText=text()==='';
    await fill('旧页面提交中的内容');await wait(()=>!send().disabled);send().click();await wait(()=>f.requests.length===6);await remount(true);await fill('新页面的下一项草稿');f.requests[5].resolve();await tick();await remount(true);checks.oldSubmissionKeepsNewPageDraft=text()==='新页面的下一项草稿';
    await fill('');f.unmount();f.blockStorage();f.mount();await wait(()=>send());await fill('存储不可用仍可输入');checks.storageFailureDoesNotBlockEditing=text()==='存储不可用仍可输入';f.unmount();f.restoreStorage();
    f.mount();await wait(()=>send());await fill('与图片一起缓存的文字');
    const add=async name=>{f.pick(name);[...f.host.querySelectorAll('button')].find(button=>button.textContent.includes('添加附件')).click();await wait(()=>f.host.querySelector('[aria-label="移除 '+name+'"]'));await tick()};
    await add('first.png');await remount(true);
    checks.imagesRestoreAfterUnmount=!!f.host.querySelector('[aria-label="移除 first.png"]');
    if(!checks.imagesRestoreAfterUnmount)return{checks,errors:f.errors};
    checks.previewRestored=f.host.querySelector('.attach-thumb img').src===f.image&&text()==='与图片一起缓存的文字';
    await remount(false);checks.homeDoesNotInheritImages=!f.host.querySelector('.attach-thumb');await remount(true);await wait(()=>f.host.querySelector('.attach-thumb'));
    const clipboard=new DataTransfer(),bytes=Uint8Array.from(atob(f.image.split(',')[1]),c=>c.charCodeAt(0));clipboard.items.add(new File([bytes],'paste.png',{type:'image/png'}));window.__markdownInput.input(f.host).dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));await wait(()=>f.host.querySelector('[aria-label="移除 pasted-1.png"]'));await tick();await remount(true);await wait(()=>f.host.querySelectorAll('.attach-thumb').length===2);
    checks.pastedImageRestored=[...f.host.querySelectorAll('.attach-thumb img')].every(img=>img.src===f.image);
    f.host.querySelector('[aria-label="移除 first.png"]').click();await tick();await remount(true);await wait(()=>f.host.querySelector('.attach-thumb'));checks.removedImageDoesNotReturn=!f.host.querySelector('[aria-label="移除 first.png"]');
    const begin=async()=>{const index=f.requests.length;await wait(()=>!send().disabled);send().click();await wait(()=>f.requests.length===index+1);return f.requests[index]};
    await fill('');const failed=await begin();checks.imageOnlyUsesRealAttachment=failed.input.prompt===''&&failed.input.attachments[0].path==='/fixture/pasted-1.png'&&failed.input.attachments[0].previewDataUrl===undefined;
    failed.reject(Error('图片发送失败'));await wait(()=>f.host.textContent.includes('图片发送失败'));await remount(true);await wait(()=>f.host.querySelector('.attach-thumb'));checks.failedImageRestored=!!f.host.querySelector('[aria-label="移除 pasted-1.png"]');
    const sending=await begin();await add('next.png');sending.resolve();await wait(()=>send().getAttribute('aria-label')==='新建任务');await remount(true);await wait(()=>f.host.querySelector('[aria-label="移除 next.png"]'));checks.onlySubmittedImageCleared=f.host.querySelectorAll('.attach-thumb').length===1;
    const unmounted=await begin();f.unmount();unmounted.resolve();await tick();f.mount();await wait(()=>send());await tick();checks.unmountedSuccessClearsImages=!f.host.querySelector('.attach-thumb')&&f.cached().length===0;
    await add('old.png');const old=await begin();await remount(true);await wait(()=>f.host.querySelector('.attach-thumb'));await add('new.png');old.resolve();await tick();await remount(true);await wait(()=>f.host.querySelector('[aria-label="移除 new.png"]'));checks.newPageImagesPreserved=f.host.querySelectorAll('.attach-thumb').length===1;
    f.unmount();f.holdLoad();f.mount();await wait(()=>f.host.querySelector('[contenteditable]'));await fill('恢复期间新输入');const count=f.requests.length;window.__markdownInput.input(f.host).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true,cancelable:true}));await tick();checks.loadingDoesNotSendPartialDraft=f.requests.length===count;
    await add('during-load.png');f.releaseLoad();await wait(()=>f.host.querySelectorAll('.attach-thumb').length===2);checks.loadingKeepsNewImages=text()==='恢复期间新输入'&&!!f.host.querySelector('[aria-label="移除 new.png"]')&&!!f.host.querySelector('[aria-label="移除 during-load.png"]');
    checks.imagePreviewsAvoidLocalStorage=!Object.values(localStorage).some(value=>value.includes(f.image));
    const cachedBeforeFailure=JSON.stringify(f.cached());f.unmount();f.readFailure(true);f.mount();await wait(()=>send()&&!send().disabled);await fill('读取失败仍可编辑');checks.failedReadDoesNotEraseCache=JSON.stringify(f.cached())===cachedBeforeFailure&&text()==='读取失败仍可编辑';f.readFailure(false);
    f.unmount();f.holdLoad();f.mount();await wait(()=>f.host.querySelector('[contenteditable]'));await add('leave-during-load.png');f.unmount();f.releaseLoad();f.mount();await wait(()=>send()&&!send().disabled);checks.leavingDuringLoadKeepsNewImage=!!f.host.querySelector('[aria-label="移除 leave-during-load.png"]');
    const delayed=await begin();f.unmount();f.holdLoad();f.mount();await wait(()=>f.loadWaiting());delayed.resolve();await tick();f.releaseLoad();await tick();await tick();checks.lateReadCannotRestoreSubmittedImages=!f.host.querySelector('.attach-thumb')&&f.cached().length===0;
    return{checks,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
console.log('PASS Router draft: remount persistence, home isolation, clear/failure/success, pending edits, unmounted submissions and unavailable storage')
