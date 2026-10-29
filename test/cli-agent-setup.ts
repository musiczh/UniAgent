import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution.ts'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliAgentSetup, trustedAgentLoginUrl } from '../src/main/cliAgentSetup.ts'
import { runSetupCommand, findAgentExecutable } from '../src/main/agentSetupProcess.ts'
import { loadNativeCredentials, nativeCredentialEnv, saveNativeCredential } from '../src/main/agentSetupCredentials.ts'
import type { AgentDef } from '../src/shared/types.ts'
import { codexUsesExternalProvider } from '../src/main/agents.ts'

const root = await mkdtemp(join(tmpdir(), 'ua-cli-setup-'))
const original = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
const key = 'offline-fixture-credential'
const ready = (id: string, available = false): AgentDef => ({ id, bin: '/fixture/' + id, installed: true,
  lifecycle: { availability: available ? 'available' : 'needs-auth' } } as AgentDef)
let installed = true, available = false, downloads = 0, saves = 0
const calls: { bin: string; args: string[]; input?: string }[] = []
let output: ((chunk: string) => void) | undefined, complete: (() => void) | undefined
const setup = new CliAgentSetup({
  inspect: async id => ({ ...ready(id, available), installed }),
  openBrowser: async () => {}, find: async () => installed ? '/fixture/bin' : undefined,
  run: async (bin, args, options) => {
    calls.push({ bin, args, input: options.input })
    if (args[0] === 'login' && args[1] === '--git-code') throw new Error('no git identity')
    if (options.output) {
      output = options.output
      await new Promise<void>((done, reject) => { complete = () => { available = true; done() }; options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) })
    } else { installed = true; available = true }
    return ''
  },
  request: async () => { downloads++; return new Response('#!/bin/sh\nexit 0\n') },
  saveKey: async () => { saves++; available = true }
})
try {
  await writeFile(join(root, 'config.toml'), 'model_provider="external"\n[model_providers.external]\nbase_url="https://provider.example/v1"\nrequires_openai_auth=false\nenv_key="FIXTURE_PROVIDER_KEY"\n')
  assert.equal(await codexUsesExternalProvider(root, {}), false, 'a missing provider credential is not a reusable connection')
  assert.equal(await codexUsesExternalProvider(root, { FIXTURE_PROVIDER_KEY: key }), true)
  await writeFile(join(root, 'config.toml'), 'model_provider="openai"\n')
  assert.equal(await codexUsesExternalProvider(root, {}), false)
  await loadNativeCredentials()
  await saveNativeCredential('claude', key)
  await saveNativeCredential('grok', key + '-grok')
  assert.equal(nativeCredentialEnv('claude').ANTHROPIC_API_KEY, key)
  assert.equal(nativeCredentialEnv('grok').XAI_API_KEY, key + '-grok')
  assert.deepEqual(nativeCredentialEnv('codex'), {})
  const stored = await readFile(join(root, 'agent-credentials.json'), 'utf8')
  assert.ok(!stored.includes(key), 'credentials must be encrypted at rest')
  assert.equal((await stat(join(root, 'agent-credentials.json'))).mode & 0o777, 0o600)
  assert.equal((await setup.install('codex')).phase, 'idle')
  assert.equal(downloads, 0, 'a discovered installation is always reused')
  installed = false; available = false
  assert.equal((await setup.install('codex')).phase, 'idle')
  assert.equal(downloads, 1); assert.equal(calls[0].bin, '/bin/bash')
  const installerFailure = new CliAgentSetup({ inspect: async id => ({ ...ready(id), installed: false }), openBrowser: async () => {}, find: async () => undefined,
    request: async () => new Response('upstream failure', { status: 503 }) })
  assert.equal((await installerFailure.install('grok')).phase, 'failed')
  available = false
  await assert.rejects(setup.signIn('codex', { method: 'key', apiKey: ' ' }), /填写/)
  await assert.rejects(setup.signIn('traex', { method: 'key', apiKey: key }), INTERNAL_DISTRIBUTION ? /企业身份/ : /参数无效/)
  assert.equal((await setup.signIn('codex', { method: 'key', apiKey: key })).phase, 'idle')
  const codexCall = calls.at(-1)!
  assert.deepEqual(codexCall.args, ['login', '--with-api-key'])
  assert.equal(codexCall.input, key + '\n'); assert.ok(!JSON.stringify(codexCall.args).includes(key))
  available = false
  if (INTERNAL_DISTRIBUTION) {
  const login = setup.signIn('traex')
  while (!output) await new Promise(done => setImmediate(done))
  output('Open https://evil.example/login\n')
  assert.equal(setup.snapshot('traex').canReopen, false)
  output('Open https://sso.bytedance.com/login\nCode: ABCD-1234\n')
  assert.equal(setup.snapshot('traex').canReopen, true)
  assert.equal(setup.snapshot('traex').deviceCode, 'ABCD-1234')
  assert.ok(!JSON.stringify(setup.snapshot('traex')).includes('https:'))
  assert.deepEqual(calls.at(-1)?.args, ['login', '--sso-device'])
  await setup.reopen('traex')
  await assert.rejects(setup.signIn('traex'), /正在准备/)
  complete!(); assert.equal((await login).phase, 'idle')
  await assert.rejects(setup.reopen('traex'), /过期|尚未/)
  } else {
    await assert.rejects(setup.signIn('traex'), /参数无效/)
    await assert.rejects(setup.install('traex'), /不支持/)
  }
  available = false; output = undefined
  const waiting = setup.signIn('grok')
  while (!output) await new Promise(done => setImmediate(done))
  await setup.cancel('grok'); assert.equal((await waiting).phase, 'cancelled')
  assert.equal(setup.snapshot('grok').cancellable, false)
  let writes = 0
  for (const status of [401, 403, 503]) {
    const failed = new CliAgentSetup({ inspect: async id => ready(id), openBrowser: async () => {},
      request: async () => new Response('private response', { status }), saveKey: async () => { writes++ } })
    const result = await failed.signIn('claude', { method: 'key', apiKey: key })
    assert.equal(result.phase, 'failed'); assert.ok(!JSON.stringify(result).includes(key))
  }
  assert.equal(writes, 0, 'failed candidates never replace stored credentials')
  const valid = new CliAgentSetup({ inspect: async id => ready(id, writes > 0), openBrowser: async () => {},
    request: async () => new Response(JSON.stringify({ data: [{ id: 'model-fixture' }] })), saveKey: async () => { writes++ } })
  assert.equal((await valid.signIn('claude', { method: 'key', apiKey: key })).phase, 'idle')
  const noAuth = new CliAgentSetup({ inspect: async id => ready(id), openBrowser: async () => {}, run: async () => '' })
  assert.equal((await noAuth.signIn('codex')).phase, 'failed', 'CLI exit zero alone cannot mark login successful')
  assert.equal(trustedAgentLoginUrl('grok', 'https://auth.x.ai/login'), 'https://auth.x.ai/login')
  assert.equal(trustedAgentLoginUrl('grok', 'https://x.ai.evil.example/login'), undefined)
  assert.equal(trustedAgentLoginUrl('codex', 'https://user:pass@auth.openai.com/'), undefined)
  const local = join(root, 'fixture-cli')
  await writeFile(local, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  assert.equal(await findAgentExecutable(local), local)
  const controller = new AbortController()
  const text = await runSetupCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { signal: controller.signal, input: 'fixture-input' })
  assert.equal(text, 'fixture-input')
  await assert.rejects(runSetupCommand(process.execPath, ['-e', "console.error('private credential');process.exit(1)"], { signal: controller.signal }), error => error instanceof Error && !error.message.includes('private credential'))
  const pidPath = join(root, 'pid')
  const cancellation = new AbortController()
  const flight = runSetupCommand(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", pidPath], { signal: cancellation.signal })
  const rejected = assert.rejects(flight, /取消/)
  let pid = 0
  while (!pid) { try { pid = Number(await readFile(pidPath, 'utf8')) } catch { await new Promise(done => setTimeout(done, 10)) } }
  cancellation.abort(); await rejected
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
  assert.equal(saves, 0)
  console.log('CLI onboarding: shared reuse/install, stdin key, encrypted persistence, SSO fallback, trusted reopen, cancellation, non-destructive failures and fresh verification passed')
} finally {
  await setup.close()
  if (original === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = original
  await rm(root, { recursive: true, force: true })
}
