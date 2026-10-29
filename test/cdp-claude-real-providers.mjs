// Opt-in paid provider acceptance using already configured, encrypted Claude sources.
// UNIAGENT_REAL_PROVIDERS=1 node test/cdp-claude-real-providers.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

if (process.env.UNIAGENT_REAL_PROVIDERS !== '1') throw new Error('Explicit UNIAGENT_REAL_PROVIDERS=1 is required; this test spends provider tokens')
const fixture = await mkdtemp(join(tmpdir(), 'ua-real-provider-'))
const bundle = resolve('.test-build/claude-real-provider-test.mjs')
await build({ stdin: { contents: "export {ClaudeSourceService} from './src/main/claudeSourceService'; export {createClaudeSourceRuntime} from './src/main/claudeSourceRuntime'; export {ClaudeSdkClient, claudeSdkLaunch} from './src/main/claudeSdk'", resolveDir: process.cwd() }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { ClaudeSourceService, createClaudeSourceRuntime, ClaudeSdkClient, claudeSdkLaunch } = await import(bundle)
process.env.UNIAGENT_USER_DATA = join(homedir(), 'Library/Application Support/UniAgent')
const service = new ClaudeSourceService()
await service.start()
const selectedPresets = process.env.UNIAGENT_PROVIDER_PRESETS?.split(',')
const configured = service.snapshot().sources.filter(source => source.enabled !== false && source.hasKey && source.models.length && (!selectedPresets || selectedPresets.includes(source.preset)))
assert.ok(configured.length, 'No configured provider credentials are available')
const connections = await Promise.all(configured.map(async source => {
  const models=await service.queryModels(source)
  const model=source.models.find(model=>models.includes(model)) || models.find(model=>model.includes('flash')) || models[0]
  assert.ok(model,source.preset+': official model list is empty')
  if (!source.models.includes(model)) console.log(source.preset+': stored model '+source.models[0]+' is unavailable; validating current official '+model+' in the isolated fixture')
  return service.draftConnection({...source,models:[model]})
}))
console.log('SDK provider acceptance: ' + connections.map(connection => `${connection.preset}/${connection.model}`).join(', '))
process.env.UNIAGENT_USER_DATA = join(fixture, 'data')
const checks = [], rounds = [], clients = new Set()
async function run(connection, prompt, resumeId, interrupt = false, sessionHome = connection.preset, effort = 'high', markers) {
  if (connection.preset.startsWith('mimo') && !['off','high'].includes(effort)) effort='off'
  const home = join(fixture, sessionHome); await mkdir(home, { recursive: true })
  const file = join(home, 'source-fixture.txt'); await writeFile(file, 'REAL_PROVIDER_TOOL_OK\n')
  const runtime = await createClaudeSourceRuntime(connection, effort)
  const args = ['--tools', 'Read', '--permission-mode', 'bypassPermissions',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', connection.model, '--effort', effort, ...runtime.args, ...(resumeId ? ['--resume', resumeId] : [])]
  const launch = claudeSdkLaunch(join(homedir(), '.local/bin/claude'), home, args,
    { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: process.env.PATH, ...runtime.env })
  launch.options.settingSources = []
  const client = new ClaudeSdkClient(launch)
  clients.add(client)
  try {
    let nativeId, result, usedRead = false, cancelled = false
    await client.ready
    await new Promise((resolveTurn, rejectTurn) => {
      const timer = setTimeout(() => rejectTurn(new Error(connection.preset + ': SDK turn timed out')), 90000)
      const finish = () => { clearTimeout(timer); resolveTurn() }
      client.on('failure', error => { clearTimeout(timer); rejectTurn(new Error(runtime.redact(String(error)))) })
      client.on('message', event => {
        nativeId ||= event.session_id
        if (event.type === 'system' && event.subtype === 'api_retry' && [401, 402, 403].includes(event.error_status)) {
          clearTimeout(timer); rejectTurn(new Error(connection.preset + ': provider rejected authentication or billing (' + event.error_status + ')'))
        }
        if (event.type === 'assistant' && event.message?.content?.some(block => block.type === 'tool_use' && block.name === 'Read')) usedRead = true
        if (event.type === 'result') { result = event; finish() }
        if (interrupt && !cancelled && event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
          cancelled = true
          void client.request('interrupt').then(() => client.close()).then(finish, rejectTurn)
        }
      })
      void client.request('send', { uuid: randomUUID(), content: prompt.replace('{file}', file) }).catch(error => { clearTimeout(timer); rejectTurn(error) })
    })
    if (interrupt) assert.ok(cancelled && nativeId, connection.preset + ': cancellation did not occur')
    else {
      assert.equal(result?.is_error, false, connection.preset + ': ' + runtime.redact(result?.result || 'no SDK result'))
      if (markers) {
        assert.ok(markers.every(marker => result?.result?.includes(marker)), 'every intermediate turn must survive switching back')
        assert.equal(usedRead, false, 'round-trip recall must use conversation history, not files')
      } else assert.match(result?.result || '', /REAL_PROVIDER_TOOL_OK/)
      if (resumeId) assert.equal(result.session_id, resumeId, 'cross-provider resume must keep native identity')
      if (!resumeId && !markers) assert.equal(usedRead, true, 'real provider must actually invoke Read')
    }
    checks.push({ provider: connection.preset, model: connection.model, effort, crossProvider: sessionHome !== connection.preset, step: markers ? 'roundtrip' : interrupt ? 'stream-cancel' : resumeId ? 'resume' : 'tool-call', passed: true, usedRead })
    console.log('✓ ' + connection.preset + ' ' + checks.at(-1).step)
    return nativeId
  } finally { await client.close(); clients.delete(client); await runtime.dispose() }
}
try {
  const ids = await Promise.all(connections.map(connection => run(connection, 'Use the Read tool to read {file}. Then reply with the exact marker found in the file.')))
  await Promise.all(connections.map((connection, index) => run(connection, 'Reply with the exact marker you just read, and nothing else.', ids[index])))
  await Promise.all(connections.map((connection, index) => run(connections[(index + 1) % connections.length], 'Recall the exact marker from the file read earlier in this conversation. Reply only that marker, without using any tools.', ids[index], false, connection.preset, 'low')))
  await Promise.all(connections.map((connection, index) => run(connection, 'Recall the exact marker from the file read earlier in this conversation. Reply only that marker, without using any tools.', ids[index], false, connection.preset, 'max')))
  const cancelled = await Promise.all(connections.map(connection => run(connection, 'Output 60 numbered lines containing the text REAL_PROVIDER_TOOL_OK. Do not use tools.', undefined, true)))
  await Promise.all(connections.map((connection, index) => run(connection, 'Stop the numbered list. Reply REAL_PROVIDER_TOOL_OK only.', cancelled[index])))
  await Promise.all(connections.map((connection, index) => run(connections[(index + 1) % connections.length], 'Recall the marker repeated earlier. Reply only the marker.', cancelled[index], false, connection.preset, 'low')))
  const markers = [], chain = [connections[0], connections[1] || connections[0], connections[0]]
  let nativeId
  for (const [hop, connection] of chain.entries()) {
    const marker = 'ROUND_' + randomBytes(6).toString('hex')
    markers.push(marker)
    const id = await run(connection, `Add this new marker to our conversation: ${marker}. Reply with every ROUND_ marker from ALL user messages in this conversation, in chronological order, separated by spaces. Do not use tools.`, nativeId, false, connections[0].preset, 'low', markers)
    assert.ok(id, 'round-trip requires a native session identity')
    nativeId ||= id
    assert.equal(id, nativeId)
    rounds.push({ chain: chain.map(connection=>connection.preset), hop, provider: connection.preset, model: connection.model, completed: true, recalledMarkers: markers.length, sameSession: true })
  }
  await mkdir(resolve('.uniagent-artifacts'), { recursive: true })
  await writeFile(resolve('.uniagent-artifacts/claude-real-provider-acceptance.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, rounds, officialClaudePaidRequests: 0 }, null, 2))
  console.log('Real SDK providers ('+connections.map(connection=>connection.preset).join(', ')+'): tool calls, supported efforts, cross-provider recall, switch-back and cancellation recovery passed')
} finally {
  await Promise.all([...clients].map(client => client.close()))
  await rm(fixture, { recursive: true, force: true })
}
