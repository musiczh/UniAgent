import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KimiOnboarding, KIMI_NATIVE_RELEASE, managedKimiPath, sharedKimiPath, findKimiExecutable, downloadKimiBinary } from '../src/main/kimiInstallation.ts'

const root = await mkdtemp(join(tmpdir(), 'kimi-install-unit-'))
let downloads = 0, verifies = 0, probes = 0, logins = 0
const env = { HOME: root, PATH: '/usr/bin:/bin', KIMI_CODE_HOME: join(root, 'kimi-home') }
const deps = {
  env: () => env, find: async () => undefined as string | undefined,
  download: async (file: string, signal: AbortSignal, progress: (bytes: number, total: number) => void) => { downloads++; signal.throwIfAborted(); await writeFile(file, 'fixture'); progress(7, 7) },
  verify: async () => { verifies++ }, probe: async () => { probes++; return { status: 'needs-auth' as const, version: '2.2.0' } }
}
try {
  assert.equal(managedKimiPath(env), join(root, '.uniagent', 'runtimes', 'kimi-code', KIMI_NATIVE_RELEASE.version, 'kimi'), 'both editions reuse the same legacy native program')
  await assert.rejects(downloadKimiBinary(join(root, 'bad'), new AbortController().signal, () => {}, (async () => new Response('bad bytes')) as typeof fetch), /校验失败/)
  await assert.rejects(downloadKimiBinary(join(root, 'redirect'), new AbortController().signal, () => {}, (async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/binary' } })) as typeof fetch), /不受信任/)
  const installer = new KimiOnboarding(deps)
  const phases: string[] = []; installer.onChanged = value => phases.push(value.phase)
  const results = await Promise.all([installer.install(), installer.install()])
  assert.equal(downloads, 1); assert.equal(verifies, 1); assert.equal(probes, 1)
  assert.equal(results[0].status, 'needs-auth', 'installed binary does not imply authenticated model')
  assert.equal(await readFile(sharedKimiPath(env), 'utf8'), 'fixture')
  assert.ok(phases.includes('verifying') && phases.includes('activating'))
  assert.equal(sharedKimiPath(env), join(root, '.local/bin/kimi'))
  await mkdir(join(managedKimiPath(env), '..'), { recursive: true })
  await writeFile(managedKimiPath(env), 'legacy', { mode: 0o700 })
  assert.equal(await findKimiExecutable('kimi', { ...env, PATH: '' }), sharedKimiPath(env))
  const reused = new KimiOnboarding({ ...deps, find: async () => '/existing/kimi' })
  await reused.install(); assert.equal(downloads, 1, 'existing CLI is not overwritten or duplicated')
  const failedRoot = join(root, 'failed'); await mkdir(failedRoot)
  const failed = new KimiOnboarding({ ...deps, env: () => ({ HOME: failedRoot }), verify: async () => { throw new Error('contract mismatch') } })
  assert.equal((await failed.install()).phase, 'failed')
  await assert.rejects(access(sharedKimiPath({ HOME: failedRoot })))
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const cancelled = new KimiOnboarding({ ...deps, download: async (_file, signal) => { started(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) } })
  const flight = cancelled.install(); await entered; await cancelled.cancel()
  assert.equal((await flight).phase, 'cancelled')
  const signedIn = new KimiOnboarding({ ...deps, find: async () => '/existing/kimi', probe: async () => ({ status: 'ready' }), login: (() => { logins++; throw new Error('must not login') }) as any })
  assert.equal((await signedIn.signIn()).status, 'ready'); assert.equal(logins, 0)
  let authenticated = false, listener: any, stopped = 0, selectedRegion: unknown
  const login = new KimiOnboarding({ ...deps, find: async () => '/existing/kimi', probe: async () => ({ status: authenticated ? 'ready' : 'needs-auth' }), login: (_bin, _home, region) => { selectedRegion = region; return ({ subscribe: (callback: any) => { listener = callback; return () => { listener = undefined } }, stop: async () => { stopped++ } }) } })
  const loginFlight = login.signIn({ region: 'global' }); while (!listener) await new Promise(resolve => setImmediate(resolve))
  assert.equal(selectedRegion, 'global'); listener({ status: 'awaiting', url: 'https://kimi.com/login' });
  let opened = ''; await login.reopen(async url => { opened = url }); assert.equal(opened, 'https://kimi.com/login');
  authenticated = true; listener({ status: 'success' }); assert.equal((await loginFlight).status, 'ready', 'login exit must be followed by a fresh probe')
  authenticated = false
  const cancelLogin = login.signIn(); while (!listener) await new Promise(resolve => setImmediate(resolve))
  await login.cancel(); assert.equal((await cancelLogin).phase, 'cancelled'); assert.ok(stopped > 0); assert.equal(listener, undefined)
  console.log('Kimi installer: single flight, existing reuse, verification failure, cancel, login reuse and fresh probe passed')
} finally { await rm(root, { recursive: true, force: true }) }
