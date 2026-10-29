import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ZCodeInstallationService } from '../src/main/zcode/installation'
import { detectZCodeEngine, detectZCodeRuntime, getZCodeRuntimeSnapshot, zcodeRuntimeConfigPath } from '../src/main/zcode/runtime'
import { verifyZCodeEngine } from '../src/main/zcode/build'
import { downloadZCodeFile, verifyZCodeArchive } from '../src/main/zcode/nodeRuntime'
import { runZCodeInstallProcess } from '../src/main/zcode/installProcess'
import { writeZCodeJson } from '../src/main/zcode/store'
import { agentInitializationPrompt } from '../src/shared/agentInitialization'
import type { ZCodeRuntimeConfig } from '../src/shared/zcode'
import { ZCodeConfigurationService } from '../src/main/zcode/configuration'
import { ZCodeSetupTrace } from '../src/main/zcode/diagnostics'
import type { DiagnosticInput } from '../src/main/diagnostics'

const root = await mkdtemp('/tmp/uzi-')
const previousHome = process.env.UNIAGENT_USER_DATA
const previousUserHome = process.env.HOME
process.env.HOME = root
let counter = 0, builds = 0
const scope = async () => { process.env.UNIAGENT_USER_DATA = join(root, `case-${++counter}`); await mkdir(process.env.UNIAGENT_USER_DATA) }
async function fixture(directory: string, mode = 'ok'): Promise<ZCodeRuntimeConfig> {
  await mkdir(join(directory, 'provider'), { recursive: true })
  await writeFile(join(directory, 'provider/zcode-builtin.json'), JSON.stringify({ schemaVersion: 1, config: {} }))
  const bundlePath = join(directory, 'cli.cjs')
  await writeFile(bundlePath, `
if(process.argv.includes('--version')) console.log('0.16.9');
else if(process.argv.includes('--help')) console.log('app-server --stdio');
else {
  const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
  send({method:'startup/storageState',params:{phase:'${mode === 'storage-failed' ? 'failed' : 'ready'}'}});
  require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
    const q=JSON.parse(line);
    if('${mode}'==='hang') return;
    if(q.method==='runtime/capabilities') send({id:q.id,result:{independentPlanState:${mode !== 'bad-protocol'}}});
    else if(q.method==='session/list') send({id:q.id,result:{sessions:'${mode}'==='bad-protocol'?null:[]}});
    else send({id:q.id,error:{code:-32601,message:'unknown'}});
  });
}`)
  return { schemaVersion: 1, source: 'source-build', executable: process.execPath, bundlePath,
    resourceRoot: directory, dataRootId: 'fixture' }
}
const dependencies = {
  build: async (directory: string, _revision: string, signal: AbortSignal) => { builds++; signal.throwIfAborted(); return fixture(directory) },
  verify: verifyZCodeEngine, detect: detectZCodeEngine,
  save: async (config: ZCodeRuntimeConfig) => { writeZCodeJson(zcodeRuntimeConfigPath(), config) }
}
const noSwitch = async () => {}
try {
  await scope()
  const service = new ZCodeInstallationService(dependencies)
  assert.equal((await service.snapshot()).installed, false)
  let activations = 0
  const first = service.install(async () => { activations++ })
  assert.equal(service.install(noSwitch), first, 'duplicate installs share one flight')
  assert.equal((await first).phase, 'completed')
  assert.match((await service.snapshot()).message!, /已安装，运行时校验通过/)
  assert.equal(activations, 1); assert.equal(builds, 1)
  const storedText = await readFile(zcodeRuntimeConfigPath(), 'utf8')
  const stored = JSON.parse(storedText)
  const socketBundle = join(root, 'socket.cjs')
  await writeFile(socketBundle, `
const net = require('node:net'), path = require('node:path');
const server = net.createServer();
server.listen(path.join(process.env.TMPDIR, 'znr-00000000-0000-0000-0000-000000000000.sock'), () => {
  process.stdout.write(JSON.stringify({method:'startup/storageState',params:{phase:'ready'}})+'\\n');
  require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
    const q=JSON.parse(line);
    process.stdout.write(JSON.stringify({id:q.id,result:q.method==='session/list'?{sessions:[]}:{independentPlanState:true}})+'\\n');
  }).on('close',()=>server.close());
});`)
  const longDirectory = join(root, 'long-installation-directory-'.repeat(6))
  await mkdir(longDirectory)
  await verifyZCodeEngine({ ...stored, bundlePath: socketBundle }, longDirectory, new AbortController().signal)
  assert.equal(stored.personalProviderConfigPath, undefined, 'no fake key/provider is written')
  assert.equal((await getZCodeRuntimeSnapshot()).phase, 'needs-auth')
  await assert.rejects(detectZCodeRuntime(stored), /配置模型/)
  assert.equal((await service.snapshot()).installed, true)
  const missingProvider = { ...stored, personalProviderConfigPath: join(root, 'missing-provider.json') }
  assert.equal((await detectZCodeEngine(missingProvider)).version, '0.16.9', 'damaged credentials must not hide a healthy engine or block repair in the UI')
  await assert.rejects(detectZCodeRuntime(missingProvider))
  assert.equal((await service.install(async () => { throw new Error('must not switch') })).phase, 'completed')
  assert.equal(builds, 1, 'healthy engine is reused')
  assert.equal((await new ZCodeInstallationService(dependencies).snapshot()).installed, true, 'restart discovers persisted installation')

  const configuration = new ZCodeConfigurationService()
  await assert.rejects(configuration.check({ service: 'invalid' }, noSwitch), /参数无效/)
  await assert.rejects(configuration.check({ service: 'zai-api', apiKey: 'bad\nvalue' }, noSwitch), /参数无效/)
  await assert.rejects(configuration.check({ service: 'zai-api', apiKey: 'x'.repeat(8193) }, noSwitch), /参数无效/)
  assert.equal((await configuration.check({ service: 'zai-api' }, noSwitch)).phase, 'failed')
  assert.equal(await readFile(zcodeRuntimeConfigPath(), 'utf8'), storedText)

  for (const mode of ['storage-failed', 'bad-protocol']) {
    const config = await fixture(join(root, mode), mode)
    await assert.rejects(verifyZCodeEngine(config, root, new AbortController().signal))
  }
  const optionalPlan = await fixture(join(root, 'optional-plan'), 'bad-protocol')
  const optionalText = await readFile(optionalPlan.bundlePath!, 'utf8')
  await writeFile(optionalPlan.bundlePath!, optionalText.replace("sessions:'bad-protocol'==='bad-protocol'?null:[]", 'sessions:[]'))
  await verifyZCodeEngine(optionalPlan, root, new AbortController().signal)
  const hanging = await fixture(join(root, 'hanging'), 'hang')
  const controller = new AbortController()
  const verifying = verifyZCodeEngine(hanging, root, controller.signal)
  const timer = setTimeout(() => controller.abort(), 100)
  await assert.rejects(verifying); clearTimeout(timer)

  for (const phase of ['preparing', 'downloading', 'building', 'verifying'] as const) {
    await scope()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const cancelling = new ZCodeInstallationService({ ...dependencies, build: async (_dir, _revision, signal, progress) => {
      progress(phase, 'ZCode 测试'); entered()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error('abort'))
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      })
      throw new Error('unreachable')
    } })
    const flight = cancelling.install(noSwitch)
    await started
    assert.equal((await cancelling.snapshot()).cancellable, true)
    await cancelling.cancel()
    assert.equal((await flight).phase, 'cancelled')
    assert.deepEqual(await readdir(join(process.env.UNIAGENT_USER_DATA!, 'zcode/runtime')), [])
    await assert.rejects(access(zcodeRuntimeConfigPath()))
    assert.equal((await new ZCodeInstallationService(dependencies).install(noSwitch)).phase, 'completed', 'cancel can be retried')
  }
  for (const message of ['ZCode 源码下载失败或超时', 'ZCode 依赖安装失败或超时', 'ZCode 构建失败或超时', 'https://secret:password@example.test']) {
    await scope()
    const failing = new ZCodeInstallationService({ ...dependencies, build: async () => { throw new Error(message) } })
    const result = await failing.install(noSwitch)
    assert.equal(result.phase, 'failed'); assert.ok(!result.message?.includes('password'))
    await assert.rejects(access(zcodeRuntimeConfigPath()))
    assert.deepEqual(await readdir(join(process.env.UNIAGENT_USER_DATA!, 'zcode/runtime')), [])
  }
  await scope()
  const changed = new ZCodeInstallationService(dependencies)
  const concurrent = 'concurrent configuration'
  const result = await changed.install(async () => { await writeFile(zcodeRuntimeConfigPath(), concurrent) })
  assert.equal(result.phase, 'failed')
  assert.equal(await readFile(zcodeRuntimeConfigPath(), 'utf8'), concurrent)
  assert.deepEqual(await readdir(join(process.env.UNIAGENT_USER_DATA!, 'zcode/runtime')), [])
  assert.equal((await new ZCodeInstallationService(dependencies).install(noSwitch)).phase, 'failed', 'malformed config is preserved')
  assert.equal(await readFile(zcodeRuntimeConfigPath(), 'utf8'), concurrent)

  for (const invalid of [null, [], { schemaVersion: 2 }, { schemaVersion: 1, source: 'source-build' }]) {
    await scope()
    writeZCodeJson(zcodeRuntimeConfigPath(), invalid)
    const original = await readFile(zcodeRuntimeConfigPath(), 'utf8')
    const count = builds
    assert.equal((await new ZCodeInstallationService(dependencies).install(noSwitch)).phase, 'failed')
    assert.equal(builds, count, 'invalid configuration must not start a download or silently replace the config')
    assert.equal(await readFile(zcodeRuntimeConfigPath(), 'utf8'), original)
  }
  await writeFile(zcodeRuntimeConfigPath(), '')
  assert.equal((await new ZCodeInstallationService(dependencies).install(noSwitch)).phase, 'failed', 'an empty file is corrupted, not an absent configuration')
  assert.equal(await readFile(zcodeRuntimeConfigPath(), 'utf8'), '')

  await scope()
  const blocked = new ZCodeInstallationService(dependencies)
  assert.equal((await blocked.install(async () => { throw new Error('active session') })).phase, 'failed')
  await assert.rejects(access(zcodeRuntimeConfigPath()))
  const saveFailure = new ZCodeInstallationService({ ...dependencies, save: async config => {
    await dependencies.save(config); throw new Error('directory fsync failure')
  } })
  assert.equal((await saveFailure.install(noSwitch)).phase, 'failed')
  const retained = JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8'))
  await access(retained.bundlePath)

  const archive = Buffer.from('official archive fixture')
  const digest = createHash('sha256').update(archive).digest('hex')
  await verifyZCodeArchive(archive, `${digest}  node.tar.gz`, 'node.tar.gz')
  await assert.rejects(verifyZCodeArchive(Buffer.from('corrupt'), `${digest}  node.tar.gz`, 'node.tar.gz'), /完整性/)
  await assert.rejects(verifyZCodeArchive(archive, `${digest}  other.tar.gz`, 'node.tar.gz'), /校验信息/)
  await assert.rejects(verifyZCodeArchive(archive, `${digest}  node.tar.gz\n${digest}  node.tar.gz`, 'node.tar.gz'), /校验信息/)
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('oversized')
    await assert.rejects(downloadZCodeFile('https://fixture.test', 2, new AbortController().signal), /大小限制/)
    globalThis.fetch = async () => new Response('', { status: 503 })
    await assert.rejects(downloadZCodeFile('https://fixture.test', 10, new AbortController().signal), /下载失败/)
  } finally { globalThis.fetch = originalFetch }

  const command = { cwd: root, env: { PATH: process.env.PATH }, signal: new AbortController().signal, timeout: 2000, message: 'bounded failure' }
  assert.equal(await runZCodeInstallProcess(process.execPath, ['-e', "console.log('ok')"], command), 'ok')
  await assert.rejects(runZCodeInstallProcess('/absent-node-fixture', [], command), /bounded failure/)
  await assert.rejects(runZCodeInstallProcess(process.execPath, ['-e', 'process.exit(9)'], command), (error: any) => {
    assert.equal(error.code, 'ZCODE_INSTALL_EXIT'); assert.equal(error.exitCode, 9); return true
  })
  const pidFile = join(root, 'pid')
  const abort = new AbortController()
  const processFlight = runZCodeInstallProcess(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", pidFile], { ...command, signal: abort.signal })
  for (let i = 0; i < 100; i++) { try { await access(pidFile); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) } }
  const pid = Number(await readFile(pidFile, 'utf8'))
  abort.abort()
  await assert.rejects(processFlight, /取消/)
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'cancelled child must be gone')
  await assert.rejects(runZCodeInstallProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...command, timeout: 50 }), (error: any) => {
    assert.equal(error.code, 'ZCODE_INSTALL_TIMEOUT'); return true
  })
  await scope()
  const entries: DiagnosticInput[] = []
  const failedInstall = new ZCodeInstallationService({ ...dependencies, build: async (_dir, _revision, _signal, progress) => {
    progress('building', 'fixture')
    throw Object.assign(new Error('secret-install-output'), { code: 'ZCODE_INSTALL_EXIT', exitCode: 9 })
  } }, entry => { entries.push(entry) })
  assert.equal((await failedInstall.install(noSwitch)).phase, 'failed')
  assert.equal(entries.length, 1); assert.equal(entries[0].field, 'building')
  assert.equal((entries[0].sample as any).exitCode, 9)
  assert.ok(!JSON.stringify(entries).includes('secret-install-output'))
  const trace = new ZCodeSetupTrace('installation', entry => { entries.push(entry) })
  trace.stage('verifying'); trace.fail('cancelled', new Error('secret-install-output'))
  assert.equal(entries.at(-1)?.code, 'zcode_installation_cancelled')
  assert.match(agentInitializationPrompt('zcode', 'ZCode'), /3c5b227649371507ddc4eb46ac5133afe6db1cab/)
  console.log('zcode-installation: install/reuse/restart, credential separation, protocol faults, cancel/retry, concurrency, process cleanup, download integrity and fallback passed')
} finally {
  if (previousHome === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousHome
  if (previousUserHome === undefined) delete process.env.HOME
  else process.env.HOME = previousUserHome
  await rm(root, { recursive: true, force: true })
}
