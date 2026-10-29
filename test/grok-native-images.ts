import assert from 'node:assert/strict'
import { mkdtemp,writeFile,readFile,rm,symlink,stat,utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareGrokAttachments,grokImageBlocks,assertGrokPromptSize,materializeGrokHistoryImages,collectGrokImages } from '../src/main/grokImages.ts'
import { buildTextPromptBlocks } from '../src/main/acp/acpPromptBlocks.ts'
import { ACPHistoryProjection } from '../src/main/acp/acpEventProjection.ts'

const root=await mkdtemp(join(tmpdir(),'ua-grok-images-')),env={HOME:root}
function png(width:number,height:number):Buffer {
  const chunk=(type:string,data:Buffer) => {
    const content=Buffer.concat([Buffer.from(type),data]); let crc=0xffffffff
    for(const byte of content){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
    const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);content.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))])
}
const original=join(root,'original.png'),bytes=png(32,16)
const image=(path=original,mime='image/png')=>({kind:'image' as const,path,name:'image',mime})
try {
  await writeFile(original,bytes)
  const stored=(await prepareGrokAttachments([image()],env))![0]
  assert.notEqual(stored.path,original);assert.deepEqual(await readFile(stored.path),bytes)
  assert.deepEqual((await grokImageBlocks([stored],env))[0],{type:'image',data:bytes.toString('base64'),mimeType:'image/png'})
  assert.deepEqual(await prepareGrokAttachments([image()],env),[stored],'content-addressed copies deduplicate')
  const jpeg=join(root,'valid.jpeg')
  await promisify(execFile)('/usr/bin/sips',['-s','format','jpeg',original,'--out',jpeg])
  assert.equal((await grokImageBlocks([image(jpeg,'image/jpeg')],env))[0].mimeType,'image/jpeg')
  await assert.rejects(buildTextPromptBlocks('test',[image()],{provider:'grok',imageAttachments:false,fileAttachments:true,env}),/不支持图片/)
  for(const [w,h] of [[7,100],[32,15],[1,1],[4001,4000]]) {
    const path=join(root,`invalid-${w}-${h}.png`);await writeFile(path,png(w,h))
    await assert.rejects(prepareGrokAttachments([image(path)],env),/像素/)
  }
  await assert.rejects(prepareGrokAttachments([image(original,'image/jpeg')],env),/MIME/)
  const fake=join(root,'fake.png');await writeFile(fake,'<svg/>')
  await assert.rejects(prepareGrokAttachments([image(fake)],env),/格式/)
  const truncated=join(root,'truncated.png');await writeFile(truncated,bytes.subarray(0,42))
  await assert.rejects(prepareGrokAttachments([image(truncated)],env))
  const link=join(root,'link.png');await symlink(original,link)
  await assert.rejects(prepareGrokAttachments([image(link)],env))
  await assert.rejects(prepareGrokAttachments([image(root)],env))
  const large=join(root,'large.png');await writeFile(large,Buffer.concat([bytes,Buffer.alloc(4*1024*1024)]))
  await assert.rejects(prepareGrokAttachments([image(large)],env),/4 MiB/)
  const padded=join(root,'padded.png');await writeFile(padded,Buffer.concat([bytes,Buffer.alloc(3*1024*1024)]))
  await assert.rejects(prepareGrokAttachments([image(padded),image(padded)],env),/7 MiB/)
  await assert.rejects(prepareGrokAttachments(Array.from({length:17},()=>image()),env),/16/)
  assert.throws(()=>assertGrokPromptSize([{type:'text',text:'中'.repeat(3*1024*1024)}],'session'),/7.5 MiB/)
  for(const [format,base64] of Object.entries({
    webp:'UklGRkgAAABXRUJQVlA4IDwAAAAQAwCdASogACAAPm00lkekIyIhKAgAgA2JZQB2AACAoKAA/vkd2//+QH/+QH/+QH/8gP/+IXeyAwAAAAA=',
    gif:'R0lGODdhIAAgAIEAAAAA/wAAAAAAAAAAACwAAAAAIAAgAEAINQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJUmRAADs='
  })) {
    const path=join(root,`valid.${format}`);await writeFile(path,Buffer.from(base64,'base64'))
    assert.equal((await grokImageBlocks([image(path,`image/${format}`)],env))[0].mimeType,`image/${format}`)
  }
  const history=new ACPHistoryProjection('grok')
  history.push({sessionUpdate:'user_message_chunk',content:{type:'text',text:'Look'}})
  history.push({sessionUpdate:'user_message_chunk',content:{type:'image',data:bytes.toString('base64'),mimeType:'image/png'}})
  history.push({sessionUpdate:'user_message_chunk',content:{type:'text',text:' here'}})
  await materializeGrokHistoryImages(history.events,env)
  assert.equal(history.events.length,1);assert.equal(history.events[0].payload.text,'Look here')
  assert.equal(history.events[0].payload.attachments[0].path,stored.path)
  assert.equal(history.events[0].payload.grokImages,undefined)
  const old=new Date(Date.now()-8*24*60*60*1000)
  await utimes(stored.path,old,old)
  await collectGrokImages(new Set([stored.path]),env)
  assert.deepEqual(await readFile(stored.path),bytes,'referenced copies survive cleanup')
  await collectGrokImages(new Set(),env)
  await assert.rejects(stat(stored.path),/ENOENT/)
  assert.equal((await stat(original)).size,bytes.length,'the original is never changed or deleted')
} finally {await rm(root,{recursive:true,force:true})}
console.log('grok-native-images: decode, dimensions, MIME, size/frame limits, symlinks, owned copies and replay passed')
